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

/** Pair only parser-proven test commands with their exact Pi tool result.
 * The classified test segment must own the Bash call's exit status. */
export function piStructuredTestResult(messages: readonly PiMessage[]): { passed: boolean; evidence: string } | null {
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
  return latest;
}

/**
 * Convert Pi's toolCall/toolResult message shape into the JSONL shape consumed
 * by Loom's transcript parsers. Tool-call IDs are preserved so anti-spoofing
 * parsers can pair a real command with its exact result.
 */
export function messagesToClaudeJsonl(messages: readonly PiMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = msg.content.map((block) => {
        if (block.type === "toolCall") {
          return {
            type: "tool_use",
            name: TOOL_NAME_MAP[block.name ?? ""] ?? block.name ?? "",
            id: block.id ?? "",
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
      const resultContent = msg.content.map((block) =>
        block.type === "text" ? { type: "text", text: block.text ?? "" } : block,
      );
      lines.push(JSON.stringify({
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
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

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
