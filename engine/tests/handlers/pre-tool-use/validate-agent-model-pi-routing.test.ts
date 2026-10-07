/**
 * Gate-level proof for the Pi spawn routing boundary: the hook observes the
 * ambient parent model + routing config and accepts exactly the renders Loom
 * computed under that context — the declared render always, and a parent-model
 * render only when the policy authorizes inheriting a local parent.
 *
 * The pure policy (core/model-routing) and the render/validate seam
 * (utils/render-pi-agent) are unit-tested elsewhere; this test pins the
 * composition a real Pi spawn goes through: hook → buildPiRoutingContext →
 * validatePiAgentDefinitionFile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// The account home `os.homedir()` answers when HOME is unset (its passwd
// fallback), substitutable so the HOME-unset arm is deterministic.
const accountHome = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => accountHome.value ?? actual.homedir() };
});
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../../../src/handlers/pre-tool-use/validate-agent-model";
import {
  renderPiAgentDefinition,
  renderPiAgentDefinitionWithBinding,
} from "../../../src/utils/render-pi-agent";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const AGENT = "code-reviewer";

const source = readFileSync(join(ROOT, "agents", `${AGENT}.md`), "utf-8");
const declaredRender = renderPiAgentDefinition(source, AGENT, ROOT);
const ROUTED_BINDING = Object.freeze({ provider: "desktop-vllm", model: "qwen3.8-27b", thinking: "high" as const });
const routedRender = renderPiAgentDefinitionWithBinding(source, AGENT, ROOT, ROUTED_BINDING);
const ROUTING_CONFIG = JSON.stringify({
  schemaVersion: 1,
  defaultClass: "cloud",
  modelClasses: { local: ["desktop-vllm/*", "desktop-muse/*"] },
  rules: [{ id: "local-workloads-use-parent", when: { parentClass: "local" }, use: { kind: "parent" } }],
});

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "HOME", "PI_PROVIDER", "PI_MODEL"] as const;

describe("validate-agent-model: Pi spawn routing boundary", () => {
  let agentDir: string;
  let home: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-routing-gate-"));
    home = mkdtempSync(join(tmpdir(), "pi-routing-home-"));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    accountHome.value = null;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("reads the definition under the account home when HOME is unset, as Pi does", async () => {
    // The guard, the routing loader and the Pi extension share one resolver:
    // with HOME unset and no PI_CODING_AGENT_DIR, the definition is the
    // account home's `.pi/agent/agents/<agent>.md` — never a cwd-relative
    // `.pi/agent` (the former `$HOME ?? ""` spelling, which read as absent).
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.HOME;
    accountHome.value = home;
    mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "agents", `${AGENT}.md`), declaredRender);
    expect(await spawn()).toEqual({ kind: "allow" });
  });

  const agentFile = () => join(agentDir, "agents", `${AGENT}.md`);
  const spawn = () => handler(JSON.stringify({
    tool_name: "subagent",
    tool_input: { agent: AGENT, agentScope: "user", task: "Review the frozen scope" },
  }), []);
  const withConfig = () => writeFileSync(join(agentDir, "model-routing.json"), ROUTING_CONFIG);
  const withParent = (provider: string, model: string) => {
    process.env.PI_PROVIDER = provider;
    process.env.PI_MODEL = model;
  };

  it("allows the declared render regardless of the ambient parent model", async () => {
    writeFileSync(agentFile(), declaredRender);
    expect(await spawn()).toEqual({ kind: "allow" });
    withConfig();
    withParent("desktop-vllm", "qwen3.8-27b");
    expect(await spawn()).toEqual({ kind: "allow" });
    withParent("openai-codex", "gpt-5.6-sol");
    expect(await spawn()).toEqual({ kind: "allow" });
  });

  it("allows a parent-model render exactly when the policy authorizes the local parent", async () => {
    writeFileSync(agentFile(), routedRender);

    // Local parent + inherit rule → authorized.
    withConfig();
    withParent("desktop-vllm", "qwen3.8-27b");
    expect(await spawn()).toEqual({ kind: "allow" });

    // Cloud parent → the routed bytes are a mismatch for this context.
    withParent("openai-codex", "gpt-5.6-sol");
    await expect(spawn()).resolves.toMatchObject({
      kind: "block",
      message: expect.stringContaining("differs from active package"),
    });

    // Local parent but no config → inheritance is never implicit.
    rmSync(join(agentDir, "model-routing.json"), { force: true });
    withParent("desktop-vllm", "qwen3.8-27b");
    await expect(spawn()).resolves.toMatchObject({
      kind: "block",
      message: expect.stringContaining("differs from active package"),
    });
  });

  it("still blocks a tampered agent file under an authorized routing context", async () => {
    writeFileSync(agentFile(), routedRender + "\nstale\n");
    withConfig();
    withParent("desktop-vllm", "qwen3.8-27b");
    await expect(spawn()).resolves.toMatchObject({
      kind: "block",
      message: expect.stringContaining("differs from active package"),
    });
  });
});
