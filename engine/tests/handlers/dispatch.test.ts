import { describe, it, expect } from "vitest";
import { categorize } from "../../src/handlers/subagent-stop/dispatch";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS, REVIEW_SUB_AGENTS } from "../../src/config";

describe("categorize (pure)", () => {
  it("categorizes phase agents", () => {
    expect(categorize("brainstorm-agent")).toBe("phase");
    expect(categorize("specify-agent")).toBe("phase");
    expect(categorize("clarify-agent")).toBe("phase");
    expect(categorize("architecture-agent")).toBe("phase");
    expect(categorize("decompose-agent")).toBe("phase");
  });

  it("categorizes impl agents", () => {
    expect(categorize("code-implementer-agent")).toBe("impl");
    expect(categorize("ts-test-agent")).toBe("impl");
    expect(categorize("frontend-agent")).toBe("impl");
    expect(categorize("security-agent")).toBe("impl");
    expect(categorize("general-purpose")).toBe("impl");
  });

  it("categorizes review sub-agents", () => {
    expect(categorize("code-reviewer")).toBe("review");
    expect(categorize("silent-failure-hunter")).toBe("review");
    expect(categorize("pr-test-analyzer")).toBe("review");
    expect(categorize("type-design-analyzer")).toBe("review");
    expect(categorize("comment-analyzer")).toBe("review");
    expect(categorize("code-simplifier")).toBe("review");
  });

  it("categorizes spec-check-invoker", () => {
    expect(categorize("spec-check-invoker")).toBe("spec-check");
  });

  it("returns unknown for unrecognized", () => {
    expect(categorize("random-agent")).toBe("unknown");
    expect(categorize("")).toBe("unknown");
  });
});

describe("categorize — exhaustive config coverage", () => {
  it("every PHASE_AGENT_MAP key → phase", () => {
    for (const agent of Object.keys(PHASE_AGENT_MAP)) {
      expect(categorize(agent)).toBe("phase");
    }
  });

  it("every IMPL_AGENTS member → impl", () => {
    for (const agent of IMPL_AGENTS) {
      expect(categorize(agent)).toBe("impl");
    }
  });

  it("every REVIEW_SUB_AGENTS member → review", () => {
    for (const agent of REVIEW_SUB_AGENTS) {
      expect(categorize(agent)).toBe("review");
    }
  });

  it("every REVIEW_AGENTS member → review or spec-check", () => {
    for (const agent of REVIEW_AGENTS) {
      const result = categorize(agent);
      expect(["review", "spec-check"]).toContain(result);
    }
  });

  it("dotfiles-agent covered", () => {
    expect(categorize("dotfiles-agent")).toBe("impl");
  });

  it("undefined/null-ish strings → unknown", () => {
    expect(categorize("")).toBe("unknown");
    expect(categorize("undefined")).toBe("unknown");
    expect(categorize("null")).toBe("unknown");
  });

  it("no overlap between agent sets", () => {
    const phaseKeys = new Set(Object.keys(PHASE_AGENT_MAP));
    for (const impl of IMPL_AGENTS) {
      expect(phaseKeys.has(impl)).toBe(false);
    }
    for (const review of REVIEW_AGENTS) {
      expect(phaseKeys.has(review)).toBe(false);
      expect(IMPL_AGENTS.has(review)).toBe(false);
    }
  });

  it("case-sensitive: uppercase variants → unknown", () => {
    expect(categorize("BRAINSTORM-AGENT")).toBe("unknown");
    expect(categorize("Code-Implementer-Agent")).toBe("unknown");
    expect(categorize("Review-Invoker")).toBe("unknown");
  });

  it("gibberish and near-misses → unknown", () => {
    expect(categorize("brainstorm")).toBe("unknown");
    expect(categorize("agent")).toBe("unknown");
    expect(categorize("code-implementer")).toBe("unknown");
    expect(categorize("impl")).toBe("unknown");
  });
});
