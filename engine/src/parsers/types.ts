/**
 * Shared types for JSONL transcript parsing.
 * Supports both Claude Code and pi formats.
 */

import { claudeRecordKind } from "../core/claude-record-kind";

export type TranscriptFormat = "claude" | "pi";

// --- Claude Code types ---

export interface TranscriptLine {
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  type?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
}

export interface ToolUseBlock extends ContentBlock {
  type: "tool_use";
  name: string;
  id: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock extends ContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
}

// --- Pi types ---

export interface PiEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: PiEntryMessage;
}

export interface PiEntryMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface PiContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

/** A parsed JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field that is not of its declared type is absent, never a value of another type. */
const stringField = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function parsePiContentBlock(raw: unknown): PiContentBlock | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    text: stringField(raw.text),
    name: stringField(raw.name),
    id: stringField(raw.id),
    arguments: isRecord(raw.arguments) ? raw.arguments : undefined,
  };
}

function parsePiContent(raw: unknown): PiContentBlock[] | string | undefined {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw as unknown)) return undefined;
  return (raw as readonly unknown[]).flatMap((block) => {
    const parsed = parsePiContentBlock(block);
    return parsed === null ? [] : [parsed];
  });
}

function parsePiEntryMessage(raw: unknown): PiEntryMessage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    role: stringField(raw.role),
    content: parsePiContent(raw.content),
    toolCallId: stringField(raw.toolCallId),
    toolName: stringField(raw.toolName),
    isError: typeof raw.isError === "boolean" ? raw.isError : undefined,
  };
}

/**
 * One Pi session entry read from a parsed JSONL value, or `null` when the
 * value is not an entry (not an object, or no string `type`). The read is
 * tolerant like the extractors it feeds: a field or content block that is not
 * what the format declares is dropped, and the rest of the entry is kept.
 */
export function parsePiEntry(raw: unknown): PiEntry | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    id: stringField(raw.id),
    parentId: raw.parentId === null ? null : stringField(raw.parentId),
    message: parsePiEntryMessage(raw.message),
  };
}

// --- Shared parsers ---

/**
 * The conversation lines of a Claude Code JSONL transcript. Harness records
 * (`api-request-blob` copies of earlier turns, attachments, …) are skipped:
 * they are never the agent's activity (see core/claude-record-kind).
 */
export function* parseJsonl(content: string): Generator<TranscriptLine> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Skip invalid JSON lines
    }
    if (claudeRecordKind(parsed) === "conversation") yield parsed as TranscriptLine;
  }
}

/** The entries of a Pi JSONL transcript. A line that is not JSON, or not an entry, is skipped. */
export function* parsePiJsonl(content: string): Generator<PiEntry> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Skip invalid JSON lines
    }
    const entry = parsePiEntry(parsed);
    if (entry !== null) yield entry;
  }
}

/** Extract content blocks from a transcript line (Claude Code) */
export function getContentBlocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content;
  if (!content) return [];
  if (typeof content === "string") return [];
  return content;
}

/** Detect transcript format from content */
export function detectFormat(content: string): TranscriptFormat {
  // Pi sessions start with {"type":"session","version":...}
  const firstLine = content.split("\n")[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    if (error instanceof SyntaxError) return "claude"; // not a JSON line: not a Pi session header
    throw error;
  }
  const isPiHeader = typeof parsed === "object" && parsed !== null &&
    "type" in parsed && parsed.type === "session" && "version" in parsed && parsed.version !== undefined;
  return isPiHeader ? "pi" : "claude";
}
