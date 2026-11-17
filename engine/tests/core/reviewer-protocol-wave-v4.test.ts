/**
 * Wave reviewer protocol v4 (ADR-0083): the Wave payload carries no packet
 * identity, and the engine binds the Review Packet ID and Review Generation
 * from the issued subject. A v2-registered Wave run is unchanged, and v4 is
 * Wave-only.
 */
import { describe, expect, it } from "vitest";
import { buildReviewerContextPacket, encodeByteSection, parseContextPacket, type ContextPacket } from "../../src/core/context-packets";
import {
  REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_PROTOCOL_V2, WAVE_REVIEWER_PAYLOAD_SCHEMA_V4,
  WAVE_REVIEWER_PROTOCOL_V4, WAVE_REVIEWER_WIRE_CONTRACT_EXAMPLE_V4, parseReviewerProtocolDescriptorFor,
  parseReviewerProtocolDescriptorV2, parseWaveReviewerProtocolDescriptor, type ReviewerProtocolDescriptor,
} from "../../src/core/reviewer-contract";
import { parseWaveReviewerPayloadV4 } from "../../src/core/reviewer-protocol";
import { sha256Hex } from "../../src/core/digest";
import { parseOrchestrationRunId, parseRequestId, type SpawnRequest } from "../../src/core/orchestration-contract";
import {
  parseIssuedReviewerProtocol, parseReviewerEvidence, type ReviewerProtocolRegistration, type ReviewerSubjectBinding,
} from "../../src/core/review-output";
import { attributeFindings } from "../../src/core/findings";
import { value } from "../fixtures/parse-result";
import { publishReviewerRequest } from "../fixtures/reviewer-publication";

const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));
const runId = value(parseOrchestrationRunId("run.wave-v4"));
const priors = attributeFindings([
  { severity: "critical", claim: "one", file: null, line: null },
  { severity: "critical", claim: "two", file: null, line: null },
], "prior");
const packetId = "a".repeat(64);
const generation = 3;
const critical = { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, file: "src/a.ts", line: 4 };

const publish = (packet: ContextPacket, program: "wave-gate" | "standalone-review"): SpawnRequest =>
  publishReviewerRequest(packet, { runId, program, attempt: 1 });

function waveInput() {
  const section = { runId, wave: 1, authorityDigest: "b".repeat(64), batchEpoch: "c".repeat(64), subject: { role: "code-reviewer", taskId: "T1" },
    taskRun: { taskId: "T1", generation, packetId, headSha: "c".repeat(64) },
    task: { id: "T1", description: "review", agent: "code-implementer-agent", reviewGeneration: generation, planContext: null,
      specAnchors: [], specContributions: [], declaredFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"], proof: null, testResult: null, priorFindings: priors },
    specCheckScope: null, packetId, specFile: null, planFile: null };
  return { requestId: value(parseRequestId("request:code-reviewer:1")), role: "code-reviewer", requiredSkill: "none",
    fixedContext: [value(encodeByteSection("wave-review-authority", JSON.stringify(section)))], variableContext: [] };
}

const subject: Extract<ReviewerSubjectBinding, { kind: "wave-review" }> = {
  kind: "wave-review", runId, scope: ["src/a.ts", "src/b.ts"], taskId: "T1", packetId, generation,
  priorFindingIds: priors.map(({ id }) => id),
};

function waveAuthority(descriptor: ReviewerProtocolDescriptor) {
  const packet = value<ContextPacket>(buildReviewerContextPacket(waveInput(), descriptor));
  const request = publish(packet, "wave-gate");
  const registration: ReviewerProtocolRegistration = { schemaVersion: 2, runId, program: "wave-gate", reviewerProtocol: descriptor };
  return value(parseIssuedReviewerProtocol({ request, packet, registration, subject }));
}

const assessed = subject.priorFindingIds.map((finding_id) => ({ finding_id, verdict: "still_present", reason: "remains" }));
const v4Payload = (overrides: Record<string, unknown> = {}) =>
  ({ schemaVersion: 4, kind: "wave-review", prior_findings: assessed, findings: [critical], ...overrides });

describe("Wave reviewer protocol v4", () => {
  it("admits a payload without packet identity and binds packet and generation from the issued subject", () => {
    const evidence = parseReviewerEvidence(waveAuthority(WAVE_REVIEWER_PROTOCOL_V4), bytes(v4Payload()));
    expect(evidence.ok).toBe(true);
    if (!evidence.ok || evidence.value.kind !== "wave-review" || evidence.value.protocolVersion !== 2) throw new Error("current Wave evidence expected");
    expect(evidence.value.bound.packetId).toBe(packetId);
    expect(evidence.value.bound.generation).toBe(generation);
    expect(evidence.value.bound.priorAssessments.map(({ finding_id }) => finding_id)).toEqual(subject.priorFindingIds);
    expect(evidence.value.findings.criticalCount).toBe(1);
  });

  it.each([
    ["packetId", { packetId }],
    ["generation", { generation }],
  ])("refuses a v4 payload that carries %s", (_field, extra) => {
    const evidence = parseReviewerEvidence(waveAuthority(WAVE_REVIEWER_PROTOCOL_V4), bytes(v4Payload(extra)));
    expect(evidence.ok).toBe(false);
    if (evidence.ok) return;
    expect(evidence.error.code).toBe("invalid-payload");
    expect(evidence.error.message).toContain("issued Wave v4 schema");
  });

  it.each([
    ["missing", []],
    ["reordered", [...assessed].reverse()],
    ["duplicated", [...assessed, ...assessed]],
  ])("still requires the full ordered prior roster: %s", (_case, prior_findings) => {
    const evidence = parseReviewerEvidence(waveAuthority(WAVE_REVIEWER_PROTOCOL_V4), bytes(v4Payload({ prior_findings })));
    expect(evidence.ok).toBe(false);
    if (!evidence.ok) expect(evidence.error.code).toBe("invalid-prior-assessments");
  });

  it("names the out-of-scope finding file", () => {
    const evidence = parseReviewerEvidence(
      waveAuthority(WAVE_REVIEWER_PROTOCOL_V4),
      bytes(v4Payload({ findings: [{ ...critical, file: "src/outside.ts" }] })),
    );
    expect(evidence).toMatchObject({ ok: false, error: {
      code: "out-of-scope", path: "/findings/0/file",
      message: "findings[0].file is outside the frozen review scope: src/outside.ts",
    } });
  });

  it("refuses the v2 envelope under a v4 registration with the v4 envelope named", () => {
    const evidence = parseReviewerEvidence(waveAuthority(WAVE_REVIEWER_PROTOCOL_V4),
      bytes({ schemaVersion: 2, kind: "wave-review", packetId, generation, prior_findings: assessed, findings: [] }));
    expect(evidence.ok).toBe(false);
    if (!evidence.ok) expect(evidence.error.message).toContain('"schemaVersion": 4');
  });

  it("issues the v4 schema bytes and descriptor in the Context Packet, and the packet round-trips", () => {
    const packet = value(buildReviewerContextPacket(waveInput(), WAVE_REVIEWER_PROTOCOL_V4));
    expect(packet.reviewerProtocol).toEqual(WAVE_REVIEWER_PROTOCOL_V4);
    const schema = packet.fixedContext.find(({ label }) => label === "reviewer-payload-schema");
    expect(new TextDecoder().decode(Uint8Array.from(schema!.bytes))).toBe(WAVE_REVIEWER_PAYLOAD_SCHEMA_V4);
    expect(value(parseContextPacket(JSON.parse(JSON.stringify(packet)))).digest).toBe(packet.digest);
    expect(WAVE_REVIEWER_PROTOCOL_V4.schemaDigest).toBe(sha256Hex(WAVE_REVIEWER_PAYLOAD_SCHEMA_V4));
  });

  it("refuses a packet whose descriptor and schema section disagree", () => {
    const v2 = value(buildReviewerContextPacket(waveInput(), REVIEWER_PROTOCOL_V2));
    const forged = { ...JSON.parse(JSON.stringify(v2)), reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 };
    expect(parseContextPacket(forged).ok).toBe(false);
  });

  it("refuses a v4 registration over a v2 packet", () => {
    const packet = value<ContextPacket>(buildReviewerContextPacket(waveInput(), REVIEWER_PROTOCOL_V2));
    const request = publish(packet, "wave-gate");
    const parsed = parseIssuedReviewerProtocol({ request, packet, subject,
      registration: { schemaVersion: 2, runId, program: "wave-gate", reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 } });
    expect(parsed.ok).toBe(false);
  });

  it("parses the shown Wave example with the v4 parser", () => {
    expect(parseWaveReviewerPayloadV4(bytes(WAVE_REVIEWER_WIRE_CONTRACT_EXAMPLE_V4)).ok).toBe(true);
    expect(WAVE_REVIEWER_WIRE_CONTRACT_EXAMPLE_V4).not.toHaveProperty("packetId");
  });
});

describe("Wave reviewer protocol v2 stays as it was", () => {
  it("keeps the v2 schema bytes", () => {
    expect(REVIEWER_PROTOCOL_V2.schemaDigest).toBe(sha256Hex(REVIEWER_PAYLOAD_SCHEMA_V2));
    expect(REVIEWER_PROTOCOL_V2.schemaDigest).toBe("3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37");
  });

  it("still requires packetId and generation and refuses a v4 payload", () => {
    const authority = waveAuthority(REVIEWER_PROTOCOL_V2);
    expect(parseReviewerEvidence(authority, bytes(v4Payload())).ok).toBe(false);
    expect(parseReviewerEvidence(authority, bytes({ schemaVersion: 2, kind: "wave-review", prior_findings: assessed, findings: [] })).ok).toBe(false);
    expect(parseReviewerEvidence(authority,
      bytes({ schemaVersion: 2, kind: "wave-review", packetId, generation, prior_findings: assessed, findings: [critical] })).ok).toBe(true);
  });
});

describe("v4 is Wave-only", () => {
  it("parses v4 only for the wave-gate program", () => {
    expect(parseWaveReviewerProtocolDescriptor(WAVE_REVIEWER_PROTOCOL_V4).ok).toBe(true);
    expect(parseReviewerProtocolDescriptorFor("wave-gate", WAVE_REVIEWER_PROTOCOL_V4).ok).toBe(true);
    expect(parseReviewerProtocolDescriptorFor("standalone-review", WAVE_REVIEWER_PROTOCOL_V4).ok).toBe(false);
    expect(parseReviewerProtocolDescriptorV2(WAVE_REVIEWER_PROTOCOL_V4).ok).toBe(false);
    expect(parseReviewerProtocolDescriptorFor("standalone-review", REVIEWER_PROTOCOL_V2).ok).toBe(true);
  });

  it("refuses a standalone registration that carries the v4 descriptor", () => {
    const input = { requestId: value(parseRequestId("request:code-reviewer:1")), role: "code-reviewer", requiredSkill: "none",
      fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({ runId, scope: ["src/a.ts"], role: "code-reviewer", attempt: 1 })))],
      variableContext: [] };
    const packet = value<ContextPacket>(buildReviewerContextPacket(input, WAVE_REVIEWER_PROTOCOL_V4));
    const request = publish(packet, "standalone-review");
    const parsed = parseIssuedReviewerProtocol({ request, packet,
      subject: { kind: "standalone-review", runId, scope: ["src/a.ts"] },
      registration: { schemaVersion: 2, runId, program: "standalone-review", reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 } });
    expect(parsed).toMatchObject({ ok: false, error: { code: "authority-mismatch", path: "/registration/reviewerProtocol" } });
  });
});
