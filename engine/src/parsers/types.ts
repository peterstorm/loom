/**
 * Shared types for Claude Code JSONL transcript parsing. Pi transcripts are
 * read by `pi/transcript-adapter.ts`, never here.
 */

import { claudeRecordKind } from "../core/claude-record-kind";
import { isRecord } from "../core/plain-record";

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

/** Every JSON value of a JSONL transcript, one per non-blank line, each parsed once. A line that is not JSON is skipped. */
export function jsonlRecords(content: string): readonly unknown[] {
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue; // Skip invalid JSON lines
    }
  }
  return records;
}

/**
 * The conversation lines among parsed transcript records. Harness records
 * (`api-request-blob` copies of earlier turns, attachments, …) are skipped:
 * they are never the agent's activity (see core/claude-record-kind).
 */
export function* conversationLines(records: readonly unknown[]): Generator<TranscriptLine> {
  for (const record of records) {
    if (claudeRecordKind(record) === "conversation") yield record as TranscriptLine;
  }
}

/** The conversation lines of a Claude Code JSONL transcript (see `conversationLines`). */
export function* parseJsonl(content: string): Generator<TranscriptLine> {
  yield* conversationLines(jsonlRecords(content));
}

/**
 * Whether a parsed transcript record is a Pi session header,
 * `{"type":"session","version":…}`: the mark of a Pi session file, which no
 * Claude reader here may read as Claude activity.
 */
export function isPiSessionHeader(record: unknown): boolean {
  return isRecord(record) && record.type === "session" && record.version !== undefined;
}

/** Extract content blocks from a transcript line (Claude Code) */
export function getContentBlocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content;
  if (!content) return [];
  if (typeof content === "string") return [];
  return content;
}
