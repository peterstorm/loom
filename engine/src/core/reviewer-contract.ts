/** Reviewer wire definitions only: no issuance, Findings behavior, or shell authority. */
import { z } from "zod/v4";
import { parseReviewPath, sha256Hex } from "./review-packet";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { canonicalRecord, failure, success, type ArtifactDigest, type DomainResult } from "./orchestration-contract/identity";

export const STANDALONE_REVIEW_SUBJECT = "standalone-review";

export const REVIEWER_PAYLOAD_LIMITS = Object.freeze({
  bytes: 1_048_576, depth: 32, findings: 128, priorFindings: 4_096,
  concise: 4_096, reference: 2_048, narrative: 8_192, traceEntries: 32,
});

export type ReviewerProtocolFailure = Readonly<{
  kind: "reviewer-protocol-failed";
  code: "authority-unavailable" | "authority-mismatch" | "unsupported-protocol" |
    "payload-too-large" | "invalid-utf8" | "invalid-json" | "duplicate-key" |
    "depth-exceeded" | "invalid-payload" | "binding-mismatch" | "out-of-scope" |
    "invalid-prior-assessments" | "legacy-evidence-failed";
  path: string;
  message: string;
  byteOffset?: number;
}>;

const encoder = new TextEncoder();
export function boundedText(maxBytes: number) {
  return z.string().min(1).max(maxBytes).refine((text) =>
    text.trim().length > 0 && !text.includes("\0") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) &&
    encoder.encode(text).byteLength <= maxBytes,
  ).describe(`1–${maxBytes} UTF-8 bytes; non-whitespace; no NUL or unpaired Unicode surrogates. Preserve accepted contents exactly.`);
}
const concise = boundedText(REVIEWER_PAYLOAD_LIMITS.concise);
const reference = boundedText(REVIEWER_PAYLOAD_LIMITS.reference);
const narrative = boundedText(REVIEWER_PAYLOAD_LIMITS.narrative);
const traceEntries = z.tuple([narrative]).rest(narrative).check(z.maxLength(REVIEWER_PAYLOAD_LIMITS.traceEntries)).readonly();
export const evidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reproduction"), execution: z.enum(["not-executed", "reviewer-reported"]),
    setup: narrative, input: narrative, observed: narrative, expected: narrative, reference,
  }).readonly(),
  z.strictObject({
    kind: z.literal("execution-trace"), preconditions: traceEntries, steps: traceEntries,
    observed: narrative, expected: narrative, reference,
  }).readonly(),
]);
export type ReviewerEvidence = z.infer<typeof evidenceSchema>;

const basisSchema = z.strictObject({
  evidence: evidenceSchema,
  violatedContract: z.strictObject({ reference, statement: narrative }).readonly(),
  consequence: z.strictObject({ affected: narrative, preconditions: narrative, impact: narrative, evidenceLimits: narrative }).readonly(),
  truthConfidence: z.number().min(0).max(100),
  severityRationale: concise,
}).readonly();
export type FindingBasis = z.infer<typeof basisSchema>;

const location = {
  file: reference.refine((path) => {
    const parsed = parseReviewPath(path);
    return parsed.ok && parsed.value === path;
  }).describe(`1–${REVIEWER_PAYLOAD_LIMITS.reference} UTF-8 bytes; canonical parseReviewPath repository-relative POSIX path; must belong to issued frozen scope (checked by ingress).`).nullable(),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  claim: concise,
};
const locationIsConsistent = (draft: Readonly<{ file: string | null; line: number | null }>): boolean =>
  draft.file !== null || draft.line === null;
export const reviewerDraftV2Schema = z.discriminatedUnion("severity", [
  z.strictObject({ severity: z.literal("critical"), ...location, basis: basisSchema })
    .refine(locationIsConsistent, { path: ["line"] }).describe("A null file requires a null line.").readonly(),
  z.strictObject({ severity: z.literal("advisory"), ...location, reason: concise, basis: basisSchema.optional() })
    .refine(locationIsConsistent, { path: ["line"] }).describe("A null file requires a null line. Optional basis must be complete, never null.").readonly(),
]);
export type ReviewerDraftV2 = z.infer<typeof reviewerDraftV2Schema>;

const findings = z.array(reviewerDraftV2Schema).max(REVIEWER_PAYLOAD_LIMITS.findings).readonly();
const standaloneSchema = z.strictObject({ schemaVersion: z.literal(2), kind: z.literal(STANDALONE_REVIEW_SUBJECT), findings }).readonly();
const waveSchema = z.strictObject({
  schemaVersion: z.literal(2), kind: z.literal("wave-review"),
  packetId: z.string().regex(/^[0-9a-f]{64}$/).describe("Must equal the issued Review Packet ID."),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Must equal the issued Review Generation."),
  prior_findings: z.array(z.strictObject({
    finding_id: reference, verdict: z.enum(["resolved_by_remediation", "still_present"]), reason: narrative,
  }).readonly()).max(REVIEWER_PAYLOAD_LIMITS.priorFindings).readonly()
    .describe("Every issued prior Finding ID exactly once in packet order; empty roster requires empty array. Ingress checks the issued roster."),
  findings,
}).readonly();
export const reviewerPayloadV2Schema = z.discriminatedUnion("kind", [standaloneSchema, waveSchema])
  .describe(`Exactly one strict JSON object, at most ${REVIEWER_PAYLOAD_LIMITS.bytes} UTF-8 bytes, no BOM, duplicate keys or more than ${REVIEWER_PAYLOAD_LIMITS.depth} nested containers including root. Byte decoder enforces these limits before schema parsing. Evidence is reviewer-reported, never engine proof.`);
export type StandaloneReviewerPayloadV2 = z.infer<typeof standaloneSchema>;
export type WaveReviewerPayloadV2 = z.infer<typeof waveSchema>;
export type ReviewerPayloadV2 = z.infer<typeof reviewerPayloadV2Schema>;

export const REVIEWER_PAYLOAD_SCHEMA_V2 = JSON.stringify(z.toJSONSchema(reviewerPayloadV2Schema, {
  target: "draft-2020-12", io: "output", unrepresentable: "throw", cycles: "throw", reused: "ref",
}), null, 2);

export const REVIEWER_IMPACT_RUBRIC_V1 = `Classify one assertion per finding. Truth confidence concerns whether that assertion holds; it is not an impact score or a severity formula.

Use critical only for a concrete consequence to supported behavior, safety or authority, an explicit acceptance or verification obligation, or safe operator use that must block this delivery. Identify the affected party or system, supported preconditions, violated contract and evidence limits. Explicit non-negotiable project obligations remain binding; cite the actual obligation and consequence.

Factual incorrectness, high confidence, stylistic preference, architectural shallowness, or a missing test alone does not establish a blocking consequence. Use advisory for a nonblocking correction or improvement, with a concise reason or benefit. A fuller advisory basis is optional, but if supplied must be complete.

For a critical, provide the claim plus evidence or a concrete execution trace, violated contract, consequence, truth confidence, and severity rationale. A reproduction is not universally required. Do not claim execution merely because a command or reference is written down. Reviewer-reported execution is not an engine execution receipt; identify what was not observed or proved.

Use an honest null location rather than invent a file or line. Finding locations must be inside the frozen scope; references supply context, not permission to expand that scope. Assess every prior Finding ID exactly once in packet order when the issued contract requires it. Do not intentionally re-emit a prior Finding as new.

The engine validates structure, attribution, scope, identity, complete evidence and arithmetic. It does not prove truth, impact, reachability, or semantic test adequacy from these fields. Never invent new Finding IDs or numeric tallies; return only the one JSON object required by the issued schema.

The existing Refutation Panel may refute an assertion, including its stated preconditions, contract and consequence, but a true assertion is not refuted merely because its repair seems unimportant. A structurally admitted surviving critical remains blocking. There is no automatic severity downgrade or new severity-dispute action.
`;

export const REVIEWER_OUTPUT_CONTRACT = "Emit exactly one JSON object conforming to reviewer-payload-schema; apply reviewer-impact-rubric. No other final output.";
export const REVIEWER_FIXED_SECTIONS = Object.freeze([
  Object.freeze({ label: "reviewer-payload-schema", text: REVIEWER_PAYLOAD_SCHEMA_V2 }),
  Object.freeze({ label: "reviewer-impact-rubric", text: REVIEWER_IMPACT_RUBRIC_V1 }),
]);

export type ReviewerProtocolDescriptor = Readonly<{
  protocol: "loom-reviewer"; version: 2; rubricVersion: 1;
  schemaDigest: ArtifactDigest; rubricDigest: ArtifactDigest;
}>;
export const CURRENT_REVIEWER_PROTOCOL: ReviewerProtocolDescriptor = canonicalRecord({
  protocol: "loom-reviewer", version: 2, rubricVersion: 1,
  schemaDigest: sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2) as ArtifactDigest,
  rubricDigest: sha256Hex(REVIEWER_IMPACT_RUBRIC_V1) as ArtifactDigest,
});

/** Exact supported bytes, not a caller-selected version or a provenance proof. */
export function parseReviewerProtocolDescriptor(raw: unknown): DomainResult<ReviewerProtocolDescriptor, ReviewerProtocolFailure> {
  const record = readExactDataRecord(raw, Object.keys(CURRENT_REVIEWER_PROTOCOL), "reviewer descriptor");
  if (!record.ok || Object.entries(CURRENT_REVIEWER_PROTOCOL).some(([key, value]) => record.value[key] !== value)) {
    return failure(canonicalRecord({ kind: "reviewer-protocol-failed", code: "unsupported-protocol", path: "/reviewerProtocol", message: "Reviewer descriptor must identify the exact supported schema and rubric bytes." }));
  }
  return success(CURRENT_REVIEWER_PROTOCOL);
}

/** Executable example; it cannot silently diverge from the actual admission schema. */
export const REVIEWER_PAYLOAD_EXAMPLE_V2: ReviewerPayloadV2 = reviewerPayloadV2Schema.parse({
  schemaVersion: 2, kind: "standalone-review", findings: [{
    severity: "critical", file: null, line: null, claim: "Supported input can be accepted without the required authorization check.",
    basis: {
      evidence: { kind: "execution-trace", preconditions: ["An unauthenticated caller reaches the supported entry point."], steps: ["Trace the entry point to the write without encountering authorization."], observed: "Predicted unauthorized write; not executed.", expected: "Reject before writing.", reference: "Entry-point control flow" },
      violatedContract: { reference: "Project authorization obligation", statement: "Writes require authorization." },
      consequence: { affected: "Stored user data", preconditions: "Unauthenticated supported request", impact: "Unauthorized modification", evidenceLimits: "Static trace only; no execution receipt." },
      truthConfidence: 80, severityRationale: "The reachable authorization violation blocks safe delivery.",
    },
  }],
});
