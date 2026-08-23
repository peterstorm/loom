import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import {
  cancelledUiResponse,
  confirmUiResponse,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
  parsePiRpcLine,
  StrictLfJsonlDecoder,
  valueUiResponse,
} from "./interactive-rpc";

export const LOOM_INTERACTIVE_SUBAGENT_TOOL = "loom_interactive_subagent";
const MAX_RPC_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_INTERACTIVE_RUNTIME_MS = 60 * 60 * 1000;

type InteractiveAgentSnapshot = Readonly<{
  agent: string;
  agentSource: "user";
  task: string;
  messages: readonly unknown[];
  stderr: string;
  usage: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  }>;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}>;

export type InteractiveAgentProgress = InteractiveAgentSnapshot & Readonly<{
  status: "running";
}>;

export type InteractiveAgentResult = InteractiveAgentSnapshot & Readonly<{
  status: "completed";
  exitCode: number;
}>;

type InteractiveAgentDefinition = Readonly<{
  model: string;
  tools: readonly string[];
  systemPrompt: string;
}>;

type SpawnRpcChild = (
  command: string,
  args: readonly string[],
  cwd: string,
) => ChildProcessWithoutNullStreams;

export type InteractiveSubagentDependencies = Readonly<{
  spawnChild?: SpawnRpcChild;
  onChildStarted?: (child: ChildProcessWithoutNullStreams) => void;
  onChildSettled?: (child: ChildProcessWithoutNullStreams) => void;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const textOfLastAssistant = (messages: readonly unknown[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (isRecord(content) && content.type === "text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
};

function loadInteractiveAgentDefinition(path: string): InteractiveAgentDefinition {
  const parsed = parseFrontmatter<Record<string, string>>(readFileSync(path, "utf8"));
  const model = parsed.frontmatter.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`interactive Pi agent definition ${path} has no exact model binding`);
  }
  const declaredTools = typeof parsed.frontmatter.tools === "string"
    ? parsed.frontmatter.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : [];
  const tools = declaredTools.length > 0 ? declaredTools : ["read", "bash", "edit", "write"];
  return Object.freeze({
    model,
    tools: Object.freeze([...new Set([...tools, "AskUserQuestion"])]),
    systemPrompt: parsed.body,
  });
}

function piInvocation(args: readonly string[]): Readonly<{ command: string; args: readonly string[] }> {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") === true;
  if (currentScript && !isBunVirtualScript) {
    try {
      accessSync(currentScript, fsConstants.F_OK);
      return Object.freeze({ command: process.execPath, args: Object.freeze([currentScript, ...args]) });
    } catch (error) {
      const message = errorText(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`active Pi entry point ${currentScript} is unavailable; refusing PATH fallback: ${message}`);
      }
      throw new Error(`cannot inspect active Pi entry point ${currentScript}: ${message}`);
    }
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? Object.freeze({ command: "pi", args: Object.freeze([...args]) })
    : Object.freeze({ command: process.execPath, args: Object.freeze([...args]) });
}

const rpcOptions = (
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Readonly<{ timeout?: number; signal?: AbortSignal }> => Object.freeze({
  ...(timeout === undefined ? {} : { timeout }),
  ...(signal === undefined ? {} : { signal }),
});

export async function relayExtensionUiRequest(
  request: ExtensionUiRequest,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ExtensionUiResponse | null> {
  switch (request.kind) {
    case "select": {
      const value = await ctx.ui.select(request.title, [...request.options], rpcOptions(request.timeout, signal));
      return value === undefined ? cancelledUiResponse(request.id) : valueUiResponse(request.id, value);
    }
    case "confirm": {
      const confirmed = await ctx.ui.confirm(request.title, request.message, rpcOptions(request.timeout, signal));
      return signal?.aborted === true
        ? cancelledUiResponse(request.id)
        : confirmUiResponse(request.id, confirmed);
    }
    case "input": {
      const value = await ctx.ui.input(request.title, request.placeholder, rpcOptions(request.timeout, signal));
      return value === undefined ? cancelledUiResponse(request.id) : valueUiResponse(request.id, value);
    }
    case "editor": {
      // Pi's editor API has no AbortSignal option. A child-lifetime relay must
      // not open a modal it cannot dismiss after the child exits.
      if (signal !== undefined) return cancelledUiResponse(request.id);
      const value = await ctx.ui.editor(request.title, request.prefill);
      return value === undefined ? cancelledUiResponse(request.id) : valueUiResponse(request.id, value);
    }
    case "notify":
      ctx.ui.notify(request.message, request.notifyType);
      return null;
    case "set-status":
      ctx.ui.setStatus(request.key, request.text);
      return null;
    case "set-widget":
      ctx.ui.setWidget(request.key, request.lines === undefined ? undefined : [...request.lines], {
        placement: request.placement,
      });
      return null;
    case "set-title":
      ctx.ui.setTitle(request.title);
      return null;
    case "set-editor-text":
      ctx.ui.setEditorText(request.text);
      return null;
  }
}

const defaultSpawn: SpawnRpcChild = (command, args, cwd) => spawn(command, [...args], {
  cwd,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

export async function stopInteractiveChild(
  child: ChildProcessWithoutNullStreams,
  graceMs = 5000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStopped) => {
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(force);
      resolveStopped();
    };
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish();
    }, graceMs);
    child.once("close", finish);
    child.kill("SIGTERM");
  });
}

function usageFromMessage(message: Record<string, unknown>): Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
}> {
  const usage = isRecord(message.usage) ? message.usage : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Object.freeze({
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    cost: number(cost.total),
    contextTokens: number(usage.totalTokens),
  });
}

export async function runInteractiveSubagent(
  input: Readonly<{
    agent: string;
    task: string;
    cwd: string;
    packageRoot: string;
    piAgentDir: string;
    signal?: AbortSignal;
    onUpdate?: (result: InteractiveAgentProgress) => void;
    relay: (request: ExtensionUiRequest, signal: AbortSignal) => Promise<ExtensionUiResponse | null>;
  }>,
  dependencies: InteractiveSubagentDependencies = {},
): Promise<InteractiveAgentResult> {
  const agentPath = join(input.piAgentDir, "agents", `${input.agent}.md`);
  const validation = validatePiAgentDefinitionFile(agentPath, input.agent, input.packageRoot);
  if (!validation.ok) throw new Error(validation.error);
  const definition = loadInteractiveAgentDefinition(agentPath);
  const promptDir = await mkdtemp(join(tmpdir(), "loom-pi-interactive-"));
  const promptPath = join(promptDir, "agent.md");
  await writeFile(promptPath, definition.systemPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--extension", join(input.packageRoot, "pi", "extension.ts"),
    "--extension", join(input.packageRoot, "pi", "ask-user-question.ts"),
    "--model", definition.model,
    "--tools", definition.tools.join(","),
    "--append-system-prompt", promptPath,
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    const invocation = piInvocation(args);
    child = (dependencies.spawnChild ?? defaultSpawn)(invocation.command, invocation.args, input.cwd);
    dependencies.onChildStarted?.(child);
  } catch (error) {
    await rm(promptDir, { recursive: true, force: true });
    throw error;
  }

  const messages: unknown[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  let model: string | undefined;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let stderr = "";
  let stdoutBytes = 0;
  let settled = false;
  let aborted = false;
  let protocolFailure: string | null = null;
  let forcedKill: NodeJS.Timeout | undefined;
  const decoder = new StrictLfJsonlDecoder();
  const observedUiRequestIds = new Set<string>();
  const childLifetime = new AbortController();
  const terminateChild = (): void => {
    childLifetime.abort();
    child.kill("SIGTERM");
    forcedKill ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
  };

  const currentSnapshot = (): InteractiveAgentSnapshot => Object.freeze({
    agent: input.agent,
    agentSource: "user",
    task: input.task,
    messages: Object.freeze([...messages]),
    stderr,
    usage: Object.freeze({ ...usage }),
    ...(model === undefined ? {} : { model }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  });
  const currentProgress = (): InteractiveAgentProgress => Object.freeze({
    ...currentSnapshot(),
    status: "running",
  });
  const currentResult = (exitCode: number): InteractiveAgentResult => Object.freeze({
    ...currentSnapshot(),
    status: "completed",
    exitCode,
  });

  const writeFrame = (
    frame: ExtensionUiResponse | Readonly<{ type: "prompt"; message: string }> | Readonly<{ type: "abort" }>,
  ): void => {
    if (!child.stdin.writable) throw new Error("Pi RPC child stdin is not writable");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const parsed = parsePiRpcLine(line);
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.value.kind === "extension-ui") {
      if (observedUiRequestIds.has(parsed.value.request.id)) {
        throw new Error(`Pi RPC child repeated UI request id ${parsed.value.request.id}`);
      }
      observedUiRequestIds.add(parsed.value.request.id);
      const response = await input.relay(parsed.value.request, childLifetime.signal);
      if (response !== null) writeFrame(response);
      return;
    }
    const { payload, type } = parsed.value;
    if (type === "message_end" && isRecord(payload.message)) {
      const message = payload.message;
      messages.push(Object.freeze({ ...message }));
      if (message.role === "assistant") {
        usage.turns += 1;
        const observed = usageFromMessage(message);
        usage.input += observed.input;
        usage.output += observed.output;
        usage.cacheRead += observed.cacheRead;
        usage.cacheWrite += observed.cacheWrite;
        usage.cost += observed.cost;
        usage.contextTokens = observed.contextTokens;
        if (typeof message.model === "string") model = message.model;
        if (typeof message.stopReason === "string") stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
      }
      input.onUpdate?.(currentProgress());
      return;
    }
    if (type === "extension_error") {
      throw new Error(`Pi RPC child extension failed: ${String(payload.error ?? "unknown extension error")}`);
    }
    if (type === "response" && payload.success === false) {
      throw new Error(`Pi RPC command ${String(payload.command ?? "unknown")} failed: ${String(payload.error ?? "unknown error")}`);
    }
    if (type === "agent_settled") {
      settled = true;
      terminateChild();
    }
  };

  const failProtocol = (error: unknown): void => {
    protocolFailure ??= errorText(error);
    terminateChild();
  };
  let processing = Promise.resolve();
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    processing = processing.then(async () => {
      if (stdoutBytes > MAX_RPC_STREAM_BYTES) throw new Error(`Pi RPC stream exceeded ${MAX_RPC_STREAM_BYTES} bytes`);
      const lines = decoder.push(chunk);
      if (!lines.ok) throw new Error(lines.error);
      for (const line of lines.value) await handleLine(line);
    }).catch(failProtocol);
  });
  child.once("close", () => childLifetime.abort());
  child.stdout.on("error", failProtocol);
  child.stdin.on("error", failProtocol);
  child.stderr.on("error", failProtocol);
  child.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr, "utf8") >= MAX_STDERR_BYTES) return;
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
      stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_STDERR_BYTES).toString("utf8") + "\n[stderr truncated]";
    }
  });

  const abort = (): void => {
    aborted = true;
    try {
      writeFrame({ type: "abort" });
    } catch (error) {
      protocolFailure ??= `failed to send Pi RPC abort frame: ${errorText(error)}`;
    }
    terminateChild();
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const runtimeTimeout = setTimeout(() => {
    protocolFailure = `interactive Pi child exceeded ${MAX_INTERACTIVE_RUNTIME_MS}ms`;
    terminateChild();
  }, MAX_INTERACTIVE_RUNTIME_MS);

  try {
    writeFrame({ type: "prompt", message: `Task: ${input.task}` });
    const exitCode = await new Promise<number>((resolveExit) => {
      child.once("error", (error) => {
        protocolFailure = `cannot start Pi RPC child: ${error.message}`;
        resolveExit(1);
      });
      child.once("close", (code) => resolveExit(code ?? (settled ? 0 : 1)));
    });
    await processing;
    const finished = decoder.finish();
    if (!finished.ok && protocolFailure === null) protocolFailure = finished.error;
    if (protocolFailure !== null) {
      errorMessage = protocolFailure;
      stopReason = "error";
    } else if (aborted) {
      errorMessage = "Interactive Pi subagent was aborted";
      stopReason = "aborted";
    } else if (!settled) {
      errorMessage = `Pi RPC child exited before agent_settled (exit ${exitCode})`;
      stopReason = "error";
    }
    return currentResult(protocolFailure === null && settled && !aborted ? 0 : Math.max(1, exitCode));
  } finally {
    clearTimeout(runtimeTimeout);
    if (forcedKill !== undefined) clearTimeout(forcedKill);
    input.signal?.removeEventListener("abort", abort);
    const cleanupErrors: string[] = [];
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch (error) {
      cleanupErrors.push(`kill child: ${errorText(error)}`);
    }
    try {
      dependencies.onChildSettled?.(child);
    } catch (error) {
      cleanupErrors.push(`notify child settlement: ${errorText(error)}`);
    }
    try {
      await rm(promptDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`remove prompt directory: ${errorText(error)}`);
    }
    if (cleanupErrors.length > 0) {
      process.stderr.write(`loom(pi): interactive subagent cleanup failed: ${cleanupErrors.join("; ")}\n`);
    }
  }
}

const subagentDetails = (result: InteractiveAgentProgress | InteractiveAgentResult) => Object.freeze({
  mode: "single" as const,
  agentScope: "user" as const,
  projectAgentsDir: null,
  results: Object.freeze([result]),
});

export function registerInteractiveSubagentTool(
  pi: ExtensionAPI,
  packageRoot: string,
  piAgentDir: string,
  dependencies: InteractiveSubagentDependencies = {},
): void {
  const activeChildren = new Set<ChildProcessWithoutNullStreams>();
  pi.on("session_shutdown", async () => {
    await Promise.all([...activeChildren].map((child) => stopInteractiveChild(child)));
  });

  pi.registerTool({
    name: LOOM_INTERACTIVE_SUBAGENT_TOOL,
    label: "Loom Interactive Subagent",
    description: "Run one interactive Loom phase agent in a Pi RPC child and relay its questions to the parent TUI.",
    promptSnippet: "Run a Loom phase agent that must ask the user questions",
    promptGuidelines: [
      "Use loom_interactive_subagent instead of subagent for specify-agent, clarify-agent, architecture-agent, and arch-interviewer-agent when they must question the user.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Interactive Loom phase agent name" }),
      task: Type.String({ description: "Fully substituted phase task prompt" }),
      agentScope: Type.Optional(Type.Literal("user", { default: "user" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("loom_interactive_subagent requires a parent TUI or RPC UI client");
      const result = await runInteractiveSubagent({
        agent: params.agent,
        task: params.task,
        cwd: resolve(ctx.cwd, params.cwd ?? ctx.cwd),
        packageRoot,
        piAgentDir,
        signal,
        relay: (request, childSignal) => relayExtensionUiRequest(request, ctx, childSignal),
        onUpdate: onUpdate === undefined ? undefined : (partial) => onUpdate({
          content: [{ type: "text", text: textOfLastAssistant(partial.messages) || "Interactive phase agent running…" }],
          details: subagentDetails(partial),
        }),
      }, {
        ...dependencies,
        onChildStarted: (child) => {
          activeChildren.add(child);
          dependencies.onChildStarted?.(child);
        },
        onChildSettled: (child) => {
          activeChildren.delete(child);
          dependencies.onChildSettled?.(child);
        },
      });
      const output = textOfLastAssistant(result.messages) || result.errorMessage || "(no output)";
      return {
        content: [{ type: "text", text: output }],
        details: subagentDetails(result),
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("loom interactive "))}${theme.fg("accent", args.agent)}\n` +
          theme.fg("dim", args.task.length > 80 ? `${args.task.slice(0, 80)}…` : args.task),
        0,
        0,
      );
    },
  });
}
