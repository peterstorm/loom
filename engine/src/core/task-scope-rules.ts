/**
 * Whether a roster's scope can ever produce the evidence it owes, under a
 * TaskGraph's frozen Verification Manifest (loom#198, Cause 3).
 *
 * - A Task that owes red-then-green (I6) and whose `file_list` holds no test
 *   file can never pass: settlement judges it `no-test-files` on every
 *   attempt.
 * - Tasks that owe I6 under a manifest that declares no `affectedRunner`
 *   have no engine run to prove I6 with (the engine-run evidence of Cause 1).
 * - A completable Requirement no Task completes is a critical at every Wave
 *   Gate's spec-check.
 *
 * All used to surface only at settlement or at a Wave Gate, after attempts
 * were spent. Population refuses them; the rules are exported so an
 * operation that edits a Task's scope applies the same ones.
 *
 * Pure.
 */

import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { frozenRedThenGreenEra, redThenGreenOwing, redThenGreenScope } from "./proof-obligations";
import { isTestFileBySuffixes } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
import type { VerificationPolicy } from "./verification-policy";

/** The parts of a Task its evidence scope is judged from. */
export type ScopedTask = Readonly<{ id: string; fileList: readonly string[]; policy: VerificationPolicy }>;

/** What a scope is judged under: the frozen manifest and the contracts whose writers owe no I6. */
export type ScopeAuthority = Readonly<{
  manifest: FrozenVerificationManifest | undefined;
  contracts: readonly Readonly<{ id: string; contractTask: string }>[];
}>;

/** Why a roster's scope cannot produce the evidence it owes. */
export type TaskScopeProblem =
  | Readonly<{ kind: "no-test-file"; taskId: string; suffixes: readonly string[] }>
  | Readonly<{ kind: "no-engine-runner"; taskIds: NonEmpty<string> }>
  | Readonly<{ kind: "unowned-requirements"; ids: NonEmpty<string> }>;

/** Whether `task` owes I6 under `authority`: the one duty rule, `redThenGreenOwing`. */
const owesRedThenGreen = (task: ScopedTask, { manifest, contracts }: ScopeAuthority): boolean =>
  redThenGreenOwing(redThenGreenScope(manifest, contracts), task.id, task.policy).kind === "owed";

/**
 * The files of `files` the frozen Test-File Classification does not call a
 * test file; none on a graph frozen without one, which has no rule to apply.
 */
export function frozenNonTestFiles(manifest: FrozenVerificationManifest | undefined, files: readonly string[]): readonly string[] {
  const era = frozenRedThenGreenEra(manifest);
  return era.kind === "owed-if-new-tests" ? files.filter((file) => !isTestFileBySuffixes(file, era.testFiles.suffixes)) : [];
}

/** The refusal of a Task that owes I6 but declares no file the frozen classification calls a test, or null. */
export function taskTestFileProblem(task: ScopedTask, authority: ScopeAuthority): TaskScopeProblem | null {
  const era = frozenRedThenGreenEra(authority.manifest);
  if (era.kind !== "owed-if-new-tests" || !owesRedThenGreen(task, authority)) return null;
  return frozenNonTestFiles(authority.manifest, task.fileList).length < task.fileList.length
    ? null
    : Object.freeze({ kind: "no-test-file", taskId: task.id, suffixes: era.testFiles.suffixes });
}

/**
 * The evidence-scope problems of a roster: each I6-owing Task without a test
 * file, then, once, the I6-owing Tasks a manifest without an `affectedRunner`
 * leaves without an engine run.
 */
export function rosterScopeProblems(tasks: readonly ScopedTask[], authority: ScopeAuthority): readonly TaskScopeProblem[] {
  const owing = tasks.filter((task) => owesRedThenGreen(task, authority));
  const withoutTestFile = owing
    .map((task) => taskTestFileProblem(task, authority))
    .filter((problem): problem is TaskScopeProblem => problem !== null);
  const owingIds = nonEmpty(owing.map(({ id }) => id));
  const runnerless = owingIds !== null && authority.manifest?.affectedRunner === undefined
    ? [Object.freeze({ kind: "no-engine-runner" as const, taskIds: owingIds })]
    : [];
  return Object.freeze([...withoutTestFile, ...runnerless]);
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
    case "unowned-requirements":
      return `${problem.ids.join(", ")} ${problem.ids.length === 1 ? "has" : "have"} no completion owner: no Task names ` +
        `${problem.ids.length === 1 ? "it" : "them"} in spec_anchors. Give each to the Task that completes it (a contribution does not), ` +
        "or move it out of scope in the specification";
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
}
