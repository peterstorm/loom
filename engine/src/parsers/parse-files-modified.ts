/**
 * Extract Write/Edit file paths from a Claude Code JSONL transcript. A Pi
 * transcript is never read here: Pi's write targets are a fold over its
 * projected tool calls (`pi/transcript-adapter.ts`). A Pi session handed to
 * this reader is refused, not read as an empty write set: a shrunken
 * `files_modified` would silently shrink the Wave Gate lint set.
 */

import { conversationLines, getContentBlocks, isPiSessionHeader, jsonlRecords } from "./types";
import { FILE_MODIFYING_TOOLS } from "../core/tool-vocabulary";
import { parseErr, parseOk, type LineParseResult } from "../core/parse-result";

export const PI_SESSION_REFUSAL =
  "transcript is a Pi session (it carries a session header record); the Claude reader never reads Pi write targets";

/** The write targets a Claude Code transcript records, sorted and distinct, or why it is not one. */
export function parseFilesModified(content: string): LineParseResult<readonly string[]> {
  // Each line is parsed once: the Pi refusal and the write scan read the same records.
  const records = jsonlRecords(content);
  if (records.some(isPiSessionHeader)) {
    return Object.freeze(parseErr<readonly string[]>(PI_SESSION_REFUSAL));
  }
  const files = new Set<string>();

  for (const line of conversationLines(records)) {
    for (const block of getContentBlocks(line)) {
      if (block.type !== "tool_use") continue;

      const name = block.name ?? "";
      if (!FILE_MODIFYING_TOOLS.has(name)) continue;

      const input = block.input as Record<string, unknown> | undefined;
      const filePath = input?.file_path ?? input?.path;

      if (typeof filePath === "string") {
        files.add(filePath);
      }
    }
  }

  return Object.freeze(parseOk<readonly string[]>(Object.freeze([...files].sort())));
}
