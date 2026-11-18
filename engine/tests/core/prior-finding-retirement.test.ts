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
    ], "whole")).toBe(true);
  });

  it("keeps a finding its owner still sees, or that a dissent pins to a file and line", () => {
    expect(priorFindingRetires("type-design-analyzer", [
      vote("type-design-analyzer", "still_present"),
      vote("code-reviewer", "resolved_by_remediation"),
    ], "whole")).toBe(false);
    expect(priorFindingRetires("type-design-analyzer", [
      vote("type-design-analyzer", "resolved_by_remediation"),
      vote("code-reviewer", "still_present", "pilot-core.ts:813 still widens the measured variant"),
    ], "whole")).toBe(false);
  });

  it("requires unanimity when the owner is not on the roster, and never retires on no votes", () => {
    expect(priorFindingRetires("recovered-view", [vote("code-reviewer", "resolved_by_remediation")], "whole")).toBe(true);
    expect(priorFindingRetires("recovered-view", [
      vote("code-reviewer", "resolved_by_remediation"),
      vote("comment-analyzer", "still_present"),
    ], "whole")).toBe(false);
    expect(priorFindingRetires("code-reviewer", [], "whole")).toBe(false);
  });

  it("in a narrowed run (ADR-0093), never retires a Finding whose owner did not vote, however unanimous the rest", () => {
    expect(priorFindingRetires("silent-failure-hunter", [vote("comment-analyzer", "resolved_by_remediation")], "narrowed")).toBe(false);
    expect(priorFindingRetires("recovered-view", [vote("code-reviewer", "resolved_by_remediation")], "narrowed")).toBe(false);
    expect(priorFindingRetires("code-reviewer", [
      vote("code-reviewer", "resolved_by_remediation"),
      vote("comment-analyzer", "still_present", "not re-verified"),
    ], "narrowed")).toBe(true);
  });

  it("property: unanimous resolution always retires, and an owner's still_present never does", () => {
    const agents = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer"];
    fc.assert(fc.property(fc.subarray(agents, { minLength: 1 }), fc.string(), (roster, reason) => {
      const owner = roster[0]!;
      expect(priorFindingRetires(owner, roster.map((agent) => vote(agent, "resolved_by_remediation", reason)), "whole")).toBe(true);
      expect(priorFindingRetires(owner, roster.map((agent) =>
        vote(agent, agent === owner ? "still_present" : "resolved_by_remediation", reason)), "whole")).toBe(false);
    }));
  });

  it("property: a narrowed run retires a Finding only on its owner's vote", () => {
    const agents = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer", "comment-analyzer"];
    fc.assert(fc.property(fc.subarray(agents, { minLength: 1 }), fc.constantFrom(...agents), (voters, owner) => {
      const votes = voters.map((agent) => vote(agent, "resolved_by_remediation"));
      expect(priorFindingRetires(owner, votes, "narrowed")).toBe(voters.includes(owner));
    }));
  });
});
