/**
 * Standalone Review Run records: the persisted wire forms of the frozen authority, the
 * reviewer-evidence ledger, the aggregate and the adjudicated result; the canonical
 * result artifact identity; and the human summary read model. Pure projections — the
 * exact serialized bytes are what every digest and publication receipt binds.
 */
import { sha256Bytes } from "./digest";
import { reviewFindingCounts } from "./findings";
import { parseRecordedLlmProfileId } from "./model-profiles";
import {
  parseArtifactRef, parseRequestId, parseSlotId, type ArtifactRef, type DomainResult, type SemanticPayloadParseError,
} from "./orchestration-contract";
import { failure, success } from "./orchestration-contract/identity";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { STANDALONE_REVIEW_SUBJECT } from "./reviewer-contract";
import { findingOf, standaloneOriginReference } from "./standalone-finding-origin";
import type {
  AdjudicatedStandaloneReview, FrozenStandaloneReviewAuthority, StandaloneReviewAggregate, StandaloneReviewerEvidence,
} from "./standalone-review-model";
import { STANDALONE_REVIEWER_ROLES, exactKeys, type StandaloneReviewerRole } from "./standalone-review-scope";

export function serializeStandaloneReviewAuthority(authority: FrozenStandaloneReviewAuthority): string {
  return JSON.stringify({
    schema_version: authority.schemaVersion,
    ...(authority.schemaVersion !== 1 ? { reviewer_protocol: authority.reviewerProtocol } : {}),
    ...(authority.schemaVersion === 3 ? { successor: authority.successor } : {}),
    kind: authority.kind,
    run_id: authority.runId,
    scope_source: authority.scopeSource,
    scope: authority.scope,
    scope_safety: authority.scopeSafety,
    changed_paths: {
      unstaged: authority.changedPaths.unstaged,
      staged: authority.changedPaths.staged,
      committed: authority.changedPaths.committed,
      base_revision: authority.changedPaths.baseRevision,
      head_revision: authority.changedPaths.headRevision,
    },
    review_metadata: {
      requested_kinds: authority.reviewMetadata.requestedKinds,
      docs_only: authority.reviewMetadata.docsOnly,
      source_or_test_changed: authority.reviewMetadata.sourceOrTestChanged,
      types_changed: authority.reviewMetadata.typesChanged,
      comments_changed: authority.reviewMetadata.commentsChanged,
      additions: authority.reviewMetadata.additions,
      file_count: authority.reviewMetadata.fileCount,
      new_structure: authority.reviewMetadata.newStructure,
      languages: authority.reviewMetadata.languages,
    },
    reviewers: authority.reviewers,
    roster: authority.roster.orderedSlots,
  }, null, 2);
}

function reviewerEvidenceValue(evidence: StandaloneReviewerEvidence) {
  return {
    authority_kind: evidence.authorityKind,
    agent: evidence.agent,
    slot_id: evidence.slotId,
    request_id: evidence.requestId,
    attempt: evidence.attempt,
    model_profile: evidence.modelProfile,
    context_digest: evidence.contextDigest,
    artifact: evidence.artifact,
  };
}

export function serializeStandaloneAggregate(aggregate: StandaloneReviewAggregate): string {
  return JSON.stringify({
    schema_version: aggregate.schemaVersion,
    ...(aggregate.schemaVersion !== 1 ? { reviewer_protocol: aggregate.reviewerProtocol } : {}),
    ...(aggregate.schemaVersion === 3 ? { successor: aggregate.successor, lineage: aggregate.lineage } : {}),
    run_id: aggregate.runId,
    subject_id: aggregate.subjectId,
    scope: aggregate.scope,
    reviewer_evidence: aggregate.reviewerEvidence.map(reviewerEvidenceValue),
    findings: aggregate.findings,
  }, null, 2);
}

export function parseReviewerEvidence(raw: unknown, runId: string, label: string): ParseResult<readonly StandaloneReviewerEvidence[]> {
  if (raw === undefined) return ok([]); // historical v1 aggregate compatibility
  if (!Array.isArray(raw)) return fail([`${label} must be an array`]);
  const errors: string[] = [];
  const evidence: StandaloneReviewerEvidence[] = [];
  raw.forEach((entry, index) => {
    const path = `${label}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${path} must be an object`); return; }
    errors.push(...exactKeys(entry, ["authority_kind", "agent", "slot_id", "request_id", "attempt", "model_profile", "context_digest", "artifact"], path));
    const artifact = parseArtifactRef(entry.artifact);
    if (!artifact.ok) errors.push(`${path}.artifact: ${artifact.error.message}`);
    if (artifact.ok && artifact.value.runId !== runId) errors.push(`${path}.artifact belongs to another run`);
    if (entry.authority_kind !== "request-bound" && entry.authority_kind !== "legacy-slot-bound") errors.push(`${path}.authority_kind is invalid`);
    if (typeof entry.agent !== "string" || !(STANDALONE_REVIEWER_ROLES as readonly string[]).includes(entry.agent)) errors.push(`${path}.agent is invalid`);
    const slotId = parseSlotId(entry.slot_id);
    if (!slotId.ok) errors.push(`${path}.slot_id: ${slotId.error.message}`);
    const requestId = parseRequestId(entry.request_id);
    if (!requestId.ok) errors.push(`${path}.request_id: ${requestId.error.message}`);
    if (entry.attempt !== 1 && entry.attempt !== 2) errors.push(`${path}.attempt must be 1 or 2`);
    const requestBound = entry.authority_kind === "request-bound";
    // A closed-set id has to be parsed against the allowlist, not merely
    // shape-checked: aggregate.json is untrusted on-disk input, and a bare cast
    // would type an off-roster string as a member of LLM_PROFILE_IDS.
    const modelProfile = requestBound ? parseRecordedLlmProfileId(entry.model_profile) : null;
    if (modelProfile !== null && !modelProfile.ok) errors.push(`${path}.model_profile: ${modelProfile.error.message}`);
    if (!requestBound && entry.model_profile !== null) errors.push(`${path}.model_profile must be null for legacy evidence`);
    if (requestBound && (typeof entry.context_digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.context_digest))) errors.push(`${path}.context_digest must be a SHA-256 digest for request-bound evidence`);
    if (!requestBound && entry.context_digest !== null) errors.push(`${path}.context_digest must be null for legacy evidence`);
    if (artifact.ok && typeof entry.agent === "string" && slotId.ok && requestId.ok &&
        (entry.attempt === 1 || entry.attempt === 2) && (entry.authority_kind === "request-bound" || entry.authority_kind === "legacy-slot-bound") &&
        (modelProfile === null || modelProfile.ok)) {
      evidence.push(Object.freeze({
        authorityKind: entry.authority_kind,
        agent: entry.agent as StandaloneReviewerRole,
        slotId: slotId.value,
        requestId: requestId.value,
        attempt: entry.attempt,
        modelProfile: modelProfile === null ? null : modelProfile.value,
        contextDigest: requestBound ? entry.context_digest as string : null,
        artifact: artifact.value,
      }));
    }
  });
  for (const field of ["agent", "slotId", "requestId"] as const) {
    const values = evidence.map((entry) => entry[field]);
    if (new Set(values).size !== values.length) errors.push(`${label}.${field} values must be distinct`);
  }
  const slots = evidence.map(({ artifact }) => artifact.slot.path);
  if (new Set(slots).size !== slots.length) errors.push(`${label} artifact slots must be distinct`);
  return errors.length > 0 ? fail(errors) : ok(Object.freeze(evidence));
}

export function serializeAdjudicatedStandaloneReview(result: AdjudicatedStandaloneReview): string {
  return JSON.stringify({
    schema_version: result.schemaVersion,
    ...(result.schemaVersion !== 1 ? { reviewer_protocol: result.reviewerProtocol } : {}),
    ...(result.schemaVersion === 3 ? { successor: result.successor, lineage: result.lineage } : {}),
    run_id: result.runId,
    subject_id: STANDALONE_REVIEW_SUBJECT,
    scope: result.scope,
    reviewer_evidence: result.reviewerEvidence.map(reviewerEvidenceValue),
    surviving_critical_findings: result.survivingCriticals,
    advisory_findings: result.advisories,
    refuted_critical_findings: result.refutedCriticals,
    panel: result.panel === null ? null : {
      lenses: result.panel.lenses,
      threshold: result.panel.threshold,
      surviving: result.panel.outcomes.filter(({ survives }) => survives).length,
      refuted: result.panel.outcomes.filter(({ survives }) => !survives).length,
      outcomes: result.panel.outcomes.map((outcome) => ({
        finding_id: outcome.findingId,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: outcome.claim,
        survives: outcome.survives,
        refuted_by: outcome.refutations.map(({ lens }) => lens),
        reasoning: outcome.refutations.map(({ reason }) => reason),
        upheld_by: outcome.upheldBy,
        uncertain_from: outcome.uncertainFrom,
      })),
    },
  }, null, 2);
}

/** Legacy helper output stays explicitly unversioned and never claims v1 authority. */
export function serializeHistoricalAdjudicatedStandaloneReview(result: Extract<AdjudicatedStandaloneReview, { schemaVersion: 1 }>): string {
  const versioned = JSON.parse(serializeAdjudicatedStandaloneReview(result)) as Record<string, unknown>;
  const {
    schema_version: _schemaVersion,
    subject_id: _subjectId,
    reviewer_evidence: _reviewerEvidence,
    ...historical
  } = versioned;
  return JSON.stringify(historical, null, 2);
}

function summaryData(value: unknown): string {
  return JSON.stringify(value).replace(/[&<>|`]/g, (character) => `&#${character.codePointAt(0)};`)
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)
    .replace(/([*_\[\]\\])/g, "\\$1");
}

function renderStandaloneSuccessorSummary(result: Extract<AdjudicatedStandaloneReview, { schemaVersion: 3 }>): string {
  const { counts, currentCriticalCoverage, inventory, dispositions } = result.lineage;
  const policy = result.successor.disposition;
  return [
    `Standalone successor: ${counts.new} new; ${counts.inherited} inherited; ${counts.total} total Findings.`,
    `Current dispositions: ${counts.survivingCritical} surviving critical; ${counts.refutedCritical} refuted critical; ${counts.resolved} resolved; ${counts.advisory} advisory.`,
    `Current critical coverage: ${currentCriticalCoverage.kind}; ${counts.currentCriticalCoverageLimited} limited origins.`,
    "Advisory policy is DECLARED; Repair-Checked is not semantic resolution. Original assertions and historical decisions remain retained.", "",
    "| State | Provenance | ID | Origin | Original Run | Severity | Location | Claim | Advisory policy |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...inventory.map((row, index) => {
      const finding = findingOf(row);
      const origin = standaloneOriginReference(row.origin);
      const decision = policy.kind === "selected-record" ? policy.disposition.record.entries.find(entry => entry.origin === origin) : undefined;
      return `| ${dispositions[index]!.state} | ${dispositions[index]!.provenance} | ${summaryData(finding.id)} | ${origin} | ${summaryData(row.origin.runId)} | ${finding.severity} | ${summaryData({ file: finding.file, line: finding.line })} | ${summaryData(finding.claim)} | ${summaryData(decision ?? policy.kind)} |`;
    }), "",
    ...inventory.map(row => `${summaryData(row.finding.id)} retained detail: ${summaryData({ origin: row.origin,
      finding: row.finding, history: row.history, assessment: result.lineage.assessments.find(entry => entry.origin === standaloneOriginReference(row.origin)) ?? null })}`),
  ].join("\n");
}

/** Human read model only: emitted and surviving counts have distinct, derived meanings. */
export function renderStandaloneReviewSummary(result: AdjudicatedStandaloneReview): string {
  if (result.schemaVersion === 3) return renderStandaloneSuccessorSummary(result);
  const rows = [
    ...result.survivingCriticals.map((finding) => ({ disposition: "surviving", finding })),
    ...result.refutedCriticals.map(({ finding }) => ({ disposition: "refuted", finding })),
    ...result.advisories.map((finding) => ({ disposition: "advisory", finding })),
  ];
  const counts = reviewFindingCounts(rows.map(({ finding }) => finding));
  return [
    `Emitted/admitted: ${counts.critical} critical; ${counts.advisory} advisory.`,
    `After refutation: ${result.survivingCriticals.length} surviving critical; ${result.refutedCriticals.length} refuted critical; ${result.advisories.length} advisory.`,
    "", "| Disposition | ID | Reviewer | Severity | Location | Claim |", "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(({ disposition, finding }) =>
      `| ${disposition} | ${summaryData(finding.id)} | ${summaryData(finding.agent)} | ${finding.severity} | ${summaryData({ file: finding.file, line: finding.line })} | ${summaryData(finding.claim)} |`),
    "",
    ...rows.flatMap(({ finding }) => finding.protocolVersion !== 2 ? [] : [
      `${summaryData(finding.id)} detail: ${summaryData(finding.severity === "critical"
        ? { basis: finding.basis } : { reason: finding.reason, basis: finding.basis })}`,
    ]),
  ].join("\n");
}

export const STANDALONE_RESULT_SLOT = "result.json" as const;

export function canonicalStandaloneResultArtifact(
  result: AdjudicatedStandaloneReview,
): DomainResult<ArtifactRef, SemanticPayloadParseError> {
  const bytes = Buffer.from(serializeAdjudicatedStandaloneReview(result), "utf-8");
  const artifact = parseArtifactRef({
    runId: result.runId,
    slot: STANDALONE_RESULT_SLOT,
    digest: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  });
  return artifact.ok
    ? success(artifact.value)
    : failure({ message: `canonical standalone result artifact is invalid: ${artifact.error.message}` });
}
