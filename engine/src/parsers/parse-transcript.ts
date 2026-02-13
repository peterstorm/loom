/**
 * Extract plain text from a Claude Code JSONL transcript
 * Parses assistant messages, tool results, and nested content blocks
 */

import { parseJsonl, getContentBlocks, type ContentBlock } from "./types";

function extractText(block: ContentBlock): string[] {
  const texts: string[] = [];

  if (block.type === "text" && block.text) {
    texts.push(block.text);
  } else if (block.type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const sub of content) {
        if (sub.type === "text" && sub.text) {
          texts.push(sub.text);
        }
      }
    }
  }

  return texts;
}

export function parseTranscript(content: string): string {
  const texts: string[] = [];

  for (const line of parseJsonl(content)) {
    const msgContent = line.message?.content;

    if (typeof msgContent === "string") {
      texts.push(msgContent);
      continue;
    }

    for (const block of getContentBlocks(line)) {
      texts.push(...extractText(block));
    }
  }

  return texts.join("\n");
}
