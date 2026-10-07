/**
 * The offline Pi child loop shared by the emission suites
 * (`pi/emission-tool-runtime.test.ts`, `pi/emission-vertical-slice.test.ts`): the REAL
 * pi-agent-core `runAgentLoop` with ONLY the model transport scripted (one
 * `AssistantMessageEventStream` per turn), the same offline-reproduction
 * posture the committed qualification probe used.
 *
 * This is the one place the suites track pi-ai/pi-agent-core stream semantics
 * (`start` then `done`; an aborted turn completes through the stream's `error`
 * event; a caller signal that fired before a response finishes the turn as
 * aborted). Both suites used to carry private copies that had already drifted
 * (one modelled aborts and recorded contexts, the other did neither).
 *
 * The registered emission tool is the PRODUCTION definition
 * (`pi/emission-tool.ts`'s `emissionToolDefinition`) with an observation
 * record wrapped around the PRODUCTION execute — never a test twin.
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type StreamFn } from "@earendil-works/pi-agent-core";
import type { IssuedEmissionBinding } from "../../src/core/emission-tool";
import { emissionToolDefinition } from "../../../pi/emission-tool";

/** The minimal complete pi Model record — the readiness probe discovered a
 *  definition without `input`/`cost` crashes pi-ai client-side before any
 *  request; the scripted transport never dials `baseUrl`. */
export const scriptedModel: Model<"openai-completions"> = {
  id: "scripted-emission-model",
  name: "scripted-emission-model",
  api: "openai-completions",
  provider: "scripted",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const zeroUsage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export type ScriptedToolCall = Readonly<{ type: "toolCall"; id: string; name: string; arguments: unknown }>;

export const assistantToolCallMessage = (calls: readonly ScriptedToolCall[]): AssistantMessage =>
  ({
    role: "assistant",
    content: calls,
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  }) as AssistantMessage;

export const assistantFinalTextMessage = (text: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  }) as AssistantMessage;

/** The transport's aborted-turn result: the final AssistantMessage carries
 *  stopReason "aborted" (pi-ai's cancellation contract — the final message of
 *  an aborted assistant turn) and whatever partial content had streamed when
 *  the cancel arrived — here, nothing. */
const assistantAbortedTurnMessage = (): AssistantMessage =>
  ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "scripted",
    model: scriptedModel.id,
    usage: zeroUsage(),
    stopReason: "aborted",
    errorMessage: "aborted by the caller",
    timestamp: Date.now(),
  }) as AssistantMessage;

/** The caller's cancellation arrived while the model streamed the emission
 *  tool call: the aborted turn's partial message still carries a structurally
 *  complete toolCall block. Because execute never ran, the transcript adapter
 *  classifies the call as incomplete and unusable rather than authoritative. */
export const assistantAbortedToolCallMessage = (calls: readonly ScriptedToolCall[]): AssistantMessage =>
  ({
    ...assistantToolCallMessage(calls),
    stopReason: "aborted",
    errorMessage: "aborted by the caller",
  }) as AssistantMessage;

/** One successfully executed emission call as it lands on a settled
 *  transcript: the assistant toolCall turn, then its acknowledged toolResult. */
export const acknowledgedEmissionCall = (id: string, toolName: string, args: unknown): readonly unknown[] => [
  assistantToolCallMessage([{ type: "toolCall", id, name: toolName, arguments: args }]),
  {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError: false,
    content: [{ type: "text", text: "payload acknowledged" }],
    details: {},
    timestamp: Date.now(),
  },
];

export interface ScriptedTurn {
  /** The transport for one assistant turn — the ONLY scripted part. */
  readonly streamFn: StreamFn;
  /** What the model saw on each request — the tool-role error feedback the
   *  re-prompt loop carries is asserted from these. */
  readonly contexts: readonly { readonly role: string; readonly isError?: boolean }[][];
  readonly callCount: () => number;
}

/** Script ONLY the model transport: one AssistantMessageEventStream per turn,
 *  shaped exactly as pi-ai's real streams are consumed (`start`, then the
 *  completing `done`, or `error` for an aborted turn). */
export const scriptTurns = (responses: readonly AssistantMessage[]): ScriptedTurn => {
  let call = 0;
  const contexts: { role: string; isError?: boolean }[][] = [];
  const streamFn: StreamFn = (_model, context, options) => {
    contexts.push(structuredClone(context.messages) as { role: string; isError?: boolean }[]);
    // The transport honours the caller's cancellation signal the way real
    // pi-ai streams do: a request whose signal fires before its response
    // completes finishes as an aborted turn — it never consumes a scripted
    // response.
    const message: AssistantMessage | undefined = options?.signal?.aborted
      ? assistantAbortedTurnMessage()
      : responses[call];
    if (message === undefined) {
      // A script exhausted by an unexpected follow-up turn is a test defect,
      // never a silent empty stream: pi would treat an immediately-ended
      // stream as an error turn, masking the behavior under test.
      throw new Error(`scripted transport exhausted after ${call} response(s)`);
    }
    call += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "aborted") {
      // pi-ai's stream contract: an aborted turn completes through the
      // stream's `error` event, whose extracted result is the aborted
      // AssistantMessage the agent loop reads.
      stream.push({ type: "error", reason: "aborted", error: message });
    } else {
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
    }
    return stream;
  };
  return { streamFn, contexts, callCount: () => call };
};

export type ScriptedLoopOptions = Readonly<{
  signal?: AbortSignal;
  beforeToolCall?: AgentLoopConfig["beforeToolCall"];
}>;

/** Run the REAL agent loop over `tools` with the scripted transport. */
export const runScriptedLoop = async (
  tools: readonly Record<string, unknown>[],
  script: ScriptedTurn,
  loop?: ScriptedLoopOptions,
): Promise<{ readonly events: AgentEvent[]; readonly messages: readonly unknown[] }> => {
  const events: AgentEvent[] = [];
  const config = {
    model: scriptedModel,
    convertToLlm: (messages: readonly unknown[]) => messages,
    ...(loop?.beforeToolCall ? { beforeToolCall: loop.beforeToolCall } : {}),
  } as unknown as AgentLoopConfig;
  const messages = await runAgentLoop(
    [{ role: "user", content: "Emit the issued payload exactly once.", timestamp: Date.now() }],
    { systemPrompt: "loom producer agent", messages: [], tools } as unknown as AgentContext,
    config,
    (event) => {
      events.push(event);
    },
    loop?.signal,
    script.streamFn,
  );
  return { events, messages };
};

/** The PRODUCTION emission tool definition over `issued`, with the suite's
 *  observation record around the PRODUCTION execute — the arguments pi
 *  validated, seen beside the same admission decision. */
export const observedEmissionTool = (issued: IssuedEmissionBinding, observed: unknown[]): Record<string, unknown> => {
  const definition = emissionToolDefinition(issued);
  return {
    ...definition,
    execute: async (toolCallId: string, params: unknown) => {
      observed.push(params);
      return definition.execute(toolCallId, params);
    },
  } as Record<string, unknown>;
};
