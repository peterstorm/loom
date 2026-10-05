/** Standalone-only lineage grammar. Parsing establishes data integrity, never publication authority. */
import { z } from "zod/v4";
import { boundedText, evidenceSchema, reviewerDraftV2Schema, REVIEWER_IMPACT_RUBRIC_V1, type ReviewerProtocolFailure } from "./reviewer-contract";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { canonicalRecord, success, failure, type DomainResult, SAFE_AUTHORITY_ID, SHA256_HEX } from "./orchestration-contract/identity";
import { parseReviewPath } from "./review-packet";
import { sha256Hex } from "./digest";

export const STANDALONE_LINEAGE_LIMITS = Object.freeze({
  retainedBytes: 16_777_216, inventory: 4_096, historyPerOrigin: 64,
  paths: 4_096, schemaBytes: 16_384, responseBytes: 1_048_576,
});
const text = boundedText(8_192);
const reference = boundedText(2_048);
const digest = z.string().regex(SHA256_HEX);
const identity = z.string().regex(SAFE_AUTHORITY_ID);
const role = z.enum(["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer", "comment-analyzer", "architecture-tech-lead", "code-simplifier"]);
const path = reference.refine(value => {
  const parsed = parseReviewPath(value);
  return parsed.ok && parsed.value === value;
});
const locator = reference.refine(value => value.startsWith("/") && !value.includes("\\") &&
  value.slice(1).split("/").every(part => part !== "" && part !== "." && part !== ".."));
export const standalonePublicationReferenceSchema = z.strictObject({ locator, runId: identity, resultDigest: digest }).readonly();
export type StandalonePublicationReference = z.infer<typeof standalonePublicationReferenceSchema>;
const attribution = { runId: identity, requestId: identity, transcriptDigest: digest, role, ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) };
export const findingOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current"), ...attribution }).readonly(),
  z.strictObject({ kind: z.literal("published"), ...attribution, publication: standalonePublicationReferenceSchema }).readonly(),
  z.strictObject({ kind: z.literal("published-successor"), ...attribution, publication: standalonePublicationReferenceSchema }).readonly(),
]);
export type FindingOrigin = z.infer<typeof findingOriginSchema>;
const vote = z.strictObject({ lens: reference, reason: text }).readonly();
const repaired = z.strictObject({ requestId: identity, role, reason: text, change: z.strictObject({ path, description: text }).readonly() }).readonly();
const decisionPublication = z.union([standalonePublicationReferenceSchema,
  z.strictObject({ kind: z.literal("enclosing-publication") }).readonly()]);
const currentAssessment = z.strictObject({ runId: identity, requestId: identity, transcriptDigest: digest,
  contextDigest: digest, role, reason: text, change: z.strictObject({ path, description: text }).readonly(),
  changedInput: z.enum(["observed-changed", "historical-unknown"]),
}).readonly();
const decision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("adjudication"), publication: decisionPublication,
    lenses: z.array(reference).min(1).max(7).readonly(), threshold: z.number().int().min(1).max(7),
    survives: z.boolean(), refutations: z.array(vote).max(7).readonly(),
    upheldBy: z.array(reference).max(7).readonly(), uncertainFrom: z.array(reference).max(7).readonly(),
  }).readonly(),
  z.strictObject({ kind: z.literal("resolution"), publication: standalonePublicationReferenceSchema,
    snapshotDigest: digest, assessments: z.array(repaired).min(1).max(7).readonly(),
  }).readonly(),
  z.strictObject({ kind: z.literal("successor-resolution"), publication: decisionPublication,
    runId: identity, snapshotDigest: digest, assessments: z.array(currentAssessment).min(1).max(7).readonly(),
  }).readonly(),
]);
const findingIdentity = { id: reference, agent: role };
const legacyFinding = z.strictObject({ ...findingIdentity, severity: z.enum(["critical", "advisory"]), file: path.nullable(),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(), claim: boundedText(4_096),
}).readonly();
/** Identity stays outside the unchanged strict v2 draft grammar. */
const standaloneStoredFindingSchema = z.union([legacyFinding, z.strictObject({
  protocolVersion: z.literal(2), ...findingIdentity, draft: reviewerDraftV2Schema,
}).readonly()]);
const standaloneLineageRowSchema = z.strictObject({
  origin: findingOriginSchema, finding: standaloneStoredFindingSchema,
  history: z.array(decision).max(STANDALONE_LINEAGE_LIMITS.historyPerOrigin).readonly(),
}).readonly();
export const standaloneLineageInventorySchema = z.array(standaloneLineageRowSchema).max(STANDALONE_LINEAGE_LIMITS.inventory).readonly();
export type StandaloneLineageRow = z.infer<typeof standaloneLineageRowSchema>;

export const standaloneDispositionSchema = z.strictObject({
  schemaVersion: z.literal(1), source: standalonePublicationReferenceSchema, provenance: z.literal("DECLARED"),
  revision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("initial") }).readonly(),
    z.strictObject({ kind: z.literal("correction"), previousDigest: digest }).readonly(),
    z.strictObject({ kind: z.literal("historical-import"), proseReference: reference, prose: boundedText(65_536) }).readonly(),
  ]),
  entries: z.array(z.strictObject({ origin: digest, decision: z.enum(["accepted", "deferred", "dismissed"]), reason: text }).readonly())
    .max(STANDALONE_LINEAGE_LIMITS.inventory).readonly(),
}).readonly();
export type StandaloneDispositionRecord = z.infer<typeof standaloneDispositionSchema>;

const reopening = z.strictObject({
  decisionDigest: digest, evidence: evidenceSchema,
  changedConditions: text, currentApplicability: text, evidenceLimits: text,
}).readonly();
const assessment = z.discriminatedUnion("verdict", [
  z.strictObject({ origin: digest, verdict: z.literal("still-present"), reason: text }).readonly(),
  z.strictObject({ origin: digest, verdict: z.literal("not-assessable"), reason: text }).readonly(),
  z.strictObject({ origin: digest, verdict: z.literal("retained"), decisionDigest: digest, reason: text }).readonly(),
  z.strictObject({ origin: digest, verdict: z.literal("repaired"), reason: text, change: z.strictObject({ path, description: text }).readonly() }).readonly(),
  z.strictObject({ origin: digest, verdict: z.literal("reopen"), reason: text, proposal: reopening }).readonly(),
]);
export type StandaloneResolutionAssessment = z.infer<typeof assessment>;
export const standaloneReviewerPayloadV3Schema = z.strictObject({
  schemaVersion: z.literal(3), kind: z.literal("standalone-successor-review"),
  lineageDigest: digest, snapshotDigest: digest,
  priorAssessments: z.array(assessment).max(4_096).readonly(),
  findings: z.array(z.strictObject({ draft: reviewerDraftV2Schema,
    relation: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("independent") }).readonly(),
      z.strictObject({ kind: z.literal("distinct-related"), origin: digest, distinction: text }).readonly(),
    ]),
  }).readonly()).max(128).readonly(),
}).readonly().describe("Explicit standalone successor envelope only; Finding evidence remains v2. Every issued origin digest exactly once in inventory order. No IDs/counts authored by reviewers. One strict JSON object; 1048576 UTF-8 bytes; depth 32; no duplicate keys/BOM. Repaired requires a relevant changed scoped path; reopening names an exact prior decision and supplies new evidence. Engine joins scope, roster, source and decisions independently.");
export type StandaloneReviewerPayloadV3 = z.infer<typeof standaloneReviewerPayloadV3Schema>;
export const STANDALONE_REVIEWER_SCHEMA_V3 = JSON.stringify(z.toJSONSchema(standaloneReviewerPayloadV3Schema, {
  target: "draft-2020-12", io: "output", unrepresentable: "throw", cycles: "throw", reused: "ref",
}), null, 2);
export const STANDALONE_REVIEWER_PROTOCOL_V3 = Object.freeze({
  protocol: "loom-reviewer", version: 3, rubricVersion: 1,
  schemaDigest: sha256Hex(STANDALONE_REVIEWER_SCHEMA_V3), rubricDigest: sha256Hex(REVIEWER_IMPACT_RUBRIC_V1),
} as const);
export function parseStandaloneReviewerProtocolV3(raw: unknown): DomainResult<typeof STANDALONE_REVIEWER_PROTOCOL_V3, ReviewerProtocolFailure> {
  const record = readExactDataRecord(raw, Object.keys(STANDALONE_REVIEWER_PROTOCOL_V3), "standalone v3 descriptor");
  return record.ok && Object.entries(STANDALONE_REVIEWER_PROTOCOL_V3).every(([key, value]) => record.value[key] === value)
    ? success(STANDALONE_REVIEWER_PROTOCOL_V3)
    : failure(canonicalRecord({ kind: "reviewer-protocol-failed", code: "unsupported-protocol", path: "/reviewerProtocol", message: "Standalone v3 requires its exact schema and unchanged impact rubric." }));
}
export const STANDALONE_REVIEWER_FIXED_SECTIONS_V3 = Object.freeze([
  Object.freeze({ label: "reviewer-payload-schema", text: STANDALONE_REVIEWER_SCHEMA_V3 }),
  Object.freeze({ label: "reviewer-impact-rubric", text: REVIEWER_IMPACT_RUBRIC_V1 }),
]);
/** Historical contexts froze bytes but not modes. Unknown mode is not inferred from today's checkout. */
export const standalonePreviousSnapshotSchema = z.array(z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("present"), path, digest, mode: z.enum(["100644", "100755"]).nullable() }).readonly(),
  z.strictObject({ kind: z.literal("absent"), path }).readonly(),
  z.strictObject({ kind: z.literal("historical-unknown"), path }).readonly(),
])).min(1).max(STANDALONE_LINEAGE_LIMITS.paths).readonly();
export type StandalonePreviousSnapshot = z.infer<typeof standalonePreviousSnapshotSchema>;
const standaloneSnapshotSchema = z.array(z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("present"), path, digest, mode: z.enum(["100644", "100755"]) }).readonly(),
  z.strictObject({ kind: z.literal("absent"), path }).readonly(),
  z.strictObject({ kind: z.literal("historical-unknown"), path }).readonly(),
])).min(1).max(STANDALONE_LINEAGE_LIMITS.paths).readonly();
export type StandaloneSnapshot = z.infer<typeof standaloneSnapshotSchema>;
export const standaloneSuccessorSelectionSchema = z.strictObject({ runId: identity, snapshot: standaloneSnapshotSchema,
  reviewers: z.array(role).min(1).max(7).readonly(),
}).readonly();
