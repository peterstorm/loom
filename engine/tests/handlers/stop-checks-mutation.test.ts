/**
 * The Task mutation check as the third arm of `runStopChecks` (ADR-0071),
 * over a real record file and real Task files, with in-memory runner ports:
 * - a stop is held while the Task's record is missing, stale or names
 *   survivors, at most `TASK_MUTATION_STOP_CHECK_MAX_BLOCKS` times, and then
 *   proceeds with a note;
 * - a clean record of these very bytes passes, and a proceeding stop clears
 *   the arm's counter;
 * - every fault fails open: an unavailable run, an unreadable record, an
 *   unreadable Task file, a throwing observation, no repository root, an
 *   unreadable counter;
 * - the arm runs no runner and joins the affected-test check in one block;
 * - on Pi the same finding is one report-only operator line, every time.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { reportImplementationStopChecks } from "../../../pi/subagent-stop";
import {
  AFFECTED_BLOCK_HEADING,
  MUTATION_BLOCK_HEADING,
  TASK_MUTATION_STOP_CHECK_MAX_BLOCKS,
  type StopCheckBlockCount,
  type StopChecksOutcome,
} from "../../src/core/affected-stop-check-types";
import { changedFilesAtStop } from "../../src/core/changed-files";
import {
  recordedTaskMutation,
  taskMutationCommand,
  taskMutationDuty,
  taskMutationResultOf,
  taskMutationUnavailable,
  type TaskMutationObservation,
  type TaskMutationResult,
  type TaskMutationStanding,
} from "../../src/core/task-mutation-check";
import type { TaskMutant } from "../../src/core/owner-verification/mutation-plan";
import { REPORT_ONLY_STOP_CHECK_PORTS } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { runStopChecks, type StopChecksInput } from "../../src/handlers/subagent-stop/stop-checks";
import type { Evidence } from "../../src/machine";
import {
  observeTaskMutation,
  observeTaskMutationDigest,
  taskMutationRecordPath,
  writeTaskMutationRecord,
} from "../../src/orchestration/task-mutation-record";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { task } from "../fixtures/contract-status-fixtures";
import { inMemoryBlockCounters } from "../fixtures/stop-check-block-counters";
import { recordingStopCheckPorts } from "../fixtures/stop-check-runners";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { junitReport, mutationManifest, START_SHA, type JunitCase, type MutationManifestOverrides } from "../fixtures/task-mutation";

const IMPL = "src/ledger.ts";
const TEST = "src/ledger.test.ts";
const PACKAGE_ROOT = "/opt/loom";
const AGENT = "session.agent";
const COMMAND = taskMutationCommand(PACKAGE_ROOT, "T2");
const PASSING: JunitCase = { file: TEST, name: "ledger > debits", outcome: "passed" };
const FAILING: JunitCase = { file: TEST, name: "ledger > credits", outcome: "failed" };
const CLEAN: TaskMutationResult = { kind: "clean", mutants: 3, candidates: 3 };
const GUARD: TaskMutant = {
  id: "guard", path: IMPL, line: 4, column: 3, start: 40, end: 70, operator: "guard-removal",
  original: "if (amount <= 0) throw new RangeError();", replacement: ";",
};
const SURVIVORS = taskMutationResultOf([{ mutant: GUARD, outcome: "survived" }], 5);

const graph = (overrides: MutationManifestOverrides = {}): TaskGraph => ({
  ...graphFixture([taskFixture({ ...task("T2", 2, [IMPL, TEST]), start_sha: START_SHA })]),
  verification_manifest: mutationManifest(overrides),
});

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = canonicalTempDir(prefix);
  temporary.push(directory);
  return directory;
}

/** A repository root holding the Task's two files, and an empty record directory. */
function workspace(): Readonly<{ root: CanonicalRepositoryRoot; records: string }> {
  const parsed = parseCanonicalRepositoryRoot(tempDir("loom-stop-mutation-"));
  if (!parsed.ok) throw new Error("root fixture");
  const root = parsed.value;
  writeFile(root, IMPL, "export const debit = (amount: number) => { if (amount <= 0) throw new RangeError(); return -amount; };\n");
  writeFile(root, TEST, "import './ledger';\n");
  return { root, records: tempDir("loom-stop-mutation-records-") };
}

function writeFile(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Record `result` as a run over the Task's files as they are now. */
function record({ root, records }: ReturnType<typeof workspace>, result: TaskMutationResult): void {
  const duty = taskMutationDuty(graph(), "T2");
  if (duty.kind !== "owed") throw new Error("the fixture Task owes the check");
  const digest = observeTaskMutationDigest(root, duty);
  if (!digest.ok) throw new Error(digest.error);
  const written = writeTaskMutationRecord(root, recordedTaskMutation("T2", digest.value, result), records);
  if (!written.ok) throw new Error(written.error);
}

type StopOptions = Readonly<{
  manifest?: MutationManifestOverrides;
  taskMutation?: StopChecksInput["taskMutation"];
  /** The implementation files the attempt changed; none by default, so the affected check has nothing to run. */
  changed?: readonly string[];
  affected?: readonly JunitCase[];
  presets?: Partial<Readonly<Record<"mutation" | "affected", StopCheckBlockCount>>>;
  root?: "unavailable";
}>;

/** One agent's stops over `space`: each call is one stop, and the counters persist between them. */
function stopper(space: ReturnType<typeof workspace>, options: StopOptions = {}) {
  const { counters, counts } = inMemoryBlockCounters(options.presets === undefined ? {} : { presets: options.presets });
  const { ports, launches } = recordingStopCheckPorts({ root: space.root, report: () => junitReport(options.affected ?? [PASSING]), blocks: counters });
  const files = options.changed ?? [];
  const input: StopChecksInput = {
    loadGraph: () => graph(options.manifest),
    stateFilePath: join(space.root, ".loom", "active_task_graph.json"),
    taskId: "T2",
    agentKey: AGENT,
    changedFiles: (root) => ({
      kind: "observed",
      changed: changedFilesAtStop(files.map((path): Evidence => ({ kind: "FileWrite", path: join(root, path), via: "tool" })), root, () => true),
    }),
    taskMutation: options.taskMutation ?? observeTaskMutation(PACKAGE_ROOT, () => space.records),
    hookStartedAtMs: 0,
  };
  const shell = options.root === "unavailable"
    ? { ...ports, repositoryRoot: () => ({ ok: false as const, reason: "no Git repository here" }) }
    : ports;
  return { stop: () => runStopChecks(input, shell), counts, launches };
}

const textOf = (outcome: StopChecksOutcome): string => outcome.kind === "block" || outcome.kind === "note" ? outcome.message : "";

describe("the Task mutation check at a stop", () => {
  it("holds a stop whose check never ran, naming the one command, and runs no runner for it", async () => {
    const { stop, counts, launches } = stopper(workspace());
    const outcome = await stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(MUTATION_BLOCK_HEADING);
    expect(textOf(outcome)).toContain("The check has not run for this Task.");
    expect(textOf(outcome)).toContain(`  ${COMMAND}`);
    expect(textOf(outcome)).toContain("blocks at most 1 more time(s)");
    expect(counts.mutation.get(AGENT)).toBe(1);
    expect(launches).toEqual([]);
  });

  it("blocks at most twice, then lets the stop proceed with a note and clears its counter", async () => {
    const { stop, counts } = stopper(workspace());
    const outcomes = [await stop(), await stop()];
    expect(outcomes.map(({ kind }) => kind)).toEqual(["block", "block"]);
    expect(textOf(outcomes[1]!)).toContain("blocks at most 0 more time(s)");
    expect(counts.mutation.get(AGENT)).toBe(TASK_MUTATION_STOP_CHECK_MAX_BLOCKS);
    const third = await stop();
    expect(third.kind).toBe("note");
    expect(textOf(third)).toContain(`stop checks for T2: the Task mutation check reached its ${TASK_MUTATION_STOP_CHECK_MAX_BLOCKS}-block cap`);
    expect(textOf(third)).not.toContain(MUTATION_BLOCK_HEADING);
    expect(counts.mutation.has(AGENT)).toBe(false);
  });

  it("passes a clean record of these bytes, and clears the counter an earlier block left", async () => {
    const space = workspace();
    const { stop, counts } = stopper(space, { changed: [IMPL] });
    expect((await stop()).kind).toBe("block");
    record(space, CLEAN);
    expect(await stop()).toEqual({ kind: "passed" });
    expect(counts.mutation.has(AGENT)).toBe(false);
  });

  it.each([
    ["an implementation file", IMPL],
    ["a test file", TEST],
  ])("reads a clean record as stale once %s changes, and holds the stop", async (_label, path) => {
    const space = workspace();
    record(space, CLEAN);
    writeFile(space.root, path, "export const changed = true;\n");
    const outcome = await stopper(space).stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain("Your files changed after the check last ran");
  });

  it("holds a stop whose record names survivors, and lists each as the helper does", async () => {
    const space = workspace();
    record(space, SURVIVORS);
    const outcome = await stopper(space).stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(`- ${IMPL}:4:3 guard-removal: \`if (amount <= 0) throw new RangeError();\` → \`;\``);
    expect(textOf(outcome)).toContain("an equivalent mutant");
  });

  it("joins the affected-test check in one block, each arm counting its own blocks", async () => {
    const { stop, counts, launches } = stopper(workspace(), { changed: [IMPL], affected: [FAILING] });
    const outcome = await stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome).indexOf(AFFECTED_BLOCK_HEADING)).toBeGreaterThan(-1);
    expect(textOf(outcome).indexOf(MUTATION_BLOCK_HEADING)).toBeGreaterThan(textOf(outcome).indexOf(AFFECTED_BLOCK_HEADING));
    expect([counts.affected.get(AGENT), counts.mutation.get(AGENT)]).toEqual([1, 1]);
    expect(launches).toHaveLength(1);
  });

  it("still blocks for a failing affected test when its own record is clean", async () => {
    const space = workspace();
    record(space, CLEAN);
    const { stop, counts } = stopper(space, { changed: [IMPL], affected: [FAILING] });
    const outcome = await stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).not.toContain(MUTATION_BLOCK_HEADING);
    expect(counts.mutation.has(AGENT)).toBe(false);
  });
});

describe("the Task mutation check fails open", () => {
  const proceeds = async (stop: () => Promise<StopChecksOutcome>, note: string | RegExp): Promise<void> => {
    const outcome = await stop();
    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toMatch(note);
    expect(textOf(outcome)).not.toContain(MUTATION_BLOCK_HEADING);
  };

  it("for a run that was unavailable, such as a red baseline", async () => {
    const space = workspace();
    record(space, taskMutationUnavailable("the unmutated tests fail: 'ledger > credits' (src/ledger.test.ts)"));
    await proceeds(stopper(space).stop, "Task mutation check for T2 did not decide (its last run was unavailable: the unmutated tests fail");
  });

  it("for a record that is not a record", async () => {
    const space = workspace();
    writeFileSync(taskMutationRecordPath(space.root, "T2", space.records), "{ not json");
    await proceeds(stopper(space).stop, /did not decide \(its record is unreadable: .*is not JSON/);
  });

  it("for a record another schema wrote", async () => {
    const space = workspace();
    writeFileSync(taskMutationRecordPath(space.root, "T2", space.records), JSON.stringify({ schemaVersion: 9 }));
    await proceeds(stopper(space).stop, /its record is unreadable: .*taskMutationRecord/);
  });

  it("for an observation that throws", async () => {
    const taskMutation = (): TaskMutationObservation => { throw new Error("EIO: record directory"); };
    await proceeds(stopper(workspace(), { taskMutation }).stop, "did not decide (EIO: record directory); the stop proceeds");
  });

  it("without a repository root, and never asks for the record", async () => {
    let asked = 0;
    const taskMutation = (): TaskMutationObservation => { asked++; throw new Error("unreachable"); };
    await proceeds(stopper(workspace(), { taskMutation, root: "unavailable" }).stop, "Task mutation check for T2 did not decide (no Git repository here)");
    expect(asked).toBe(0);
  });

  it("with an unreadable block counter", async () => {
    const { stop, counts } = stopper(workspace(), { presets: { mutation: { kind: "unreadable", reason: "EACCES" } } });
    await proceeds(stop, "the Task mutation check's block counter is unreadable: EACCES");
    expect(counts.mutation.has(AGENT)).toBe(false);
  });

  it.each<[string, MutationManifestOverrides]>([
    ["the operator switched it off", { taskMutationCheck: "off" }],
    ["no affected runner is frozen", { affectedRunner: undefined }],
  ])("is idle when %s: the record is never read", async (_label, manifest) => {
    let asked = 0;
    const taskMutation = (): TaskMutationObservation => { asked++; throw new Error("unreachable"); };
    const outcome = await stopper(workspace(), { manifest, taskMutation }).stop();
    expect(outcome.kind).not.toBe("block");
    expect(textOf(outcome)).not.toContain("Task mutation check");
    expect(asked).toBe(0);
  });
});

describe("the block cap over any run of stops", () => {
  const standingArb: fc.Arbitrary<TaskMutationStanding> = fc.constantFrom<TaskMutationStanding>(
    { kind: "not-run" },
    { kind: "stale" },
    { kind: "current", result: SURVIVORS },
    { kind: "current", result: CLEAN },
    { kind: "current", result: taskMutationUnavailable("the unmutated tests fail") },
  );
  const holds = (standing: TaskMutationStanding): boolean => standing.kind !== "current" || standing.result.kind === "survivors";

  it("property: a stop is held exactly when its record would hold it and fewer than two blocks stand; any other stop proceeds and resets the count", async () => {
    const space = workspace();
    await fc.assert(fc.asyncProperty(fc.array(standingArb, { minLength: 1, maxLength: 9 }), async (standings) => {
      const seen = { at: 0 };
      const taskMutation = (): TaskMutationObservation => ({ kind: "observed", standing: standings[seen.at]!, command: COMMAND });
      const { stop, counts } = stopper(space, { taskMutation });
      let issued = 0;
      for (const [at, standing] of standings.entries()) {
        seen.at = at;
        const blocks = holds(standing) && issued < TASK_MUTATION_STOP_CHECK_MAX_BLOCKS;
        issued = blocks ? issued + 1 : 0;
        expect((await stop()).kind === "block").toBe(blocks);
        expect(counts.mutation.get(AGENT) ?? 0).toBe(issued);
      }
    }), { numRuns: 60 });
  });
});

describe("the Task mutation check on Pi", () => {
  /** The Pi parent's report-only stop for T2 over `space`, its child's epoch holding no write. */
  const report = (space: ReturnType<typeof workspace>, notifyOperator: (line: string) => void = () => undefined) =>
    reportImplementationStopChecks(
      { load: () => graph(), getPath: () => join(space.root, ".pi", "state", "active_task_graph.json") },
      "T2",
      { kind: "read", events: [] },
      { ...REPORT_ONLY_STOP_CHECK_PORTS, repositoryRoot: () => ({ ok: true as const, root: space.root }) },
      notifyOperator,
      observeTaskMutation(PACKAGE_ROOT, () => space.records),
    );

  it("is one report-only operator line for a missing check, every time, and never a block", async () => {
    const space = workspace();
    const lines: string[] = [];
    for (let stop = 0; stop < TASK_MUTATION_STOP_CHECK_MAX_BLOCKS + 2; stop++) {
      const note = await report(space, (line) => lines.push(line));
      expect(note?.message).toMatch(/^stop checks \(report-only on Pi; the agent has already ended\): T2\n/);
      expect(note?.message).toContain(MUTATION_BLOCK_HEADING);
      expect(note?.message).toContain(COMMAND);
    }
    expect(lines).toHaveLength(TASK_MUTATION_STOP_CHECK_MAX_BLOCKS + 2);
  });

  it("says nothing of the arm once the record is clean", async () => {
    const space = workspace();
    record(space, CLEAN);
    const note = await report(space);
    expect(note?.message ?? "").not.toContain(MUTATION_BLOCK_HEADING);
  });
});
