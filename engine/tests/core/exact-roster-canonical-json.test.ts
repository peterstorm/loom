import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalExactRosterJson, parseExactRoster, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { panelRosterSlot } from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";

/** A real parsed roster of `size` refutation verifier slots. */
const exactRoster = (size: number) => {
  const runId = value(parseOrchestrationRunId("run.exact-roster-canonical-json"));
  return value(parseExactRoster(Array.from({ length: size }, (_, index) =>
    panelRosterSlot(runId, "verifier", index + 1, "refutation-panel", "review-verifier-agent"))));
};

describe("canonicalExactRosterJson", () => {
  it("omits the derived byId view of a parsed roster and keeps every other field in key order", () => {
    const roster = exactRoster(2);
    const canonical = canonicalExactRosterJson(roster);
    expect(Object.keys(canonical as object)).toEqual(["runId", "program", "orderedSlots"]);
    expect(canonical).toEqual({ runId: roster.runId, program: roster.program, orderedSlots: roster.orderedSlots });
    // The slots are carried, not copied: the canonical form is the parsed content itself.
    expect((canonical as { orderedSlots: unknown }).orderedSlots).toBe(roster.orderedSlots);
  });

  it("gives one canonical text for the real Map view and the legacy fake-Map record alike", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), (size) => {
      const durable = JSON.parse(JSON.stringify(exactRoster(size)));
      // Today's real immutable Map stringifies as `{}`; the fake-Map record it
      // replaced stringified as `{"size":N}` and still sits in old checkpoints.
      expect(durable.byId).toEqual({});
      const legacy = { ...durable, byId: { size } };
      expect(JSON.stringify(canonicalExactRosterJson(legacy))).toBe(JSON.stringify(canonicalExactRosterJson(durable)));
      expect(JSON.stringify(canonicalExactRosterJson(durable))).not.toContain("byId");
    }), { numRuns: 8 });
  });

  it("still distinguishes rosters whose recorded slots differ", () => {
    const durable = JSON.parse(JSON.stringify(exactRoster(2)));
    const reordered = { ...durable, orderedSlots: [...durable.orderedSlots].reverse() };
    expect(JSON.stringify(canonicalExactRosterJson(reordered))).not.toBe(JSON.stringify(canonicalExactRosterJson(durable)));
  });

  it("passes a value that is not a record through unchanged, so it still compares unequal", () => {
    const array = [{ byId: {} }];
    for (const raw of [null, undefined, 0, "roster", true, array]) {
      expect(canonicalExactRosterJson(raw)).toBe(raw);
    }
  });

  it("drops only a top-level byId and never mutates its input", () => {
    // Frozen: a write to the input would throw rather than pass silently.
    const raw = Object.freeze({ byId: { size: 1 }, orderedSlots: Object.freeze([{ byId: "nested" }]), extra: true });
    expect(canonicalExactRosterJson(raw)).toEqual({ orderedSlots: [{ byId: "nested" }], extra: true });
  });
});
