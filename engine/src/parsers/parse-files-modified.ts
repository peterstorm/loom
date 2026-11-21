/**
 * Extract Write/Edit file paths from a Claude Code JSONL transcript. A Pi
 * transcript is never read here: Pi's write targets are a fold over its
 * projected tool calls (`pi/transcript-adapter.ts`).
 */

import { parseJsonl, getContentBlocks } from "./types";
import { FILE_MODIFYING_TOOLS } from "../core/tool-vocabulary";

export function parseFilesModified(content: string): string[] {
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

  return [...files].sort();
}
