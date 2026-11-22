/**
 * Extract Write/Edit file paths from a Claude Code JSONL transcript. A Pi
 * transcript is never read here: Pi's write targets are a fold over its
 * projected tool calls (`pi/transcript-adapter.ts`). A Pi session handed to
 * this reader is refused, not read as an empty write set: a shrunken
 * `files_modified` would silently shrink the Wave Gate lint set.
 */

import { parseJsonl, getContentBlocks } from "./types";
import { FILE_MODIFYING_TOOLS } from "../core/tool-vocabulary";
import { isRecord } from "../core/plain-record";

/** The write targets a Claude Code transcript records, sorted and distinct, or why it is not one. */
export type FilesModifiedResult =
  | Readonly<{ ok: true; value: readonly string[] }>
  | Readonly<{ ok: false; error: string }>;

export const PI_SESSION_REFUSAL =
  "transcript is a Pi session (it carries a session header record); the Claude reader never reads Pi write targets";

/** Whether one JSONL line is a Pi session header: `{"type":"session","version":…}`. */
function isPiSessionHeader(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return false; // Not a JSON record, so no session header; the Claude reader skips it too.
  }
  return isRecord(parsed) && parsed.type === "session" && parsed.version !== undefined;
}

export function parseFilesModified(content: string): FilesModifiedResult {
  if (content.split("\n").some((line) => line.trim() !== "" && isPiSessionHeader(line))) {
    return Object.freeze({ ok: false, error: PI_SESSION_REFUSAL });
  }
  const files = new Set<string>();

  for (const line of parseJsonl(content)) {
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

  return Object.freeze({ ok: true, value: Object.freeze([...files].sort()) });
}
