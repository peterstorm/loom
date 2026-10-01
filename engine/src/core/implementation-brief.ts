/**
 * The implementation brief — the exact prompt one implementation dispatch
 * gives its child — rendered by the engine instead of hand-assembled by the
 * orchestrating model.
 *
 * Every value comes from protected authority: the Task row, the dispatch the
 * engine derived for it (`deriveTaskImplementationDispatch`), the Spec Index
 * text of its Requirement claims, the Agent Catalog's declared skill, and the
 * binding rule documents its file list selects. The renderer then proves the
 * result passes the same spawn-gate checks the harness will apply — no
 * residual template variable, and the canonical `**Task ID:**` binding naming
 * this Task — so a rendered brief is admissible by construction rather than by
 * the orchestrator's care.
 *
 * Pure: the shell reads the template, rules, graph and spec and passes them in.
 */

import { AGENT_CATALOG, type LoomAgentName } from "./model-profiles";
import { canonicalRecord, type DomainResult } from "./orchestration-contract";
import type { ParsedSpec } from "./parse-spec";
import { findResidualPlaceholders } from "./validate-template-substitution";
import { taskVerificationPolicy, type VerificationRequirement } from "./verification-policy";
import type { Task, WaveImplementationDispatch } from "../types";
import { extractTaskId } from "../utils/extract-task-id";

/** The binding rule documents an implementation brief can inline. */
export const RULE_DOCUMENTS = [
  "architecture.md",
  "typescript-patterns.md",
  "java-patterns.md",
  "property-testing.md",
  "rust-patterns.md",
] as const;
export type RuleDocument = (typeof RULE_DOCUMENTS)[number];

/** Which stack a declared artifact belongs to, by extension, in rule order. */
const STACK_RULES: readonly (readonly [RegExp, readonly RuleDocument[]])[] = [
  [/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, ["typescript-patterns.md"]],
  [/\.(?:java|kt|kts)$/i, ["java-patterns.md", "property-testing.md"]],
  [/\.rs$/i, ["rust-patterns.md"]],
];

/**
 * The rule documents a Task's brief inlines, selected deterministically from
 * its declared artifacts: `architecture.md` plus each touched stack's pattern
 * documents. A Task that declares no code artifact (documentation or
 * configuration only) inlines none.
 */
export function ruleDocumentsFor(fileList: readonly string[]): readonly RuleDocument[] {
  const stack = STACK_RULES.flatMap(([pattern, documents]) =>
    fileList.some((path) => pattern.test(path)) ? documents : []);
  return stack.length === 0 ? Object.freeze([]) : Object.freeze(["architecture.md", ...stack]);
}

/** Literal substituted for `{rules_content}` when no code is declared. */
export const NO_CODE_RULES = "N/A — no code in this task.";
/** Literal substituted for `{implementation_retry_context}` on attempt 1. */
export const NO_RETRY_CONTEXT = "None — semantic attempt 1.";

/** The template variables the implementation brief template must declare —
 *  exactly these, so a drifted template is refused rather than half-rendered. */
const BRIEF_VARIABLES = [
  "rules_content",
  "task_id",
  "wave",
  "agent_type",
  "required_skill",
  "dependencies",
  "verification_policy",
  "implementation_retry_context",
  "task_description",
  "spec_anchors_formatted",
  "spec_contributions_formatted",
  "plan_context",
  "file_list",
  "plan_file_path",
] as const;
type BriefVariable = (typeof BRIEF_VARIABLES)[number];

export type ImplementationBriefInput = Readonly<{
  template: string;
  task: Task;
  dispatch: WaveImplementationDispatch;
  planFile: string | null;
  /** The indexed Spec, or null when the protected spec_file is unindexed. */
  spec: ParsedSpec | null;
  /** Contents of every rule document `ruleDocumentsFor(task.file_list)` names. */
  rules: ReadonlyMap<RuleDocument, string>;
}>;

export type ImplementationBrief = Readonly<{
  taskId: string;
  agent: string;
  dispatch: WaveImplementationDispatch;
  prompt: string;
}>;

export type ImplementationBriefError =
  | Readonly<{ kind: "dispatch-task-mismatch"; message: string }>
  | Readonly<{ kind: "unknown-agent"; message: string }>
  | Readonly<{ kind: "template-variables-mismatch"; message: string }>
  | Readonly<{ kind: "rule-document-missing"; message: string }>
  | Readonly<{ kind: "requirement-text-unavailable"; message: string }>
  | Readonly<{ kind: "residual-placeholders"; message: string }>
  | Readonly<{ kind: "task-id-binding"; message: string }>;

const refused = (kind: ImplementationBriefError["kind"], message: string): DomainResult<never, ImplementationBriefError> =>
  canonicalRecord({ ok: false as const, error: canonicalRecord({ kind, message }) });

const PLACEHOLDER = /\{([a-z_]+)\}/g;

function templateVariables(template: string): readonly string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""))].sort();
}

function requirementRendering(requirement: VerificationRequirement<string>): string {
  return requirement.kind === "required" ? "required" : `waived (${requirement.reason})`;
}

function bulleted(lines: readonly string[], none: string): string {
  return lines.length === 0 ? none : lines.map((line) => `- ${line}`).join("\n");
}

/** Requirement text for each id, or the ids the Spec Index cannot resolve. */
function formattedRequirements(
  ids: readonly string[],
  spec: ParsedSpec | null,
): DomainResult<string, readonly string[]> {
  if (ids.length === 0) return { ok: true, value: "None." };
  const entries = spec === null ? [] : [...spec.frs, ...spec.scenarios, ...spec.oos];
  const contentById = new Map<string, string>(entries.map((entry) => [entry.id, entry.content]));
  const missing = ids.filter((id) => !contentById.has(id));
  if (missing.length > 0) return { ok: false, error: missing };
  return {
    ok: true,
    value: ids.map((id) => `- **${id}** — ${(contentById.get(id) ?? "").trim().replace(/\n/g, "\n  ")}`).join("\n"),
  };
}

/**
 * Render one Task's implementation brief, or refuse with the exact reason the
 * brief could not be admissible.
 */
export function renderImplementationBrief(
  input: ImplementationBriefInput,
): DomainResult<ImplementationBrief, ImplementationBriefError> {
  const { task, dispatch, template } = input;
  if (dispatch.taskId !== task.id) {
    return refused("dispatch-task-mismatch", `dispatch names ${dispatch.taskId} but the brief is for ${task.id}`);
  }
  if (!Object.prototype.hasOwnProperty.call(AGENT_CATALOG, task.agent)) {
    return refused("unknown-agent", `${task.id} names agent ${task.agent}, which the Agent Catalog does not define`);
  }
  const requiredSkill = AGENT_CATALOG[task.agent as LoomAgentName].requiredSkill ?? "none";

  const declared = templateVariables(template);
  const expected = [...BRIEF_VARIABLES].sort();
  if (declared.length !== expected.length || declared.some((name, index) => name !== expected[index])) {
    return refused(
      "template-variables-mismatch",
      `implementation brief template declares {${declared.join("}, {")}} but the renderer owns {${expected.join("}, {")}}`,
    );
  }

  const ruleNames = ruleDocumentsFor(task.file_list ?? []);
  const missingRules = ruleNames.filter((name) => !input.rules.has(name));
  if (missingRules.length > 0) {
    return refused("rule-document-missing", `binding rule document(s) unavailable: ${missingRules.join(", ")}`);
  }
  const rulesContent = ruleNames.length === 0
    ? NO_CODE_RULES
    : ruleNames.map((name) => (input.rules.get(name) ?? "").trimEnd()).join("\n\n");

  const anchors = formattedRequirements(task.spec_anchors ?? [], input.spec);
  const contributions = formattedRequirements(task.spec_contributions ?? [], input.spec);
  if (!anchors.ok || !contributions.ok) {
    const missing = [...(anchors.ok ? [] : anchors.error), ...(contributions.ok ? [] : contributions.error)];
    return refused(
      "requirement-text-unavailable",
      input.spec === null
        ? `${task.id} claims Requirements (${missing.join(", ")}) but the protected spec_file has no Spec Index`
        : `${task.id} claims Requirements the Spec Index does not define: ${missing.join(", ")}`,
    );
  }

  const policy = taskVerificationPolicy(task);
  const values: Readonly<Record<BriefVariable, string>> = {
    rules_content: rulesContent,
    task_id: task.id,
    wave: String(task.wave),
    agent_type: task.agent,
    required_skill: requiredSkill,
    dependencies: task.depends_on.length === 0 ? "none" : task.depends_on.join(", "),
    verification_policy: [
      `- regression: ${requirementRendering(policy.regression)}`,
      `- new_tests: ${requirementRendering(policy.newTests)}`,
    ].join("\n"),
    implementation_retry_context: dispatch.promptAppendix ?? NO_RETRY_CONTEXT,
    task_description: task.description,
    spec_anchors_formatted: anchors.value,
    spec_contributions_formatted: contributions.value,
    plan_context: task.plan_context?.trim() || "None recorded for this Task; read the full plan.",
    file_list: bulleted(task.file_list ?? [], "None declared."),
    plan_file_path: input.planFile ?? "none recorded",
  };
  // One pass over the TEMPLATE only: substituted values are never re-scanned
  // for variables, so a brace in Task text cannot be mistaken for one.
  const prompt = template.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name as BriefVariable] : placeholder);

  const residual = findResidualPlaceholders(prompt);
  if (residual.length > 0) {
    return refused(
      "residual-placeholders",
      `${task.id}'s brief would carry ${residual.join(" ")}, which the spawn gate refuses as unsubstituted ` +
        "template variables; they come from protected Task/plan/rule text, so correct that text",
    );
  }
  const bound = extractTaskId(prompt);
  if (bound !== task.id) {
    return refused(
      "task-id-binding",
      `${task.id}'s brief binds Task ${bound ?? "none"} first; the spawn gate binds the first **Task ID:** it finds`,
    );
  }
  return canonicalRecord({
    ok: true as const,
    value: canonicalRecord({ taskId: task.id, agent: task.agent, dispatch, prompt }),
  });
}

/**
 * The Pi dispatch marker: a spawn item whose whole task is
 * `LOOM_IMPLEMENTATION_BRIEF: T5` asks the Loom extension to substitute the
 * engine-rendered brief before any spawn gate reads the prompt, so the
 * orchestrating model never copies the brief into a tool call.
 */
export const IMPLEMENTATION_BRIEF_MARKER = "LOOM_IMPLEMENTATION_BRIEF";

const MARKER_LINE = new RegExp(`^${IMPLEMENTATION_BRIEF_MARKER}: (T\\d+)$`);

/** The Task a spawn item's task text asks to be expanded, or null when the
 *  task text is not exactly one brief marker. */
export function parseImplementationBriefMarker(task: string): string | null {
  return MARKER_LINE.exec(task.trim())?.[1] ?? null;
}
