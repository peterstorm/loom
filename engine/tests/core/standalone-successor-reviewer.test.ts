import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { value } from "../fixtures/parse-result";
import { parseRequestId, parseOrchestrationRunId, parseAgentRequestAuthority, parseIssuedSpawnRequest, createPublicationAuthorityResolver,
  type AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { parseContextPacket, parseStandaloneReviewerContextPacketV3, buildReviewerContextPacket, encodeByteSection } from "../../src/core/context-packets";
import { sha256Hex } from "../../src/core/digest";
import { prepareStandaloneLineageSource, prepareStandaloneSuccessor } from "../../src/core/standalone-review";
import { standaloneOriginReference } from "../../src/core/standalone-finding-origin";
import { parseStandaloneReviewerPayloadV3, parseReviewerPayloadV2 } from "../../src/core/reviewer-protocol";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_IMPACT_RUBRIC_V1, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { STANDALONE_REVIEWER_SCHEMA_V3, STANDALONE_LINEAGE_LIMITS, STANDALONE_REVIEWER_PROTOCOL_V3, parseStandaloneReviewerProtocolV3 } from "../../src/core/standalone-lineage-contract";
import { buildStandaloneSuccessorReviewerContext, standaloneSuccessorReviewerRegistration, parseIssuedStandaloneSuccessorReviewer,
  admitStandaloneSuccessorReviewer, aggregateIssuedStandaloneSuccessorEvidence,
  type IssuedStandaloneSuccessorReviewer } from "../../src/core/standalone-successor-reviewer";
import { EMISSION_TOOL_SPECS, issueEmissionBinding, type IssuedEmissionBindingOf } from "../../src/core/emission-tool";
import { issuedReviewerEmissionRoute, projectRegisteredReviewerProtocol } from "../../src/core/reviewer-emission-route";
import { selectCanonicalPayload } from "../../src/core/emission-ingestion";
import { observeEmissionCalls } from "../../src/core/emission-observation";
import { emissionCallFrame } from "../fixtures/emission-call-frame";

const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));
const prior = value(prepareStandaloneLineageSource(standaloneFixture(undefined, true).input.standaloneResult, "/owned/predecessor"));
const prepared = value(prepareStandaloneSuccessor(prior, bytes({ runId: "run.v3", snapshot: prior.scope.map(path => ({ kind: "absent", path })),
  reviewers: prior.reviewers }), { kind: "historical-decision-unavailable" }));
const payload = () => ({ schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest,
  priorAssessments: prepared.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict: "still-present", reason: "Still applies." })), findings: [] });

function fixture(role = "code-reviewer", attempt: 1 | 2 = 1) {
  const policy = value(resolveAgentPolicy(role));
  const profile = value(resolveModelProfile(policy.profile));
  const identity = { runId: value(parseOrchestrationRunId(prepared.runId)), requestId: value(parseRequestId(`request:${role}:${attempt}`)),
    role: policy.agent, attempt, requiredSkill: policy.requiredSkill };
  const packet = value(buildStandaloneSuccessorReviewerContext(prepared, identity, []));
  const authority = value(parseAgentRequestAuthority({ ...identity, slotId: `slot:${role}`, program: "standalone-review",
    modelProfile: policy.profile, harnessBinding: { pi: lowerModelProfile(profile, "pi"), claude: lowerModelProfile(profile, "claude-code") },
    contextDigest: packet.digest, outputSlot: `transcripts/${role}/attempt-${attempt}.raw` }));
  const context = { digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` } };
  const content = { schemaVersion: 1, kind: "batch-published", effectId: `effect:${role}:${attempt}`, runId: authority.runId,
    requestIds: [authority.requestId], contextDigests: [authority.contextDigest], issuedRequests: [{ authority, context }] };
  const receipt = { ...content, publicationDigest: sha256Hex(JSON.stringify(content)) };
  const publications = createPublicationAuthorityResolver(() => ({ ok: true, value: [...bytes(receipt)] }));
  const request = value(parseIssuedSpawnRequest(publications, { authority, context, issuance: { schemaVersion: 1,
    kind: "issued-spawn-request-proof", runId: authority.runId, effectId: content.effectId, publicationDigest: receipt.publicationDigest, batchIndex: 0 } }));
  const registration = standaloneSuccessorReviewerRegistration(prepared);
  const issued = value(parseIssuedStandaloneSuccessorReviewer({ request, packet, registration, prepared }));
  return { request, packet, registration, prepared, issued };
}

/** The successor's issued v3 binding, derived exactly as production derives
 *  it: the durable v3 registration's protocol projection through the core
 *  reviewer-route derivation, with a Pi parent. The request is issued under
 *  its catalog profile, whose Pi route IS the qualified emission route, so no
 *  binding override is needed to reach the emission arm. */
function successorBinding(authority: AgentRequestAuthority): IssuedEmissionBindingOf<"reviewer-payload"> {
  const protocol = value(projectRegisteredReviewerProtocol({ schemaVersion: 3, kind: "standalone-review", reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3 }));
  if (protocol === null) throw new Error("fixture registration must project a reviewer protocol");
  const route = issuedReviewerEmissionRoute(protocol, authority, true);
  if (route.kind !== "emission") throw new Error(`fixture successor route must be emission, got ${route.kind}`);
  return route.binding;
}

describe("explicit standalone v3 wire and descriptor conservation", () => {
  it("keeps P4 exact descriptor/schema/rubric and independent/Wave issuance at v2", () => {
    expect(CURRENT_REVIEWER_PROTOCOL.version).toBe(2);
    expect(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2)).toBe("3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37");
    expect(sha256Hex(REVIEWER_IMPACT_RUBRIC_V1)).toBe("4f36c09cc1e7c27e2d8ff36c86ad22c7723c1a4715bd9c198bbed40e2c2f3a6b");
    expect(new TextEncoder().encode(REVIEWER_PAYLOAD_SCHEMA_V2).length).toBe(10257);
    const v2 = value(buildReviewerContextPacket({ requestId: value(parseRequestId("request:initial")), role: "code-reviewer", requiredSkill: "none",
      fixedContext: [value(encodeByteSection("source", "unchanged"))], variableContext: [] }));
    expect(v2.schemaVersion).toBe(2);
    expect(parseContextPacket(v2)).toEqual({ ok: true, value: v2 });
    expect(parseStandaloneReviewerContextPacketV3(v2).ok).toBe(false);
    expect(parseReviewerPayloadV2(bytes(payload())).ok).toBe(false);
    expect(parseStandaloneReviewerPayloadV3(bytes(REVIEWER_PAYLOAD_EXAMPLE_V2)).ok).toBe(false);
    expect(parseStandaloneReviewerProtocolV3(CURRENT_REVIEWER_PROTOCOL).ok).toBe(false);
  });
  it("bounds generated v3 schema separately without changing the impact rubric", () => {
    const size = new TextEncoder().encode(STANDALONE_REVIEWER_SCHEMA_V3).length;
    expect(size).toBeLessThanOrEqual(STANDALONE_LINEAGE_LIMITS.schemaBytes);
    expect(STANDALONE_REVIEWER_PROTOCOL_V3.schemaDigest).toBe(sha256Hex(STANDALONE_REVIEWER_SCHEMA_V3));
    expect(STANDALONE_REVIEWER_PROTOCOL_V3.rubricDigest).toBe(CURRENT_REVIEWER_PROTOCOL.rubricDigest);
    expect(parseStandaloneReviewerProtocolV3({ ...STANDALONE_REVIEWER_PROTOCOL_V3, schemaDigest: "a".repeat(64) }).ok).toBe(false);
  });
  it("round trips exact text and duplicate new drafts without minting Finding evidence version 3", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.array(fc.constantFrom("é", "\n", "🧵", " ", "a"), { maxLength: 30 }), (truthConfidence, parts) => {
      const example = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
      if (example.severity !== "critical") throw Error("critical example required");
      const draft = { ...example, claim: `Exact ${parts.join("")} `, basis: { ...example.basis, truthConfidence } };
      const raw = { ...payload(), findings: [{ draft, relation: { kind: "independent" } }, { draft, relation: { kind: "independent" } }] };
      expect(parseStandaloneReviewerPayloadV3(bytes(raw))).toEqual({ ok: true, value: raw });
    }), { seed: 5110, numRuns: 60 });
  });
  it("enforces all ingress bounds and refuses decoded duplicates, malformed priors and authored IDs atomically", () => {
    const raw = JSON.stringify(payload());
    expect(parseStandaloneReviewerPayloadV3(new TextEncoder().encode(raw.padEnd(1_048_576))).ok).toBe(true);
    expect(parseStandaloneReviewerPayloadV3(new Uint8Array(1_048_577))).toMatchObject({ ok: false, error: { code: "payload-too-large" } });
    expect(parseStandaloneReviewerPayloadV3(new TextEncoder().encode("[".repeat(33)))).toMatchObject({ ok: false, error: { code: "depth-exceeded" } });
    expect(parseStandaloneReviewerPayloadV3(new Uint8Array([255]))).toMatchObject({ ok: false, error: { code: "invalid-utf8" } });
    expect(parseStandaloneReviewerPayloadV3(new TextEncoder().encode(`\ufeff${raw}`)).ok).toBe(false);
    expect(parseStandaloneReviewerPayloadV3(new TextEncoder().encode(raw.replace('"schemaVersion":', '"schemaVersion":3,"schema\\u0056ersion":')))).toMatchObject({ ok: false, error: { code: "duplicate-key" } });
    const assessment = payload().priorAssessments[0];
    expect(parseStandaloneReviewerPayloadV3(bytes({ ...payload(), priorAssessments: Array(4096).fill(assessment) })).ok).toBe(true);
    expect(parseStandaloneReviewerPayloadV3(bytes({ ...payload(), priorAssessments: Array(4097).fill(assessment) })).ok).toBe(false);
    const finding = { draft: { severity: "advisory", file: null, line: null, claim: "new", reason: "benefit" }, relation: { kind: "independent" } };
    expect(parseStandaloneReviewerPayloadV3(bytes({ ...payload(), findings: Array(128).fill(finding) })).ok).toBe(true);
    expect(parseStandaloneReviewerPayloadV3(bytes({ ...payload(), findings: Array(129).fill(finding) })).ok).toBe(false);
    for (const change of [{ priorAssessments: [{ ...assessment, reason: " " }] }, { criticalCount: 0 },
      { findings: [{ ...finding, id: "chosen-1" }] }, { priorAssessments: [{ ...assessment, verdict: "repaired" }] },
      { priorAssessments: [{ ...assessment, verdict: "reopen", proposal: { decisionDigest: "a".repeat(64) } }] }]) {
      expect(parseStandaloneReviewerPayloadV3(bytes({ ...payload(), ...change })).ok).toBe(false);
    }
    fc.assert(fc.property(fc.uint8Array({ maxLength: 2048 }), data => { expect(typeof parseStandaloneReviewerPayloadV3(data).ok).toBe("boolean"); }), { seed: 5111, numRuns: 100 });
  });
});

describe("publication-bound successor admission at actual core seams", () => {
  it.each([1, 2] as const)("binds explicit semantic attempt %i without changing protocol or lineage", attempt => {
    const f = fixture("code-reviewer", attempt);
    expect(f.issued.protocolVersion).toBe(3);
    expect(parseContextPacket(f.packet).ok).toBe(false);
    expect(parseStandaloneReviewerContextPacketV3(f.packet)).toEqual({ ok: true, value: f.packet });
    const accepted = value(admitStandaloneSuccessorReviewer(f.issued, bytes(payload())));
    expect(accepted.request.attempt).toBe(attempt);
    expect(accepted.lineageDigest).toBe(prepared.lineageDigest);
    expect(accepted.newFindings).toEqual([]);
    expect(f.packet.fixedContext.map(section => section.label)).toEqual(["standalone-successor-authority", "standalone-lineage", "reviewer-payload-schema", "reviewer-impact-rubric"]);
  });
  it("rejects altered issuance/registration/context/lineage rather than trusting self-hashes", () => {
    const f = fixture();
    expect(parseIssuedStandaloneSuccessorReviewer({ ...f, request: { ...f.request } }).ok).toBe(false);
    expect(parseIssuedStandaloneSuccessorReviewer({ ...f, prepared: { ...prepared } }).ok).toBe(false);
    expect(parseIssuedStandaloneSuccessorReviewer({ ...f, packet: fixture("code-reviewer", 2).packet }).ok).toBe(false);
    for (const mutation of [{ runId: "run.foreign" }, { program: "wave-gate" }, { schemaVersion: 2 }, { lineageDigest: "f".repeat(64) },
      { snapshotDigest: "f".repeat(64) }, { reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }, { extra: 1 }]) {
      expect(parseIssuedStandaloneSuccessorReviewer({ ...f, registration: { ...f.registration, ...mutation } }).ok).toBe(false);
    }
    let reads = 0;
    const registration = Object.defineProperty({ ...f.registration }, "schemaVersion", { enumerable: true, get() { reads++; return 3; } });
    expect(parseIssuedStandaloneSuccessorReviewer({ ...f, registration }).ok).toBe(false);
    const fake = Object.defineProperty({}, "request", { get() { reads++; throw Error("getter"); } }) as IssuedStandaloneSuccessorReviewer;
    expect(admitStandaloneSuccessorReviewer(fake, new Proxy(new Uint8Array(), { get() { reads++; throw Error("bytes"); } })).ok).toBe(false);
    expect(reads).toBe(0);
  });
  it("requires exact full roster and current requests, not copied/replayed foreign evidence", () => {
    const fixtures = prepared.reviewers.map(role => fixture(role));
    const evidence = fixtures.map(f => value(admitStandaloneSuccessorReviewer(f.issued, bytes(payload()))));
    const requests: readonly AgentRequestAuthority[] = fixtures.map(f => f.request.authority);
    expect(value(aggregateIssuedStandaloneSuccessorEvidence(prepared, requests, evidence))[0]?.state).toBe("active");
    expect(aggregateIssuedStandaloneSuccessorEvidence(prepared, requests, evidence.slice(1)).ok).toBe(false);
    expect(aggregateIssuedStandaloneSuccessorEvidence(prepared, requests, [{ ...evidence[0]! }, evidence[1]!]).ok).toBe(false);
    expect(aggregateIssuedStandaloneSuccessorEvidence(prepared, [fixture("code-reviewer", 2).request.authority, requests[1]!], evidence).ok).toBe(false);
    expect(aggregateIssuedStandaloneSuccessorEvidence(prepared, [...requests].reverse(), [...evidence].reverse()).ok).toBe(false);
    expect(admitStandaloneSuccessorReviewer(fixtures[0]!.issued, bytes({ ...payload(), priorAssessments: [] })).ok).toBe(false);
  });
  it("attributes current origins to exact issued request/transcript, retaining v2 Finding evidence and relation", () => {
    const f = fixture();
    const raw = bytes({ ...payload(), findings: [{ draft: { severity: "advisory", file: null, line: null, claim: "Distinct assertion", reason: "Nonblocking." },
      relation: { kind: "distinct-related", origin: standaloneOriginReference(prepared.inventory[0]!.origin), distinction: "Different violated assertion." } }] });
    const accepted = value(admitStandaloneSuccessorReviewer(f.issued, raw));
    expect(accepted.newFindings[0]).toMatchObject({ origin: { kind: "current", runId: prepared.runId, requestId: f.request.authority.requestId,
      transcriptDigest: sha256Hex(new TextDecoder().decode(raw)), ordinal: 2 }, finding: { id: "code-reviewer-2", protocolVersion: 2 } });
    expect(accepted.newFindings[0]?.origin).not.toHaveProperty("publication");
    expect(accepted.payload.findings[0]?.relation.kind).toBe("distinct-related");
  });
});

// ---------------------------------------------------------------------------
// The successor's issued emission authority (T9): the successor surface's own
// v3-locked half of the emission seam's issuance join (AD-6/AD-7/AD-8,
// FR-001/FR-012). The v3 schema bytes are UNCHANGED (FR-021): the registry
// cell, the frozen descriptor and the packet's reviewer-payload-schema
// section are one schema, one contract.
// ---------------------------------------------------------------------------

describe("the successor's issued emission authority (T9)", () => {
  const registryV3Cell = EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v3"]!;

  it("keeps one schema, one contract: the registry's v3 cell bytes, the frozen descriptor digest and the packet's schema section are the same bytes (FR-021/FR-031)", () => {
    expect(registryV3Cell.schemaBytes).toBe(STANDALONE_REVIEWER_SCHEMA_V3);
    expect(sha256Hex(registryV3Cell.schemaBytes)).toBe(STANDALONE_REVIEWER_PROTOCOL_V3.schemaDigest);
    const f = fixture("code-reviewer", 1);
    const schemaSection = f.packet.fixedContext.find(section => section.label === "reviewer-payload-schema")!;
    expect(new TextDecoder().decode(schemaSection.bytes.valueOf())).toBe(registryV3Cell.schemaBytes);
    expect(registryV3Cell.parsePayload).toBe(parseStandaloneReviewerPayloadV3);
  });

  it("derives the successor's v3 binding from its durable registration through the ONE production route — the registry mint's own cell", () => {
    const f = fixture("code-reviewer", 1);
    const binding = successorBinding(f.request.authority);
    expect(binding).toMatchObject({
      requestId: "request:code-reviewer:1",
      kind: { kind: "reviewer-payload" },
      version: "v3",
      toolName: EMISSION_TOOL_SPECS["reviewer-payload"].toolName,
      schemaDigest: STANDALONE_REVIEWER_PROTOCOL_V3.schemaDigest,
    });
    expect(binding).toEqual(value(issueEmissionBinding({
      requestId: "request:code-reviewer:1", kind: "reviewer-payload", version: "v3", schemaDigest: STANDALONE_REVIEWER_PROTOCOL_V3.schemaDigest,
    })));
  });

  it("refuses a drifted or foreign successor protocol descriptor before any binding exists — checked, never trusted (AD-8)", () => {
    const registration = (reviewerProtocol: unknown) => ({ schemaVersion: 3, kind: "standalone-review", reviewerProtocol });
    const drifted = projectRegisteredReviewerProtocol(registration({ ...STANDALONE_REVIEWER_PROTOCOL_V3, schemaDigest: "f".repeat(64) }));
    expect(drifted.ok).toBe(false);
    // The current v2 descriptor certifies no successor (v3) contract.
    expect(projectRegisteredReviewerProtocol(registration(CURRENT_REVIEWER_PROTOCOL)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Emission-sourced successor payloads cross the UNCHANGED issuance joins
// (FR-012, T9): the kernel's canonical selection decides WHICH bytes are
// captured; the successor's own joins (issued protocol, lineage digests,
// prior-origin/coverage, attribution) stay source-blind — an emission source
// can never override issuance, and a join refusal is identical regardless of
// which source produced the bytes.
// ---------------------------------------------------------------------------

describe("emission-sourced successor payloads cross the unchanged issuance joins (FR-012, T9)", () => {
  it("selects a valid v3 emission call through the successor's own binding and admits the selected bytes through the identical joins", () => {
    const f = fixture("code-reviewer", 1);
    const binding = successorBinding(f.request.authority);
    const selection = selectCanonicalPayload(
      binding,
      observeEmissionCalls([emissionCallFrame(binding, "call-successor-1", payload())]),
      [],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind !== "emission-tool-arguments") throw new Error("fixture must select the emission arm");
    const admitted = value(admitStandaloneSuccessorReviewer(f.issued, Uint8Array.from(selection.payload.bytes)));
    // The joins are source-blind: identical lineage, coverage and attribution
    // to the extraction-sourced admission of the same payload.
    const extractionAdmitted = value(admitStandaloneSuccessorReviewer(f.issued, bytes(payload())));
    expect(admitted.request.attempt).toBe(extractionAdmitted.request.attempt);
    expect(admitted.lineageDigest).toBe(extractionAdmitted.lineageDigest);
    expect(admitted.payload.snapshotDigest).toBe(extractionAdmitted.payload.snapshotDigest);
    expect(admitted.newFindings).toEqual(extractionAdmitted.newFindings);
    expect(admitted.payload).toEqual(extractionAdmitted.payload);
  });

  it("refuses an emission-sourced payload that violates the coverage join exactly as the extraction path does — a source cannot override issuance", () => {
    const f = fixture("code-reviewer", 1);
    const binding = successorBinding(f.request.authority);
    const coverageViolating = { ...payload(), priorAssessments: [] };
    const selection = selectCanonicalPayload(
      binding,
      observeEmissionCalls([emissionCallFrame(binding, "call-successor-2", coverageViolating)]),
      [],
    );
    expect(selection.kind).toBe("emission-tool-arguments");
    if (selection.kind !== "emission-tool-arguments") throw new Error("fixture must select the emission arm");
    const emissionJoinRefusal = admitStandaloneSuccessorReviewer(f.issued, Uint8Array.from(selection.payload.bytes));
    const extractionJoinRefusal = admitStandaloneSuccessorReviewer(f.issued, bytes(coverageViolating));
    expect(emissionJoinRefusal.ok).toBe(false);
    expect(extractionJoinRefusal.ok).toBe(false);
    if (!emissionJoinRefusal.ok && !extractionJoinRefusal.ok) {
      expect(emissionJoinRefusal.error.message).toBe(extractionJoinRefusal.error.message);
    }
  });

  it("retains the engine-refined refusal on the selection and never reaches the joins with the refused arguments (FR-006)", () => {
    const f = fixture("code-reviewer", 1);
    const binding = successorBinding(f.request.authority);
    const refined = { ...payload(), findings: [{ draft: { severity: "advisory" as const, file: null, line: null, claim: "Exact text ", reason: "   " }, relation: { kind: "independent" as const } }] };
    const selection = selectCanonicalPayload(
      binding,
      observeEmissionCalls([emissionCallFrame(binding, "call-successor-3", refined)]),
      [{ origin: "content[0].text", text: JSON.stringify(payload()) }],
    );
    expect(selection.kind).toBe("extraction-over-refused-call");
    if (selection.kind !== "extraction-over-refused-call") throw new Error("fixture must retain the refusal");
    expect(selection.emissionRefusal.code).toBe("invalid-payload");
    expect(selection.source).toBe("extraction");
    // The extraction fallback's admitted payload crosses the SAME joins.
    if (!selection.fallback.ok) throw new Error("fixture fallback must admit");
    expect(admitStandaloneSuccessorReviewer(f.issued, Uint8Array.from(selection.fallback.value.bytes)).ok).toBe(true);
  });
});
