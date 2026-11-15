import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  classifyModelRef,
  parseModelRef,
  parseModelRoutingConfig,
  resolveAgentLaunchBinding,
  resolveEffectivePiBinding,
  resolveEffectivePiBindingFromParent,
  servedProvidersFor,
  unmatchablePatternReason,
  type EffectivePiBinding,
  type ModelRef,
  type ModelRoutingConfig,
  type RoutingWorkload,
  type ServedModels,
} from "../../src/core/model-routing";
import type { PiBinding } from "../../src/core/model-profiles";

const declared: PiBinding = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high",
});

const declaredMini: PiBinding = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.4-mini",
  thinking: "medium",
});

const localConfigRaw = {
  schemaVersion: 1,
  defaultClass: "cloud",
  modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
  targets: {
    qwen: { model: "desktop-vllm/qwen3.8-27b", thinkingLevel: "xhigh" },
    glm: { model: "desktop-vllm/glm-5.3-flash-exl3-k4-vision-mtp", thinkingLevel: "max" },
  },
  rules: [{ id: "local-parent", when: { parentClass: "local" }, use: { kind: "parent" } }],
};

const localConfigParsed = parseModelRoutingConfig(localConfigRaw);
if (!localConfigParsed.ok) throw new Error(localConfigParsed.error.message);
const localConfig: ModelRoutingConfig = localConfigParsed.value;

const qwenRef: ModelRef = { provider: "desktop-vllm", model: "qwen3.8-27b" };
const codexRef: ModelRef = { provider: "openai-codex", model: "gpt-5.6-sol" };

/** The routed binding for a ref-only parent; a routing refusal fails the test. */
function routed(
  declaredBinding: PiBinding,
  parentRef: ModelRef | null,
  config: ModelRoutingConfig | null,
  served: ServedModels = {},
): EffectivePiBinding {
  const result = resolveEffectivePiBinding(declaredBinding, { config, parentRef, served });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** The routed binding for a parent with its own thinking level; a routing refusal fails the test. */
function fromParent(
  declaredBinding: PiBinding,
  parent: EffectivePiBinding,
  config: ModelRoutingConfig | null,
  workload?: RoutingWorkload,
  served: ServedModels = {},
): EffectivePiBinding {
  const result = resolveEffectivePiBindingFromParent(declaredBinding, parent, { config, served }, workload);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const parse = (raw: unknown): ModelRoutingConfig => {
  const parsed = parseModelRoutingConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

describe("parseModelRef", () => {
  it("parses a valid provider/model ref into a frozen value object", () => {
    const result = parseModelRef("desktop-vllm/qwen3.8-27b");
    expect(result).toEqual({ ok: true, value: { provider: "desktop-vllm", model: "qwen3.8-27b" } });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    ["not a string", 42],
    ["no slash", "qwen3.8-27b"],
    ["two slashes", "a/b/c"],
    ["empty provider", "/model"],
    ["empty model", "provider/"],
    ["whitespace", "provider/ model"],
    ["wildcard", "provider/*"],
  ])("rejects %s", (_label, raw) => {
    const result = parseModelRef(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-model-ref");
  });
});

describe("parseModelRoutingConfig", () => {
  it("parses a valid config", () => {
    const result = parseModelRoutingConfig(localConfigRaw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.defaultClass).toBe("cloud");
      expect(Object.keys(result.value.targets)).toEqual(["qwen", "glm"]);
      expect(result.value.targets.qwen).toEqual({
        kind: "exact",
        provider: "desktop-vllm",
        model: "qwen3.8-27b",
        thinking: "xhigh",
      });
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    expect(parseModelRoutingConfig("nope").ok).toBe(false);
    expect(parseModelRoutingConfig(null).ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = parseModelRoutingConfig({ ...localConfigRaw, schemaVersion: 2 });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or malformed modelClasses", () => {
    expect(parseModelRoutingConfig({ ...localConfigRaw, modelClasses: "x" }).ok).toBe(false);
    expect(parseModelRoutingConfig({ ...localConfigRaw, modelClasses: { local: "not-array" } }).ok).toBe(false);
    expect(parseModelRoutingConfig({ ...localConfigRaw, modelClasses: { local: ["" as unknown as string] } }).ok).toBe(false);
  });

  it("rejects a malformed rule", () => {
    expect(parseModelRoutingConfig({ ...localConfigRaw, rules: [{ id: "x", when: { parentClass: "local" }, use: { kind: "bogus" } }] }).ok).toBe(false);
    expect(parseModelRoutingConfig({ ...localConfigRaw, rules: [{ id: "x", when: { parentClass: "local" }, use: { kind: "named", target: "missing" } }] }).ok).toBe(false);
    expect(parseModelRoutingConfig({ ...localConfigRaw, rules: [{ id: "", when: { parentClass: "local" }, use: { kind: "parent" } }] }).ok).toBe(false);
    expect(parseModelRoutingConfig({ ...localConfigRaw, rules: "nope" }).ok).toBe(false);
  });

  it("rejects a rule whose parent class can never be produced", () => {
    const result = parseModelRoutingConfig({
      ...localConfigRaw,
      rules: [{ id: "typo", when: { parentClass: "locla" }, use: { kind: "parent" } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not produced by modelClasses or defaultClass");
  });

  it("accepts a rule matching the default class without a modelClasses entry", () => {
    const result = parseModelRoutingConfig({
      ...localConfigRaw,
      rules: [{ id: "cloud-default", when: { parentClass: "cloud" }, use: { kind: "declared" } }],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["a lone segment can never match a two-segment ref", "desktop-vllm"],
    ["three segments can never match a two-segment ref", "a/b/c"],
    ["an empty provider segment can never match", "/model"],
    ["an empty model segment can never match", "provider/"],
    ["a whitespace provider segment can never match a whitespace-free ref", " desktop-vllm/*"],
    ["a whitespace model segment can never match a whitespace-free ref", "desktop-vllm/ m"],
    ["a Unicode whitespace segment can never match a whitespace-free ref", "desktop-vllm/\u00a0m"],
  ])("rejects an unmatchable pattern: %s", (_label, pattern) => {
    const result = parseModelRoutingConfig({ ...localConfigRaw, modelClasses: { local: [pattern] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-routing-config");
      expect(result.error.message).toContain("can never match");
    }
  });

  it("accepts every pattern shape that can match", () => {
    for (const pattern of ["desktop-vllm/*", "desktop-vllm/qwen3.8-27b", "*/m", "*/*"]) {
      const result = parseModelRoutingConfig({ ...localConfigRaw, modelClasses: { local: [pattern] } });
      expect(result.ok, pattern).toBe(true);
    }
  });
});

describe("unmatchablePatternReason", () => {
  it("is null for matchable patterns", () => {
    for (const pattern of ["desktop-vllm/*", "a/b", "*/m", "*/*"]) {
      expect(unmatchablePatternReason(pattern), pattern).toBeNull();
    }
  });

  it("names the defect for dead patterns", () => {
    expect(unmatchablePatternReason("desktop-vllm")).toContain("two '/'-separated segments");
    expect(unmatchablePatternReason("a/b/c")).toContain("two '/'-separated segments");
    expect(unmatchablePatternReason("/m")).toContain("empty segment");
    expect(unmatchablePatternReason("a /b")).toContain("whitespace");
  });
});

describe("classifyModelRef", () => {
  it("classifies a local provider/model as local", () => {
    expect(classifyModelRef(qwenRef, localConfig)).toBe("local");
    expect(classifyModelRef({ provider: "desktop-muse", model: "anything" }, localConfig)).toBe("local");
  });

  it("classifies an unmatched ref as the default class", () => {
    expect(classifyModelRef(codexRef, localConfig)).toBe("cloud");
  });
});

describe("resolveEffectivePiBinding", () => {
  it("returns the declared binding when the parent ref is absent", () => {
    expect(routed(declared, null, localConfig)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("returns the declared binding when the config is absent", () => {
    expect(routed(declared, qwenRef, null)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("inherits the parent model when the parent is local and a parent rule matches", () => {
    expect(routed(declared, qwenRef, localConfig)).toEqual({
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "high",
    });
  });

  it("keeps the declared binding when the parent is not local", () => {
    expect(routed(declared, codexRef, localConfig)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("keeps the declared thinking level when only a parent model ref is available", () => {
    expect(routed(declaredMini, qwenRef, localConfig).thinking).toBe("medium");
  });

  it("inherits the active parent's complete binding when its thinking level is available", () => {
    expect(fromParent(declared, {
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "xhigh",
    }, localConfig)).toEqual({
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "xhigh",
    });
  });

  it("uses a named exact target including its thinking level", () => {
    const named = parseModelRoutingConfig({
      ...localConfigRaw,
      rules: [{ id: "local-glm", when: { parentClass: "local" }, use: { kind: "named", target: "glm" } }],
    });
    if (!named.ok) throw new Error(named.error.message);
    expect(fromParent(declared, {
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "xhigh",
    }, named.value)).toEqual({
      provider: "desktop-vllm",
      model: "glm-5.3-flash-exl3-k4-vision-mtp",
      thinking: "max",
    });
  });

  it("lets a more-specific workload/profile rule select a named target", () => {
    const specific = parseModelRoutingConfig({
      ...localConfigRaw,
      rules: [
        { id: "local-parent", when: { parentClass: "local" }, use: { kind: "parent" } },
        {
          id: "local-review-glm",
          when: { parentClass: "local", workload: "subagent", profile: "general-review" },
          use: { kind: "named", target: "glm" },
        },
      ],
    });
    if (!specific.ok) throw new Error(specific.error.message);
    expect(fromParent(declared, {
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "xhigh",
    }, specific.value, {
      workload: "subagent",
      profile: "general-review",
      agent: "code-reviewer",
    }).model).toBe("glm-5.3-flash-exl3-k4-vision-mtp");
  });

  it("rejects equal-specificity rules that can match the same workload", () => {
    const ambiguous = parseModelRoutingConfig({
      ...localConfigRaw,
      rules: [
        {
          id: "by-profile",
          when: { parentClass: "local", profile: "general-review" },
          use: { kind: "parent" },
        },
        {
          id: "by-agent",
          when: { parentClass: "local", agent: "code-reviewer" },
          use: { kind: "named", target: "glm" },
        },
      ],
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.message).toContain("equal-specificity routing rules");
  });

  it("keeps the declared binding when a matching rule says 'declared'", () => {
    const config: ModelRoutingConfig = Object.freeze({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: Object.freeze({ local: Object.freeze(["desktop-vllm/*"]) }),
      targets: Object.freeze({}),
      rules: Object.freeze([Object.freeze({ id: "r", when: Object.freeze({ parentClass: "local" }), use: Object.freeze({ kind: "declared" }) })]),
    });
    expect(routed(declared, qwenRef, config).model).toBe("gpt-5.6-sol");
  });

  it("keeps the declared binding when no rule matches the parent class", () => {
    const config: ModelRoutingConfig = Object.freeze({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: Object.freeze({ local: Object.freeze(["desktop-vllm/*"]) }),
      targets: Object.freeze({}),
      rules: Object.freeze([Object.freeze({ id: "r", when: Object.freeze({ parentClass: "other" }), use: Object.freeze({ kind: "parent" }) })]),
    });
    expect(routed(declared, qwenRef, config).model).toBe("gpt-5.6-sol");
  });
});

describe("model-routing property tests", () => {
  const modelRefArb: fc.Arbitrary<ModelRef> = fc
    .tuple(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)), fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)))
    .map(([provider, model]) => Object.freeze({ provider, model }));

  it("resolveEffectivePiBinding is total and always preserves the declared thinking level", () => {
    fc.assert(
      fc.property(modelRefArb, fc.constantFrom(null, localConfig), fc.constantFrom(declared, declaredMini), (parentRef, config, declaredBinding) => {
        const result: EffectivePiBinding = routed(declaredBinding, parentRef, config);
        expect(result.thinking).toBe(declaredBinding.thinking);
        expect(typeof result.provider).toBe("string");
        expect(typeof result.model).toBe("string");
      }),
      { numRuns: 200 },
    );
  });

  it("resolves to the declared binding whenever the parent is not local or the config/parent is absent", () => {
    fc.assert(
      fc.property(modelRefArb, fc.constantFrom(declared, declaredMini), (parentRef, declaredBinding) => {
        const parentClass = classifyModelRef(parentRef, localConfig);
        if (parentClass === "local") return; // the inherit case is covered separately
        const result = routed(declaredBinding, parentRef, localConfig);
        expect(result.provider).toBe(declaredBinding.provider);
        expect(result.model).toBe(declaredBinding.model);
      }),
      { numRuns: 200 },
    );
  });

  it("inherits exactly the parent provider/model for a local parent under the local-parent rule", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)), fc.constantFrom(declared, declaredMini), (model, declaredBinding) => {
        const parentRef: ModelRef = Object.freeze({ provider: "desktop-vllm", model });
        const result = routed(declaredBinding, parentRef, localConfig);
        expect(result.provider).toBe("desktop-vllm");
        expect(result.model).toBe(model);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Served targets: `{ "served": "<provider>" }` stands for whatever single
 * model the provider serves now. The shell probes it; the policy only reads
 * the probe's answer, and refuses rather than fall back when it is unknown.
 * The config mirrors the operator's live policy shape.
 */
describe("served routing targets", () => {
  const servedConfigRaw = {
    schemaVersion: 1,
    defaultClass: "cloud",
    modelClasses: { local: ["desktop-vllm/*", "llama.cpp/*"] },
    targets: {
      served: { served: "desktop-vllm" },
      "served-max": { served: "desktop-vllm", thinkingLevel: "max" },
    },
    rules: [
      { id: "local-desktop-children-use-served", when: { parentClass: "local", parentModel: "desktop-vllm/*" }, use: { kind: "named", target: "served" } },
      { id: "other-local-children-inherit-parent", when: { parentClass: "local" }, use: { kind: "parent" } },
      { id: "cloud-workers-use-parent", when: { parentClass: "cloud", workload: "subagent", agent: "worker" }, use: { kind: "parent" } },
      { id: "cloud-children-use-served", when: { parentClass: "cloud" }, use: { kind: "named", target: "served-max" } },
    ],
  };
  const servedConfig = parse(servedConfigRaw);
  const warmind: ServedModels = { "desktop-vllm": { kind: "served", ref: { provider: "desktop-vllm", model: "warmind-1017" } } };
  const llamaParent: ModelRef = { provider: "llama.cpp", model: "gemma" };

  describe("parsing", () => {
    it("parses a served target, with or without a pinned thinking level", () => {
      expect(servedConfig.targets.served).toEqual({ kind: "served", provider: "desktop-vllm", thinking: null });
      expect(servedConfig.targets["served-max"]).toEqual({ kind: "served", provider: "desktop-vllm", thinking: "max" });
    });

    it.each([
      ["both model and served", { model: "desktop-vllm/x", served: "desktop-vllm", thinkingLevel: "high" }, "exactly one of model"],
      ["neither model nor served", { thinkingLevel: "high" }, "exactly one of model"],
      ["a served value that is not a provider name", { served: "desktop-vllm/x" }, "served must be a provider name"],
      ["an empty served provider", { served: "" }, "served must be a provider name"],
      ["a non-string served provider", { served: 7 }, "served must be a provider name"],
      ["an invalid thinking level", { served: "desktop-vllm", thinkingLevel: "huge" }, "thinkingLevel must be an exact thinking level"],
      ["an unknown field", { served: "desktop-vllm", fallback: "x" }, "unknown field fallback"],
      ["an exact model without a thinking level", { model: "desktop-vllm/x" }, "must have an exact thinkingLevel"],
      ["a target that is not an object", "desktop-vllm", "must be an object"],
    ])("rejects a target with %s", (_label, target, message) => {
      const result = parseModelRoutingConfig({ ...servedConfigRaw, targets: { ...servedConfigRaw.targets, broken: target } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-routing-config");
        expect(result.error.message).toContain(message);
      }
    });
  });

  describe("which providers a parent needs probed", () => {
    it("names the served providers of every rule that can match the parent", () => {
      expect(servedProvidersFor(servedConfig, codexRef)).toEqual(["desktop-vllm"]);
      expect(servedProvidersFor(servedConfig, qwenRef)).toEqual(["desktop-vllm"]);
    });

    it("names none when no reachable rule selects a served target, or there is no parent or config", () => {
      expect(servedProvidersFor(servedConfig, llamaParent)).toEqual([]);
      expect(servedProvidersFor(servedConfig, null)).toEqual([]);
      expect(servedProvidersFor(null, codexRef)).toEqual([]);
      expect(servedProvidersFor(localConfig, qwenRef)).toEqual([]);
    });
  });

  describe("resolution", () => {
    it("resolves a served target to the probed model at its pinned thinking level", () => {
      expect(routed(declared, codexRef, servedConfig, warmind)).toEqual({ provider: "desktop-vllm", model: "warmind-1017", thinking: "max" });
    });

    it("carries the parent's thinking level over when the served target pins none", () => {
      expect(fromParent(declared, { ...qwenRef, thinking: "low" }, servedConfig, {}, warmind))
        .toEqual({ provider: "desktop-vllm", model: "warmind-1017", thinking: "low" });
      // A ref-only parent's thinking is the declared one.
      expect(routed(declaredMini, qwenRef, servedConfig, warmind).thinking).toBe("medium");
    });

    it("lets a more specific rule keep the parent instead of the served target", () => {
      const parent: EffectivePiBinding = { ...codexRef, thinking: "high" };
      expect(fromParent(declared, parent, servedConfig, { workload: "subagent", agent: "worker" }, warmind)).toEqual(parent);
    });

    it("needs no probe for a parent whose deciding rule names no served target", () => {
      expect(routed(declared, llamaParent, servedConfig, {})).toEqual({ ...llamaParent, thinking: "high" });
    });

    it("refuses, naming the rule, target and reason, when the served model is unknown", () => {
      const result = resolveEffectivePiBinding(declared, {
        config: servedConfig,
        parentRef: codexRef,
        served: { "desktop-vllm": { kind: "unknown", reason: "http://h/v1/models lists 2 models (a, b)" } },
      });
      expect(result).toEqual({
        ok: false,
        error: {
          kind: "served-model-unknown",
          message: "routing rule cloud-children-use-served selects target \"served-max\", served by provider 'desktop-vllm', " +
            "whose model is unknown: http://h/v1/models lists 2 models (a, b)",
        },
      });
    });

    it("refuses a provider the context never probed, and a probe keyed to the wrong provider", () => {
      const unprobed = resolveEffectivePiBinding(declared, { config: servedConfig, parentRef: codexRef, served: {} });
      expect(unprobed.ok).toBe(false);
      if (!unprobed.ok) expect(unprobed.error.message).toContain("the routing context did not probe it");
      const misKeyed = resolveEffectivePiBinding(declared, {
        config: servedConfig,
        parentRef: codexRef,
        served: { "desktop-vllm": { kind: "served", ref: { provider: "other", model: "m" } } },
      });
      expect(misKeyed.ok).toBe(false);
      if (!misKeyed.ok) expect(misKeyed.error.message).toContain("a model of another provider");
    });

    it("carries the refusal through an Agent's launch binding", () => {
      const launch = resolveAgentLaunchBinding("code-reviewer", {
        config: servedConfig,
        parentRef: codexRef,
        served: { "desktop-vllm": { kind: "unknown", reason: "down" } },
      });
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.kind).toBe("served-model-unknown");
    });

    it("always launches a served route on exactly the probed model, or refuses — never another binding", () => {
      const segment = fc.stringMatching(/^[a-z0-9.-]{1,10}$/);
      const observation = fc.oneof(
        segment.map((model) => ({ kind: "served" as const, ref: { provider: "desktop-vllm", model } })),
        fc.string().map((reason) => ({ kind: "unknown" as const, reason })),
      );
      fc.assert(fc.property(observation, fc.constantFrom(codexRef, qwenRef), (observed, parentRef) => {
        const result = resolveEffectivePiBinding(declared, { config: servedConfig, parentRef, served: { "desktop-vllm": observed } });
        if (observed.kind === "unknown") {
          expect(result.ok).toBe(false);
          return;
        }
        expect(result.ok && result.value.provider === "desktop-vllm" && result.value.model === observed.ref.model).toBe(true);
      }));
    });
  });
});
