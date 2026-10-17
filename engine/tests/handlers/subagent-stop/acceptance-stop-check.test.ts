/**
 * The acceptance arm of the one stop shell (`runStopChecks`), driven through
 * its ports: a claimant with a failing owed testcase is blocked, a passing one
 * is not, and every path the check cannot decide fails open. These graphs
 * freeze no affected runner and the attempt changed no files, so the affected
 * arm stays off. Plus the production counters and runner lock, the Pi
 * report-only form, and the manifest's runner grammar.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../../src/core/digest";
import {
  acceptanceRunnerCheck,
  defaultVerificationManifest,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "../../../src/core/verification-manifest";
import {
  ACCEPTANCE_STOP_CHECK_MAX_BLOCKS,
  PRODUCTION_STOP_CHECK_PORTS,
  REPORT_ONLY_STOP_CHECK_PORTS,
  reapStaleRunnerLock,
  type StopCheckShellPorts,
} from "../../../src/handlers/subagent-stop/acceptance-stop-check";
import { runStopChecks, stopChecksReportLine } from "../../../src/handlers/subagent-stop/stop-checks";
import { NO_CHANGED_FILES } from "../../../src/core/changed-files";
import type { CompletionCheckRunnerResult } from "../../../src/orchestration/completion-check-runner";
import type { TaskGraph } from "../../../src/types";
import type { AcceptanceContract } from "../../../src/core/acceptance-contract";
import { parseCanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { contract, frozenPaths, surface, task } from "../../fixtures/contract-status-fixtures";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { inMemoryBlockCounters } from "../../fixtures/stop-check-block-counters";

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

  it("refuses a frozen engine-default form that carries a runner", () => {
    const tampered = { ...JSON.parse(JSON.stringify(defaultVerificationManifest())), acceptanceRunner: frozenManifest().acceptanceRunner };
    const rehydrated = parseFrozenVerificationManifest(tampered);
    expect(rehydrated.ok).toBe(false);
    if (!rehydrated.ok) expect(rehydrated.error.errors.join("; ")).toContain("engine-default source cannot authorize an acceptance runner");
  });

  it("expands {files} into one argument per acceptance file and nothing else", () => {
    const runner = frozenManifest().acceptanceRunner!;
    const check = acceptanceRunnerCheck(runner, ["tests/a.acceptance.test.ts", "tests/b.acceptance.test.ts"]);
    expect(check).toMatchObject({ ok: true, value: { args: ["run", "--reporter=junit", `--outputFile=${REPORT}`, "tests/a.acceptance.test.ts", "tests/b.acceptance.test.ts"] } });
  });

  it("names each file relative to a runner cwd below the repository root, and refuses one outside it", () => {
    const frozen = freezeVerificationManifest(manifestBytes({ ...RUNNER, executable: "npm", args: ["run", "test:acceptance", "--", "{files}"], cwd: "engine" }));
    if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
    const runner = frozen.value.acceptanceRunner!;
    expect(acceptanceRunnerCheck(runner, ["engine/tests/acceptance/a.acceptance.test.ts"])).toMatchObject({
      ok: true, value: { cwd: "engine", args: ["run", "test:acceptance", "--", "tests/acceptance/a.acceptance.test.ts"] },
    });
    const outside = acceptanceRunnerCheck(runner, ["engine/tests/a.acceptance.test.ts", "pi/b.acceptance.test.ts"]);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.errors.join("; ")).toBe("acceptanceRunner.cwd engine does not contain pi/b.acceptance.test.ts");
    // A sibling directory sharing the prefix is outside too.
    expect(acceptanceRunnerCheck(runner, ["engine-extra/a.test.ts"]).ok).toBe(false);
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

/** A fresh acceptance counter that cannot be read, as a corrupt counter file
 *  reads. Fresh per test: a stop that proceeds clears it, as it removes a file. */
const unreadableAcceptanceCounter = () =>
  inMemoryBlockCounters({ presets: { acceptance: { kind: "unreadable", reason: "counter.json is not JSON" } } }).counters;

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
function ports(reportBytes: Uint8Array | null, overrides: Partial<StopCheckShellPorts> = {}) {
  const { counters, counts } = inMemoryBlockCounters();
  const blocks = counts.acceptance;
  const runs: string[][] = [];
  const locks = { acquired: 0, released: 0 };
  const run: StopCheckShellPorts["runCheck"] = async (check) => {
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
  const value: StopCheckShellPorts = {
    repositoryRoot: () => ({ ok: true, root }),
    acquireRunner: () => {
      locks.acquired++;
      return { kind: "acquired", release: () => { locks.released++; return null; } };
    },
    runCheck: run,
    readReport: () => reportBytes ?? new Uint8Array(),
    blocks: counters,
    pathExists: () => true,
    now: () => Date.now(),
    ...overrides,
  };
  return { value, runs, blocks, locks };
}

const input = (taskId: string, overrides: Partial<TaskGraph> = {}) =>
  ({
    loadGraph: () => graph(overrides),
    stateFilePath: "/repo/.claude/state/active_task_graph.json",
    taskId,
    agentKey: "session.agent",
    changedFiles: () => ({ kind: "observed" as const, changed: NO_CHANGED_FILES }),
    hookStartedAtMs: Date.now(),
  });

describe("runStopChecks: the acceptance arm", () => {
  it("blocks a claimant whose owed testcase still fails, running only its acceptance file under the runner lock", async () => {
    const fake = ports(junit("failed"));
    const outcome = await runStopChecks(input("T2"), fake.value);
    expect(outcome).toMatchObject({ kind: "block", message: expect.stringContaining(`'${ROSTER[0].name}'`) });
    expect(fake.runs).toEqual([["run", "--reporter=junit", `--outputFile=${REPORT}`, SURFACE.acceptance]]);
    expect(fake.blocks.get("session.agent")).toBe(1);
    expect(fake.locks).toEqual({ acquired: 1, released: 1 });
  });

  it("lets a claimant whose owed testcases pass stop, and forgets its blocks", async () => {
    const fake = ports(junit("passed"));
    fake.blocks.set("session.agent", 2);
    expect(await runStopChecks(input("T2"), fake.value)).toEqual({ kind: "passed" });
    expect(fake.blocks.has("session.agent")).toBe(false);
  });

  it("skips a non-claimant, a graph with no runner, and a contract not yet frozen", async () => {
    const fake = ports(junit("failed"));
    expect(await runStopChecks(input("T1"), fake.value)).toEqual({ kind: "skip" });
    const { acceptanceRunner: _runner, ...noRunner } = frozenManifest();
    expect(await runStopChecks(input("T2", { verification_manifest: noRunner as FrozenVerificationManifest }), fake.value))
      .toEqual({ kind: "skip" });
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    expect(await runStopChecks(input("T2", { acceptance_contracts: [awaiting] }), fake.value)).toEqual({ kind: "skip" });
    expect(fake.runs).toEqual([]);
  });

  it("fails open when the report is missing, changed after the run, or the runner did not complete", async () => {
    expect(await runStopChecks(input("T2"), ports(null).value)).toMatchObject({ kind: "note", message: expect.stringContaining("no report") });
    const changed = ports(junit("failed"), { readReport: () => junit("passed") });
    expect(await runStopChecks(input("T2"), changed.value)).toMatchObject({ kind: "note", message: expect.stringContaining("changed") });
    const cancelled = ports(junit("failed"), {
      runCheck: async () => ({ ok: false, error: { kind: "containment-unsupported", message: "no process groups" } }),
    });
    expect(await runStopChecks(input("T2"), cancelled.value)).toMatchObject({ kind: "note", message: expect.stringContaining("no process groups") });
    expect(cancelled.locks).toEqual({ acquired: 1, released: 1 });
  });

  it.each([
    ["timed out", { timedOut: true, signal: "SIGKILL" }, "the runner timed out"],
    ["was killed", { timedOut: false, signal: "SIGTERM" }, "the runner was killed by SIGTERM"],
  ])("does not judge the partial report of a runner that %s", async (_label, killed, message) => {
    const fake = ports(junit("failed"));
    const run = fake.value.runCheck;
    const killedRun: StopCheckShellPorts["runCheck"] = async (check, at) => {
      const result = await run(check, at);
      if (!result.ok || result.value.checkResult.outcome.kind !== "observed") throw new Error("fixture");
      const outcome = { ...result.value.checkResult.outcome, ...killed };
      return { ok: true, value: { ...result.value, checkResult: { ...result.value.checkResult, outcome } } } as CompletionCheckRunnerResult;
    };
    const outcome = await runStopChecks(input("T2"), { ...fake.value, runCheck: killedRun });
    expect(outcome).toMatchObject({ kind: "note", message: expect.stringContaining(message) });
    expect(fake.blocks.has("session.agent")).toBe(false);
    expect(fake.locks).toEqual({ acquired: 1, released: 1 });
  });

  it("tells the operator about a runner lock that will not release, and still blocks a failing claimant", async () => {
    const stuck = (reportBytes: Uint8Array) => ports(reportBytes, {
      acquireRunner: () => ({ kind: "acquired", release: () => "the runner lock x.lock could not be released: EACCES" }),
    });
    expect(await runStopChecks(input("T2"), stuck(junit("passed")).value)).toEqual({
      kind: "note",
      message: "stop checks for T2: the runner lock x.lock could not be released: EACCES",
    });
    const noted = await runStopChecks(input("T2"), { ...stuck(junit("passed")).value, readReport: () => junit("failed") });
    expect(noted).toMatchObject({ kind: "note", message: expect.stringMatching(/changed after the runner produced it[\s\S]*the runner lock x\.lock could not be released/) });
    expect(await runStopChecks(input("T2"), stuck(junit("failed")).value)).toMatchObject({ kind: "block" });
  });

  it("lets the stop proceed with a note, running nothing, when an owed file is outside the runner's cwd", async () => {
    const elsewhere = freezeVerificationManifest(manifestBytes({ ...RUNNER, cwd: "engine" }));
    if (!elsewhere.ok) throw new Error(elsewhere.error.errors.join("; "));
    const fake = ports(junit("failed"));
    const outcome = await runStopChecks(input("T2", { verification_manifest: elsewhere.value }), fake.value);
    expect(outcome).toMatchObject({ kind: "note", message: expect.stringContaining(`acceptanceRunner.cwd engine does not contain ${SURFACE.acceptance}`) });
    expect(fake.runs).toEqual([]);
    expect(fake.locks).toEqual({ acquired: 0, released: 0 });
    expect(fake.blocks.has("session.agent")).toBe(false);
  });

  it("notes a refused command before reading the block counter or resolving the repository root", async () => {
    const elsewhere = freezeVerificationManifest(manifestBytes({ ...RUNNER, cwd: "engine" }));
    if (!elsewhere.ok) throw new Error(elsewhere.error.errors.join("; "));
    const fake = ports(junit("failed"), {
      blocks: unreadableAcceptanceCounter(),
      repositoryRoot: () => ({ ok: false, reason: "the protected TaskGraph's repository root is unavailable" }),
    });
    const outcome = await runStopChecks(input("T2", { verification_manifest: elsewhere.value }), fake.value);
    expect(outcome).toEqual({
      kind: "note",
      message: `acceptance stop check for T2 did not decide (the runner command is invalid for these files: acceptanceRunner.cwd engine does not contain ${SURFACE.acceptance}); the stop proceeds and the Wave Gate judges`,
    });
  });

  it("does not run while another claimant holds the runner", async () => {
    const fake = ports(junit("failed"), { acquireRunner: () => ({ kind: "held", reason: "another claimant's stop check (pid 7) is running the acceptance runner" }) });
    expect(await runStopChecks(input("T2"), fake.value)).toMatchObject({ kind: "note", message: expect.stringContaining("pid 7") });
    expect(fake.runs).toEqual([]);
  });

  it("names an unreadable block counter instead of reporting the cap, and never blocks without it", async () => {
    const fake = ports(junit("failed"), { blocks: unreadableAcceptanceCounter() });
    const outcome = await runStopChecks(input("T2"), fake.value);
    expect(outcome).toMatchObject({ kind: "note", message: expect.stringContaining("block counter is unreadable: counter.json is not JSON") });
    expect(outcome).not.toMatchObject({ message: expect.stringContaining("cap") });
    expect(fake.runs).toEqual([]);
  });

  it("turns a thrown fault, including an unloadable graph, into a note", async () => {
    const unloadable = { ...input("T2"), loadGraph: () => { throw new Error("state file is corrupt"); } };
    expect(await runStopChecks(unloadable, ports(junit("failed")).value))
      .toMatchObject({ kind: "note", message: expect.stringContaining("crashed and did not decide: state file is corrupt") });
    const throwing = ports(junit("failed"), { runCheck: async () => { throw new Error("spawn exploded"); } });
    expect(await runStopChecks(input("T2"), throwing.value)).toMatchObject({ kind: "note", message: expect.stringContaining("spawn exploded") });
    expect(throwing.locks).toEqual({ acquired: 1, released: 1 });
  });

  it(`stops blocking after ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS} blocks for the same agent`, async () => {
    const fake = ports(junit("failed"));
    const outcomes = [];
    for (let attempt = 0; attempt <= ACCEPTANCE_STOP_CHECK_MAX_BLOCKS; attempt++) outcomes.push(await runStopChecks(input("T2"), fake.value));
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
    expect(ports.blocks.issued("acceptance", "s.a")).toEqual({ kind: "count", blocks: 0 });
    ports.blocks.record("acceptance", "s.a", 1);
    ports.blocks.record("acceptance", "s.a", 2);
    ports.blocks.record("acceptance", "s.b", 1);
    expect(ports.blocks.issued("acceptance", "s.a")).toEqual({ kind: "count", blocks: 2 });
    expect(ports.blocks.issued("acceptance", "s.b")).toEqual({ kind: "count", blocks: 1 });
    ports.blocks.clear("acceptance", "s.a");
    expect(existsSync(counter(dir, "s.a"))).toBe(false);
    expect(ports.blocks.issued("acceptance", "s.a")).toEqual({ kind: "count", blocks: 0 });
    ports.blocks.clear("acceptance", "s.never");
  });

  it("reads a corrupt or malformed counter as unreadable, naming the file", () => {
    const dir = subagentDir();
    writeFileSync(counter(dir, "s.a"), "{not json");
    writeFileSync(counter(dir, "s.b"), JSON.stringify({ blocks: -1 }));
    expect(PRODUCTION_STOP_CHECK_PORTS.blocks.issued("acceptance", "s.a")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("is not JSON") });
    expect(PRODUCTION_STOP_CHECK_PORTS.blocks.issued("acceptance", "s.b")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("non-negative integer") });
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

  it("reaps a stale lock only while it still holds the stale bytes, and hands back one another stop took", () => {
    const dir = subagentDir();
    const path = join(dir, "acceptance-stop-check.test.lock");
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, acquiredAt: 0 });
    const fresh = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    const leftovers = () => readdirSync(dir).filter((name) => name.includes(".reap."));

    writeFileSync(path, stale);
    expect(reapStaleRunnerLock(path, stale)).toBe("reaped");
    expect(existsSync(path)).toBe(false);

    // Another stop reaped the stale lock and took a fresh one before this stop's reap.
    writeFileSync(path, fresh);
    expect(reapStaleRunnerLock(path, stale)).toBe("retaken");
    expect(readFileSync(path, "utf8")).toBe(fresh);

    rmSync(path);
    expect(reapStaleRunnerLock(path, stale)).toBe("reaped");
    expect(leftovers()).toEqual([]);
  });

  it("reports a lock it cannot release instead of swallowing the fault, and treats an absent one as released", () => {
    const dir = subagentDir();
    const lock = PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root);
    if (lock.kind !== "acquired") throw new Error("lock fixture");
    expect(lock.release()).toBeNull();
    expect(lock.release()).toBeNull();

    const unreadable = PRODUCTION_STOP_CHECK_PORTS.acquireRunner(root);
    if (unreadable.kind !== "acquired") throw new Error("lock fixture");
    const [name] = readdirSync(dir).filter((entry) => entry.endsWith(".lock"));
    const path = join(dir, name!);
    rmSync(path);
    mkdirSync(path);
    expect(unreadable.release()).toMatch(/could not be released: .*EISDIR/);
  });

  it("keeps no counter in the Pi report-only form", () => {
    const dir = subagentDir();
    REPORT_ONLY_STOP_CHECK_PORTS.blocks.record("acceptance", "pi.T2", 1);
    expect(REPORT_ONLY_STOP_CHECK_PORTS.blocks.issued("acceptance", "pi.T2")).toEqual({ kind: "count", blocks: 0 });
    REPORT_ONLY_STOP_CHECK_PORTS.blocks.clear("acceptance", "pi.T2");
    expect(existsSync(counter(dir, "pi.T2"))).toBe(false);
  });
});

describe("stopChecksReportLine", () => {
  it("prints nothing for a skip and one operator line for every other outcome", () => {
    expect(stopChecksReportLine("T2", { kind: "skip" })).toBeNull();
    expect(stopChecksReportLine("T2", { kind: "passed" })).toBe("stop checks: every acceptance and affected-test check that ran for T2 passes");
    expect(stopChecksReportLine("T2", { kind: "note", message: "did not decide" })).toBe("did not decide");
    expect(stopChecksReportLine("T2", { kind: "block", message: "still failing" }))
      .toBe("stop checks (report-only on Pi; the agent has already ended): T2\nstill failing");
  });
});
