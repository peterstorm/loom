/**
 * Regression attribution (loom#199, Cause 1): which failures of a trusted
 * failing test run count against the Task being settled.
 *
 * A Task's regression verdict used to be the whole run's: any failing test
 * failed the Task. In a Wave whose Tasks change coupled code, another
 * in-flight Task's own test file is legitimately red while its owner is mid
 * change, and that failure escalated the Task that merely ran it. A failure
 * now counts against the settling Task unless its test file belongs to
 * ANOTHER in-flight Task of the same Wave, which owns that file's outcome.
 * Everything else still counts, including a test this Task's change broke in
 * a settled Task's or a sealed Wave's file. The Wave Gate's completion suite
 * judges the whole suite.
 *
 * Fail closed: without recorded per-file results, with a failure no declared
 * file explains, or with no passing test outside the foreign files, the
 * whole-run verdict stands.
 *
 * Pure.
 */

import type { Evidence } from "../machine/types";
import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { attributeReportedFile } from "./report-file-attribution";

type TestRunFact = Extract<Evidence, { kind: "TestRun" }>;

/** Every file of another in-flight Task of the settling Task's Wave, mapped to that Task. */
export type ForeignTestOwners = ReadonlyMap<string, string>;

export const NO_FOREIGN_OWNERS: ForeignTestOwners = Object.freeze(new Map<string, string>());

/** One failing test file another in-flight Task owns. */
export type ForeignFailure = Readonly<{ file: string; owner: string }>;

export type RegressionAttribution =
  /** The failing run's verdict stands as a failure of the settling Task. */
  | Readonly<{ kind: "stands"; reason: string }>
  /** Every failure is in a file another in-flight Task owns, and this Task's tests passed. */
  | Readonly<{ kind: "foreign-only"; foreign: NonEmpty<ForeignFailure> }>;

const stands = (reason: string): RegressionAttribution => Object.freeze({ kind: "stands", reason });

/**
 * Attribute a trusted failing run's per-file failures. Only `foreign-only`
 * changes a verdict: every failing file is owned by another in-flight Task,
 * and at least one test outside those files executed with no failure.
 */
export function attributeRegressionFailures(
  run: TestRunFact,
  owners: ForeignTestOwners,
  repositoryRoot: string,
): RegressionAttribution {
  const files = run.report?.files;
  if (files?.kind !== "recorded") return stands("the report recorded no per-file results");
  if (owners.size === 0) return stands("no other in-flight Task of the Wave owns a file");
  const declared = [...owners.keys()];
  const foreign: ForeignFailure[] = [];
  let ownExecuted = 0;
  for (const result of files.results) {
    const ownerFile = attributeReportedFile(declared, result.file, repositoryRoot);
    const failing = result.failed > 0 || result.collectionError;
    if (ownerFile === null) {
      if (failing) return stands(`${result.file} failed and no other in-flight Task owns it`);
      ownExecuted += result.executed - result.skipped;
      continue;
    }
    const owner = owners.get(ownerFile);
    if (failing && owner !== undefined) foreign.push(Object.freeze({ file: ownerFile, owner }));
  }
  const attributed = nonEmpty(foreign);
  if (attributed === null) return stands("no failing file is owned by another in-flight Task");
  if (ownExecuted < 1) return stands("no test outside other in-flight Tasks' files ran");
  return Object.freeze({ kind: "foreign-only", foreign: attributed });
}

/** The evidence-label clause naming each failure attributed to its owner. */
export const describeForeignFailures = (foreign: NonEmpty<ForeignFailure>): string =>
  `failures attributed to in-flight Tasks: ${foreign.map(({ file, owner }) => `${file} (${owner})`).join(", ")}`;

/**
 * The files of every OTHER Task of `wave` that has not settled its
 * implementation, each mapped to its Task. Distill Tasks own implementation
 * files only, so they never match a reported test file.
 */
export function foreignTestOwners(
  tasks: readonly Readonly<{ id: string; wave: number; status: string; file_list?: readonly string[] }>[],
  settlingTaskId: string,
  wave: number,
): ForeignTestOwners {
  const owners = new Map<string, string>();
  for (const task of tasks) {
    if (task.id === settlingTaskId || task.wave !== wave) continue;
    if (task.status === "implemented" || task.status === "completed") continue;
    for (const file of task.file_list ?? []) owners.set(file, task.id);
  }
  return Object.freeze(owners);
}
