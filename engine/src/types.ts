/**
 * Core types for loom hook handlers
 */

import { match } from "ts-pattern";
import type { TaskProof } from "./core/proof-obligations";
import type { DeclaredArtifactBaseline } from "./core/artifact-baseline";

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
  spec_anchors?: string[];
  new_tests_required?: boolean;
  /** Exact architecture context selected for this Task by decompose. */
  plan_context?: string;
  /** Engine-authored proof aggregate. New graphs always carry it. */
  proof?: TaskProof;
  /** Files this task creates/modifies (decompose contract); older graphs may lack it */
  file_list?: string[];
  /** Test outcome + trust provenance; absent until an impl agent completes. */
  test_result?: TaskTestResult;
  test_evidence?: string;
  new_tests_written?: boolean;
  new_test_evidence?: string;
  files_modified?: string[];
  review_status?: ReviewStatus;
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
   * Exactly five writers keep the three in lockstep, and every one of them
   * writes all three together: `sanitizeDecomposedTask` (the initializer, in
   * handlers/helpers/populate-task-graph); `mergeFindings` (a reviewer
   * finished) and `applyFindingOutcomes` (the panel adjudicated), both in
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
   * the invariant a load-boundary check, five coordinated writers and a `--fix`
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
  /** Exact declared-artifact state captured before the implementation agent
   *  starts. Proof compares current bytes to this baseline; transcript tool
   *  calls remain lint targets and cannot vouch that a change occurred. */
  artifact_baseline?: readonly DeclaredArtifactBaseline[];
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
  updated_at?: string;
}
