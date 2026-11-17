/** Reviewer wire definitions only: no issuance, Findings behavior, or shell authority. */
import { z } from "zod/v4";
import { parseReviewPath } from "./review-packet";
import { sha256Hex } from "./digest";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { canonicalRecord, failure, success, type ArtifactDigest, type DomainResult } from "./orchestration-contract/identity";

export const STANDALONE_REVIEW_SUBJECT = "standalone-review";

export const REVIEWER_PAYLOAD_LIMITS = Object.freeze({
  bytes: 1_048_576, depth: 32, findings: 128, priorFindings: 4_096,
  concise: 4_096, reference: 2_048, narrative: 8_192, traceEntries: 32,
  // Model-reliability ceiling for retry guidance: payloads above this size
  // routinely break strict JSON in agent emissions (long re-verification
  // reasons quoting source text), so the retry diagnostic tells the agent to
  // compress instead of re-emitting a shape that already failed.
  retryGuidanceBytes: 8_500,
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
const priorFindings = z.array(z.strictObject({
  finding_id: reference, verdict: z.enum(["resolved_by_remediation", "still_present"]), reason: narrative,
}).readonly()).max(REVIEWER_PAYLOAD_LIMITS.priorFindings).readonly()
  .describe("Every issued prior Finding ID exactly once in packet order; empty roster requires empty array. Ingress checks the issued roster.");
const standaloneSchema = z.strictObject({ schemaVersion: z.literal(2), kind: z.literal(STANDALONE_REVIEW_SUBJECT), findings }).readonly();
const waveSchema = z.strictObject({
  schemaVersion: z.literal(2), kind: z.literal("wave-review"),
  packetId: z.string().regex(/^[0-9a-f]{64}$/).describe("Must equal the issued Review Packet ID."),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Must equal the issued Review Generation."),
  prior_findings: priorFindings,
  findings,
}).readonly();
const wholePayloadLimits = `Exactly one strict JSON object, at most ${REVIEWER_PAYLOAD_LIMITS.bytes} UTF-8 bytes, no BOM, duplicate keys or more than ${REVIEWER_PAYLOAD_LIMITS.depth} nested containers including root. Byte decoder enforces these limits before schema parsing. Evidence is reviewer-reported, never engine proof.`;
export const reviewerPayloadV2Schema = z.discriminatedUnion("kind", [standaloneSchema, waveSchema]).describe(wholePayloadLimits);
export type StandaloneReviewerPayloadV2 = z.infer<typeof standaloneSchema>;
export type WaveReviewerPayloadV2 = z.infer<typeof waveSchema>;
export type ReviewerPayloadV2 = z.infer<typeof reviewerPayloadV2Schema>;

/**
 * The Wave reviewer payload of protocol v4 (ADR-0083): the v2 Wave arm without
 * `packetId` and `generation`. The issued request already names its slot and
 * the Context Packet digest, so the engine binds both from the issued subject;
 * a reviewer that copies them is refused by the strict object. Prior
 * assessments stay required in packet order.
 */
export const waveReviewerPayloadV4Schema = z.strictObject({
  schemaVersion: z.literal(4), kind: z.literal("wave-review"), prior_findings: priorFindings, findings,
}).readonly().describe(`${wholePayloadLimits} The engine binds the Review Packet ID and Review Generation from the issued request; never include them.`);
export type WaveReviewerPayloadV4 = z.infer<typeof waveReviewerPayloadV4Schema>;

const jsonSchemaBytes = (schema: z.ZodType): string => JSON.stringify(z.toJSONSchema(schema, {
  target: "draft-2020-12", io: "output", unrepresentable: "throw", cycles: "throw", reused: "ref",
}), null, 2);
export const REVIEWER_PAYLOAD_SCHEMA_V2 = jsonSchemaBytes(reviewerPayloadV2Schema);
export const WAVE_REVIEWER_PAYLOAD_SCHEMA_V4 = jsonSchemaBytes(waveReviewerPayloadV4Schema);

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
/** The v4 packet carries the v4 Wave schema under the same reserved labels. */
export const WAVE_REVIEWER_FIXED_SECTIONS_V4 = Object.freeze([
  Object.freeze({ label: "reviewer-payload-schema", text: WAVE_REVIEWER_PAYLOAD_SCHEMA_V4 }),
  Object.freeze({ label: "reviewer-impact-rubric", text: REVIEWER_IMPACT_RUBRIC_V1 }),
]);

// New-issuance tool-primary wire wording (FR-020/AS-012; AD-7).

/**
 * The ONE new-issuance tool-primary wire wording (FR-020/AS-012; AD-7),
 * rendered over the route's registry-minted tool name (typed at the
 * binding/route boundaries that feed this render): the exact tool as the
 * PRIMARY final action, no re-emission within the spawn (a second call is
 * the duplicate-call ambiguity refusal, AD-9), and final-message extraction
 * as the deterministic fallback under the issued payload schema. Kind- and
 * version-generic: the issued binding selects the tool. Extraction-only and
 * archived issued contracts keep `REVIEWER_OUTPUT_CONTRACT` verbatim — this
 * wording is never stamped onto them — and the schema/rubric bytes above are
 * untouched by it; the tool-primary wording joins the stamped fragment only
 * through the stamp pass, never by editing generated shims.
 */
export const reviewerEmissionToolContract = (toolName: string): string =>
  `Emit the required payload by calling the exact tool ${toolName} exactly once, with its arguments carrying the complete issued payload, and make that tool call your primary final action. Never call ${toolName} a second time in this spawn. Only if the tool is unavailable or refuses your arguments, fall back to the final message: exactly one JSON object conforming to the issued payload schema, and nothing else.`;

/**
 * The stamped fragment's tool-primary template (FR-020/AS-012; AD-7): the
 * SAME frozen wording as `reviewerEmissionToolContract()` over the ONE
 * placeholder that stands for the route's registry-minted tool name. The
 * shared fragment is stamped once and cannot name a route-specific tool (the
 * binding is minted per request), so the stamped copy carries the template;
 * substituting the placeholder with the exact issued tool name reproduces the
 * per-spawn render byte-for-byte — one wording, two renderings. Kind- and
 * version-generic: never substitute a different tool or rewrite the template
 * in a shim. Extraction-only and archived issued contracts keep
 * `REVIEWER_OUTPUT_CONTRACT` verbatim; the tool-primary wording joins the
 * stamped fragment only through the stamp pass, never by editing generated
 * shims or the archived references/reviewer-protocol-v1 and v2 fragments
 * (AS-012).
 */
export const REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER = "<issued emission tool name>";
export const REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE: string = reviewerEmissionToolContract(REVIEWER_EMISSION_TOOL_CONTRACT_PLACEHOLDER);

/** The v2 descriptor: standalone review and Wave runs registered before v4. */
export type ReviewerProtocolDescriptorV2 = Readonly<{
  protocol: "loom-reviewer"; version: 2; rubricVersion: 1;
  schemaDigest: ArtifactDigest; rubricDigest: ArtifactDigest;
}>;
/** The v4 descriptor: Wave review only (ADR-0083). Version 4, never 3, so it
 *  cannot collide with the standalone successor v3 descriptor (ADR-0010). */
export type WaveReviewerProtocolDescriptorV4 = Readonly<{
  protocol: "loom-reviewer"; version: 4; rubricVersion: 1;
  schemaDigest: ArtifactDigest; rubricDigest: ArtifactDigest;
}>;
/** Every descriptor a schema-2 registration can carry; `version` selects the decoder. */
export type ReviewerProtocolDescriptor = ReviewerProtocolDescriptorV2 | WaveReviewerProtocolDescriptorV4;

export const REVIEWER_PROTOCOL_V2: ReviewerProtocolDescriptorV2 = canonicalRecord({
  protocol: "loom-reviewer", version: 2, rubricVersion: 1,
  schemaDigest: sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2) as ArtifactDigest,
  rubricDigest: sha256Hex(REVIEWER_IMPACT_RUBRIC_V1) as ArtifactDigest,
});
export const WAVE_REVIEWER_PROTOCOL_V4: WaveReviewerProtocolDescriptorV4 = canonicalRecord({
  protocol: "loom-reviewer", version: 4, rubricVersion: 1,
  schemaDigest: sha256Hex(WAVE_REVIEWER_PAYLOAD_SCHEMA_V4) as ArtifactDigest,
  rubricDigest: sha256Hex(REVIEWER_IMPACT_RUBRIC_V1) as ArtifactDigest,
});

/** The fixed packet sections a descriptor issues: its schema and the shared rubric. */
export const reviewerFixedSections = (descriptor: ReviewerProtocolDescriptor) =>
  descriptor.version === 4 ? WAVE_REVIEWER_FIXED_SECTIONS_V4 : REVIEWER_FIXED_SECTIONS;

/** The review programs that register a schema-2 reviewer descriptor. */
export type ReviewerProgram = typeof STANDALONE_REVIEW_SUBJECT | "wave-gate";

const unsupportedDescriptor = (message: string): DomainResult<never, ReviewerProtocolFailure> =>
  failure(canonicalRecord({ kind: "reviewer-protocol-failed", code: "unsupported-protocol", path: "/reviewerProtocol", message }));

function exactDescriptor<D extends ReviewerProtocolDescriptor>(raw: unknown, supported: D): D | null {
  const record = readExactDataRecord(raw, Object.keys(supported), "reviewer descriptor");
  return record.ok && Object.entries(supported).every(([key, value]) => record.value[key] === value) ? supported : null;
}

/** Exact v2 bytes only: what standalone review and every standalone result admit. */
export function parseReviewerProtocolDescriptorV2(raw: unknown): DomainResult<ReviewerProtocolDescriptorV2, ReviewerProtocolFailure> {
  const v2 = exactDescriptor(raw, REVIEWER_PROTOCOL_V2);
  return v2 === null
    ? unsupportedDescriptor("Reviewer descriptor must identify the exact supported schema and rubric bytes.")
    : success(v2);
}

/** Exact v2 or v4 bytes: what a Wave Gate registration and its Task review state admit. */
export function parseWaveReviewerProtocolDescriptor(raw: unknown): DomainResult<ReviewerProtocolDescriptor, ReviewerProtocolFailure> {
  const descriptor = exactDescriptor(raw, REVIEWER_PROTOCOL_V2) ?? exactDescriptor(raw, WAVE_REVIEWER_PROTOCOL_V4);
  return descriptor === null
    ? unsupportedDescriptor("Wave reviewer descriptor must identify the exact supported v2 or v4 schema and rubric bytes.")
    : success(descriptor);
}

/** The descriptor parse a review program admits: v4 is Wave-only. Not a provenance proof. */
export function parseReviewerProtocolDescriptorFor(
  program: ReviewerProgram, raw: unknown,
): DomainResult<ReviewerProtocolDescriptor, ReviewerProtocolFailure> {
  return program === "wave-gate" ? parseWaveReviewerProtocolDescriptor(raw) : parseReviewerProtocolDescriptorV2(raw);
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

/**
 * The example the stamped Wire Contract shows a reviewer: the common case, a
 * critical and an advisory each at a real file and line. `REVIEWER_PAYLOAD_EXAMPLE_V2`
 * stays location-free because fixtures admit it under scopes of their own, but
 * a reviewer shown `file: null` copies it. Parsed by the admission schema
 * here, so it cannot diverge from what admission accepts.
 */
export const REVIEWER_WIRE_CONTRACT_EXAMPLE_V2: ReviewerPayloadV2 = reviewerPayloadV2Schema.parse({
  schemaVersion: 2, kind: "standalone-review", findings: [
    { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], file: "src/orders/update-order.ts", line: 42 },
    {
      severity: "advisory", file: "src/orders/update-order.ts", line: 57,
      claim: "The retry loop repeats the lookup the caller already performed.",
      reason: "Passing the loaded order in removes one query per retry; behavior is unchanged.",
    },
  ],
});

/**
 * The Wave v4 example the stamped Wire Contract shows (ADR-0073): no
 * `packetId` or `generation`, one prior assessment and one new finding.
 * Parsed by the v4 admission schema, so it cannot diverge from it.
 */
export const WAVE_REVIEWER_WIRE_CONTRACT_EXAMPLE_V4: WaveReviewerPayloadV4 = waveReviewerPayloadV4Schema.parse({
  schemaVersion: 4, kind: "wave-review",
  prior_findings: [{
    finding_id: "code-reviewer-1", verdict: "resolved_by_remediation",
    reason: "The remediation added the authorization check before the write.",
  }],
  findings: [REVIEWER_WIRE_CONTRACT_EXAMPLE_V2.findings[1]],
});
