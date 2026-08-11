/** Pi subagent messages adapted to the Claude-compatible JSONL parsers. */

import { attributeExit, classifyTestCommandDetailed, type ClassifiedTestCommand } from "../engine/src/machine";
import { extractTestEvidence } from "../engine/src/handlers/subagent-stop/update-task-status";

const TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  find: "Find",
  grep: "Grep",
  ls: "Ls",
});

export type PiContentBlock =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "toolCall";
      id: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ type: "opaque"; originalType: string }>;

export interface PiMessage {
  readonly role: string;
  readonly content: readonly PiContentBlock[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export type PiTranscriptResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePiContentBlock(
  block: unknown,
  label: string,
  errors: string[],
): PiContentBlock | null {
  if (!isRecord(block) || typeof block.type !== "string" || block.type.trim() === "") {
    errors.push(`${label} must be a typed content block`);
    return null;
  }
  if (block.type === "text") {
    if (typeof block.text !== "string") {
      errors.push(`${label}.text must be a string`);
      return null;
    }
    return Object.freeze({ type: "text", text: block.text });
  }
  if (block.type === "toolCall") {
    const id = typeof block.id === "string" && block.id.trim() !== "" ? block.id : null;
    const name = typeof block.name === "string" && block.name.trim() !== "" ? block.name : null;
    const argumentsValue = isRecord(block.arguments) ? block.arguments : null;
    if (id === null) errors.push(`${label}.id must be non-empty`);
    if (name === null) errors.push(`${label}.name must be non-empty`);
    if (argumentsValue === null) errors.push(`${label}.arguments must be an object`);
    if (name?.toLowerCase() === "bash" &&
        (argumentsValue === null || typeof argumentsValue.command !== "string")) {
      errors.push(`${label}.arguments.command must be a string for Bash`);
    }
    if (id === null || name === null || argumentsValue === null) return null;
    return Object.freeze({
      type: "toolCall",
      id,
      name,
      arguments: Object.freeze({ ...argumentsValue }),
    });
  }
  return Object.freeze({ type: "opaque", originalType: block.type });
}

/** Parse the untrusted harness payload once so every consumer receives fresh,
 * immutable messages whose complete trusted shape has already been proven. */
export function parsePiMessages(messages: unknown): PiTranscriptResult<readonly PiMessage[]> {
  if (!Array.isArray(messages)) return { ok: false, errors: ["messages must be an array"] };
  const errors: string[] = [];
  const parsedMessages: PiMessage[] = [];
  messages.forEach((message, messageIndex) => {
    const messageLabel = `messages[${messageIndex}]`;
    if (!isRecord(message)) {
      errors.push(`${messageLabel} must be an object`);
      return;
    }
    const role = typeof message.role === "string" && message.role.trim() !== ""
      ? message.role
      : null;
    if (role === null) errors.push(`${messageLabel}.role must be a non-empty string`);

    const contentValue = message.content;
    const isStringContent = role !== null && typeof contentValue === "string";
    const isArrayContent = Array.isArray(contentValue);
    const isSingletonContentBlock = isRecord(contentValue);
    const contentBlocks = isArrayContent
      ? contentValue.map((block, blockIndex): readonly [unknown, string] => [block, `${messageLabel}.content[${blockIndex}]`])
      : isSingletonContentBlock
        ? [[contentValue, `${messageLabel}.content`] as const]
        : [];
    if (!isStringContent && !isArrayContent && !isSingletonContentBlock) {
      errors.push(`${messageLabel}.content must be an array, string, or typed content block`);
      return;
    }

    const blockErrorsBefore = errors.length;
    const content: PiContentBlock[] = isStringContent
      ? [Object.freeze({ type: "text", text: contentValue })]
      : [];
    for (const [block, label] of contentBlocks) {
      const parsedBlock = parsePiContentBlock(block, label, errors);
      if (parsedBlock !== null) content.push(parsedBlock);
    }

    const toolCallId = typeof message.toolCallId === "string" && message.toolCallId.trim() !== ""
      ? message.toolCallId
      : null;
    const toolName = typeof message.toolName === "string" && message.toolName.trim() !== ""
      ? message.toolName
      : null;
    if (message.toolCallId !== undefined && toolCallId === null) {
      errors.push(`${messageLabel}.toolCallId must be non-empty when present`);
    }
    if (message.toolName !== undefined && toolName === null) {
      errors.push(`${messageLabel}.toolName must be non-empty when present`);
    }
    if (message.role === "toolResult") {
      if (toolCallId === null) errors.push(`${messageLabel}.toolCallId must be non-empty`);
      if (toolName === null) errors.push(`${messageLabel}.toolName must be non-empty`);
    }
    if (message.isError !== undefined && typeof message.isError !== "boolean") {
      errors.push(`${messageLabel}.isError must be a boolean when present`);
    }

    if (role !== null && errors.length === blockErrorsBefore) {
      parsedMessages.push(Object.freeze({
        role,
        content: Object.freeze(content),
        ...(toolCallId === null ? {} : { toolCallId }),
        ...(toolName === null ? {} : { toolName }),
        ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
      }));
    }
  });
  return errors.length > 0
    ? { ok: false, errors: Object.freeze(errors) }
    : { ok: true, value: Object.freeze(parsedMessages) };
}

/** Pair only parser-proven test commands with their exact Pi tool result.
 * The classified test segment must own the Bash call's exit status. */
export function piStructuredTestResult(
  input: unknown,
): PiTranscriptResult<{ passed: boolean; evidence: string } | null> {
  const parsed = parsePiMessages(input);
  if (!parsed.ok) return parsed;
  const testCalls = new Map<string, ClassifiedTestCommand>();
  let latest: { passed: boolean; evidence: string } | null = null;
  for (const message of parsed.value) {
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type !== "toolCall" || block.name?.toLowerCase() !== "bash" || !block.id) continue;
        const command = typeof block.arguments?.command === "string" ? block.arguments.command : "";
        const classified = classifyTestCommandDetailed(command);
        if (classified !== null) testCalls.set(block.id, classified);
      }
      continue;
    }
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const classified = testCalls.get(message.toolCallId);
    if (classified === undefined) continue;
    const attributedExit = attributeExit(message.isError === true ? 1 : 0, classified);
    if (attributedExit === null) continue;
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const parsed = extractTestEvidence(text);
    latest = { passed: attributedExit === 0 && parsed.passed, evidence: parsed.evidence };
  }
  return { ok: true, value: latest };
}

/**
 * Convert Pi's toolCall/toolResult message shape into the JSONL shape consumed
 * by Loom's transcript parsers. Tool-call IDs are preserved so anti-spoofing
 * parsers can pair a real command with its exact result.
 */
export function messagesToClaudeJsonl(input: unknown): PiTranscriptResult<string> {
  const parsed = parsePiMessages(input);
  if (!parsed.ok) return parsed;
  const lines: string[] = [];

  for (const msg of parsed.value) {
    if (msg.role === "assistant") {
      const content = msg.content.map((block) => {
        if (block.type === "toolCall") {
          if (!block.name || !block.id) throw new Error("validated Pi tool call lost its identity");
          return {
            type: "tool_use",
            name: TOOL_NAME_MAP[block.name] ?? block.name,
            id: block.id,
            input: block.arguments ?? {},
          };
        }
        if (block.type === "text") return { type: "text", text: block.text ?? "" };
        return block;
      });
      lines.push(JSON.stringify({ message: { role: "assistant", content } }));
      continue;
    }

    if (msg.role === "toolResult") {
      if (!msg.toolCallId) throw new Error("validated Pi tool result lost its call identity");
      const resultContent = msg.content.map((block) =>
        block.type === "text" ? { type: "text", text: block.text ?? "" } : block,
      );
      lines.push(JSON.stringify({
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: resultContent,
          }],
        },
      }));
      continue;
    }

    if (msg.role === "user") {
      const content = msg.content.map((block) =>
        block.type === "text" ? { type: "text", text: block.text ?? "" } : block,
      );
      lines.push(JSON.stringify({ message: { role: "user", content } }));
    }
  }

  return { ok: true, value: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
}

/**
 * Collect every candidate final text payload from a Pi subagent result.
 *
 * Deliberately COLLECTS rather than selects. A Pi result is a list of content
 * blocks, and more than one text block means the engine genuinely cannot tell
 * which is the Agent's final answer. Returning them all lets
 * `parseFinalPayload` refuse the ambiguity; picking the last one here would
 * bury that decision in an adapter and hash whichever block happened to come
 * last as if it were the result.
 *
 * Text is passed through verbatim — no trim, no join, no normalisation — so
 * the bytes hashed on the Pi side are byte-identical to Claude's for the same
 * Agent output.
 */
export function piFinalPayloadCandidates(
  content: unknown,
): PiTranscriptResult<readonly Readonly<{ origin: string; text: string }>[]> {
  if (!Array.isArray(content)) {
    return { ok: false, errors: ["pi result content must be an array of blocks"] };
  }
  const candidates: Readonly<{ origin: string; text: string }>[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text !== "string") {
      return { ok: false, errors: [`pi text block at index ${index} carries no string text`] };
    }
    candidates.push({ origin: `content[${index}].text`, text });
  }
  return { ok: true, value: Object.freeze(candidates) };
}
