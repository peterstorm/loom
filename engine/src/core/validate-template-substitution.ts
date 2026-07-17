/**
 * Core: Validate that task prompts have no unsubstituted template variables.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync).
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH } from "../config";

const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

/**
 * The single source of truth for "unsubstituted template variable" detection:
 * strip shell `${var}` expansions, then match `{identifier}` placeholders minus
 * the {type}/{id}/{name} false-positive set. Exported so tests and other callers
 * share this exact logic instead of re-implementing (and silently drifting from)
 * the regex.
 *
 * Known limitation: the `${...}` strip is non-greedy up to the first `}`, so a
 * nested shell expansion like `${foo{bar}}` leaves `{bar}` and reports it as a
 * residual placeholder (a false positive that blocks loudly, never a silent
 * pass). Templates in this repo do not nest braces; if that changes, widen the
 * strip rather than trusting the block message, which attributes the residual to
 * substitution logic.
 */
export function findResidualPlaceholders(prompt: string): string[] {
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");
  const matches = cleaned.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  return matches.filter((v) => !FALSE_POSITIVES.has(v));
}

export function validateTemplateSubstitution(prompt: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  if (!prompt) return { kind: "allow" };

  const realIssues = findResidualPlaceholders(prompt);

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
