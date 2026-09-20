import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildContextPacket, buildReviewerContextPacket, parseContextPacket, encodeByteSection,
  contextPacketDigest, contextPacketByteLength, CONTEXT_PACKET_SCHEMA_VERSION, REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION,
  type ByteSection, type ContextPacketInput, type ReviewerContextPacketV2,
} from "../../src/core/context-packets";
import {
  CURRENT_REVIEWER_PROTOCOL, REVIEWER_FIXED_SECTIONS, REVIEWER_OUTPUT_CONTRACT,
  parseReviewerProtocolDescriptor, REVIEWER_PAYLOAD_EXAMPLE_V2,
} from "../../src/core/reviewer-contract";
import { parseReviewerPayloadV2 } from "../../src/core/reviewer-protocol";
import { parseRequestId } from "../../src/core/orchestration-contract";
import { sha256Hex } from "../../src/core/review-packet";

function section(label: string, text: string): ByteSection {
  const encoded = encodeByteSection(label, text);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
}
const request = parseRequestId("reviewer-request-1");
if (!request.ok) throw new Error("invalid fixture request");
const input: ContextPacketInput = {
  requestId: request.value, role: "code-reviewer", requiredSkill: "none", outputContract: "legacy Machine Summary",
  fixedContext: [section("scope", "src/a.ts")], variableContext: [],
};
function current(overrides: Partial<Omit<ContextPacketInput, "outputContract">> = {}): ReviewerContextPacketV2 {
  const built = buildReviewerContextPacket({ ...input, ...overrides });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}
const rehash = (packet: ReviewerContextPacketV2): ReviewerContextPacketV2 => ({ ...packet, digest: contextPacketDigest(packet) });
const textOf = (entry: ByteSection): string => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(entry.bytes));

const roles = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer", "comment-analyzer", "architecture-tech-lead", "code-simplifier"];
describe("reviewer-only v2 Context Packet", () => {
  it.each(roles)("issues the authoritative schema/rubric for %s", (role) => {
    const packet = current({ role });
    expect(packet.schemaVersion).toBe(2);
    expect(packet.reviewerProtocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    expect(packet.outputContract).toBe(REVIEWER_OUTPUT_CONTRACT);
    for (const expected of REVIEWER_FIXED_SECTIONS) {
      const found = packet.fixedContext.filter((entry) => entry.label === expected.label);
      expect(found.length).toBe(1);
      expect(textOf(found[0])).toBe(expected.text);
      expect(found[0].digest).toBe(sha256Hex(expected.text));
    }
    expect(parseContextPacket(JSON.parse(JSON.stringify(packet)))).toEqual({ ok: true, value: packet });
    expect(parseReviewerPayloadV2(new TextEncoder().encode(JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2))).ok).toBe(true);
  });
  it.each(["spec-check", "review-verifier", "skill-content-reviewer", "security-agent", "architecture-agent", "", "code-reviewer-extra"])("does not issue v2 to %j", (role) => {
    expect(buildReviewerContextPacket({ ...input, role }).ok).toBe(false);
    expect(parseContextPacket(rehash({ ...current(), role })).ok).toBe(false);
  });
  it.each(REVIEWER_FIXED_SECTIONS)("reserves $label in both section classes", ({ label }) => {
    for (const kind of ["fixedContext", "variableContext"] as const) {
      expect(buildReviewerContextPacket({ ...input, [kind]: [section(label, "replacement")] }).ok).toBe(false);
    }
  });
  it("adds its own sections even without caller sections, but the legacy builder stays unchanged", () => {
    expect(buildReviewerContextPacket({ ...input, fixedContext: [], variableContext: [] }).ok).toBe(true);
    expect(buildContextPacket({ ...input, fixedContext: [], variableContext: [] }).ok).toBe(false);
  });
  it("hashes the descriptor immediately after outputContract and before sections", () => {
    const packet = current();
    const sectionIdentity = (entry: ByteSection) => ({ label: entry.label, digest: entry.digest, byteLength: entry.byteLength });
    const identity = {
      schemaVersion: 2, requestId: packet.requestId, role: packet.role, requiredSkill: packet.requiredSkill,
      outputContract: packet.outputContract, reviewerProtocol: packet.reviewerProtocol,
      fixedContext: packet.fixedContext.map(sectionIdentity), variableContext: packet.variableContext.map(sectionIdentity),
    };
    expect(packet.digest).toBe(sha256Hex(JSON.stringify(identity)));
    const { reviewerProtocol, ...without } = identity;
    expect(packet.digest).not.toBe(sha256Hex(JSON.stringify({ ...without, reviewerProtocol })));
    expect(contextPacketByteLength(packet)).toBe(packet.fixedContext.reduce((sum, entry) => sum + entry.bytes.length, 0));
  });
  it("retains all input bytes without aliasing caller arrays, and freezes every level", () => {
    const data = { ...input, fixedContext: [...input.fixedContext], variableContext: [section("task", "exact\n 🧵 bytes")] };
    const before = JSON.stringify(data);
    const packet = current(data);
    expect(JSON.stringify(data)).toBe(before);
    data.fixedContext.length = 0;
    data.variableContext.length = 0;
    expect(packet.fixedContext.length).toBe(3);
    expect(textOf(packet.variableContext[0])).toBe("exact\n 🧵 bytes");
    for (const value of [packet, packet.reviewerProtocol, packet.fixedContext, packet.variableContext, ...packet.fixedContext, ...packet.fixedContext.map((entry) => entry.bytes)]) expect(Object.isFrozen(value)).toBe(true);
  });
  it("keeps large parsed sections compact while preserving immutable array behavior", () => {
    const packet = current({ variableContext: [section("large", "abcd".repeat(150_000))] });
    const serialized = JSON.stringify(packet);
    const parsed = parseContextPacket(JSON.parse(serialized));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const bytes = parsed.value.variableContext[0]!.bytes;
    expect(Array.isArray(bytes)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(true);
    expect(Object.keys(bytes)).toEqual([]);
    expect(bytes.length).toBe(600_000);
    expect(bytes.slice(0, 8)).toEqual([97, 98, 99, 100, 97, 98, 99, 100]);
    expect(Buffer.from(bytes).subarray(-4).toString()).toBe("abcd");
    expect(JSON.stringify(parsed.value)).toBe(serialized);
    expect(() => { (bytes as number[])[0] = 0; }).toThrow();
    expect(bytes[0]).toBe(97);
  });
  it("round-trips arbitrary variable bytes and changes identity without changing fixed contract", () => {
    fc.assert(fc.property(fc.string({ maxLength: 100 }), (text) => {
      const first = current({ variableContext: [section("task", text)] });
      const second = current({ variableContext: [section("task", text + "x")] });
      expect(parseContextPacket(first)).toEqual({ ok: true, value: first });
      expect(first.digest).not.toBe(second.digest);
      expect(first.fixedContext).toEqual(second.fixedContext);
      expect(first.reviewerProtocol).toEqual(second.reviewerProtocol);
    }), { seed: 4010, numRuns: 40 });
  });
  it("refuses missing/duplicate/moved/replaced reserved sections even after honest rehashing", () => {
    const packet = current();
    for (const expected of REVIEWER_FIXED_SECTIONS) {
      const owned = packet.fixedContext.find((entry) => entry.label === expected.label)!;
      const remaining = packet.fixedContext.filter((entry) => entry.label !== expected.label);
      const replacements = [
        { ...packet, fixedContext: remaining },
        { ...packet, fixedContext: [...packet.fixedContext, owned] },
        { ...packet, fixedContext: remaining, variableContext: [owned] },
        { ...packet, fixedContext: [...remaining, section(expected.label, expected.text + "\n")] },
        { ...packet, fixedContext: packet.fixedContext.map((entry) => entry === owned ? { ...entry, bytes: [0, ...entry.bytes.slice(1)] } : entry) },
      ];
      for (const replacement of replacements) expect(parseContextPacket(rehash(replacement)).ok).toBe(false);
    }
    expect(parseContextPacket(rehash({ ...packet, outputContract: "Emit legacy Machine Summary" })).ok).toBe(false);
  });
  it("refuses altered request/role/Skill/section identities without matching digest", () => {
    const packet = current();
    for (const altered of [{ ...packet, requestId: "other" }, { ...packet, role: "comment-analyzer" }, { ...packet, requiredSkill: "other" }, { ...packet, digest: "0".repeat(64) }, { ...packet, extra: 1 }]) expect(parseContextPacket(altered).ok).toBe(false);
  });
  it("requires exact descriptor, with no v1 fallback or inherited authority", () => {
    const packet = current();
    for (const reviewerProtocol of [undefined, null, {}, { ...CURRENT_REVIEWER_PROTOCOL, version: 1 }, { ...CURRENT_REVIEWER_PROTOCOL, rubricVersion: 2 }, { ...CURRENT_REVIEWER_PROTOCOL, schemaDigest: "0".repeat(64) }, { ...CURRENT_REVIEWER_PROTOCOL, rubricDigest: "0".repeat(64) }, { ...CURRENT_REVIEWER_PROTOCOL, extra: true }, Object.create(CURRENT_REVIEWER_PROTOCOL)]) {
      expect(parseReviewerProtocolDescriptor(reviewerProtocol).ok).toBe(false);
      expect(parseContextPacket({ ...packet, reviewerProtocol }).ok).toBe(false);
    }
    expect(parseContextPacket(Object.create(packet)).ok).toBe(false);
    expect(parseContextPacket({ ...packet, schemaVersion: 1 }).ok).toBe(false);
    expect(parseContextPacket({ ...packet, schemaVersion: 3 }).ok).toBe(false);
    const { reviewerProtocol: _removed, ...stripped } = packet;
    expect(parseContextPacket(stripped).ok).toBe(false);
  });
  it("turns hostile descriptor/packet inspection into typed failure", () => {
    for (const raw of [new Proxy({}, { getPrototypeOf() { throw new Error("hostile"); } }), { get protocol() { throw new Error("hostile"); } }]) expect(parseReviewerProtocolDescriptor(raw).ok).toBe(false);
    expect(parseContextPacket({ get schemaVersion() { throw new Error("hostile"); } }).ok).toBe(false);
    expect(parseContextPacket({ ...current(), get reviewerProtocol() { throw new Error("must not invoke accessor"); } }).ok).toBe(false);
  });
});

describe("historical and non-reviewer Context Packets remain v1", () => {
  it("retains the old constants, object ordering, bytes, and digest identity", () => {
    expect(CONTEXT_PACKET_SCHEMA_VERSION).toBe(1);
    expect(REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION).toBe(2);
    const result = buildContextPacket(input);
    if (!result.ok) throw new Error(result.error.message);
    const packet = result.value;
    expect(packet.schemaVersion).toBe(1);
    expect(Object.keys(packet)).toEqual(["schemaVersion", "requestId", "role", "requiredSkill", "outputContract", "fixedContext", "variableContext", "digest"]);
    expect(packet).not.toHaveProperty("reviewerProtocol");
    expect(packet.fixedContext).toEqual(input.fixedContext);
    const oldIdentity = JSON.stringify({
      schemaVersion: 1, requestId: input.requestId, role: input.role, requiredSkill: input.requiredSkill, outputContract: input.outputContract,
      fixedContext: input.fixedContext.map(({ label, digest, byteLength }) => ({ label, digest, byteLength })), variableContext: [],
    });
    expect(packet.digest).toBe(sha256Hex(oldIdentity));
    expect(parseContextPacket(JSON.parse(JSON.stringify(packet)))).toEqual(result);
  });
  it("does not cut over any existing builder caller, including reviewers or spec-check", () => {
    for (const role of [...roles, "spec-check", "review-verifier", "architecture-agent"]) {
      const result = buildContextPacket({ ...input, role });
      expect(result.ok && result.value.schemaVersion).toBe(1);
    }
    // These names were not reserved by v1; do not retrospectively enforce a rubric.
    const legacy = buildContextPacket({ ...input, fixedContext: [section("reviewer-impact-rubric", "old arbitrary bytes")] });
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(parseContextPacket(legacy.value)).toEqual(legacy);
  });
});
