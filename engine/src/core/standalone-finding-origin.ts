/**
 * Finding Origin: the immutable identity of one originally attributed Finding, and the
 * bounded lineage-inventory rows that carry it. Pure data reads and content references,
 * never authority — a parsed inventory cannot stand in for an authenticated source.
 */
import { match } from "ts-pattern";
import { canonicalDigest } from "./digest";
import type { Finding } from "./findings";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { canonicalRecord, failure, success, type DomainResult } from "./orchestration-contract/identity";
import { isRecord } from "./panel-kernel";
import { parseBoundedReviewerJson } from "./reviewer-protocol";
import {
  STANDALONE_LINEAGE_LIMITS, findingOriginSchema, standaloneLineageInventorySchema,
  type FindingOrigin, type StandaloneLineageRow,
} from "./standalone-lineage-contract";

/** Every lineage refusal: a closed code plus a bounded diagnostic. */
export type StandaloneLineageError = Readonly<{
  kind: "standalone-lineage-rejected";
  code: "invalid-data" | "limit-exceeded" | "source-unavailable" | "identity-mismatch" | "invalid-history" |
    "invalid-disposition" | "scope-narrowed" | "roster-narrowed" | "invalid-assessments" | "ordinal-exhausted";
  message: string;
}>;
export const rejectLineage = (code: StandaloneLineageError["code"], message: string): DomainResult<never, StandaloneLineageError> =>
  failure(canonicalRecord({ kind: "standalone-lineage-rejected", code, message }));

/** Content reference, not authority; current origins have no forward result-digest reference. */
export const standaloneOriginReference = (origin: FindingOrigin): string => origin.kind === "published" ? canonicalDigest(origin) : canonicalDigest({ kind: "current",
  runId: origin.runId, requestId: origin.requestId, transcriptDigest: origin.transcriptDigest,
  role: origin.role, ordinal: origin.ordinal });
export const standaloneDecisionReference = (decision: StandaloneLineageRow["history"][number]): string => canonicalDigest(decision);

export function parseFindingOrigin(raw: unknown): DomainResult<FindingOrigin, StandaloneLineageError> {
  const inspected = readExactDataRecord(raw, ["kind", "runId", "requestId", "transcriptDigest", "role", "ordinal", "publication"], "Finding Origin");
  if (!inspected.ok) return rejectLineage("invalid-data", "Finding Origin must contain only own data fields.");
  const value = inspected.value;
  const publication = value.kind === "published" || value.kind === "published-successor"
    ? readExactDataRecord(value.publication, ["locator", "runId", "resultDigest"], "original publication") : success(undefined);
  if (!publication.ok) return rejectLineage("invalid-data", "Original publication must contain only own data fields.");
  const parsed = findingOriginSchema.safeParse(value.kind !== "current" ? { ...value, publication: publication.value } : value);
  if (!parsed.success) return rejectLineage("invalid-data", "Finding Origin is malformed.");
  if (parsed.data.kind !== "current" && parsed.data.runId !== parsed.data.publication.runId) {
    return rejectLineage("identity-mismatch", "Origin and original publication must name the same Run.");
  }
  return success(parsed.data);
}

function historyProblem(row: StandaloneLineageRow): boolean {
  return row.history.some(decision => match(decision)
    .with({ kind: "adjudication" }, value => {
      const votes = [...value.refutations.map(vote => vote.lens), ...value.upheldBy, ...value.uncertainFrom];
      return findingOf(row).severity !== "critical" || new Set(value.lenses).size !== value.lenses.length ||
        new Set(votes).size !== votes.length || votes.length !== value.lenses.length ||
        votes.some(lens => !value.lenses.includes(lens)) ||
        value.threshold < Math.floor(value.lenses.length / 2) + 1 || value.threshold > value.lenses.length ||
        value.survives !== (value.refutations.length < value.threshold);
    })
    .with({ kind: "resolution" }, { kind: "successor-resolution" }, value => new Set(value.assessments.map(entry => entry.role)).size !== value.assessments.length ||
      new Set(value.assessments.map(entry => entry.requestId)).size !== value.assessments.length)
    .exhaustive());
}

export function findingOf(row: StandaloneLineageRow): Finding {
  return "draft" in row.finding
    ? canonicalRecord({ ...row.finding.draft, protocolVersion: 2, id: row.finding.id, agent: row.finding.agent })
    : row.finding;
}

/** Bounded immutable data reader. Its output cannot be substituted for an authenticated source. */
export function parseStandaloneLineageInventory(bytes: Uint8Array): DomainResult<readonly StandaloneLineageRow[], StandaloneLineageError> {
  const decoded = parseBoundedReviewerJson(bytes, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  if (!decoded.ok) return rejectLineage(decoded.error.code === "payload-too-large" ? "limit-exceeded" : "invalid-data", decoded.error.message);
  if (!Array.isArray(decoded.value) || decoded.value.length > STANDALONE_LINEAGE_LIMITS.inventory || decoded.value.some(row =>
    isRecord(row) && Array.isArray(row.history) && row.history.length > STANDALONE_LINEAGE_LIMITS.historyPerOrigin)) {
    return rejectLineage("limit-exceeded", "Inventory/history count exceeds its pre-copy budget.");
  }
  const parsed = standaloneLineageInventorySchema.safeParse(decoded.value);
  if (!parsed.success) return rejectLineage("invalid-data", "Lineage inventory does not conform to its bounded grammar.");
  const seen = new Set<string>();
  for (const row of parsed.data) {
    const origin = parseFindingOrigin(row.origin);
    const key = standaloneOriginReference(row.origin);
    if (!origin.ok || seen.has(key) || row.finding.id !== `${row.origin.role}-${row.origin.ordinal}` || row.finding.agent !== row.origin.role) {
      return rejectLineage("identity-mismatch", "Inventory must preserve unique full origins and exact engine-attributed IDs/roles.");
    }
    seen.add(key);
    if (historyProblem(row)) return rejectLineage("invalid-history", "Historical decisions must preserve full votes and strict-majority outcomes.");
  }
  return success(parsed.data);
}

/** The retained form of an attributed Finding under its Finding Origin role. */
export function storedFinding(finding: Finding, agent: FindingOrigin["role"]): StandaloneLineageRow["finding"] {
  if (finding.protocolVersion !== 2) return canonicalRecord({ ...finding, agent });
  const { id, protocolVersion, agent: _agent, ...draft } = finding;
  return canonicalRecord({ id, agent, protocolVersion, draft });
}
