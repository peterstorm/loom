/**
 * The Pi user agent directory every Loom reader of it shares — tested at the
 * seam callers cross, never by matching a shell's source text.
 *
 * The pure resolver (`engine/src/core/pi-agent-directory.ts`) is Pi's own
 * `getAgentDir` rule over the environment and home directory; the factory
 * test proves the extension resolves it when its factory starts (not at
 * module import) and validates every spawn against exactly
 * `<that directory>/agents/<agent>.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  piAgentDefinitionPath,
  piHomeAgentDirectory,
  resolvePiAgentDirectory,
} from "../../src/core/pi-agent-directory";
import { LOOM_REVIEW_AUTHORITY_BRIDGE } from "../../src/handlers/helpers/programs/review-authority-bridge";

describe("resolvePiAgentDirectory", () => {
  it("honours PI_CODING_AGENT_DIR, else the home ~/.pi/agent directory", () => {
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/home/u")).toBe("/custom/pi");
    expect(resolvePiAgentDirectory({}, "/home/u")).toBe(join("/home/u", ".pi", "agent"));
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: undefined }, "/home/u")).toBe(join("/home/u", ".pi", "agent"));
    expect(piHomeAgentDirectory("/home/u")).toBe(join("/home/u", ".pi", "agent"));
  });

  it("treats an empty selection as unset, exactly as Pi does", () => {
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "" }, "/home/u")).toBe(join("/home/u", ".pi", "agent"));
  });

  it("normalises a selected directory the way Pi does: ~ against home, file:// URLs as paths", () => {
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, "/home/u")).toBe("/home/u");
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~/pi-agent" }, "/home/u")).toBe(join("/home/u", "pi-agent"));
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: pathToFileURL("/srv/pi agent").href }, "/home/u"))
      .toBe("/srv/pi agent");
    // Only a leading `~/` is the home shorthand; `~other/x` is a literal name.
    expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~other/x" }, "/home/u")).toBe("~other/x");
  });

  it("never consults the home directory when the session selects a plain directory", () => {
    const plain = fc.string({ minLength: 1 }).filter((selected) =>
      selected !== "~" && !selected.startsWith("~/") && !selected.startsWith("file://"));
    fc.assert(fc.property(plain, fc.string(), (selected, home) => {
      expect(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: selected }, home)).toBe(selected);
    }));
  });

  it("places each agent's generated definition under the directory's agents/ folder", () => {
    expect(piAgentDefinitionPath("/custom/pi", "code-reviewer")).toBe(join("/custom/pi", "agents", "code-reviewer.md"));
  });
});

describe("the extension factory's definition port", () => {
  type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
  const ENV_KEYS = [
    "PI_CODING_AGENT_DIR", "LOOM_STATE_PATH", "LOOM_SUBAGENT_DIR", "LOOM_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT",
    "LOOM_PI_EXTENSION_RUNTIME_ROOT", "LOOM_PI_EXTENSION_RUNTIME_REVISION",
    "LOOM_ORCHESTRATION_RUNS_ROOT", "LOOM_ORCHESTRATION_RUN_DIR",
  ] as const;
  let root: string;
  let previousEnv: readonly (readonly [string, string | undefined])[];
  let previousBridge: unknown;
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;

  beforeEach(() => {
    root = canonicalTempDir("loom-pi-agent-directory-");
    previousEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    previousBridge = globals[LOOM_REVIEW_AUTHORITY_BRIDGE];
    delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_STATE_PATH = join(root, "state", "active_task_graph.json");
    process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  });

  afterEach(() => {
    for (const [key, prior] of previousEnv) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    if (previousBridge === undefined) delete globals[LOOM_REVIEW_AUTHORITY_BRIDGE];
    else globals[LOOM_REVIEW_AUTHORITY_BRIDGE] = previousBridge;
    rmSync(root, { recursive: true, force: true });
  });

  /** Load one extension factory under the given agent directory and return
   *  the block reason its `tool_call` guard gives one Loom spawn. */
  const spawnRefusalUnder = async (
    agentDirectory: string,
    input: Readonly<Record<string, unknown>> = { agent: "code-reviewer", task: "Review the change" },
  ): Promise<string> => {
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    mkdirSync(join(agentDirectory, "agents"), { recursive: true });
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerTool: () => undefined,
      registerCommand: () => undefined,
    };
    const extension = await import("../../../pi/extension");
    extension.default(pi as never, () => []);
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const context = { cwd, hasUI: false, sessionManager: { getSessionId: () => "agent-directory-session" } };
    const responses: unknown[] = [];
    for (const handler of handlers.get("tool_call") ?? []) {
      responses.push(await handler({ toolName: "subagent", toolCallId: "call-agent-directory", input }, context));
    }
    const blocked = responses.find((response): response is { block: true; reason: string } =>
      typeof response === "object" && response !== null && (response as { block?: unknown }).block === true);
    if (blocked === undefined) throw new Error(`expected the spawn to be refused, received ${JSON.stringify(responses)}`);
    return blocked.reason;
  };

  it("runs the Spawn Admission over the user-scope definition, refusing a non-user agent scope", async () => {
    const refusal = await spawnRefusalUnder(join(root, "pi-agent-scope"), {
      agent: "code-reviewer",
      task: "Review the change",
      agentScope: "project",
    });
    expect(refusal).toContain("Loom-owned Pi agents require agentScope='user'");
    // The first factory test pays the extension's one-time module import and
    // transform, which routinely sits at the default 5 s budget under load.
  }, 30_000);

  it("reads the generated definition from the directory selected when each factory starts", async () => {
    const first = join(root, "pi-agent-first");
    const second = join(root, "pi-agent-second");
    const firstRefusal = await spawnRefusalUnder(first);
    // The admission's definition-identity guard, over the exact file Pi runs.
    expect(firstRefusal).toContain("must be rendered from active Loom package");
    expect(firstRefusal).toContain(`cannot read generated agent ${piAgentDefinitionPath(first, "code-reviewer")}`);
    // The same loaded module, a new factory, a different session directory:
    // the port follows the factory, never the module's import-time env.
    const secondRefusal = await spawnRefusalUnder(second);
    expect(secondRefusal).toContain(`cannot read generated agent ${piAgentDefinitionPath(second, "code-reviewer")}`);
    expect(secondRefusal).not.toContain(first);
  }, 30_000);
});
