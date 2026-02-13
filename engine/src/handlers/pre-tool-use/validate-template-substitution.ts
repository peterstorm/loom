/**
 * Validate that Task tool prompts have no unsubstituted template variables.
 * Blocks Task spawns containing {variable} patterns.
 */

import { existsSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";

// Common false positives to skip
const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const input: PreToolUseInput = JSON.parse(stdin);
  if (input.tool_name !== "Task") return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? "";
  if (!prompt) return { kind: "allow" };

  // Remove shell ${var} expansions to avoid false positives
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");

  // Find {word} patterns
  const matches = cleaned.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  const realIssues = matches.filter((v) => !FALSE_POSITIVES.has(v));

  if (realIssues.length === 0) return { kind: "allow" };

  return {
    kind: "block",
    message: [
      "BLOCKED: Task prompt contains unsubstituted template variables:",
      `  ${realIssues.join(" ")}`,
      "",
      "These should have been substituted before spawning:",
      ...realIssues.map((v) => `  - ${v}`),
      "",
      "Check the /loom skill template substitution logic.",
    ].join("\n"),
  };
};

export default handler;
