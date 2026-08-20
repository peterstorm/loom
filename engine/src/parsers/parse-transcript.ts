/**
 * Extract plain text from a JSONL transcript.
 * Supports both Claude Code and pi formats (auto-detected or explicit).
 */

import {
  parseJsonl,
  parsePiJsonl,
  getContentBlocks,
  detectFormat,
  type ContentBlock,
  type PiEntry,
  type TranscriptFormat,
  type TranscriptLine,
} from "./types";

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

    texts.push(...textContent(msg.content));
  }

  return texts.join("\n");
}

export function parseTranscript(content: string, format?: TranscriptFormat): string {
  const fmt = format ?? detectFormat(content);
  return fmt === "pi" ? parsePiTranscript(content) : parseClaudeTranscript(content);
}

export type FirstUserPromptParse =
  | Readonly<{ ok: true; prompt: string }>
  | Readonly<{ ok: false; error: string }>;

const promptFailure = (error: string): FirstUserPromptParse => ({ ok: false, error });

function authoredPromptText(body: unknown): string | null {
  return typeof body === "string" || Array.isArray(body)
    ? textContent(body).join("\n")
    : null;
}

/** The first user-authored prompt only. Unlike general transcript extraction,
 * this is an attribution boundary: malformed JSON before the prompt and
 * user-role tool-result envelopes fail closed instead of being skipped. */
export function parseFirstUserPrompt(
  content: string,
  format?: TranscriptFormat,
): FirstUserPromptParse {
  let resolvedFormat = format;
  for (const [index, rawLine] of content.split("\n").entries()) {
    if (rawLine.trim() === "") continue;
    let parsed: TranscriptLine | PiEntry;
    try {
      parsed = JSON.parse(rawLine) as TranscriptLine | PiEntry;
    } catch (error) {
      return promptFailure(
        `malformed transcript JSON before the first user prompt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (resolvedFormat === undefined) {
      const candidate = parsed as PiEntry & { version?: unknown };
      resolvedFormat = candidate.type === "session" && candidate.version !== undefined ? "pi" : "claude";
    }

    if (resolvedFormat === "pi") {
      const entry = parsed as PiEntry;
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const body = entry.message.content;
      const prompt = authoredPromptText(body);
      if (prompt === null) {
        return promptFailure(`first Pi user prompt has unsupported content at line ${index + 1}`);
      }
      return prompt.trim() === ""
        ? promptFailure(`first user prompt is empty at line ${index + 1}`)
        : { ok: true, prompt };
    }

    const line = parsed as TranscriptLine;
    if (line.message?.role !== "user") continue;
    const body = line.message.content;
    if (Array.isArray(body) && body.some((block) =>
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "tool_result"
    )) {
      return promptFailure(`first user-role entry is a tool result, not an authored prompt, at line ${index + 1}`);
    }
    const prompt = authoredPromptText(body);
    if (prompt === null) {
      return promptFailure(`first Claude user prompt has unsupported content at line ${index + 1}`);
    }
    return prompt.trim() === ""
      ? promptFailure(`first user prompt is empty at line ${index + 1}`)
      : { ok: true, prompt };
  }
  return promptFailure("transcript contains no user-authored prompt");
}
