/**
 * Shared types for JSONL transcript parsing.
 * Supports both Claude Code and pi formats.
 */

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
  message?: {
    role: string;
    content: PiContentBlock[] | string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

export interface PiContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

// --- Shared parsers ---

/** Read and parse JSONL file line by line (Claude Code format) */
export function* parseJsonl(content: string): Generator<TranscriptLine> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as TranscriptLine;
    } catch {
      // Skip invalid JSON lines
    }
  }
}

/** Read and parse JSONL file line by line (pi format) */
export function* parsePiJsonl(content: string): Generator<PiEntry> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as PiEntry;
    } catch {
      // Skip invalid JSON lines
    }
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
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed.type === "session" && parsed.version !== undefined) return "pi";
  } catch {}
  return "claude";
}
