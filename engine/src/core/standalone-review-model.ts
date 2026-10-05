/**
 * The Standalone Review Run's model: frozen authority, reviewer evidence, aggregate,
 * adjudicated result, Refutation Panel outcomes, and the nominal successor-lineage
 * values. Types only. Every nominal brand declared here is minted exclusively by the
 * custody owner (standalone-review.ts) behind process-local membership, so the model
 * sits beneath every module that reads it without offering a way to forge membership.
 */
import type { Finding, RefutedFinding } from "./findings";
import type { LlmProfileId } from "./model-profiles";
import type {
  AgentRequestAuthority, AgentRosterSlot, ArtifactRef, ExactRoster, NonEmpty, OrchestrationRunId, RequestId, SlotId,
} from "./orchestration-contract";
import type { ReviewPath } from "./review-packet";
import type { ReviewerProtocolDescriptor, STANDALONE_REVIEW_SUBJECT } from "./reviewer-contract";
import type {
  FindingOrigin, STANDALONE_REVIEWER_PROTOCOL_V3, StandaloneDispositionRecord, StandaloneLineageRow,
  StandalonePreviousSnapshot, StandalonePublicationReference, StandaloneResolutionAssessment,
  StandaloneReviewerPayloadV3, StandaloneSnapshot,
} from "./standalone-lineage-contract";
import type {
  StandaloneChangedPaths, StandaloneReviewMetadata, StandaloneReviewerRole, StandaloneScopeSafety, StandaloneScopeSource,
} from "./standalone-review-scope";

/** Complete immutable authority produced before any reviewer is spawnable. */
export type StandaloneReviewProtocol =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>
  | Readonly<{ schemaVersion: 3; reviewerProtocol: typeof STANDALONE_REVIEWER_PROTOCOL_V3; successor: PreparedStandaloneSuccessor }>;
type StandaloneAggregateProtocol = Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }> |
  (Extract<StandaloneReviewProtocol, { schemaVersion: 3 }> & Readonly<{ lineage: StandaloneSuccessorLineage }>);

export type FrozenStandaloneReviewAuthority = StandaloneReviewProtocol & Readonly<{
  readonly kind: "standalone-review-authority";
  readonly runId: OrchestrationRunId;
  readonly scopeSource: StandaloneScopeSource;
  readonly scope: NonEmpty<ReviewPath>;
  readonly scopeSafety: NonEmpty<StandaloneScopeSafety>;
  readonly changedPaths: StandaloneChangedPaths;
  readonly reviewMetadata: StandaloneReviewMetadata;
  readonly reviewers: NonEmpty<StandaloneReviewerRole>;
  readonly roster: ExactRoster<AgentRosterSlot>;
}>;

export interface StandaloneReviewerEvidence {
  readonly authorityKind: "request-bound" | "legacy-slot-bound";
  readonly agent: StandaloneReviewerRole;
  /** Branded like every other slot/request identity in this module: the value
   *  comes from untrusted `aggregate.json`, so it is PARSED against
   *  `SAFE_AUTHORITY_ID`, not merely shape-checked for non-emptiness. */
  readonly slotId: SlotId;
  readonly requestId: RequestId;
  readonly attempt: 1 | 2;
  readonly modelProfile: LlmProfileId | null;
  readonly contextDigest: string | null;
  readonly artifact: ArtifactRef;
}

export type StandaloneReviewAggregate = StandaloneAggregateProtocol & Readonly<{
  readonly runId: string;
  readonly subjectId: typeof STANDALONE_REVIEW_SUBJECT;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly findings: readonly Finding[];
}>;

export type StandaloneReviewState =
  | Readonly<{ kind: "clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{ kind: "requires-refutation"; aggregate: StandaloneReviewAggregate; criticals: NonEmpty<Finding> }>;

export interface PanelRefutation { readonly lens: string; readonly reason: string }
interface ParsedPanelOutcomeBase {
  readonly findingId: string;
  readonly claim: string;
  readonly upheldBy: readonly string[];
  readonly uncertainFrom: readonly string[];
}
export type ParsedPanelOutcome =
  | Readonly<ParsedPanelOutcomeBase & { survives: true; refutations: readonly PanelRefutation[] }>
  | Readonly<ParsedPanelOutcomeBase & { survives: false; refutations: NonEmpty<PanelRefutation> }>;
export interface ParsedPanelOutcomes {
  readonly lenses: readonly string[];
  readonly threshold: number;
  readonly outcomes: readonly ParsedPanelOutcome[];
}

export type AdjudicatedStandaloneReview = StandaloneAggregateProtocol & Readonly<{
  readonly runId: string;
  readonly scope: readonly string[];
  readonly reviewerEvidence: readonly StandaloneReviewerEvidence[];
  readonly survivingCriticals: readonly Finding[];
  readonly advisories: readonly Finding[];
  readonly refutedCriticals: readonly RefutedFinding[];
  readonly panel: ParsedPanelOutcomes | null;
}>;

export type StandaloneSuccessorReviewHistory = Readonly<{
  publication: StandalonePublicationReference; runId: string; snapshotDigest: string; lineageDigest: string;
  reports: StandaloneSuccessorLineage["reports"]; assessments: StandaloneSuccessorLineage["assessments"];
  currentCriticalCoverage: StandaloneSuccessorLineage["currentCriticalCoverage"];
  disposition: StandaloneDispositionSelection;
}>;

export type StandaloneDispositionPublicationReference = Readonly<{ locator: string; runId: string; dispositionDigest: string }>;
export type StandaloneDispositionRevision = Readonly<{
  record: StandaloneDispositionRecord; digest: string; publication: StandaloneDispositionPublicationReference }>;
declare const publishedDispositionBrand: unique symbol;
export type PublishedStandaloneDisposition = StandaloneDispositionRevision & Readonly<{ [publishedDispositionBrand]: true;
  history: readonly StandaloneDispositionRevision[] }>;

export type StandaloneDispositionSelection =
  | Readonly<{ kind: "historical-decision-unavailable" }>
  | Readonly<{ kind: "selected-record"; disposition: PublishedStandaloneDisposition }>;

declare const successorBrand: unique symbol;
export type PreparedStandaloneSuccessor = Readonly<{
  [successorBrand]: true; runId: string; source: StandalonePublicationReference;
  inventory: readonly StandaloneLineageRow[]; disposition: StandaloneDispositionSelection;
  snapshot: StandaloneSnapshot; previousSnapshot: StandalonePreviousSnapshot;
  reviewHistory: readonly StandaloneSuccessorReviewHistory[];
  snapshotDigest: string; reviewers: readonly [FindingOrigin["role"], ...FindingOrigin["role"][]]; lineageDigest: string;
}>;

export type StandaloneAssessmentProjection = Readonly<{
  origin: string; state: "active" | "retained" | "resolved" | "reopening-required" | "coverage-limited";
  assessments: readonly StandaloneResolutionAssessment[];
}>;

declare const evidenceBrand: unique symbol;
export type AdmittedStandaloneSuccessorEvidence = Readonly<{
  [evidenceBrand]: true; request: AgentRequestAuthority; lineageDigest: string; transcriptDigest: string;
  payload: StandaloneReviewerPayloadV3;
  newFindings: readonly StandaloneLineageRow[];
}>;

export type StandaloneSuccessorLineage = Readonly<{
  inventory: readonly StandaloneLineageRow[];
  reports: readonly AdmittedStandaloneSuccessorEvidence[];
  assessments: readonly StandaloneAssessmentProjection[];
  dispositions: readonly Readonly<{ origin: string; provenance: "new" | "inherited";
    state: "active" | "refuted" | "resolved" | "policy-retired" | "pending-panel" }>[];
  currentCriticalCoverage:
    | Readonly<{ kind: "complete"; origins: readonly [] }>
    | Readonly<{ kind: "limited"; origins: readonly [string, ...string[]] }>;
  counts: Readonly<{ new: number; inherited: number; total: number; survivingCritical: number;
    refutedCritical: number; resolved: number; advisory: number; currentCriticalCoverageLimited: number }>;
}>;
