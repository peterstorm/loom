/**
 * Shared types for Claude Code JSONL transcript parsing
 */

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

/** Read and parse JSONL file line by line */
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

/** Extract content blocks from a transcript line */
export function getContentBlocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content;
  if (!content) return [];
  if (typeof content === "string") return [];
  return content;
}
