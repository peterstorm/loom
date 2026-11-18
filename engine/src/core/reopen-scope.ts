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
 * The scope is protected Task state, `reopen_scope`, present only while a
 * tests-only reopening is in force; absent reads as a full re-implementation,
 * so a graph that never asks for one is byte-identical to before. It freezes
 * the Task's Test-File Classification and, from the first attempt after the
 * reopening, the declared-artifact baseline that attempt registered with, so
 * "changed since the reopening" means the same bytes on every retry.
 *
 * Pure. It declares the Task fields it reads instead of importing `Task`: the
 * State File root (`types`) imports this module's types.
 */

import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import { parseDeclaredArtifactBaseline } from "./artifact-baseline";
import { nonEmpty, type DomainResult, type NonEmpty } from "./orchestration-contract";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { frozenRedThenGreenEra, type TestsOnlyScope } from "./proof-obligations";
import { classifyTaskFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";

/** What `reopen-task --needs` names: the default full re-implementation, or tests only. */
export const REOPEN_NEEDS = ["implementation", "tests"] as const;
export type ReopenNeeds = (typeof REOPEN_NEEDS)[number];

/** What a reopening audit says it needed: `implementation` when it records none. */
export const reopeningNeedsOf = (audit: Readonly<{ needs?: Exclude<ReopenNeeds, "implementation"> }>): ReopenNeeds =>
  audit.needs ?? "implementation";

/**
 * The bytes "since the reopening" are measured from: none yet, until the
 * first attempt after the reopening registers, then that registration's
 * declared-artifact snapshot of the Task's `file_list`. Nothing writes a
 * reopened Task's declared files between the reopening (which requires a
 * quiescent Wave) and that registration, so the two are the same bytes.
 */
export type ReopenBaseline =
  | Readonly<{ kind: "awaiting-attempt" }>
  | Readonly<{ kind: "captured"; entries: readonly DeclaredArtifactBaseline[] }>;

/** The protected `reopen_scope` of a Task reopened for tests only, in State File spelling. */
export type TestsOnlyReopenScope = Readonly<{
  kind: "tests-only";
  /** The frozen Test-File Classification's test files of `file_list`, in its order. */
  test_files: NonEmpty<string>;
  /** Every other `file_list` entry, in its order. */
  implementation_files: readonly string[];
  baseline: ReopenBaseline;
}>;

/** The Task fields this module reads and writes; an absent scope is a full re-implementation. */
export type ReopenScopeSource = Readonly<{ reopen_scope?: TestsOnlyReopenScope }>;

const AWAITING_ATTEMPT: ReopenBaseline = Object.freeze({ kind: "awaiting-attempt" });

/** The scope as the Proof derivation takes it. */
export const testsOnlyProofScope = (scope: TestsOnlyReopenScope): TestsOnlyScope =>
  Object.freeze({ testFiles: scope.test_files, implementationFiles: scope.implementation_files });

/** Why a Task's `file_list` cannot carry a tests-only scope. */
export type TestsOnlyClassificationRefusal =
  /** The TaskGraph froze no Test-File Classification (populated before I6). */
  | Readonly<{ kind: "classification-unfrozen" }>
  /** No `file_list` entry is a test file under the frozen classification. */
  | Readonly<{ kind: "no-test-files" }>;

/**
 * A fresh tests-only scope over `fileList`, split by the TaskGraph's frozen
 * Test-File Classification (INV-2's one classifier), awaiting its first
 * attempt; or why it cannot be one.
 */
export function classifyTestsOnlyScope(
  fileList: readonly string[],
  manifest: FrozenVerificationManifest | undefined,
): DomainResult<TestsOnlyReopenScope, TestsOnlyClassificationRefusal> {
  const era = frozenRedThenGreenEra(manifest);
  if (era.kind === "not-owed") return Object.freeze({ ok: false as const, error: Object.freeze({ kind: "classification-unfrozen" as const }) });
  const classification = classifyTaskFiles(fileList, era.testFiles, undefined);
  const tests = nonEmpty(classification.testFiles);
  if (tests === null) return Object.freeze({ ok: false as const, error: Object.freeze({ kind: "no-test-files" as const }) });
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      kind: "tests-only" as const,
      test_files: tests,
      implementation_files: classification.implementationFiles,
      baseline: AWAITING_ATTEMPT,
    }),
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
  const scope = task.reopen_scope;
  if (scope === undefined || scope.baseline.kind === "captured") return task;
  const entries = Object.freeze(proofBaseline.map((entry) => Object.freeze({ ...entry })));
  return { ...task, reopen_scope: Object.freeze({ ...scope, baseline: Object.freeze({ kind: "captured" as const, entries }) }) };
}

/** The captured reopen baseline of a tests-only Task, or null when there is none to measure from. */
export const capturedReopenBaseline = (task: ReopenScopeSource): readonly DeclaredArtifactBaseline[] | null =>
  task.reopen_scope?.baseline.kind === "captured" ? task.reopen_scope.baseline.entries : null;

const bullets = (paths: readonly string[], none: string): string =>
  paths.length === 0 ? `- ${none}` : paths.map((path) => `- \`${path}\``).join("\n");

/**
 * What a tests-only attempt is told with its dispatch: the spawn gate binds
 * it, status prints it in the dispatch it owes, and the brief renders it.
 */
export function testsOnlyDispatchAppendix(scope: TestsOnlyReopenScope): string {
  return [
    "## Tests-only reopening (BINDING, ADR-0093)",
    "This Task was reopened for tests only: the Finding it fixes needs new or strengthened tests, not new production code. " +
      "Add the tests that kill the named mutant or cover the named gap in your test files, and leave every implementation file exactly as it is.",
    "Settlement proves, against the bytes your files held when the Task was reopened:",
    "1. at least one of your test files changed;",
    "2. none of your implementation files changed: any write to one fails the attempt as `implementation-files-changed`, even if you undo it later only in part;",
    "3. your tests pass, by your final verification run (regression).",
    "No red-then-green order is owed, so no production edit is ever needed. If the Finding cannot be closed without changing production code, " +
      "stop and say so in your report: the orchestrator reopens the Task for a full re-implementation.",
    "",
    "Test files (yours to change):",
    bullets(scope.test_files, "None."),
    "",
    "Implementation files (off limits):",
    bullets(scope.implementation_files, "None."),
  ].join("\n");
}

/**
 * Parse a stored `reopen_scope` against the Task's `file_list`: the two lists
 * partition `file_list` in its order, at least one test file, and the
 * baseline either awaiting its attempt or captured over exactly `file_list`.
 */
export function parseTestsOnlyReopenScope(
  raw: unknown,
  fileList: readonly string[],
  path = "reopen_scope",
): ParseResult<TestsOnlyReopenScope> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  const surplus = Object.keys(raw).filter((key) => !["kind", "test_files", "implementation_files", "baseline"].includes(key));
  if (surplus.length > 0) return fail([`${path} contains unexpected field(s): ${surplus.sort().join(", ")}`]);
  if (raw.kind !== "tests-only") return fail([`${path}.kind must be tests-only`]);
  const tests = stringList(raw.test_files);
  const implementations = stringList(raw.implementation_files);
  if (tests === null || implementations === null) {
    return fail([`${path}.test_files and ${path}.implementation_files must be arrays of strings`]);
  }
  const provenTests = nonEmpty(tests);
  if (provenTests === null) return fail([`${path}.test_files must name at least one test file`]);
  if (!partitionsFileList(tests, implementations, fileList)) {
    return fail([`${path}.test_files and ${path}.implementation_files must partition file_list in its order`]);
  }
  const baseline = parseReopenBaseline(raw.baseline, fileList, `${path}.baseline`);
  if (!baseline.ok) return baseline;
  return ok(Object.freeze({
    kind: "tests-only" as const,
    test_files: Object.freeze(provenTests),
    implementation_files: implementations,
    baseline: baseline.value,
  }));
}

function parseReopenBaseline(raw: unknown, fileList: readonly string[], path: string): ParseResult<ReopenBaseline> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "awaiting-attempt") {
    return Object.keys(raw).length === 1 ? ok(AWAITING_ATTEMPT) : fail([`${path} contains unexpected field(s)`]);
  }
  if (raw.kind !== "captured") return fail([`${path}.kind must be awaiting-attempt or captured`]);
  if (Object.keys(raw).some((key) => key !== "kind" && key !== "entries")) return fail([`${path} contains unexpected field(s)`]);
  const entries = parseDeclaredArtifactBaseline(raw.entries, `${path}.entries`);
  if (!entries.ok) return entries;
  const artifacts = entries.value.map(({ artifact }) => artifact);
  return artifacts.length === fileList.length && fileList.every((file) => artifacts.includes(file))
    ? ok(Object.freeze({ kind: "captured" as const, entries: entries.value }))
    : fail([`${path}.entries must snapshot exactly file_list`]);
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
