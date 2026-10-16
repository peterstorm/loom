/**
 * Acceptance Contract CT-2's types file: the surface of I7, the
 * affected-test stop check, and of its `helper stop-check-plan` view.
 *
 * At every implementation Task's stop (claimant or not), the operator-declared
 * `affectedRunner` runs over the Task's changed files: the attempt epoch's
 * ledger FileWrite paths that still exist. A failing affected test blocks
 * the stop, at most `AFFECTED_STOP_CHECK_MAX_BLOCKS` times per agent, and
 * every fault fails open with a note naming its cause. The acceptance check and
 * the affected check run in sequence under one runner lock and inside one hook
 * budget, and they produce one combined block message. Nothing here is
 * completion evidence: no type below reaches proof, receipts or Wave Gate
 * evidence (FR-026).
 *
 * Types and fixed constants only: the types, sealed ADTs, function
 * signatures, budget constants and fixed text tables that the planner, the
 * stop shell and the plan view share. No function is implemented here. This
 * file is the CT-2 contract surface, changed only through a CT-2 amendment.
 *
 * Layering note: `StopChecksPorts` is the stop shell's port, and the core
 * owns its shape. The core may not import the shell's canonical repository
 * root or the completion runner's result type, so the port is parametric over
 * both. The shell instantiates it as
 * `StopChecksPorts<CanonicalRepositoryRoot, CompletionCheckRunnerResult>`,
 * which is a structural superset of `StopCheckPorts`.
 */

import type { OwedStopCheck } from "./acceptance-contract";
import type { AuthorizedWaveCompletionCheck } from "./completion-suite";
import type { NonEmpty } from "./orchestration-contract";
import type { ReviewPath } from "./review-packet";
import type { StopCheckOffReason, StopCheckPlanRendering, StopCheckPlanView, StopCheckRunnerCommand } from "./stop-check-plan-types";
import type { JunitTestcasesResult } from "./structured-test-report";
import type { AcceptanceRunner } from "./verification-manifest";
import type { Evidence } from "../machine/types";
import type { TaskGraph } from "../types";

// --- Budget and caps ---

/** The SubagentStop hook's own timeout (hooks.json). Both runs together finish inside it (FR-025). */
export const STOP_HOOK_BUDGET_MS = 300_000;

/** Kept free for settlement and cleanup after both checks. The stop shell's
 *  deadline is `hookStartedAtMs + STOP_HOOK_BUDGET_MS - SETTLEMENT_RESERVE_MS`. */
export const SETTLEMENT_RESERVE_MS = 30_000;

/** The longest `affectedRunner.timeoutMs` a manifest may declare. The
 *  affected runner launches only when the time left before the deadline is
 *  at least its `timeoutMs`. Otherwise the check fails open as
 *  `budget-exhausted`, and the timeout is never clipped. */
export const MAX_AFFECTED_RUNNER_TIMEOUT_MS = 120_000;

/** At most this many affected-check blocks per spawned agent. The counter is
 *  independent of the acceptance check's own `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS`. */
export const AFFECTED_STOP_CHECK_MAX_BLOCKS = 3;

// --- Frozen manifest additions ---

/** Same shape and form checks as `acceptanceRunner`, with `timeoutMs <=
 *  MAX_AFFECTED_RUNNER_TIMEOUT_MS`, and a report path distinct from
 *  `acceptanceRunner`'s and from every Wave check's. */
export type AffectedRunner = AcceptanceRunner;

/** The frozen test-file classification. The freezer always records it, and it
 *  enters the manifest digest; a manifest frozen before the field existed lacks it. */
export type FrozenTestFiles = Readonly<{
  source: "operator-manifest" | "engine-default";
  suffixes: NonEmpty<string>;
}>;

/** What a frozen verification manifest adds for I6 and I7. `affectedRunner`
 *  is present, and enters the digest, only when the operator declared it. */
export type FrozenStopCheckManifestFields = Readonly<{
  testFiles?: FrozenTestFiles;
  affectedRunner?: AffectedRunner;
}>;

// --- Changed files ---

/** A canonical repository-relative POSIX path, produced only by `parseReviewPath`. */
export type ChangedFilePath = ReviewPath;

/**
 * A Task's changed files at stop: the attempt epoch's FileWrite paths,
 * deduplicated in first-write order, kept only inside the repository and only
 * when they exist at stop time. A renamed file arrives under its new path as
 * its own FileWrite. Only `changedFilesAtStop` (in `changed-files.ts`, the
 * owner of INV-7) constructs one.
 */
export type ChangedFiles =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "some"; files: NonEmpty<ChangedFilePath> }>;

/** Derive the changed files from one epoch's ledger events. Pure and total.
 *  `exists` is the shell's stop-time existence predicate. */
export type ChangedFilesAtStopFn = (
  events: readonly Evidence[],
  repositoryRoot: string,
  exists: (path: ChangedFilePath) => boolean,
) => ChangedFiles;

// --- Plan ---

/** The completion check a runner forms, as the completion runner executes it. */
export type StopCheckCommand = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

/** Why the affected check does nothing at this Task's stop. Exactly one
 *  applies, in this precedence: no runner, then no changed files, then the
 *  command refused. */
export type AffectedOffReason =
  | Readonly<{ kind: "no-runner" }>
  /** `outsideCwd` holds the changed files that existed but lie outside
   *  `affectedRunner.cwd`; it is null when the epoch had no changed file at all. */
  | Readonly<{ kind: "no-changed-files"; outsideCwd: NonEmpty<ChangedFilePath> | null }>
  /** The runner-command builder refused these files; `errors` holds its refusal text. */
  | Readonly<{ kind: "command-refused"; errors: NonEmpty<string> }>;

/** What the TaskGraph and the changed files decide about the affected check. An
 *  `on` plan always has the files beneath the runner cwd and the command formed over them. */
export type AffectedPlan =
  | Readonly<{ kind: "off"; reason: AffectedOffReason }>
  | Readonly<{ kind: "on"; files: NonEmpty<ChangedFilePath>; command: StopCheckCommand; reportPath: string }>;

/** The acceptance check's plan, the `off | on` arm `planStopCheck` decides, unchanged. */
export type AcceptancePlan =
  | Readonly<{ kind: "off"; reason: StopCheckOffReason }>
  | Readonly<{ kind: "on"; check: OwedStopCheck; command: StopCheckCommand; reportPath: string }>;

/** Both stop checks for one Task's stop, decided by one pure planner (INV-1). */
export type StopChecksPlan =
  | Readonly<{ kind: "unknown-task" }>
  | Readonly<{ kind: "known"; wave: number; acceptance: AcceptancePlan; affected: AffectedPlan }>;

/** `planStopChecks`: the single pure, total decision point for both checks
 *  (FR-027). The live stop shell and the plan view both consume it. */
export type PlanStopChecksFn = (graph: TaskGraph, taskId: string, changed: ChangedFiles) => StopChecksPlan;

// --- Judging an affected run ---

/** One affected testcase the report shows not passing, with the file as reported. */
export type FailingAffectedTestcase = Readonly<{
  file: string;
  name: string;
  outcome: "failed" | "collection-error";
}>;

/** The verdict on one affected run's JUnit report. A report with zero
 *  testcases is `passed` with `zero-tests`, and the stop notes it (AS-023). */
export type AffectedRunVerdict =
  | Readonly<{ kind: "passed"; observed: "some-tests" | "zero-tests" }>
  | Readonly<{ kind: "failing"; testcases: NonEmpty<FailingAffectedTestcase> }>
  | Readonly<{ kind: "unobservable"; reason: string }>;

/** `judgeAffectedRun`: pure and total over the parsed report. */
export type JudgeAffectedRunFn = (projection: JunitTestcasesResult) => AffectedRunVerdict;

// --- Stop shell ---

/** The outcome of both checks at one stop. It carries only text and no
 *  completion data, so nothing in it can reach settlement (INV-3). */
export type StopChecksOutcome =
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "passed" }>
  /** The same agent keeps working; one combined message, with a heading per contributing check. */
  | Readonly<{ kind: "block"; message: string }>
  /** The stop proceeds, and the operator is told what each check noted. */
  | Readonly<{ kind: "note"; message: string }>;

/** Blocks already issued to one agent by one check, or why that count cannot be read. */
export type StopCheckBlockCount =
  | Readonly<{ kind: "count"; blocks: number }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** The one per-repository runner lock both checks run under. `release`
 *  returns why the lock could not be released, or null. */
export type StopCheckRunnerLock =
  | Readonly<{ kind: "acquired"; release: () => string | null }>
  | Readonly<{ kind: "held"; reason: string }>;

/**
 * The I/O both stop checks need, injectable for tests. `Root` is the shell's
 * canonical repository root, and `RunResult` is the completion runner's
 * result. Instantiated with those two types, the port is a structural superset
 * of `StopCheckPorts`. The unprefixed counter methods keep counting
 * acceptance-check blocks, and the `Affected` ones count the affected check's
 * own blocks.
 */
export type StopChecksPorts<Root extends string, RunResult> = Readonly<{
  repositoryRoot: (stateFilePath: string) => Readonly<{ ok: true; root: Root }> | Readonly<{ ok: false; reason: string }>;
  /** Acquired once per stop. Both runs and both report reads happen while it is held (AS-031). */
  acquireRunner: (root: Root) => StopCheckRunnerLock;
  /** Runs either check's formed command. The two checks' report paths always differ. */
  runCheck: (check: StopCheckCommand, root: Root) => Promise<RunResult>;
  readReport: (path: string) => Uint8Array;
  blocksIssued: (agentKey: string) => StopCheckBlockCount;
  recordBlock: (agentKey: string, blocks: number) => void;
  clearBlocks: (agentKey: string) => void;
  affectedBlocksIssued: (agentKey: string) => StopCheckBlockCount;
  /** Record that the affected check has now blocked this agent `blocks` times. */
  recordAffectedBlock: (agentKey: string, blocks: number) => void;
  /** Forget this agent's affected blocks: its stop is proceeding. */
  clearAffectedBlocks: (agentKey: string) => void;
  /** Whether a changed file exists at stop time. This is the existence
   *  predicate the shell hands `changedFilesAtStop`. */
  pathExists: (root: Root, path: ChangedFilePath) => boolean;
  /** The clock that measures the hook budget, in epoch ms. The dispatcher's
   *  first reading at hook entry is `hookStartedAtMs`, and every later
   *  reading is measured against that deadline. */
  now: () => number;
}>;

/** Why the affected check did not decide or block. Each kind's note carries
 *  `AFFECTED_NOTE_TEXT[kind]` verbatim, and the stop proceeds. */
export type AffectedStopCheckNoteKind =
  | "no-changed-files"
  | "zero-tests"
  | "timed-out"
  | "killed"
  | "no-readable-report"
  | "start-failed"
  | "did-not-complete"
  | "budget-exhausted"
  | "cap-reached"
  | "counter-unreadable"
  | "command-refused"
  | "lock-held"
  | "repository-unavailable"
  | "crashed";

/** The fixed text each affected-check note carries. */
export const AFFECTED_NOTE_TEXT: Readonly<Record<AffectedStopCheckNoteKind, string>> = {
  "no-changed-files": "the affected stop check is skipped: this attempt has no changed files",
  "zero-tests": "the affected stop check passes: zero affected tests were found",
  "timed-out": "the affected runner timed out",
  "killed": "the affected runner was killed",
  "no-readable-report": "the affected runner left no readable report",
  "start-failed": "the affected runner could not start",
  "did-not-complete": "the affected runner did not complete",
  "budget-exhausted": "the stop hook budget was exhausted before the affected runner could run in full",
  "cap-reached": `the affected stop check reached its ${AFFECTED_STOP_CHECK_MAX_BLOCKS}-block cap`,
  "counter-unreadable": "the affected stop check's block counter is unreadable",
  "command-refused": "the affected runner command could not be formed for the changed files",
  "lock-held": "another stop holds the stop-check runner lock",
  "repository-unavailable": "the repository root is unavailable to the affected stop check",
  "crashed": "the affected stop check crashed and did not decide",
};

/** The heading of the acceptance check's part of a block message. It is
 *  present exactly when that check contributes failures. */
export const ACCEPTANCE_BLOCK_HEADING = "## Acceptance stop check";

/** The heading of the affected check's part of a block message. It is present
 *  exactly when that check contributes failures. Each failing affected test
 *  under it reads `- '<name>' (<file>) — <outcome>`. */
export const AFFECTED_BLOCK_HEADING = "## Affected-test stop check";

// --- Plan view ---

/** The affected check's part of the plan view. An `on` view always has the
 *  changed files the runner gets and the command over them. */
export type AffectedStopCheckView =
  | Readonly<{ kind: "off"; reason: AffectedOffReason }>
  | Readonly<{ kind: "on"; files: NonEmpty<ChangedFilePath>; command: StopCheckRunnerCommand }>;

/** Both checks' view of one known Task. `acceptance` is the CT-1 view, unchanged. */
export type StopChecksPlanView =
  | Readonly<{ kind: "unknown-task"; taskId: string }>
  | Readonly<{
      kind: "known";
      acceptance: Exclude<StopCheckPlanView, { kind: "unknown-task" }>;
      affected: AffectedStopCheckView;
    }>;

/** The plan as the shell consumes it: lines to print, or a refusal naming the id. */
export type StopChecksPlanRendering = StopCheckPlanRendering;

/** Project a TaskGraph, a Task id and its changed files into the view. Pure and total. */
export type StopChecksPlanViewFn = (graph: TaskGraph, taskId: string, changed: ChangedFiles) => StopChecksPlanView;

/**
 * Render both plans for one Task. Pure and total, and it never runs a runner.
 *
 * A known Task renders the CT-1 acceptance lines (`renderStopCheckPlan`'s
 * lines, unchanged), then the affected section. An `on` section is:
 *
 *   affected tests:
 *     changed files:
 *       <file>                  one line per file the runner gets, in first-write order
 *     cwd: <cwd>
 *     argv: <JSON array>        the executable and its args after {files} expansion
 *     report: <report path>
 *
 * An `off` section is:
 *
 *   affected tests:
 *     affected stop check off — <AFFECTED_OFF_REASON_TEXT[reason.kind]>
 *       <error>                 command-refused: one line per refusal error
 *       outside the affected runner cwd: <file>   no-changed-files with outsideCwd: one line per file
 *
 * An unknown id is refused exactly as in CT-1.
 */
export type RenderStopChecksPlanFn = (graph: TaskGraph, taskId: string, changed: ChangedFiles) => StopChecksPlanRendering;

/** The first line of the affected section. */
export const AFFECTED_SECTION_HEADING = "affected tests:";

/** An `off` section's second line, followed by ` — ${reason text}`. */
export const AFFECTED_STOP_CHECK_OFF = "affected stop check off";

/** The one line each off-reason renders after `AFFECTED_STOP_CHECK_OFF — `. */
export const AFFECTED_OFF_REASON_TEXT: Readonly<Record<AffectedOffReason["kind"], string>> = {
  "no-runner": "no affected runner is frozen in this TaskGraph",
  "no-changed-files": "this Task's attempt has no changed files beneath the affected runner cwd",
  "command-refused": "the affected runner command could not be formed for the changed files",
};

/** The prefix of each `outsideCwd` detail line: `${AFFECTED_OUTSIDE_CWD_PREFIX}: ${file}`. */
export const AFFECTED_OUTSIDE_CWD_PREFIX = "outside the affected runner cwd";
