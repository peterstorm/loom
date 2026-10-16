/**
 * The surface of I6, the red-then-green proof obligation: the per-file results
 * a TestRun fact carries from its structured report, the split of a Task's
 * `file_list` into test and implementation files, the epoch ledger the
 * settlement shell hands the judge, the judge's verdict, and the judge's pure
 * signature. No logic lives here. It is Acceptance Contract CT-1's frozen
 * types file: `structured-test-report.ts` imports `TestFileResult` and
 * `TestReportFiles` from here, and the proof core imports the rest.
 *
 * Facts only. A TestRun fact records what its report listed; whether that run
 * was red or green for a Task is judged at read time from the ordered facts
 * and the frozen Task data, never stored.
 */

import type { Evidence } from "../machine/types";

// --- Per-file TestRun results (FR-001..FR-004) ---

/**
 * One test file as its structured report lists it.
 *
 * `file` is the report's identity exactly as written: a JUnit testcase's
 * `classname` (a runner-relative path under Vitest, a JVM class under
 * Surefire), or a Vitest JSON `testResults[].name` (an absolute path). The
 * capture cwd and the command string never rewrite or contribute to it.
 *
 * `executed` and `failed` count this file's testcases under the report
 * format's own counting rule, so the results of one report reconcile with its
 * summary counts. `collectionError` is true when the file failed to collect or
 * import: Vitest JUnit's synthetic testcase whose `name` equals its
 * `classname`, or a failed Vitest JSON entry with no `assertionResults`. A
 * file whose only failure is a collection error is never a behavioral red.
 */
export type TestFileResult = Readonly<{
  file: string;
  executed: number;
  failed: number;
  collectionError: boolean;
}>;

/**
 * The per-file results of one report summary. `unrecorded` is a fact captured
 * before per-file results existed (a legacy ledger line): it reads without
 * error and never satisfies an I6 step. `recorded` lists exactly the files
 * the report listed, each once.
 */
export type TestReportFiles =
  | Readonly<{ kind: "unrecorded" }>
  | Readonly<{ kind: "recorded"; results: readonly TestFileResult[] }>;

// --- Test-file classification (FR-013, FR-014) ---

/**
 * A Task's `file_list`, partitioned by the frozen test-file pattern. Every
 * entry is in exactly one list, in `file_list` order: a test file matches the
 * pattern, and every other entry (fixtures, helpers, type files included) is
 * an implementation file.
 */
export type TestFileClassification = Readonly<{
  testFiles: readonly string[];
  implementationFiles: readonly string[];
}>;

// --- The epoch ledger the settlement shell observes ---

/**
 * One attempt epoch's ledger as the settlement shell read it, on either
 * harness. `read` carries the epoch's events in ledger order, duplicate
 * deliveries already dropped by the fold boundary. `unreadable` is an
 * infrastructure fact: it settles as `implementation-observation-unavailable`
 * and never consumes semantic retry budget.
 */
export type LedgerObservation =
  | Readonly<{ kind: "read"; events: readonly Evidence[] }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

// --- The I6 judgment (FR-006..FR-012) ---

/**
 * A qualifying TestRun the judgment relied on. `index` is the run's 0-based
 * position in the epoch's ordered events (`LedgerObservation.events`), so the
 * reference names one fact of that epoch; `command` is that fact's command.
 *
 * A qualifying run has `exit !== null`, a non-null report, and recorded
 * per-file results. Nothing else counts for red or green, on either harness
 * and under every proof evaluation policy.
 */
export type RunRef = Readonly<{ index: number; command: string }>;

/**
 * The one step I6 found unmet, reported with this precedence:
 *
 *   no-test-files
 *     > implementation-write-missing
 *     > red-missing | red-after-first-implementation-write
 *     > green-missing
 *
 * `red-missing`: no qualifying run shows a behavioral red in a Task test file.
 * `red-after-first-implementation-write`: a qualifying red exists, but only
 * after the first write to a Task implementation file. `untrustedOnly` is true
 * when the step is unmet by qualifying runs while the epoch holds a
 * non-qualifying TestRun or the Task's test result has `pi-structured`
 * provenance: only trusted ledger runs qualify. `ledger-unavailable`: no
 * observation of the epoch ledger reached the judgment.
 */
export type RedThenGreenGap =
  | Readonly<{ kind: "no-test-files" }>
  | Readonly<{ kind: "implementation-write-missing" }>
  | Readonly<{ kind: "red-missing"; untrustedOnly: boolean }>
  | Readonly<{ kind: "red-after-first-implementation-write" }>
  | Readonly<{ kind: "green-missing"; untrustedOnly: boolean }>
  | Readonly<{ kind: "ledger-unavailable" }>;

/**
 * The I6 verdict over one epoch. `shown` names the three facts in order: the
 * first qualifying behavioral red on a Task test file, the first FileWrite
 * (tool or shell) to a Task implementation file after it, and the first
 * qualifying green after that write, which exits 0 and attributes every Task
 * test file with `executed >= 1`, `failed === 0` and no collection error.
 */
export type RedThenGreenObservation =
  | Readonly<{ kind: "shown"; red: RunRef; implementationWrite: string; green: RunRef }>
  | Readonly<{ kind: "unproven"; gap: RedThenGreenGap }>;

/** The settlement receipt failure kind an I6 gap mints. */
export type RedThenGreenFailureKind = `proof:red-then-green-unproven:${RedThenGreenGap["kind"]}`;

/**
 * Judge I6 over one epoch's ordered events. Pure, total and deterministic: the
 * same events, classification, repository root and untrusted-evidence flag
 * give the same observation. `repositoryRoot` makes an absolute reported file
 * identity repository-relative before attribution. `untrustedEvidence` is true
 * when the Task's test result carries `pi-structured` provenance.
 */
export type JudgeRedThenGreenFn = (
  events: readonly Evidence[],
  classification: TestFileClassification,
  repositoryRoot: string,
  untrustedEvidence: boolean,
) => RedThenGreenObservation;
