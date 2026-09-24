/**
 * The Finding / Review Run / Refutation vocabulary — the concept's SHAPE.
 *
 * This is the leaf shape volume of the Finding concept whose behaviour and
 * invariants live in core/findings.ts (the concept's one owner; see its
 * header). It moved here from the types.ts catch-all (atl-2): types.ts and
 * core/findings.ts both need these names, and a leaf volume is what keeps
 * the module graph acyclic — types.ts binds its schema-root Task fields to
 * this module one-way, while core/findings.ts keeps its type-only
 * Task/ReviewStatus edge to types.ts and re-exports this whole surface.
 *
 * Pure module: no I/O, no clock, no randomness. No imports except the
 * reviewer wire contract that defines the current draft shape.
 */

import type { ReviewerDraftV2, ReviewerProtocolDescriptor } from "./reviewer-contract";
// --- Finding / Review Run / Refutation vocabulary (the concept's shape) ---
//
// Moved here from types.ts (atl-2). Re-exported by types.ts; these are the
// definitions.

/** Severity tuple — the source of truth `parseFindingSeverity` proves against. */
export const FINDING_SEVERITIES = ["critical", "advisory"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * A normalized reviewer finding draft: claim whitespace is canonicalized and
 * optional locations are sanitized before this shape is constructed. It
 * deliberately carries NO identity — `attributeFindings` in core/findings.ts
 * is the only place identity is derived.
 */
export interface LegacyDraftFinding {
  readonly protocolVersion?: never;
  readonly basis?: never;
  readonly reason?: never;
  readonly severity: FindingSeverity;
  /** Unverified reviewer-supplied single-line location hint, or null. */
  readonly file: string | null;
  /** 1-based line, or null. */
  readonly line: number | null;
  /** The single assertion a verifier will try to refute. */
  readonly claim: string;
}

/** Exact current wire data plus its engine-owned durable discriminator. */
export type CurrentDraftFinding = ReviewerDraftV2 & Readonly<{ protocolVersion: 2 }>;
export type DraftFinding = LegacyDraftFinding | CurrentDraftFinding;
export type FindingIdentity = Readonly<{ id: string; agent: string }> & (
  | Readonly<{ review_generation?: never; review_packet_id?: never }>
  | Readonly<{ review_generation: number; review_packet_id: string }>
);
/** `attributeFindings` mints identity; stored parsers rehydrate it without changing current evidence. */
export type Finding = DraftFinding & FindingIdentity;

export const PRIOR_FINDING_VERDICTS = ["resolved_by_remediation", "still_present"] as const;
export type PriorFindingVerdict = (typeof PRIOR_FINDING_VERDICTS)[number];

/** One reviewer's explicit assessment of one finding that pre-dates the run. */
export interface PriorFindingAssessment {
  readonly finding_id: string;
  readonly verdict: PriorFindingVerdict;
  readonly reason: string;
}

interface ReviewRunEvidenceBase {
  readonly agent: string;
  readonly prior_assessments: readonly PriorFindingAssessment[];
}

/** Evidence from a legacy/non-Wave packet that has no engine-issued slot. */
export type UnboundReviewRunEvidence = Readonly<ReviewRunEvidenceBase & {
  readonly protocolVersion?: never;
  readonly new_findings: readonly LegacyDraftFinding[];
  readonly request_id?: never;
  readonly context_digest?: never;
  readonly slot_id?: never;
  readonly attempted?: never;
}>;

/** Evidence whose transcript was accepted under one exact engine-issued slot attempt. */
export type SlotBoundReviewRunEvidence = Readonly<ReviewRunEvidenceBase & {
  readonly protocolVersion?: never;
  readonly new_findings: readonly LegacyDraftFinding[];
  readonly request_id?: never;
  readonly context_digest?: never;
  readonly slot_id: string;
  readonly attempted: 1 | 2;
}>;

/** Evidence staged by one reviewer. It activates only through successful
 * whole-run finalization or the narrower incomplete-run retirement path, which
 * preserves accepted new Findings while withholding prior-Finding resolutions. */
export type LegacyReviewRunEvidence = UnboundReviewRunEvidence | SlotBoundReviewRunEvidence;
export type CurrentReviewRunEvidence = Readonly<ReviewRunEvidenceBase & {
  protocolVersion: 2;
  new_findings: readonly CurrentDraftFinding[];
  slot_id: string;
  attempted: 1 | 2;
  request_id: string;
  context_digest: string;
}>;
export type ReviewRunEvidence = LegacyReviewRunEvidence | CurrentReviewRunEvidence;

/** Engine-issued semantic-slot authority for one member of an active Review
 * Run. Legacy runs may omit this field, but exact-slot Wave recovery refuses
 * such runs rather than accepting caller-authored attempt evidence. */
type ReviewRunSlotBase = Readonly<{ agent: string; slot_id: string; attempted: 1 | 2 }>;
export type LegacyReviewRunSlotAuthority = ReviewRunSlotBase & Readonly<{ request_id?: never; context_digest?: never }>;
export type CurrentReviewRunSlotAuthority = ReviewRunSlotBase & Readonly<{ request_id: string; context_digest: string }>;
export type ReviewRunSlotAuthority = LegacyReviewRunSlotAuthority | CurrentReviewRunSlotAuthority;

/**
 * In-progress, packet-bound review run. Every expected reviewer must cover every
 * prior finding exactly once before any prior finding can leave the active set.
 */
type ReviewRunBase = Readonly<{
  generation: number;
  packet_id: string;
  head_sha: string;
  expected_agents: readonly [string, ...string[]];
  prior_finding_ids: readonly string[];
}>;

type ReviewRunWorkspaceAuthority =
  | Readonly<{
      workspace_scope?: never;
      workspace_head_sha?: never;
      wave_gate_run_id?: never;
      wave_gate_authority_digest?: never;
    }>
  | Readonly<{
      /** Exact Wave authority that issued this byte snapshot. */
      workspace_scope: readonly string[];
      workspace_head_sha: string;
      wave_gate_run_id: string;
      wave_gate_authority_digest: string;
    }>;

/** Workspace authority is either wholly absent on an unbound/legacy run or complete. */
export type LegacyReviewRun = Readonly<ReviewRunBase & ReviewRunWorkspaceAuthority & {
  reviewer_protocol?: never;
  evidence: readonly LegacyReviewRunEvidence[];
  slot_authority?: readonly [LegacyReviewRunSlotAuthority, ...LegacyReviewRunSlotAuthority[]];
}>;
export type CurrentReviewRun = Readonly<ReviewRunBase & Extract<ReviewRunWorkspaceAuthority, { workspace_scope: readonly string[] }> & {
  reviewer_protocol: ReviewerProtocolDescriptor;
  evidence: readonly CurrentReviewRunEvidence[];
  slot_authority: readonly [CurrentReviewRunSlotAuthority, ...CurrentReviewRunSlotAuthority[]];
}>;
export type ReviewRun = LegacyReviewRun | CurrentReviewRun;

type AcceptedReviewAuthorityBase = Readonly<{
  generation: number;
  packet_id: string;
  head_sha: string;
  scope: readonly string[];
}>;

type AcceptedReviewRunAuthority =
  | Readonly<{ run_id?: never; authority_digest?: never }>
  | Readonly<{ run_id: string; authority_digest: string }>;

/** Review authority retained after a roster closes. It is the immutable source
 * for completion integrity and completed-Wave reopening; graph summaries are
 * never substituted for it. Run authority is either wholly absent for legacy
 * evidence or complete, so a partially bound accepted run is unrepresentable. */
export type LegacyAcceptedReviewAuthority = Readonly<AcceptedReviewAuthorityBase & AcceptedReviewRunAuthority & { reviewer_protocol?: never }>;
export type CurrentAcceptedReviewAuthority = Readonly<AcceptedReviewAuthorityBase & {
  run_id: string;
  authority_digest: string;
  reviewer_protocol: ReviewerProtocolDescriptor;
}>;
export type AcceptedReviewAuthority = LegacyAcceptedReviewAuthority | CurrentAcceptedReviewAuthority;

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
 * A refuted finding always has at least one — `countRefutationVotes` (reached
 * per finding from `tallyRefutations`) destructures `[head, ...tail]` at the
 * vote site specifically to establish it, and
 * `parseStoredRefutation` rejects an empty list on the way back in. The
 * invariant was proven on write and on read and then forgotten by the type in
 * between, so `RefutedFinding` documented in a comment what `AdjudicatedFinding`
 * and `FindingOutcome` already express. The shape lives beside its consumers
 * here, so the in-flight and at-rest forms cannot disagree about whether a
 * refuted finding may have zero refutations.
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
