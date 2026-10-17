/**
 * `runStopChecks`, the one stop shell for both stop checks (AD-10), driven
 * with in-memory ports: a runner that answers per check (told apart by report
 * path), an advanceable clock, a recording lock and one counter per check.
 *
 * Every decision the shell acts on is pure and pinned elsewhere (the planner,
 * `stopCheckBlockDecision`, the judges); these tests pin the shell's own
 * work: the sequence, the one lock, the budget, the counters it reads and
 * writes, and that every infrastructure fault fails open with a named note.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTANCE_BLOCK_HEADING,
  AFFECTED_BLOCK_HEADING,
  AFFECTED_NOTE_TEXT,
  AFFECTED_OFF_REASON_TEXT,
  AFFECTED_STOP_CHECK_OFF,
  AFFECTED_STOP_CHECK_MAX_BLOCKS,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  SETTLEMENT_RESERVE_MS,
  STOP_HOOK_BUDGET_MS,
  type ChangedFiles,
  type StopCheckBlockCount,
  type StopChecksOutcome,
} from "../../src/core/affected-stop-check-types";
import { changedFilesAtStop, NO_CHANGED_FILES } from "../../src/core/changed-files";
import { sha256Bytes } from "../../src/core/digest";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import {
  ACCEPTANCE_STOP_CHECK_MAX_BLOCKS,
  PRODUCTION_STOP_CHECK_PORTS,
  REPORT_ONLY_STOP_CHECK_PORTS,
  type StopCheckShellPorts,
} from "../../src/handlers/subagent-stop/acceptance-stop-check";
import {
  epochChangedFiles,
  runStopChecks,
  stopChecksReportLine,
  type ChangedFilesObservation,
  type StopChecksInput,
} from "../../src/handlers/subagent-stop/stop-checks";
import { createStopCheckPlanHandler, type LiveAttemptEvidenceFn } from "../../src/handlers/helpers/stop-check-plan";
import { UNKNOWN_TASK_PREFIX } from "../../src/core/stop-check-plan-types";
import type { Evidence } from "../../src/machine";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contract, frozenPaths, gitProject, surface, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import { stopCheckGraph } from "../fixtures/stop-check-plan-fixtures";

const SURFACE = surface("payload");
const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const OWED = "AS-001: one valid call wins";
const LEDGER_TEST = "ledger > balances after a debit";

const ACCEPTANCE_RUNNER = {
  executable: "vitest",
  args: ["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: 120_000,
  report: { kind: "required-file", path: ACCEPTANCE_REPORT },
};
const AFFECTED_RUNNER = {
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
};

function manifest(runners: Readonly<{ acceptance?: boolean; affected?: Readonly<Record<string, unknown>> | boolean }>): FrozenVerificationManifest {
  const affected = runners.affected === true ? AFFECTED_RUNNER : runners.affected || undefined;
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...(runners.acceptance === true ? { acceptanceRunner: ACCEPTANCE_RUNNER } : {}),
    ...(affected === undefined ? {} : { affectedRunner: affected }),
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

/** T1 is CT-1's contract Task, T2 a claimant owing `OWED`, T3 a Task that claims nothing. */
function graph(frozen: FrozenVerificationManifest): TaskGraph {
  return {
    current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", wave_gates: {},
    tasks: [
      task("T1", 1, [SURFACE.types, SURFACE.acceptance]),
      task("T2", 2, ["src/payload.ts", "src/payload.test.ts"], ["AS-001"]),
      task("T3", 2, ["src/ledger.ts", "src/ledger.test.ts"]),
    ],
    acceptance_contracts: [contract({
      id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
      freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [{ file: SURFACE.acceptance, name: OWED, anchors: ["AS-001"] }] as never },
    })],
    verification_manifest: frozen,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repositoryRoot() {
  const dir = canonicalTempDir("loom-stop-checks-");
  roots.push(dir);
  const parsed = parseCanonicalRepositoryRoot(dir);
  if (!parsed.ok) throw new Error("root fixture");
  return parsed.value;
}

// --- Fake runner, clock, lock and counters ---

type Testcase = Readonly<{ file: string; name: string; outcome: "passed" | "failed" }>;
const failing = (file: string, name: string): Testcase => ({ file, name, outcome: "failed" });
const passing = (file: string, name: string): Testcase => ({ file, name, outcome: "passed" });

const junit = (cases: readonly Testcase[]): Uint8Array => new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) => `<testcase classname="${file}" name="${name}">${outcome === "failed" ? "<failure/>" : ""}</testcase>`).join("") +
  "</testsuite></testsuites>");

type Run =
  | Readonly<{ kind: "report"; cases: readonly Testcase[]; tookMs?: number }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "killed" }>
  | Readonly<{ kind: "no-report" }>
  | Readonly<{ kind: "start-failed" }>
  | Readonly<{ kind: "did-not-complete" }>
  | Readonly<{ kind: "report-rewritten" }>
  | Readonly<{ kind: "not-junit" }>
  | Readonly<{ kind: "throws" }>;

/** How far one fake run advances the clock: a report its own `tookMs`, a timeout the whole timeout, anything else one second. */
function elapsedMs(run: Run, timeoutMs: number): number {
  switch (run.kind) {
    case "report": return run.tookMs ?? 1_000;
    case "timed-out": return timeoutMs;
    default: return 1_000;
  }
}

type CheckName = "acceptance" | "affected";
type Launch = Readonly<{ check: CheckName; argv: readonly string[]; lockHeld: boolean; atMs: number }>;

type FakeOptions = Readonly<{
  acceptance?: Run;
  affected?: Run;
  blocks?: Readonly<{ acceptance?: StopCheckBlockCount; affected?: StopCheckBlockCount }>;
  lock?: "free" | "held" | "release-fails";
  root?: "ok" | "unavailable";
  clearFails?: boolean;
}>;

function fakePorts(root: ReturnType<typeof repositoryRoot>, options: FakeOptions = {}) {
  const clock = { ms: 1_000_000 };
  const launches: Launch[] = [];
  const reports = new Map<string, Uint8Array>();
  const locks = { acquired: 0, released: 0, held: 0 };
  const counters = { acceptance: new Map<string, number>(), affected: new Map<string, number>() };
  const issued = (check: CheckName) => (key: string): StopCheckBlockCount => {
    const preset = options.blocks?.[check];
    if (preset?.kind === "unreadable") return preset;
    return { kind: "count", blocks: counters[check].get(key) ?? preset?.blocks ?? 0 };
  };
  const runnerResult = (check: CheckName, timedOut: boolean, signal: string | null, bytes: Uint8Array | null, digestOf: Uint8Array | null = bytes) => {
    const path = check === "acceptance" ? ACCEPTANCE_REPORT : AFFECTED_REPORT;
    if (bytes === null) reports.delete(join(root, path));
    else reports.set(join(root, path), bytes);
    return {
      ok: true,
      value: {
        checkResult: {
          checkId: "stop-check",
          scope: "wave",
          outcome: {
            kind: "observed", exitCode: timedOut || signal !== null ? null : 1, timedOut, signal,
            report: digestOf === null ? { kind: "missing", path } : { kind: "produced", path, digest: sha256Bytes(digestOf), byteLength: digestOf.byteLength },
          },
        },
        diagnostics: { stdoutTail: `${check} runner stdout`, stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
      },
    } as CompletionCheckRunnerResult;
  };
  const ports: StopCheckShellPorts = {
    repositoryRoot: () => options.root === "unavailable" ? { ok: false, reason: "no Git repository here" } : { ok: true, root },
    acquireRunner: () => {
      if (options.lock === "held") return { kind: "held", reason: "another stop (pid 7) holds the runner lock" };
      locks.acquired++;
      locks.held++;
      return { kind: "acquired", release: () => { locks.released++; locks.held--; return options.lock === "release-fails" ? "the runner lock x.lock could not be released: EACCES" : null; } };
    },
    runCheck: async (command) => {
      const check: CheckName = command.reportPolicy.kind === "required-file" && command.reportPolicy.path === AFFECTED_REPORT ? "affected" : "acceptance";
      launches.push({ check, argv: [command.executable, ...command.args], lockHeld: locks.held > 0, atMs: clock.ms });
      const run = options[check] ?? { kind: "report", cases: [] };
      clock.ms += elapsedMs(run, command.timeoutMs);
      switch (run.kind) {
        case "report":
          return runnerResult(check, false, null, junit(run.cases));
        case "timed-out":
          return runnerResult(check, true, "SIGKILL", junit([failing("src/partial.test.ts", "partial")]));
        case "killed":
          return runnerResult(check, false, "SIGTERM", junit([failing("src/partial.test.ts", "partial")]));
        case "no-report":
          return runnerResult(check, false, null, null);
        case "report-rewritten":
          return runnerResult(check, false, null, junit([passing("src/ledger.test.ts", LEDGER_TEST)]), junit([failing("src/ledger.test.ts", LEDGER_TEST)]));
        case "not-junit":
          return runnerResult(check, false, null, new TextEncoder().encode("not xml at all"));
        case "start-failed":
          return {
            ok: true,
            value: {
              checkResult: { checkId: command.checkId, scope: "wave", outcome: { kind: "spawn-failed", message: `spawn ${command.executable} ENOENT` } },
              diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
            },
          } as CompletionCheckRunnerResult;
        case "did-not-complete":
          return { ok: false, error: { kind: "containment-unsupported", message: "no process groups on this host" } };
        case "throws":
          throw new Error("runner port defect");
      }
    },
    readReport: (path) => {
      const bytes = reports.get(path);
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
    blocksIssued: issued("acceptance"),
    recordBlock: (key, blocks) => { counters.acceptance.set(key, blocks); },
    clearBlocks: (key) => {
      if (options.clearFails === true) throw new Error("EROFS: counter directory is read-only");
      counters.acceptance.set(key, 0);
    },
    affectedBlocksIssued: issued("affected"),
    recordAffectedBlock: (key, blocks) => { counters.affected.set(key, blocks); },
    clearAffectedBlocks: (key) => { counters.affected.set(key, 0); },
    pathExists: () => true,
    now: () => clock.ms,
  };
  return { ports, launches, locks, counters, clock };
}

/** Changed files as the owner derives them from FileWrite facts, every file present. */
function changed(root: string, ...files: string[]): ChangedFiles {
  return changedFilesAtStop(files.map((path): Evidence => ({ kind: "FileWrite", path: join(root, path), via: "tool" })), root, () => true);
}

function input(
  frozen: FrozenVerificationManifest,
  taskId: string,
  observation: ChangedFilesObservation,
  startedAtMs = 1_000_000,
): StopChecksInput {
  return {
    loadGraph: () => graph(frozen),
    stateFilePath: "/repo/.loom/active_task_graph.json",
    taskId,
    agentKey: "session.agent",
    changedFiles: () => observation,
    hookStartedAtMs: startedAtMs,
  };
}

const observed = (files: ChangedFiles): ChangedFilesObservation => ({ kind: "observed", changed: files });
const textOf = (outcome: StopChecksOutcome): string => outcome.kind === "block" || outcome.kind === "note" ? outcome.message : "";
const affectedArgv = (...files: string[]): readonly string[] => [AFFECTED_RUNNER.executable, ...AFFECTED_RUNNER.args.slice(0, -1), ...files];

// --- Blocking and passing ---

describe("runStopChecks: the affected check blocks on failing affected tests", () => {
  it("AS-020: a non-claimant with failing affected tests is blocked, each failing test named with its file, and its affected counter counts one block", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST), failing("src/audit.test.ts", "audit > logs"), passing("src/ledger.test.ts", "ledger > opens")] } });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(AFFECTED_BLOCK_HEADING);
    expect(textOf(outcome)).not.toContain(ACCEPTANCE_BLOCK_HEADING);
    expect(textOf(outcome)).toContain(`'${LEDGER_TEST}' (src/ledger.test.ts)`);
    expect(textOf(outcome)).toContain("'audit > logs' (src/audit.test.ts)");
    expect(textOf(outcome)).not.toContain("ledger > opens");
    expect(textOf(outcome)).toContain(`at most ${AFFECTED_STOP_CHECK_MAX_BLOCKS - 1} more time(s)`);
    expect(fake.launches.map(({ check, argv }) => [check, argv])).toEqual([["affected", affectedArgv("src/ledger.ts")]]);
    expect(fake.counters.affected.get("session.agent")).toBe(1);
    expect(fake.counters.acceptance.has("session.agent")).toBe(false);
  });

  it("AS-021: an affected run whose tests all pass is `passed` and clears both counters", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] }, blocks: { affected: { kind: "count", blocks: 2 } } });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome).toEqual({ kind: "passed" });
    expect(fake.counters.affected.get("session.agent")).toBe(0);
    expect(fake.counters.acceptance.get("session.agent")).toBe(0);
  });

  it("AS-023: zero affected tests pass with the zero-tests note", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: { kind: "report", cases: [] } });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "docs/ledger.md"))), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["zero-tests"]);
  });

  it("skips a Task the TaskGraph does not know, and a stop with no runner frozen, running nothing", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root);
    expect(await runStopChecks(input(manifest({ affected: true }), "T9", observed(changed(root, "src/ledger.ts"))), fake.ports)).toEqual({ kind: "skip" });
    expect(await runStopChecks(input(manifest({}), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports)).toEqual({ kind: "skip" });
    expect(fake.launches).toEqual([]);
    expect(fake.locks.acquired).toBe(0);
  });
});

describe("runStopChecks: the changed files", () => {
  it("AS-022: no changed files skips the affected check with its note, takes no lock and runs nothing", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root);

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(NO_CHANGED_FILES)), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["no-changed-files"]);
    expect(fake.launches).toEqual([]);
    expect(fake.locks.acquired).toBe(0);
  });

  it("names each changed file outside the affected runner cwd in the no-changed-files note", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root);

    const outcome = await runStopChecks(input(manifest({ affected: { ...AFFECTED_RUNNER, cwd: "engine" } }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["no-changed-files"]);
    expect(textOf(outcome)).toContain("outside the affected runner cwd: src/ledger.ts");
  });

  it("AS-024: the epoch's changed files exclude a file deleted by stop time and carry a renamed file under its new path", () => {
    const root = repositoryRoot();
    const present = new Set(["src/ledger.ts", "src/new-name.ts"]);
    const events: Evidence[] = [
      { kind: "FileWrite", path: join(root, "src/old-name.ts"), via: "tool" },
      { kind: "FileWrite", path: join(root, "src/ledger.ts"), via: "tool" },
      // `mv src/old-name.ts src/new-name.ts` mints a shell FileWrite for its destination.
      { kind: "FileWrite", path: join(root, "src/new-name.ts"), via: "shell" },
    ];

    const observation = epochChangedFiles<string>({ kind: "read", events }, (_root, path) => present.has(path))(root);

    expect(observation).toEqual({ kind: "observed", changed: { kind: "some", files: ["src/ledger.ts", "src/new-name.ts"] } });
  });

  it("an unreadable epoch is unavailable rather than no changed files, and the affected check notes it", async () => {
    const root = repositoryRoot();
    const observation = epochChangedFiles<string>({ kind: "unreadable", reason: "ledger is corrupt" }, () => true)(root);
    expect(observation).toEqual({ kind: "unavailable", reason: "the attempt's ledger epoch is unreadable: ledger is corrupt" });

    const fake = fakePorts(root);
    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observation), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT.crashed);
    expect(textOf(outcome)).toContain("ledger is corrupt");
    expect(fake.launches).toEqual([]);
  });
});

describe("runStopChecks: failing open", () => {
  it(`AS-025: blocks ${AFFECTED_STOP_CHECK_MAX_BLOCKS} times, then fails open with the cap note without launching the runner`, async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] } });
    const stop = () => runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    const outcomes: StopChecksOutcome[] = [];
    for (let attempt = 0; attempt <= AFFECTED_STOP_CHECK_MAX_BLOCKS; attempt++) outcomes.push(await stop());

    expect(outcomes.map(({ kind }) => kind)).toEqual([...Array(AFFECTED_STOP_CHECK_MAX_BLOCKS).fill("block"), "note"]);
    expect(textOf(outcomes.at(-1)!)).toContain(AFFECTED_NOTE_TEXT["cap-reached"]);
    expect(fake.launches).toHaveLength(AFFECTED_STOP_CHECK_MAX_BLOCKS);
    expect(fake.counters.affected.get("session.agent")).toBe(0);
  });

  it("AS-025: an unreadable affected counter fails open naming it, and the runner never launches", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, {
      affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] },
      blocks: { affected: { kind: "unreadable", reason: "counter.json is not JSON" } },
    });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(`${AFFECTED_NOTE_TEXT["counter-unreadable"]}: counter.json is not JSON`);
    expect(fake.launches).toEqual([]);
  });

  it.each<[string, Run, keyof typeof AFFECTED_NOTE_TEXT]>([
    ["times out", { kind: "timed-out" }, "timed-out"],
    ["is killed", { kind: "killed" }, "killed"],
    ["leaves no report", { kind: "no-report" }, "no-readable-report"],
    ["leaves a report that changed after it was produced", { kind: "report-rewritten" }, "no-readable-report"],
    ["leaves a report that is not JUnit", { kind: "not-junit" }, "no-readable-report"],
    ["cannot start", { kind: "start-failed" }, "start-failed"],
    ["does not complete", { kind: "did-not-complete" }, "did-not-complete"],
  ])("AS-026: an affected runner that %s fails open with its named note, under one lock released once", async (_label, run, kind) => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: run });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT[kind]);
    expect(fake.counters.affected.get("session.agent")).toBe(0);
    expect(fake.locks).toMatchObject({ acquired: 1, released: 1 });
  });

  it("AS-026: an affected command the builder refuses fails open with the refusal, running nothing", async () => {
    const root = repositoryRoot();
    const nodeRunner = {
      executable: "node",
      args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${AFFECTED_REPORT}`, "{files}"],
      cwd: ".",
      timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
      report: { kind: "required-file", path: AFFECTED_REPORT },
    };
    const fake = fakePorts(root);

    const outcome = await runStopChecks(input(manifest({ affected: nodeRunner }), "T3", observed(changed(root, "src/ledger.test.js", "-e"))), fake.ports);

    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["command-refused"]);
    expect(textOf(outcome)).toContain("node arguments do not select an allowed project script");
    expect(fake.launches).toEqual([]);
  });

  it("an unavailable repository root fails both on-checks open, each with its own note", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { root: "unavailable" });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts"))), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain("acceptance stop check for T2 did not decide (no Git repository here)");
    expect(textOf(outcome)).toContain(`${AFFECTED_NOTE_TEXT["repository-unavailable"]} (no Git repository here)`);
    expect(fake.launches).toEqual([]);
  });

  it("AS-031: a runner lock another stop holds fails both checks open with a note, running nothing", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { lock: "held" });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts"))), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain("acceptance stop check for T2 did not decide (another stop (pid 7) holds the runner lock)");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["lock-held"]);
    expect(fake.launches).toEqual([]);
  });

  it("names a lock that would not release, and still blocks a failing stop", async () => {
    const root = repositoryRoot();
    const passingFake = fakePorts(root, { lock: "release-fails", affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] } });
    const passed = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), passingFake.ports);
    expect(passed).toEqual({ kind: "note", message: "stop checks for T3: the runner lock x.lock could not be released: EACCES" });

    const failingFake = fakePorts(root, { lock: "release-fails", affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] } });
    const blocked = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), failingFake.ports);
    expect(blocked.kind).toBe("block");
    expect(textOf(blocked)).toContain("could not be released: EACCES");
  });

  it("names both the crash and a lock that would not release when a runner throws under the lock", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { lock: "release-fails", affected: { kind: "throws" } });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome).toEqual({
      kind: "note",
      message: "stop checks for T3 crashed and did not decide: runner port defect\nstop checks for T3: the runner lock x.lock could not be released: EACCES",
    });
    expect(fake.locks).toMatchObject({ acquired: 1, released: 1, held: 0 });
    expect(fake.counters.affected.get("session.agent")).toBe(0);
  });

  it("turns a thrown fault, including an unloadable TaskGraph, into a crash note", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root);
    const unloadable = { ...input(manifest({ affected: true }), "T3", observed(NO_CHANGED_FILES)), loadGraph: () => { throw new Error("state file is corrupt"); } };

    expect(await runStopChecks(unloadable, fake.ports)).toEqual({ kind: "note", message: "stop checks for T3 crashed and did not decide: state file is corrupt" });
  });

  it("notes a counter that could not be cleared when the stop proceeds", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { clearFails: true, affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] } });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fake.ports);

    expect(outcome).toEqual({ kind: "note", message: "stop checks for T3: a block counter could not be cleared: EROFS: counter directory is read-only" });
  });
});

describe("runStopChecks: one lock, one sequence, one message, one budget", () => {
  it("AS-028: a claimant runs acceptance then affected under one lock, and one message carries each check's failures under its heading", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", "payload > parses")] },
    });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts"))), fake.ports);

    expect(outcome.kind).toBe("block");
    expect(fake.launches.map(({ check }) => check)).toEqual(["acceptance", "affected"]);
    expect(fake.launches.every(({ lockHeld }) => lockHeld)).toBe(true);
    expect(fake.locks).toMatchObject({ acquired: 1, released: 1 });
    const message = textOf(outcome);
    expect(message.indexOf(ACCEPTANCE_BLOCK_HEADING)).toBe(0);
    expect(message.indexOf(OWED)).toBeGreaterThan(0);
    expect(message.indexOf(AFFECTED_BLOCK_HEADING)).toBeGreaterThan(message.indexOf(OWED));
    expect(message.indexOf("'payload > parses' (src/payload.test.ts)")).toBeGreaterThan(message.indexOf(AFFECTED_BLOCK_HEADING));
    expect(fake.counters.acceptance.get("session.agent")).toBe(1);
    expect(fake.counters.affected.get("session.agent")).toBe(1);
  });

  it("AS-029: each check keeps its own cap: at the acceptance cap only the affected check blocks, and the acceptance runner does not run", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", "payload > parses")] },
      blocks: { acceptance: { kind: "count", blocks: ACCEPTANCE_STOP_CHECK_MAX_BLOCKS } },
    });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts"))), fake.ports);

    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).not.toContain(ACCEPTANCE_BLOCK_HEADING);
    expect(textOf(outcome)).toContain(AFFECTED_BLOCK_HEADING);
    expect(textOf(outcome)).toContain(`the acceptance stop check reached its ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS}-block cap`);
    expect(fake.launches.map(({ check }) => check)).toEqual(["affected"]);
    expect(fake.counters.affected.get("session.agent")).toBe(1);
    expect(fake.counters.acceptance.has("session.agent")).toBe(false);
  });

  it("AS-029: at the affected cap only the acceptance check blocks", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", "payload > parses")] },
      blocks: { affected: { kind: "count", blocks: AFFECTED_STOP_CHECK_MAX_BLOCKS } },
    });

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts"))), fake.ports);

    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(ACCEPTANCE_BLOCK_HEADING);
    expect(textOf(outcome)).not.toContain(AFFECTED_BLOCK_HEADING);
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["cap-reached"]);
    expect(fake.counters.acceptance.get("session.agent")).toBe(1);
    expect(fake.counters.affected.has("session.agent")).toBe(false);
  });

  const deadline = STOP_HOOK_BUDGET_MS - SETTLEMENT_RESERVE_MS;

  it.each<[string, number, boolean]>([
    ["one millisecond less than", deadline - MAX_AFFECTED_RUNNER_TIMEOUT_MS + 1, false],
    ["exactly", deadline - MAX_AFFECTED_RUNNER_TIMEOUT_MS, true],
    ["more than", 1_000, true],
  ])("AS-030: an acceptance run leaving %s the affected timeout decides the launch, and the full timeout is never clipped", async (_label, acceptanceMs, launches) => {
    const root = repositoryRoot();
    const fake = fakePorts(root, {
      acceptance: { kind: "report", cases: [passing(SURFACE.acceptance, OWED)], tookMs: acceptanceMs },
      affected: { kind: "timed-out" },
    });
    const startedAtMs = fake.clock.ms;

    const outcome = await runStopChecks(input(manifest({ acceptance: true, affected: true }), "T2", observed(changed(root, "src/payload.ts")), startedAtMs), fake.ports);

    expect(fake.launches.map(({ check }) => check)).toEqual(launches ? ["acceptance", "affected"] : ["acceptance"]);
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT[launches ? "timed-out" : "budget-exhausted"]);
    expect(fake.clock.ms - startedAtMs).toBeLessThanOrEqual(deadline);
  });

  it("AS-030: a hook that started long ago leaves no budget, so the affected runner never launches", async () => {
    const root = repositoryRoot();
    const fake = fakePorts(root, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] } });

    const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts")), fake.clock.ms - STOP_HOOK_BUDGET_MS), fake.ports);

    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(AFFECTED_NOTE_TEXT["budget-exhausted"]);
    expect(fake.launches).toEqual([]);
  });

  it("AS-027: every outcome carries only its kind and text, never a report, digest or testcase record", async () => {
    const root = repositoryRoot();
    const runs: readonly Run[] = [
      { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] },
      { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] },
      { kind: "report", cases: [] },
      { kind: "timed-out" },
      { kind: "no-report" },
    ];
    for (const run of runs) {
      const outcome = await runStopChecks(input(manifest({ affected: true }), "T3", observed(changed(root, "src/ledger.ts"))), fakePorts(root, { affected: run }).ports);
      expect(Object.keys(outcome).every((key) => key === "kind" || key === "message")).toBe(true);
    }
  });
});

describe("stopChecksReportLine (Pi report-only)", () => {
  it("prints nothing for a skip and one operator line naming both checks otherwise", () => {
    expect(stopChecksReportLine("T2", { kind: "skip" })).toBeNull();
    expect(stopChecksReportLine("T2", { kind: "passed" })).toBe("stop checks: every acceptance and affected-test check that ran for T2 passes");
    expect(stopChecksReportLine("T2", { kind: "note", message: "did not decide" })).toBe("did not decide");
    expect(stopChecksReportLine("T2", { kind: "block", message: "still failing" }))
      .toBe("stop checks (report-only on Pi; the agent has already ended): T2\nstill failing");
  });
});

describe("helper stop-check-plan: the liveAttemptEvidence port", () => {
  const savedState = process.env.LOOM_STATE_PATH;
  afterEach(() => {
    if (savedState === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = savedState;
  });

  /** A State File for `graph(...)` in a fresh Git project, with `LOOM_STATE_PATH` pointed at it. */
  function stateFile(frozen: FrozenVerificationManifest): string {
    const root = gitProject("loom-stop-checks-helper-", roots);
    const built = graph(frozen);
    const { json } = stopCheckGraph({ tasks: built.tasks, contracts: built.acceptance_contracts ?? [], manifest: frozen });
    const path = writeStateFile(root, json);
    process.env.LOOM_STATE_PATH = path;
    return path;
  }

  const plan = async (live: LiveAttemptEvidenceFn, taskId = "T3") => {
    const written: string[] = [];
    const result = await createStopCheckPlanHandler((text) => { written.push(text); }, undefined, live)("", ["--task", taskId]);
    return { result, text: written.join("") };
  };

  it("AS-032: renders the changed files of the epoch the port returns, asking it about the named Task and this TaskGraph", async () => {
    const path = stateFile(manifest({ affected: true }));
    const asked: string[] = [];
    const root = dirname(dirname(path));
    const { result, text } = await plan((taskId, statePath) => {
      asked.push(`${taskId} ${statePath}`);
      return { kind: "live", ledger: { kind: "read", events: [{ kind: "FileWrite", path: join(root, "src/ledger.ts"), via: "tool" }] } };
    });

    expect(result).toEqual({ kind: "passthrough" });
    expect(asked).toEqual([`T3 ${path}`]);
    // The file does not exist in the project, so the stop-time existence filter drops it.
    expect(text).toContain(AFFECTED_OFF_REASON_TEXT["no-changed-files"]);
  });

  it("AS-033: no live attempt renders no changed files", async () => {
    stateFile(manifest({ affected: true }));
    const { text } = await plan(() => ({ kind: "no-live-attempt" }));
    expect(text).toContain(`${AFFECTED_STOP_CHECK_OFF} — ${AFFECTED_OFF_REASON_TEXT["no-changed-files"]}`);
  });

  it("FR-029: a live attempt whose epoch cannot be read is refused naming why, and nothing is printed", async () => {
    stateFile(manifest({ affected: true }));
    const { result, text } = await plan(() => ({ kind: "live", ledger: { kind: "unreadable", reason: "evidence ledger is corrupt" } }));
    expect(result).toEqual({ kind: "error", message: "stop-check-plan: the attempt's ledger epoch is unreadable: evidence ledger is corrupt" });
    expect(text).toBe("");
  });

  it("FR-029: an unknown Task id is still refused naming it", async () => {
    stateFile(manifest({ affected: true }));
    const { result, text } = await plan(() => ({ kind: "no-live-attempt" }), "T9");
    expect(result).toEqual({ kind: "error", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });
    expect(text).toBe("");
  });
});

describe("production stop-check ports", () => {
  const savedDir = process.env.LOOM_SUBAGENT_DIR;
  afterEach(() => {
    if (savedDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
    else process.env.LOOM_SUBAGENT_DIR = savedDir;
  });
  const subagentDir = (): string => {
    const dir = canonicalTempDir("loom-stop-checks-subagents-");
    roots.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    return dir;
  };

  it("AS-029: keeps the affected counter in its own file, independent of the acceptance counter", () => {
    const dir = subagentDir();
    const ports = PRODUCTION_STOP_CHECK_PORTS;
    ports.recordBlock("s.a", 2);
    ports.recordAffectedBlock("s.a", 1);
    expect(ports.blocksIssued("s.a")).toEqual({ kind: "count", blocks: 2 });
    expect(ports.affectedBlocksIssued("s.a")).toEqual({ kind: "count", blocks: 1 });
    expect(existsSync(join(dir, "s.a.affected-stop-check.json"))).toBe(true);
    ports.clearAffectedBlocks("s.a");
    expect(existsSync(join(dir, "s.a.affected-stop-check.json"))).toBe(false);
    expect(ports.blocksIssued("s.a")).toEqual({ kind: "count", blocks: 2 });
    ports.clearBlocks("s.a");
    expect(ports.affectedBlocksIssued("s.a")).toEqual({ kind: "count", blocks: 0 });
  });

  it("reads a corrupt affected counter as unreadable, naming the file", () => {
    const dir = subagentDir();
    writeFileSync(join(dir, "s.a.affected-stop-check.json"), "{not json");
    expect(PRODUCTION_STOP_CHECK_PORTS.affectedBlocksIssued("s.a")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("is not JSON") });
  });

  it("answers whether a changed file exists beneath the repository root", () => {
    const root = repositoryRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/ledger.ts"), "");
    const exists = PRODUCTION_STOP_CHECK_PORTS.pathExists;
    const files = changed(root, "src/ledger.ts", "src/gone.ts");
    if (files.kind !== "some") throw new Error("fixture");
    expect(files.files.map((path) => exists(root, path))).toEqual([true, false]);
  });

  it("keeps no affected counter in the Pi report-only form", () => {
    const dir = subagentDir();
    REPORT_ONLY_STOP_CHECK_PORTS.recordAffectedBlock("pi.T2", 1);
    expect(REPORT_ONLY_STOP_CHECK_PORTS.affectedBlocksIssued("pi.T2")).toEqual({ kind: "count", blocks: 0 });
    expect(existsSync(join(dir, "pi.T2.affected-stop-check.json"))).toBe(false);
  });
});
