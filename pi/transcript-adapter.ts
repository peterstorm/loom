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

export interface PiContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

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

function transcriptErrors(messages: readonly PiMessage[]): readonly string[] {
  const errors: string[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      errors.push(`messages[${messageIndex}].content must be an array`);
      return;
    }
    message.content.forEach((block, blockIndex) => {
      const label = `messages[${messageIndex}].content[${blockIndex}]`;
      if (!block || typeof block !== "object" || typeof block.type !== "string") {
        errors.push(`${label} must be a typed content block`);
        return;
      }
      if (block.type !== "toolCall") return;
      if (typeof block.id !== "string" || block.id.trim() === "") errors.push(`${label}.id must be non-empty`);
      if (typeof block.name !== "string" || block.name.trim() === "") errors.push(`${label}.name must be non-empty`);
      if (block.name?.toLowerCase() === "bash" && typeof block.arguments?.command !== "string") {
        errors.push(`${label}.arguments.command must be a string for Bash`);
      }
    });
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || message.toolCallId.trim() === "") {
        errors.push(`messages[${messageIndex}].toolCallId must be non-empty`);
      }
      if (typeof message.toolName !== "string" || message.toolName.trim() === "") {
        errors.push(`messages[${messageIndex}].toolName must be non-empty`);
      }
    }
  });
  return errors;
}

/** Pair only parser-proven test commands with their exact Pi tool result.
 * The classified test segment must own the Bash call's exit status. */
export function piStructuredTestResult(
  messages: readonly PiMessage[],
): PiTranscriptResult<{ passed: boolean; evidence: string } | null> {
  const errors = transcriptErrors(messages);
  if (errors.length > 0) return { ok: false, errors };
  const testCalls = new Map<string, ClassifiedTestCommand>();
  let latest: { passed: boolean; evidence: string } | null = null;
  for (const message of messages) {
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
export function messagesToClaudeJsonl(messages: readonly PiMessage[]): PiTranscriptResult<string> {
  const errors = transcriptErrors(messages);
  if (errors.length > 0) return { ok: false, errors };
  const lines: string[] = [];

  for (const msg of messages) {
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
