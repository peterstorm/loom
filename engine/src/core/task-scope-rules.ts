/**
 * Whether a Task's scope can ever satisfy the evidence its policy owes, under
 * a TaskGraph's frozen Verification Manifest (loom#198, Cause 3).
 *
 * A Task that owes red-then-green (I6) and whose `file_list` holds no test
 * file can never pass: settlement judges it `no-test-files` on every attempt.
 * A graph whose Tasks owe I6 and whose manifest declares no `affectedRunner`
 * has no engine run to prove I6 with (loom#198, Cause 1). Both used to surface
 * only at settlement, after attempts were spent. Population refuses them, and
 * `orchestration rescope-task` re-checks an edited Task with the same rule.
 *
 * Pure.
 */

import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { frozenRedThenGreenEra, taskRedThenGreenEra, type RedThenGreenScope } from "./proof-obligations";
import { isTestFileBySuffixes } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { requiresNewTests, type VerificationPolicy } from "./verification-policy";

/** The parts of a Task its evidence scope is judged from. */
export type ScopedTask = Readonly<{ id: string; fileList: readonly string[]; policy: VerificationPolicy }>;

/** Why a Task's scope, or a roster's, cannot produce the evidence it owes. */
export type TaskScopeProblem =
  | Readonly<{ kind: "no-test-file"; taskId: string; suffixes: readonly string[] }>
  | Readonly<{ kind: "no-engine-runner"; taskIds: NonEmpty<string> }>;

/** Whether `task` owes I6 under `scope`: new tests required, and the graph's era owes them a red-then-green. */
export const owesRedThenGreen = (task: ScopedTask, scope: RedThenGreenScope): boolean =>
  requiresNewTests(task.policy) && taskRedThenGreenEra(scope, task.id) === "owed-if-new-tests";

/** The refusal of a Task that owes I6 but declares no file the frozen classification calls a test, or null. */
export function taskTestFileProblem(
  task: ScopedTask,
  scope: RedThenGreenScope,
  manifest: FrozenVerificationManifest | undefined,
): TaskScopeProblem | null {
  const era = frozenRedThenGreenEra(manifest);
  if (era.kind !== "owed-if-new-tests" || !owesRedThenGreen(task, scope)) return null;
  const { suffixes } = era.testFiles;
  return task.fileList.some((file) => isTestFileBySuffixes(file, suffixes))
    ? null
    : Object.freeze({ kind: "no-test-file", taskId: task.id, suffixes });
}

/**
 * Every scope problem of a roster: each I6-owing Task without a test file,
 * then, once, the I6-owing Tasks a manifest without an `affectedRunner`
 * leaves without an engine run.
 */
export function rosterScopeProblems(
  tasks: readonly ScopedTask[],
  scope: RedThenGreenScope,
  manifest: FrozenVerificationManifest | undefined,
): readonly TaskScopeProblem[] {
  const perTask = tasks.flatMap((task) => {
    const problem = taskTestFileProblem(task, scope, manifest);
    return problem === null ? [] : [problem];
  });
  const owing = nonEmpty(tasks.filter((task) => owesRedThenGreen(task, scope)).map(({ id }) => id));
  const runnerless = owing !== null && manifest?.affectedRunner === undefined
    ? [Object.freeze({ kind: "no-engine-runner" as const, taskIds: owing })]
    : [];
  return Object.freeze([...perTask, ...runnerless]);
}

/** One problem as an operator reads it, with the fix. */
export function renderTaskScopeProblem(problem: TaskScopeProblem): string {
  switch (problem.kind) {
    case "no-test-file":
      return `Task ${problem.taskId} requires new tests but its file_list holds no test file (frozen suffixes: ` +
        `${problem.suffixes.join(", ")}), so I6 could only fail with no-test-files; add its test file, or waive new tests`;
    case "no-engine-runner":
      return `Tasks ${problem.taskIds.join(", ")} owe red-then-green, but the verification manifest declares no affectedRunner, ` +
        "so no engine run (`helper run-tests`) can prove it; declare an affectedRunner that writes a JUnit or Vitest JSON report";
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
}
