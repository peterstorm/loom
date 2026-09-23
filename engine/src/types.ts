/**
 * Shared Loom schemas and Hook result/input types.
 */

import type {
  FailedTaskProof,
  PendingTaskProof,
  SatisfiedTaskProof,
  TaskProof,
} from "./core/proof-obligations";
import type {
  ImplementationAttemptAuthority,
  ImplementationAttemptSettlementReceipt,
  ImplementationSettlementReceiptId,
} from "./core/implementation-completion";
import type { ImplementationAttemptContext } from "./core/implementation-retry";
import type { StoredVerificationPolicy } from "./core/verification-policy";
import type { DeclaredArtifactBaseline } from "./core/artifact-baseline";
import type { IssuedReviewPacketRegistration } from "./core/review-packet";
import type {
  AcceptedWaveCompletionReceipt,
  CompletionCheckId,
  CompletionSemanticFailure,
  WaveCompletionSuiteResult,
} from "./core/completion-suite";
import type { FrozenVerificationManifest, ProjectVerificationCoverage } from "./core/verification-manifest";
import type { Phase } from "./core/phases";
import type { SettledFloor, SpecIndexObservation } from "./core/requirement-coverage";
export type { IssuedReviewPacketRegistration } from "./core/review-packet";
export { PHASES, type Phase } from "./core/phases";
import type {
  ArtifactDigest,
  ArtifactRef,
  AwaitUserAction,
  BlockedAction,
  DoneAction,
  NonEmpty as OrchestrationNonEmpty,
  OrchestrationRunId,
  ProtectedWaveStateCommitted,
  SpawnBatchAction,
  TerminalBlockedDiagnostic,
} from "./core/orchestration-contract";

// --- Hook Result (discriminated union) ---

export type HookResult =
  /**
   * The tool call proceeds. `systemMessage` is for the case where it proceeds
   * but the operator needs to know something anyway — a gate reporting that it
   * could NOT run, most of all.
   *
   * It exists because stderr does not reach anyone on a successful hook: an
   * exit-0 PreToolUse hook's stderr is not surfaced outside `--debug`, so
   * `validate-agent-skill` announcing "skill enforcement SKIPPED for this spawn"
   * was as silent as the `allow` it replaced. The harness DOES surface a
   * `systemMessage` from a hook's JSON stdout, which is the only channel that
   * actually reaches the operator on this path.
   */
  | { kind: "allow"; systemMessage?: string }
  | { kind: "block"; message: string }
  | { kind: "error"; message: string }
  /**
   * The hook declines to decide and the tool call proceeds untouched.
   * `systemMessage` carries the same operator channel `allow` has, and for the
   * same reason: `passthrough` also exits 0, so a handler that wrote its
   * diagnostic to stderr immediately before returning here wrote it to nobody.
   * A reviewer whose findings were discarded, a task graph that could not be
   * read, an evidence write that did not land — every one of those was reported
   * through a channel the harness swallows.
   *
   * Hook handlers populate this. CLI helpers under `handlers/helpers/` do NOT:
   * their stderr does reach their caller, and several of them emit machine-read
   * JSON on stdout that a second `systemMessage` object would corrupt.
   */
  | { kind: "passthrough"; systemMessage?: string };

/** Defense-in-depth: collapse empty diagnostic messages to a sentinel so
 *  a silent error/block can never reach the user. Used at the cli exit boundary. */
export function nonEmptyMessage(s: string | undefined | null): string {
  return s && s.trim() !== "" ? s : "<no message provided>";
}

/** Smart constructors — preferred over object literals so callers funnel through nonEmptyMessage. */
export const allowResult = (): HookResult => ({ kind: "allow" });
export const passthroughResult = (systemMessage?: string): HookResult =>
  systemMessage === undefined
    ? { kind: "passthrough" }
    : { kind: "passthrough", systemMessage: nonEmptyMessage(systemMessage) };
export const errorResult = (message: string): HookResult => ({ kind: "error", message: nonEmptyMessage(message) });
export const blockResult = (message: string): HookResult => ({ kind: "block", message: nonEmptyMessage(message) });

// --- Handler signature ---

export type HookHandler = (stdin: string, args: string[]) => Promise<HookResult>;

// --- Hook input types (from Claude Code stdin JSON) ---

export interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
  /** Harness id of this tool call — stamped as the call-start key so the
   *  PostToolUse recorder can scope report artifacts to THIS call. */
  tool_use_id?: string;
}

export interface SubagentStopInput {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

export interface SubagentStartInput {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

// --- Task Graph state ---

/** Task status values — the const tuple is the source of truth so parsers
 *  (parseTaskGraph) can prove disk values against it. */
export const TASK_STATUSES = ["pending", "implemented", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_STATUSES = ["pending", "passed", "blocked", "evidence_capture_failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// The wave-gate domain model (TaskTestResult, testResultPassed, WaveGate,
// newWaveGate) lives in the PURE core module core/wave-gate-model — a
// functional-core consumer must not import runtime values from this legacy
// catch-all, which also declares outer-shell hook contracts. Re-exported here
// (and imported for this module's own schema-root declarations) so the import
// surface is unchanged; only the dependency arrow moved. See
// core/wave-gate-model.ts.
export { newWaveGate, testResultPassed } from "./core/wave-gate-model";
import type { TaskTestResult, WaveGate } from "./core/wave-gate-model";
export type { TaskTestResult, WaveGate } from "./core/wave-gate-model";

/**
 * Pre-refactor task graphs stored `tests_passed: boolean` on the task; the
 * field was replaced by `test_result` with NO compat read (the branch never
 * shipped). Such a task now reads as missing evidence — correct, but
 * mystifying without a note. Pure: returns the operator-facing explanation
 * when the raw task object carries the legacy field without its
 * replacement, null otherwise.
 */
export function legacyTestsPassedNote(task: unknown): string | null {
  if (typeof task !== "object" || task === null) return null;
  const raw = task as Record<string, unknown>;
  if (!("tests_passed" in raw) || "test_result" in raw) return null;
  const id = typeof raw.id === "string" ? raw.id : "<unknown>";
  return `legacy tests_passed found on task ${id}; re-run task or regenerate graph — field replaced by test_result`;
}

// --- Review findings ---
//
// The Finding/ReviewRun/Refutation vocabulary lives in the Finding concept's
// core modules — the leaf shape volume core/findings-shape.ts plus its
// behaviour owner core/findings.ts (the wave-gate extraction pattern, one
// concept one owner). The shapes used to sit here beside `Task` to avoid a
// shape-level cycle; the leaf volume is what keeps the module graph acyclic:
// types.ts binds its schema-root Task fields to findings-shape one-way, and
// core/findings keeps its type-only Task/ReviewStatus edge to this file.
// Re-exported here so the import surface is unchanged; only the dependency
// arrow moved. See core/findings-shape.ts and core/findings.ts.
export { FINDING_SEVERITIES, PRIOR_FINDING_VERDICTS } from "./core/findings-shape";
import type {
  AcceptedReviewAuthority,
  Finding,
  RefutedFinding,
  ResolvedFinding,
  ReviewRun,
} from "./core/findings-shape";
export type {
  AcceptedReviewAuthority,
  CurrentAcceptedReviewAuthority,
  CurrentDraftFinding,
  CurrentReviewRun,
  CurrentReviewRunEvidence,
  CurrentReviewRunSlotAuthority,
  DraftFinding,
  Finding,
  FindingIdentity,
  FindingResolution,
  FindingResolutionAssessment,
  FindingSeverity,
  LegacyAcceptedReviewAuthority,
  LegacyDraftFinding,
  LegacyReviewRun,
  LegacyReviewRunEvidence,
  LegacyReviewRunSlotAuthority,
  NonEmptyPriorAssessments,
  NonEmptyRefutations,
  PriorFindingAssessment,
  PriorFindingVerdict,
  Refutation,
  RefutedFinding,
  ResolvedFinding,
  ReviewRun,
  ReviewRunEvidence,
  ReviewRunSlotAuthority,
  SlotBoundReviewRunEvidence,
  UnboundReviewRunEvidence,
} from "./core/findings-shape";

export interface RecoveredArtifactWriteEvidence {
  readonly baseline_sha: string;
  readonly packet_id: string;
  readonly packet_path: string;
  readonly modified_paths: readonly string[];
}

declare const NON_EMPTY_NEW_TEST_EVIDENCE: unique symbol;
export type NonEmptyNewTestEvidence = string & { readonly [NON_EMPTY_NEW_TEST_EVIDENCE]: true };

/** One normalized new-test observation. A positive observation cannot exist without evidence. */
export type NewTestEvidence =
  | Readonly<{ kind: "not-written"; written: false; evidence: string }>
  | Readonly<{ kind: "written"; written: true; evidence: NonEmptyNewTestEvidence }>;

/** Compatibility parser for legacy boolean/string evidence pairs. */
export function parseNewTestEvidence(written: unknown, evidence: unknown): NewTestEvidence {
  const text = typeof evidence === "string" ? evidence : "";
  return written === true && text.trim() !== ""
    ? Object.freeze({ kind: "written", written: true, evidence: text as NonEmptyNewTestEvidence })
    : Object.freeze({ kind: "not-written", written: false, evidence: text });
}

/** The canonical absent new-test observation: nothing written, no evidence.
 *  Producers with no transport evidence hand this exact value to the ADT
 *  instead of re-running the legacy pair parser on empty input. */
export const NEW_TEST_EVIDENCE_NOT_WRITTEN: NewTestEvidence =
  Object.freeze({ kind: "not-written", written: false, evidence: "" });

export function parseStoredNewTestEvidence(raw: unknown):
  | Readonly<{ ok: true; value: NewTestEvidence }>
  | Readonly<{ ok: false; error: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return Object.freeze({ ok: false, error: "new_test_observation must be a plain object" });
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "evidence" || keys[1] !== "kind" || keys[2] !== "written") {
    return Object.freeze({ ok: false, error: "new_test_observation must contain exactly evidence, kind, written" });
  }
  if (record.kind === "written" && record.written === true &&
      typeof record.evidence === "string" && record.evidence.trim() !== "") {
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        kind: "written",
        written: true,
        evidence: record.evidence as NonEmptyNewTestEvidence,
      }),
    });
  }
  if (record.kind === "not-written" && record.written === false && typeof record.evidence === "string") {
    return Object.freeze({
      ok: true,
      value: Object.freeze({ kind: "not-written", written: false, evidence: record.evidence }),
    });
  }
  return Object.freeze({ ok: false, error: "new_test_observation tag, written flag, and evidence are contradictory" });
}

/** Persisted Task projection: one optional ADT replaces two independently optional wire fields. */
export type StoredNewTestEvidence = Readonly<{ new_test_observation: NewTestEvidence }>;

export function storedNewTestEvidence(evidence: NewTestEvidence): StoredNewTestEvidence {
  return Object.freeze({ new_test_observation: evidence });
}

interface TaskCommonMetadataBase {
  /** Base fields are `readonly` like the rest: every mutation flows through
   *  StateManager.update's locked transform, which returns a NEW task object.
   *  An in-place assignment on a loaded graph would bypass that transform and
   *  the wave-gate/review invariants it protects. */
  readonly id: string;
  readonly description: string;
  readonly agent: string;
  readonly wave: number;
  readonly depends_on: readonly string[];
  /** Requirement Completion Claims: this Task's Wave must fully satisfy each Requirement. */
  readonly spec_anchors?: readonly string[];
  /** Partial Requirement Contributions; never part of Wave Gate spec-check completion scope. */
  readonly spec_contributions?: readonly string[];
  /**
   * Spec Index content hash per Requirement Completion Claim, recorded by the
   * engine when the Task→Requirement edge was created. Engine-derived, never
   * authored: decompose describes WHICH Requirements a Task completes, and the
   * specification's own bytes decide what those Requirements SAID at that
   * moment. Absent on graphs decomposed before this field existed and on graphs
   * whose spec file did not project during population. A later successful gate
   * projection reports that absence as unverifiable drift; if projection still
   * cannot be established, settlement refuses with `projection-unavailable`.
   */
  readonly spec_anchor_hashes?: Readonly<Record<string, string>>;
  /** Explicit independent regression/new-test policy. New graphs carry this;
   * new_tests_required remains a read-compatible legacy projection. */
  readonly verification_policy?: StoredVerificationPolicy;
  readonly new_tests_required?: boolean;
  /** Exact architecture context selected for this Task by decompose. */
  readonly plan_context?: string;
  /** Files this task creates/modifies (decompose contract); older graphs may lack it */
  readonly file_list?: readonly string[];
  /** Test outcome + trust provenance; absent until an impl agent completes. */
  readonly test_result?: TaskTestResult;
  readonly test_evidence?: string;
  readonly new_test_observation?: NewTestEvidence;
  readonly files_modified?: readonly string[];
  readonly review_status?: ReviewStatus;
  /** Monotonic implementation generation; incremented whenever task bytes change. */
  readonly review_generation?: number;
  /** Packet-bound reviewer batch currently collecting evidence. */
  readonly review_run?: ReviewRun;
  /** Immutable packet/context authority that produced accepted review evidence. */
  readonly accepted_review_authority?: AcceptedReviewAuthority;
  /**
   * Why evidence capture failed. Meaningful ONLY alongside
   * `review_status: "evidence_capture_failed"` — every writer that moves the
   * status off that value clears this field in the same update. It used to
   * survive the transition, so a task could sit at `passed` carrying
   * "CRITICAL_COUNT marker not found…" from a run two reviewers ago.
   */
  readonly review_error?: string;
  /**
   * The reviewers whose transcript could not be parsed, still outstanding.
   *
   * `review_status` is per-TASK but evidence capture fails per-AGENT, and that
   * mismatch was a silent data-loss bug: `/wave-gate` spawns every reviewer in
   * one message, so a later reviewer emitting `CRITICAL_COUNT: 0` overwrote an
   * earlier one's `evidence_capture_failed` with `passed` — the same transcripts
   * producing a different gate outcome depending on completion order, and
   * `checkReviews` advancing the wave. Naming the agents makes the failure
   * SURVIVE a sibling's clean pass and, just as importantly, CLEARABLE: the
   * reviewer that failed re-runs, drops out of this set, and the status leaves
   * `evidence_capture_failed` only once the set is empty. A single sticky
   * boolean would have fixed the loss and dead-ended the operator.
   *
   * Biconditional with the status, proven at the load boundary
   * (`evidenceFailureError`): `review_status === "evidence_capture_failed"` iff
   * this array is present and non-empty. `--fix` repairs a violation by clearing
   * the whole review record — unreviewed also blocks the gate, so the repair
   * fails closed rather than guessing which reviewer broke.
   */
  readonly review_evidence_failures?: readonly string[];
  /**
   * Authoritative review findings: each with a derived id, its emitting agent,
   * and (when the reviewer supplied one) a file/line. This is the field the
   * refutation panel votes on — a k-of-n vote needs items two verifiers can
   * agree they are discussing, which free text cannot provide.
   *
   * `critical_findings` and `advisory_findings` below are DERIVED VIEWS over
   * this array. They remain the fields the wave gate counts and the GH comment
   * prints, so no consumer had to migrate when identity arrived; they can
   * migrate opportunistically.
   *
   * The coordinated writers keep the three in lockstep, and every one of them
   * writes all three together: `sanitizeTask` (the initializer, in
   * core/task-graph-population); `mergeFindings` (legacy/unbound
   * review), `finalizeReviewRun` (packet-bound review),
   * `applyFindingOutcomes` (panel adjudication), and
   * `preserveAcceptedReviewRunFindings` (incomplete-run retirement), all in
   * core/findings; `updateTaskFindings` (the manual operator override) in
   * handlers/helpers/store-review-findings; and `fixTaskFindings` (repair) in
   * handlers/helpers/validate-task-graph. A writer that touched only the views
   * would produce a critical no panel can reach and no gate can clear — and one
   * that touched only the array would produce a critical the gate never counts.
   * `findingsLockstepError` refuses to load either.
   *
   * `readonly` for the same reason `findings` is. The DERIVED fields were the
   * mutable ones, which is exactly backwards: a holder of a `Task` could
   * `push` a claim into a view and break, in place and with no compile error,
   * the invariant a load-boundary check, coordinated writers and a `--fix`
   * repair path all exist to protect. Every producer already returns a fresh
   * array, so nothing had to change but the type.
   */
  readonly findings?: readonly Finding[];
  readonly critical_findings?: readonly string[];
  readonly advisory_findings?: readonly string[];
  /**
   * Findings a refutation panel killed, kept with the verifiers' reasoning
   * instead of deleted. A wrong refutation must stay auditable — a silently
   * dropped critical is indistinguishable from one that was never found.
   */
  readonly refuted_findings?: readonly RefutedFinding[];
  /** Findings that held before code changed and were explicitly verified fixed. */
  readonly resolved_findings?: readonly ResolvedFinding[];
  /** Exact declared-artifact state captured before the implementation agent
   *  starts. Proof compares current bytes to this baseline; transcript tool
   *  calls remain lint targets and cannot vouch that a change occurred. */
  readonly artifact_baseline?: readonly DeclaredArtifactBaseline[];
  /** Active attempt authority remains compatibility-optional on shared metadata.
   * StateManager proves authority/baseline/reservation lockstep; historical
   * attempt 1 may omit context, but semantic attempt 2 may not. */
  readonly active_implementation_attempt?: ImplementationAttemptAuthority;
  /** Exact prompt/retry authority frozen before the active Agent dispatch.
   * Unversioned historical attempts may omit it; every protocol-2 registration requires it. */
  readonly active_implementation_context?: ImplementationAttemptContext;
  readonly attempt_artifact_baseline?: readonly DeclaredArtifactBaseline[];
  readonly attempt_repository_baseline?: readonly DeclaredArtifactBaseline[];
  /** First repository boundary retained until an exact attempt is accepted.
   * Fresh attempts bind to this boundary instead of snapshotting unresolved
   * foreign bytes as their new starting state. */
  readonly repository_baseline?: readonly DeclaredArtifactBaseline[];
  /** Repository-observed unowned paths still different from the retained
   * repository boundary, including paths omitted from transcript evidence.
   * Sibling-owned dirty paths never enter this set. */
  readonly unresolved_repository_paths?: readonly string[];
  readonly reserved_at?: string;
  readonly legacy_execution_reservation?: true;
  /** Engine-issued packet authority retained after a review run closes. A
   * self-hashed packet is integrity evidence, not provenance; historical write
   * recovery accepts a packet only when every registration field matches. */
  readonly issued_review_packets?: readonly IssuedReviewPacketRegistration[];
  /** Historical commit explicitly supplied to the sanctioned recovery helper
   * after a legacy retry overwrote the original baseline. Persisted so the
   * exceptional evidence source remains auditable. */
  readonly artifact_baseline_recovered_from?: string;
  /** Audited immutable Review Packets used to recover cumulative write
   * attribution after a legacy retry replaced files_modified. */
  readonly recovered_artifact_writes?: readonly RecoveredArtifactWriteEvidence[];
  readonly start_sha?: string;
  readonly failure_reason?: string;
  readonly retry_count?: number;
  /** Strict bounded-retry lineage marker. Attempt history REQUIRES protocol-2
   * metadata; there is no read-only compatibility projection — a history
   * without it fails closed at load, and the Task must be re-registered
   * through a modern implementation dispatch (or re-populated). */
  readonly implementation_retry_protocol?: 2;
  readonly implementation_retry_history_start?: number;
  readonly implementation_retry_predecessor_receipt_id?: ImplementationSettlementReceiptId;
  /**
   * Attestation mode: the declared artifacts already carry the completed work,
   * so the dispatched child must prove EXISTING bytes instead of producing new
   * ones. The proof's declared-artifact obligations carry the `attested` arm
   * (satisfied when bytes are unchanged vs the attempt baseline; a write is
   * drift), the stored policy waives new tests, and the child's prompt must
   * bind the engine-derived attestation context. Load-locked: a Task carrying
   * this flag without attested obligations, or obligations without the flag,
   * is refused by the TaskGraph task validator.
   */
  readonly implementation_attestation?: true;
  /** Immutable exact receipts; append-only settlement audit in wire order. */
  readonly implementation_attempt_history?: readonly ImplementationAttemptSettlementReceipt[];
}

export type TaskCommonMetadata = Readonly<TaskCommonMetadataBase>;

/** Existing flat wire fields, represented as a closed lifecycle union. */
export type TaskLifecycle =
  | Readonly<{
      status: "pending";
      proof: PendingTaskProof | FailedTaskProof;
      revalidation_required?: never;
      legacy_missing_proof?: never;
    }>
  | Readonly<{
      status: "pending";
      proof: TaskProof;
      revalidation_required: true;
      legacy_missing_proof?: never;
    }>
  | Readonly<{
      status: "implemented";
      proof: SatisfiedTaskProof;
      revalidation_required?: never;
      legacy_missing_proof?: never;
    }>
  | Readonly<{
      status: "completed";
      proof: SatisfiedTaskProof;
      revalidation_required?: never;
      legacy_missing_proof?: never;
    }>
  | Readonly<{
      status: "failed";
      proof: FailedTaskProof;
      revalidation_required?: never;
      legacy_missing_proof?: never;
    }>
  | Readonly<{
      status: "implemented" | "completed";
      proof?: never;
      revalidation_required?: never;
      /** Protected migration marker; ordinary writers cannot claim modern completion with it. */
      legacy_missing_proof: true;
    }>;

export type Task = Readonly<TaskCommonMetadata & TaskLifecycle>;

// WaveGate + newWaveGate moved to the pure core module core/wave-gate-model
// (re-exported above); the functional core must not pull runtime values from
// this legacy catch-all file.

/**
 * Closed verdict union for spec-check runs, parsed at the store boundaries
 * (store-spec-check helper, store-spec-check-findings hook) — free-text
 * verdicts never reach the gate's typed logic.
 */
export const SPEC_CHECK_VERDICTS = ["PASSED", "BLOCKED", "EVIDENCE_CAPTURE_FAILED", "UNKNOWN"] as const;
export type SpecCheckVerdict = (typeof SPEC_CHECK_VERDICTS)[number];

/** Smart constructor: null when the raw text is not a known verdict. */
export function parseSpecCheckVerdict(raw: string): SpecCheckVerdict | null {
  return (SPEC_CHECK_VERDICTS as readonly string[]).includes(raw) ? (raw as SpecCheckVerdict) : null;
}

interface SpecCheckBase {
  readonly wave: number;
  readonly run_at: string;
}

export type ManualSpecCheckEvidenceSource = Readonly<{
  kind: "manual-override";
  reason: string;
}>;

/**
 * Captured evidence is complete: count/view lockstep is established at
 * construction. Registered and historical captures need no duplicate source
 * field because their Wave epoch is the authority; a manual bypass always
 * carries its attributable reason in the evidence itself.
 */
export type CapturedSpecCheckVerdict = Extract<SpecCheckVerdict, "PASSED" | "BLOCKED">;

declare const CAPTURED_SPEC_CHECK: unique symbol;

export type CapturedSpecCheck = Readonly<SpecCheckBase & {
  /** Nominal constructor-origin witness; only core/spec-check mints this type. */
  readonly [CAPTURED_SPEC_CHECK]: true;
  verdict: CapturedSpecCheckVerdict;
  critical_count: number;
  high_count: number;
  /** `readonly` for the reason `Task.critical_findings` is: a holder that can
   *  `push` into a findings view mutates gate input in place, with no compile
   *  error at the site that did it. */
  critical_findings: readonly string[];
  high_findings: readonly string[];
  medium_findings: readonly string[];
  error?: never;
} & (
  | Readonly<{ evidence_source?: never }>
  | Readonly<{ evidence_source: ManualSpecCheckEvidenceSource }>
)>;

/**
 * Why a spec-check capture failed, as a closed set rather than prose.
 *
 * `transcript` is a capture the harness could not read or whose footer does not
 * parse, and is the only re-applyable arm. `settled-floor` means a parsed report
 * omitted engine-settled findings. `projection-unavailable` means no structural
 * projection could be proved, which is an absence of evidence and therefore a
 * decided refusal. The `error` string is for operators; control flow branches
 * only on this closed cause.
 */
export type SpecCheckEvidenceFailureCause =
  | "transcript"
  | "settled-floor"
  | "projection-unavailable";

/** A failed capture carries a cause and cannot masquerade as usable counts. */
export type EvidenceFailedSpecCheck = Readonly<SpecCheckBase & {
  verdict: "EVIDENCE_CAPTURE_FAILED";
  error: string;
  cause: SpecCheckEvidenceFailureCause;
  critical_count?: never;
  high_count?: never;
  critical_findings?: never;
  high_findings?: never;
  medium_findings?: never;
}>;

export type SpecCheck = CapturedSpecCheck | EvidenceFailedSpecCheck;

// --- Protected Wave Gate registration and canonical status read model ---

/**
 * The sole protected reference to an active Wave Gate Run Directory program.
 * Run-directory progress is inert until this parser-proven registration is
 * atomically installed through StateManager.
 */
export type ActiveWaveGateTerminalOutcome =
  | Readonly<{ kind: "done"; outcome: ArtifactRef }>
  | Readonly<{ kind: "terminal-blocked"; diagnostic: TerminalBlockedDiagnostic }>
  /** The operator's terminal decision recorded by `helper orchestration abandon`.
   *  Fields mirror the run directory's immutable abandonment marker exactly —
   *  no invented timestamp — so the state stamp and the on-disk marker can
   *  never disagree about why the run ended or what replaced it. A tombstoned
   *  registration is no longer active authority: `start` supersedes it, while
   *  the spec-trace retirement flow can still prove the run from it. */
  | Readonly<{ kind: "terminal-abandoned"; reason: string; supersededBy: OrchestrationRunId | null }>;

type ProtectedWaveGateRegistrationBase = Readonly<{
  schemaVersion: 1;
  kind: "active-wave-gate";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  /** Absolute authoritative parent of this run. Absent only on registrations
   * created before directory authority was persisted. */
  runsRoot?: string;
}>;

/** Live authority and retained terminal audit are distinct states. */
export type LiveWaveGateRegistration = Readonly<ProtectedWaveGateRegistrationBase & {
  terminalOutcome: null;
}>;

export type RetiredWaveGateRegistration = ActiveWaveGateTerminalOutcome extends infer Outcome
  ? Outcome extends ActiveWaveGateTerminalOutcome
    ? Readonly<ProtectedWaveGateRegistrationBase & {
        /** A retained terminal registration is audit only, never live authority. */
        terminalOutcome: Outcome;
      }>
    : never
  : never;

export type ActiveWaveGateRegistration = LiveWaveGateRegistration | RetiredWaveGateRegistration;

type CompletedWaveGateRegistrationCommon = Readonly<{
  kind: "completed-wave-gate";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  completionReceipt: ProtectedWaveStateCommitted;
}>;

/** Terminal audit is not active authority for the newly-current Wave. Schema
 * v1 is the exact historical shape; schema v2 additionally archives the suite
 * receipt that authorized the terminal transition. */
export type CompletedWaveGateRegistration =
  | Readonly<CompletedWaveGateRegistrationCommon & {
      schemaVersion: 1;
    }>
  | Readonly<CompletedWaveGateRegistrationCommon & {
      schemaVersion: 2;
      completionSuite: AcceptedWaveCompletionReceipt;
    }>;

/** Immutable audit of a completed Wave reopened because exact workspace
 * bytes drifted, or because legacy completion authority could not prove those
 * bytes. This is completed-Wave history; orphaned active-run replacement is
 * modeled separately by `OrphanedWaveGateRetirement`. */
export type WaveReopeningAudit = Readonly<{
  schemaVersion: 1;
  kind: "completed-wave-reopened-for-review-integrity";
  /** Exact bytes were compared, or historical authority could not prove them. */
  proofMode: "modern-exact-workspace-drift" | "legacy-workspace-authority-unverifiable";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  completionReceipt: ProtectedWaveStateCommitted;
  /** Reopened Tasks; legacy authority never labels these as proven drift. */
  reopenedTaskIds: readonly string[];
}>;

export type OrphanedWaveGateRetirement = Readonly<{
  schemaVersion: 1;
  kind: "orphaned-wave-gate-retirement";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  reason: "authoritative-run-directory-missing";
  runsRoot: string;
  runDirectory: string;
  replacementRunId: OrchestrationRunId;
  replacementAuthorityDigest: ArtifactDigest;
}>;

/** Immutable audit of the exceptional trace-v2 migration that retired an
 * operator-abandoned Wave Gate. It records the old authority; it is neither
 * completed Wave history nor orphan recovery. */
export type SpecTraceWaveGateRetirement = Readonly<{
  schemaVersion: 1;
  kind: "spec-trace-wave-gate-retirement";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  runsRoot: string;
  reason: string;
  supersededBy: OrchestrationRunId | null;
}>;

export type StatusFact<T> =
  | Readonly<{ kind: "known"; value: T }>
  | Readonly<{ kind: "unavailable"; reasons: OrchestrationNonEmpty<StatusReason> }>;

export type StatusReasonKind =
  | "authority-unavailable"
  | "authority-contradiction"
  | "task-running"
  | "proof-failed"
  | "tests-not-ready"
  | "review-roster-gap"
  | "review-evidence-failure"
  | "refutation-required"
  | "advisory-decision-required"
  | "review-spawn-required"
  | "blocked-diagnostic"
  | "engine-resume-required"
  | "wave-implementation-pending"
  | "implementation-escalation-required"
  | "wave-gate-not-started"
  | "run-complete"
  | "completion-prerequisite-failed"
  | "completion-eligible"
  | "wave-gate-ready";

export type StatusReason = Readonly<{
  kind: StatusReasonKind;
  message: string;
  taskId: string | null;
}>;

export type StatusTaskCounts = Readonly<{
  pending: number;
  running: number;
  implemented: number;
  blocked: number;
  completed: number;
}>;

export type FailedProofObligation = Readonly<{
  taskId: string;
  failure: import("./core/proof-obligations").ProofFailure;
}>;

export type TestReadinessIssue = Readonly<{
  taskId: string;
  reasons: OrchestrationNonEmpty<string>;
}>;

export type TestReadiness =
  | Readonly<{ kind: "ready"; affectedTasks: readonly [] }>
  | Readonly<{ kind: "not-ready"; affectedTasks: OrchestrationNonEmpty<TestReadinessIssue> }>;

export type ReviewRosterGap = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  agent: string;
}>;

export type ReviewEvidenceFailure = Readonly<{
  taskId: string;
  generation: number | null;
  packetId: string | null;
  agent: string;
  error: string;
}>;

export type FindingCounts = Readonly<{
  /** Active blocking critical Findings only; advisories are counted separately. */
  activeCritical: number;
  advisory: number;
  resolved: number;
  refuted: number;
}>;

export type RefutationPanelNeed =
  | Readonly<{
      kind: "needed";
      findingIds: OrchestrationNonEmpty<string>;
      reasons: OrchestrationNonEmpty<string>;
    }>
  | Readonly<{
      kind: "not-needed";
      findingIds: readonly [];
      reasons: OrchestrationNonEmpty<string>;
    }>;

export type WaveGateCompletionEligibility =
  | Readonly<{ kind: "eligible"; failedPrerequisites: readonly [] }>
  | Readonly<{ kind: "ineligible"; failedPrerequisites: OrchestrationNonEmpty<string> }>;

/** A shell observation of the current Git-visible Wave workspace. The core
 * compares it with accepted suite authority and never performs repository I/O. */
export type WaveWorkspaceObservation =
  | Readonly<{ kind: "observed"; workspaceDigest: ArtifactDigest }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** A shell observation of the exact persisted completion result for the
 * current active Wave authority. Absence is ordinary; unreadable or malformed
 * bytes are unavailable and retain their cause. */
export type WaveCompletionResultObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "observed"; result: WaveCompletionSuiteResult }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type WaveCompletionSuiteRequiredReason =
  | "accepted-suite-missing"
  | "accepted-suite-invalid"
  | "completion-result-invalid"
  | "completion-result-unavailable"
  | "workspace-observation-missing"
  | "workspace-observation-unavailable";

/** Canonical completion-suite status. Digest/count data is carried by the
 * status value so JSON and human renderers remain policy-free projections. */
export type WaveCompletionSuiteReadiness =
  | Readonly<{
      kind: "legacy-unavailable";
      verificationManifestDigest: null;
    }>
  | Readonly<{
      kind: "required";
      projectVerificationCoverage: ProjectVerificationCoverage;
      reason: WaveCompletionSuiteRequiredReason;
      detail: string;
      verificationManifestDigest: ArtifactDigest | null;
      acceptedResultDigest: ArtifactDigest | null;
    }>
  | Readonly<{
      kind: "accepted";
      projectVerificationCoverage: ProjectVerificationCoverage;
      verificationManifestDigest: ArtifactDigest | null;
      suiteDigest: ArtifactDigest;
      resultDigest: ArtifactDigest;
      workspaceDigest: ArtifactDigest;
      checkCount: number;
    }>
  | Readonly<{
      kind: "rejected";
      projectVerificationCoverage: ProjectVerificationCoverage;
      verificationManifestDigest: ArtifactDigest;
      suiteDigest: ArtifactDigest;
      workspaceDigest: ArtifactDigest;
      failureKinds: OrchestrationNonEmpty<CompletionSemanticFailure["kind"]>;
      checkIds: OrchestrationNonEmpty<CompletionCheckId>;
    }>
  | Readonly<{
      kind: "stale";
      projectVerificationCoverage: ProjectVerificationCoverage;
      verificationManifestDigest: ArtifactDigest | null;
      suiteDigest: ArtifactDigest;
      resultDigest: ArtifactDigest;
      acceptedWorkspaceDigest: ArtifactDigest;
      currentWorkspaceDigest: ArtifactDigest;
      checkCount: number;
    }>;

export type CanonicalStatusFacts = Readonly<{
  location: StatusFact<Readonly<{ activePhase: Phase; activeWave: number | null }>>;
  tasks: StatusFact<Readonly<{ counts: StatusTaskCounts }>>;
  failedProofObligations: StatusFact<readonly FailedProofObligation[]>;
  testReadiness: StatusFact<TestReadiness>;
  reviewRuns: StatusFact<Readonly<{
    rosterGaps: readonly ReviewRosterGap[];
    evidenceFailures: readonly ReviewEvidenceFailure[];
  }>>;
  findingCounts: StatusFact<FindingCounts>;
  refutationPanelNeed: StatusFact<RefutationPanelNeed>;
  waveCompletionSuiteReadiness: StatusFact<WaveCompletionSuiteReadiness>;
  waveGateCompletionEligibility: StatusFact<WaveGateCompletionEligibility>;
}>;

export type WaveGateProtectedSnapshotBinding = Readonly<{
  runId: OrchestrationRunId;
  registrationRevision: number;
  authorityDigest: ArtifactDigest;
  readinessDigest: ArtifactDigest;
  lifecycleCheckpointDigest: ArtifactDigest;
}>;

/** Lifecycle-issued action authority. Every arm carries the complete protected
 * snapshot identity so a same-run proof cannot cross a registration revision,
 * readiness derivation, or durable lifecycle checkpoint. */
export type WaveGateNextAction =
  | Readonly<{ kind: "review-batch"; lifecycle: "preparing" | "awaiting-review-results"; action: SpawnBatchAction; binding: WaveGateProtectedSnapshotBinding }>
  | Readonly<{ kind: "advisory-decision"; lifecycle: "awaiting-advisory-decision"; action: AwaitUserAction; binding: WaveGateProtectedSnapshotBinding }>
  | Readonly<{ kind: "blocked"; lifecycle: "recoverable-blocked" | "terminal-blocked"; action: BlockedAction; binding: WaveGateProtectedSnapshotBinding }>
  | Readonly<{ kind: "completed"; lifecycle: "done"; action: DoneAction; binding: WaveGateProtectedSnapshotBinding }>;

/** A registered program can be temporarily unable to expose its next semantic
 * action until the engine replays its checkpoint. Status calls it registered,
 * not healthy: health additionally requires a shell proof that the authoritative
 * Run Directory still exists. */
export type EngineResumeDiagnostic = Readonly<{
  kind: "engine-resume-required";
  category: "registered-run-suspended";
  runId: OrchestrationRunId;
  message: string;
  retry: Readonly<{
    kind: "engine-resume";
    eligible: true;
    consumesSemanticAttempt: false;
  }>;
  recovery: Readonly<{
    kind: "resume-orchestration";
    runId: OrchestrationRunId;
  }>;
}>;

export type EngineResumeAction = Readonly<{
  kind: "blocked";
  runId: OrchestrationRunId;
  diagnostic: EngineResumeDiagnostic;
}>;

/** One exact implementation spawn instruction derived from protected history. */
export type WaveImplementationDispatch =
  | Readonly<{
      kind: "initial-implementation";
      taskId: string;
      semanticAttempt: 1;
      promptAppendix: string | null;
    }>
  | Readonly<{
      kind: "retry-implementation";
      taskId: string;
      semanticAttempt: 2;
      promptAppendix: string;
    }>;

/** What the orchestrator owes to leave the implementation window. */
export type WaveImplementationRecovery =
  | Readonly<{
      kind: "spawn-wave-implementation";
      wave: number;
      dispatches: OrchestrationNonEmpty<WaveImplementationDispatch>;
    }>
  | Readonly<{
      kind: "await-wave-implementation";
      wave: number;
      activeTaskIds: OrchestrationNonEmpty<string>;
    }>
  | Readonly<{
      kind: "escalate-wave-implementation";
      wave: number;
      tasks: OrchestrationNonEmpty<Readonly<{
        taskId: string;
        receiptId: string;
        failureKinds: OrchestrationNonEmpty<string>;
      }>>;
    }>
  | Readonly<{ kind: "start-wave-gate"; wave: number }>;

/** An execute Wave holds no Wave Gate registration between entering the Wave
 * and starting its gate. Healthy implementation work is retryable; exhausted
 * attempt-2 authority is a separate terminal escalation arm. */
export type WaveImplementationDiagnostic =
  | Readonly<{
      kind: "wave-gate-not-started";
      category: "healthy-wave-unstarted";
      runId: OrchestrationRunId;
      message: string;
      retry: Readonly<{
        kind: "advance-wave-lifecycle";
        eligible: true;
        consumesSemanticAttempt: false;
      }>;
      recovery: Exclude<WaveImplementationRecovery, { kind: "escalate-wave-implementation" }>;
    }>
  | Readonly<{
      kind: "implementation-escalation-required";
      category: "semantic-attempts-exhausted";
      runId: OrchestrationRunId;
      message: string;
      retry: Readonly<{
        kind: "advance-wave-lifecycle";
        eligible: false;
        consumesSemanticAttempt: false;
      }>;
      recovery: Extract<WaveImplementationRecovery, { kind: "escalate-wave-implementation" }>;
    }>;

export type WaveImplementationAction = Readonly<{
  kind: "blocked";
  runId: OrchestrationRunId;
  diagnostic: WaveImplementationDiagnostic;
}>;

export type NextActionDecision = Readonly<{
  /** Exactly one of the fixed four transport tags. `blocked` is a transport
   * tag: engine resume and healthy implementation actions are retryable, while
   * implementation escalation is terminal with `retry.eligible: false`. */
  action: WaveGateNextAction["action"] | EngineResumeAction | WaveImplementationAction;
  reasons: OrchestrationNonEmpty<StatusReason>;
}>;

export type LoomStatus = Readonly<{
  schemaVersion: 1;
  facts: CanonicalStatusFacts;
  next: NextActionDecision;
}>;

export type WaveSpecCheckSlotAuthority = Readonly<{
  readonly slot_id: string;
  readonly attempted: 1 | 2;
}>;

export type WaveSpecCheckDocumentAuthority =
  | Readonly<{ path: null; contentDigest: null }>
  | Readonly<{ path: string; contentDigest: ArtifactDigest }>;

export type WaveSpecCheckDocumentsAuthority = Readonly<{
  readonly spec: WaveSpecCheckDocumentAuthority;
  readonly plan: WaveSpecCheckDocumentAuthority;
}>;

export interface WaveReviewEpochAuthority {
  readonly runId: OrchestrationRunId;
  readonly wave: number;
  readonly batchEpoch: ArtifactDigest;
  /** Exact spec/plan paths and bytes. Absent only on historical epochs. */
  readonly specCheckDocuments?: WaveSpecCheckDocumentsAuthority;
  /** Exact spec-check slot attempt issued for this epoch. Absent on historical
   * epochs and while modern task-attempt invalidation awaits reissuance; exact
   * recovery refuses to infer it from evidence. */
  readonly specCheckSlotAuthority?: WaveSpecCheckSlotAuthority;
  /**
   * The exact settled CRITICAL authority rendered into this epoch's spec-check
   * packet: current epochs carry both count and Finding identities; historical
   * epochs may carry count only.
   *
   * Recorded at installation because it is the ONLY authority the Agent was
   * actually shown. Re-projecting it at capture time reads `spec_anchor_hashes`
   * and out-of-Wave `spec_anchors` that no epoch digest covers, so enforcement
   * could drift from the packet. Absent on epochs installed before any floor
   * existed; `epochSettledFloor` maps that absence to stated unavailability.
   */
  readonly settledSpecCheckFloor?: SettledFloor;
}

export interface TaskGraph {
  /** Absent only on legacy completion-only graphs; every fresh graph uses v2. */
  readonly spec_trace_version?: 2;
  readonly current_phase: Phase;
  /** Readonly like `tasks`: every mutation must flow through StateManager.update's locked transform. */
  readonly phase_artifacts: Readonly<Partial<Record<Phase, string>>>;
  readonly skipped_phases: readonly Phase[];
  readonly spec_dir?: string | null;
  readonly spec_file: string | null;
  /** Compact identity/reason from the exact Spec Index observation used when
   * Tasks and Requirement Content Hashes were populated. Absent on legacy
   * graphs; never contains the derived ParsedSpec itself. */
  readonly spec_index_observation?: SpecIndexObservation;
  readonly plan_file: string | null;
  readonly plan_title?: string;
  /** `readonly` for the same reason `Task.findings` is: every producer already
   *  returns a fresh array, and an in-place `push`/`sort` on the task list is a
   *  state mutation that bypasses `StateManager.update`'s locked transform. */
  readonly tasks: readonly Task[];
  readonly current_wave?: number;
  readonly executing_tasks?: readonly string[];
  /** Readonly like `tasks`: wave gates are derived per wave and every writer
   *  replaces the record (or a gate) with a fresh object through
   *  StateManager.update's locked transform. A holder of the graph must not be
   *  able to mutate a gate — or add a gate — in place and bypass that. */
  readonly wave_gates: Readonly<Record<string, WaveGate>>;
  readonly github_issue?: number;
  readonly github_repo?: string;
  readonly spec_check?: SpecCheck;
  /** Exact current Wave review batch epoch, shared by reviewer and spec-check slots. */
  readonly wave_review_epoch?: WaveReviewEpochAuthority;
  /** Operator-owned verification authority frozen before implementation begins. */
  readonly verification_manifest?: FrozenVerificationManifest;
  /** Accepted quiescent-Wave result bound to the exact active registration. */
  readonly active_wave_completion_suite?: AcceptedWaveCompletionReceipt;
  /** Parser-proven protected registration; absent until a Wave Gate is explicitly registered. */
  readonly active_wave_gate?: ActiveWaveGateRegistration;
  /** Immutable terminal registrations, separate from authority for the next Wave. */
  readonly wave_gate_history?: readonly CompletedWaveGateRegistration[];
  /** Immutable audit of a completed Wave reopened after modern byte proof or legacy authority loss. */
  readonly wave_reopening_history?: readonly WaveReopeningAudit[];
  /** Nonterminal retirement audit for missing Run Directories replaced in-place. */
  readonly orphaned_wave_gate_history?: readonly OrphanedWaveGateRetirement[];
  /** Abandoned active authority retired only to install Requirement trace v2. */
  readonly spec_trace_wave_gate_retirements?: readonly SpecTraceWaveGateRetirement[];
  readonly updated_at?: string;
}

// ---------------------------------------------------------------------------
// Plan executable-model declarations
// ---------------------------------------------------------------------------
//
// These are pure data shapes describing what a plan DECLARED, not how it is
// parsed. They live here rather than in `parsers/parse-plan-models.ts` because
// both the producer (that parser) and a consumer in the functional core
// (`core/wave-gate-machine.ts`, which binds lifecycle artifacts to a wave) need
// them. Keeping them in the parser forced core to import across a denied
// boundary for a type-only dependency; keeping them here lets the arrow point
// at shared data instead. `parse-plan-models.ts` re-exports them, so its
// public surface is unchanged.

export type InvariantTier = "checkable" | "advisory";

/**
 * The three states a `**Tier:**` line can be in: absent, recognized, or
 * present-but-unrecognized. The old `InvariantTier | null` conflated absent
 * with unrecognized — a consumer that wanted to say which failure it was
 * looking at had no way to know.
 */
export type PlanInvariantTier =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly tier: InvariantTier }
  | { readonly status: "unrecognized"; readonly raw: string };

/** Model sections that carry `### ` id-blocks. */
export type BlockSection = "Lifecycles" | "Invariants";

/** All canonical model sections. */
export type ModelSection = BlockSection | "Pipeline";

/**
 * A near-miss or misplaced model marker. Each variant carries the context
 * needed to explain itself (`renderStray`); validation treats ANY stray as
 * an error — a typo must never read as an opt-out.
 */
export type Stray =
  | { readonly kind: "unterminated-fence" }
  | { readonly kind: "empty-section"; readonly section: BlockSection }
  | { readonly kind: "near-miss-heading"; readonly heading: string }
  | {
      readonly kind: "bad-block-grammar";
      readonly heading: string;
      readonly section: BlockSection;
      readonly prefix: "LC" | "INV";
    }
  | { readonly kind: "misplaced-heading"; readonly heading: string; readonly home: BlockSection }
  | { readonly kind: "misplaced-label"; readonly label: string; readonly home: ModelSection };

export interface PlanLifecycle {
  /** e.g. "LC-1" */
  readonly id: string;
  readonly title: string;
  /** Path from the `**Machine file:**` line; null when the line is missing */
  readonly machineFile: string | null;
}

export interface PlanPipeline {
  /** Path from the `**AuthoredDag:**` line; null when the line is missing */
  readonly dagFile: string | null;
  /** Node names from the first column of the Pipeline section's node table
   *  (header/separator rows skipped); empty when the section has no table.
   *  Cross-checked against the sidecar to catch plan↔sidecar drift. */
  readonly declaredNodes: readonly string[];
}

export interface PlanInvariant {
  /** e.g. "INV-1" */
  readonly id: string;
  readonly title: string;
  /** The `**Tier:**` line, three-state: absent, recognized, or unrecognized */
  readonly tier: PlanInvariantTier;
  /** Path from the `**Rule file:**` line; null when the line is missing */
  readonly ruleFile: string | null;
}

export interface PlanModels {
  readonly lifecycles: readonly PlanLifecycle[];
  readonly pipeline: PlanPipeline | null;
  readonly invariants: readonly PlanInvariant[];
  /**
   * Near-miss / misplaced model markers: section headings that almost match
   * (`## Lifecycles:`, `## Pipelines`), `###` blocks inside a model section
   * that don't match the block grammar (`### INV-A1:`, `### lc-1:`, missing
   * colon), LC/INV headings outside their sections, and model field labels
   * (`**Machine file:**` etc.) outside their sections. Each entry is a
   * discriminated Stray carrying its context; render with `renderStray`.
   * Any stray means the plan tried to declare a model and failed —
   * validation must error, not skip.
   */
  readonly strays: readonly Stray[];
}
