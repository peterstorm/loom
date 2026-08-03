/** Pi subagent messages adapted to the Claude-compatible JSONL parsers. */

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
