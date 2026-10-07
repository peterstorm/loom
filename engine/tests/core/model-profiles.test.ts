import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  LLM_PROFILES,
  QUALIFIED_LOCAL_REVIEW_PROGRAMS,
  isIssuableProfile,
  lowerModelProfile,
  issuedReviewerProfile,
  reviewerIssueRouteForParent,
  parseAgentFrontmatter,
  parseLlmProfile,
  parseLlmProfileId,
  resolveAgentPolicy,
  resolveAgentProfile,
  resolveHarnessBinding,
  resolveModelProfile,
  validateAgentPolicyCatalog,
  validateAgentPolicyFrontmatter,
  validateExplicitSpawnModel,
  type AgentPolicy,
  type LlmProfileId,
  type LoomAgentName,
} from "../../src/core/model-profiles";
import {
  IMPL_AGENTS,
  LOOM_OWNED_AGENTS,
  assertPanelJudgeProfileUnique,
  panelJudgeProfileCarriers,
} from "../../src/core/agent-catalog-projections";
import { classifyPiSpawnItems, parsePiSpawnItems } from "../../src/core/pi-spawn-input";
import { ORCHESTRATION_PROGRAMS } from "../../src/core/orchestration-contract/programs";

const EXPECTED_PROFILES = {
  implementation: {
    claudeCode: { model: "opus" },
    pi: { provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" },
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
  "qualified-local-review": {
    claudeCode: { model: "sonnet" },
    pi: { provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" },
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
  "spec-check-review": {
    claudeCode: { model: "sonnet" },
    pi: { provider: "github-copilot", model: "gpt-5.6-terra", thinking: "high" },
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

  it("keeps all default profiles on exact cloud targets and the alternative on one qualified local target", () => {
    const defaults = LLM_PROFILES.filter(({ id }) => id !== "qualified-local-review");
    // implementation rides the same local qualified route as the reviewer
    // election; every other default stays on an exact cloud target.
    const cloudDefaults = defaults.filter(({ id }) => id !== "implementation");
    expect(new Set(cloudDefaults.map(({ pi }) => pi.provider))).toEqual(new Set(["github-copilot", "openai-codex"]));
    expect(new Set(cloudDefaults.map(({ pi }) => pi.model))).toEqual(
      new Set(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-5.6-terra"]),
    );
    expect(defaults.find(({ id }) => id === "implementation")?.pi).toEqual(EXPECTED_PROFILES.implementation.pi);
    expect(LLM_PROFILES.find(({ id }) => id === "qualified-local-review")?.pi).toEqual(EXPECTED_PROFILES["qualified-local-review"].pi);
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

describe("qualified-local reviewer issuance", () => {
  const qualified = { pi: true, provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" };

  it("elects the local profile only from the exact parent session route", () => {
    expect(reviewerIssueRouteForParent(qualified)).toBe("qualified-local");
    for (const changed of [
      { pi: false }, { provider: "openai-codex" }, { model: "glm-5.3-flash-spark-tp2-v15" },
      { thinking: "medium" },
    ]) expect(reviewerIssueRouteForParent({ ...qualified, ...changed })).toBe("catalog");
  });

  it.each(QUALIFIED_LOCAL_REVIEW_PROGRAMS)("preserves the catalog for all non-reviewers and the cloud default in %s", (program) => {
    expect(issuedReviewerProfile("code-reviewer", program, "qualified-local")).toMatchObject({
      ok: true, value: { id: "qualified-local-review", pi: qualifiedRoute },
    });
    expect(issuedReviewerProfile("code-reviewer", program, "catalog")).toEqual(resolveModelProfile("general-review"));
    expect(issuedReviewerProfile("spec-check-invoker", program, "qualified-local")).toEqual(resolveModelProfile("spec-check-review"));
    expect(issuedReviewerProfile("review-verifier-agent", program, "qualified-local")).toEqual(resolveModelProfile("refutation"));
  });

  it("names exactly the Wave Gate and Standalone Review programs as electing", () => {
    expect(QUALIFIED_LOCAL_REVIEW_PROGRAMS).toEqual(["wave-gate", "standalone-review"]);
    expect(Object.isFrozen(QUALIFIED_LOCAL_REVIEW_PROGRAMS)).toBe(true);
  });
});

describe("the one profile-eligibility rule", () => {
  // `null` is a program that did not parse: it elects nothing.
  const programs = [...ORCHESTRATION_PROGRAMS, null];

  it("admits a role's catalog profile in every program, and only qualified-local-review besides", () => {
    for (const policy of AGENT_POLICIES) for (const program of programs) for (const id of LLM_PROFILE_IDS) {
      const electsLocal = id === "qualified-local-review" && policy.kind.kind === "reviewer" &&
        (program === "wave-gate" || program === "standalone-review");
      expect(isIssuableProfile(policy, program, id), `${policy.agent}/${String(program)}/${id}`)
        .toBe(id === policy.profile || electsLocal);
    }
  });

  it("issuance only ever elects a profile the rule admits", () => {
    fc.assert(fc.property(
      fc.constantFrom(...AGENT_POLICIES),
      fc.constantFrom(...QUALIFIED_LOCAL_REVIEW_PROGRAMS),
      fc.constantFrom("catalog" as const, "qualified-local" as const),
      (policy, program, route) => {
        const issued = issuedReviewerProfile(policy.agent, program, route);
        expect(issued.ok).toBe(true);
        if (!issued.ok) return;
        expect(isIssuableProfile(policy, program, issued.value.id)).toBe(true);
        // The catalog route never leaves the role's catalog profile.
        if (route === "catalog") expect(issued.value.id).toBe(policy.profile);
      },
    ));
  });

  it("issuance elects the local profile for every reviewer the rule admits it for", () => {
    for (const policy of AGENT_POLICIES) for (const program of QUALIFIED_LOCAL_REVIEW_PROGRAMS) {
      const issued = issuedReviewerProfile(policy.agent, program, "qualified-local");
      expect(issued.ok && issued.value.id === "qualified-local-review", policy.agent)
        .toBe(isIssuableProfile(policy, program, "qualified-local-review"));
    }
  });
});

const qualifiedRoute = { provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" };

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
      expect(parsePiSpawnItems(raw)).toMatchObject({ ok: false, error: { kind: "malformed-spawn-input" } });
    }
  });

  it("names a structural boundary failure apart from an unknown Agent", () => {
    expect(classifyPiSpawnItems("not an object")).toEqual({
      ok: false, error: { kind: "malformed-spawn-input", message: "Pi subagent input must be an object" },
    });
    expect(classifyPiSpawnItems({ chain: [{ agent: "code-reviewer", task: "  " }] })).toEqual({
      ok: false,
      error: { kind: "malformed-spawn-input", message: "Pi subagent item 1 must contain a non-empty agent and task" },
    });
    expect(classifyPiSpawnItems({ tasks: [{ agent: "loom:ghost", task: "x" }] })).toMatchObject({
      ok: false, error: { kind: "unknown-agent" },
    });
    expect(classifyPiSpawnItems({ tasks: [
      { agent: "code-reviewer", task: "Loom review" },
      { agent: "external-agent", task: "outside workflow" },
    ] })).toEqual({
      ok: false,
      error: { kind: "unknown-agent", message: "Pi subagent batches must not mix Loom-owned and external agents" },
    });
    expect(parsePiSpawnItems({ agent: "external-agent", task: "x" })).toMatchObject({
      ok: false, error: { kind: "unknown-agent" },
    });
  });

  it("property: a classified Loom-owned batch carries every item, in order, with its resolved Agent", () => {
    const loomAgents = AGENT_POLICIES.map(({ agent }) => agent);
    fc.assert(fc.property(
      fc.array(fc.record({
        agent: fc.constantFrom(...loomAgents).chain((agent) => fc.constantFrom(agent, `loom:${agent}`)),
        task: fc.string({ minLength: 1 }).filter((task) => task.trim() !== ""),
      }), { minLength: 1, maxLength: 6 }),
      (tasks) => {
        const classified = classifyPiSpawnItems({ tasks });
        expect(classified.ok).toBe(true);
        if (!classified.ok || classified.value.kind !== "loom-owned") throw new Error("expected a Loom-owned batch");
        expect(classified.value.items).toEqual(tasks.map(({ agent, task }) => ({
          agent: agent.startsWith("loom:") ? agent.slice("loom:".length) : agent, task,
        })));
      },
    ));
  });

  it("does not count vacuous single fields as a second mode beside a populated batch", () => {
    // Regression: a model echoes the tool schema's optional top-level
    // agent/task fields with an empty string alongside the parallel payload it
    // actually intended; counting that echo as a populated single mode refused
    // the unambiguous batch (observed live with gpt-5.6-terra dispatching a
    // one-entry tasks array). Only a POPULATED single form is a mode, so the
    // echo is ignored and the parallel batch parses.
    expect(parsePiSpawnItems({
      agent: "comment-analyzer",
      task: "",
      tasks: [{ agent: "comment-analyzer", task: "review the wave slot" }],
    })).toEqual({
      ok: true,
      value: [{ agent: "comment-analyzer", task: "review the wave slot" }],
    });
    // A vacuous single form ALONE is still no batch at all.
    expect(parsePiSpawnItems({ agent: "comment-analyzer", task: "" }).ok).toBe(false);
    expect(parsePiSpawnItems({ agent: "", task: "review" }).ok).toBe(false);
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
      value: {
        agent: "code-reviewer",
        profile: "general-review",
        kind: { kind: "reviewer" },
        requiredSkill: null,
      },
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

describe("panel-judge profile uniqueness — the judge-verdict scoping invariant", () => {
  const row = (agent: LoomAgentName, profile: LlmProfileId): AgentPolicy<LoomAgentName> =>
    Object.freeze({ agent, profile, kind: Object.freeze({ kind: "reviewer" }), requiredSkill: null });

  it("the live catalog carries the panel-judge profile exactly once", () => {
    // The consumer the scoping condition reads as data: `producerKindsOfAgent`
    // binds judge-verdict emission to the carrier list, so the list must name
    // exactly the one judge.
    expect(panelJudgeProfileCarriers()).toEqual(["arch-judge-agent"]);
  });

  it("refuses a synthetic roster where a second agent binds the panel-judge profile", () => {
    // The throwing branch driven with a synthetic two-carrier roster — the
    // failure mode the load-time assertion exists for, exercised directly so a
    // weakened predicate cannot survive the suite green.
    const twoCarriers = [row("arch-judge-agent", "panel-judge"), row("code-reviewer", "panel-judge")];
    expect(() => assertPanelJudgeProfileUnique(twoCarriers)).toThrowError(
      /panel-judge profile must bind exactly one Agent[\s\S]*arch-judge-agent, code-reviewer[\s\S]*judge-verdict/,
    );
  });

  it("accepts the synthetic single-carrier roster — the legal shape", () => {
    expect(() => assertPanelJudgeProfileUnique([row("arch-judge-agent", "panel-judge")])).not.toThrow();
  });
});
