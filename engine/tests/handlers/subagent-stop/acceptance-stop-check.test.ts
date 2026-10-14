/**
 * The Acceptance Stop Check's shell, driven through its ports: a claimant
 * with a failing owed testcase is blocked, a passing one is not, and every
 * path the check cannot decide fails open. Plus the production counter and
 * runner lock, the Pi report-only form, and the manifest's runner grammar.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../../src/core/digest";
import {
  acceptanceRunnerCheck,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "../../../src/core/verification-manifest";
import {
  ACCEPTANCE_STOP_CHECK_MAX_BLOCKS,
  PRODUCTION_STOP_CHECK_PORTS,
  REPORT_ONLY_STOP_CHECK_PORTS,
  runAcceptanceStopCheck,
  stopCheckReportLine,
  type BlockCount,
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
const manifestBytes = (runner: unknown = RUNNER, schemaVersion = 2, checks: unknown[] = []): Uint8Array => new TextEncoder().encode(JSON.stringify({
  schemaVersion, kind: "loom-verification-manifest", checks, ...(runner === null ? {} : { acceptanceRunner: runner }),
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

  it("refuses a runner sharing a Wave check's report path, at freezing and at rehydration", () => {
    const waveCheck = {
      id: "project:verify", scope: "wave", executable: "vitest", args: ["run"], cwd: ".", timeoutMs: 60_000,
      report: { kind: "required-file", path: REPORT },
    };
    const source = freezeVerificationManifest(manifestBytes(RUNNER, 2, [waveCheck]));
    expect(source.ok).toBe(false);
    if (!source.ok) expect(source.error.errors.join("; ")).toContain("is also a Wave check's report path");

    // A frozen form carrying the conflict (built from a conflict-free one) is refused by its own parse.
    const clean = freezeVerificationManifest(manifestBytes(RUNNER, 2, [{ ...waveCheck, report: { kind: "required-file", path: ".loom/completion-reports/verify.junit.xml" } }]));
    if (!clean.ok) throw new Error(clean.error.errors.join("; "));
    const tampered = JSON.parse(JSON.stringify(clean.value)) as { projectChecks: { reportPolicy: { path: string } }[] };
    tampered.projectChecks[0]!.reportPolicy.path = REPORT;
    const rehydrated = parseFrozenVerificationManifest(tampered);
    expect(rehydrated.ok).toBe(false);
    if (!rehydrated.ok) expect(rehydrated.error.errors.join("; ")).toContain("frozenVerificationManifest.acceptanceRunner.report.path");
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

/** In-memory ports; `reportBytes: null` makes the runner produce no report. */
function ports(reportBytes: Uint8Array | null, overrides: Partial<StopCheckPorts> = {}) {
  const blocks = new Map<string, number>();
  const runs: string[][] = [];
  const locks = { acquired: 0, released: 0 };
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
    acquireRunner: () => {
      locks.acquired++;
      return { kind: "acquired", release: () => { locks.released++; } };
    },
    runCheck: run,
    readReport: () => reportBytes ?? new Uint8Array(),
    blocksIssued: (key): BlockCount => ({ kind: "count", blocks: blocks.get(key) ?? 0 }),
    recordBlock: (key, count) => { blocks.set(key, count); },
    clearBlocks: (key) => { blocks.delete(key); },
    ...overrides,
  };
  return { value, runs, blocks, locks };
}

const input = (taskId: string, overrides: Partial<TaskGraph> = {}) =>
  ({ loadGraph: () => graph(overrides), stateFilePath: "/repo/.claude/state/active_task_graph.json", taskId, agentKey: "session.agent" });

describe("runAcceptanceStopCheck", () => {
  it("blocks a claimant whose owed testcase still fails, running only its acceptance file under the runner lock", async () => {
    const fake = ports(junit("failed"));
    const outcome = await runAcceptanceStopCheck(input("T2"), fake.value);
    expect(outcome).toMatchObject({ kind: "block", message: expect.stringContaining(`'${ROSTER[0].name}'`) });
    expect(fake.runs).toEqual([["run", "--reporter=junit", `--outputFile=${REPORT}`, SURFACE.acceptance]]);
    expect(fake.blocks.get("session.agent")).toBe(1);
    expect(fake.locks).toEqual({ acquired: 1, released: 1 });
  });

  it("lets a claimant whose owed testcases pass stop, and forgets its blocks", async () => {
    const fake = ports(junit("passed"));
    fake.blocks.set("session.agent", 2);
    expect(await runAcceptanceStopCheck(input("T2"), fake.value)).toEqual({ kind: "passed" });
    expect(fake.blocks.has("session.agent")).toBe(false);
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
    expect(cancelled.locks).toEqual({ acquired: 1, released: 1 });
  });

  it("does not run while another claimant holds the runner", async () => {
    const fake = ports(junit("failed"), { acquireRunner: () => ({ kind: "held", reason: "another claimant's stop check (pid 7) is running the acceptance runner" }) });
    expect(await runAcceptanceStopCheck(input("T2"), fake.value)).toMatchObject({ kind: "note", message: expect.stringContaining("pid 7") });
    expect(fake.runs).toEqual([]);
  });

  it("names an unreadable block counter instead of reporting the cap, and never blocks without it", async () => {
    const fake = ports(junit("failed"), { blocksIssued: () => ({ kind: "unreadable", reason: "counter.json is not JSON" }) });
    const outcome = await runAcceptanceStopCheck(input("T2"), fake.value);
    expect(outcome).toMatchObject({ kind: "note", message: expect.stringContaining("block counter is unreadable: counter.json is not JSON") });
    expect(outcome).not.toMatchObject({ message: expect.stringContaining("cap") });
    expect(fake.runs).toEqual([]);
  });

  it("turns a thrown fault, including an unloadable graph, into a note", async () => {
    const unloadable = { ...input("T2"), loadGraph: () => { throw new Error("state file is corrupt"); } };
    expect(await runAcceptanceStopCheck(unloadable, ports(junit("failed")).value))
      .toMatchObject({ kind: "note", message: expect.stringContaining("crashed and did not decide: state file is corrupt") });
    const throwing = ports(junit("failed"), { runCheck: async () => { throw new Error("spawn exploded"); } });
    expect(await runAcceptanceStopCheck(input("T2"), throwing.value)).toMatchObject({ kind: "note", message: expect.stringContaining("spawn exploded") });
    expect(throwing.locks).toEqual({ acquired: 1, released: 1 });
  });

  it(`stops blocking after ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS} blocks for the same agent`, async () => {
    const fake = ports(junit("failed"));
    const outcomes = [];
    for (let attempt = 0; attempt <= ACCEPTANCE_STOP_CHECK_MAX_BLOCKS; attempt++) outcomes.push(await runAcceptanceStopCheck(input("T2"), fake.value));
    expect(outcomes.map(({ kind }) => kind)).toEqual([...Array(ACCEPTANCE_STOP_CHECK_MAX_BLOCKS).fill("block"), "note"]);
    expect(outcomes.at(-1)).toMatchObject({ message: expect.stringContaining("block cap") });
    expect(fake.blocks.has("session.agent")).toBe(false);
  });
});

describe("production stop-check ports", () => {
  const savedDir = process.env.LOOM_SUBAGENT_DIR;
  const dirs: string[] = [];
  const subagentDir = (): string => {
    const dir = canonicalTempDir("loom-stop-check-subagents-");
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    return dir;
  };
  afterEach(() => {
    if (savedDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
    else process.env.LOOM_SUBAGENT_DIR = savedDir;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const counter = (dir: string, key: string) => join(dir, `${key}.acceptance-stop-check.json`);

  it("counts, keeps agent keys independent, and clears", () => {
    const dir = subagentDir();
    const ports = PRODUCTION_STOP_CHECK_PORTS;
    expect(ports.blocksIssued("s.a")).toEqual({ kind: "count", blocks: 0 });
    ports.recordBlock("s.a", 1);
    ports.recordBlock("s.a", 2);
    ports.recordBlock("s.b", 1);
    expect(ports.blocksIssued("s.a")).toEqual({ kind: "count", blocks: 2 });
    expect(ports.blocksIssued("s.b")).toEqual({ kind: "count", blocks: 1 });
    ports.clearBlocks("s.a");
    expect(existsSync(counter(dir, "s.a"))).toBe(false);
    expect(ports.blocksIssued("s.a")).toEqual({ kind: "count", blocks: 0 });
    ports.clearBlocks("s.never");
  });

  it("reads a corrupt or malformed counter as unreadable, naming the file", () => {
    const dir = subagentDir();
    writeFileSync(counter(dir, "s.a"), "{not json");
    writeFileSync(counter(dir, "s.b"), JSON.stringify({ blocks: -1 }));
    expect(PRODUCTION_STOP_CHECK_PORTS.blocksIssued("s.a")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("is not JSON") });
    expect(PRODUCTION_STOP_CHECK_PORTS.blocksIssued("s.b")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("non-negative integer") });
  });

  it("serializes the runner per repository, releases only its own lock, and reaps a dead holder's", () => {
    const dir = subagentDir();
    const first = PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root);
    expect(first.kind).toBe("acquired");
    expect(PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root)).toMatchObject({ kind: "held", reason: expect.stringContaining(`pid ${process.pid}`) });
    if (first.kind === "acquired") first.release();
    const second = PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root);
    expect(second.kind).toBe("acquired");

    // A lock left by a process that is gone is stale.
    const [lock] = readdirSync(dir).filter((name) => name.endsWith(".lock"));
    const path = join(dir, lock!);
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, acquiredAt: Date.now() }));
    if (second.kind === "acquired") second.release();
    expect(readFileSync(path, "utf8")).toContain(String(2 ** 22 + 12345));
    const reaped = PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root);
    expect(reaped.kind).toBe("acquired");
    if (reaped.kind === "acquired") reaped.release();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps no counter in the Pi report-only form", () => {
    const dir = subagentDir();
    REPORT_ONLY_STOP_CHECK_PORTS.recordBlock("pi.T2", 1);
    expect(REPORT_ONLY_STOP_CHECK_PORTS.blocksIssued("pi.T2")).toEqual({ kind: "count", blocks: 0 });
    REPORT_ONLY_STOP_CHECK_PORTS.clearBlocks("pi.T2");
    expect(existsSync(counter(dir, "pi.T2"))).toBe(false);
  });
});

describe("stopCheckReportLine", () => {
  it("prints nothing for a skip and one operator line for every other outcome", () => {
    expect(stopCheckReportLine("T2", { kind: "skip" })).toBeNull();
    expect(stopCheckReportLine("T2", { kind: "passed" })).toBe("acceptance stop check: T2's owed acceptance testcases pass");
    expect(stopCheckReportLine("T2", { kind: "note", message: "did not decide" })).toBe("did not decide");
    expect(stopCheckReportLine("T2", { kind: "block", message: "still failing" }))
      .toBe("acceptance stop check (report-only on Pi; the agent has already ended): T2 still failing");
  });
});
