/**
 * The Task owner check as the fourth arm of `runStopChecks` (ADR-0092), over a
 * real record file and real family files, with in-memory runner ports:
 * - a stop is held while the Task's record is missing, stale or names a
 *   finding the Task answers, at most `TASK_OWNER_STOP_CHECK_MAX_BLOCKS`
 *   times, and then proceeds with a note;
 * - a clean record of these very bytes passes;
 * - a red baseline, an unavailable run, a finding the Task does not answer
 *   and every fault are notes, and the stop proceeds;
 * - the arm runs no runner and joins the mutation arm in one block, each
 *   counting its own blocks;
 * - on Pi the same finding is one report-only operator line.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { reportImplementationStopChecks } from "../../../pi/subagent-stop";
import {
  MUTATION_BLOCK_HEADING,
  OWNER_BLOCK_HEADING,
  TASK_OWNER_STOP_CHECK_MAX_BLOCKS,
  type StopChecksOutcome,
} from "../../src/core/affected-stop-check-types";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type { CoverageVerdict, MutationVerdict, OwnerObligation } from "../../src/core/owner-verification/types";
import { NO_TASK_MUTATION_CHECK } from "../../src/core/task-mutation-check";
import {
  recordedTaskOwnerCheck,
  taskOwnerCheckDuty,
  taskOwnerCheckResult,
  taskOwnerCheckUnavailable,
  type TaskOwnerCheckObservation,
  type TaskOwnerCheckResult,
} from "../../src/core/task-owner-check";
import { REPORT_ONLY_STOP_CHECK_PORTS } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import type { StopChecksInput } from "../../src/handlers/subagent-stop/stop-checks";
import { observeTaskMutation } from "../../src/orchestration/task-mutation-record";
import {
  observeTaskOwnerCheck,
  observeTaskOwnerCheckDigest,
  taskOwnerCheckRecordPath,
  writeTaskOwnerCheckRecord,
} from "../../src/orchestration/task-owner-check-record";
import type { Task, TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { task } from "../fixtures/contract-status-fixtures";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import { ownerObligation } from "../fixtures/owner-obligation";
import { inMemoryBlockCounters } from "../fixtures/stop-check-block-counters";
import { outcomeText, recordingStopCheckPorts, stopsOf } from "../fixtures/stop-check-runners";
import { graphFixture } from "../fixtures/task-lifecycle";
import { junitReport, mutationManifest, START_SHA } from "../fixtures/task-mutation";

const OWNER = "src/rules/owner.ts";
const SIBLING = "src/rules/sibling.ts";
const MATRIX = "src/rules.matrix.test.ts";
const COMMANDS = loomCommandsAt("/opt/loom");
const COMMAND = COMMANDS.ownerCheck("T2");
const AGENT = "session.agent";

const ADMISSION: OwnerObligation = ownerObligation({
  invariant: "INV-1", title: "Admission is decided only by the owner", statement: null,
  owner: OWNER, siblings: [{ path: SIBLING, note: null }], matrixTest: MATRIX, mutation: { kind: "verify" },
});

const withStart = (built: Task): Task => ({ ...built, start_sha: START_SHA });

/** T2 writes the owner and the matrix test (it answers), or only the sibling, with the owner and matrix test from Wave 1. */
const graph = (role: "answers" | "sibling-only" = "answers", mutationCheck: "on" | "off" = "off"): TaskGraph => ({
  ...graphFixture(role === "answers"
    ? [withStart(task("T2", 2, [OWNER, MATRIX]))]
    : [withStart(task("T1", 1, [OWNER, MATRIX])), withStart(task("T2", 2, [SIBLING]))]),
  verification_manifest: mutationManifest({ taskMutationCheck: mutationCheck }),
  owner_obligations: [ADMISSION],
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

type Space = Readonly<{ root: CanonicalRepositoryRoot; records: string }>;

function writeFile(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function workspace(): Space {
  const parsed = parseCanonicalRepositoryRoot(tempDir("loom-stop-owner-"));
  if (!parsed.ok) throw new Error("root fixture");
  writeFile(parsed.value, OWNER, "export const decide = (age: number): boolean => age >= 18;\n");
  writeFile(parsed.value, SIBLING, "import { decide } from './owner';\nexport const admit = decide;\n");
  writeFile(parsed.value, MATRIX, "import './rules/owner';\n");
  return { root: parsed.value, records: tempDir("loom-stop-owner-records-") };
}

function record({ root, records }: Space, result: TaskOwnerCheckResult, role: "answers" | "sibling-only" = "answers"): void {
  const duty = taskOwnerCheckDuty(graph(role), "T2");
  if (duty.kind !== "owed") throw new Error(`the fixture Task owes the check (${duty.reason})`);
  const digest = observeTaskOwnerCheckDigest(root, duty);
  if (!digest.ok) throw new Error(digest.error);
  const written = writeTaskOwnerCheckRecord(root, recordedTaskOwnerCheck("T2", digest.value, result), records);
  if (!written.ok) throw new Error(written.error);
}

function verified(survived: boolean): MutationVerdict {
  const built = verifiedMutationOf({
    killed: 2, timedOut: 0, invalid: 0, unmutated: 0, ownerChangedInWave: true,
    survivors: survived ? [{ mutantId: "m", operator: "comparison-flip", line: 1, column: 50, original: "age >= 18", replacement: "age < 18" }] : [],
  });
  if (!built.ok) throw new Error(built.error.kind);
  return built.value;
}

const resultOf = (coverage: CoverageVerdict, mutation: MutationVerdict): TaskOwnerCheckResult => taskOwnerCheckResult([{
  invariant: ADMISSION.invariant, title: ADMISSION.title, owner: OWNER, matrixTest: MATRIX, coverage, mutation,
}]);
const CLEAN = resultOf({ kind: "covered" }, verified(false));
const SURVIVORS = resultOf({ kind: "covered" }, verified(true));
const MISSING = resultOf({ kind: "missing", paths: [SIBLING] }, verified(false));
const RED = resultOf({ kind: "covered" }, { kind: "red-baseline", failures: ["matrix > admits"] });

type StopOptions = Readonly<{
  role?: "answers" | "sibling-only";
  mutationCheck?: "on" | "off";
  taskOwnerCheck?: StopChecksInput["taskOwnerCheck"];
  root?: "unavailable";
}>;

function stopper(space: Space, options: StopOptions = {}) {
  const { counters, counts } = inMemoryBlockCounters();
  const { ports, launches } = recordingStopCheckPorts({ root: space.root, report: () => junitReport([]), blocks: counters });
  const input: StopChecksInput = {
    loadGraph: () => graph(options.role, options.mutationCheck),
    stateFilePath: join(space.root, ".loom", "active_task_graph.json"),
    taskId: "T2",
    agentKey: AGENT,
    changedFiles: () => ({ kind: "observed", changed: { kind: "none" } }),
    taskMutation: options.mutationCheck === "on" ? observeTaskMutation(COMMANDS, () => space.records) : () => NO_TASK_MUTATION_CHECK,
    taskOwnerCheck: options.taskOwnerCheck ?? observeTaskOwnerCheck(COMMANDS, () => space.records),
    hookStartedAtMs: 0,
  };
  return { stop: stopsOf(input, ports, options.root), counts, launches };
}

const textOf = outcomeText;

describe("the Task owner check at a stop", () => {
  it("holds a stop whose check never ran, naming the one command, and runs no runner for it", async () => {
    const { stop, counts, launches } = stopper(workspace());
    const outcome = await stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(OWNER_BLOCK_HEADING);
    expect(textOf(outcome)).toContain("The check has not run for this Task.");
    expect(textOf(outcome)).toContain(`  ${COMMAND}`);
    expect(counts.owner.get(AGENT)).toBe(1);
    expect(launches).toEqual([]);
  });

  it("blocks at most twice, then lets the stop proceed with a note and clears its counter", async () => {
    const { stop, counts } = stopper(workspace());
    expect([(await stop()).kind, (await stop()).kind]).toEqual(["block", "block"]);
    expect(counts.owner.get(AGENT)).toBe(TASK_OWNER_STOP_CHECK_MAX_BLOCKS);
    const third = await stop();
    expect(third.kind).toBe("note");
    expect(textOf(third)).toContain(`the Task owner check reached its ${TASK_OWNER_STOP_CHECK_MAX_BLOCKS}-block cap`);
    expect(counts.owner.has(AGENT)).toBe(false);
  });

  it("passes a clean record of these bytes: the stop proceeds and the arm says nothing", async () => {
    const space = workspace();
    record(space, CLEAN);
    const outcome = await stopper(space).stop();
    expect(outcome.kind).not.toBe("block");
    expect(textOf(outcome)).not.toMatch(/owner check/i);
  });

  it.each([OWNER, SIBLING, MATRIX])("reads a clean record as stale once %s changes, and holds the stop", async (path) => {
    const space = workspace();
    record(space, CLEAN);
    writeFile(space.root, path, "export const changed = true;\n");
    const outcome = await stopper(space).stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain("changed after the check last ran");
  });

  it.each([
    ["a survivor", SURVIVORS, `INV-1: mutant survived at ${OWNER}:1:50 (comparison-flip)`],
    ["a missing sibling", MISSING, `INV-1: matrix test ${MATRIX} does not import ${SIBLING}`],
  ] as const)("holds a stop for %s the Task answers, in the gate's words", async (_name, result, line) => {
    const space = workspace();
    record(space, result);
    const outcome = await stopper(space).stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome)).toContain(line);
    expect(textOf(outcome)).toContain("an equivalent mutant");
  });

  it("joins the mutation arm in one block, each counting its own blocks", async () => {
    const { stop, counts } = stopper(workspace(), { mutationCheck: "on" });
    const outcome = await stop();
    expect(outcome.kind).toBe("block");
    expect(textOf(outcome).indexOf(OWNER_BLOCK_HEADING)).toBeGreaterThan(textOf(outcome).indexOf(MUTATION_BLOCK_HEADING));
    expect(textOf(outcome).indexOf(MUTATION_BLOCK_HEADING)).toBeGreaterThan(-1);
    expect([counts.mutation.get(AGENT), counts.owner.get(AGENT)]).toEqual([1, 1]);
  });
});

describe("the Task owner check proceeds", () => {
  const proceeds = async (stop: () => Promise<StopChecksOutcome>, note: string): Promise<void> => {
    const outcome = await stop();
    expect(outcome.kind).toBe("note");
    expect(textOf(outcome)).toContain(note);
    expect(textOf(outcome)).not.toContain(OWNER_BLOCK_HEADING);
  };

  it("on a red baseline, usually another Task's unfinished work", async () => {
    const space = workspace();
    record(space, RED);
    await proceeds(stopperOf(space), `matrix test ${MATRIX} is red against the unmutated workspace`);
  });

  it("on an unavailable run", async () => {
    const space = workspace();
    record(space, taskOwnerCheckUnavailable("the family's files changed while the check ran"));
    await proceeds(stopperOf(space), "its last run was unavailable: the family's files changed while the check ran");
  });

  it("on a survivor the Task does not answer: only the matrix test does, and it is another Task's", async () => {
    const space = workspace();
    record(space, SURVIVORS, "sibling-only");
    await proceeds(stopper(space, { role: "sibling-only" }).stop, `only ${MATRIX} answers this, and this Task does not list it`);
  });

  it("on an unreadable record, a throwing observation and no repository root", async () => {
    const space = workspace();
    writeFileSync(taskOwnerCheckRecordPath(space.root, "T2", space.records), "{ not json");
    await proceeds(stopperOf(space), "its record is unreadable");
    const throwing = (): TaskOwnerCheckObservation => { throw new Error("EIO: record directory"); };
    await proceeds(stopper(workspace(), { taskOwnerCheck: throwing }).stop, "did not hold the stop (EIO: record directory)");
    await proceeds(stopper(workspace(), { root: "unavailable" }).stop, "did not hold the stop (no Git repository here)");
  });

  const stopperOf = (space: Space) => stopper(space).stop;

  const standingArb = fc.constantFrom<TaskOwnerCheckObservation["kind"] | "current-clean" | "current-survivors" | "stale">(
    "current-clean", "current-survivors", "stale", "unavailable",
  );

  it("property: a stop is held exactly when the arm fails and fewer than two blocks stand; any other stop resets the count", async () => {
    const space = workspace();
    const duty = taskOwnerCheckDuty(graph(), "T2");
    if (duty.kind !== "owed") throw new Error("fixture");
    await fc.assert(fc.asyncProperty(fc.array(standingArb, { minLength: 1, maxLength: 8 }), async (standings) => {
      const seen = { at: 0 };
      const taskOwnerCheck = (): TaskOwnerCheckObservation => {
        const kind = standings[seen.at]!;
        if (kind === "unavailable") return { kind: "unavailable", reason: "EIO" };
        if (kind === "stale") return { kind: "observed", duty, standing: { kind: "stale" }, command: COMMAND };
        return { kind: "observed", duty, standing: { kind: "current", result: kind === "current-clean" ? CLEAN : SURVIVORS }, command: COMMAND };
      };
      const { stop, counts } = stopper(space, { taskOwnerCheck });
      let issued = 0;
      for (const [at, kind] of standings.entries()) {
        seen.at = at;
        const blocks = (kind === "stale" || kind === "current-survivors") && issued < TASK_OWNER_STOP_CHECK_MAX_BLOCKS;
        issued = blocks ? issued + 1 : 0;
        expect((await stop()).kind === "block").toBe(blocks);
        expect(counts.owner.get(AGENT) ?? 0).toBe(issued);
      }
    }), { numRuns: 50 });
  });
});

describe("the Task owner check on Pi", () => {
  it("is one report-only operator line for a missing check, every time, and never a block", async () => {
    const space = workspace();
    const lines: string[] = [];
    for (let stop = 0; stop < TASK_OWNER_STOP_CHECK_MAX_BLOCKS + 2; stop++) {
      const note = await reportImplementationStopChecks(
        { load: () => graph(), getPath: () => join(space.root, ".pi", "state", "active_task_graph.json") },
        "T2",
        { kind: "read", events: [] },
        { ...REPORT_ONLY_STOP_CHECK_PORTS, repositoryRoot: () => ({ ok: true as const, root: space.root }) },
        (line) => lines.push(line),
        () => NO_TASK_MUTATION_CHECK,
        observeTaskOwnerCheck(COMMANDS, () => space.records),
      );
      expect(note?.message).toMatch(/^stop checks \(report-only on Pi; the agent has already ended\): T2\n/);
      expect(note?.message).toContain(OWNER_BLOCK_HEADING);
      expect(note?.message).toContain(COMMAND);
    }
    expect(lines).toHaveLength(TASK_OWNER_STOP_CHECK_MAX_BLOCKS + 2);
  });
});
