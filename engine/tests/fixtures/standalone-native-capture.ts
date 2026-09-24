import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { LOOM_REVIEW_AUTHORITY_BRIDGE, readLoomReviewAuthorityBridge } from "../../src/handlers/helpers/programs/review-authority-bridge";
import { fixtureSession } from "./pi-session";
import { value } from "./standalone-successor-remediation";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
type Emit = (event: string, payload: Record<string, unknown>) => Promise<unknown[]>;
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function nativeBatchCapturer(root: string, harness: "claude" | "pi", session: ReturnType<typeof fixtureSession>, emit: Emit) {
  const bindings = await import("../../src/orchestration/session-run-bindings");
  const dispatch = await import("../../src/handlers/subagent-stop/dispatch");
  let ordinal = 0;
  let redeliver: ((texts?: readonly (readonly string[])[]) => Promise<unknown[]>) | undefined;
  const capture = async (handle: RunDirHandle, requests: readonly { authority: AgentRequestAuthority; task: string }[], texts: readonly (readonly string[])[]) => {
    const toolCallId = `owned-native-${++ordinal}`;
    if (harness === "pi") {
      value(await bindings.registerSessionRunBinding(session.transport, session.sessionId, {
        runId: handle.runId, runsRoot: handle.identity.runsRoot, runDirectory: handle.runDirectory,
        requestIds: requests.map(row => row.authority.requestId), resultDigest: null,
      }));
      const input = { tasks: requests.map(row => ({ agent: row.authority.role, task: row.task, cwd: root })), agentScope: "user" };
      const calls = await emit("tool_call", { toolName: "subagent", toolCallId, input });
      if (calls.some(result => result !== undefined)) throw Error(`native spawn refused: ${JSON.stringify(calls)}`);
      redeliver = (observed = texts) => emit("tool_result", { toolName: "subagent", toolCallId, input, isError: false, content: [],
        details: { results: input.tasks.map((item, index) => ({ agent: item.agent, task: item.task, exitCode: 0,
          messages: [{ role: "assistant", content: observed[index]!.map(text => ({ type: "text", text })) }] })) } });
      return redeliver();
    }
    const deliveries: ((observed: readonly string[]) => Promise<unknown>)[] = [];
    for (const [index, { authority }] of requests.entries()) {
      const nativeId = `${toolCallId}-${index}`;
      value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness, nativeId, requestId: authority.requestId,
        role: authority.role, attempt: authority.attempt }));
      const transcript = join(session.directory, `${nativeId}.jsonl`);
      deliveries.push(async observed => {
        writeFileSync(transcript, JSON.stringify({ message: { role: "assistant", content: observed.map(text => ({ type: "text", text })) } }) + "\n");
        process.env.LOOM_ORCHESTRATION_RUNS_ROOT = handle.identity.runsRoot;
        process.env.LOOM_ORCHESTRATION_RUN_DIR = handle.runDirectory;
        return dispatch.runDispatch(JSON.stringify({ session_id: session.sessionId, agent_id: nativeId,
          agent_type: authority.role, agent_transcript_path: transcript }), []);
      });
    }
    redeliver = async (observed = texts) => {
      const responses: unknown[] = [];
      for (const [index, deliver] of deliveries.entries()) responses.push(await deliver(observed[index]!));
      return responses;
    };
    return redeliver();
  };
  return { capture, retainFinalObservation: () => {
    if (redeliver === undefined) throw Error("native observation has not been issued");
    return redeliver;
  } };
}

/** Caller owns the ENTIRE session operation. No nested session scope, no ambient cleanup. */
export async function nativeSuccessorCapture(root: string, harness: "claude" | "pi") {
  const session = fixtureSession(root);
  const keys = ["PI_CODING_AGENT_DIR", "LOOM_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "LOOM_PI_EXTENSION_RUNTIME_ROOT", "LOOM_PI_EXTENSION_RUNTIME_REVISION",
    "LOOM_ORCHESTRATION_RUNS_ROOT", "LOOM_ORCHESTRATION_RUN_DIR"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const oldBridge = globals[LOOM_REVIEW_AUTHORITY_BRIDGE];
  const restore = () => {
    for (const [key, prior] of previous) { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
    if (oldBridge === undefined) delete globals[LOOM_REVIEW_AUTHORITY_BRIDGE]; else globals[LOOM_REVIEW_AUTHORITY_BRIDGE] = oldBridge;
  };
  try {
    // Shadow only this test worker's inherited transport locators; durable parent bindings and PI admission stay untouched.
    delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.PI_CODING_AGENT_DIR = join(session.directory, "pi-agent");
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "agents"), { recursive: true });
    const handlers = new Map<string, Handler[]>();
    if (harness === "pi") {
      const extension = await import("../../../pi/extension");
      const render = await import("../../src/utils/render-pi-agent");
      const { STANDALONE_REVIEWER_ROLES } = await import("../../src/core/standalone-review");
      for (const role of [...STANDALONE_REVIEWER_ROLES, "review-verifier-agent"]) {
        writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "agents", `${role}.md`), render.expectedPiAgentDefinition(role, packageRoot));
      }
      const api = { on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
        registerTool: () => undefined, registerCommand: () => undefined };
      extension.default(api as never, () => []);
    }
    const context = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => session.sessionId, getSessionFile: () => session.sessionFile } };
    const emit: Emit = async (event, payload) => {
      const responses: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) responses.push(await handler(payload, context));
      return responses;
    };
    const capturer = await nativeBatchCapturer(root, harness, session, emit);
    return { ...capturer, emit, session, verify: () => {
      if (harness !== "pi") throw Error("Claude has durable capture provenance, not a Pi process witness");
      return readLoomReviewAuthorityBridge(globalThis).verify({ cwd: root, sessionId: session.sessionId });
      },
      close: async () => {
        try { await emit("session_shutdown", { reason: "quit" }); }
        finally { restore(); }
      } };
  } catch (cause) { restore(); throw cause; }
}
