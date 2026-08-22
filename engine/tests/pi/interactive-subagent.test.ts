import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedPiAgentDefinition } from "../../src/utils/render-pi-agent";
import type { ExtensionUiResponse } from "../../../pi/interactive-rpc";
import {
  registerInteractiveSubagentTool,
  relayExtensionUiRequest,
  runInteractiveSubagent,
  stopInteractiveChild,
} from "../../../pi/interactive-subagent";

const ROOT = join(import.meta.dirname, "../../..");
const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

const prepareAgentDir = (): string => {
  const piAgentDir = mkdtempSync(join(tmpdir(), "loom-interactive-agent-"));
  temporaries.push(piAgentDir);
  const agentsDir = join(piAgentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "arch-interviewer-agent.md"),
    expectedPiAgentDefinition("arch-interviewer-agent", ROOT),
  );
  return piAgentDir;
};

const fakeRpcChildScript = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const at = buffer.indexOf("\n");
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const frame = JSON.parse(line);
    if (frame.type === "prompt") {
      process.stdout.write(JSON.stringify({
        type: "extension_ui_request", id: "question-1", method: "select",
        title: "Choose architecture", options: ["Simple", "Typed"]
      }) + "\n");
    } else if (frame.type === "extension_ui_response") {
      process.stdout.write(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Selected: " + frame.value }],
          model: "fake-model",
          stopReason: "stop",
          usage: {
            input: 12, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
            cost: { total: 0.25 }
          }
        }
      }) + "\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
    }
  }
});
setInterval(() => {}, 1000);
`;

describe("interactive Pi subagent shell", () => {
  it("relays an exact request id and preserves the same child turn through completion", async () => {
    const piAgentDir = prepareAgentDir();
    const relayed: string[] = [];
    let invocation: Readonly<{ command: string; args: readonly string[]; cwd: string }> | undefined;

    const result = await runInteractiveSubagent({
      agent: "arch-interviewer-agent",
      task: "Ask and write the interview digest",
      cwd: ROOT,
      packageRoot: ROOT,
      piAgentDir,
      relay: async (request): Promise<ExtensionUiResponse> => {
        relayed.push(`${request.kind}:${request.id}`);
        return { type: "extension_ui_response", id: request.id, value: "Typed" };
      },
    }, {
      spawnChild: (command, args, cwd) => {
        invocation = { command, args, cwd };
        return spawn(process.execPath, ["-e", fakeRpcChildScript], {
          cwd: ROOT,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });

    expect(invocation).toBeDefined();
    expect(invocation?.cwd).toBe(ROOT);
    expect(invocation?.args).toEqual(expect.arrayContaining([
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--extension", join(ROOT, "pi", "extension.ts"),
      "--extension", join(ROOT, "pi", "ask-user-question.ts"),
      "--model", "openai-codex/gpt-5.6-sol:high",
    ]));
    const toolFlag = invocation?.args.indexOf("--tools") ?? -1;
    expect(toolFlag).toBeGreaterThanOrEqual(0);
    expect(invocation?.args[toolFlag + 1]?.split(",")).toContain("AskUserQuestion");
    expect(relayed).toEqual(["select:question-1"]);
    expect(result).toMatchObject({
      agent: "arch-interviewer-agent",
      task: "Ask and write the interview digest",
      exitCode: 0,
      stopReason: "stop",
      model: "fake-model",
      usage: { input: 12, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.25, contextTokens: 18, turns: 1 },
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Selected: Typed" }],
      }),
    ]);
  });

  it("cancels an open relay when the RPC child exits", async () => {
    const piAgentDir = prepareAgentDir();
    const crashScript = String.raw`
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"open",method:"input",title:"Open"}) + "\n");
  setTimeout(() => process.exit(7), 10);
});
`;
    let relayWasCancelled = false;
    const result = await runInteractiveSubagent({
      agent: "arch-interviewer-agent",
      task: "interview",
      cwd: ROOT,
      packageRoot: ROOT,
      piAgentDir,
      relay: async (request, signal) => new Promise<ExtensionUiResponse>((resolveResponse) => {
        signal.addEventListener("abort", () => {
          relayWasCancelled = true;
          resolveResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
        }, { once: true });
      }),
    }, {
      spawnChild: () => spawn(process.execPath, ["-e", crashScript], {
        cwd: ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"],
      }),
    });

    expect(relayWasCancelled).toBe(true);
    expect(result).toMatchObject({ exitCode: 7, stopReason: "error" });
  });

  it("relays every supported parent dialog with method-correct responses", async () => {
    const calls: string[] = [];
    const ctx = {
      ui: {
        select: async () => { calls.push("select"); return "A"; },
        confirm: async () => { calls.push("confirm"); return true; },
        input: async () => { calls.push("input"); return "typed"; },
        editor: async () => { calls.push("editor"); return "edited"; },
      },
    };
    await expect(relayExtensionUiRequest(
      { kind: "select", id: "s", title: "S", options: ["A"] }, ctx as never,
    )).resolves.toEqual({ type: "extension_ui_response", id: "s", value: "A" });
    await expect(relayExtensionUiRequest(
      { kind: "confirm", id: "c", title: "C", message: "sure?" }, ctx as never,
    )).resolves.toEqual({ type: "extension_ui_response", id: "c", confirmed: true });
    await expect(relayExtensionUiRequest(
      { kind: "input", id: "i", title: "I" }, ctx as never,
    )).resolves.toEqual({ type: "extension_ui_response", id: "i", value: "typed" });
    await expect(relayExtensionUiRequest(
      { kind: "editor", id: "e", title: "E", prefill: "" }, ctx as never,
    )).resolves.toEqual({ type: "extension_ui_response", id: "e", value: "edited" });
    expect(calls).toEqual(["select", "confirm", "input", "editor"]);
  });

  it("returns the subagent-compatible details envelope from the registered tool", async () => {
    const piAgentDir = prepareAgentDir();
    type ToolExecute = (
      toolCallId: string,
      params: { agent: string; task: string; agentScope: "user" },
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: { hasUI: boolean; cwd: string; ui: { select: () => Promise<string> } },
    ) => Promise<{ details: unknown }>;
    let execute: ToolExecute | undefined;
    registerInteractiveSubagentTool({
      on: () => undefined,
      registerTool: (tool: { execute: ToolExecute }) => { execute = tool.execute; },
    } as never, ROOT, piAgentDir, {
      spawnChild: () => spawn(process.execPath, ["-e", fakeRpcChildScript], {
        cwd: ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    if (execute === undefined) throw new Error("interactive subagent tool was not registered");

    const result = await execute("tool-1", {
      agent: "arch-interviewer-agent",
      task: "Ask and return",
      agentScope: "user",
    }, undefined, undefined, {
      hasUI: true,
      cwd: ROOT,
      ui: { select: async () => "Typed" },
    });

    expect(result.details).toMatchObject({
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [{ agent: "arch-interviewer-agent", task: "Ask and return", exitCode: 0 }],
    });
  });

  it("rejects duplicate child UI request ids", async () => {
    const piAgentDir = prepareAgentDir();
    const duplicateScript = String.raw`
process.stdin.once("data", () => {
  const request = JSON.stringify({type:"extension_ui_request",id:"same",method:"input",title:"Value"}) + "\n";
  process.stdout.write(request + request);
});
setInterval(() => {}, 1000);
`;
    const result = await runInteractiveSubagent({
      agent: "arch-interviewer-agent",
      task: "interview",
      cwd: ROOT,
      packageRoot: ROOT,
      piAgentDir,
      relay: async (request) => ({ type: "extension_ui_response", id: request.id, value: "answer" }),
    }, {
      spawnChild: () => spawn(process.execPath, ["-e", duplicateScript], {
        cwd: ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    expect(result).toMatchObject({
      exitCode: 1,
      stopReason: "error",
      errorMessage: "Pi RPC child repeated UI request id same",
    });
  });

  it("escalates a shutdown-resistant child to SIGKILL", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], {
      cwd: ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<NodeJS.Signals | null>((resolveClosed) => {
      child.once("close", (_code, signal) => resolveClosed(signal));
    });
    await new Promise<void>((resolveReady) => child.stdout.once("data", () => resolveReady()));
    await stopInteractiveChild(child, 20);
    await expect(closed).resolves.toBe("SIGKILL");
  });

  it("reports cleanup failure without replacing a successful child result", async () => {
    const piAgentDir = prepareAgentDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runInteractiveSubagent({
        agent: "arch-interviewer-agent",
        task: "Ask and return",
        cwd: ROOT,
        packageRoot: ROOT,
        piAgentDir,
        relay: async (request) => ({ type: "extension_ui_response", id: request.id, value: "Typed" }),
      }, {
        spawnChild: () => spawn(process.execPath, ["-e", fakeRpcChildScript], {
          cwd: ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"],
        }),
        onChildSettled: () => { throw new Error("cleanup hook failed"); },
      });

      expect(result.exitCode).toBe(0);
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("notify child settlement: cleanup hook failed");
    } finally {
      stderr.mockRestore();
    }
  });

  it("fails instead of falling back to PATH when the active Pi entry point disappears", async () => {
    const piAgentDir = prepareAgentDir();
    const previousScript = process.argv[1];
    process.argv[1] = join(tmpdir(), `missing-pi-entry-${process.pid}`);
    try {
      await expect(runInteractiveSubagent({
        agent: "arch-interviewer-agent",
        task: "interview",
        cwd: ROOT,
        packageRoot: ROOT,
        piAgentDir,
        relay: async () => null,
      }, {
        spawnChild: () => { throw new Error("spawn should not be reached"); },
      })).rejects.toThrow("refusing PATH fallback");
    } finally {
      process.argv[1] = previousScript;
    }
  });

  it("fails before spawn when the generated Pi Agent is not the active package render", async () => {
    const piAgentDir = mkdtempSync(join(tmpdir(), "loom-interactive-stale-agent-"));
    temporaries.push(piAgentDir);
    const agentsDir = join(piAgentDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "arch-interviewer-agent.md"), "---\nname: arch-interviewer-agent\n---\nstale");

    await expect(runInteractiveSubagent({
      agent: "arch-interviewer-agent",
      task: "interview",
      cwd: ROOT,
      packageRoot: ROOT,
      piAgentDir,
      relay: async () => null,
    })).rejects.toThrow("differs from active package");
  });
});
