/**
 * Extract test output ONLY from Bash tool_use/tool_result pairs in JSONL transcript
 * Anti-spoofing: ignores free text — only returns output from actual test commands
 */

import { parseJsonl, getContentBlocks, type ContentBlock } from "./types";
import { TEST_COMMAND_PATTERNS } from "../core/tool-vocabulary";

function isTestCommand(cmd: string): boolean {
  const cmdLower = cmd.toLowerCase().trim();
  return TEST_COMMAND_PATTERNS.some((p) => cmdLower.includes(p));
}

/**
 * The port through which the parser reaches a persisted output file: the
 * file's full text, or null when it is absent or unreadable (the reader, a
 * shell, reports an unreadable file itself — `readPersistedOutput` in
 * utils/persisted-output.ts). The parser stays a pure scraper of the
 * transcript text it is given.
 */
export type PersistedOutputReader = (filePath: string) => string | null;

/**
 * Resolve persisted output: when Bash output exceeds ~30KB, Claude Code saves
 * it to disk and the JSONL contains a `<persisted-output>` block with a file path
 * and a truncated preview. Read the full file to get the actual test results;
 * fall back to the truncated preview when the reader has none.
 */
function resolvePersistedOutput(text: string, readPersisted: PersistedOutputReader): string {
  const match = text.match(/Full output saved to:\s*(\S+)/);
  const filePath = match?.[1];
  return filePath === undefined ? text : readPersisted(filePath) ?? text;
}

function extractToolResultContent(block: ContentBlock, readPersisted: PersistedOutputReader): string[] {
  const results: string[] = [];
  const content = block.content;

  if (typeof content === "string") {
    results.push(resolvePersistedOutput(content, readPersisted));
  } else if (Array.isArray(content)) {
    for (const sub of content) {
      if (sub.type === "text" && sub.text) {
        results.push(resolvePersistedOutput(sub.text, readPersisted));
      }
    }
  }

  return results;
}

export function parseBashTestOutput(content: string, readPersisted: PersistedOutputReader): string {
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
          results.push(...extractToolResultContent(block, readPersisted));
        }
      }
    }
  }

  return results.join("\n");
}
