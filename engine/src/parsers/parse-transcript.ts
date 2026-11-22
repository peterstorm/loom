/**
 * Extract plain text from a Claude Code JSONL transcript. Every reader here
 * serves a Claude Code hook; a Pi child's messages are read by
 * `pi/transcript-adapter.ts`. A Pi session file handed here reads as harness
 * metadata only (its records are typed `session`/`message`), so it yields no
 * text and no prompt — it fails closed.
 */

import { parseJsonl, getContentBlocks, type ContentBlock } from "./types";
import { claudeRecordKind } from "../core/claude-record-kind";
import { isRecord } from "../core/plain-record";
import { parseErr, parseOk, type LineParseResult } from "../core/parse-result";

function textContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string" && block.text.length > 0
      ? [block.text]
      : []
  );
}

function extractText(block: ContentBlock): string[] {
  if (block.type === "text") return textContent([block]);
  return block.type === "tool_result" ? textContent(block.content) : [];
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

function authoredPromptText(body: unknown): string | null {
  return typeof body === "string" || Array.isArray(body)
    ? textContent(body).join("\n")
    : null;
}

/** The first user-authored prompt only. Unlike general transcript extraction,
 * this is an attribution boundary: malformed JSON before the prompt and
 * user-role tool-result envelopes fail closed instead of being skipped. */
export function parseFirstUserPrompt(content: string): LineParseResult<string> {
  for (const [index, rawLine] of content.split("\n").entries()) {
    if (rawLine.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      return parseErr(
        `malformed transcript JSON before the first user prompt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(parsed)) {
      return parseErr(`malformed transcript entry before the first user prompt at line ${index + 1}: expected a JSON object`);
    }
    // Only a message that is an object can carry a role; any other is no user prompt.
    const message = isRecord(parsed.message) ? parsed.message : null;

    if (claudeRecordKind(parsed) === "harness") continue;
    if (message?.role !== "user") continue;
    const body = message.content;
    if (Array.isArray(body) && body.some((block) =>
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "tool_result"
    )) {
      return parseErr(`first user-role entry is a tool result, not an authored prompt, at line ${index + 1}`);
    }
    const prompt = authoredPromptText(body);
    if (prompt === null) {
      return parseErr(`first Claude user prompt has unsupported content at line ${index + 1}`);
    }
    return prompt.trim() === ""
      ? parseErr(`first user prompt is empty at line ${index + 1}`)
      : parseOk(prompt);
  }
  return parseErr("transcript contains no user-authored prompt");
}
