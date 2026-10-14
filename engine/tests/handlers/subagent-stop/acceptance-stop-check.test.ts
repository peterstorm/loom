/**
 * The Acceptance Stop Check's shell, driven through its ports: a claimant
 * with a failing owed testcase is blocked, a passing one is not, and every
 * path the check cannot decide fails open. Plus the manifest's runner grammar.
 */
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../../../src/core/digest";
import {
  acceptanceRunnerCheck,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "../../../src/core/verification-manifest";
import {
  ACCEPTANCE_STOP_CHECK_MAX_BLOCKS,
  runAcceptanceStopCheck,
  type StopCheckPorts,
} from "../../../src/handlers/subagent-stop/acceptance-stop-check";
import type { CompletionCheckRunnerResult } from "../../../src/orchestration/completion-check-runner";
import type { TaskGraph } from "../../../src/types";
import type { AcceptanceContract } from "../../../src/core/acceptance-contract";
import { parseCanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { contract, frozenPaths, surface, task } from "../../fixtures/contract-status-fixtures";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const SURFACE = surface("payload");
const REPORT = ".loom/completion-reports/acceptance.junit.xml";
const RUNNER = {
  executable: "vitest",
  args: ["run", "--reporter=junit", `--outputFile=${REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: 120_000,
  report: { kind: "required-file", path: REPORT },
};

/** A source manifest; `null` declares no runner. */
const manifestBytes = (runner: unknown = RUNNER, schemaVersion = 2): Uint8Array => new TextEncoder().encode(JSON.stringify({
  schemaVersion, kind: "loom-verification-manifest", checks: [], ...(runner === null ? {} : { acceptanceRunner: runner }),
}));

function frozenManifest(): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(manifestBytes());
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

describe("verification manifest acceptanceRunner", () => {
  it("freezes a schema-2 runner, round-trips the frozen form, and keeps schema 1 runner-free", () => {
    const frozen = frozenManifest();
    expect(frozen.acceptanceRunner).toMatchObject({ executable: "vitest", report: { path: REPORT } });
    expect(parseFrozenVerificationManifest(JSON.parse(JSON.stringify(frozen)))).toMatchObject({ ok: true, value: frozen });
    const v1 = freezeVerificationManifest(manifestBytes(null, 1));
    expect(v1.ok && v1.value.acceptanceRunner).toBeUndefined();
  });

  it.each([
    ["a runner in a schema-1 manifest", { ...RUNNER }, 1, "is not allowed"],
    ["no {files} argument", { ...RUNNER, args: ["run"] }, 2, "exactly one whole"],
    ["{files} inside an argument", { ...RUNNER, args: ["run", "--files={files}", "{files}"] }, 2, "only as a whole argument"],
    ["a report outside the protected root", { ...RUNNER, report: { kind: "required-file", path: "out.xml" } }, 2, "beneath protected"],
    ["a timeout past the stop hook's budget", { ...RUNNER, timeoutMs: 600_000 }, 2, "at most 240000"],
    ["a disallowed executable", { ...RUNNER, executable: "npx" }, 2, "allowlist"],
  ])("refuses %s", (_label, runner, schemaVersion, message) => {
    const frozen = freezeVerificationManifest(manifestBytes(runner, schemaVersion));
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error.errors.join("; ")).toContain(message);
  });

  it("expands {files} into one argument per acceptance file and nothing else", () => {
    const runner = frozenManifest().acceptanceRunner!;
    const check = acceptanceRunnerCheck(runner, ["tests/a.acceptance.test.ts", "tests/b.acceptance.test.ts"]);
    expect(check).toMatchObject({ ok: true, value: { args: ["run", "--reporter=junit", `--outputFile=${REPORT}`, "tests/a.acceptance.test.ts", "tests/b.acceptance.test.ts"] } });
  });
});

const ROSTER = [{ file: SURFACE.acceptance, name: "AS-001: one valid call wins", anchors: ["AS-001"] }] as const;
const frozenContract = (): AcceptanceContract => contract({
  id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
  freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [...ROSTER] as never },
});

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", wave_gates: {},
    tasks: [task("T1", 1, [SURFACE.types, SURFACE.acceptance]), task("T2", 2, ["src/payload.ts"], ["AS-001"])],
    acceptance_contracts: [frozenContract()],
    verification_manifest: frozenManifest(),
    ...overrides,
  };
}

const junit = (outcome: "passed" | "failed"): Uint8Array => new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites><testsuite name="${SURFACE.acceptance}" tests="1">` +
  `<testcase classname="${SURFACE.acceptance}" name="${ROSTER[0].name}">` +
  (outcome === "failed" ? `<failure type="AssertionError" message="expected 1 to be 2"/>` : "") +
  "</testcase></testsuite></testsuites>");

const root = (() => {
  const parsed = parseCanonicalRepositoryRoot(canonicalTempDir("loom-stop-check-root-"));
  if (!parsed.ok) throw new Error("root fixture");
  return parsed.value;
})();

function ports(reportBytes: Uint8Array | null, overrides: Partial<StopCheckPorts> = {}) {
  const blocks = new Map<string, number>();
  const runs: string[][] = [];
  const run: StopCheckPorts["runCheck"] = async (check) => {
    runs.push([...check.args]);
    const report = reportBytes === null
      ? { kind: "missing" as const, path: REPORT }
      : { kind: "produced" as const, path: REPORT, digest: sha256Bytes(reportBytes), byteLength: reportBytes.byteLength };
    return {
      ok: true,
      value: {
        checkResult: { checkId: check.checkId, scope: "wave", outcome: { kind: "observed", exitCode: 1, timedOut: false, signal: null, report } },
        diagnostics: { stdoutTail: "runner stdout", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
      },
    } as CompletionCheckRunnerResult;
  };
  const value: StopCheckPorts = {
    repositoryRoot: () => ({ ok: true, root }),
    runCheck: run,
    readReport: () => reportBytes ?? new Uint8Array(),
    blocksIssued: (key) => blocks.get(key) ?? 0,
    recordBlock: (key) => { blocks.set(key, (blocks.get(key) ?? 0) + 1); },
    ...overrides,
  };
  return { value, runs, blocks };
}

const input = (taskId: string, overrides: Partial<TaskGraph> = {}) =>
  ({ graph: graph(overrides), stateFilePath: "/repo/.claude/state/active_task_graph.json", taskId, agentKey: "session.agent" });

describe("runAcceptanceStopCheck", () => {
  it("blocks a claimant whose owed testcase still fails, running only its acceptance file", async () => {
    const fake = ports(junit("failed"));
    const outcome = await runAcceptanceStopCheck(input("T2"), fake.value);
    expect(outcome).toMatchObject({ kind: "block", message: expect.stringContaining(`'${ROSTER[0].name}'`) });
    expect(fake.runs).toEqual([["run", "--reporter=junit", `--outputFile=${REPORT}`, SURFACE.acceptance]]);
    expect(fake.blocks.get("session.agent")).toBe(1);
  });

  it("lets a claimant whose owed testcases pass stop", async () => {
    expect(await runAcceptanceStopCheck(input("T2"), ports(junit("passed")).value)).toEqual({ kind: "passed" });
  });

  it("skips a non-claimant, a graph with no runner, and a contract not yet frozen", async () => {
    const fake = ports(junit("failed"));
    expect(await runAcceptanceStopCheck(input("T1"), fake.value)).toEqual({ kind: "skip" });
    const { acceptanceRunner: _runner, ...noRunner } = frozenManifest();
    expect(await runAcceptanceStopCheck(input("T2", { verification_manifest: noRunner as FrozenVerificationManifest }), fake.value))
      .toEqual({ kind: "skip" });
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    expect(await runAcceptanceStopCheck(input("T2", { acceptance_contracts: [awaiting] }), fake.value)).toEqual({ kind: "skip" });
    expect(fake.runs).toEqual([]);
  });

  it("fails open when the report is missing, changed after the run, or the runner did not complete", async () => {
    expect(await runAcceptanceStopCheck(input("T2"), ports(null).value)).toMatchObject({ kind: "note", message: expect.stringContaining("no report") });
    const changed = ports(junit("failed"), { readReport: () => junit("passed") });
    expect(await runAcceptanceStopCheck(input("T2"), changed.value)).toMatchObject({ kind: "note", message: expect.stringContaining("changed") });
    const cancelled = ports(junit("failed"), {
      runCheck: async () => ({ ok: false, error: { kind: "containment-unsupported", message: "no process groups" } }),
    });
    expect(await runAcceptanceStopCheck(input("T2"), cancelled.value)).toMatchObject({ kind: "note", message: expect.stringContaining("no process groups") });
  });

  it(`stops blocking after ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS} blocks for the same agent`, async () => {
    const fake = ports(junit("failed"));
    const outcomes = [];
    for (let attempt = 0; attempt <= ACCEPTANCE_STOP_CHECK_MAX_BLOCKS; attempt++) outcomes.push(await runAcceptanceStopCheck(input("T2"), fake.value));
    expect(outcomes.map(({ kind }) => kind)).toEqual([...Array(ACCEPTANCE_STOP_CHECK_MAX_BLOCKS).fill("block"), "note"]);
    expect(outcomes.at(-1)).toMatchObject({ message: expect.stringContaining("block cap") });
  });
});
