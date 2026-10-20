/**
 * The surface of I6, the red-then-green proof obligation: the per-file results
 * a TestRun fact carries from its structured report, the split of a Task's
 * `file_list` into test and implementation files, the epoch ledger the
 * settlement shell hands the judge, the judge's verdict, and the judge's pure
 * signature. No logic lives here. It is Acceptance Contract CT-1's types
 * file: it re-exports `TestFileResult` and `TestReportFiles` from their owner,
 * `structured-test-report.ts`, and the proof core imports the rest.
 *
 * Facts only. A TestRun fact records what its report listed; whether that run
 * was red or green for a Task is judged at read time from the ordered facts
 * and the frozen Task data, never stored.
 */

import type { Evidence } from "../machine/types";

// --- Per-file TestRun results (FR-001..FR-004) ---

/** One test file as its structured report lists it, and the per-file results
 *  of one report summary. Their owner, the report parser, documents both. */
export type { TestFileResult, TestReportFiles } from "./structured-test-report";

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
 * `red-missing`: no qualifying run shows a behavioral red in a Task test file
 * (a failing testcase, or under FR-007a a collection error in a Task that
 * creates an implementation file).
 * `red-after-first-implementation-write`: a qualifying red exists, but only
 * after the first write to a Task implementation file. `untrustedOnly` is true
 * when the step is unmet by qualifying runs while the epoch holds a
 * non-qualifying TestRun or the Task's test result has `pi-structured`
 * provenance: only trusted ledger runs qualify.
 *
 * `ledger-unavailable` is minted by proof evaluation, never by the judge: no
 * `LedgerObservation` reached it at all. That is the stored-evidence
 * reconcile path, which reads no ledger and has no earlier satisfied I6
 * result to carry forward. It is distinct from an `unreadable` observation,
 * which settles as `implementation-observation-unavailable` before any
 * judgment and never mints a gap.
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
 * first qualifying behavioral red on a Task test file (a failing testcase
 * that is not a collection error, or, when the Task creates an implementation
 * file, a collection error: FR-007a), the first FileWrite
 * (tool or shell) to a Task implementation file after it, and the first
 * qualifying green after that write, which exits 0 and attributes every Task
 * test file with at least one testcase that ran (`executed - skipped >= 1`),
 * `failed === 0` and no collection error.
 */
export type RedThenGreenObservation =
  | Readonly<{ kind: "shown"; red: RunRef; implementationWrite: string; green: RunRef }>
  | Readonly<{ kind: "unproven"; gap: RedThenGreenGap }>;

/** The settlement receipt failure kind an I6 gap mints. */
export type RedThenGreenFailureKind = `proof:red-then-green-unproven:${RedThenGreenGap["kind"]}`;

/**
 * Judge I6 over one epoch's ordered events. Pure, total and deterministic: the
 * same events, classification, created implementation files, repository root
 * and untrusted-evidence flag give the same observation.
 * `createdImplementationFiles` are the Task's implementation files absent at
 * its first artifact baseline (`createdImplementationFiles` in
 * `red-then-green.ts`). When there is at least one, a collection error in a
 * Task test file is red (FR-007a): before the Task writes the module, a test
 * that imports it cannot load, and that failure is the red. When there is
 * none, only a failing testcase is red (FR-007). `repositoryRoot` makes an
 * absolute reported file identity repository-relative before attribution.
 * `untrustedEvidence` is true when the Task's test result carries
 * `pi-structured` provenance.
 */
export type JudgeRedThenGreenFn = (
  events: readonly Evidence[],
  classification: TestFileClassification,
  createdImplementationFiles: readonly string[],
  repositoryRoot: string,
  untrustedEvidence: boolean,
) => RedThenGreenObservation;
