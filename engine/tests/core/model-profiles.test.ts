import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  CURRENT_PI_CATALOG,
  LLM_PROFILE_IDS,
  LLM_PROFILES,
  RECORDED_LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  lowerModelProfile,
  currentProfileBindings,
  recordedProfileBindings,
  parseAgentFrontmatter,
  parseLlmProfile,
  parseLlmProfileId,
  parseRecordedLlmProfileId,
  piCatalogAsOf,
  piHistoryViolations,
  piModelPattern,
  profileBindingsUnder,
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
import { RECORDED_PI_VOCABULARY } from "../fixtures/local-pi-binding";

const LOCAL = { provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" } as const;

const EXPECTED_PROFILES = {
  implementation: { claudeCode: { model: "opus" }, pi: LOCAL },
  "architecture-finalize": { claudeCode: { model: "opus" }, pi: LOCAL },
  "general-review": { claudeCode: { model: "sonnet" }, pi: LOCAL },
  "focused-review": { claudeCode: { model: "sonnet" }, pi: LOCAL },
  "panel-design": { claudeCode: { model: "opus" }, pi: LOCAL },
  "panel-judge": { claudeCode: { model: "opus" }, pi: LOCAL },
  refutation: { claudeCode: { model: "opus" }, pi: LOCAL },
  mechanical: { claudeCode: { model: "haiku" }, pi: LOCAL },
  "spec-check-review": { claudeCode: { model: "sonnet" }, pi: LOCAL },
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

  it("runs every Pi profile on the one local route; profiles differ only in their Claude model", () => {
    expect(new Set(LLM_PROFILES.map(({ pi }) => piModelPattern(pi)))).toEqual(new Set([piModelPattern(LOCAL)]));
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

describe("recorded profile bindings", () => {
  it("records each current profile's catalog lowering first, with its unchanged Claude model", () => {
    for (const profile of LLM_PROFILES) {
      const recorded = recordedProfileBindings(profile.id);
      const current = currentProfileBindings(profile.id);
      expect(current).toEqual({ claude: lowerModelProfile(profile, "claude-code"), pi: lowerModelProfile(profile, "pi") });
      expect(recorded.pi[0]).toEqual(current.pi);
      expect(recorded.claude).toEqual(current.claude);
    }
  });

  it("keeps every recorded binding byte-for-byte, current lowering included", () => {
    const rows = Object.fromEntries(RECORDED_LLM_PROFILE_IDS.map((id) => {
      const recorded = recordedProfileBindings(id);
      return [id, [recorded.claude.model, ...recorded.pi.map((binding) => JSON.stringify(binding))]];
    }));
    const local = JSON.stringify({ harness: "pi", provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high" });
    const sol = JSON.stringify({ harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" });
    expect(rows).toEqual({
      implementation: ["opus", local, sol],
      "architecture-finalize": ["opus", local, sol],
      "general-review": ["sonnet", local, sol],
      "focused-review": ["sonnet", local, JSON.stringify({ harness: "pi", provider: "openai-codex", model: "gpt-5.5", thinking: "high" })],
      "qualified-local-review": ["sonnet", local],
      "panel-design": ["opus", local, sol],
      "panel-judge": ["opus", local, sol],
      refutation: ["opus", local, sol],
      mechanical: ["haiku", local, JSON.stringify({ harness: "pi", provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" })],
      "spec-check-review": ["sonnet", local, JSON.stringify({ harness: "pi", provider: "github-copilot", model: "gpt-5.6-terra", thinking: "high" })],
    });
  });

  it("returns immutable recorded and current bindings", () => {
    for (const id of RECORDED_LLM_PROFILE_IDS) {
      const recorded = recordedProfileBindings(id);
      expect(Object.isFrozen(recorded) && Object.isFrozen(recorded.pi) && Object.isFrozen(recorded.claude)).toBe(true);
      expect(recorded.pi.every(Object.isFrozen)).toBe(true);
    }
    for (const id of LLM_PROFILE_IDS) {
      const current = currentProfileBindings(id);
      expect(Object.isFrozen(current) && Object.isFrozen(current.pi) && Object.isFrozen(current.claude)).toBe(true);
    }
  });

  it("keeps the cloud targets each profile issued before 2026-10-08, and nothing it never issued", () => {
    const history = Object.fromEntries(RECORDED_LLM_PROFILE_IDS.map((id) =>
      [id, recordedProfileBindings(id).pi.slice(1).map(piModelPattern)]));
    expect(history).toEqual({
      implementation: ["openai-codex/gpt-5.6-sol:high"],
      "architecture-finalize": ["openai-codex/gpt-5.6-sol:high"],
      "general-review": ["openai-codex/gpt-5.6-sol:high"],
      "focused-review": ["openai-codex/gpt-5.5:high"],
      "qualified-local-review": [],
      "panel-design": ["openai-codex/gpt-5.6-sol:high"],
      "panel-judge": ["openai-codex/gpt-5.6-sol:high"],
      refutation: ["openai-codex/gpt-5.6-sol:high"],
      mechanical: ["openai-codex/gpt-5.4-mini:medium"],
      "spec-check-review": ["github-copilot/gpt-5.6-terra:high"],
    });
  });

  it("records exactly the catalog ids, then the retired ones, as a frozen roster", () => {
    expect(RECORDED_LLM_PROFILE_IDS).toEqual([...LLM_PROFILE_IDS, ...RETIRED_LLM_PROFILE_IDS]);
    expect(Object.isFrozen(RECORDED_LLM_PROFILE_IDS)).toBe(true);
  });

  it("parses a retired profile id only as a recorded one", () => {
    expect(parseRecordedLlmProfileId("qualified-local-review")).toEqual({ ok: true, value: "qualified-local-review" });
    expect(parseRecordedLlmProfileId("general-review")).toEqual({ ok: true, value: "general-review" });
    expect(parseLlmProfileId("qualified-local-review").ok).toBe(false);
    expect(resolveModelProfile("qualified-local-review").ok).toBe(false);
    expect(parseRecordedLlmProfileId("current").ok).toBe(false);
  });

  it("parses exactly the catalog and retired ids as recorded, naming both in one refusal", () => {
    fc.assert(fc.property(fc.oneof(fc.constantFrom(...RECORDED_LLM_PROFILE_IDS), fc.string(), fc.anything()), (raw) => {
      const recorded = (RECORDED_LLM_PROFILE_IDS as readonly unknown[]).includes(raw);
      const parsed = parseRecordedLlmProfileId(raw);
      expect(parsed.ok).toBe(recorded);
      if (!parsed.ok) {
        for (const id of RECORDED_LLM_PROFILE_IDS) expect(parsed.error.message).toContain(id);
      }
    }));
  });

  it("holds the history invariant on every recorded row: no repeat, never the current target", () => {
    for (const id of LLM_PROFILE_IDS) {
      const [current, ...history] = recordedProfileBindings(id).pi;
      expect(piHistoryViolations(id, current!, history), id).toEqual([]);
    }
    for (const id of RETIRED_LLM_PROFILE_IDS) {
      expect(piHistoryViolations(id, null, recordedProfileBindings(id).pi), id).toEqual([]);
    }
  });

  it("names a history entry equal to the profile's current target, and every repeated entry", () => {
    const local = currentProfileBindings("refutation").pi;
    const sol = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" } as const;
    const mini = { provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" } as const;
    expect(piHistoryViolations("refutation", local, [sol, local, mini, sol, sol])).toEqual([
      { kind: "current-target-in-history", profileId: "refutation", target: piModelPattern(local) },
      { kind: "duplicate-history-target", profileId: "refutation", target: piModelPattern(sol) },
      { kind: "duplicate-history-target", profileId: "refutation", target: piModelPattern(sol) },
    ]);
    expect(piHistoryViolations("qualified-local-review", null, [local, local])).toEqual([
      { kind: "duplicate-history-target", profileId: "qualified-local-review", target: piModelPattern(local) },
    ]);
  });

  it("property: a history of distinct non-current targets has no violation, and appending any of its entries adds exactly one", () => {
    const targets = [
      { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
      { provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" },
      { provider: "github-copilot", model: "gpt-5.6-terra", thinking: "high" },
    ] as const;
    const current = currentProfileBindings("general-review").pi;
    fc.assert(fc.property(fc.shuffledSubarray([...targets], { minLength: 1 }), fc.nat(), (history, pick) => {
      expect(piHistoryViolations("general-review", current, history)).toEqual([]);
      const repeated = history[pick % history.length]!;
      expect(piHistoryViolations("general-review", current, [...history, repeated]))
        .toEqual([{ kind: "duplicate-history-target", profileId: "general-review", target: piModelPattern(repeated) }]);
    }));
  });
});

describe("the Pi lowering table: today's catalog and a replayed one", () => {
  it("lowers every catalog profile through today's table, so the catalog, lowering and issuance agree", () => {
    for (const profile of LLM_PROFILES) {
      expect(CURRENT_PI_CATALOG.lowering[profile.id]).toEqual(profile.pi);
      expect(profileBindingsUnder(CURRENT_PI_CATALOG.lowering, profile.id)).toEqual(currentProfileBindings(profile.id));
      expect(currentProfileBindings(profile.id).pi).toEqual(lowerModelProfile(profile, "pi"));
    }
    expect(Object.isFrozen(CURRENT_PI_CATALOG) && Object.isFrozen(CURRENT_PI_CATALOG.lowering)).toBe(true);
  });

  it("replays nothing when a replay names no profile: the replayed table is today's", () => {
    const replayed = piCatalogAsOf({});
    expect(replayed).toEqual({ ok: true, value: { kind: "recorded-as-of", lowering: CURRENT_PI_CATALOG.lowering } });
  });

  it("property: accepts exactly the targets the named profile issued, lowering it there and every other profile as today", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...RECORDED_PI_VOCABULARY), (named, target) => {
      const issued = recordedProfileBindings(named).pi.some((binding) => piModelPattern(binding) === piModelPattern(target));
      const replayed = piCatalogAsOf({ [named]: target });
      expect(replayed.ok).toBe(issued);
      if (!replayed.ok) {
        expect(replayed.error).toEqual({
          kind: "unrecorded-pi-binding",
          message: `profile '${named}' never recorded the Pi binding ${piModelPattern(target)}`,
        });
        return;
      }
      for (const id of LLM_PROFILE_IDS) {
        const bindings = profileBindingsUnder(replayed.value.lowering, id);
        expect(bindings.claude).toEqual(currentProfileBindings(id).claude);
        expect(bindings.pi).toEqual(id === named ? target : currentProfileBindings(id).pi);
      }
    }));
  });

  it("names every unrecorded binding of one replay in one refusal", () => {
    const sol = recordedProfileBindings("refutation").pi[1]!;
    const mini = recordedProfileBindings("mechanical").pi[1]!;
    expect(piCatalogAsOf({ refutation: mini, mechanical: sol, implementation: sol })).toEqual({
      ok: false,
      error: {
        kind: "unrecorded-pi-binding",
        message: `profile 'refutation' never recorded the Pi binding ${piModelPattern(mini)}; ` +
          `profile 'mechanical' never recorded the Pi binding ${piModelPattern(sol)}`,
      },
    });
  });

  it("stores the recorded target itself, whatever extra fields the named binding carries", () => {
    const sol = recordedProfileBindings("refutation").pi[1]!;
    const replayed = piCatalogAsOf({ refutation: sol });
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value.lowering.refutation).toEqual({ provider: sol.provider, model: sol.model, thinking: sol.thinking });
    expect(Object.isFrozen(replayed.value) && Object.isFrozen(replayed.value.lowering)).toBe(true);
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
    ["pi", "desktop-vllm/glm-5.3-flash-spark-tp2-v14:high", "openai-codex/gpt-5.6-sol:high"],
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
    for (const agent of ["review-verifier-agent", "comment-analyzer", "spec-check-invoker"]) {
      expect(resolveHarnessBinding(agent, "pi")).toEqual({ ok: true, value: { harness: "pi", ...LOCAL } });
    }
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
