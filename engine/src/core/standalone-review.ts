/**
 * Standalone Review custody core (ADR-0010): roster-completion proof, aggregation and
 * finalization; Finding Origin lineage sources, disposition revisions and successor
 * preparation; issued successor evidence; and the LC-2 reducer with its authoritative
 * result publication. These share one owner because their process-local membership is
 * one proof chain — prepared-source membership feeds issued reviewer evidence, which
 * feeds LC-2 finalization/publication, which alone can admit the next source. Exporting
 * a registrar to separate them would bypass that chain; only read-only membership
 * predicates leave this module. Everything outside the chain — scope and roster policy,
 * preparation, capture, transcript admission, records, the Refutation Panel and the
 * checkpoint codec — has its own module. The lineage, successor-reviewer and machine
 * entry modules retain their existing APIs; this implementation never imports them.
 */
import { isDeepStrictEqual } from "node:util";
import { match } from "ts-pattern";
import { buildStandaloneReviewerContextPacketV3, encodeByteSection, parseStandaloneReviewerContextPacketV3,
  type ByteSection, type StandaloneReviewerContextPacketV3 } from "./context-packets";
import { canonicalDigest, sha256Bytes } from "./digest";
import { attributeFindings, findingsUnionError, parseStoredFindings, type Finding, type RefutedFinding } from "./findings";
import {
  acceptedAgentResult,
  canonicalRecord,
  canonicalStructuralEquals,
  parseCompleteRoster,
  parseEffectId,
  reconcileEffectReceipt,
  sameAgentRequestAuthority,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type ArtifactSetPublished,
  type CompleteRoster,
  type CompleteRosterError,
  type DomainResult,
  type EffectIntent,
  type EffectReceipt,
  type InfrastructureRetryDiagnostic,
  type NonEmpty,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type PublishArtifactSet,
  type RequestId,
  type SemanticPayloadParseError,
  type SlotId,
  type SpawnRequest,
} from "./orchestration-contract";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { parseEffectReceipt } from "./orchestration-contract/effects";
import { failure, success } from "./orchestration-contract/identity";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import type { RefutationPanelAuthority } from "./panel-authority";
import type { IssuedStandaloneReviewerProtocol, ParsedFindings, ReviewerProtocolAuthorityResolver } from "./review-output";
import { STANDALONE_REVIEW_SUBJECT, parseReviewerProtocolDescriptor, type ReviewerProtocolFailure } from "./reviewer-contract";
import { parseBoundedReviewerJson, parseStandaloneReviewerPayloadV3 } from "./reviewer-protocol";
import {
  STANDALONE_LINEAGE_LIMITS, STANDALONE_REVIEWER_PROTOCOL_V3,
  standaloneDispositionSchema, standalonePreviousSnapshotSchema, standalonePublicationReferenceSchema,
  standaloneSuccessorSelectionSchema,
  type StandaloneDispositionRecord, type StandaloneLineageRow, type StandalonePreviousSnapshot, type StandalonePublicationReference,
  type StandaloneReviewerPayloadV3,
} from "./standalone-lineage-contract";
import {
  findingOf, parseFindingOrigin, parseStandaloneLineageInventory, rejectLineage, standaloneDecisionReference,
  standaloneOriginReference, storedFinding, type StandaloneLineageError,
} from "./standalone-finding-origin";
import {
  freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion, type StandaloneRefutationCompletionReceipt,
} from "./standalone-refutation-completion";
import {
  canonicalStandalonePanelOutcomes, panelOutcomeValue, standaloneCurrentPanelCriticals, type FrozenStandalonePanelAuthority,
} from "./standalone-refutation-panel";
import type {
  AdjudicatedStandaloneReview, AdmittedStandaloneSuccessorEvidence, FrozenStandaloneReviewAuthority, PanelRefutation,
  ParsedPanelOutcomes, PreparedStandaloneSuccessor, PublishedStandaloneDisposition, StandaloneAssessmentProjection,
  StandaloneDispositionPublicationReference, StandaloneDispositionRevision, StandaloneDispositionSelection,
  StandaloneReviewAggregate, StandaloneReviewerEvidence, StandaloneReviewProtocol, StandaloneReviewState,
  StandaloneSuccessorLineage, StandaloneSuccessorReviewHistory,
} from "./standalone-review-model";
import {
  canonicalStandaloneResultArtifact, parseReviewerEvidence, serializeAdjudicatedStandaloneReview,
  serializeStandaloneAggregate, serializeStandaloneReviewAuthority,
} from "./standalone-review-records";
import {
  STANDALONE_REVIEWER_ROLES, exactKeys, findingScopeErrors, parseStandaloneReviewScope, type StandaloneReviewerRole,
} from "./standalone-review-scope";
import {
  fingerprintCapturedReviewerResult, parseCapturedReviewerResult, type CapturedReviewerResult,
} from "./standalone-reviewer-capture";
import { admitStandaloneTranscript } from "./standalone-transcript-admission";

const freeze = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

export type StandaloneReviewerProtocolResolver = (request: AgentRequestAuthority) => DomainResult<
  Extract<ReturnType<ReviewerProtocolAuthorityResolver>, { ok: true }>["value"] | IssuedStandaloneSuccessorReviewer, ReviewerProtocolFailure>;

declare class StandaloneRosterCompletionMembership {
  private readonly standaloneRosterCompletionMembership: true;
}

type ProvenStandaloneRosterEntry = Readonly<{
  slotId: SlotId;
  requestId: RequestId;
  attempt: 1 | 2;
  payloadFingerprint: string;
}>;

/**
 * T4 completion authority. A structural T1 CompleteRoster is deliberately not
 * sufficient: this proof exists only after T1 reparses the raw result set
 * against this frozen standalone roster and an independent publication
 * registration resolver.
 */
export type StandaloneRosterCompletionProof = StandaloneRosterCompletionMembership & Readonly<{
  schemaVersion: 1;
  kind: "standalone-roster-completion-proof";
  runId: OrchestrationRunId;
  rosterDigest: ArtifactDigest;
  accepted: NonEmpty<ProvenStandaloneRosterEntry>;
  /** Durable parser input retained so publication authority can be re-proved after restart. */
  results: NonEmpty<AcceptedAgentResult<CapturedReviewerResult>>;
}>;

const standaloneRosterCompletionCache = new WeakMap<object, Readonly<{
  authority: FrozenStandaloneReviewAuthority;
  authoritySerialization: string;
  roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>;
  findings: readonly ParsedFindings[];
  successorReports: readonly AdmittedStandaloneSuccessorEvidence[];
}>>();

/** The sole T4 constructor for roster-completion authority. */
export function proveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
  rawResults: unknown,
  reviewerProtocols: StandaloneReviewerProtocolResolver,
): DomainResult<StandaloneRosterCompletionProof, CompleteRosterError> {
  const reparsed = parseCompleteRoster(
    resolver,
    authority.roster,
    rawResults,
    parseCapturedReviewerResult,
  );
  if (!reparsed.ok) return reparsed;
  const findings: ParsedFindings[] = [];
  const successorReports: AdmittedStandaloneSuccessorEvidence[] = [];
  for (const result of reparsed.value.ordered) {
    const protocol = reviewerProtocols(result.authority);
    if (authority.schemaVersion === 3) {
      if (!protocol.ok || protocol.value.protocolVersion !== 3 || protocol.value.prepared !== authority.successor ||
          !sameAgentRequestAuthority(protocol.value.request, result.authority)) return completionProtocolFailure("v3 issued authority differs from frozen successor", successorReports.length);
      const admitted = admitStandaloneSuccessorReviewer(protocol.value, Buffer.from(result.value.rawBytes.data, "base64"));
      if (!admitted.ok) return completionProtocolFailure(admitted.error.message, successorReports.length);
      successorReports.push(admitted.value);
      continue;
    }
    if (!protocol.ok || protocol.value.protocolVersion === 3 || protocol.value.subject.kind !== "standalone-review" ||
        protocol.value.protocolVersion !== authority.schemaVersion ||
        !sameAgentRequestAuthority(protocol.value.request, result.authority) ||
        JSON.stringify(protocol.value.subject.scope) !== JSON.stringify(authority.scope) ||
        protocol.value.subject.runId !== authority.runId ||
        JSON.stringify(protocol.value.reviewerProtocol) !== JSON.stringify(authority.reviewerProtocol)) {
      return completionProtocolFailure("reviewer protocol does not match the exact frozen standalone request", findings.length);
    }
    const admission = admitStandaloneTranscript(protocol.value as IssuedStandaloneReviewerProtocol, Buffer.from(result.value.rawBytes.data, "base64"));
    if (!admission.ok) return completionProtocolFailure(admission.problems.join("; "), findings.length);
    findings.push(admission.findings);
  }
  const [firstResult, ...otherResults] = reparsed.value.ordered;
  const toEntry = (result: AcceptedAgentResult<CapturedReviewerResult>): ProvenStandaloneRosterEntry => Object.freeze({
    slotId: result.authority.slotId,
    requestId: result.authority.requestId,
    attempt: result.authority.attempt,
    payloadFingerprint: fingerprintCapturedReviewerResult(result.value),
  });
  const accepted = Object.freeze([
    toEntry(firstResult),
    ...otherResults.map(toEntry),
  ]) as NonEmpty<ProvenStandaloneRosterEntry>;
  const rosterDigest = canonicalDigest(accepted);
  const proof = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-roster-completion-proof" as const,
    runId: authority.runId,
    rosterDigest,
    accepted,
    results: Object.freeze([firstResult, ...otherResults]) as NonEmpty<AcceptedAgentResult<CapturedReviewerResult>>,
  }) as StandaloneRosterCompletionProof;
  standaloneRosterCompletionCache.set(proof, canonicalRecord({
    authority,
    authoritySerialization: serializeStandaloneReviewAuthority(authority),
    roster: reparsed.value,
    findings: Object.freeze(findings),
    successorReports: Object.freeze(successorReports),
  }));
  return success(proof);
}

/**
 * Rehydrate roster authority from persisted JSON. The resolver must verify the
 * immutable batch publication receipt/artifact for every retained request.
 */
export function parseStandaloneRosterCompletionProof(
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
  raw: unknown,
  reviewerProtocols: StandaloneReviewerProtocolResolver,
): DomainResult<StandaloneRosterCompletionProof, CompleteRosterError> {
  const malformedPersistedCompletion = (message: string): DomainResult<never, CompleteRosterError> =>
    failure(canonicalRecord({
      kind: "incomplete-or-invalid-roster" as const,
      violations: Object.freeze([canonicalRecord({
        kind: "malformed-result-boundary" as const,
        field: null,
        index: null,
        reason: "unsafe-inspection" as const,
        message,
      })]) as CompleteRosterError["violations"],
    }));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== "standalone-roster-completion-proof" ||
      raw.runId !== authority.runId || !Array.isArray(raw.results)) {
    return malformedPersistedCompletion(
      "persisted standalone roster completion must contain the canonical schema, run authority, and durable result roster",
    );
  }
  const reproved = proveStandaloneRosterCompletion(authority, resolver, raw.results, reviewerProtocols);
  if (!reproved.ok) return reproved;
  if (raw.rosterDigest !== reproved.value.rosterDigest ||
      JSON.stringify(raw.accepted) !== JSON.stringify(reproved.value.accepted)) {
    return malformedPersistedCompletion(
      "persisted standalone roster completion digest or accepted-slot projection disagrees with the re-proved result roster",
    );
  }
  return reproved;
}

function completionProtocolFailure(message: string, index: number): DomainResult<never, CompleteRosterError> {
  return failure(canonicalRecord({ kind: "incomplete-or-invalid-roster", violations: Object.freeze([
    canonicalRecord({ kind: "malformed-result-boundary", field: null, index, reason: "unsafe-inspection", message }),
  ]) as CompleteRosterError["violations"] }));
}

function resolveStandaloneRosterCompletion(
  authority: FrozenStandaloneReviewAuthority,
  proof: StandaloneRosterCompletionProof,
): DomainResult<Readonly<{ roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>; findings: readonly ParsedFindings[]; successorReports: readonly AdmittedStandaloneSuccessorEvidence[] }>, SemanticPayloadParseError> {
  const cached = typeof proof === "object" && proof !== null
    ? standaloneRosterCompletionCache.get(proof)
    : undefined;
  if (cached === undefined || cached.authority !== authority || proof.runId !== authority.runId ||
      cached.authoritySerialization !== serializeStandaloneReviewAuthority(authority) ||
      proof.rosterDigest !== canonicalDigest(proof.accepted) || !Array.isArray(proof.results)) {
    return failure({ message: "standalone aggregation requires the exact opaque roster-completion proof minted for this frozen authority" });
  }
  return success(cached);
}

function standaloneReviewerEvidence(
  authority: FrozenStandaloneReviewAuthority,
  roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>,
): ParseResult<readonly Readonly<{ agent: StandaloneReviewerRole; evidence: StandaloneReviewerEvidence }>[]> {
  const errors: string[] = [];
  if (roster.ordered.length !== authority.roster.orderedSlots.length) {
    errors.push("complete reviewer roster length does not match frozen authority");
  }
  const transcripts = roster.ordered.flatMap((result, index) => {
    const expected = authority.roster.orderedSlots[index];
    if (expected === undefined) {
      errors.push(`complete reviewer result ${index} is surplus`);
      return [];
    }
    const canonical = result.authority;
    if (canonical.runId !== authority.runId) errors.push(`reviewer result ${index} belongs to a stale or foreign run`);
    if (canonical.slotId !== expected.slotId) errors.push(`reviewer result ${index} is outside canonical slot order`);
    const expectedAttempt = canonical.attempt === 1 ? expected.attempts[0] : expected.attempts[1];
    if (canonical.requestId !== expectedAttempt.requestId || canonical.contextDigest !== expectedAttempt.contextDigest ||
        canonical.modelProfile !== expectedAttempt.modelProfile || canonical.outputSlot.path !== expectedAttempt.outputSlot.path ||
        canonical.role !== expectedAttempt.role || canonical.program !== "standalone-review") {
      errors.push(`reviewer result ${index} does not match frozen request/model/context/output authority`);
    }
    const captured = result.value;
    if (captured.artifact.runId !== authority.runId || captured.artifact.slot.path !== canonical.outputSlot.path) {
      errors.push(`reviewer result ${index} artifact is bound to a stale, foreign, or mismatched slot`);
    }
    if (!(STANDALONE_REVIEWER_ROLES as readonly string[]).includes(canonical.role)) {
      errors.push(`reviewer result ${index} role is not a standalone reviewer`);
      return [];
    }
    const parsed = parseCapturedReviewerResult(captured);
    if (!parsed.ok) {
      errors.push(`reviewer result ${index}: ${parsed.error.message}`);
      return [];
    }
    const evidence: StandaloneReviewerEvidence = Object.freeze({
      authorityKind: "request-bound",
      agent: canonical.role as StandaloneReviewerRole,
      slotId: canonical.slotId,
      requestId: canonical.requestId,
      attempt: canonical.attempt,
      modelProfile: canonical.modelProfile,
      contextDigest: canonical.contextDigest,
      artifact: parsed.value.artifact,
    });
    return [{ agent: canonical.role as StandaloneReviewerRole, evidence }];
  });
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(transcripts));
}

/** Canonical aggregation consumes only the exact opaque completion proof and its cached admission. */
export function aggregateStandaloneReview(input: {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly completion: StandaloneRosterCompletionProof;
}): ParseResult<StandaloneReviewState> {
  const { authority } = input;
  const resolved = resolveStandaloneRosterCompletion(authority, input.completion);
  if (!resolved.ok) return fail([resolved.error.message]);
  const evidence = standaloneReviewerEvidence(authority, resolved.value.roster);
  if (!evidence.ok) return evidence;
  const transcripts = evidence.value;
  if (authority.schemaVersion === 3) {
    const lineage = deriveStandaloneSuccessorLineage(authority.successor,
      resolved.value.roster.ordered.map(result => result.authority), resolved.value.successorReports, null);
    if (!lineage.ok) return fail([lineage.error.message]);
    const aggregate: StandaloneReviewAggregate = Object.freeze({ schemaVersion: 3, reviewerProtocol: authority.reviewerProtocol,
      successor: authority.successor, lineage: lineage.value, runId: authority.runId, subjectId: STANDALONE_REVIEW_SUBJECT,
      scope: authority.scope, reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)),
      findings: Object.freeze(lineage.value.inventory.map(findingOf)) });
    return ok(standaloneAggregateRoute(aggregate));
  }
  const findings = Object.freeze(transcripts.flatMap(({ agent }, index) => attributeFindings(resolved.value.findings[index]!.drafts, agent)));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) return fail(["attributed standalone finding ids must be distinct across review agents"]);
  const aggregate: StandaloneReviewAggregate = Object.freeze({
    ...standaloneProtocol(authority), runId: authority.runId, subjectId: STANDALONE_REVIEW_SUBJECT,
    scope: authority.scope, reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)), findings,
  });
  return ok(standaloneAggregateRoute(aggregate));
}

function standaloneAggregateRoute(aggregate: StandaloneReviewAggregate): StandaloneReviewState {
  const [head, ...tail] = standaloneCurrentPanelCriticals(aggregate);
  return head === undefined ? Object.freeze({ kind: "clean", aggregate })
    : Object.freeze({ kind: "requires-refutation", aggregate, criticals: Object.freeze([head, ...tail]) as NonEmpty<Finding> });
}

function standaloneProtocol(value: Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }>): Exclude<StandaloneReviewProtocol, { schemaVersion: 3 }> {
  return value.schemaVersion === 2
    ? Object.freeze({ schemaVersion: 2, reviewerProtocol: value.reviewerProtocol })
    : Object.freeze({ schemaVersion: 1 });
}

export function parseStandaloneAggregate(raw: unknown, proof?: Readonly<{
  authority: FrozenStandaloneReviewAuthority; completion: StandaloneRosterCompletionProof;
}>): ParseResult<StandaloneReviewAggregate> {
  if (!isRecord(raw)) return fail(["standalone review aggregate must be an object"]);
  if (raw.schema_version === 3) {
    if (proof === undefined || proof.authority.schemaVersion !== 3) return fail(["v3 aggregate requires frozen successor and current roster proof"]);
    const rebuilt = aggregateStandaloneReview(proof);
    return rebuilt.ok && JSON.stringify(raw) === JSON.stringify(JSON.parse(serializeStandaloneAggregate(rebuilt.value.aggregate)))
      ? ok(rebuilt.value.aggregate) : fail(["v3 aggregate differs from independently re-proved current evidence"]);
  }
  // `reviewer_evidence` is ALLOWED but not REQUIRED, which is one exclusion,
  // not two passes: this used to run exactKeys over the required-only list,
  // strip every resulting error whose text merely CONTAINED
  // "reviewer_evidence" by substring, and then recompute unknown fields
  // against the correct list anyway.
  const errors = exactKeys(
    raw,
    ["schema_version", "run_id", "subject_id", "scope", "reviewer_evidence", "findings", ...(raw.schema_version === 2 ? ["reviewer_protocol"] : [])],
    "aggregate",
  ).filter((error) => raw.schema_version !== 1 || error !== "aggregate.reviewer_evidence is required");
  if (raw.schema_version !== 1 && raw.schema_version !== 2) errors.push("aggregate.schema_version must be 1 or 2");
  const descriptor = raw.schema_version === 2 ? parseReviewerProtocolDescriptor(raw.reviewer_protocol) : null;
  if (descriptor !== null && !descriptor.ok) errors.push(descriptor.error.message);
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  if (runId === "") errors.push("aggregate.run_id must be non-empty");
  if (raw.subject_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`aggregate.subject_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
  const scope = parseStandaloneReviewScope(raw.scope, "aggregate.scope");
  if (!scope.ok) errors.push(...scope.errors);
  if (!Array.isArray(raw.findings)) errors.push("aggregate.findings must be an array");
  const findingError = findingsUnionError(raw.findings, "aggregate.findings");
  if (findingError !== null) errors.push(findingError);
  const findings = parseStoredFindings(raw.findings);
  if (findings.some((finding) => (finding.protocolVersion === 2) !== (raw.schema_version === 2))) {
    errors.push("aggregate Finding protocol differs from aggregate authority");
  }
  if (scope.ok) errors.push(...findingScopeErrors(scope.value, findings, "aggregate.findings"));
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) errors.push("aggregate finding ids must be distinct");
  const evidence = parseReviewerEvidence(raw.reviewer_evidence, runId, "aggregate.reviewer_evidence");
  if (!evidence.ok) errors.push(...evidence.errors);
  return errors.length > 0 || !scope.ok || !evidence.ok
    ? fail(errors)
    : ok(Object.freeze({
        ...(descriptor !== null && descriptor.ok ? { schemaVersion: 2 as const, reviewerProtocol: descriptor.value } : { schemaVersion: 1 as const }),
        runId, subjectId: STANDALONE_REVIEW_SUBJECT, scope: scope.value, reviewerEvidence: evidence.value, findings,
      }));
}

function finalizeStandaloneSuccessor(aggregate: Extract<StandaloneReviewAggregate, { schemaVersion: 3 }>,
  panel: ParsedPanelOutcomes | null): ParseResult<AdjudicatedStandaloneReview> {
  const criticals = standaloneCurrentPanelCriticals(aggregate);
  if ((criticals.length === 0) !== (panel === null)) return fail(["successor requires exactly its current critical panel work"]);
  if (panel !== null && (panel.outcomes.length !== criticals.length || criticals.some(finding =>
      !panel.outcomes.some(outcome => outcome.findingId === `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`)))) return fail(["successor panel coverage differs from fresh work"]);
  const lineage = deriveStandaloneSuccessorLineage(aggregate.successor,
    aggregate.lineage.reports.map(report => report.request), aggregate.lineage.reports, panel);
  if (!lineage.ok) return fail([lineage.error.message]);
  const survivingCriticals: Finding[] = [];
  const refutedCriticals: RefutedFinding[] = [];
  const advisories: Finding[] = [];
  for (const [index, row] of lineage.value.inventory.entries()) {
    const finding = findingOf(row);
    const state = lineage.value.dispositions[index]!.state;
    if (finding.severity === "advisory") advisories.push(finding);
    else if (state === "active") survivingCriticals.push(finding);
    else if (state === "refuted") {
      const decision = row.history.at(-1);
      if (decision?.kind !== "adjudication" || decision.refutations.length === 0) return fail(["refuted history lacks its original votes"]);
      refutedCriticals.push(Object.freeze({ finding, refutations: decision.refutations as NonEmpty<PanelRefutation> }));
    }
  }
  return ok(Object.freeze({ schemaVersion: 3, reviewerProtocol: aggregate.reviewerProtocol,
    successor: aggregate.successor, lineage: lineage.value, runId: aggregate.runId, scope: aggregate.scope,
    reviewerEvidence: aggregate.reviewerEvidence, survivingCriticals: Object.freeze(survivingCriticals),
    advisories: Object.freeze(advisories), refutedCriticals: Object.freeze(refutedCriticals), panel }));
}

/** Legacy v1/v2 finalization: a critical can only be surviving or audibly refuted. */
export function finalizeStandaloneReview(
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): ParseResult<AdjudicatedStandaloneReview> {
  if (aggregate.schemaVersion === 3) return finalizeStandaloneSuccessor(aggregate, panel);
  const criticals = aggregate.findings.filter((finding) => finding.severity === "critical");
  const advisories = Object.freeze(aggregate.findings.filter((finding) => finding.severity === "advisory"));
  if (criticals.length === 0) {
    return panel === null
      ? ok(Object.freeze({
          ...standaloneProtocol(aggregate),
          runId: aggregate.runId,
          scope: Object.freeze([...aggregate.scope]),
          reviewerEvidence: Object.freeze([...aggregate.reviewerEvidence]),
          survivingCriticals: Object.freeze([]),
          advisories,
          refutedCriticals: Object.freeze([]),
          panel: null,
        }))
      : fail(["a clean standalone review must not carry panel outcomes"]);
  }
  if (panel === null) return fail(["standalone review has unadjudicated critical findings"]);
  const canonicalPanel = canonicalStandalonePanelOutcomes(panel);
  if (!canonicalPanel.ok) return canonicalPanel;
  const byId = new Map(canonicalPanel.value.outcomes.map((outcome) => [outcome.findingId, outcome] as const));
  const survivingCriticals: Finding[] = [];
  const refutedCriticals: RefutedFinding[] = [];
  for (const finding of criticals) {
    const outcome = byId.get(`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`);
    if (!outcome) return fail([`missing adjudication for critical finding ${finding.id}`]);
    if (outcome.survives) survivingCriticals.push(finding);
    else refutedCriticals.push(Object.freeze({
      finding,
      refutations: Object.freeze(outcome.refutations.map(({ lens, reason }) => Object.freeze({ lens, reason }))) as NonEmpty<PanelRefutation>,
    }));
  }
  return ok(Object.freeze({
    ...standaloneProtocol(aggregate),
    runId: aggregate.runId,
    scope: Object.freeze([...aggregate.scope]),
    reviewerEvidence: Object.freeze([...aggregate.reviewerEvidence]),
    survivingCriticals: Object.freeze(survivingCriticals),
    advisories,
    refutedCriticals: Object.freeze(refutedCriticals),
    panel: canonicalPanel.value,
  }));
}

declare const sourceBrand: unique symbol;
export type StandaloneLineageSource = Readonly<{
  [sourceBrand]: true; publication: StandalonePublicationReference; inventory: readonly StandaloneLineageRow[];
  scope: readonly string[]; reviewers: readonly string[]; snapshot: StandalonePreviousSnapshot;
  reviewHistory: readonly StandaloneSuccessorReviewHistory[];
}>;
const sources = new WeakSet<object>();
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** The shell supplies the no-follow authenticated locator; LC-2 membership proves publication.
 * A successor's local origins/decisions receive enclosing publication exactly once at this join.
 */
export function prepareStandaloneLineageSource(result: AuthoritativeStandaloneReviewResult, locator: string,
  observedSnapshot?: StandalonePreviousSnapshot,
): DomainResult<StandaloneLineageSource, StandaloneLineageError> {
  if (!isAuthoritativeStandaloneReviewResult(result)) return rejectLineage("source-unavailable", "Lineage requires an LC-2 published result, not self-consistent result bytes.");
  const count = result.schemaVersion === 3 ? result.lineage.inventory.length
    : result.survivingCriticals.length + result.refutedCriticals.length + result.advisories.length;
  if (count > STANDALONE_LINEAGE_LIMITS.inventory || result.scope.length > STANDALONE_LINEAGE_LIMITS.paths ||
      (observedSnapshot !== undefined && observedSnapshot.length > STANDALONE_LINEAGE_LIMITS.paths)) {
    return rejectLineage("limit-exceeded", "Source inventory or observed scope exceeds its 4096-entry budget.");
  }
  const published = readStandaloneReviewPublication(result, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!published.ok) return rejectLineage("source-unavailable", published.error.message);
  const publication = standalonePublicationReferenceSchema.safeParse({ locator, runId: result.runId, resultDigest: published.value.digest });
  if (!publication.success) return rejectLineage("invalid-data", "Source publication locator or identity is malformed.");
  if (result.schemaVersion === 3) {
    const rows = result.lineage.inventory.map(row => canonicalRecord({ ...row,
      origin: row.origin.kind === "current" ? canonicalRecord({ ...row.origin, kind: "published-successor" as const, publication: publication.data }) : row.origin,
      history: freeze(row.history.map(decision => "kind" in decision.publication
        ? canonicalRecord({ ...decision, publication: publication.data }) : decision)),
    }));
    const inventory = parseStandaloneLineageInventory(bytes(rows));
    if (!inventory.ok) return inventory;
    if (observedSnapshot !== undefined && !canonicalStructuralEquals(observedSnapshot, result.successor.snapshot)) {
      return rejectLineage("identity-mismatch", "V3 source observation differs from its frozen published snapshot.");
    }
    const source: Omit<StandaloneLineageSource, typeof sourceBrand> = canonicalRecord({ publication: publication.data, inventory: inventory.value,
      snapshot: result.successor.snapshot, scope: result.scope, reviewers: result.successor.reviewers,
      reviewHistory: freeze([...result.successor.reviewHistory, canonicalRecord({ publication: publication.data,
        runId: result.runId, snapshotDigest: result.successor.snapshotDigest, lineageDigest: result.successor.lineageDigest,
        reports: result.lineage.reports, assessments: result.lineage.assessments, currentCriticalCoverage: result.lineage.currentCriticalCoverage,
        disposition: result.successor.disposition })]) });
    const minted = source as StandaloneLineageSource;
    sources.add(minted);
    return success(minted);
  }
  const findings = [...result.survivingCriticals, ...result.refutedCriticals.map(row => row.finding), ...result.advisories];
  const rows: StandaloneLineageRow[] = [];
  for (const evidence of result.reviewerEvidence) {
    const attributed = findings.filter(finding => finding.agent === evidence.agent).sort((a, b) => Number(a.id.split("-").at(-1)) - Number(b.id.split("-").at(-1)));
    for (const finding of attributed) {
      const origin = parseFindingOrigin({ kind: "published", runId: result.runId, requestId: evidence.requestId,
        transcriptDigest: evidence.artifact.digest, role: evidence.agent, ordinal: Number(finding.id.split("-").at(-1)), publication: publication.data });
      if (!origin.ok) return origin;
      const outcome = result.panel?.outcomes.find(row => row.findingId === `standalone-review:${finding.id}`);
      const history = outcome === undefined || result.panel === null ? [] : [{ kind: "adjudication" as const,
        publication: publication.data, lenses: result.panel.lenses, threshold: result.panel.threshold,
        survives: outcome.survives, refutations: outcome.refutations, upheldBy: outcome.upheldBy, uncertainFrom: outcome.uncertainFrom }];
      rows.push(canonicalRecord({ origin: origin.value, finding: storedFinding(finding, origin.value.role), history: freeze(history) }));
    }
  }
  if (rows.length !== count) return rejectLineage("identity-mismatch", "Every original Finding must join one accepted reviewer transcript.");
  const inventory = parseStandaloneLineageInventory(bytes(rows));
  if (!inventory.ok) return inventory;
  const snapshot = standalonePreviousSnapshotSchema.safeParse(observedSnapshot ?? result.scope.map(path => ({ kind: "historical-unknown", path })));
  if (!snapshot.success || !canonicalStructuralEquals(snapshot.data.map(row => row.path), result.scope)) {
    return rejectLineage("identity-mismatch", "Observed predecessor snapshot must cover its exact published scope in order.");
  }
  const source: Omit<StandaloneLineageSource, typeof sourceBrand> = canonicalRecord({ publication: publication.data, inventory: inventory.value, snapshot: snapshot.data,
    scope: freeze(result.scope), reviewers: freeze(result.reviewerEvidence.map(row => row.agent)), reviewHistory: freeze([]) });
  const minted = source as StandaloneLineageSource;
  sources.add(minted);
  return success(minted);
}

declare const dispositionBrand: unique symbol;
export type PreparedStandaloneDisposition = Readonly<{ [dispositionBrand]: true; record: StandaloneDispositionRecord; digest: string }>;
const dispositions = new WeakMap<object, readonly StandaloneDispositionRevision[]>();
/** Complete DECLARED policy data; corrections consume receipt-backed previous authority. */
export function prepareStandaloneDisposition(source: StandaloneLineageSource, input: Uint8Array,
  previous?: PublishedStandaloneDisposition,
): DomainResult<PreparedStandaloneDisposition, StandaloneLineageError> {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Disposition requires the exact prepared published source.");
  const decoded = parseBoundedReviewerJson(input, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage("invalid-data", decoded.error.message);
  if (isRecord(decoded.value) && Array.isArray(decoded.value.entries) && decoded.value.entries.length > STANDALONE_LINEAGE_LIMITS.inventory) {
    return rejectLineage("limit-exceeded", "Disposition inventory exceeds its pre-copy budget.");
  }
  const parsed = standaloneDispositionSchema.safeParse(decoded.value);
  if (!parsed.success) return rejectLineage("invalid-disposition", "Disposition record must contain complete bounded DECLARED policy.");
  const record = parsed.data;
  const advisories = source.inventory.filter(row => findingOf(row).severity === "advisory").map(row => standaloneOriginReference(row.origin));
  if (!canonicalStructuralEquals(record.source, source.publication) || record.entries.length !== advisories.length ||
      record.entries.some((row, index) => row.origin !== advisories[index])) return rejectLineage("invalid-disposition", "Policy must cover every advisory exactly once in source order, and no critical.");
  if (record.revision.kind === "correction") {
    if (previous === undefined || !publishedDispositions.has(previous) || record.revision.previousDigest !== previous.digest ||
        !canonicalStructuralEquals(previous.record.source, record.source)) return rejectLineage("invalid-disposition", "Correction must name the exact prior revision of this source.");
  } else if (previous !== undefined) return rejectLineage("invalid-disposition", "Only a correction may supply a prior revision.");
  if (previous !== undefined && previous.history.length >= STANDALONE_LINEAGE_LIMITS.historyPerOrigin - 1) {
    return rejectLineage("limit-exceeded", "Disposition chain exceeds 64 exact revisions.");
  }
  const dispositionDigest: string = canonicalDigest(record);
  const prepared = canonicalRecord({ record, digest: dispositionDigest }) as PreparedStandaloneDisposition;
  dispositions.set(prepared, previous === undefined ? freeze([]) : freeze([...previous.history,
    canonicalRecord({ record: previous.record, digest: previous.digest, publication: previous.publication })]));
  return success(prepared);
}

const publishedDispositions = new WeakSet<object>();
/** Port evidence is observed by the shell (or an in-memory adapter), never inferred from a self-hash. */
export type StandaloneDispositionPublicationReader = (reference: StandaloneDispositionPublicationReference) => DomainResult<
  Readonly<{ receipt: unknown; recordBytes: Uint8Array }>, Readonly<{ message: string }>>;

export function readPublishedStandaloneDisposition(prepared: PreparedStandaloneDisposition,
  reference: StandaloneDispositionPublicationReference, read: StandaloneDispositionPublicationReader,
): DomainResult<PublishedStandaloneDisposition, StandaloneLineageError> {
  if (!dispositions.has(prepared)) return rejectLineage("invalid-disposition", "Publication requires a prepared declaration.");
  const referenceFields = readExactDataRecord(reference, ["locator", "runId", "dispositionDigest"], "disposition publication reference");
  if (!referenceFields.ok) return rejectLineage("invalid-disposition", "Publication reference must contain only own data fields.");
  const parsedReference = standalonePublicationReferenceSchema.safeParse({ locator: referenceFields.value.locator, runId: referenceFields.value.runId, resultDigest: referenceFields.value.dispositionDigest });
  if (!parsedReference.success || parsedReference.data.resultDigest !== prepared.digest) return rejectLineage("invalid-disposition", "Selected publication revision differs from the declaration.");
  const lookup = canonicalRecord({ locator: parsedReference.data.locator, runId: parsedReference.data.runId, dispositionDigest: prepared.digest });
  const observed = read(lookup);
  if (!observed.ok) return rejectLineage("source-unavailable", observed.error.message);
  if (observed.value.recordBytes.byteLength > STANDALONE_LINEAGE_LIMITS.retainedBytes) return rejectLineage("limit-exceeded", "Published disposition exceeds byte budget.");
  const expected = bytes(prepared.record);
  if (expected.length !== observed.value.recordBytes.length || expected.some((byte, index) => byte !== observed.value.recordBytes[index])) return rejectLineage("invalid-disposition", "Published disposition bytes differ from registered declaration.");
  const receipt = parseEffectReceipt(observed.value.receipt);
  if (!receipt.ok || receipt.value.kind !== "artifact-set-published" || receipt.value.runId !== lookup.runId ||
      receipt.value.effectId !== `effect:standalone-disposition:${prepared.digest}` || receipt.value.artifacts.length !== 1) return rejectLineage("invalid-disposition", "Disposition receipt does not match its exact Run/effect.");
  const artifact = receipt.value.artifacts[0];
  if (artifact.runId !== lookup.runId || artifact.slot.path !== "artifacts/disposition.json" || artifact.digest !== prepared.digest || artifact.byteLength !== expected.length) return rejectLineage("invalid-disposition", "Disposition receipt differs from exact published bytes.");
  const published = canonicalRecord({ record: prepared.record, digest: prepared.digest,
    publication: lookup, history: dispositions.get(prepared)! }) as PublishedStandaloneDisposition;
  publishedDispositions.add(published);
  return success(published);
}

function freezeDispositionSelection(selection: StandaloneDispositionSelection): StandaloneDispositionSelection {
  return selection.kind === "selected-record"
    ? canonicalRecord({ kind: "selected-record", disposition: selection.disposition })
    : canonicalRecord({ kind: "historical-decision-unavailable" });
}

/** Read-only publication inventory. References and counts are engine projections, never parent arithmetic. */
export function projectStandaloneLineageSource(source: StandaloneLineageSource, selection: StandaloneDispositionSelection) {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Source inspection requires published source membership.");
  if (selection.kind === "selected-record" && (!publishedDispositions.has(selection.disposition) ||
      !canonicalStructuralEquals(selection.disposition.record.source, source.publication))) {
    return rejectLineage("invalid-disposition", "Source inspection requires the exact selected published disposition.");
  }
  const revisions = selection.kind === "selected-record" ? [...selection.disposition.history, selection.disposition] : [];
  const policies = revisions.map(revision => ({ revision,
    entries: new Map(revision.record.entries.map(entry => [entry.origin, entry] as const)) }));
  const inventory = freeze(source.inventory.map(row => {
    const originReference = standaloneOriginReference(row.origin);
    const finding = findingOf(row);
    const latest = row.history.at(-1);
    const state = match(latest)
      .with(undefined, () => "active" as const)
      .with({ kind: "resolution" }, { kind: "successor-resolution" }, () => "resolved" as const)
      .with({ kind: "adjudication" }, decision => decision.survives ? "active" as const : "refuted" as const)
      .exhaustive();
    const policy = freeze(policies.flatMap(({ revision, entries }) => {
      const entry = entries.get(originReference);
      return entry === undefined ? [] : [canonicalRecord({ publication: revision.publication, digest: revision.digest,
        provenance: revision.record.provenance, ...entry })];
    }));
    return canonicalRecord({ originReference, origin: row.origin, finding, state, history: row.history,
      decisionReferences: freeze(row.history.map(standaloneDecisionReference)), policy });
  }));
  return success(canonicalRecord({ schemaVersion: 1 as const, kind: "standalone-lineage-source" as const,
    source: source.publication, scope: source.scope, reviewers: source.reviewers, snapshot: source.snapshot,
    disposition: freezeDispositionSelection(selection), inventory,
    counts: canonicalRecord({ total: inventory.length,
      survivingCritical: inventory.filter(row => row.finding.severity === "critical" && row.state === "active").length,
      refutedCritical: inventory.filter(row => row.finding.severity === "critical" && row.state === "refuted").length,
      resolved: inventory.filter(row => row.state === "resolved").length,
      advisory: inventory.filter(row => row.finding.severity === "advisory").length }),
    advisoryInventory: freeze(inventory.filter(row => row.finding.severity === "advisory").map(row => canonicalRecord({
      origin: row.originReference, findingId: row.finding.id }))),
  }));
}

const successors = new WeakSet<object>();
/** Read-only custody membership: true only for a value prepareStandaloneSuccessor minted. */
export const isPreparedStandaloneSuccessor = (value: PreparedStandaloneSuccessor): boolean => successors.has(value);

/** Preparation consumes nominal published policy; a prepared but unpublished declaration cannot select policy. */
export function prepareStandaloneSuccessor(source: StandaloneLineageSource, input: Uint8Array,
  disposition: StandaloneDispositionSelection,
): DomainResult<PreparedStandaloneSuccessor, StandaloneLineageError> {
  if (!sources.has(source)) return rejectLineage("source-unavailable", "Successor requires a prepared published predecessor.");
  if (source.reviewHistory.length >= STANDALONE_LINEAGE_LIMITS.historyPerOrigin) return rejectLineage("limit-exceeded", "Successor chain exceeds 64 retained current review generations.");
  const decoded = parseBoundedReviewerJson(input, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage("invalid-data", decoded.error.message);
  if (isRecord(decoded.value) && Array.isArray(decoded.value.snapshot) && decoded.value.snapshot.length > STANDALONE_LINEAGE_LIMITS.paths) {
    return rejectLineage("limit-exceeded", "Successor snapshot exceeds its pre-copy path budget.");
  }
  const selection = standaloneSuccessorSelectionSchema.safeParse(decoded.value);
  if (!selection.success) return rejectLineage("invalid-data", "Successor selection is malformed.");
  const { runId, snapshot, reviewers } = selection.data;
  if (runId === source.publication.runId) return rejectLineage("identity-mismatch", "A successor requires a fresh Run identity.");
  const scope = snapshot.map(row => row.path);
  if (new Set(scope).size !== scope.length || source.scope.some(path => !scope.includes(path)) || snapshot.some(row => row.kind === "historical-unknown")) {
    return rejectLineage("scope-narrowed", "Successor must freeze known bytes/absence for every predecessor path; scope may only expand.");
  }
  if (new Set(reviewers).size !== reviewers.length || source.reviewers.some(role => !reviewers.some(current => current === role))) {
    return rejectLineage("roster-narrowed", "Successor must retain all predecessor reviewer roles without duplicates.");
  }
  if (disposition.kind === "selected-record" && (!publishedDispositions.has(disposition.disposition) ||
      !canonicalStructuralEquals(disposition.disposition.record.source, source.publication))) {
    return rejectLineage("invalid-disposition", "Selected policy must be the exact published revision of this source.");
  }
  const frozenPolicy = freezeDispositionSelection(disposition);
  const snapshotDigest: string = canonicalDigest(snapshot);
  const base = canonicalRecord({ runId, source: source.publication, inventory: source.inventory, disposition: frozenPolicy,
    snapshot, previousSnapshot: source.snapshot, reviewHistory: source.reviewHistory, snapshotDigest, reviewers });
  const successorLineageDigest: string = canonicalDigest(base);
  const minimum = { schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: successorLineageDigest, snapshotDigest: base.snapshotDigest,
    priorAssessments: source.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict: "not-assessable", reason: "x" })), findings: [] };
  if (bytes(minimum).length > STANDALONE_LINEAGE_LIMITS.responseBytes || bytes(base).length > STANDALONE_LINEAGE_LIMITS.retainedBytes) {
    return rejectLineage("limit-exceeded", "Successor lineage or minimum exact coverage exceeds its byte budget.");
  }
  const prepared = canonicalRecord({ ...base, lineageDigest: successorLineageDigest }) as PreparedStandaloneSuccessor;
  successors.add(prepared);
  return success(prepared);
}

function active(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): boolean {
  const policy = prepared.disposition;
  if (policy.kind === "selected-record" && policy.disposition.record.entries.some(entry =>
    entry.origin === standaloneOriginReference(row.origin) && entry.decision === "dismissed")) return false;
  const latest = row.history.at(-1);
  return latest === undefined || (latest.kind === "adjudication" && latest.survives);
}
function decisionReferences(prepared: PreparedStandaloneSuccessor, row: StandaloneLineageRow): readonly string[] {
  const historical = row.history.map(standaloneDecisionReference);
  const policy = prepared.disposition;
  if (policy.kind !== "selected-record") return historical;
  return [...historical, ...[...policy.disposition.history, policy.disposition].filter(revision =>
    revision.record.entries.some(entry => entry.origin === standaloneOriginReference(row.origin))).map(revision => revision.digest)];
}

/** Unknown historical inputs leave relevance a reviewer assertion, not an engine-observed change. */
function changedStandaloneInput(prepared: PreparedStandaloneSuccessor, path: string): "observed-changed" | "historical-unknown" | "unchanged" {
  const current = prepared.snapshot.find(entry => entry.path === path);
  if (current === undefined) return "unchanged";
  const previous = prepared.previousSnapshot.find(entry => entry.path === path);
  if (previous === undefined || previous.kind === "historical-unknown") return "historical-unknown";
  if (current.kind !== previous.kind) return "observed-changed";
  if (current.kind === "present" && previous.kind === "present") {
    // An unobserved mode cannot certify either equality or a mode-only repair.
    return current.digest !== previous.digest || (previous.mode !== null && current.mode !== previous.mode)
      ? "observed-changed" : "unchanged";
  }
  return "unchanged";
}

/** Atomic semantic join; the issued-request layer adds reviewer/request/transcript provenance. */
export function assessStandaloneSuccessor(prepared: PreparedStandaloneSuccessor, payload: StandaloneReviewerPayloadV3): DomainResult<StandaloneReviewerPayloadV3, StandaloneLineageError> {
  if (!successors.has(prepared)) return rejectLineage("source-unavailable", "Assessments require parser-prepared successor data.");
  if (payload.lineageDigest !== prepared.lineageDigest || payload.snapshotDigest !== prepared.snapshotDigest) return rejectLineage("identity-mismatch", "Assessment source/lineage does not match the frozen successor.");
  if (payload.priorAssessments.length !== prepared.inventory.length) return rejectLineage("invalid-assessments", "Every origin requires one assessment in issued order.");
  for (const [index, row] of prepared.inventory.entries()) {
    const assessment = payload.priorAssessments[index];
    if (assessment === undefined || assessment.origin !== standaloneOriginReference(row.origin)) return rejectLineage("invalid-assessments", "Missing, foreign, duplicate or reordered origin assessment.");
    const references = decisionReferences(prepared, row);
    const valid = match(assessment)
      .with({ verdict: "retained" }, value => references.includes(value.decisionDigest))
      .with({ verdict: "reopen" }, value => references.includes(value.proposal.decisionDigest))
      .with({ verdict: "repaired" }, value => active(prepared, row) && changedStandaloneInput(prepared, value.change.path) !== "unchanged")
      .with({ verdict: "still-present" }, () => active(prepared, row))
      .with({ verdict: "not-assessable" }, () => true)
      .exhaustive();
    if (!valid) return rejectLineage("invalid-assessments", "Assessment must respect the exact prior decision and explicitly reopen retired history.");
  }
  const origins = new Set(prepared.inventory.map(row => standaloneOriginReference(row.origin)));
  if (payload.findings.some(row => (row.draft.file !== null && !prepared.snapshot.some(entry => entry.path === row.draft.file)) ||
      (row.relation.kind === "distinct-related" && !origins.has(row.relation.origin)))) return rejectLineage("invalid-assessments", "New Findings require scoped locations and exact distinct-related origins.");
  return success(payload);
}

/** Whole-roster semantic aggregation, never an installable or Refutation Panel authority. */
export function aggregateStandaloneAssessments(prepared: PreparedStandaloneSuccessor,
  reports: readonly Readonly<{ role: string; payload: StandaloneReviewerPayloadV3 }>[],
): DomainResult<readonly StandaloneAssessmentProjection[], StandaloneLineageError> {
  if (!successors.has(prepared)) return rejectLineage("source-unavailable", "Aggregation requires exact prepared successor data.");
  if (reports.length !== prepared.reviewers.length || reports.some((report, index) => report.role !== prepared.reviewers[index])) return rejectLineage("invalid-assessments", "Aggregation requires the complete ordered current roster.");
  for (const report of reports) {
    const assessed = assessStandaloneSuccessor(prepared, report.payload);
    if (!assessed.ok) return assessed;
  }
  return success(freeze(prepared.inventory.map((row, index): StandaloneAssessmentProjection => {
    const assessments = freeze(reports.map(report => report.payload.priorAssessments[index]!));
    const state = match(assessments)
      .when(values => values.some(value => value.verdict === "not-assessable"), () => "coverage-limited" as const)
      .when(values => values.some(value => value.verdict === "reopen"), () => "reopening-required" as const)
      .when(values => values.every(value => value.verdict === "repaired"), () => "resolved" as const)
      .otherwise(() => active(prepared, row) ? "active" as const : "retained" as const);
    return canonicalRecord({ origin: standaloneOriginReference(row.origin), state, assessments });
  })));
}

/** All inventory rows, including retired history, participate. The caller supplies accepted transcript identity. */
export function attributeStandaloneSuccessorFindings(prepared: PreparedStandaloneSuccessor,
  input: Readonly<{ role: string; requestId: string; transcriptDigest: string; payload: StandaloneReviewerPayloadV3 }>,
): DomainResult<readonly StandaloneLineageRow[], StandaloneLineageError> {
  const admitted = assessStandaloneSuccessor(prepared, input.payload);
  if (!admitted.ok) return admitted;
  if (!prepared.reviewers.some(role => role === input.role)) return rejectLineage("identity-mismatch", "Only a current expected reviewer may receive attribution.");
  const highWater = prepared.inventory.reduce((highest, row) => row.origin.role === input.role ? Math.max(highest, row.origin.ordinal) : highest, 0);
  if (input.payload.findings.length > Number.MAX_SAFE_INTEGER - highWater) return rejectLineage("ordinal-exhausted", "Standalone Finding ordinal space is exhausted.");
  if (input.payload.findings.length === 0) return success(freeze([]));
  const origin = parseFindingOrigin({ kind: "current", runId: prepared.runId, requestId: input.requestId,
    transcriptDigest: input.transcriptDigest, role: input.role, ordinal: Math.min(highWater + 1, Number.MAX_SAFE_INTEGER) });
  if (!origin.ok) return origin;
  const findings = attributeFindings(input.payload.findings.map(row => ({ protocolVersion: 2 as const, ...row.draft })), input.role, highWater + 1);
  return success(freeze(findings.map((finding, index) => canonicalRecord({ origin: canonicalRecord({ ...origin.value, ordinal: highWater + index + 1 }),
    finding: storedFinding(finding, origin.value.role), history: freeze([]) }))));
}

// Issued successor admission and aggregation use the same private prepared membership.
const rejected = (message: string): DomainResult<never, ReviewerProtocolFailure> => failure(canonicalRecord({
  kind: "reviewer-protocol-failed", code: "authority-mismatch", path: "/standalone-successor", message,
}));
const subject = (prepared: PreparedStandaloneSuccessor, request: Pick<AgentRequestAuthority, "role" | "attempt">) => canonicalRecord({
  runId: prepared.runId, role: request.role, attempt: request.attempt,
  lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest,
});

/** Independent protocol registration projection; full LC-2 authority also freezes roster and nominal successor. */
export function standaloneSuccessorReviewerRegistration(prepared: PreparedStandaloneSuccessor) {
  return canonicalRecord({ schemaVersion: 3 as const, program: "standalone-review" as const, runId: prepared.runId,
    reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3, lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest });
}

/** Both semantic attempts bind prepared lineage, not the later registration/result digest. */
export function buildStandaloneSuccessorReviewerContext(prepared: PreparedStandaloneSuccessor,
  request: Pick<AgentRequestAuthority, "runId" | "requestId" | "role" | "attempt" | "requiredSkill">,
  variableContext: readonly ByteSection[],
): DomainResult<StandaloneReviewerContextPacketV3, ReviewerProtocolFailure> {
  if (!isPreparedStandaloneSuccessor(prepared) || request.runId !== prepared.runId || !prepared.reviewers.some(role => role === request.role)) {
    return rejected("Successor context requires the exact prepared source and expected reviewer.");
  }
  const authority = encodeByteSection("standalone-successor-authority", JSON.stringify(subject(prepared, request)));
  const lineage = encodeByteSection("standalone-lineage", JSON.stringify(prepared));
  if (!authority.ok || !lineage.ok) return rejected("Prepared lineage could not be encoded.");
  const packet = buildStandaloneReviewerContextPacketV3({ requestId: request.requestId, role: request.role,
    requiredSkill: request.requiredSkill ?? "none", fixedContext: [authority.value, lineage.value], variableContext });
  return packet.ok ? success(packet.value) : rejected(packet.error.message);
}

declare const issuedBrand: unique symbol;
export type IssuedStandaloneSuccessorReviewer = Readonly<{
  [issuedBrand]: true; protocolVersion: 3; request: AgentRequestAuthority;
  packet: StandaloneReviewerContextPacketV3; prepared: PreparedStandaloneSuccessor;
}>;
const issuedProtocols = new WeakSet<object>();

/** Publication membership is re-proved before inspecting untrusted packet/registration data. */
export function parseIssuedStandaloneSuccessorReviewer(input: Readonly<{
  request: SpawnRequest; packet: StandaloneReviewerContextPacketV3; registration: unknown; prepared: PreparedStandaloneSuccessor;
}>): DomainResult<IssuedStandaloneSuccessorReviewer, ReviewerProtocolFailure> {
  const issued = acceptedAgentResult(input.request, null);
  if (!issued.ok || !isPreparedStandaloneSuccessor(input.prepared)) return rejected("Successor admission requires publication-issued request and prepared lineage membership.");
  const request = issued.value.authority;
  const parsed = parseStandaloneReviewerContextPacketV3(input.packet);
  if (!parsed.ok || parsed.value.schemaVersion !== 3) return rejected("Successor admission requires the explicit standalone v3 Context Packet.");
  const packet = parsed.value;
  const expected = standaloneSuccessorReviewerRegistration(input.prepared);
  const registration = readExactDataRecord(input.registration, Object.keys(expected), "standalone successor registration");
  if (!registration.ok || !canonicalStructuralEquals(registration.value, expected) || request.program !== "standalone-review" ||
      request.runId !== input.prepared.runId || packet.requestId !== request.requestId || packet.role !== request.role ||
      packet.requiredSkill !== (request.requiredSkill ?? "none") || packet.digest !== request.contextDigest ||
      input.request.context.digest !== packet.digest || input.request.context.slot.path !== `contexts/${packet.digest}.json`) {
    return rejected("Independent registration, published request and Context Packet must join exactly.");
  }
  const variable = packet.variableContext;
  const rebuilt = buildStandaloneSuccessorReviewerContext(input.prepared, request, variable);
  if (!rebuilt.ok || rebuilt.value.digest !== packet.digest) return rejected("Published Context Packet does not contain the exact prepared lineage and request subject.");
  const authority = canonicalRecord({ protocolVersion: 3 as const, request, packet, prepared: input.prepared }) as IssuedStandaloneSuccessorReviewer;
  issuedProtocols.add(authority);
  return success(authority);
}

const admittedEvidence = new WeakSet<object>();

export function admitStandaloneSuccessorReviewer(authority: IssuedStandaloneSuccessorReviewer,
  raw: Uint8Array,
): DomainResult<AdmittedStandaloneSuccessorEvidence, ReviewerProtocolFailure | StandaloneLineageError> {
  if (!issuedProtocols.has(authority)) return rejected("Successor evidence requires minted issued protocol authority.");
  const parsed = parseStandaloneReviewerPayloadV3(raw);
  if (!parsed.ok) return parsed;
  const assessed = assessStandaloneSuccessor(authority.prepared, parsed.value);
  if (!assessed.ok) return assessed;
  const transcriptDigest = sha256Bytes(raw);
  const findings = attributeStandaloneSuccessorFindings(authority.prepared, { role: authority.request.role,
    requestId: authority.request.requestId, transcriptDigest, payload: assessed.value });
  if (!findings.ok) return findings;
  const evidence = canonicalRecord({ request: authority.request, lineageDigest: authority.prepared.lineageDigest,
    transcriptDigest, payload: assessed.value, newFindings: findings.value }) as AdmittedStandaloneSuccessorEvidence;
  admittedEvidence.add(evidence);
  return success(evidence);
}

/** Current roster only; LC-2 additionally enforces each slot's expected semantic attempt. */
export function aggregateIssuedStandaloneSuccessorEvidence(prepared: PreparedStandaloneSuccessor,
  requests: readonly AgentRequestAuthority[], reports: readonly AdmittedStandaloneSuccessorEvidence[],
): DomainResult<readonly StandaloneAssessmentProjection[], ReviewerProtocolFailure | StandaloneLineageError> {
  if (!isPreparedStandaloneSuccessor(prepared) || reports.length !== requests.length || reports.some(report => !admittedEvidence.has(report))) {
    return rejected("Whole-roster aggregation requires exact admitted evidence membership.");
  }
  if (reports.some((report, index) => report.lineageDigest !== prepared.lineageDigest ||
      !sameAgentRequestAuthority(report.request, requests[index]!))) return rejected("Current evidence does not match the exact expected request/attempt roster.");
  return aggregateStandaloneAssessments(prepared, reports.map(report => ({ role: report.request.role, payload: report.payload })));
}

function successorDispositionState(
  prepared: PreparedStandaloneSuccessor,
  reports: readonly AdmittedStandaloneSuccessorEvidence[],
  row: StandaloneLineageRow,
  index: number,
  provenance: "new" | "inherited",
  panel: ParsedPanelOutcomes | null,
): StandaloneSuccessorLineage["dispositions"][number]["state"] {
  const finding = findingOf(row);
  const reopening = provenance === "inherited" &&
    reports.some(report => report.payload.priorAssessments[index]?.verdict === "reopen");
  if (finding.severity === "critical" && (provenance === "new" || reopening)) {
    const outcome = panel?.outcomes.find(value => value.findingId === `standalone-review:${finding.id}`);
    if (outcome === undefined) return "pending-panel";
    return outcome.survives ? "active" : "refuted";
  }
  if (finding.severity === "advisory" && prepared.disposition.kind === "selected-record" &&
      prepared.disposition.disposition.record.entries.some(entry =>
        entry.origin === standaloneOriginReference(row.origin) && entry.decision === "dismissed")) {
    return "policy-retired";
  }
  const latest = row.history.at(-1);
  if (latest?.kind === "adjudication" && !latest.survives) return "refuted";
  if (latest?.kind === "resolution" || latest?.kind === "successor-resolution") return "resolved";
  return "active";
}

/** Current panel work and history are derived from the exact full-roster admission, not from caller partitions. */
function deriveStandaloneSuccessorLineage(prepared: PreparedStandaloneSuccessor,
  requests: readonly AgentRequestAuthority[], reports: readonly AdmittedStandaloneSuccessorEvidence[],
  panel: ParsedPanelOutcomes | null,
): DomainResult<StandaloneSuccessorLineage, ReviewerProtocolFailure | StandaloneLineageError> {
  const projected = aggregateIssuedStandaloneSuccessorEvidence(prepared, requests, reports);
  if (!projected.ok) return projected;
  const inherited = prepared.inventory.map((row, index): StandaloneLineageRow => {
    const assessment = projected.value[index]!;
    if (assessment.state !== "resolved") return row;
    const assessments = reports.flatMap((report, reportIndex) => {
      const value = report.payload.priorAssessments[index]!;
      if (value.verdict !== "repaired") return [];
      const changedInput = changedStandaloneInput(prepared, value.change.path);
      if (changedInput === "unchanged") return [];
      return [canonicalRecord({ runId: prepared.runId, requestId: report.request.requestId,
        transcriptDigest: report.transcriptDigest, contextDigest: report.request.contextDigest,
        role: prepared.reviewers[reportIndex]!,
        reason: value.reason, change: value.change, changedInput })];
    });
    return canonicalRecord({ ...row, history: Object.freeze([...row.history, canonicalRecord({
      kind: "successor-resolution" as const, publication: canonicalRecord({ kind: "enclosing-publication" as const }),
      runId: prepared.runId, snapshotDigest: prepared.snapshotDigest, assessments: Object.freeze(assessments),
    })]) });
  });
  const all = [...inherited, ...reports.flatMap(report => report.newFindings)];
  const dispositions = all.map((row, index): StandaloneSuccessorLineage["dispositions"][number] => {
    const provenance = index < inherited.length ? "inherited" : "new";
    return canonicalRecord({
      origin: standaloneOriginReference(row.origin),
      provenance,
      state: successorDispositionState(prepared, reports, row, index, provenance, panel),
    });
  });
  const inventory = all.map((row, index): StandaloneLineageRow => {
    if (panel === null || !(dispositions[index]!.provenance === "new" ||
        reports.some(report => report.payload.priorAssessments[index]?.verdict === "reopen"))) return row;
    const outcome = panel.outcomes.find(value => value.findingId === `standalone-review:${row.finding.id}`);
    return outcome === undefined ? row : canonicalRecord({ ...row, history: Object.freeze([...row.history, canonicalRecord({
      kind: "adjudication" as const, publication: canonicalRecord({ kind: "enclosing-publication" as const }),
      lenses: panel.lenses, threshold: panel.threshold, survives: outcome.survives,
      refutations: outcome.refutations, upheldBy: outcome.upheldBy, uncertainFrom: outcome.uncertainFrom,
    })]) });
  });
  if (inventory.length > STANDALONE_LINEAGE_LIMITS.inventory || inventory.some(row => row.history.length > STANDALONE_LINEAGE_LIMITS.historyPerOrigin)) {
    return rejected("Successor inventory/history exceeds its retained budget.");
  }
  const limited = projected.value.filter((value, index) => value.state === "coverage-limited" &&
    findingOf(prepared.inventory[index]!).severity === "critical").map(value => value.origin);
  const count = (state: StandaloneSuccessorLineage["dispositions"][number]["state"], critical = false) =>
    dispositions.filter((value, index) => value.state === state && (!critical || findingOf(inventory[index]!).severity === "critical")).length;
  const [firstLimited, ...remainingLimited] = limited;
  const coverage: StandaloneSuccessorLineage["currentCriticalCoverage"] = firstLimited === undefined
    ? canonicalRecord({ kind: "complete", origins: Object.freeze([]) })
    : canonicalRecord({ kind: "limited", origins: Object.freeze([firstLimited, ...remainingLimited]) });
  return success(canonicalRecord({ inventory: Object.freeze(inventory), reports: Object.freeze([...reports]),
    assessments: projected.value, dispositions: Object.freeze(dispositions),
    currentCriticalCoverage: coverage,
    counts: canonicalRecord({ new: inventory.length - inherited.length, inherited: inherited.length, total: inventory.length,
      survivingCritical: count("active", true), refutedCritical: count("refuted", true), resolved: count("resolved"),
      advisory: inventory.filter(row => findingOf(row).severity === "advisory").length, currentCriticalCoverageLimited: limited.length }),
  }));
}

type AcceptedStandaloneSlot = Readonly<{
  slotId: SlotId;
  requestId: RequestId;
  attempt: 1 | 2;
  /** Canonical payload plus artifact byte identity accepted for this slot. */
  payloadFingerprint: string;
}>;

type PendingStandaloneSlot = Readonly<{
  slotId: SlotId;
  expectedAttempt: 1 | 2;
  /**
   * Why attempt 1 was refused, carried durably so the attempt-2 spawn prompt can
   * name the ACTUAL defect. The rejection diagnostic used to live only in the
   * pass-local `rejected` set of `resumeStandaloneFacade`, so a resume that
   * merely re-issued an already-recorded retry lost it and fell back to a
   * generic message — telling the reviewer to fix its scope when the real defect
   * was a missing Machine Summary block. Always null while `expectedAttempt` is
   * 1; null selects the supported generic fallback when no non-empty diagnostic
   * survived, including but not limited to legacy checkpoints.
   */
  rejectionDiagnostic: string | null;
}>;

interface StandaloneStateBase {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly accepted: readonly AcceptedStandaloneSlot[];
  readonly pending: readonly PendingStandaloneSlot[];
}

type StandalonePreparingState = Readonly<StandaloneStateBase & { kind: "preparing" }>;
type StandaloneAwaitingResultsState = Readonly<StandaloneStateBase & { kind: "awaiting-results" }>;
type StandaloneAggregatingState = Readonly<StandaloneStateBase & {
  kind: "aggregating";
  completion: StandaloneRosterCompletionProof;
}>;
type StandaloneAwaitingRefutationState = Readonly<StandaloneStateBase & {
  kind: "awaiting-refutation";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: FrozenStandalonePanelAuthority;
  refutationAuthority: RefutationPanelAuthority;
}>;
export type StandaloneReadyToFinalizeState = Readonly<StandaloneStateBase & {
  kind: "ready-to-finalize";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panel: ParsedPanelOutcomes | null;
  /** Null when there is no current Refutation Panel work; inherited active criticals may remain. */
  refutationCompletion: StandaloneRefutationCompletionReceipt | null;
  rosterDigest: string;
  reviewerEvidenceDigest: string;
  aggregateDigest: string;
  provenOutcomeDigest: string;
  finalizationDigest: string;
  result: AdjudicatedStandaloneReview;
  publicationIntent: PublishArtifactSet;
}>;

declare class AuthoritativeStandaloneReviewResultMembership {
  private readonly authoritativeStandaloneReviewResultMembership: true;
}

/** Opaque versioned result authority consumed by downstream remediation (T5). */
export type AuthoritativeStandaloneReviewResult =
  AuthoritativeStandaloneReviewResultMembership & AdjudicatedStandaloneReview;

const readyFinalizationCache = new WeakSet<object>();
const authoritativeStandaloneResultCache = new WeakSet<object>();
const standaloneResultPublications = new WeakMap<object, Readonly<{ artifact: ArtifactRef; serialization: string }>>();

export type StandaloneDoneState = Readonly<StandaloneStateBase & {
  kind: "done";
  result: AuthoritativeStandaloneReviewResult;
  outcome: ArtifactRef;
  publicationReceipt: ArtifactSetPublished;
}>;
type StandaloneTerminalBlockedState = Readonly<StandaloneStateBase & {
  kind: "terminal-blocked";
  failed: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: 2; message: string }>;
}>;

type StandaloneRecoverablePredecessor =
  | StandalonePreparingState
  | StandaloneAwaitingResultsState
  | StandaloneAggregatingState
  | StandaloneAwaitingRefutationState
  | StandaloneReadyToFinalizeState;

type StandaloneRecoverableBlockedState = Readonly<StandaloneStateBase & {
  kind: "recoverable-blocked";
  predecessor: StandaloneRecoverablePredecessor;
  diagnostic: InfrastructureRetryDiagnostic;
  expectedIntent: EffectIntent;
  expectedIntentDigest: string;
}>;

export type StandaloneReviewMachineState =
  | StandaloneRecoverablePredecessor
  | StandaloneRecoverableBlockedState
  | StandaloneDoneState
  | StandaloneTerminalBlockedState;

type AuthoritativeStandaloneResultError = Readonly<{
  kind: "standalone-result-authority-rejected";
  message: string;
}>;

const authoritativeResultFailure = (message: string): Readonly<{
  ok: false;
  error: AuthoritativeStandaloneResultError;
}> => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind: "standalone-result-authority-rejected" as const, message }),
});

function prepareResultPublicationIntent(
  result: AdjudicatedStandaloneReview,
): Readonly<{ ok: true; value: PublishArtifactSet }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  const artifact = canonicalStandaloneResultArtifact(result);
  if (!artifact.ok) return authoritativeResultFailure(artifact.error.message);
  if (result.schemaVersion === 3 && artifact.value.byteLength > STANDALONE_LINEAGE_LIMITS.retainedBytes) {
    return authoritativeResultFailure("canonical v3 result exceeds its retained lineage byte budget");
  }
  const effectId = parseEffectId(`effect:standalone-result:${canonicalDigest({
    runId: result.runId,
    artifact: artifact.value,
  })}`);
  if (!effectId.ok) return authoritativeResultFailure(effectId.error.message);
  return canonicalRecord({
    ok: true,
    value: canonicalRecord({
      kind: "publish-artifact-set" as const,
      effectId: effectId.value,
      runId: artifact.value.runId,
      artifacts: Object.freeze([artifact.value]) as readonly [ArtifactRef],
    }),
  });
}

function readyToFinalize(
  state: StandaloneAggregatingState | StandaloneAwaitingRefutationState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "aggregate-clean" | "refutation-completed" }>,
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): StandaloneMachineResult {
  const finalized = finalizeStandaloneReview(aggregate, panel);
  if (!finalized.ok) {
    return rejectTransition(state, event, "aggregate-route-mismatch", finalized.errors.join("; "));
  }
  if (finalized.value.reviewerEvidence.length === 0 ||
      finalized.value.reviewerEvidence.some(({ authorityKind }) => authorityKind !== "request-bound")) {
    return rejectTransition(state, event, "aggregate-route-mismatch",
      `schema-v${aggregate.schemaVersion} finalization requires exact non-empty request-bound reviewer evidence`);
  }
  const publication = prepareResultPublicationIntent(finalized.value);
  if (!publication.ok) {
    return rejectTransition(state, event, "publication-receipt-mismatch", publication.error.message);
  }
  const ready = canonicalRecord({
    ...state,
    kind: "ready-to-finalize" as const,
    aggregate,
    panel: finalized.value.panel,
    refutationCompletion: event.kind === "refutation-completed" ? event.completion : null,
    rosterDigest: state.completion.rosterDigest,
    reviewerEvidenceDigest: canonicalDigest(finalized.value.reviewerEvidence),
    aggregateDigest: canonicalDigest(serializeStandaloneAggregate(aggregate)),
    provenOutcomeDigest: canonicalDigest(panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)),
    finalizationDigest: canonicalDigest(serializeAdjudicatedStandaloneReview(finalized.value)),
    result: finalized.value,
    publicationIntent: publication.value,
  });
  readyFinalizationCache.add(ready);
  return machineSuccess(ready);
}

/**
 * The version-aware result parser requires the opaque ready state produced
 * from roster/panel proof plus the exact engine-issued publication receipt.
 */
export function parseAuthoritativeStandaloneReviewResult(
  ready: StandaloneReadyToFinalizeState,
  rawResult: unknown,
  rawReceipt: unknown,
): Readonly<{ ok: true; value: AuthoritativeStandaloneReviewResult; receipt: ArtifactSetPublished }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  if (typeof ready !== "object" || ready === null || !readyFinalizationCache.has(ready)) {
    return authoritativeResultFailure("schema-v1 result parsing requires an opaque LC-2 ready-to-finalize authority");
  }
  const reaggregated = aggregateStandaloneReview({
    authority: ready.authority,
    completion: ready.completion,
  });
  if (!reaggregated.ok ||
      canonicalDigest(serializeStandaloneAggregate(reaggregated.value.aggregate)) !== ready.aggregateDigest ||
      ready.completion.rosterDigest !== ready.rosterDigest) {
    return authoritativeResultFailure("frozen roster proof or aggregate digest changed before result publication");
  }
  const finalized = finalizeStandaloneReview(ready.aggregate, ready.panel);
  if (!finalized.ok || finalized.value.reviewerEvidence.length === 0 ||
      canonicalDigest(finalized.value.reviewerEvidence) !== ready.reviewerEvidenceDigest ||
      canonicalDigest(ready.panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)) !== ready.provenOutcomeDigest ||
      canonicalDigest(serializeAdjudicatedStandaloneReview(finalized.value)) !== ready.finalizationDigest) {
    return authoritativeResultFailure("proven panel outcome, reviewer evidence, aggregate, or finalization changed before publication");
  }
  let expectedRaw: unknown;
  try {
    expectedRaw = JSON.parse(serializeAdjudicatedStandaloneReview(finalized.value));
  } catch {
    return authoritativeResultFailure(`engine-authored schema-v${ready.authority.schemaVersion} finalization is not canonical JSON`);
  }
  if (!isDeepStrictEqual(rawResult, expectedRaw)) {
    return authoritativeResultFailure(`schema-v${ready.authority.schemaVersion} result bytes do not match the exact independently frozen finalization`);
  }
  const reconciled = reconcileEffectReceipt(ready.publicationIntent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "artifact-set-published") {
    return authoritativeResultFailure(reconciled.ok
      ? "result publication receipt has the wrong effect kind"
      : reconciled.error.message);
  }
  const authoritative = finalized.value as AuthoritativeStandaloneReviewResult;
  authoritativeStandaloneResultCache.add(authoritative);
  standaloneResultPublications.set(authoritative, canonicalRecord({ artifact: ready.publicationIntent.artifacts[0],
    serialization: serializeAdjudicatedStandaloneReview(finalized.value) }));
  return canonicalRecord({ ok: true, value: authoritative, receipt: reconciled.value });
}

export function isAuthoritativeStandaloneReviewResult(
  result: AuthoritativeStandaloneReviewResult,
): boolean {
  return typeof result === "object" && result !== null && authoritativeStandaloneResultCache.has(result);
}

/** Exact publication identity retained by LC-2, not a digest re-authored from supplied result data. */
export function readStandaloneReviewPublication(result: AuthoritativeStandaloneReviewResult, maximumByteLength: number):
  Readonly<{ ok: true; value: ArtifactRef }> | Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  const publication = standaloneResultPublications.get(result);
  if (publication === undefined) return authoritativeResultFailure("standalone source requires LC-2 publication membership");
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 1 || publication.artifact.byteLength > maximumByteLength) {
    return authoritativeResultFailure("standalone source publication exceeds its retained byte budget");
  }
  try {
    if (serializeAdjudicatedStandaloneReview(result) !== publication.serialization) {
      return authoritativeResultFailure("standalone source changed after its original result publication");
    }
    return canonicalRecord({ ok: true, value: publication.artifact });
  } catch {
    return authoritativeResultFailure("standalone source could not be inspected safely");
  }
}

export type StandaloneReviewMachineEvent =
  | Readonly<{ kind: "review-batch-published"; runId: string }>
  | Readonly<{ kind: "result-accepted"; result: AcceptedAgentResult<CapturedReviewerResult> }>
  | Readonly<{
      kind: "result-rejected";
      request: Readonly<{ runId: string; slotId: SlotId; requestId: RequestId; attempt: 1 | 2 }>;
      message: string;
    }>
  | Readonly<{
      kind: "complete-roster-proved";
      completion: StandaloneRosterCompletionProof;
    }>
  | Readonly<{ kind: "aggregate-clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{
      kind: "aggregate-has-criticals";
      aggregate: StandaloneReviewAggregate;
      panelAuthority: FrozenStandalonePanelAuthority;
      refutationAuthority: RefutationPanelAuthority;
    }>
  | Readonly<{
      kind: "refutation-completed";
      completion: StandaloneRefutationCompletionReceipt;
    }>
  | Readonly<{ kind: "result-published"; result: unknown; receipt: ArtifactSetPublished }>
  | Readonly<{
      kind: "recoverable-effect-failed";
      diagnostic: InfrastructureRetryDiagnostic;
      intent: EffectIntent;
    }>
  | Readonly<{ kind: "recovery-receipt-accepted"; receipt: EffectReceipt }>;

type StandaloneMachineError = Readonly<{
  kind:
    | "undeclared-transition"
    | "foreign-run-event"
    | "unknown-slot"
    | "duplicate-result"
    | "stale-attempt"
    | "roster-mismatch"
    | "aggregate-route-mismatch"
    | "publication-receipt-mismatch"
    | "recovery-receipt-mismatch";
  state: StandaloneReviewMachineState["kind"];
  event: StandaloneReviewMachineEvent["kind"];
  message: string;
}>;

type StandaloneMachineResult =
  | Readonly<{ ok: true; value: StandaloneReviewMachineState }>
  | Readonly<{ ok: false; error: StandaloneMachineError }>;

export const STANDALONE_REVIEW_DECLARED_TRANSITIONS = Object.freeze({
  preparing: Object.freeze(["review-batch-published", "recoverable-effect-failed"]),
  "awaiting-results": Object.freeze([
    "result-accepted", "result-rejected", "complete-roster-proved", "recoverable-effect-failed",
  ]),
  aggregating: Object.freeze(["aggregate-clean", "aggregate-has-criticals", "recoverable-effect-failed"]),
  "awaiting-refutation": Object.freeze(["refutation-completed", "recoverable-effect-failed"]),
  "ready-to-finalize": Object.freeze(["result-published", "recoverable-effect-failed"]),
  "recoverable-blocked": Object.freeze(["recoverable-effect-failed", "recovery-receipt-accepted"]),
  done: Object.freeze([]),
  "terminal-blocked": Object.freeze([]),
} as const satisfies Readonly<Record<
  StandaloneReviewMachineState["kind"],
  readonly StandaloneReviewMachineEvent["kind"][]
>>);

export function isDeclaredStandaloneReviewTransition(
  state: StandaloneReviewMachineState["kind"],
  event: StandaloneReviewMachineEvent["kind"],
): boolean {
  return (STANDALONE_REVIEW_DECLARED_TRANSITIONS[state] as readonly string[]).includes(event);
}

const machineSuccess = (value: StandaloneReviewMachineState): StandaloneMachineResult =>
  canonicalRecord({ ok: true, value });

const rejectTransition = (
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
  kind: StandaloneMachineError["kind"],
  message: string,
): StandaloneMachineResult => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind, state: state.kind, event: event.kind, message }),
});

function stateBase(authority: FrozenStandaloneReviewAuthority): StandaloneStateBase {
  return canonicalRecord({
    authority,
    accepted: Object.freeze([]),
    pending: Object.freeze(authority.roster.orderedSlots.map((slot) => canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: 1 as const,
      rejectionDiagnostic: null,
    }))),
  });
}

export function startStandaloneReviewMachine(
  authority: FrozenStandaloneReviewAuthority,
): StandalonePreparingState {
  return canonicalRecord({ kind: "preparing", ...stateBase(authority) });
}

function eventRunId(event: StandaloneReviewMachineEvent): string | null {
  switch (event.kind) {
    case "review-batch-published": return event.runId;
    case "result-accepted": return event.result.authority.runId;
    case "result-rejected": return event.request.runId;
    case "complete-roster-proved": return event.completion.runId;
    case "aggregate-clean":
    case "aggregate-has-criticals": return event.aggregate.runId;
    case "refutation-completed": return typeof event.completion === "object" && event.completion !== null
      ? event.completion.standaloneRunId
      : null;
    case "result-published": return event.receipt.runId;
    case "recoverable-effect-failed": return event.diagnostic.runId;
    case "recovery-receipt-accepted": return event.receipt.runId;
  }
}

function acceptedPayloadMatchesAuthority(
  result: AcceptedAgentResult<CapturedReviewerResult>,
): boolean {
  const parsed = parseCapturedReviewerResult(result.value);
  return parsed.ok && parsed.value.artifact.runId === result.authority.runId &&
    parsed.value.artifact.slot.path === result.authority.outputSlot.path;
}

function rosterAttempt<First, Second>(
  slot: Readonly<{ attempts: readonly [First, Second] }> | undefined,
  attempt: 1 | 2,
): First | Second | undefined {
  return slot?.attempts[attempt - 1];
}

function withAccepted(
  state: StandaloneAwaitingResultsState,
  result: AcceptedAgentResult<CapturedReviewerResult>,
): StandaloneMachineResult {
  const authority = result.authority;
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === authority.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === authority.slotId);
    return rejectTransition(state, { kind: "result-accepted", result }, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? `slot ${authority.slotId} already has an accepted result` : `slot ${authority.slotId} is not in the frozen roster`);
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== authority.attempt) {
    return rejectTransition(state, { kind: "result-accepted", result }, "stale-attempt",
      `slot ${authority.slotId} expects attempt ${pending.expectedAttempt}, received ${authority.attempt}`);
  }
  const slot = state.authority.roster.byId.get(authority.slotId);
  const expected = rosterAttempt(slot, authority.attempt);
  if (expected === undefined || !sameAgentRequestAuthority(authority, expected) || !acceptedPayloadMatchesAuthority(result)) {
    return rejectTransition(state, { kind: "result-accepted", result }, "roster-mismatch",
      "accepted result does not match frozen run/agent/request/context/model/output or artifact authority");
  }
  const remaining = state.pending.filter((_, index) => index !== pendingIndex);
  if (remaining.length === 0) {
    return rejectTransition(state, { kind: "result-accepted", result }, "undeclared-transition",
      "the final result must enter through complete-roster-proved, not result-accepted (incomplete)");
  }
  return machineSuccess(canonicalRecord({
    ...state,
    accepted: Object.freeze([...state.accepted, canonicalRecord({
      slotId: authority.slotId,
      requestId: authority.requestId,
      attempt: authority.attempt,
      payloadFingerprint: fingerprintCapturedReviewerResult(result.value),
    })]),
    pending: Object.freeze(remaining),
  }));
}

function withRejected(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "result-rejected" }>,
): StandaloneMachineResult {
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === event.request.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === event.request.slotId);
    return rejectTransition(state, event, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? "an accepted slot cannot later be rejected" : "rejected result slot is not pending");
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== event.request.attempt) {
    return rejectTransition(state, event, "stale-attempt",
      `slot ${event.request.slotId} expects attempt ${pending.expectedAttempt}, received ${event.request.attempt}`);
  }
  const slot = state.authority.roster.byId.get(event.request.slotId);
  const expected = rosterAttempt(slot, event.request.attempt);
  if (expected === undefined || expected.requestId !== event.request.requestId) {
    return rejectTransition(state, event, "roster-mismatch", "rejected request does not match frozen slot authority");
  }
  const message = event.message.trim();
  if (event.request.attempt === 2) {
    return machineSuccess(canonicalRecord({
      ...state,
      kind: "terminal-blocked",
      failed: canonicalRecord({
        slotId: event.request.slotId,
        requestId: event.request.requestId,
        attempt: 2 as const,
        message: message || "reviewer result failed its second and final semantic attempt",
      }),
    }));
  }
  return machineSuccess(canonicalRecord({
    ...state,
    pending: Object.freeze(state.pending.map((entry, index) => index === pendingIndex
      ? canonicalRecord({
          slotId: entry.slotId,
          expectedAttempt: 2 as const,
          // Durable so EVERY later resume that re-issues this retry can name the
          // real defect, not just the pass that recorded the rejection.
          rejectionDiagnostic: message || null,
        })
      : entry)),
  }));
}

function withCompleteRoster(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "complete-roster-proved" }>,
): StandaloneMachineResult {
  const canonical = aggregateStandaloneReview({
    authority: state.authority,
    completion: event.completion,
  });
  if (!canonical.ok) {
    return rejectTransition(state, event, "roster-mismatch", canonical.errors.join("; "));
  }
  const expectedSlots = state.authority.roster.orderedSlots;
  const proven = event.completion.accepted;
  if (proven.length !== expectedSlots.length) {
    return rejectTransition(state, event, "roster-mismatch", "completion proof length differs from frozen roster");
  }
  const acceptedBySlot = new Map(state.accepted.map((entry) => [entry.slotId, entry] as const));
  for (let index = 0; index < expectedSlots.length; index++) {
    const expectedSlot = expectedSlots[index]!;
    const result = proven[index]!;
    const expectedAttempt = state.pending.find(({ slotId }) => slotId === expectedSlot.slotId)?.expectedAttempt;
    const accepted = acceptedBySlot.get(expectedSlot.slotId);
    if (result.slotId !== expectedSlot.slotId) {
      return rejectTransition(state, event, "roster-mismatch", "completion proof does not preserve canonical slot order");
    }
    if (accepted !== undefined && (
      accepted.requestId !== result.requestId || accepted.attempt !== result.attempt ||
      accepted.payloadFingerprint !== result.payloadFingerprint
    )) {
      return rejectTransition(state, event, "roster-mismatch", "completion proof replaces previously accepted payload or artifact bytes");
    }
    if (accepted === undefined && expectedAttempt !== result.attempt) {
      return rejectTransition(state, event, "stale-attempt", "completion proof uses a stale or unissued semantic attempt");
    }
  }
  return machineSuccess(canonicalRecord({
    kind: "aggregating",
    authority: state.authority,
    accepted: Object.freeze([...proven]),
    pending: Object.freeze([]),
    completion: event.completion,
  }));
}

function recoverable(
  state: StandaloneRecoverablePredecessor | StandaloneRecoverableBlockedState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "recoverable-effect-failed" }>,
): StandaloneMachineResult {
  if (event.diagnostic.runId !== state.authority.runId || event.intent.runId !== state.authority.runId ||
      event.diagnostic.effectId !== event.intent.effectId) {
    return rejectTransition(state, event, "recovery-receipt-mismatch",
      "recoverable diagnostic and failed EffectIntent must identify this exact standalone run/effect");
  }
  if (state.kind === "recoverable-blocked" && JSON.stringify(state.expectedIntent) !== JSON.stringify(event.intent)) {
    return rejectTransition(state, event, "recovery-receipt-mismatch",
      "a repeated recoverable failure cannot replace the exact blocked EffectIntent");
  }
  const predecessor = state.kind === "recoverable-blocked" ? state.predecessor : state;
  return machineSuccess(canonicalRecord({
    kind: "recoverable-blocked",
    authority: state.authority,
    accepted: state.accepted,
    pending: state.pending,
    predecessor,
    diagnostic: event.diagnostic,
    expectedIntent: state.kind === "recoverable-blocked" ? state.expectedIntent : event.intent,
    expectedIntentDigest: state.kind === "recoverable-blocked" ? state.expectedIntentDigest : canonicalDigest(event.intent),
  }));
}

/** Exact LC-2 reducer. Undeclared state/event pairs are rejected, never absorbed. */
export function reduceStandaloneReviewMachine(
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
): StandaloneMachineResult {
  if (!isDeclaredStandaloneReviewTransition(state.kind, event.kind)) {
    return rejectTransition(state, event, "undeclared-transition", `event ${event.kind} is not declared from ${state.kind}`);
  }
  const runId = eventRunId(event);
  if (runId !== null && runId !== state.authority.runId) {
    return rejectTransition(state, event, "foreign-run-event", "event belongs to a stale or foreign standalone run");
  }

  if (event.kind === "recoverable-effect-failed") {
    if (state.kind === "done" || state.kind === "terminal-blocked") {
      return rejectTransition(state, event, "undeclared-transition", "terminal states are monotonic");
    }
    return recoverable(state, event);
  }

  switch (state.kind) {
    case "preparing":
      return event.kind === "review-batch-published"
        ? machineSuccess(canonicalRecord({ ...state, kind: "awaiting-results" }))
        : rejectTransition(state, event, "undeclared-transition", "preparing accepts only review-batch-published or recoverable-effect-failed");

    case "awaiting-results":
      if (event.kind === "result-accepted") return withAccepted(state, event.result);
      if (event.kind === "result-rejected") return withRejected(state, event);
      if (event.kind === "complete-roster-proved") return withCompleteRoster(state, event);
      return rejectTransition(state, event, "undeclared-transition", "awaiting-results received an undeclared event");

    case "aggregating": {
      if (event.kind !== "aggregate-clean" && event.kind !== "aggregate-has-criticals") {
        return rejectTransition(state, event, "undeclared-transition", "aggregating accepts only one aggregate route");
      }
      const canonical = aggregateStandaloneReview({ authority: state.authority, completion: state.completion });
      if (!canonical.ok || serializeStandaloneAggregate(canonical.value.aggregate) !== serializeStandaloneAggregate(event.aggregate)) {
        return rejectTransition(state, event, "roster-mismatch", "aggregate does not match the complete captured reviewer roster");
      }
      const criticals = standaloneCurrentPanelCriticals(event.aggregate);
      if (event.kind === "aggregate-clean" && criticals.length !== 0) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "aggregate-clean requires zero critical findings");
      }
      if (event.kind === "aggregate-has-criticals" && criticals.length === 0) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "aggregate-has-criticals requires at least one critical finding");
      }
      if (event.kind === "aggregate-has-criticals") {
        const reproved = freezeStandaloneRefutationPanelAuthority({
          standaloneAuthority: state.authority,
          aggregate: event.aggregate,
          panelAuthority: event.refutationAuthority,
          threshold: event.panelAuthority.threshold,
        });
        if (!reproved.ok || JSON.stringify(reproved.value) !== JSON.stringify(event.panelAuthority)) {
          return rejectTransition(state, event, "aggregate-route-mismatch",
            "critical route requires persisted T2 authority matching the exact standalone finding brief");
        }
      }
      return event.kind === "aggregate-clean"
        ? readyToFinalize(state, event, event.aggregate, null)
        : machineSuccess(canonicalRecord({
            ...state,
            kind: "awaiting-refutation",
            completion: state.completion,
            aggregate: event.aggregate,
            panelAuthority: event.panelAuthority,
            refutationAuthority: event.refutationAuthority,
          }));
    }

    case "awaiting-refutation":
      if (event.kind !== "refutation-completed") {
        return rejectTransition(state, event, "undeclared-transition", "awaiting-refutation accepts only refutation-completed");
      }
      if (typeof event.completion !== "object" || event.completion === null ||
          !("completedPanelState" in event.completion)) {
        return rejectTransition(state, event, "aggregate-route-mismatch",
          "refutation completion requires a durable completed T2 panel state");
      }
      const completionProof = parseStandaloneRefutationCompletion({
        panelAuthority: state.panelAuthority,
        aggregate: state.aggregate,
        completedPanelState: event.completion.completedPanelState,
      });
      if (!completionProof.ok ||
          JSON.stringify(completionProof.value.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          JSON.stringify(event.completion.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          event.completion.standaloneRunId !== state.authority.runId ||
          event.completion.panelRunId !== state.panelAuthority.panelRunId ||
          event.completion.findingBriefDigest !== state.panelAuthority.findingBriefDigest ||
          event.completion.manifestDigest !== state.panelAuthority.manifestDigest ||
          event.completion.threshold !== state.panelAuthority.threshold ||
          event.completion.outcomeDigest !== completionProof.value.outcomeDigest ||
          event.completion.completedPanelStateDigest !== completionProof.value.completedPanelStateDigest ||
          canonicalDigest(panelOutcomeValue(event.completion.panel)) !== completionProof.value.outcomeDigest) {
        return rejectTransition(state, event, "aggregate-route-mismatch",
          "refutation completion requires the opaque parser-produced receipt for this exact frozen panel authority");
      }
      const canonicalResult = finalizeStandaloneReview(state.aggregate, event.completion.panel);
      if (!canonicalResult.ok) {
        return rejectTransition(state, event, "aggregate-route-mismatch", "completed Refutation Panel cannot finalize the frozen standalone aggregate");
      }
      return readyToFinalize(state, event, state.aggregate, event.completion.panel);

    case "ready-to-finalize":
      if (event.kind !== "result-published") {
        return rejectTransition(state, event, "undeclared-transition", "ready-to-finalize accepts only result-published");
      }
      const published = parseAuthoritativeStandaloneReviewResult(state, event.result, event.receipt);
      if (!published.ok) {
        return rejectTransition(state, event, "publication-receipt-mismatch", published.error.message);
      }
      return machineSuccess(canonicalRecord({
        ...state,
        kind: "done",
        result: published.value,
        outcome: state.publicationIntent.artifacts[0],
        publicationReceipt: published.receipt,
      }));

    case "recoverable-blocked":
      if (event.kind !== "recovery-receipt-accepted") {
        return rejectTransition(state, event, "undeclared-transition", "recoverable-blocked accepts only recovery-receipt-accepted or another recoverable failure");
      }
      if (canonicalDigest(state.expectedIntent) !== state.expectedIntentDigest) {
        return rejectTransition(state, event, "recovery-receipt-mismatch",
          "the blocked EffectIntent changed after it was recorded");
      }
      const recoveryReconciled = reconcileEffectReceipt(state.expectedIntent, event.receipt);
      if (!recoveryReconciled.ok) {
        return rejectTransition(state, event, "recovery-receipt-mismatch",
          `recovery receipt does not reconcile with the exact blocked ${state.expectedIntent.kind} intent: ${recoveryReconciled.error.message}`);
      }
      return machineSuccess(state.predecessor);

    case "done":
    case "terminal-blocked":
      return rejectTransition(state, event, "undeclared-transition", "terminal states are monotonic and reject late input");
  }
}
