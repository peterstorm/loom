/**
 * Core: Validate that task prompts have no unsubstituted template variables.
 * Harness-agnostic — no stdin parsing. Not pure: resolves the active graph
 * lazily and reads the filesystem (existsSync).
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { taskGraphPath } from "../config";

const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

/**
 * The single source of truth for "unsubstituted template variable" detection:
 * strip shell `${var}` expansions, then match `{identifier}` placeholders minus
 * the {type}/{id}/{name} false-positive set. Exported so tests and other callers
 * share this exact logic instead of re-implementing (and silently drifting from)
 * the regex.
 *
 * The identifier class is the template system's declared underscore grammar:
 * `[a-zA-Z_][a-zA-Z0-9_]*`. Dots and hyphens are deliberately excluded because
 * arbitrary Task prompts commonly contain JSX/member and arithmetic expressions
 * such as `{props.title}` and `{width-height}`; treating those as template names
 * blocks valid code-bearing prompts.
 *
 * Nesting note: the `${...}` strip is non-greedy up to the first `}`, so a nested
 * expansion like `${foo{bar}}` matches `${foo{bar}` and leaves a lone `}`, which
 * matches no placeholder and is correctly allowed. The strip only leaves a
 * residual `{word}` for ADJACENT braces (`${done}{leftover}`), where `{leftover}`
 * is a genuine unsubstituted placeholder that SHOULD block. Both outcomes are
 * correct — neither is a silent pass.
 */
export function findResidualPlaceholders(prompt: string): string[] {
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");
  const matches = cleaned.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  return matches.filter((v) => !FALSE_POSITIVES.has(v));
}

export function validateTemplateSubstitution(prompt: string): HookResult {
  if (!existsSync(taskGraphPath())) return { kind: "allow" };
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
