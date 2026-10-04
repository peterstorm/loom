import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priorFindingRetires } from "../../src/core/findings";

const vote = (agent: string, verdict: "resolved_by_remediation" | "still_present", reason = "checked") =>
  ({ agent, verdict, reason });

describe("priorFindingRetires", () => {
  it("lets the owning reviewer retire its finding over evidence-free dissent", () => {
    expect(priorFindingRetires("pr-test-analyzer", [
      vote("pr-test-analyzer", "resolved_by_remediation"),
      vote("code-reviewer", "still_present", "runner.test.ts still lacks a fake-route test"),
      vote("comment-analyzer", "still_present", "Outside my scope; not re-verified"),
    ])).toBe(true);
  });

  it("keeps a finding its owner still sees, or that a dissent pins to a file and line", () => {
    expect(priorFindingRetires("type-design-analyzer", [
      vote("type-design-analyzer", "still_present"),
      vote("code-reviewer", "resolved_by_remediation"),
    ])).toBe(false);
    expect(priorFindingRetires("type-design-analyzer", [
      vote("type-design-analyzer", "resolved_by_remediation"),
      vote("code-reviewer", "still_present", "pilot-core.ts:813 still widens the measured variant"),
    ])).toBe(false);
  });

  it("requires unanimity when the owner is not on the roster, and never retires on no votes", () => {
    expect(priorFindingRetires("recovered-view", [vote("code-reviewer", "resolved_by_remediation")])).toBe(true);
    expect(priorFindingRetires("recovered-view", [
      vote("code-reviewer", "resolved_by_remediation"),
      vote("comment-analyzer", "still_present"),
    ])).toBe(false);
    expect(priorFindingRetires("code-reviewer", [])).toBe(false);
  });

  it("property: unanimous resolution always retires, and an owner's still_present never does", () => {
    const agents = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer"];
    fc.assert(fc.property(fc.subarray(agents, { minLength: 1 }), fc.string(), (roster, reason) => {
      const owner = roster[0]!;
      expect(priorFindingRetires(owner, roster.map((agent) => vote(agent, "resolved_by_remediation", reason)))).toBe(true);
      expect(priorFindingRetires(owner, roster.map((agent) =>
        vote(agent, agent === owner ? "still_present" : "resolved_by_remediation", reason)))).toBe(false);
    }));
  });
});
