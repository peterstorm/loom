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

export type FirstUserPromptParse =
  | Readonly<{ ok: true; prompt: string }>
  | Readonly<{ ok: false; error: string }>;

const promptFailure = (error: string): FirstUserPromptParse => ({ ok: false, error });

function authoredPromptText(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (!Array.isArray(body)) return null;
  return body.flatMap((block) =>
    typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string"
      ? [block.text]
      : []
  ).join("\n");
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
