/**
 * Shared types for Claude Code JSONL transcript parsing. Pi transcripts are
 * read by `pi/transcript-adapter.ts`, never here.
 */

import { claudeRecordKind } from "../core/claude-record-kind";

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

/** Extract content blocks from a transcript line (Claude Code) */
export function getContentBlocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content;
  if (!content) return [];
  if (typeof content === "string") return [];
  return content;
}
