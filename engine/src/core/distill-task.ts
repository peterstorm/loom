/**
 * The Distill Task (ADR-0068): the one engine-added Task a Wave carries so a
 * fresh agent runs the `distill` skill in apply mode over the Wave's freshly
 * implemented code before the Wave Gate reviews it.
 *
 * This module owns every Distill Task rule that is not proof evaluation:
 * which Task is one, which Waves get one and over which files, when it may be
 * dispatched, what its dispatch tells the agent, when a failed pass is
 * restored, and which Distill Tasks a reopening sweeps back. Population,
 * status, registration, settlement and reopening each call here, so none of
 * them can disagree. Pure: every observation arrives as a parameter.
 */
import type { DistillPassSetting } from "./distill-pass-setting";
import { DECISION_RECORD_AGENT, DISTILL_AGENT } from "./model-profiles";
import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { compareStrings } from "./ordering";
import { samePlanPath } from "./plan-path-match";
import { TASK_ID_PATTERN } from "./task-id";
import type { FrozenRedThenGreenEra } from "./proof-obligations";
import { isTestFileBySuffixes } from "./test-file-classification";

/**
 * What this module reads of a Task. It is declared here, not imported: the
 * State File root (`types`) reaches this module through
 * `core/implementation-retry`, so importing `Task` back would close an import
 * cycle. Every `Task` has this shape, so callers pass their Tasks as they are.
 * `status` repeats the closed Task status union on purpose: a new status makes
 * `Task` unassignable here until the rules below say what it means for them.
 */
export type DistillTaskView = Readonly<{
  id: string;
  agent: string;
  wave: number;
  status: "pending" | "implemented" | "completed" | "failed";
  file_list?: readonly string[];
  /** The Task's live attempt authority: a Task carrying one still holds a reservation. Only its presence is read. */
  active_implementation_attempt?: unknown;
}>;

/**
 * Whether a Task is a Distill Task. Its agent is its whole identity. The
 * State File load boundary asks this of a raw record, so `agent` is read as
 * unknown: anything but the exact agent name is not a Distill Task.
 */
export const isDistillTask = (task: Readonly<{ agent?: unknown }>): boolean => task.agent === DISTILL_AGENT;

/** Why an authored Task naming the distill agent is refused: population adds the pass itself. */
export const authoredDistillTaskRefusal = (taskId: string): string =>
  `Task ${taskId}: agent '${DISTILL_AGENT}' is engine-only; the distill pass is engine-added, one per Wave, ` +
  "at TaskGraph population. Remove the Task";

/** What population needs to know of an authored Task to plan the distill pass. */
export type DistillSourceTask = Readonly<Pick<DistillTaskView, "id" | "agent" | "wave"> & { file_list: readonly string[] }>;

/** One Wave's Distill Task as population will write it. */
export type DistillTaskPlan = Readonly<{
  id: string;
  wave: number;
  /** The Distill Scope, in the order the sources first list each path. */
  scope: NonEmpty<string>;
  /** The Tasks whose files the scope holds, in roster order. */
  sourceTaskIds: NonEmpty<string>;
  description: string;
}>;

export type DistillPlanInput = Readonly<{
  tasks: readonly DistillSourceTask[];
  /** The Tasks that write an Acceptance Contract. */
  contractTaskIds: ReadonlySet<string>;
  /** Every Acceptance Contract's frozen paths. */
  frozenPaths: readonly string[];
  /** The graph's I6 era, from `frozenRedThenGreenEra`: the one carrier of the frozen Test-File Classification. */
  era: FrozenRedThenGreenEra;
  setting: DistillPassSetting;
}>;

const taskNumber = (id: string): number => (TASK_ID_PATTERN.test(id) ? Number(id.slice(1)) : 0);

const describeDistillTask = (wave: number, sources: NonEmpty<string>): string =>
  `Distill pass for Wave ${wave}: behaviour-preserving simplification of the code ${sources.join(", ")} ` +
  "implemented, with the distill skill in apply mode. Changing nothing is an acceptable result.";

/**
 * The Distill Tasks a roster gets: at most one per Wave, in Wave order,
 * numbered after the highest authored Task id.
 *
 * A Wave's sources are its Tasks other than Contract Tasks and ADR Tasks. Its
 * scope is their implementation files (the frozen classification decides),
 * minus every frozen contract path: a test file in scope would let the
 * distiller weaken its own oracle, and a frozen path listed by a second Task
 * makes the State File refuse to load. A Wave with an empty scope gets no
 * Task; neither does any Wave when the manifest froze no classification or
 * the operator turned the pass off.
 */
export function planDistillTasks(input: DistillPlanInput): readonly DistillTaskPlan[] {
  const { era } = input;
  if (input.setting === "off" || era.kind === "not-owed") return Object.freeze([]);
  const { suffixes } = era.testFiles;
  const inScope = (path: string): boolean =>
    !isTestFileBySuffixes(path, suffixes) && !input.frozenPaths.some((frozen) => samePlanPath(frozen, path));
  const firstId = Math.max(0, ...input.tasks.map(({ id }) => taskNumber(id))) + 1;
  const waves = [...new Set(input.tasks.map(({ wave }) => wave))].sort((left, right) => left - right);
  const scoped = waves.flatMap((wave) => {
    const sources = input.tasks.filter((task) =>
      task.wave === wave && task.agent !== DECISION_RECORD_AGENT && task.agent !== DISTILL_AGENT &&
      !input.contractTaskIds.has(task.id));
    const scope = nonEmpty(sources
      .flatMap(({ file_list }) => file_list.filter(inScope))
      .filter((path, index, paths) => paths.findIndex((other) => samePlanPath(other, path)) === index));
    const sourceTaskIds = nonEmpty(sources.filter(({ file_list }) => file_list.some(inScope)).map(({ id }) => id));
    return scope === null || sourceTaskIds === null ? [] : [{ wave, scope, sourceTaskIds }];
  });
  return Object.freeze(scoped.map(({ wave, scope, sourceTaskIds }, index) => Object.freeze({
    id: `T${firstId + index}`,
    wave,
    scope,
    sourceTaskIds,
    description: describeDistillTask(wave, sourceTaskIds),
  })));
}

/**
 * The Tasks a Distill Task still waits for: every other Task of its Wave that
 * is not yet `implemented` or `completed`, or still holds a reservation, in
 * roster order. Empty for any other Task, and for a Distill Task that may be
 * dispatched. Status and registration both ask here, so the dispatch is never
 * offered before registration would admit it.
 */
export function distillDispatchBlockers(
  tasks: readonly DistillTaskView[],
  executing: ReadonlySet<string>,
  task: DistillTaskView,
): readonly string[] {
  if (!isDistillTask(task)) return Object.freeze([]);
  return Object.freeze(tasks
    .filter((sibling) => sibling.wave === task.wave && sibling.id !== task.id)
    .filter((sibling) =>
      (sibling.status !== "implemented" && sibling.status !== "completed") ||
      executing.has(sibling.id) || sibling.active_implementation_attempt !== undefined)
    .map(({ id }) => id));
}

/** Why registration refuses a Distill Task its Wave is not ready for. */
export const distillWithheldMessage = (taskId: string, blockers: NonEmpty<string>): string =>
  `${taskId} is its Wave's distill pass and runs after every other Task of the Wave is implemented; ` +
  `still outstanding: ${blockers.join(", ")}`;

/** The label every distill appendix opens with: a prompt line that starts with it claims to be one. */
export const DISTILL_APPENDIX_LABEL = "LOOM_DISTILL_PASS";

/** The first line of the distill appendix; the spawn gate and the brief both find the appendix by it. */
export const DISTILL_APPENDIX_HEADER = `${DISTILL_APPENDIX_LABEL}: 1`;

/**
 * The fixed appendix a Distill Task's dispatch carries, derived from its
 * protected `file_list` alone so status, the brief and the spawn gate render
 * the same bytes. It replaces the implementation workflow for this Task: the
 * agent implements nothing.
 */
export function distillPromptAppendix(task: Readonly<{ id: string; file_list?: readonly string[] }>): string {
  const scope = [...(task.file_list ?? [])].sort(compareStrings);
  return [
    DISTILL_APPENDIX_HEADER,
    `Task ${task.id} is this Wave's distill pass. You implement nothing and add no feature, test or file.`,
    "Run the distill skill in APPLY mode over exactly these files, which the Wave's other Tasks just implemented:",
    ...scope.map((path) => `- ${path}`),
    "Rules the engine checks at settlement:",
    "1. Before your first edit, run the tests that cover these files and see them pass. An edit made before a passing run is refused.",
    "2. Apply one catalog move at a time and re-run the same tests after it.",
    "3. Edit only the files listed above. Never edit a test file, and never change an exported signature: that is a deepening, so report it instead.",
    "4. Finish with one bare, report-writing test run after your last edit, as your prompt's final verification table shows.",
    "Leaving the files unchanged is an acceptable result: if nothing is worth a move, say so and stop after the passing run.",
    "If your final state cannot be proven (tests failing, or no trusted pass after your last edit), the engine restores every file to what it held when you started.",
  ].join("\n");
}

/** What settlement does with a Distill Task attempt's bytes. */
export type DistillRestoreDecision =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "restore"; after: NonEmpty<string> }>;

const KEEP: DistillRestoreDecision = Object.freeze({ kind: "keep" });

/**
 * Whether settlement writes a Distill Task's snapshot back. It restores
 * exactly when the attempt changed scope paths and the Oracle, judging those
 * bytes, would settle anything but `implemented`: the pass could not prove it
 * preserved behaviour, so its edits must not reach review. `failureKinds` are
 * that trial settlement's failure kinds and become the evidence's `after`.
 */
export function distillRestoreDecision(
  changedScopePaths: readonly string[],
  failureKinds: readonly string[],
): DistillRestoreDecision {
  const after = nonEmpty(failureKinds);
  return changedScopePaths.length === 0 || after === null ? KEEP : Object.freeze({ kind: "restore", after });
}

/** The Git ref that keeps one Distill Task attempt's snapshot tree alive until settlement. */
export const distillSnapshotRef = (authorityDigest: string): string => `refs/loom/distill/${authorityDigest}`;

/**
 * The settled Distill Tasks a reopening sweeps back with it, in TaskGraph
 * order: those of the Waves the reopened Tasks sit in. Re-implemented code is
 * distilled again. `implemented` is the active Wave's settled state (Task
 * Reopening, Contract Revision); `completed` is a reopened completed Wave's,
 * whose Distill Task stays `completed` until a sibling is returned. A pending
 * Distill Task already owes its pass, and a named one is not swept.
 */
export function distillTasksReopenedWith(
  tasks: readonly DistillTaskView[],
  reopenedTaskIds: readonly string[],
): readonly string[] {
  const reopened = new Set(reopenedTaskIds);
  const waves = new Set(tasks.filter(({ id }) => reopened.has(id)).map(({ wave }) => wave));
  return Object.freeze(tasks
    .filter((task) => isDistillTask(task) && waves.has(task.wave) && !reopened.has(task.id) &&
      (task.status === "implemented" || task.status === "completed"))
    .map(({ id }) => id));
}
