/**
 * Extract test output ONLY from Bash tool_use/tool_result pairs in JSONL transcript
 * Anti-spoofing: ignores free text — only returns output from actual test commands
 */

import { parseJsonl, getContentBlocks, type ContentBlock } from "./types";
import { TEST_COMMAND_PATTERNS } from "../config";

function isTestCommand(cmd: string): boolean {
  const cmdLower = cmd.toLowerCase().trim();
  return TEST_COMMAND_PATTERNS.some((p) => cmdLower.includes(p));
}

function extractToolResultContent(block: ContentBlock): string[] {
  const results: string[] = [];
  const content = block.content;

  if (typeof content === "string") {
    results.push(content);
  } else if (Array.isArray(content)) {
    for (const sub of content) {
      if (sub.type === "text" && sub.text) {
        results.push(sub.text);
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
