/**
 * The Reopen Scope (ADR-0093): what a Task Reopening says the Finding needs.
 *
 * A full re-implementation (the default) keeps the Task's Proof as its policy
 * derives it, I6 included. A tests-only reopening is for a Finding that new
 * test rows close (a surviving mutant, an uncovered case): the reopened
 * attempt adds or strengthens tests in the Task's declared test files and
 * leaves every declared implementation file alone. Its Proof owes no I6
 * order, so no cosmetic production edit is needed, and any production write
 * fails it by name (`deriveProofObligations` is the one place that decides).
 *
 * The scope is protected Task state, `reopen_scope` (one `TestsOnlyScope`),
 * present only while a tests-only reopening is in force; absent reads as a
 * full re-implementation, so a graph that never asks for one is
 * byte-identical to before. Beside it, `reopen_baseline` holds the
 * declared-artifact snapshot the first attempt after the reopening registered
 * with, so "changed since the reopening" means the same bytes on every retry;
 * it is absent until that attempt registers.
 *
 * Pure. It declares the Task fields it reads instead of importing `Task`: the
 * State File root (`types`) imports this module's types.
 */

import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import { parseDeclaredArtifactBaseline } from "./artifact-baseline";
import { nonEmpty, type DomainResult } from "./orchestration-contract";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { frozenRedThenGreenEra, type TestsOnlyScope } from "./proof-obligations";
import { classifyTaskFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";

/** What `reopen-task --needs` names: the default full re-implementation, or tests only. */
export const REOPEN_NEEDS = ["implementation", "tests"] as const;
export type ReopenNeeds = (typeof REOPEN_NEEDS)[number];

/** The needs a reopening audit records: only a tests-only one spells its needs out. */
export type RecordedReopenNeeds = Exclude<ReopenNeeds, "implementation">;

/** What a reopening audit says it needed: `implementation` when it records none. */
export const reopeningNeedsOf = (audit: Readonly<{ needs?: RecordedReopenNeeds }>): ReopenNeeds =>
  audit.needs ?? "implementation";

/** The Task fields this module reads and writes; an absent scope is a full re-implementation. */
export type ReopenScopeSource = Readonly<{
  reopen_scope?: TestsOnlyScope;
  /** Absent until the first attempt after the reopening registers. */
  reopen_baseline?: readonly DeclaredArtifactBaseline[];
}>;

/** Why a Task's `file_list` cannot carry a tests-only scope. */
export type TestsOnlyClassificationRefusal =
  /** The TaskGraph froze no Test-File Classification (populated before I6). */
  | Readonly<{ kind: "classification-unfrozen" }>
  /** No `file_list` entry is a test file under the frozen classification. */
  | Readonly<{ kind: "no-test-files" }>;

/**
 * The tests-only scope of `fileList` for the reopening audited at
 * `reopening`: the list split by the TaskGraph's frozen Test-File
 * Classification (INV-2's one classifier), or why it cannot be one.
 */
export function classifyTestsOnlyScope(
  fileList: readonly string[],
  manifest: FrozenVerificationManifest | undefined,
  reopening: number,
): DomainResult<TestsOnlyScope, TestsOnlyClassificationRefusal> {
  const era = frozenRedThenGreenEra(manifest);
  if (era.kind === "not-owed") return Object.freeze({ ok: false as const, error: Object.freeze({ kind: "classification-unfrozen" as const }) });
  const classification = classifyTaskFiles(fileList, era.testFiles, undefined);
  const tests = nonEmpty(classification.testFiles);
  if (tests === null) return Object.freeze({ ok: false as const, error: Object.freeze({ kind: "no-test-files" as const }) });
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({ testFiles: tests, implementationFiles: classification.implementationFiles, reopening }),
  });
}

/**
 * The Task with its reopen baseline captured from the first attempt after the
 * reopening: `proofBaseline` is that registration's declared-artifact snapshot
 * of `file_list`. A captured baseline is kept on every later attempt, and a
 * Task with no tests-only scope is returned as it is.
 */
export function withCapturedReopenBaseline<T extends ReopenScopeSource>(
  task: T,
  proofBaseline: readonly DeclaredArtifactBaseline[],
): T {
  if (task.reopen_scope === undefined || task.reopen_baseline !== undefined) return task;
  return { ...task, reopen_baseline: Object.freeze(proofBaseline.map((entry) => Object.freeze({ ...entry }))) };
}

/** Why a tests-only Task's attempt cannot be measured since its reopening. */
export type ReopenBaselineRefusal = Readonly<{ kind: "reopen-baseline-uncaptured"; message: string }>;

/**
 * The baseline a Task's attempt is measured from since its reopening: none
 * for a Task with no tests-only scope, the captured one for a Task with one,
 * or a refusal for a tests-only Task whose registration captured none.
 */
export function attemptReopenBaseline(
  task: ReopenScopeSource,
): DomainResult<readonly DeclaredArtifactBaseline[] | null, ReopenBaselineRefusal> {
  if (task.reopen_scope === undefined) return Object.freeze({ ok: true as const, value: null });
  return task.reopen_baseline === undefined
    ? Object.freeze({
        ok: false as const,
        error: Object.freeze({
          kind: "reopen-baseline-uncaptured" as const,
          message: "tests-only Task's attempt registered without capturing its reopen baseline",
        }),
      })
    : Object.freeze({ ok: true as const, value: task.reopen_baseline });
}

const bullets = (paths: readonly string[], none: string): string =>
  paths.length === 0 ? `- ${none}` : paths.map((path) => `- \`${path}\``).join("\n");

/**
 * What a tests-only attempt is told with its dispatch: the spawn gate binds
 * it, status prints it in the dispatch it owes, and the brief renders it.
 */
export function testsOnlyDispatchAppendix(scope: TestsOnlyScope): string {
  return [
    "## Tests-only reopening (BINDING, ADR-0093)",
    "This Task was reopened for tests only: the Finding it fixes needs new or strengthened tests, not new production code. " +
      "Add the tests that kill the named mutant or cover the named gap in your test files, and leave every implementation file exactly as it is.",
    "Settlement proves, against the bytes your files held when the Task was reopened:",
    "1. at least one of your test files changed;",
    "2. none of your implementation files changed: any implementation file whose bytes differ from the reopening's when you finish " +
      "fails the attempt as `implementation-files-changed`. A write you fully revert leaves no difference;",
    "3. your tests pass, by your final verification run (regression).",
    "No red-then-green order is owed, so no production edit is ever needed. If the Finding cannot be closed without changing production code, " +
      "stop and say so in your report: the orchestrator reopens the Task for a full re-implementation.",
    "",
    "Test files (yours to change):",
    bullets(scope.testFiles, "None."),
    "",
    "Implementation files (off limits):",
    bullets(scope.implementationFiles, "None."),
  ].join("\n");
}

/**
 * Parse a stored `reopen_scope` against the Task's `file_list`: the two lists
 * partition `file_list` in its order, at least one test file, and a
 * `task_reopening_history` position. Whether that position audits a
 * tests-only reopening of this Task is the TaskGraph's to prove.
 */
export function parseTestsOnlyScope(
  raw: unknown,
  fileList: readonly string[],
  path = "reopen_scope",
): ParseResult<TestsOnlyScope> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  const surplus = Object.keys(raw).filter((key) => !["testFiles", "implementationFiles", "reopening"].includes(key));
  if (surplus.length > 0) return fail([`${path} contains unexpected field(s): ${surplus.sort().join(", ")}`]);
  const tests = stringList(raw.testFiles);
  const implementations = stringList(raw.implementationFiles);
  if (tests === null || implementations === null) {
    return fail([`${path}.testFiles and ${path}.implementationFiles must be arrays of strings`]);
  }
  const provenTests = nonEmpty(tests);
  if (provenTests === null) return fail([`${path}.testFiles must name at least one test file`]);
  if (!partitionsFileList(tests, implementations, fileList)) {
    return fail([`${path}.testFiles and ${path}.implementationFiles must partition file_list in its order`]);
  }
  const reopening = raw.reopening;
  if (typeof reopening !== "number" || !Number.isSafeInteger(reopening) || reopening < 0) {
    return fail([`${path}.reopening must be a non-negative safe integer (a task_reopening_history position)`]);
  }
  return ok(Object.freeze({ testFiles: Object.freeze(provenTests), implementationFiles: implementations, reopening }));
}

/** Parse a stored `reopen_baseline`: a declared-artifact snapshot of exactly `file_list`. */
export function parseReopenBaseline(
  raw: unknown,
  fileList: readonly string[],
  path = "reopen_baseline",
): ParseResult<readonly DeclaredArtifactBaseline[]> {
  const entries = parseDeclaredArtifactBaseline(raw, path);
  if (!entries.ok) return entries;
  const artifacts = entries.value.map(({ artifact }) => artifact);
  return artifacts.length === fileList.length && fileList.every((file) => artifacts.includes(file))
    ? entries
    : fail([`${path} must snapshot exactly file_list`]);
}

const stringList = (raw: unknown): readonly string[] | null =>
  Array.isArray(raw) && raw.every((value: unknown) => typeof value === "string" && value.length > 0)
    ? Object.freeze(raw.filter((value: unknown): value is string => typeof value === "string"))
    : null;

/**
 * Whether `tests` and `implementations` split `fileList` exactly: every entry
 * in one of them, none in both, each list in `fileList`'s order.
 */
export function partitionsFileList(
  tests: readonly string[],
  implementations: readonly string[],
  fileList: readonly string[],
): boolean {
  const listed = new Set([...tests, ...implementations]);
  return listed.size === tests.length + implementations.length &&
    listed.size === fileList.length && fileList.every((file) => listed.has(file)) &&
    inOrderOf(tests, fileList) && inOrderOf(implementations, fileList);
}

/** Whether `subset`'s entries appear in `ordered` in the same relative order. */
const inOrderOf = (subset: readonly string[], ordered: readonly string[]): boolean => {
  const positions = subset.map((entry) => ordered.indexOf(entry));
  return positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)));
};
