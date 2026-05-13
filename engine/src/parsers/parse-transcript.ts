/**
 * Extract plain text from a JSONL transcript.
 * Supports both Claude Code and pi formats (auto-detected or explicit).
 */

import { parseJsonl, parsePiJsonl, getContentBlocks, detectFormat, type ContentBlock, type TranscriptFormat } from "./types";

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

function parseClaudeTranscript(content: string): string {
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

function parsePiTranscript(content: string): string {
  const texts: string[] = [];

  for (const entry of parsePiJsonl(content)) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (typeof msg.content === "string") {
      texts.push(msg.content);
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    }
  }

  return texts.join("\n");
}

export function parseTranscript(content: string, format?: TranscriptFormat): string {
  const fmt = format ?? detectFormat(content);
  return fmt === "pi" ? parsePiTranscript(content) : parseClaudeTranscript(content);
}
