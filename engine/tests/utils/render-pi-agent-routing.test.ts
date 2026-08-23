import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  expectedPiAgentDefinition,
  renderPiAgentDefinition,
  renderPiAgentDefinitionWithBinding,
  validatePiAgentDefinitionFile,
  type PiRoutingContext,
} from "../../src/utils/render-pi-agent";
import {
  classifyModelRef,
  parseModelRef,
  parseModelRoutingConfig,
  resolveEffectivePiBinding,
  type ModelRef,
  type ModelRoutingConfig,
} from "../../src/core/model-routing";
import { lowerModelProfile, resolveAgentProfile, type PiBinding } from "../../src/core/model-profiles";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS = ["code-reviewer", "code-implementer-agent", "silent-failure-hunter"];

const declaredBinding = (agent: string): PiBinding => {
  const profile = resolveAgentProfile(agent);
  if (!profile.ok) throw new Error(profile.error.message);
  return lowerModelProfile(profile.value, "pi");
};

const LOCAL_PARENT: ModelRef = Object.freeze({ provider: "desktop-vllm", model: "qwen3.8-27b" });
const CLOUD_PARENT: ModelRef = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol" });

/** The policy `~/.pi/agent/model-routing.json` encodes: local parents inherit. */
const routingConfig = (rules: readonly unknown[] = [
  { id: "local-workloads-use-parent", when: { parentClass: "local" }, use: { kind: "parent" } },
]): ModelRoutingConfig => {
  const parsed = parseModelRoutingConfig({
    schemaVersion: 1,
    defaultClass: "cloud",
    modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
    rules,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const routing = (parentRef: ModelRef | null, config: ModelRoutingConfig | null): PiRoutingContext =>
  Object.freeze({ config, parentRef });

const source = (agent: string): string => readFileSync(join(ROOT, "agents", `${agent}.md`), "utf-8");

const modelLine = (rendered: string): string => {
  const match = /^model:\s*(.*)$/m.exec(rendered);
  if (match === null) throw new Error("rendered agent has no model line");
  return match[1]!;
};

// One scratch dir for every temp agent file this suite writes; cleaned once.
const scratch = mkdtempSync(join(tmpdir(), "loom-routing-agent-"));
let scratchCounter = 0;
const tempAgentFile = (contents: string): string => {
  const path = join(scratch, `agent-${scratchCounter += 1}.md`);
  writeFileSync(path, contents);
  return path;
};
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("routing-aware Pi agent rendering", () => {
  it("renders byte-identically when the effective binding equals the declared one", () => {
    for (const agent of AGENTS) {
      const declared = declaredBinding(agent);
      expect(renderPiAgentDefinitionWithBinding(source(agent), agent, ROOT, declared))
        .toBe(renderPiAgentDefinition(source(agent), agent, ROOT));
    }
  });

  it("renders the parent model for a routed binding, keeping the declared thinking level", () => {
    const agent = "code-reviewer";
    const declared = declaredBinding(agent);
    const rendered = renderPiAgentDefinitionWithBinding(source(agent), agent, ROOT, {
      provider: LOCAL_PARENT.provider,
      model: LOCAL_PARENT.model,
      thinking: declared.thinking,
    });
    expect(modelLine(rendered)).toBe(`desktop-vllm/qwen3.8-27b:${declared.thinking}`);
    expect(rendered).toContain("<!-- LOOM_PI_AGENT_ID:code-reviewer -->");
    expect(rendered).not.toBe(renderPiAgentDefinition(source(agent), agent, ROOT));
  });

  it("accepts the declared render for any routing context", () => {
    const path = tempAgentFile(expectedPiAgentDefinition("code-reviewer", ROOT));
    expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT, null)).toEqual({ ok: true });
    expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT, routing(LOCAL_PARENT, routingConfig())))
      .toEqual({ ok: true });
    expect(validatePiAgentDefinitionFile(path, "code-reviewer", ROOT, routing(CLOUD_PARENT, routingConfig())))
      .toEqual({ ok: true });
  });

  it("accepts the routed render only when the policy authorizes inheriting the parent", () => {
    const agent = "code-reviewer";
    const declared = declaredBinding(agent);
    const path = tempAgentFile(
      renderPiAgentDefinitionWithBinding(source(agent), agent, ROOT, {
        provider: LOCAL_PARENT.provider,
        model: LOCAL_PARENT.model,
        thinking: declared.thinking,
      }),
    );

    // Local parent + inherit rule → authorized.
    expect(validatePiAgentDefinitionFile(path, agent, ROOT, routing(LOCAL_PARENT, routingConfig())))
      .toEqual({ ok: true });

    // Cloud parent → not authorized, so the routed bytes are a mismatch.
    expect(validatePiAgentDefinitionFile(path, agent, ROOT, routing(CLOUD_PARENT, routingConfig()))).toMatchObject({
      ok: false,
      error: expect.stringContaining("differs from active package"),
    });

    // No context at all (legacy callers) → not authorized.
    expect(validatePiAgentDefinitionFile(path, agent, ROOT, null)).toMatchObject({
      ok: false,
      error: expect.stringContaining("differs from active package"),
    });

    // Local parent but an explicit `declared` rule → not authorized.
    const declaredRule = routingConfig([
      { id: "keep-declared", when: { parentClass: "local" }, use: { kind: "declared" } },
    ]);
    expect(validatePiAgentDefinitionFile(path, agent, ROOT, routing(LOCAL_PARENT, declaredRule))).toMatchObject({
      ok: false,
      error: expect.stringContaining("differs from active package"),
    });
  });

  it("rejects tampered routed bytes even under an authorized context", () => {
    const agent = "code-reviewer";
    const declared = declaredBinding(agent);
    const routed = renderPiAgentDefinitionWithBinding(source(agent), agent, ROOT, {
      provider: LOCAL_PARENT.provider,
      model: LOCAL_PARENT.model,
      thinking: declared.thinking,
    });
    const path = tempAgentFile(routed + "\nstale\n");
    expect(validatePiAgentDefinitionFile(path, agent, ROOT, routing(LOCAL_PARENT, routingConfig()))).toMatchObject({
      ok: false,
      error: expect.stringContaining("differs from active package"),
    });
  });

  it("property: parent-rendered bytes are accepted iff the policy makes the child inherit the parent", () => {
    const agent = "code-reviewer";
    const declared = declaredBinding(agent);
    const config = routingConfig();
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom("desktop-vllm", "desktop-muse", "openai-codex", "anthropic", "ollama"),
          fc.constantFrom("qwen3.8-27b", "deepseek-v4-flash", "gpt-5.6-sol", "gpt-5.5", "claude-opus-4-8"),
        ),
        ([provider, model]) => {
          const parentRef = parseModelRef(`${provider}/${model}`);
          if (!parentRef.ok) return;
          const ref = parentRef.value;
          const effective = resolveEffectivePiBinding(declared, ref, config);
          const inherits = effective.provider !== declared.provider || effective.model !== declared.model;
          const rendered = renderPiAgentDefinitionWithBinding(source(agent), agent, ROOT, {
            provider: ref.provider,
            model: ref.model,
            thinking: declared.thinking,
          });
          const path = tempAgentFile(rendered);
          const validation = validatePiAgentDefinitionFile(path, agent, ROOT, routing(ref, config));
          if (inherits) {
            expect(validation).toEqual({ ok: true });
            expect(classifyModelRef(ref, config)).toBe("local");
          } else {
            // Accepted only in the degenerate case where the parent binding is
            // the declared binding (the bytes ARE the declared render).
            const renderedAsDeclared = rendered === renderPiAgentDefinition(source(agent), agent, ROOT);
            expect(validation.ok).toBe(renderedAsDeclared);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
