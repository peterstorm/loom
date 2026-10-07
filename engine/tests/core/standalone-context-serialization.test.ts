import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildStandaloneReviewerContextPacketV3, encodeByteSection, serializeStandaloneReviewerContextPacketV3 } from "../../src/core/context-packets";
import { parseRequestId } from "../../src/core/orchestration-contract";
import { admitStandaloneSuccessorPacketSize, standaloneSuccessorPackets } from "../../src/handlers/helpers/programs/standalone-successor-source";
import { prepareStandaloneLineageSource, prepareStandaloneSuccessor } from "../../src/core/standalone-review";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { wrapStandalonePanelLine } from "../../src/orchestration/standalone-panel-context";
const value = <T>(result: { ok: true; value: T } | { ok: false }): T => {
  if (!result.ok) throw Error("fixture parser refused");
  return result.value;
};

describe("immutable successor section serialization", () => {
  it("conserves exact canonical JSON bytes across repeated packets and round trips", () => {
    fc.assert(fc.property(fc.string(), text => {
      const section = value(encodeByteSection("fixture", text));
      for (const role of ["code-reviewer", "type-design-analyzer"] as const) {
        const packet = value(buildStandaloneReviewerContextPacketV3({ requestId: value(parseRequestId(`request:${role}`)),
          role, requiredSkill: "none", fixedContext: [section], variableContext: [] }));
        const expected = JSON.stringify(packet);
        expect(value(serializeStandaloneReviewerContextPacketV3(packet))).toBe(expected);
        expect(value(serializeStandaloneReviewerContextPacketV3(packet))).toBe(expected);
        expect(value(serializeStandaloneReviewerContextPacketV3(JSON.parse(expected)))).toBe(expected);
        const changed = { ...packet, fixedContext: [{ ...section, bytes: [...section.bytes, 0] }, ...packet.fixedContext.slice(1)] };
        expect(serializeStandaloneReviewerContextPacketV3(changed).ok).toBe(false);
        expect(Object.isFrozen(section.bytes)).toBe(true);
      }
    }), { numRuns: 30 });
  });

  it("refuses a component-bounded packet whose exact byte-array serialization exceeds retained reads", () => {
    const section = value(encodeByteSection("fixture", "😀".repeat(1_048_576)));
    expect(section.byteLength).toBe(4_194_304);
    const packet = value(buildStandaloneReviewerContextPacketV3({
      requestId: value(parseRequestId("request:serialized-budget")),
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: [],
      variableContext: [section],
    }));
    const serialized = value(serializeStandaloneReviewerContextPacketV3(packet));
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(16_777_216);
    expect(admitStandaloneSuccessorPacketSize(packet)).toEqual({
      ok: false,
      message: "successor packet exceeds 16777216 serialized byte budget",
    });
  });

  it("refuses amplified serialization through the production successor packet constructor", () => {
    const prior = value(prepareStandaloneLineageSource(
      standaloneFixture(undefined, true).input.standaloneResult,
      "/owned/predecessor",
    ));
    const prepared = value(prepareStandaloneSuccessor(prior, new TextEncoder().encode(JSON.stringify({
      runId: "run.serialized-production-budget",
      snapshot: prior.scope.map(path => ({ kind: "absent", path })),
      reviewers: prior.reviewers,
    })), { kind: "historical-decision-unavailable" }));
    const current = value(encodeByteSection("standalone-frozen-source", JSON.stringify({
      schemaVersion: 2,
      headRevision: "a".repeat(40),
      files: prepared.snapshot.map(({ path }) => ({ path, kind: "absent", digest: null, byteLength: 0 })),
    })));
    const amplified = Array.from({ length: 24 }, (_, index) =>
      value(encodeByteSection(`amplified-${index}`, "😀".repeat(43_510))));

    const packets = standaloneSuccessorPackets(prepared, current, amplified);
    if (packets.ok) {
      const serialized = value(serializeStandaloneReviewerContextPacketV3(packets.value.packets[0]!));
      throw new Error(`production constructor admitted ${Buffer.byteLength(serialized, "utf8")} serialized bytes`);
    }
    expect(packets.message).toBe("successor packet exceeds 16777216 serialized byte budget");
  });

  it("wraps display lines without splitting astral Unicode characters", () => {
    const original = `${"a".repeat(4095)}😀tail`;
    const chunks = wrapStandalonePanelLine(original);
    expect(chunks.join("")).toBe(original);
    expect(chunks.every(chunk => chunk.length <= 4096)).toBe(true);
    expect(Buffer.from(chunks.join("\n"), "utf8").toString("utf8")).not.toContain("�");
  });
});
