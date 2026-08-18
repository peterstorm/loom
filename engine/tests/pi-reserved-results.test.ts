/**
 * Unit tests for the reserved-result classification extracted out of
 * `pi/extension.ts`'s `tool_result` handler.
 *
 * These rules decide which gate-owned evidence gets invalidated when a Pi child
 * disappears. Before the extraction the only test that reached them was the
 * full fake-harness integration fixture, so a wrong branch here was expensive
 * to see and easy to miss. Each case below states one rule directly.
 */

import { describe, expect, it } from "vitest";
import {
  classifyMissingReservedResults,
  type ReservedResultItem,
} from "../../pi/reserved-results";

const item = (over: Partial<ReservedResultItem> = {}): ReservedResultItem => ({
  agentType: "code-reviewer",
  taskId: "T1",
  kind: "review",
  ...over,
});

/** The envelope shape the harness returns for a result that DID arrive. */
const returned = (agent: string) => ({ agent, exitCode: 0 });

describe("classifyMissingReservedResults", () => {
  describe("a batch bound to an orchestration run", () => {
    it("reports every unmatched slot as a missing run result and claims no gate evidence", () => {
      const items = [item(), item({ agentType: "silent-failure-hunter" })];

      const missing = classifyMissingReservedResults(items, [returned("code-reviewer")], true);

      expect(missing.runResults.map((m) => m.index)).toEqual([1]);
      expect(missing.reviews).toEqual([]);
      expect(missing.specChecks).toEqual([]);
    });

    it("reports nothing when every slot reported", () => {
      const items = [item(), item({ agentType: "spec-check-invoker", taskId: null })];

      const missing = classifyMissingReservedResults(
        items,
        [returned("code-reviewer"), returned("spec-check-invoker")],
        true,
      );

      expect(missing.runResults).toEqual([]);
    });
  });

  describe("a batch NOT bound to an orchestration run", () => {
    it("reports a missing reviewer as missing review evidence, never as a run result", () => {
      const missing = classifyMissingReservedResults([item()], [], false);

      expect(missing.reviews.map((m) => m.item.agentType)).toEqual(["code-reviewer"]);
      expect(missing.runResults).toEqual([]);
    });

    it("reports a missing spec-check separately from reviewers", () => {
      const items = [item(), item({ agentType: "spec-check-invoker" })];

      const missing = classifyMissingReservedResults(items, [], false);

      expect(missing.reviews.map((m) => m.index)).toEqual([0]);
      expect(missing.specChecks.map((m) => m.index)).toEqual([1]);
    });

    it("ignores a standalone slot — it owns no task-graph evidence to invalidate", () => {
      const missing = classifyMissingReservedResults([item({ kind: "standalone" })], [], false);

      expect(missing.reviews).toEqual([]);
      expect(missing.specChecks).toEqual([]);
    });

    it("ignores a reviewer with no task id — there is no task to record the failure against", () => {
      const missing = classifyMissingReservedResults([item({ taskId: null })], [], false);

      expect(missing.reviews).toEqual([]);
    });

    it("ignores a non-review, non-spec-check agent", () => {
      const missing = classifyMissingReservedResults(
        [item({ agentType: "code-implementer-agent", kind: "implementation" })],
        [],
        false,
      );

      expect(missing.reviews).toEqual([]);
      expect(missing.specChecks).toEqual([]);
    });
  });

  describe("what counts as 'the result arrived'", () => {
    it("treats a result from the WRONG agent as an absence — position alone does not prove reporting", () => {
      const missing = classifyMissingReservedResults([item()], [returned("silent-failure-hunter")], false);

      expect(missing.reviews.map((m) => m.index)).toEqual([0]);
    });

    it("matches a namespaced agent name against the bare reserved type", () => {
      const missing = classifyMissingReservedResults([item()], [returned("loom:code-reviewer")], false);

      expect(missing.reviews).toEqual([]);
    });

    it.each([
      ["a non-object entry", "code-reviewer"],
      ["null", null],
      ["an array", []],
      ["an envelope with no agent field", { exitCode: 0 }],
      ["an envelope whose agent is not a string", { agent: 7 }],
    ])("treats %s as an absence rather than trusting the slot", (_label, raw) => {
      const missing = classifyMissingReservedResults([item()], [raw], false);

      expect(missing.reviews.map((m) => m.index)).toEqual([0]);
    });

    it("keeps each slot's own batch index when an earlier result is missing", () => {
      const items = [item(), item({ agentType: "silent-failure-hunter" })];

      // Position 0 is absent; position 1 holds the SECOND reviewer's result.
      const missing = classifyMissingReservedResults(
        items,
        [undefined, returned("silent-failure-hunter")],
        false,
      );

      expect(missing.reviews.map((m) => m.index)).toEqual([0]);
    });
  });

  it("returns frozen results — a caller cannot mutate the classification it was handed", () => {
    const missing = classifyMissingReservedResults([item()], [], false);

    expect(Object.isFrozen(missing)).toBe(true);
    expect(Object.isFrozen(missing.reviews)).toBe(true);
    expect(() => (missing.reviews as unknown as unknown[]).push({})).toThrow();
  });
});
