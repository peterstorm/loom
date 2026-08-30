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
  alignPiImplementationAuthorities,
  classifyMissingReservedResults,
  unrecordableMissingEvidenceDiagnostic,
  type ReservedResultItem,
} from "../../pi/reserved-results";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../src/core/implementation-completion";

const item = (over: Partial<ReservedResultItem> = {}): ReservedResultItem => ({
  agentType: "code-reviewer",
  taskId: "T1",
  kind: "non-implementation",
  ...over,
});

/** The parseable envelope shape required before a result DID arrive. */
const returned = (agent: string, taskId = "T1") => ({ agent, task: `Task: ${taskId}`, exitCode: 0, messages: [] });

function authority(taskId: string, reservation: string) {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId(reservation);
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId, wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
    headSha: "1".repeat(40), reservedAt: instant.value,
    taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

describe("alignPiImplementationAuthorities", () => {
  it("carries registration order onto implementation slots while preserving non-implementation slots", () => {
    const t1 = authority("T1", "pi-t1");
    const t2 = authority("T2", "pi-t2");
    const aligned = alignPiImplementationAuthorities(
      [
        { agent: "code-reviewer", task: "Task ID: T1" },
        { agent: "code-implementer-agent", task: "Task ID: T2" },
        { agent: "code-implementer-agent", task: "Task ID: T1" },
      ],
      [
        { kind: "non-implementation" },
        { kind: "implementation", prompt: "Task ID: T2", description: "" },
        { kind: "implementation", prompt: "Task ID: T1", description: "" },
      ],
      [t2, t1],
    );
    expect(aligned).toEqual({ ok: true, authoritiesBySlot: [null, t2, t1] });
  });

  it.each([
    { name: "missing", authorities: [] },
    { name: "mismatched", authorities: [authority("T2", "pi-wrong")] },
    { name: "surplus", authorities: [authority("T1", "pi-right"), authority("T2", "pi-surplus")] },
  ])("rejects $name authority instead of permitting prompt inference", ({ authorities }) => {
    const result = alignPiImplementationAuthorities(
      [{ agent: "code-implementer-agent", task: "Task ID: T1" }],
      [{ kind: "implementation", prompt: "Task ID: T1", description: "" }],
      authorities,
    );
    expect(result).toMatchObject({ ok: false });
  });
});

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

    it("treats a matching reviewer for the wrong Task as missing reserved evidence", () => {
      const missing = classifyMissingReservedResults([item()], [returned("code-reviewer", "T2")], false);

      expect(missing.reviews).toEqual([{ item: item(), index: 0 }]);
    });

    it("requires the reserved Task identity for Task-bound run reviewers too", () => {
      const missing = classifyMissingReservedResults([item()], [returned("code-reviewer", "T2")], true);

      expect(missing.runResults).toEqual([{ item: item(), index: 0 }]);
    });

    it.each([
      ["a non-object entry", "code-reviewer"],
      ["null", null],
      ["an array", []],
      ["an envelope with no agent field", { task: "Task: T1", exitCode: 0, messages: [] }],
      ["an envelope whose agent is not a string", { ...returned("code-reviewer"), agent: 7 }],
      ["a matching-agent envelope with no task", { agent: "code-reviewer", exitCode: 0, messages: [] }],
      ["a matching-agent envelope whose task is not a string", { ...returned("code-reviewer"), task: 7 }],
      ["a matching-agent envelope with no exit code", { agent: "code-reviewer", task: "Task: T1", messages: [] }],
      ["a matching-agent envelope whose exit code is not a number", { ...returned("code-reviewer"), exitCode: "0" }],
      ["a matching-agent envelope with no messages", { agent: "code-reviewer", task: "Task: T1", exitCode: 0 }],
      ["a matching-agent envelope with an invalid stop reason", { ...returned("code-reviewer"), stopReason: 7 }],
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

/**
 * The ad-hoc arm. A batch spawned with no TaskGraph has no slot to mark, and
 * `extension.ts` used to skip the whole reporting block in that case — so a
 * reserved reviewer that died without returning left no trace anywhere. This is
 * the report that replaced the silence.
 */
describe("unrecordableMissingEvidenceDiagnostic", () => {
  it("names what was expected, for which session, and why nothing was recorded", () => {
    const diagnostic = unrecordableMissingEvidenceDiagnostic({
      sessionId: "session-adhoc",
      reviews: 2,
      specChecks: 1,
    });

    expect(diagnostic).toContain("2 reserved review result(s) and 1 reserved spec-check result(s)");
    expect(diagnostic).toContain("session-adhoc");
    expect(diagnostic).toContain("cannot be recorded as evidence_capture_failed");
    expect(diagnostic).toContain("no TaskGraph was active at spawn");
  });

  it("counts a zero side honestly instead of dropping the sentence for it", () => {
    expect(unrecordableMissingEvidenceDiagnostic({ sessionId: "s", reviews: 0, specChecks: 3 }))
      .toContain("0 reserved review result(s) and 3 reserved spec-check result(s)");
  });
});
