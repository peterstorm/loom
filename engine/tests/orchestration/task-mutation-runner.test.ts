/**
 * The Task mutation check's shells (ADR-0071):
 * - `runFileMutants`, the sequencing policy over one file, with a scripted
 *   runner port and clock: baseline first, mutants in plan order, and no
 *   launch the deadline cannot hold;
 * - the record store: what is written is what is read, absence is `not-run`,
 *   and anything else is a named failure;
 * - `runTaskMutationCheck` and `helper mutation-check` over a real repository
 *   whose runner really executes the Task's tests: survivors, a clean run, an
 *   untested file, a red baseline, and that the real workspace is only read.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { emptyAcceptanceExpectation } from "../../src/core/acceptance-contract";
import { applyMutant, MUTANT_CAP_PER_TASK, taskMutants } from "../../src/core/owner-verification/mutation-plan";
import type { MatrixTestRun } from "../../src/core/owner-verification/types";
import {
  KILLING_TEST,
  mutantsByFile,
  recordedTaskMutation,
  TASK_MUTATION_DEADLINE_MS,
  TASK_MUTATION_NOT_RUN,
  taskMutationDuty,
  taskMutationUnavailable,
  type FileMutants,
  type OwedTaskMutation,
  type TaskMutationResult,
} from "../../src/core/task-mutation-check";
import { createMutationCheckHandler, type MutationCheckPorts } from "../../src/handlers/helpers/mutation-check";
import { PRODUCTION_STOP_CHECK_PORTS } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import type { OwnerVariant } from "../../src/orchestration/owner-mutation-workspace";
import {
  observeTaskMutation,
  observeTaskMutationDigest,
  readTaskMutationRecord,
  taskIdFileSegment,
  taskMutationRecordPath,
  writeTaskMutationRecord,
} from "../../src/orchestration/task-mutation-record";
import { runFileMutants, runTaskMutationCheck, type TaskMutationBudget } from "../../src/orchestration/task-mutation-runner";
import type { HookResult } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { junitReport, talliedResult, type JunitCase } from "../fixtures/task-mutation";
import {
  cleanupTaskMutationRepos,
  GUARDED_IMPL,
  LEDGER,
  ledgerTestText,
  taskMutationRepo,
  type TaskMutationRepo,
  type TaskMutationRepoOptions,
} from "../fixtures/task-mutation-repo";

const savedStatePath = process.env.LOOM_STATE_PATH;
const temporary: string[] = [];

afterEach(() => {
  cleanupTaskMutationRepos();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (savedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = savedStatePath;
});

function tempDir(): string {
  const directory = canonicalTempDir("loom-task-mutation-records-");
  temporary.push(directory);
  return directory;
}

// --- runFileMutants ---

const NO_CONTRACTS = emptyAcceptanceExpectation(1);
const TEST_FILE = "src/ledger.test.ts";
const SOURCE = [
  "export function debit(balance: number, amount: number): number {",
  "  if (amount <= 0) throw new RangeError();",
  "  if (amount > balance) return balance;",
  "  return balance - amount;",
  "}",
  "",
].join("\n");

/** Every mutant of `SOURCE`'s body, as one file's plan. */
function sourceMutants(): FileMutants {
  const planned = taskMutants([{ path: "src/ledger.ts", text: SOURCE, changedLines: new Set([2, 3, 4]) }], MUTANT_CAP_PER_TASK);
  if (!planned.ok) throw new Error("the fixture source parses");
  const [file] = mutantsByFile(planned.value.mutants);
  if (file === undefined) throw new Error("the fixture source holds mutation sites");
  return file;
}

const FILE = sourceMutants();
const passing: JunitCase = { file: TEST_FILE, name: "debits", outcome: "passed" };
const failing: JunitCase = { file: TEST_FILE, name: "refuses zero", outcome: "failed" };
const reported = (cases: readonly JunitCase[]): MatrixTestRun =>
  ({ kind: "exited", exitCode: cases.some(({ outcome }) => outcome === "failed") ? 1 : 0, signal: null, report: { kind: "produced", bytes: junitReport(cases) } });
const GREEN = reported([passing]);
const KILLED = reported([passing, failing]);
const TIMED_OUT: MatrixTestRun = { kind: "timed-out", elapsedMs: 1_000 };
const NO_REPORT: MatrixTestRun = { kind: "exited", exitCode: 0, signal: null, report: { kind: "missing" } };

/** A runner port that answers each launch from `answer` and records the variant it was given; each launch takes `msPerRun`. */
function scripted(answer: (variant: OwnerVariant, launch: number) => MatrixTestRun, msPerRun = 0) {
  const variants: OwnerVariant[] = [];
  const clock = { ms: 0 };
  const run = async (variant: OwnerVariant): Promise<MatrixTestRun> => {
    variants.push(variant);
    clock.ms += msPerRun;
    return answer(variant, variants.length - 1);
  };
  const budget = (deadlineMs: number, runTimeoutMs: number): TaskMutationBudget => ({ deadlineMs, now: () => clock.ms, runTimeoutMs });
  return { run, variants, budget };
}

const AMPLE = (port: ReturnType<typeof scripted>): TaskMutationBudget => port.budget(TASK_MUTATION_DEADLINE_MS, 1_000);

describe("runFileMutants", () => {
  it("runs the unmutated file first, then each mutant's text in plan order", async () => {
    const port = scripted((variant) => variant.kind === "baseline" ? GREEN : KILLED);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(port.variants).toEqual([{ kind: "baseline" }, ...FILE.mutants.map((mutant) => ({ kind: "mutant", text: applyMutant(SOURCE, mutant) }))]);
    expect(ran).toEqual({ ok: true, value: FILE.mutants.map((mutant) => ({ mutant, outcome: "killed" })) });
  });

  it("judges each mutant by its own run: killed, survived, timed out, or no evidence", async () => {
    const answers = [GREEN, KILLED, GREEN, TIMED_OUT, reported([])];
    const port = scripted((_variant, launch) => answers[launch] ?? KILLED);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(ran.ok && ran.value.slice(0, 4).map(({ outcome }) => outcome)).toEqual(["killed", "survived", "killed", "invalid"]);
  });

  it("launches no mutant over a red baseline, and says a sibling's work may be the cause", async () => {
    const port = scripted(() => KILLED);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(ran).toEqual({ ok: false, error: expect.stringContaining(`the unmutated tests of src/ledger.ts fail ('refuses zero' (${TEST_FILE}))`) });
    expect(ran.ok ? "" : ran.error).toContain("a sibling Task's unfinished work may be the cause");
    expect(port.variants).toHaveLength(1);
  });

  it.each<[string, MatrixTestRun, string]>([
    ["left no report", NO_REPORT, "without writing its report"],
    ["timed out", TIMED_OUT, "exceeded its time limit"],
    ["could not start", { kind: "spawn-failed", message: "spawn node ENOENT" }, "spawn node ENOENT"],
  ])("launches no mutant when the unmutated run %s", async (_label, baseline, reason) => {
    const port = scripted(() => baseline);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(ran.ok ? "" : ran.error).toContain("the unmutated run of src/ledger.ts could not be observed");
    expect(ran.ok ? "" : ran.error).toContain(reason);
    expect(port.variants).toHaveLength(1);
  });

  it("leaves every mutant of a file no test ran for surviving, unrun", async () => {
    const port = scripted(() => reported([]));
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(ran).toEqual({ ok: true, value: FILE.mutants.map((mutant) => ({ mutant, outcome: "untested" })) });
    expect(port.variants).toHaveLength(1);
  });

  it("ends without a result when a mutant's run cannot be observed", async () => {
    const port = scripted((variant, launch) => variant.kind === "baseline" ? GREEN : launch === 2 ? NO_REPORT : KILLED);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, AMPLE(port));
    expect(ran.ok ? "" : ran.error).toContain("a mutant run of src/ledger.ts could not be observed");
    expect(port.variants).toHaveLength(3);
  });

  it("launches nothing when the deadline cannot hold one whole run", async () => {
    const port = scripted(() => GREEN);
    const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, port.budget(999, 1_000));
    expect(ran).toEqual({ ok: false, error: "its 480 s deadline cannot hold another run (999 ms left, one run may take 1000 ms)" });
    expect(port.variants).toEqual([]);
  });

  it("property: no run launches with less than its whole timeout left, and a run that does not finish in time has no result", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 12_000 }), fc.integer({ min: 1, max: 1_500 }), fc.integer({ min: 1, max: 1_500 }),
      async (deadlineMs, runTimeoutMs, msPerRun) => {
        const port = scripted((variant) => variant.kind === "baseline" ? GREEN : KILLED, msPerRun);
        const ran = await runFileMutants(port.run, FILE, SOURCE, NO_CONTRACTS, port.budget(deadlineMs, runTimeoutMs));
        const launches = port.variants.length;
        // Launch `n` (from 0) starts at `n * msPerRun`, and may only start with a whole timeout left.
        const affordable = (launch: number): boolean => deadlineMs - launch * msPerRun >= runTimeoutMs;
        for (let launch = 0; launch < launches; launch++) expect(affordable(launch)).toBe(true);
        expect(ran.ok).toBe(launches === FILE.mutants.length + 1);
        if (!ran.ok) expect(affordable(launches)).toBe(false);
      }), { numRuns: 200 });
  });
});

// --- The record store ---

describe("the Task mutation record store", () => {
  const repo = (options: TaskMutationRepoOptions = { tests: "strong" }): Readonly<{ at: TaskMutationRepo; duty: OwedTaskMutation }> => {
    const at = taskMutationRepo(options);
    const duty = taskMutationDuty(at.graph, LEDGER.taskId);
    if (duty.kind !== "owed") throw new Error(`the fixture Task owes the check, but is ${duty.reason}`);
    return { at, duty };
  };
  const CLEAN: TaskMutationResult = talliedResult({ killed: 3, candidates: 3 });

  it("reads back the record it wrote, and replaces an earlier one, leaving no staged file", () => {
    const { at, duty } = repo();
    const directory = tempDir();
    const digest = observeTaskMutationDigest(at.root, duty);
    if (!digest.ok) throw new Error(digest.error);
    const first = recordedTaskMutation(LEDGER.taskId, digest.value, taskMutationUnavailable("the unmutated tests fail"));
    const second = recordedTaskMutation(LEDGER.taskId, digest.value, CLEAN);
    expect(writeTaskMutationRecord(at.root, first, directory)).toEqual({ ok: true, value: taskMutationRecordPath(at.root, LEDGER.taskId, directory) });
    expect(readTaskMutationRecord(at.root, LEDGER.taskId, directory)).toEqual({ ok: true, value: first });
    expect(writeTaskMutationRecord(at.root, second, directory).ok).toBe(true);
    expect(readTaskMutationRecord(at.root, LEDGER.taskId, directory)).toEqual({ ok: true, value: second });
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("reads no file, and a directory that does not exist, as a check that never ran", () => {
    const { at } = repo();
    expect(readTaskMutationRecord(at.root, LEDGER.taskId, tempDir())).toEqual({ ok: true, value: TASK_MUTATION_NOT_RUN });
    expect(readTaskMutationRecord(at.root, LEDGER.taskId, join(tempDir(), "missing"))).toEqual({ ok: true, value: TASK_MUTATION_NOT_RUN });
  });

  it("keeps one record per repository and Task, under a name that holds no path separator", () => {
    const [left, right] = [repo().at, repo().at];
    const directory = tempDir();
    const paths = [
      taskMutationRecordPath(left.root, "T1", directory),
      taskMutationRecordPath(left.root, "T2", directory),
      taskMutationRecordPath(right.root, "T1", directory),
      taskMutationRecordPath(left.root, "../T1", directory),
      taskMutationRecordPath(left.root, "T 1", directory),
      taskMutationRecordPath(left.root, "T_1", directory),
      taskMutationRecordPath(left.root, "T_201", directory),
    ];
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.slice(directory.length + 1)).toMatch(/^task-mutation\.[0-9a-f]{16}\.[A-Za-z0-9_-]+\.json$/);
  });

  it("keeps an ordinary Task id readable in its file name", () => {
    expect(taskIdFileSegment("T12")).toBe("T12");
    expect(taskIdFileSegment("wave-2-T3")).toBe("wave-2-T3");
    expect(taskIdFileSegment("T 1")).toBe("T_201");
    expect(taskIdFileSegment("T_1")).toBe("T_5f1");
  });

  it("escapes each UTF-8 byte of a multi-byte character, and only those", () => {
    expect(taskIdFileSegment("Té")).toBe("T_c3_a9");
    expect(taskIdFileSegment("T😀1")).toBe("T_f0_9f_98_801");
  });

  it("property: two distinct Task ids never share a record file name, and none holds a separator", () => {
    const id = fc.string({ unit: fc.constantFrom("T", "1", "_", " ", "-", "/", ".", "é", "2", "f"), minLength: 1, maxLength: 8 });
    fc.assert(fc.property(id, id, (left, right) => {
      expect(taskIdFileSegment(left) === taskIdFileSegment(right)).toBe(left === right);
      expect(taskIdFileSegment(left)).toMatch(/^[A-Za-z0-9_-]+$/);
    }));
  });

  it.each([
    ["text that is not JSON", "{ nope", /is not JSON/],
    ["a document that is no record", JSON.stringify({ schemaVersion: 1 }), /taskMutationRecord lacks/],
  ])("refuses %s, naming the file", (_label, text, reason) => {
    const { at } = repo();
    const directory = tempDir();
    const path = taskMutationRecordPath(at.root, LEDGER.taskId, directory);
    writeFileSync(path, text);
    const read = readTaskMutationRecord(at.root, LEDGER.taskId, directory);
    expect(read.ok ? "" : read.error).toMatch(reason);
    expect(read.ok ? "" : read.error).toContain(path);
  });

  it("returns a failed write as data when its directory cannot be made", () => {
    const { at, duty } = repo();
    const blocked = join(tempDir(), "not-a-directory");
    writeFileSync(blocked, "");
    const digest = observeTaskMutationDigest(at.root, duty);
    if (!digest.ok) throw new Error(digest.error);
    expect(writeTaskMutationRecord(at.root, recordedTaskMutation(LEDGER.taskId, digest.value, CLEAN), blocked).ok).toBe(false);
  });

  it("digests a declared file that is not there as absent, and moves when it appears", () => {
    const { at, duty } = repo({ tests: "none" });
    const without = observeTaskMutationDigest(at.root, duty);
    at.write(LEDGER.test, ledgerTestText("strong"));
    const withTest = observeTaskMutationDigest(at.root, duty);
    expect(without.ok && withTest.ok && without.value !== withTest.value).toBe(true);
  });

  it("observes a record of other bytes as stale, with the command that refreshes it", () => {
    const { at, duty } = repo();
    const directory = tempDir();
    const observe = observeTaskMutation("/opt/loom", () => directory);
    expect(observe(duty, at.root)).toMatchObject({ kind: "observed", standing: { kind: "not-run" } });
    const digest = observeTaskMutationDigest(at.root, duty);
    if (!digest.ok) throw new Error(digest.error);
    writeTaskMutationRecord(at.root, recordedTaskMutation(LEDGER.taskId, digest.value, CLEAN), directory);
    expect(observe(duty, at.root)).toEqual({
      kind: "observed",
      standing: { kind: "current", result: CLEAN },
      command: "bun '/opt/loom/engine/src/cli.ts' helper mutation-check --task 'T1'",
    });
    at.write(LEDGER.impl, `${GUARDED_IMPL}// edited\n`);
    expect(observe(duty, at.root)).toMatchObject({ kind: "observed", standing: { kind: "stale" } });
  });
});

// --- The real run ---

/** Run `helper mutation-check` over `at` with the production runner; what it printed and returned. */
async function helper(
  at: TaskMutationRepo,
  args: readonly string[] = ["--task", LEDGER.taskId],
  overrides: Partial<MutationCheckPorts> = {},
): Promise<Readonly<{ result: HookResult; printed: string; records: string }>> {
  process.env.LOOM_STATE_PATH = at.statePath;
  const printed: string[] = [];
  const records = overrides.recordDirectory ?? tempDir();
  const handler = createMutationCheckHandler({
    write: (text) => { printed.push(text); },
    repositoryRoot: PRODUCTION_STOP_CHECK_PORTS.repositoryRoot,
    run: runTaskMutationCheck,
    now: () => Date.now(),
    ...overrides,
    recordDirectory: records,
  });
  return { result: await handler("", [...args]), printed: printed.join(""), records };
}

const standingOf = (at: TaskMutationRepo, records: string) => {
  const duty = taskMutationDuty(at.graph, LEDGER.taskId);
  if (duty.kind !== "owed") throw new Error("the fixture Task owes the check");
  const observation = observeTaskMutation("/opt/loom", () => records)(duty, at.root);
  return observation.kind === "observed" ? observation.standing : observation;
};

describe("helper mutation-check over a real repository", () => {
  it("names the guard a weak test leaves standing, with the test that kills it, and records the survivors", async () => {
    const at = taskMutationRepo({ tests: "weak" });
    const { result, printed, records } = await helper(at);
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toMatch(/^Task mutation check for T1: \d+ of \d+ mutant\(s\) survived \(of \d+ site\(s\) on changed lines\)\.\n/);
    expect(printed).toContain(`- ${LEDGER.impl}:2:3 guard-removal: \`if (amount <= 0) throw new RangeError("amount must be positive");\` → \`;\``);
    expect(printed).toContain(`  killed by: ${KILLING_TEST["guard-removal"]}`);
    expect(printed).not.toContain("(no test ran for this file)");
    expect(standingOf(at, records)).toMatchObject({ kind: "current", result: { kind: "survivors" } });
  });

  it("is clean once the tests assert both sides of the guard, and stale again once a test changes", async () => {
    const at = taskMutationRepo({ tests: "strong" });
    const { printed, records } = await helper(at);
    expect(printed).toMatch(/^Task mutation check for T1: clean — your tests killed all \d+ mutant\(s\)/);
    expect(standingOf(at, records)).toMatchObject({ kind: "current", result: { kind: "clean" } });
    at.write(LEDGER.test, ledgerTestText("weak"));
    expect(standingOf(at, records)).toEqual({ kind: "stale" });
  });

  it("goes from survivors to clean when the missing tests are added and the check is run again", async () => {
    const at = taskMutationRepo({ tests: "weak" });
    const records = tempDir();
    expect((await helper(at, undefined, { recordDirectory: records })).printed).toContain("survived");
    at.write(LEDGER.test, ledgerTestText("strong"));
    expect(standingOf(at, records)).toEqual({ kind: "stale" });
    expect((await helper(at, undefined, { recordDirectory: records })).printed).toContain("clean");
    expect(standingOf(at, records)).toMatchObject({ kind: "current", result: { kind: "clean" } });
  });

  it("reports every mutant of a file no test ran for as a survivor, without running one", async () => {
    const at = taskMutationRepo({ tests: "none" });
    const { printed } = await helper(at);
    expect(printed).toContain("guard-removal");
    expect(printed.match(/\(no test ran for this file\)/g)?.length).toBeGreaterThan(0);
    expect(printed.match(/^- /gm)?.length).toBe(printed.match(/\(no test ran for this file\)/g)?.length);
  });

  it("is unavailable over a red baseline, names the failing test, and records a result that never blocks", async () => {
    const at = taskMutationRepo({ tests: "red" });
    const { result, printed, records } = await helper(at);
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toContain(`Task mutation check for T1: unavailable — the unmutated tests of ${LEDGER.impl} fail ('debits' (${LEDGER.test}))`);
    expect(printed).toContain("It did not decide and will not block your stop.");
    expect(printed).not.toContain("survived");
    expect(standingOf(at, records)).toMatchObject({ kind: "current", result: { kind: "unavailable" } });
  });

  it("only reads the real workspace: no file changes, no report is left, and its worktrees are removed", async () => {
    const at = taskMutationRepo({ tests: "weak" });
    const before = [LEDGER.impl, LEDGER.test, LEDGER.runner].map((path) => readFileSync(join(at.root, path), "utf8"));
    const state = readFileSync(at.statePath, "utf8");
    await helper(at);
    expect([LEDGER.impl, LEDGER.test, LEDGER.runner].map((path) => readFileSync(join(at.root, path), "utf8"))).toEqual(before);
    expect(readFileSync(at.statePath, "utf8")).toBe(state);
    expect(existsSync(join(at.root, LEDGER.report))).toBe(false);
    expect(at.worktrees()).toEqual([at.root]);
  });

  it("is unavailable for a Task with no start_sha: the lines it changed cannot be told", async () => {
    const { printed } = await helper(taskMutationRepo({ tests: "strong", startSha: "absent" }));
    expect(printed).toContain("unavailable — Task T1 records no start_sha");
  });

  it("is unavailable, and recorded as stale, when the Task's files change while it runs", async () => {
    const at = taskMutationRepo({ tests: "strong" });
    const run = async (): Promise<TaskMutationResult> => {
      at.write(LEDGER.impl, `${GUARDED_IMPL}// edited mid-run\n`);
      return talliedResult({ killed: 1, candidates: 1 });
    };
    const { printed, records } = await helper(at, undefined, { run });
    expect(printed).toContain("unavailable — the Task's files changed while the check ran");
    expect(standingOf(at, records)).toEqual({ kind: "stale" });
  });

  it("says a Task owes nothing when the operator switched the check off, and runs nothing", async () => {
    const run = async (): Promise<TaskMutationResult> => { throw new Error("unreachable"); };
    const { result, printed, records } = await helper(taskMutationRepo({ tests: "weak", taskMutationCheck: "off" }), undefined, { run });
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toBe('Task mutation check for T1: not owed — the verification manifest sets taskMutationCheck to "off".\n');
    expect(readdirSync(records)).toEqual([]);
  });

  it.each<[string, readonly string[], RegExp]>([
    ["no --task", [], /mutation-check requires --task <task-id>/],
    ["an unknown argument", ["--task", "T1", "--force"], /unknown or unconsumed argument\(s\): --force/],
    ["a Task the TaskGraph does not hold", ["--task", "T9"], /Task T9 is not in the TaskGraph/],
  ])("refuses %s as an error, printing nothing", async (_label, args, message) => {
    const { result, printed } = await helper(taskMutationRepo({ tests: "strong" }), args);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" ? result.message : "").toMatch(message);
    expect(printed).toBe("");
  });

  it("returns an unwritable record as an error that still carries the result", async () => {
    const blocked = join(tempDir(), "not-a-directory");
    writeFileSync(blocked, "");
    const run = async (): Promise<TaskMutationResult> => talliedResult({ killed: 2, candidates: 2 });
    const { result } = await helper(taskMutationRepo({ tests: "strong" }), undefined, { run, recordDirectory: blocked });
    expect(result.kind === "error" ? result.message : "").toMatch(/the record could not be written .*the result was:\nTask mutation check for T1: clean/s);
  });

  it("never throws: a repository whose worktrees cannot be made is an unavailable result", async () => {
    const at = taskMutationRepo({ tests: "strong" });
    mkdirSync(join(at.root, ".git"), { recursive: true });
    writeFileSync(join(at.root, ".git", "worktrees"), "");
    const { result, printed } = await helper(at);
    expect(result).toEqual({ kind: "passthrough" });
    expect(printed).toContain("Task mutation check for T1: unavailable — worktree-failed");
  });
});
