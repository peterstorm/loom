/**
 * Regression attribution (ADR-0080): which failures of a trusted failing test
 * run count against the Task being settled.
 *
 * A failure counts against the settling Task unless its test file is declared
 * only by OTHER Tasks of the same Wave that have not settled their
 * implementation: those owners judge that file's outcome, since it is
 * legitimately red while they are mid change. A file the settling Task
 * declares itself always counts, and so does a test this Task broke in a
 * settled Task's or a sealed Wave's file. The Wave Gate's completion suite
 * judges the whole suite.
 *
 * Fail closed: without recorded per-file results, with a failure no foreign
 * file explains, or with no passing test outside the foreign files, the
 * whole-run verdict stands.
 *
 * Pure.
 */

import type { TaskStatus } from "../types";
import type { Evidence } from "../machine/types";
import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { attributeReportedFile } from "./report-file-attribution";

type TestRunFact = Extract<Evidence, { kind: "TestRun" }>;

/**
 * Which failures a settlement may attribute elsewhere. `whole-run`: none, so
 * every failure counts against the settling Task. `attributed`: each file
 * that only unsettled sibling Tasks of the Wave declare, mapped to those Tasks.
 */
export type RegressionScope =
  | Readonly<{ kind: "whole-run" }>
  | Readonly<{ kind: "attributed"; owners: ReadonlyMap<string, NonEmpty<string>>; repositoryRoot: string }>;

export const WHOLE_RUN_SCOPE: RegressionScope = Object.freeze({ kind: "whole-run" });

/** One failing test file and the unsettled sibling Tasks that declare it. */
export type ForeignFailure = Readonly<{ file: string; owners: NonEmpty<string> }>;

export type RegressionAttribution =
  /** The failing run's verdict stands as a failure of the settling Task. */
  | Readonly<{ kind: "stands" }>
  /** Every failure is in a file only unsettled siblings declare, and this Task's tests passed. */
  | Readonly<{ kind: "foreign-only"; foreign: NonEmpty<ForeignFailure> }>;

const STANDS: RegressionAttribution = Object.freeze({ kind: "stands" });

/**
 * Attribute a trusted failing run's per-file failures. Only `foreign-only`
 * changes a verdict: every failing file is declared only by unsettled
 * siblings, and at least one test outside those files executed with no failure.
 */
export function attributeRegressionFailures(run: TestRunFact, scope: RegressionScope): RegressionAttribution {
  const files = run.report?.files;
  if (scope.kind === "whole-run" || files?.kind !== "recorded") return STANDS;
  const declared = [...scope.owners.keys()];
  const foreign: ForeignFailure[] = [];
  let ownExecuted = 0;
  for (const result of files.results) {
    const file = attributeReportedFile(declared, result.file, scope.repositoryRoot);
    const owners = file === null ? undefined : scope.owners.get(file);
    const failing = result.failed > 0 || result.collectionError;
    if (file !== null && owners !== undefined) {
      if (failing) foreign.push(Object.freeze({ file, owners }));
    } else if (failing) {
      return STANDS;
    } else {
      ownExecuted += result.executed - result.skipped;
    }
  }
  const attributed = nonEmpty(foreign);
  return attributed === null || ownExecuted < 1 ? STANDS : Object.freeze({ kind: "foreign-only", foreign: attributed });
}

/** The evidence-label clause naming each failure attributed to its owners. */
export const describeForeignFailures = (foreign: NonEmpty<ForeignFailure>): string =>
  `failures attributed to unsettled Tasks: ${foreign.map(({ file, owners }) => `${file} (${owners.join(", ")})`).join(", ")}`;

/**
 * Whether a status has settled its implementation. Keyed by every status, so a
 * new status does not compile until it is classified here.
 */
const IMPLEMENTATION_SETTLED: Readonly<Record<TaskStatus, boolean>> = Object.freeze({
  pending: false,
  failed: false,
  implemented: true,
  completed: true,
});

type RosterTask = Readonly<{ id: string; wave: number; status: TaskStatus; file_list?: readonly string[] }>;

/**
 * The settling Task's regression scope: every file declared by another Task
 * of its Wave that has not settled its implementation, mapped to all such
 * Tasks, minus every file the settling Task declares itself. Distill Tasks
 * declare implementation files only, so they never match a reported test file.
 */
export function regressionScope(
  tasks: readonly RosterTask[],
  settling: Readonly<{ id: string; wave: number; file_list?: readonly string[] }>,
  repositoryRoot: string,
): RegressionScope {
  const own = new Set(settling.file_list ?? []);
  const owners = new Map<string, NonEmpty<string>>();
  for (const task of tasks) {
    if (task.id === settling.id || task.wave !== settling.wave || IMPLEMENTATION_SETTLED[task.status]) continue;
    for (const file of task.file_list ?? []) {
      if (own.has(file)) continue;
      const prior = owners.get(file);
      owners.set(file, prior === undefined ? [task.id] : [...prior, task.id]);
    }
  }
  return owners.size === 0
    ? WHOLE_RUN_SCOPE
    : Object.freeze({ kind: "attributed", owners: Object.freeze(owners), repositoryRoot });
}
