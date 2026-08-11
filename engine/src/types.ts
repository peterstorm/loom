/**
 * Core types for loom hook handlers
 */

import { match } from "ts-pattern";
import type { TaskProof } from "./core/proof-obligations";
import type { DeclaredArtifactBaseline } from "./core/artifact-baseline";
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
  | { kind: "passthrough" };

/** Defense-in-depth: collapse empty diagnostic messages to a sentinel so
 *  a silent error/block can never reach the user. Used at the cli exit boundary. */
export function nonEmptyMessage(s: string | undefined | null): string {
  return s && s.trim() !== "" ? s : "<no message provided>";
}

/** Smart constructors — preferred over object literals so callers funnel through nonEmptyMessage. */
export const allowResult = (): HookResult => ({ kind: "allow" });
/** Allow the call, but tell the operator something. See `HookResult.allow`. */
export const allowWithNotice = (systemMessage: string): HookResult => ({
  kind: "allow",
  systemMessage: nonEmptyMessage(systemMessage),
});
export const passthroughResult = (): HookResult => ({ kind: "passthrough" });
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
}

// --- Task Graph state ---

/** Phase ordering — the const tuple is the single source of truth so both
 *  the `Phase` type and config's PHASE_ORDER derive from it (dropping a phase
 *  can't leave the type wider than what parseTaskGraph proves against). */
export const PHASES = [
  "init", "brainstorm", "specify", "clarify", "architecture", "plan-alignment", "decompose", "execute",
] as const;
export type Phase = (typeof PHASES)[number];

/** Task status values — the const tuple is the source of truth so parsers
 *  (parseTaskGraph) can prove disk values against it. */
export const TASK_STATUSES = ["pending", "implemented", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_STATUSES = ["pending", "passed", "blocked", "evidence_capture_failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Per-task test outcome with its trust provenance IN the data. Trusted
 * verdicts come from the evidence ledger (real exit status cross-checked
 * against a parsed report artifact) and need no qualifier; an untrusted
 * verdict carries what the low-trust source claimed (`passed`) and a label
 * naming exactly how weak that source is. An independent boolean pair
 * would permit the impossible {passed: true, trusted: false → "trusted"?}
 * drift — this shape does not.
 */
export type TaskTestResult =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | { readonly verdict: "untrusted"; readonly passed: boolean; readonly label: string };

/** Did the task's test evidence show a pass at ANY trust level? (Gate checks
 *  that need trust must match on `verdict` instead.) */
export function testResultPassed(result: TaskTestResult | undefined): boolean {
  if (result === undefined) return false;
  return match(result)
    .with({ verdict: "trusted-pass" }, () => true)
    .with({ verdict: "trusted-fail" }, () => false)
    .with({ verdict: "untrusted" }, ({ passed }) => passed)
    .exhaustive();
}

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
// The finding SHAPES live here, with `Task`, because this module is the schema
// root: every other module may depend on it and it depends on none of them.
// They used to be declared in core/findings and imported back, which made
// types.ts and core/findings mutually dependent — harmless only for as long as
// both directions stayed `import type`. core/findings still OWNS the finding
// aggregate (minting identity, proving lockstep, the two review-path writers)
// and re-exports these so no import site had to move.

/** Severity tuple — the source of truth `parseFindingSeverity` proves against. */
export const FINDING_SEVERITIES = ["critical", "advisory"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * A finding exactly as a reviewer emitted it: a claim, a severity, and an
 * optional location. Deliberately carries NO identity — see core/findings.
 */
export interface DraftFinding {
  readonly severity: FindingSeverity;
  /** Repo-relative path the claim concerns, or null when the reviewer gave none. */
  readonly file: string | null;
  /** 1-based line, or null. */
  readonly line: number | null;
  /** The single assertion a verifier will try to refute. */
  readonly claim: string;
}

/** A draft plus derived identity. Only `attributeFindings` produces these. */
export interface Finding extends DraftFinding {
  /** `${agent}-${ordinal}`, derived — never agent-chosen. */
  readonly id: string;
  /** The review agent that emitted the claim (namespace already stripped). */
  readonly agent: string;
  /** Implementation generation whose immutable Review Packet produced this finding. */
  readonly review_generation?: number;
  /** Canonical Review Packet identity; absent only on legacy findings. */
  readonly review_packet_id?: string;
}

export const PRIOR_FINDING_VERDICTS = ["resolved_by_remediation", "still_present"] as const;
export type PriorFindingVerdict = (typeof PRIOR_FINDING_VERDICTS)[number];

/** One reviewer's explicit assessment of one finding that pre-dates the run. */
export interface PriorFindingAssessment {
  readonly finding_id: string;
  readonly verdict: PriorFindingVerdict;
  readonly reason: string;
}

/** Evidence staged by one reviewer. It is not activated until the whole run completes. */
export interface ReviewRunEvidence {
  readonly agent: string;
  readonly prior_assessments: readonly PriorFindingAssessment[];
  readonly new_findings: readonly DraftFinding[];
}

/** Engine-issued semantic-slot authority for one member of an active Review
 * Run. Legacy runs may omit this field, but exact-slot Wave recovery refuses
 * such runs rather than accepting caller-authored attempt evidence. */
export interface ReviewRunSlotAuthority {
  readonly agent: string;
  readonly slot_id: string;
  readonly attempted: 1 | 2;
}

/**
 * In-progress, packet-bound review run. Every expected reviewer must cover every
 * prior finding exactly once before any prior finding can leave the active set.
 */
export interface ReviewRun {
  readonly generation: number;
  readonly packet_id: string;
  readonly head_sha: string;
  readonly expected_agents: readonly [string, ...string[]];
  readonly prior_finding_ids: readonly string[];
  readonly evidence: readonly ReviewRunEvidence[];
  /** Present on engine-owned Wave runs; ordered exactly like expected_agents. */
  readonly slot_authority?: readonly [ReviewRunSlotAuthority, ...ReviewRunSlotAuthority[]];
}

export interface FindingResolutionAssessment extends PriorFindingAssessment {
  readonly agent: string;
}

export type NonEmptyPriorAssessments = readonly [
  FindingResolutionAssessment,
  ...FindingResolutionAssessment[],
];

/** Why a previously valid finding left the active set after implementation. */
export interface FindingResolution {
  readonly kind: "resolved_by_remediation";
  readonly generation: number;
  readonly packet_id: string;
  readonly head_sha: string;
  readonly expected_agents: readonly [string, ...string[]];
  readonly assessments: NonEmptyPriorAssessments;
}

/** A remediated finding, kept separately from findings a panel proved false. */
export interface ResolvedFinding {
  readonly finding: Finding;
  readonly resolution: FindingResolution;
}

/**
 * One verifier's refutation: the lens that voted to kill a finding, and why.
 *
 * A pair, not two positionally-aligned arrays. The parallel-array form let a
 * lens list and a reason list disagree in length, which no reader could detect
 * and only a runtime check in the parser could reject; here the misalignment is
 * unrepresentable.
 *
 * `lens` is the open string form on purpose: a refutation record OUTLIVES the
 * lens table that produced it, and a stored audit trail must not become
 * unreadable because a lens was later renamed or retired.
 */
export interface Refutation {
  readonly lens: string;
  readonly reason: string;
}

/**
 * One or more refutations.
 *
 * A refuted finding always has at least one — `tallyRefutations` destructures
 * `[head, ...tail]` at the vote site specifically to establish it, and
 * `parseStoredRefutation` rejects an empty list on the way back in. The
 * invariant was proven on write and on read and then forgotten by the type in
 * between, so `RefutedFinding` documented in a comment what `AdjudicatedFinding`
 * and `FindingOutcome` already express. It lives here rather than in
 * `core/findings` because the stored shape is what needs it: `types.ts` cannot
 * import `core/findings`, which imports `types.ts`.
 */
export type NonEmptyRefutations = readonly [Refutation, ...Refutation[]];

/**
 * A finding a refutation panel killed, together with why.
 *
 * Recorded, never deleted: a wrong refutation is a shipped bug, and a silently
 * dropped critical finding is indistinguishable from one that was never found.
 */
export interface RefutedFinding {
  readonly finding: Finding;
  /** The lenses that refuted it, with their reasoning, in lens order. */
  readonly refutations: NonEmptyRefutations;
}

export interface IssuedReviewPacketRegistration {
  readonly task_id: string;
  readonly packet_id: string;
  readonly packet_path: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly scope: readonly string[];
}

export interface RecoveredArtifactWriteEvidence {
  readonly baseline_sha: string;
  readonly packet_id: string;
  readonly packet_path: string;
  readonly modified_paths: readonly string[];
}

export interface Task {
  id: string;
  description: string;
  agent: string;
  wave: number;
  status: TaskStatus;
  depends_on: readonly string[];
  spec_anchors?: readonly string[];
  new_tests_required?: boolean;
  /** Exact architecture context selected for this Task by decompose. */
  plan_context?: string;
  /** Engine-authored proof aggregate. New graphs always carry it. */
  proof?: TaskProof;
  /** Files this task creates/modifies (decompose contract); older graphs may lack it */
  file_list?: readonly string[];
  /** Test outcome + trust provenance; absent until an impl agent completes. */
  test_result?: TaskTestResult;
  test_evidence?: string;
  new_tests_written?: boolean;
  new_test_evidence?: string;
  files_modified?: readonly string[];
  review_status?: ReviewStatus;
  /** Monotonic implementation generation; incremented whenever task bytes change. */
  review_generation?: number;
  /** Packet-bound reviewer batch currently collecting evidence. */
  review_run?: ReviewRun;
  /**
   * Why evidence capture failed. Meaningful ONLY alongside
   * `review_status: "evidence_capture_failed"` — every writer that moves the
   * status off that value clears this field in the same update. It used to
   * survive the transition, so a task could sit at `passed` carrying
   * "CRITICAL_COUNT marker not found…" from a run two reviewers ago.
   */
  review_error?: string;
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
  review_evidence_failures?: readonly string[];
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
   * Exactly six writers keep the three in lockstep, and every one of them
   * writes all three together: `sanitizeDecomposedTask` (the initializer, in
   * handlers/helpers/populate-task-graph); `mergeFindings` (legacy/unbound
   * review), `finalizeReviewRun` (packet-bound review), and
   * `applyFindingOutcomes` (the panel adjudicated), all in core/findings;
   * `updateTaskFindings` (the manual operator override) in
   * handlers/helpers/store-review-findings; and `fixTaskFindings` (repair) in
   * handlers/helpers/validate-task-graph. A writer that touched only the views
   * would produce a critical no panel can reach and no gate can clear — and one
   * that touched only the array would produce a critical the gate never counts.
   * `findingsLockstepError` refuses to load either.
   *
   * `readonly` for the same reason `findings` is. The DERIVED fields were the
   * mutable ones, which is exactly backwards: a holder of a `Task` could
   * `push` a claim into a view and break, in place and with no compile error,
   * the invariant a load-boundary check, six coordinated writers and a `--fix`
   * repair path all exist to protect. Every producer already returns a fresh
   * array, so nothing had to change but the type.
   */
  findings?: readonly Finding[];
  critical_findings?: readonly string[];
  advisory_findings?: readonly string[];
  /**
   * Findings a refutation panel killed, kept with the verifiers' reasoning
   * instead of deleted. A wrong refutation must stay auditable — a silently
   * dropped critical is indistinguishable from one that was never found.
   */
  refuted_findings?: readonly RefutedFinding[];
  /** Findings that held before code changed and were explicitly verified fixed. */
  resolved_findings?: readonly ResolvedFinding[];
  /** Exact declared-artifact state captured before the implementation agent
   *  starts. Proof compares current bytes to this baseline; transcript tool
   *  calls remain lint targets and cannot vouch that a change occurred. */
  artifact_baseline?: readonly DeclaredArtifactBaseline[];
  /** Exact declared and previously-attributed artifact state captured
   * immediately before the current implementation attempt. Unlike
   * artifact_baseline, this advances on every accepted retry so byte changes
   * from that attempt invalidate older evidence even when current transcript
   * tool attribution is missing. */
  attempt_artifact_baseline?: readonly DeclaredArtifactBaseline[];
  /** Compact snapshot of every Git-visible dirty path immediately before the
   * current implementation attempt. Comparing this boundary with the later
   * dirty set detects writes outside declared/previously-attributed scope. */
  attempt_repository_baseline?: readonly DeclaredArtifactBaseline[];
  /** Engine-issued packet authority retained after a review run closes. A
   * self-hashed packet is integrity evidence, not provenance; historical write
   * recovery accepts a packet only when every registration field matches. */
  issued_review_packets?: readonly IssuedReviewPacketRegistration[];
  /** Historical commit explicitly supplied to the sanctioned recovery helper
   * after a legacy retry overwrote the original baseline. Persisted so the
   * exceptional evidence source remains auditable. */
  artifact_baseline_recovered_from?: string;
  /** Audited immutable Review Packets used to recover cumulative write
   * attribution after a legacy retry replaced files_modified. */
  recovered_artifact_writes?: readonly RecoveredArtifactWriteEvidence[];
  start_sha?: string;
  failure_reason?: string;
  retry_count?: number;
}

export interface WaveGate {
  impl_complete: boolean;
  tests_passed: boolean | null;
  reviews_complete: boolean;
  blocked: boolean;
}

/** The initial (nothing verified yet) wave gate — the one shape every
 *  writer must start from. A factory instead of a shared literal so adding
 *  a field to WaveGate updates every construction site at once. */
export function newWaveGate(): WaveGate {
  return { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };
}

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

/** Captured evidence is complete: count/view lockstep is established at construction. */
export type CapturedSpecCheck = Readonly<SpecCheckBase & {
  verdict: Exclude<SpecCheckVerdict, "EVIDENCE_CAPTURE_FAILED">;
  critical_count: number;
  high_count: number;
  /** `readonly` for the reason `Task.critical_findings` is: a holder that can
   *  `push` into a findings view mutates gate input in place, with no compile
   *  error at the site that did it. */
  critical_findings: readonly string[];
  high_findings: readonly string[];
  medium_findings: readonly string[];
  error?: never;
}>;

/** A failed capture carries a cause and cannot masquerade as usable counts. */
export type EvidenceFailedSpecCheck = Readonly<SpecCheckBase & {
  verdict: "EVIDENCE_CAPTURE_FAILED";
  error: string;
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
  | Readonly<{ kind: "terminal-blocked"; diagnostic: TerminalBlockedDiagnostic }>;

export type ActiveWaveGateRegistration = Readonly<{
  schemaVersion: 1;
  kind: "active-wave-gate";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  /** Non-null only while reading a legacy terminal registration. New
   * completions archive it in wave_gate_history and clear active authority. */
  terminalOutcome: ActiveWaveGateTerminalOutcome | null;
}>;

/** Terminal audit is not active authority for the newly-current Wave. */
export type CompletedWaveGateRegistration = Readonly<{
  schemaVersion: 1;
  kind: "completed-wave-gate";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
  revision: number;
  completionReceipt: ProtectedWaveStateCommitted;
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
  | Readonly<{ kind: "blocked"; lifecycle: "recoverable-blocked" | "terminal-blocked" | "authority-blocked"; action: BlockedAction; binding: WaveGateProtectedSnapshotBinding }>
  | Readonly<{ kind: "completed"; lifecycle: "done"; action: DoneAction; binding: WaveGateProtectedSnapshotBinding }>;

/** A healthy registered program can be temporarily unable to expose its next
 * semantic action until the engine replays its checkpoint. This remains one of
 * the fixed four external action tags (`blocked`) without pretending malformed
 * authority or a terminal lifecycle failure. */
export type EngineResumeDiagnostic = Readonly<{
  kind: "engine-resume-required";
  category: "healthy-run-suspended";
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

export type NextActionDecision = Readonly<{
  /** Exactly one of the fixed four transport tags. Engine resume is a typed,
   * retryable blocked action rather than terminal invalid authority. */
  action: WaveGateNextAction["action"] | EngineResumeAction;
  reasons: OrchestrationNonEmpty<StatusReason>;
}>;

export type LoomStatus = Readonly<{
  schemaVersion: 1;
  facts: CanonicalStatusFacts;
  next: NextActionDecision;
}>;

export interface TaskGraph {
  current_phase: Phase;
  phase_artifacts: Partial<Record<Phase, string>>;
  skipped_phases: Phase[];
  spec_dir?: string | null;
  spec_file: string | null;
  plan_file: string | null;
  plan_title?: string;
  /** `readonly` for the same reason `Task.findings` is: every producer already
   *  returns a fresh array, and an in-place `push`/`sort` on the task list is a
   *  state mutation that bypasses `StateManager.update`'s locked transform. */
  tasks: readonly Task[];
  current_wave?: number;
  executing_tasks?: readonly string[];
  wave_gates: Record<string, WaveGate>;
  github_issue?: number;
  github_repo?: string;
  spec_check?: SpecCheck;
  /** Parser-proven protected registration; absent until a Wave Gate is explicitly registered. */
  active_wave_gate?: ActiveWaveGateRegistration;
  /** Immutable terminal registrations, separate from authority for the next Wave. */
  wave_gate_history?: readonly CompletedWaveGateRegistration[];
  updated_at?: string;
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
  /** null when the `**Tier:**` line is missing or not a recognized tier */
  readonly tier: InvariantTier | null;
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
