/**
 * Extract test output ONLY from Bash tool_use/tool_result pairs in JSONL transcript
 * Anti-spoofing: ignores free text — only returns output from actual test commands
 */

import { parseJsonl, getContentBlocks, type ContentBlock } from "./types";
import { TEST_COMMAND_PATTERNS } from "../config";
import { existsSync, readFileSync } from "node:fs";

function isTestCommand(cmd: string): boolean {
  const cmdLower = cmd.toLowerCase().trim();
  return TEST_COMMAND_PATTERNS.some((p) => cmdLower.includes(p));
}

/**
 * Resolve persisted output: when Bash output exceeds ~30KB, Claude Code saves
 * it to disk and the JSONL contains a `<persisted-output>` block with a file path
 * and a truncated preview. Read the full file to get the actual test results.
 */
function resolvePersistedOutput(text: string): string {
  const match = text.match(/Full output saved to:\s*(\S+)/);
  if (match) {
    const filePath = match[1];
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, "utf-8");
      } catch {
        // Fall through to return original text
      }
    }
  }
  return text;
}

function extractToolResultContent(block: ContentBlock): string[] {
  const results: string[] = [];
  const content = block.content;

  if (typeof content === "string") {
    results.push(resolvePersistedOutput(content));
  } else if (Array.isArray(content)) {
    for (const sub of content) {
      if (sub.type === "text" && sub.text) {
        results.push(resolvePersistedOutput(sub.text));
      }
    }
  }

  return results;
}

export function parseBashTestOutput(content: string): string {
  const pendingToolIds = new Set<string>();
  const results: string[] = [];

  for (const line of parseJsonl(content)) {
    for (const block of getContentBlocks(line)) {
      if (block.type === "tool_use" && block.name === "Bash") {
        const input = block.input as Record<string, unknown> | undefined;
        const cmd = (input?.command as string) ?? "";

        if (isTestCommand(cmd) && block.id) {
          pendingToolIds.add(block.id);
        }
      }

      if (block.type === "tool_result") {
        const toolUseId = block.tool_use_id ?? "";
        if (pendingToolIds.has(toolUseId)) {
          results.push(...extractToolResultContent(block));
        }
      }
    }
  }

  return results.join("\n");
}
