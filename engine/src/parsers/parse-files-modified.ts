/**
 * Extract Write/Edit file paths from a JSONL transcript.
 * Supports both Claude Code and pi formats (auto-detected or explicit).
 */

import { parseJsonl, parsePiJsonl, getContentBlocks, detectFormat, type TranscriptFormat } from "./types";
import { FILE_MODIFYING_TOOLS } from "../core/tool-vocabulary";

/**
 * Pi tool names that modify files, matched case-folded. Includes multi_edit:
 * pi treats it as a first-class file tool (extension.ts tool_result gate), and
 * pi tool blocks appear in both lowercase and capitalized forms (extension.ts
 * hedges on `write`/`Write`). Under-collecting here silently shrinks the
 * wave-gate lint set (lint-wave-gate reads files_modified) — a fail-open the
 * pi files_modified threading exists to close.
 */
const PI_FILE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit"]);

function parseClaudeFilesModified(content: string): string[] {
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

function parsePiFilesModified(content: string): string[] {
  const files = new Set<string>();

  for (const entry of parsePiJsonl(content)) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      // Pi embeds tool calls in assistant content as { type: "toolCall", name, arguments }
      if (block.type !== "toolCall") continue;
      if (!block.name || !PI_FILE_TOOLS.has(block.name.toLowerCase())) continue;

      const args = block.arguments as Record<string, unknown> | undefined;
      const filePath = args?.path ?? args?.file_path;

      if (typeof filePath === "string") {
        files.add(filePath);
      }
    }
  }

  return [...files].sort();
}

export function parseFilesModified(content: string, format?: TranscriptFormat): string[] {
  const fmt = format ?? detectFormat(content);
  return fmt === "pi" ? parsePiFilesModified(content) : parseClaudeFilesModified(content);
}
