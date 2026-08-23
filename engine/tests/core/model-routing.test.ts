import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  classifyModelRef,
  parseModelRef,
  parseModelRoutingConfig,
  resolveEffectivePiBinding,
  unmatchablePatternReason,
  type EffectivePiBinding,
  type ModelRef,
  type ModelRoutingConfig,
} from "../../src/core/model-routing";
import type { PiBinding } from "../../src/core/model-profiles";

const declared: PiBinding = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "high",
});

const declared55: PiBinding = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.5",
  thinking: "medium",
});

const localConfigRaw = {
  schemaVersion: 1,
  defaultClass: "cloud",
  modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
  rules: [{ id: "local-parent", when: { parentClass: "local" }, use: { kind: "parent" } }],
};

const localConfigParsed = parseModelRoutingConfig(localConfigRaw);
if (!localConfigParsed.ok) throw new Error(localConfigParsed.error.message);
const localConfig: ModelRoutingConfig = localConfigParsed.value;

const qwenRef: ModelRef = { provider: "desktop-vllm", model: "qwen3.8-27b" };
const codexRef: ModelRef = { provider: "openai-codex", model: "gpt-5.6-sol" };

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
    expect(resolveEffectivePiBinding(declared, null, localConfig)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("returns the declared binding when the config is absent", () => {
    expect(resolveEffectivePiBinding(declared, qwenRef, null)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("inherits the parent model when the parent is local and a parent rule matches", () => {
    expect(resolveEffectivePiBinding(declared, qwenRef, localConfig)).toEqual({
      provider: "desktop-vllm",
      model: "qwen3.8-27b",
      thinking: "high",
    });
  });

  it("keeps the declared binding when the parent is not local", () => {
    expect(resolveEffectivePiBinding(declared, codexRef, localConfig)).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
  });

  it("keeps the declared thinking level when inheriting the parent model", () => {
    expect(resolveEffectivePiBinding(declared55, qwenRef, localConfig).thinking).toBe("medium");
  });

  it("keeps the declared binding when a matching rule says 'declared'", () => {
    const config: ModelRoutingConfig = Object.freeze({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: Object.freeze({ local: Object.freeze(["desktop-vllm/*"]) }),
      rules: Object.freeze([Object.freeze({ id: "r", when: Object.freeze({ parentClass: "local" }), use: Object.freeze({ kind: "declared" }) })]),
    });
    expect(resolveEffectivePiBinding(declared, qwenRef, config).model).toBe("gpt-5.6-sol");
  });

  it("keeps the declared binding when no rule matches the parent class", () => {
    const config: ModelRoutingConfig = Object.freeze({
      schemaVersion: 1,
      defaultClass: "cloud",
      modelClasses: Object.freeze({ local: Object.freeze(["desktop-vllm/*"]) }),
      rules: Object.freeze([Object.freeze({ id: "r", when: Object.freeze({ parentClass: "other" }), use: Object.freeze({ kind: "parent" }) })]),
    });
    expect(resolveEffectivePiBinding(declared, qwenRef, config).model).toBe("gpt-5.6-sol");
  });
});

describe("model-routing property tests", () => {
  const modelRefArb: fc.Arbitrary<ModelRef> = fc
    .tuple(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)), fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)))
    .map(([provider, model]) => Object.freeze({ provider, model }));

  it("resolveEffectivePiBinding is total and always preserves the declared thinking level", () => {
    fc.assert(
      fc.property(modelRefArb, fc.constantFrom(null, localConfig), fc.constantFrom(declared, declared55), (parentRef, config, declaredBinding) => {
        const result: EffectivePiBinding = resolveEffectivePiBinding(declaredBinding, parentRef, config);
        expect(result.thinking).toBe(declaredBinding.thinking);
        expect(typeof result.provider).toBe("string");
        expect(typeof result.model).toBe("string");
      }),
      { numRuns: 200 },
    );
  });

  it("resolves to the declared binding whenever the parent is not local or the config/parent is absent", () => {
    fc.assert(
      fc.property(modelRefArb, fc.constantFrom(declared, declared55), (parentRef, declaredBinding) => {
        const parentClass = classifyModelRef(parentRef, localConfig);
        if (parentClass === "local") return; // the inherit case is covered separately
        const result = resolveEffectivePiBinding(declaredBinding, parentRef, localConfig);
        expect(result.provider).toBe(declaredBinding.provider);
        expect(result.model).toBe(declaredBinding.model);
      }),
      { numRuns: 200 },
    );
  });

  it("inherits exactly the parent provider/model for a local parent under the local-parent rule", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("/") && !/\s/.test(s)), fc.constantFrom(declared, declared55), (model, declaredBinding) => {
        const parentRef: ModelRef = Object.freeze({ provider: "desktop-vllm", model });
        const result = resolveEffectivePiBinding(declaredBinding, parentRef, localConfig);
        expect(result.provider).toBe("desktop-vllm");
        expect(result.model).toBe(model);
      }),
      { numRuns: 200 },
    );
  });
});
