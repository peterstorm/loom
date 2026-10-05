/**
 * The Standalone Review's Refutation Panel read side: the canonical critical-Finding
 * brief, the independently frozen panel read authority, the current panel work, and
 * the tally parser that proves exact critical coverage. Completion authority (the T2
 * receipt) is minted separately by standalone-refutation-completion.
 */
import { canonicalDigest } from "./digest";
import type { Finding } from "./findings";
import {
  canonicalRecord, parseArtifactDigest, parseOrchestrationRunId,
  type ArtifactDigest, type DomainResult, type NonEmpty, type OrchestrationRunId,
} from "./orchestration-contract";
import { failure, success } from "./orchestration-contract/identity";
import { fail, isRecord, ok, sanitizeProse, type ParseResult } from "./panel-kernel";
import { projectFindingForPanel, type BriefFinding } from "./review-panel";
import { STANDALONE_REVIEW_SUBJECT } from "./reviewer-contract";
import { findingOf } from "./standalone-finding-origin";
import type {
  AdmittedStandaloneSuccessorEvidence, PanelRefutation, ParsedPanelOutcome, ParsedPanelOutcomes, StandaloneReviewAggregate,
} from "./standalone-review-model";
import { exactKeys } from "./standalone-review-scope";

/** Canonical defensive copy used at every panel/finalization boundary. */
export function canonicalStandalonePanelOutcomes(panel: ParsedPanelOutcomes): ParseResult<ParsedPanelOutcomes> {
  const errors: string[] = [];
  const outcomes = panel.outcomes.flatMap((outcome, index): ParsedPanelOutcome[] => {
    const refutations = Object.freeze(outcome.refutations.map(({ lens, reason }) =>
      Object.freeze({ lens, reason })));
    const base = {
      findingId: outcome.findingId,
      claim: outcome.claim,
      upheldBy: Object.freeze([...outcome.upheldBy]),
      uncertainFrom: Object.freeze([...outcome.uncertainFrom]),
    };
    if (outcome.survives) {
      return [Object.freeze({ ...base, survives: true as const, refutations })];
    }
    const [head, ...tail] = refutations;
    if (head === undefined) {
      errors.push(`panel.outcomes[${index}] refuted outcome requires non-empty refutations`);
      return [];
    }
    return [Object.freeze({
      ...base,
      survives: false as const,
      refutations: Object.freeze([head, ...tail]) as NonEmpty<PanelRefutation>,
    })];
  });
  return errors.length > 0
    ? fail(errors)
    : ok(Object.freeze({
        lenses: Object.freeze([...panel.lenses]),
        threshold: panel.threshold,
        outcomes: Object.freeze(outcomes),
      }));
}

export type StandalonePanelFindingAuthority = Extract<BriefFinding, { protocolVersion: 2 }> | Readonly<{
  protocolVersion?: never;
  basis?: never;
  reason?: never;
  id: string;
  taskId: typeof STANDALONE_REVIEW_SUBJECT;
  agent: string;
  severity: "critical";
  file: string | null;
  line: number | null;
  claim: string;
}>;

/**
 * Independently frozen expectation for a standalone Refutation Panel. This is
 * read authority, not completion authority: LC-2 additionally requires a T2
 * parser-produced completed panel receipt before it can leave refutation.
 */
export type FrozenStandalonePanelAuthority = (
  | Readonly<{ schemaVersion: 1 | 2 }>
  | Readonly<{ schemaVersion: 3; successorEvidence: Readonly<{
      lineageDigest: string; snapshotDigest: string; reports: readonly AdmittedStandaloneSuccessorEvidence[];
    }> }>
) & Readonly<{
  kind: "frozen-standalone-panel-authority";
  standaloneRunId: OrchestrationRunId;
  panelRunId: OrchestrationRunId;
  findings: NonEmpty<StandalonePanelFindingAuthority>;
  findingBriefDigest: ArtifactDigest;
  lenses: NonEmpty<string>;
  manifestDigest: ArtifactDigest;
  threshold: number;
}>;

type StandalonePanelAuthorityError = Readonly<{
  kind: "standalone-panel-authority-rejected";
  message: string;
}>;

interface FreezeStandalonePanelAuthorityInput {
  readonly standaloneRunId: unknown;
  readonly panelRunId: unknown;
  readonly aggregate: StandaloneReviewAggregate;
  readonly panelFindings: unknown;
  readonly lenses: unknown;
  readonly manifestDigest: unknown;
  readonly threshold: unknown;
}

function parseStringArray(raw: unknown, path: string, errors: string[]): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${path} must be an array containing only non-empty strings`);
    return [];
  }
  return raw.map((entry) => (entry as string).trim());
}

const UNUSABLE_PANEL_CLAIM = "(finding text was unusable after sanitization — see the task's critical_findings)";

export function canonicalStandalonePanelFindingAuthority(
  criticals: readonly Finding[],
): readonly StandalonePanelFindingAuthority[] {
  return Object.freeze(criticals.map((finding): StandalonePanelFindingAuthority => {
    if (finding.protocolVersion === 2) {
      const projected = projectFindingForPanel(STANDALONE_REVIEW_SUBJECT, finding);
      if (projected.protocolVersion !== 2) throw new Error("current panel projection lost its protocol invariant");
      return projected;
    }
    return Object.freeze({
    id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
    taskId: STANDALONE_REVIEW_SUBJECT,
    agent: sanitizeProse(finding.agent),
    severity: "critical" as const,
    // Sanitized for the same reason as `claim`: this record is substituted into
    // verifier prompts, and a path is just as much reviewer-controlled text as
    // the claim beside it. Mirrors `buildFindingBrief` in core/review-panel.
    file: finding.file === null ? null : sanitizeProse(finding.file) || null,
    line: finding.line,
    claim: sanitizeProse(finding.claim) || UNUSABLE_PANEL_CLAIM,
    });
  }));
}

export function canonicalStandalonePanelFindings(
  criticals: readonly Finding[],
): readonly Readonly<{ id: string; claim: string }>[] {
  return Object.freeze(canonicalStandalonePanelFindingAuthority(criticals).map(({ id, claim }) =>
    Object.freeze({ id, claim })));
}

/**
 * Freeze lens/threshold/brief/manifest expectations independently from a
 * serialized result. Callers cannot use result.panel.lenses as this input.
 */
export function freezeStandalonePanelAuthority(
  input: FreezeStandalonePanelAuthorityInput,
): DomainResult<FrozenStandalonePanelAuthority, StandalonePanelAuthorityError> {
  const standaloneRunId = parseOrchestrationRunId(input.standaloneRunId);
  const panelRunId = parseOrchestrationRunId(input.panelRunId);
  const manifestDigest = parseArtifactDigest(input.manifestDigest);
  const criticals = standaloneCurrentPanelCriticals(input.aggregate);
  const expectedFindings = canonicalStandalonePanelFindingAuthority(criticals);
  const errors: string[] = [];
  if (!standaloneRunId.ok) errors.push(standaloneRunId.error.message);
  if (!panelRunId.ok) errors.push(panelRunId.error.message);
  if (!manifestDigest.ok) errors.push(manifestDigest.error.message);
  if (standaloneRunId.ok && input.aggregate.runId !== standaloneRunId.value) {
    errors.push("panel authority aggregate belongs to another standalone run");
  }
  if (expectedFindings.length === 0) errors.push("panel authority requires at least one canonical critical finding");
  if (!Array.isArray(input.panelFindings) || JSON.stringify(input.panelFindings) !== JSON.stringify(expectedFindings)) {
    errors.push("panel authority findings must exactly match the frozen standalone critical finding brief");
  }
  const lenses = Array.isArray(input.lenses) && input.lenses.every((lens) =>
    typeof lens === "string" && lens.trim() === lens && lens.length > 0)
    ? input.lenses as readonly string[]
    : [];
  if (lenses.length === 0 || new Set(lenses).size !== lenses.length) {
    errors.push("panel authority lenses must be a non-empty distinct ordered roster");
  }
  const floor = Math.floor(lenses.length / 2) + 1;
  if (!Number.isInteger(input.threshold) || (input.threshold as number) < floor ||
      (input.threshold as number) > lenses.length) {
    errors.push(`panel authority threshold must be an integer from strict-majority floor ${floor} through ${lenses.length}`);
  }
  const [firstFinding, ...otherFindings] = expectedFindings;
  const [firstLens, ...otherLenses] = lenses;
  if (errors.length > 0 || !standaloneRunId.ok || !panelRunId.ok || !manifestDigest.ok ||
      firstFinding === undefined || firstLens === undefined) {
    return failure(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: errors.join("; ") || "standalone panel authority is invalid",
    }));
  }
  const authority = canonicalRecord({
    ...(input.aggregate.schemaVersion === 3 ? { schemaVersion: 3 as const, successorEvidence: canonicalRecord({
      lineageDigest: input.aggregate.successor.lineageDigest, snapshotDigest: input.aggregate.successor.snapshotDigest,
      reports: input.aggregate.lineage.reports,
    }) } : { schemaVersion: input.aggregate.schemaVersion }),
    kind: "frozen-standalone-panel-authority" as const,
    standaloneRunId: standaloneRunId.value,
    panelRunId: panelRunId.value,
    findings: Object.freeze([firstFinding, ...otherFindings]) as NonEmpty<StandalonePanelFindingAuthority>,
    findingBriefDigest: canonicalDigest(expectedFindings),
    lenses: Object.freeze([firstLens, ...otherLenses]) as NonEmpty<string>,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold as number,
  });
  return success(authority);
}

/** Reparse persisted panel read authority against the immutable aggregate artifact. */
export function parseFrozenStandalonePanelAuthority(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
): DomainResult<FrozenStandalonePanelAuthority, StandalonePanelAuthorityError> {
  if (!isRecord(raw) || raw.schemaVersion !== aggregate.schemaVersion || raw.kind !== "frozen-standalone-panel-authority") {
    return failure(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: "persisted standalone panel authority is malformed",
    }));
  }
  const parsed = freezeStandalonePanelAuthority({
    standaloneRunId: raw.standaloneRunId,
    panelRunId: raw.panelRunId,
    aggregate,
    panelFindings: raw.findings,
    lenses: raw.lenses,
    manifestDigest: raw.manifestDigest,
    threshold: raw.threshold,
  });
  if (!parsed.ok) return parsed;
  if (raw.findingBriefDigest !== parsed.value.findingBriefDigest ||
      JSON.stringify(raw) !== JSON.stringify(parsed.value)) {
    return failure(canonicalRecord({
      kind: "standalone-panel-authority-rejected" as const,
      message: "persisted standalone panel authority does not match the canonical finding brief",
    }));
  }
  return parsed;
}

/** Parse the review-panel's serialized tally and prove exact critical coverage. */
export function parseStandalonePanelOutcomes(
  raw: unknown,
  criticals: readonly Finding[],
  panelFindings: readonly { readonly id: string; readonly claim: string }[],
  expectedLenses: readonly string[],
): ParseResult<ParsedPanelOutcomes> {
  if (!isRecord(raw)) return fail(["standalone panel outcomes must be an object"]);
  const errors: string[] = exactKeys(raw, ["lenses", "threshold", "surviving", "refuted", "outcomes"], "outcomes");
  const lenses = parseStringArray(raw.lenses, "outcomes.lenses", errors);
  if (new Set(lenses).size !== lenses.length) errors.push("outcomes.lenses must be distinct");
  if (lenses.length !== expectedLenses.length || lenses.some((lens, index) => lens !== expectedLenses[index])) {
    errors.push("outcomes.lenses must exactly match the validated manifest lenses in order");
  }
  const threshold = Number.isInteger(raw.threshold) ? raw.threshold as number : 0;
  const majority = Math.floor(lenses.length / 2) + 1;
  if (threshold < majority || threshold > lenses.length) errors.push("outcomes.threshold must be at least a strict majority and no greater than the lens count");
  if (!Array.isArray(raw.outcomes)) return fail([...errors, "outcomes.outcomes must be an array"]);
  const expected = new Map(criticals.map((finding) => [`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`, finding]));
  const canonicalPanelFindings = canonicalStandalonePanelFindings(criticals);
  const canonicalPanelClaims = new Map(canonicalPanelFindings.map((finding) => [finding.id, finding.claim] as const));
  const expectedPanelClaims = new Map(panelFindings.map((finding) => [finding.id, finding.claim] as const));
  if (expectedPanelClaims.size !== panelFindings.length) errors.push("panel findings must have distinct ids");
  if (panelFindings.length !== canonicalPanelFindings.length || panelFindings.some((finding) =>
    canonicalPanelClaims.get(finding.id) !== finding.claim)) {
    errors.push("panel findings must exactly match claims derived from canonical critical dispositions");
  }
  const expectedIds = [...expected.keys()];
  const panelIds = panelFindings.map((finding) => finding.id);
  if (panelIds.length !== expectedIds.length || panelIds.some((id) => !expected.has(id)) || expectedIds.some((id) => !expectedPanelClaims.has(id))) {
    errors.push("panel findings must exactly cover aggregate critical finding ids");
  }
  const outcomes: ParsedPanelOutcome[] = [];
  for (const [index, entry] of raw.outcomes.entries()) {
    const path = `outcomes.outcomes[${index}]`;
    if (!isRecord(entry)) { errors.push(`${path} must be an object`); continue; }
    errors.push(...exactKeys(entry, [
      "finding_id", "task_id", "claim", "survives", "refuted_by", "reasoning", "upheld_by", "uncertain_from",
    ], path));
    const findingId = typeof entry.finding_id === "string" ? entry.finding_id.trim() : "";
    const finding = expected.get(findingId);
    if (entry.task_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`${path}.task_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
    if (!finding) errors.push(`${path}.finding_id is not an expected critical: ${findingId || "<empty>"}`);
    let claim = typeof entry.claim === "string" ? entry.claim : "";
    if (finding?.protocolVersion !== 2) claim = claim.trim();
    const expectedPanelClaim = expectedPanelClaims.get(findingId);
    if (finding && expectedPanelClaim !== undefined && claim !== expectedPanelClaim) errors.push(`${path}.claim does not match canonical panel finding ${findingId}`);
    if (typeof entry.survives !== "boolean") errors.push(`${path}.survives must be boolean`);
    const refutedBy = parseStringArray(entry.refuted_by, `${path}.refuted_by`, errors);
    const reasoning = parseStringArray(entry.reasoning, `${path}.reasoning`, errors);
    const upheldBy = parseStringArray(entry.upheld_by, `${path}.upheld_by`, errors);
    const uncertainFrom = parseStringArray(entry.uncertain_from, `${path}.uncertain_from`, errors);
    if (refutedBy.length !== reasoning.length) errors.push(`${path} refuted_by/reasoning lengths must match`);
    const votes = [...refutedBy, ...upheldBy, ...uncertainFrom];
    if (new Set(votes).size !== votes.length) errors.push(`${path} lens votes must be distinct across all verdict kinds`);
    if (votes.length !== lenses.length || votes.some((lens) => !lenses.includes(lens))) errors.push(`${path} must account for every panel lens exactly once`);
    if (entry.survives === false && refutedBy.length < threshold) errors.push(`${path} refuted finding must meet threshold`);
    if (entry.survives === true && refutedBy.length >= threshold) errors.push(`${path} surviving finding must be below threshold`);
    const refutations = refutedBy.map((lens, refutationIndex) => ({ lens, reason: reasoning[refutationIndex] ?? "" }));
    if (entry.survives === true) outcomes.push({ findingId, claim, survives: true, refutations, upheldBy, uncertainFrom });
    else {
      const [head, ...tail] = refutations;
      if (head === undefined) errors.push(`${path} refuted finding must carry at least one refutation`);
      else outcomes.push({ findingId, claim, survives: false, refutations: [head, ...tail], upheldBy, uncertainFrom });
    }
  }
  const ids = outcomes.map(({ findingId }) => findingId);
  if (new Set(ids).size !== ids.length) errors.push("panel outcome finding ids must be distinct");
  for (const id of expected.keys()) if (!ids.includes(id)) errors.push(`panel outcomes are missing critical finding: ${id}`);
  if (outcomes.length !== expected.size) errors.push(`panel outcomes must contain exactly ${expected.size} critical findings`);
  const surviving = outcomes.filter((outcome) => outcome.survives).length;
  const refuted = outcomes.length - surviving;
  if (raw.surviving !== surviving) errors.push(`outcomes.surviving must equal derived count ${surviving}`);
  if (raw.refuted !== refuted) errors.push(`outcomes.refuted must equal derived count ${refuted}`);
  if (errors.length > 0) return fail(errors);
  return canonicalStandalonePanelOutcomes({ lenses, threshold, outcomes });
}

/** Only new criticals and evidence-bound reopening proposals belong to the current panel. */
export function standaloneCurrentPanelCriticals(aggregate: StandaloneReviewAggregate): readonly Finding[] {
  if (aggregate.schemaVersion !== 3) return aggregate.findings.filter(finding => finding.severity === "critical");
  return aggregate.lineage.inventory.flatMap((row, index) => aggregate.lineage.dispositions[index]!.state === "pending-panel" ? [findingOf(row)] : []);
}

/** The digest preimage of proven panel outcomes, shared by completion receipts and finalization. */
export function panelOutcomeValue(panel: ParsedPanelOutcomes): unknown {
  return {
    lenses: panel.lenses,
    threshold: panel.threshold,
    outcomes: panel.outcomes.map((outcome) => ({
      findingId: outcome.findingId,
      claim: outcome.claim,
      survives: outcome.survives,
      refutations: outcome.refutations,
      upheldBy: outcome.upheldBy,
      uncertainFrom: outcome.uncertainFrom,
    })),
  };
}
