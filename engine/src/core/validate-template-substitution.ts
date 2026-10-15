/**
 * Core: Validate that task prompts have no unsubstituted template variables.
 * Harness-agnostic and pure: the shell supplies its pre-gathered TaskGraph
 * existence fact.
 */

import type { HookResult } from "../types";
import { ACCEPTANCE_RUNNER_FILES_PLACEHOLDER } from "./verification-manifest";

/** Placeholders that legitimately appear verbatim inside prompt content and
 *  are not template variables: {type}/{id}/{name} predate this gate,
 *  {system} appears verbatim in the binding rules' directory diagrams
 *  (`infra/{system}/`), which the /loom prompts inline wholesale — a rules
 *  literal, never a task-prompt variable — and {files} is the acceptance
 *  runner's own argument placeholder, which any Spec or plan describing a
 *  runner names verbatim and an engine-rendered brief then carries. No /loom
 *  template uses {files} as a variable. */
const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}", "{system}", ACCEPTANCE_RUNNER_FILES_PLACEHOLDER]);

/**
 * The single source of truth for "unsubstituted template variable" detection:
 * strip shell `${var}` expansions, then match `{identifier}` placeholders minus
 * the false-positive set above. Exported so tests and other callers
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

export function validateTemplateSubstitution(
  prompt: string,
  taskGraphExists: boolean,
): HookResult {
  if (!taskGraphExists) return { kind: "allow" };
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
