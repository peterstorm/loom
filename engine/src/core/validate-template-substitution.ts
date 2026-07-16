/**
 * Core: Validate that task prompts have no unsubstituted template variables.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync).
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH } from "../config";

const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

export function validateTemplateSubstitution(prompt: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  if (!prompt) return { kind: "allow" };

  // Remove shell ${var} expansions to avoid false positives
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");

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
}
