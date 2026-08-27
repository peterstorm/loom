import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG,
  AGENT_POLICIES,
  agentsOfKind,
  isImplementationAgent,
  isStandaloneReviewAgent,
  WAVE_REVIEW_AGENTS,
  type AgentKind,
} from "../../src/core/model-profiles";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";
import {
  ARCH_PANEL_AGENTS,
  IMPL_AGENTS,
  PHASE_AGENT_MAP,
  REVIEW_AGENTS,
  REVIEW_PANEL_AGENTS,
  REVIEW_SUB_AGENTS,
  WAVE_REVIEW_AGENTS as CONFIG_WAVE_REVIEW_AGENTS,
} from "../../src/config";

/**
 * The Agent Catalog is the single identity source; everything an agent's name
 * used to mean in four separate tables is now a projection. These are golden
 * tests: they pin the exact memberships the pre-catalog literals declared, so
 * the derivation refactor is provably behavior-neutral, and any future catalog
 * edit shows up here as an explicit membership change rather than drift.
 */
describe("Agent Catalog projections match the pre-catalog memberships", () => {
  it("phase agents and their phases", () => {
    expect(PHASE_AGENT_MAP).toEqual(Object.assign(Object.create(null), {
      "brainstorm-agent": "brainstorm",
      "specify-agent": "specify",
      "clarify-agent": "clarify",
      "architecture-agent": "architecture",
      "plan-alignment-agent": "plan-alignment",
      "decompose-agent": "decompose",
    }));
  });

  it("architecture-panel agents", () => {
    expect([...ARCH_PANEL_AGENTS].sort()).toEqual(
      ["arch-designer-agent", "arch-interviewer-agent", "arch-judge-agent"],
    );
  });

  it("implementation agents", () => {
    expect([...IMPL_AGENTS].sort()).toEqual([
      "adr-writer-agent", "code-implementer-agent", "frontend-agent", "java-test-agent",
      "security-agent", "test-engineer", "ts-test-agent",
    ]);
    expect(isImplementationAgent("code-implementer-agent")).toBe(true);
    expect(isImplementationAgent("code-implementer")).toBe(true);
    expect(isImplementationAgent("code-reviewer")).toBe(false);
  });

  it("finding-producing reviewers", () => {
    expect([...REVIEW_SUB_AGENTS].sort()).toEqual([
      "architecture-tech-lead", "code-reviewer", "code-simplifier", "comment-analyzer",
      "pr-test-analyzer", "silent-failure-hunter", "type-design-analyzer",
    ]);
  });

  it("review agents add exactly the spec-check invoker", () => {
    const extra = [...REVIEW_AGENTS].filter((agent) => !REVIEW_SUB_AGENTS.has(agent));
    expect(extra).toEqual(["spec-check-invoker"]);
  });

  it("refutation-panel verifiers", () => {
    expect([...REVIEW_PANEL_AGENTS]).toEqual(["review-verifier-agent"]);
    expect(isStandaloneReviewAgent("code-reviewer")).toBe(true);
    expect(isStandaloneReviewAgent("review-verifier-agent")).toBe(true);
    expect(isStandaloneReviewAgent("code-implementer-agent")).toBe(false);
  });

  it("required skills are the catalog's requiredSkill column", () => {
    for (const { agent, requiredSkill } of AGENT_POLICIES) {
      expect(AGENT_REQUIRED_SKILLS[agent], agent).toBe(requiredSkill);
    }
  });

  // Golden values, not just cross-file consistency: an internally-consistent
  // rename of a reviewer's skill would pass every projection test while
  // silently changing which skill Pi's spawn gate demands.
  it("pins the reviewer/utility skill pairings by value", () => {
    expect(AGENT_CATALOG["architecture-tech-lead"].requiredSkill).toBe("deepen");
    expect(AGENT_CATALOG["code-simplifier"].requiredSkill).toBe("distill");
    expect(AGENT_CATALOG["spec-check-invoker"].requiredSkill).toBe("spec-check");
    expect(AGENT_CATALOG["deepen-agent"].requiredSkill).toBe("deepen");
  });
});

describe("the wave review roster is a selection from the catalog", () => {
  it("config and the wave-gate machine expose the SAME roster object", () => {
    expect(CONFIG_WAVE_REVIEW_AGENTS).toBe(WAVE_REVIEW_AGENTS);
  });

  it("keeps its index-binding order", () => {
    expect(WAVE_REVIEW_AGENTS).toEqual([
      "code-reviewer", "silent-failure-hunter", "pr-test-analyzer",
      "type-design-analyzer", "comment-analyzer",
    ]);
  });

  it("selects only reviewer-kind agents", () => {
    for (const agent of WAVE_REVIEW_AGENTS) {
      expect(AGENT_CATALOG[agent].kind.kind, agent).toBe("reviewer");
    }
  });
});

describe("catalog totality", () => {
  it("every agent has exactly one kind and the kinds partition the catalog", () => {
    const kinds: readonly AgentKind["kind"][] =
      ["phase", "arch-panel", "impl", "reviewer", "spec-check", "review-verifier", "utility"];
    const total = kinds.reduce((sum, k) => sum + agentsOfKind(k).length, 0);
    expect(total).toBe(AGENT_POLICIES.length);
  });
});
