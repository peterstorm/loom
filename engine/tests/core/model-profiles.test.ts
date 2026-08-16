import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  LLM_PROFILES,
  LOOM_OWNED_AGENTS,
  classifyPiSpawnItems,
  lowerModelProfile,
  parseAgentFrontmatter,
  parseLlmProfile,
  parseLlmProfileId,
  parsePiSpawnItems,
  resolveAgentPolicy,
  resolveAgentProfile,
  resolveHarnessBinding,
  resolveModelProfile,
  validateAgentPolicyCatalog,
  validateAgentPolicyFrontmatter,
  validateExplicitSpawnModel,
  type LlmProfileId,
} from "../../src/core/model-profiles";
import { IMPL_AGENTS } from "../../src/config";

const EXPECTED_PROFILES = {
  implementation: {
    claudeCode: { model: "opus" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  "architecture-finalize": {
    claudeCode: { model: "opus" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  "general-review": {
    claudeCode: { model: "sonnet" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  "focused-review": {
    claudeCode: { model: "sonnet" },
    pi: { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
  },
  "panel-design": {
    claudeCode: { model: "opus" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  "panel-judge": {
    claudeCode: { model: "opus" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  refutation: {
    claudeCode: { model: "opus" },
    pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  },
  mechanical: {
    claudeCode: { model: "haiku" },
    pi: { provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" },
  },
} as const satisfies Record<LlmProfileId, unknown>;

function errorsOf(result: { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }): readonly string[] {
  return result.ok ? [] : result.errors;
}

describe("semantic model profiles", () => {
  it("has one exact Claude and Pi target per semantic profile", () => {
    expect(LLM_PROFILES).toHaveLength(LLM_PROFILE_IDS.length);
    expect(Object.fromEntries(LLM_PROFILES.map(({ id, ...bindings }) => [id, bindings])))
      .toEqual(EXPECTED_PROFILES);
  });

  it("uses only currently available, explicitly named openai-codex targets", () => {
    expect(new Set(LLM_PROFILES.map(({ pi }) => pi.provider))).toEqual(new Set(["openai-codex"]));
    expect(new Set(LLM_PROFILES.map(({ pi }) => pi.model))).toEqual(
      new Set(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini"]),
    );
    expect(LLM_PROFILES.every(({ pi }) => pi.model.length > 0 && pi.thinking.length > 0)).toBe(true);
  });

  it("keeps all architecture/discovery panel work on the strongest available harness models", () => {
    for (const id of ["panel-design", "panel-judge"] as const) {
      expect(LLM_PROFILES.find((profile) => profile.id === id)).toMatchObject({
        claudeCode: { model: "opus" },
        pi: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      });
    }
  });

  it("deep-freezes the exported policy data", () => {
    expect(Object.isFrozen(LLM_PROFILES)).toBe(true);
    expect(Object.isFrozen(LLM_PROFILES[0])).toBe(true);
    expect(Object.isFrozen(LLM_PROFILES[0]!.claudeCode)).toBe(true);
    expect(Object.isFrozen(LLM_PROFILES[0]!.pi)).toBe(true);
    expect(Object.isFrozen(AGENT_POLICIES)).toBe(true);
    expect(AGENT_POLICIES.every(Object.isFrozen)).toBe(true);
  });

  it("parses only exact known ids and exact complete profile objects", () => {
    expect(parseLlmProfileId("implementation")).toEqual({ ok: true, value: "implementation" });
    expect(parseLlmProfileId(" implementation ").ok).toBe(false);
    expect(parseLlmProfileId("current").ok).toBe(false);

    const implementation = LLM_PROFILES.find(({ id }) => id === "implementation")!;
    expect(parseLlmProfile(implementation)).toEqual({ ok: true, value: implementation });
    expect(parseLlmProfile({
      ...implementation,
      pi: { ...implementation.pi, model: "parent-session-model" },
    }).ok).toBe(false);
  });

  it("is total for arbitrary unknown parser inputs", () => {
    fc.assert(fc.property(fc.anything(), (raw) => {
      expect(() => parseLlmProfileId(raw)).not.toThrow();
      expect(() => parseLlmProfile(raw)).not.toThrow();
      expect(() => parseAgentFrontmatter(raw)).not.toThrow();
    }));
  });
});

describe("Pi spawn input parsing", () => {
  it("parses each single, parallel, and chain mode in order", () => {
    expect(parsePiSpawnItems({ agent: "code-reviewer", task: "review" })).toEqual({
      ok: true,
      value: [{ agent: "code-reviewer", task: "review" }],
    });
    expect(parsePiSpawnItems({ tasks: [
      { agent: "code-reviewer", task: "first" },
      { agent: "comment-analyzer", task: "second" },
    ] })).toEqual({
      ok: true,
      value: [
        { agent: "code-reviewer", task: "first" },
        { agent: "comment-analyzer", task: "second" },
      ],
    });
    expect(parsePiSpawnItems({ chain: [
      { agent: "code-reviewer", task: "first" },
      { agent: "type-design-analyzer", task: "use {previous}" },
    ] })).toEqual({
      ok: true,
      value: [
        { agent: "code-reviewer", task: "first" },
        { agent: "type-design-analyzer", task: "use {previous}" },
      ],
    });
  });

  it("rejects empty, mixed, and partially malformed batches as a whole", () => {
    for (const raw of [
      {},
      { tasks: [] },
      { agent: "code-reviewer", task: "single", tasks: [{ agent: "comment-analyzer", task: "parallel" }] },
      { tasks: [
        { agent: "code-reviewer", task: "valid first" },
        { agent: "comment-analyzer", task: "" },
      ] },
    ]) {
      expect(parsePiSpawnItems(raw).ok).toBe(false);
    }
  });

  it("classifies external batches without weakening all-or-nothing Loom ownership", () => {
    expect(classifyPiSpawnItems({ agent: "external-agent", task: "outside workflow" })).toEqual({
      ok: true,
      value: { kind: "external", items: [{ agent: "external-agent", task: "outside workflow" }] },
    });
    expect(classifyPiSpawnItems({ tasks: [
      { agent: "code-reviewer", task: "Loom review" },
      { agent: "external-agent", task: "outside workflow" },
    ] }).ok).toBe(false);
  });

  it.each([
    { agent: "loom:not-a-real-agent", task: "single" },
    { tasks: [{ agent: "loom:not-a-real-agent", task: "parallel" }] },
    { chain: [{ agent: "loom:not-a-real-agent", task: "chain" }] },
  ])("fails closed when an unknown Pi agent claims Loom's namespace", (input) => {
    const result = classifyPiSpawnItems(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("loom:not-a-real-agent");
  });
});

describe("exhaustive Loom agent policy", () => {
  it("covers every agents/*.md definition except README and no invented agent", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const discovered = readdirSync(join(testDir, "../../../agents"))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => name.slice(0, -".md".length))
      .sort();

    expect([...LOOM_OWNED_AGENTS].sort()).toEqual(discovered);
    expect(validateAgentPolicyCatalog(discovered)).toEqual({ ok: true });
  });

  it("assigns implementation, review, panel, refutation, and mechanical roles explicitly", () => {
    const policies = Object.fromEntries(AGENT_POLICIES.map(({ agent, profile }) => [agent, profile]));
    expect(policies).toMatchObject({
      "code-implementer-agent": "implementation",
      "frontend-agent": "implementation",
      "code-reviewer": "general-review",
      "security-agent": "focused-review",
      "arch-designer-agent": "panel-design",
      "arch-judge-agent": "panel-judge",
      "review-verifier-agent": "refutation",
      "decompose-agent": "focused-review",
      "comment-analyzer": "focused-review",
    });
  });

  it("keeps implementation profile and task-graph execution authority mutually resolvable", () => {
    const implementationAgents = AGENT_POLICIES
      .filter(({ profile }) => profile === "implementation")
      .map(({ agent }) => agent);
    expect(implementationAgents.filter((agent) => !IMPL_AGENTS.has(agent))).toEqual([]);
    expect([...IMPL_AGENTS].filter((agent) => !resolveAgentPolicy(agent).ok)).toEqual([]);
  });

  it("resolves bare and loom-namespaced agents deterministically", () => {
    expect(resolveAgentPolicy("code-reviewer")).toEqual({
      ok: true,
      value: { agent: "code-reviewer", profile: "general-review" },
    });
    expect(resolveAgentPolicy("loom:code-reviewer")).toEqual(resolveAgentPolicy("code-reviewer"));
    expect(resolveAgentProfile("code-reviewer")).toEqual(resolveModelProfile("general-review"));
  });

  it("fails closed for absent agents and profiles instead of inheriting a current model", () => {
    expect(resolveAgentPolicy("external-agent")).toMatchObject({
      ok: false,
      error: { kind: "unknown-agent" },
    });
    expect(resolveModelProfile(undefined)).toMatchObject({
      ok: false,
      error: { kind: "invalid-profile" },
    });
    expect(resolveHarnessBinding("external-agent", "pi")).toMatchObject({
      ok: false,
      error: { kind: "unknown-agent" },
    });
  });
});

describe("typed harness lowering", () => {
  it.each([
    ["claude-code", "sonnet", "opus"],
    ["pi", "openai-codex/gpt-5.6-sol:high", "openai-codex/gpt-5.5:high"],
  ] as const)("requires the exact explicit %s model", (harness, expected, wrong) => {
    expect(validateExplicitSpawnModel("code-reviewer", harness, expected)).toEqual({ ok: true });
    const mismatch = validateExplicitSpawnModel("code-reviewer", harness, wrong);
    expect(mismatch.ok).toBe(false);
    expect(!mismatch.ok && mismatch.errors.join("\n")).toContain("model mismatch");
  });

  it("lowers Claude Code to exactly its model field", () => {
    const selected = resolveModelProfile("implementation");
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(lowerModelProfile(selected.value, "claude-code")).toEqual({
      harness: "claude-code",
      model: "opus",
    });
  });

  it("lowers Pi to exact provider/model/thinking fields", () => {
    expect(resolveHarnessBinding("review-verifier-agent", "pi")).toEqual({
      ok: true,
      value: {
        harness: "pi",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinking: "high",
      },
    });
    expect(resolveHarnessBinding("comment-analyzer", "pi")).toEqual({
      ok: true,
      value: {
        harness: "pi",
        provider: "openai-codex",
        model: "gpt-5.5",
        thinking: "high",
      },
    });
  });

  it("rejects an unknown harness rather than returning a partial binding", () => {
    expect(resolveHarnessBinding("code-reviewer", "current")).toMatchObject({
      ok: false,
      error: { kind: "invalid-harness" },
    });
  });
});

describe("catalog and frontmatter validators", () => {
  it("reports missing agents and profiles, including dangling policy references", () => {
    const withoutReviewer = AGENT_POLICIES.filter(({ agent }) => agent !== "code-reviewer");
    const missingAgent = validateAgentPolicyCatalog(LOOM_OWNED_AGENTS, withoutReviewer);
    expect(errorsOf(missingAgent)).toContain("missing agent policy: code-reviewer");

    const withoutRefutation = LLM_PROFILES.filter(({ id }) => id !== "refutation");
    const missingProfile = validateAgentPolicyCatalog(
      LOOM_OWNED_AGENTS,
      AGENT_POLICIES,
      withoutRefutation,
    );
    expect(errorsOf(missingProfile)).toContain("missing model profile: refutation");
    expect(errorsOf(missingProfile)).toContain(
      "agent policy 'review-verifier-agent' references missing model profile: refutation",
    );
  });

  it("accepts frontmatter only when policy profile and Claude model both match", () => {
    expect(validateAgentPolicyFrontmatter({
      name: "code-reviewer",
      "model-profile": "general-review",
      model: "sonnet",
    })).toEqual({ ok: true });
  });

  it("reports policy/profile and profile/model frontmatter drift", () => {
    const wrongProfile = validateAgentPolicyFrontmatter({
      name: "code-reviewer",
      "model-profile": "focused-review",
      model: "sonnet",
    });
    expect(errorsOf(wrongProfile).some((error) => error.includes("model-profile mismatch"))).toBe(true);

    // A frontmatter whose model contradicts its OWN model-profile no longer
    // reaches the policy comparison: parseAgentFrontmatter refuses it, so no
    // self-contradictory AgentFrontmatter value exists to be compared.
    const selfContradictory = validateAgentPolicyFrontmatter({
      name: "code-reviewer",
      "model-profile": "general-review",
      model: "opus",
    });
    expect(errorsOf(selfContradictory).some((error) => error.includes("self-contradictory"))).toBe(true);

    // Policy-side Claude-model drift is still reported: `implementation` binds
    // opus, `general-review` binds sonnet, so a coherent implementation
    // frontmatter on a sonnet-policy agent trips BOTH catalog links.
    const wrongModel = validateAgentPolicyFrontmatter({
      name: "code-reviewer",
      "model-profile": "implementation",
      model: "opus",
    });
    expect(errorsOf(wrongModel).some((error) => error.includes("Claude model mismatch"))).toBe(true);
  });

  it("refuses frontmatter whose model contradicts its own model-profile", () => {
    const parsed = parseAgentFrontmatter({
      name: "code-reviewer",
      "model-profile": "general-review",
      model: "opus",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error.message).toContain("self-contradictory");

    // The coherent pairing still parses.
    expect(parseAgentFrontmatter({
      name: "code-reviewer",
      "model-profile": "general-review",
      model: "sonnet",
    })).toEqual({
      ok: true,
      value: { name: "code-reviewer", modelProfile: "general-review", model: "sonnet" },
    });
  });

  it("fails closed on missing declarations and unknown frontmatter agents", () => {
    expect(validateAgentPolicyFrontmatter({ name: "code-reviewer", model: "sonnet" }).ok).toBe(false);
    expect(validateAgentPolicyFrontmatter({
      name: "outside-agent",
      "model-profile": "general-review",
      model: "sonnet",
    }).ok).toBe(false);
  });
});
