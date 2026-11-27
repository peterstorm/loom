/**
 * Core: Validate that a spawn prompt carries no unfilled Loom template variable.
 * Harness-agnostic and pure: the shell supplies its pre-gathered TaskGraph
 * existence fact and says where the prompt came from.
 *
 * The gate exists to catch a parent that skipped template assembly: it read a
 * template from `commands/templates/`, failed to replace one of its variables,
 * and would spawn a child on a half-specified prompt. Two facts bound it:
 *
 * - **Only Loom's own variables are variables.** A `{word}` whose name no
 *   Loom template declares is somebody's text: a Redis key pattern
 *   (`ab:outcome:{incidentId}`), a URL or path template, a JSX expression, a
 *   rules diagram. The detector flags only names in `LOOM_TEMPLATE_VARIABLES`.
 * - **An engine-rendered brief has no parent-filled variables.** The brief
 *   renderer fills its own template in one pass and refuses a template whose
 *   variables differ from the ones it owns, before any protected text is
 *   spliced in. What remains in the brief is protected Task, plan, Spec and
 *   rule text: even a Loom variable's own name there (`{spec_file_path}` in a
 *   plan about Loom) is that text, not a variable left unfilled.
 */

import type { HookResult } from "../types";

/**
 * Every variable a Loom prompt template declares: the `{name}` placeholders of
 * `commands/templates/*.md`, which the /loom parent fills before spawning
 * (the implementation brief template among them, which the engine fills).
 * A test pins this set to the template corpus, so a template that adopts a new
 * variable fails the suite until the name is added here.
 */
export const LOOM_TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  "acceptance_contract",
  "agent_type",
  "candidate_manifest_path",
  "candidate_output_path",
  "criterion",
  "date_slug",
  "dependencies",
  "feature_description",
  "file_list",
  "frozen_signatures",
  "implementation_retry_context",
  "interview_file_path",
  "interview_json_path",
  "invariant_ownership",
  "judge_verdicts",
  "lens_name",
  "lens_prompt",
  "loom_dir",
  "marker_count",
  "operator_note",
  "panel_ranking",
  "plan_context",
  "plan_file_path",
  "predecessor_outputs",
  "prior_context",
  "required_skill",
  "rules_content",
  "scenario_test_names",
  "spec_anchors_formatted",
  "spec_contributions_formatted",
  "spec_dir",
  "spec_file_path",
  "task_description",
  "task_id",
  "verification_policy",
  "wave",
]);

/**
 * Every `{identifier}` token in placeholder position, whatever its name: the
 * template grammar's syntax, before the vocabulary decides which tokens are
 * Loom variables. Shell `${var}` expansions are stripped first.
 *
 * The identifier class is the template system's declared underscore grammar:
 * `[a-zA-Z_][a-zA-Z0-9_]*`. Dots and hyphens are deliberately excluded because
 * arbitrary prompts commonly contain JSX/member and arithmetic expressions
 * such as `{props.title}` and `{width-height}`.
 *
 * A brace glued to a preceding identifier character is expression syntax, not
 * a placeholder: ADT field notation in plan and spec prose
 * (`red-then-green-unproven{gap}`), struct literals (`Point{x}`); so is a brace
 * next to a `|` or `&`, the union and intersection notation of the same prose,
 * glued (`{none}|{some T}`, `A&{b}`) or spaced (`null | {revision}`,
 * `FrozenSurface & {typesSha256}`). No Loom template puts a variable directly
 * after an identifier character or beside a type operator, so such a match is
 * skipped. The `${...}` strip leaves a space behind, so a placeholder glued to
 * a stripped expansion (`x${done}{leftover}`) is still a token.
 *
 * Nesting note: the `${...}` strip is non-greedy up to the first `}`, so a nested
 * expansion like `${foo{bar}}` matches `${foo{bar}` and leaves a lone `}`, which
 * matches no placeholder. The strip only leaves a residual `{word}` for ADJACENT
 * braces (`${done}{leftover}`), where `{leftover}` is a genuine token.
 */
export function placeholderTokens(text: string): string[] {
  const cleaned = text.replace(/\$\{[^}]*\}/g, " ");
  return cleaned.match(/(?<![A-Za-z0-9_|&])(?<![|&][ \t]+)\{[a-zA-Z_][a-zA-Z0-9_]*\}(?![ \t]*[|&])/g) ?? [];
}

/**
 * The single source of truth for "unfilled Loom template variable" detection:
 * the placeholder tokens whose name a Loom template declares. Exported so
 * tests and other callers share this exact logic instead of re-implementing
 * (and silently drifting from) it.
 */
export function findResidualPlaceholders(text: string): string[] {
  return placeholderTokens(text).filter((token) => LOOM_TEMPLATE_VARIABLES.has(token.slice(1, -1)));
}

/**
 * Where a spawn prompt came from, as the shell observed it.
 *
 * - `parent-assembled`: text the parent wrote or filled from a template; the
 *   gate judges its bytes.
 * - `engine-rendered-brief`: an implementation brief the engine rendered from
 *   protected state for a `LOOM_IMPLEMENTATION_BRIEF` marker. Its template was
 *   proven filled before protected text was spliced in, so there is nothing
 *   for this gate to judge; the marker's operator notes, the parent's only
 *   text in it, were parsed on the way in (`parseOperatorNote`).
 */
export type SpawnPrompt =
  | Readonly<{ kind: "parent-assembled"; text: string }>
  | Readonly<{ kind: "engine-rendered-brief" }>;

export const parentAssembled = (text: string): SpawnPrompt => Object.freeze({ kind: "parent-assembled", text });
export const ENGINE_RENDERED_BRIEF: SpawnPrompt = Object.freeze({ kind: "engine-rendered-brief" });

export function validateTemplateSubstitution(
  prompt: SpawnPrompt,
  taskGraphExists: boolean,
): HookResult {
  if (!taskGraphExists) return { kind: "allow" };
  if (prompt.kind === "engine-rendered-brief") return { kind: "allow" };

  const realIssues = findResidualPlaceholders(prompt.text);

  if (realIssues.length === 0) return { kind: "allow" };

  return {
    kind: "block",
    message: [
      "BLOCKED: Task prompt contains unsubstituted template variables:",
      `  ${realIssues.join(" ")}`,
      "",
      "These Loom template variables should have been substituted before spawning:",
      ...realIssues.map((v) => `  - ${v}`),
      "",
      "Check the /loom skill template substitution logic.",
    ].join("\n"),
  };
}
