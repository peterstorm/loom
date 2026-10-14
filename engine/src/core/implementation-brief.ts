/**
 * The implementation brief — the exact prompt one implementation dispatch
 * gives its child — rendered by the engine instead of hand-assembled by the
 * orchestrating model.
 *
 * Every value comes from protected authority: the Task row, the dispatch the
 * engine derived for it (`deriveTaskImplementationDispatch`), the Spec Index
 * text of its Requirement claims, its dependencies' settled output
 * (`predecessorOutputs`), the Agent Catalog's declared skill, the binding
 * rule documents its file list selects, the ownership of every plan
 * invariant whose family it changes, and its role in every Acceptance
 * Contract it writes, completes, or runs beside. The renderer then proves the
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
import { predecessorOutputErrorMessage, predecessorOutputs, renderPredecessorOutputs } from "./predecessor-output";
import { specIndexUnavailableMessage, type SpecIndexAvailability } from "./requirement-coverage";
import { findResidualPlaceholders } from "./validate-template-substitution";
import { ACCEPTANCE_RED_WINDOW, taskVerificationPolicy, type VerificationRequirement } from "./verification-policy";
import { invariantRoles } from "./plan-paths";
import { contractRole, coveredAnchors, frozenPaths, type AcceptanceContract } from "./acceptance-contract";
import type { PlanInvariant, Task, WaveImplementationDispatch } from "../types";
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
/** Literal substituted for `{scenario_test_names}` when the Task claims no Acceptance Scenario. */
export const NO_SCENARIO_TEST_NAMES = "None — this Task claims no Acceptance Scenario.";
/** Literal substituted for `{invariant_ownership}` when no owned invariant names a file the Task changes. */
export const NO_INVARIANT_OWNERSHIP = "None — no plan invariant names a file this Task changes.";
/** Literal substituted for `{acceptance_contract}` when no contract involves the Task. */
export const NO_ACCEPTANCE_CONTRACT = "None — no plan contract involves this Task.";

/** The template variables the implementation brief template must declare —
 *  exactly these, so a drifted template is refused rather than half-rendered. */
const BRIEF_VARIABLES = [
  "rules_content",
  "task_id",
  "wave",
  "agent_type",
  "required_skill",
  "dependencies",
  "predecessor_outputs",
  "verification_policy",
  "implementation_retry_context",
  "task_description",
  "spec_anchors_formatted",
  "spec_contributions_formatted",
  "scenario_test_names",
  "plan_context",
  "invariant_ownership",
  "acceptance_contract",
  "file_list",
  "plan_file_path",
] as const;
type BriefVariable = (typeof BRIEF_VARIABLES)[number];

export type ImplementationBriefInput = Readonly<{
  template: string;
  task: Task;
  dispatch: WaveImplementationDispatch;
  planFile: string | null;
  /** The protected spec_file's Spec Index observation. An unavailable one
   *  carries its stated reason, so a refusal can name why there is no index. */
  spec: SpecIndexAvailability;
  /** The whole protected Task roster, so each direct dependency's Predecessor
   *  Output is derived from its own settled state rather than reconstructed. */
  roster: readonly Task[];
  /** Contents of every rule document `ruleDocumentsFor(task.file_list)` names. */
  rules: ReadonlyMap<RuleDocument, string>;
  /** The invariants the protected plan declares; empty when there is no plan. */
  invariants: readonly PlanInvariant[];
  /** The TaskGraph's Acceptance Contracts, with their freeze; empty when none. */
  contracts: readonly AcceptanceContract[];
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
  | Readonly<{ kind: "predecessor-output-unavailable"; message: string }>
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
 * The test-name prefixes a Task owes: one per Acceptance Scenario it claims.
 * `/spec-check` links a scenario to its tests only by an `AS-NNN:` test-name
 * prefix, so an unnamed scenario is reported NOT COVERED. Contributions owe
 * none, because a Contribution is not a completion claim. Reached only after
 * every claim resolved against the Spec Index, so a `null` index here means
 * the Task claims nothing and "none owed" is true.
 */
function scenarioTestNames(claims: readonly string[], spec: ParsedSpec | null): string {
  const scenarioIds = new Set<string>(spec?.scenarios.map(({ id }) => id) ?? []);
  const owed = claims.filter((id) => scenarioIds.has(id));
  if (owed.length === 0) return NO_SCENARIO_TEST_NAMES;
  return [
    "Give each claimed Acceptance Scenario below at least one test whose name starts with its identifier and a colon. " +
      "`/spec-check` links a scenario to its tests only by that name and reports a scenario without one NOT COVERED. " +
      "If `new_tests` is waived, an existing test must already carry the name; report any that does not.",
    "",
    ...owed.map((id) => `- \`${id}: …\` — for example \`it('${id}: …', …)\` or \`@DisplayName("${id}: …")\``),
  ].join("\n");
}

/**
 * The ownership guidance for every owned invariant whose family this Task
 * changes: its role (owner, sibling, matrix-test author — possibly several),
 * then the whole family, so a sibling sees its owner and its peers. Unowned
 * and malformed invariants name no files, so they never render here (plan
 * validation has already refused a malformed one).
 */
function invariantOwnership(fileList: readonly string[], invariants: readonly PlanInvariant[]): string {
  const blocks = invariants.flatMap((invariant) => {
    if (invariant.ownership.kind !== "owned") return [];
    const { owner, siblings, matrixTest } = invariant.ownership;
    const played = invariantRoles(fileList, invariant.ownership);
    const roles = [
      ...(played.owner
        ? [`- Owner: you change the owner module \`${owner}\`. Implement the rule there, once; every sibling entry point must call it.`]
        : []),
      ...(played.siblings.length > 0
        ? [`- Sibling: you change ${played.siblings.map(({ path }) => `\`${path}\``).join(", ")}. Call the owner module \`${owner}\`; never re-implement the rule.`]
        : []),
      ...(played.matrixTest
        ? [`- Matrix test: you change \`${matrixTest}\`. It must exercise every sibling entry point listed below against the owner module.`]
        : []),
    ];
    if (roles.length === 0) return [];
    return [[
      `**${invariant.id}: ${invariant.title}**`,
      ...(invariant.statement === null ? [] : [invariant.statement]),
      "",
      "**Your role:**",
      ...roles,
      "",
      `**Owner module:** \`${owner}\``,
      siblings.length === 0
        ? "**Sibling entry points:** none"
        : ["**Sibling entry points:**", ...siblings.map(({ path, note }) => `- \`${path}\`${note === null ? "" : ` — ${note}`}`)].join("\n"),
      `**Matrix test:** \`${matrixTest}\``,
    ].join("\n")];
  });
  return blocks.length === 0 ? NO_INVARIANT_OWNERSHIP : blocks.join("\n\n");
}

/** The contract Task's instructions: write the frozen surface and stubs, so
 *  that the contract Wave's gate observes every acceptance testcase RED. */
function contractTaskBlock(contract: AcceptanceContract): string {
  return [
    `**${contract.id}: ${contract.title}** — you are its contract Task.`,
    contract.statement,
    "",
    "Write the frozen surface, and nothing that implements it:",
    contract.types.kind === "file"
      ? `- Types file \`${contract.types.path}\` — declarations only: the types, interfaces, sealed ADTs and function signatures consumers import. No logic: its bytes freeze.`
      : `- No shared types file: ${contract.types.reason}`,
    "- Acceptance tests — dedicated files. Name every testcase after the Requirement it decides (`AS-003: …`), and give every listed Requirement at least one:",
    ...contract.acceptance.map(({ path, anchors }) => `  - \`${path}\` — ${anchors.join(", ")}`),
    ...(contract.supportedDomain === null
      ? []
      : [`- Supported domain: \`${contract.supportedDomain}\` holds the supported/unsupported table, and the relevant laws, as test cases.`]),
    "- Stub every function the acceptance tests import, in this Task's other files, so the tests compile and FAIL by assertion or by a thrown \"not implemented\" — never by a missing import or a file that fails to load.",
    "",
    "Your Wave Gate passes only if every acceptance testcase is collected and fails, and nothing else fails. It then freezes these files: no later Task may change them, and only an operator Contract Revision can. Do not implement the behavior.",
  ].join("\n");
}

/** A claimant's instructions: the frozen paths are read-only, and the
 *  testcases deciding its claims must pass at its Wave Gate. */
function claimantBlock(contract: AcceptanceContract, claims: readonly string[]): string {
  const roster = contract.freeze.state === "frozen" ? contract.freeze.roster : [];
  const mine = roster.filter(({ anchors }) => anchors.some((anchor) => claims.includes(anchor)));
  return [
    `**${contract.id}: ${contract.title}** — you complete ${claims.join(", ")} (contract Task ${contract.contractTask}).`,
    contract.statement,
    "",
    "Frozen — read them, never write them; a write fails your byte-scope proof:",
    ...frozenPaths(contract).map((path) => `- \`${path}\``),
    "",
    mine.length > 0
      ? ["Turn these acceptance testcases green; your Wave Gate requires them passing:",
          ...mine.map(({ name, file }) => `- \`${name}\` (\`${file}\`)`)].join("\n")
      : `Turn green every acceptance testcase that names ${claims.join(", ")}; your Wave Gate requires them passing.`,
    "Testcases of Requirements completed in later Waves may still fail. If an acceptance test is wrong, stop and report it: only an operator Contract Revision changes a frozen file.",
  ].join("\n");
}

/** A red-window bystander's note: which pending failures are not its own. The
 *  waiver sentence appears only when the engine stamped the waiver — a Task
 *  that authored its own regression waiver keeps that reason. */
function bystanderBlock(contract: AcceptanceContract, task: Task): string {
  const files = contract.acceptance.map(({ path }) => `\`${path}\``).join(", ");
  const regression = taskVerificationPolicy(task).regression;
  const waived = regression.kind === "waived" && regression.reason === ACCEPTANCE_RED_WINDOW
    ? `Your regression run is waived for that reason (\`${ACCEPTANCE_RED_WINDOW}\`); the Wave Gate's suite judges everything else.`
    : "The Wave Gate's suite, which knows which testcases are pending, judges them.";
  return `**${contract.id}: ${contract.title}** — its acceptance testcases in ${files} may still fail in a full-suite run until the Tasks completing ${coveredAnchors(contract).join(", ")} land. ` +
    `${waived} Failures anywhere else are yours to fix.`;
}

/**
 * The Task's role in every Acceptance Contract — its contract Task, a claimant
 * of a Requirement it covers, or a Task inside its red window — read from the
 * one role rule, and the instructions its proof and Wave Gate hold it to.
 */
function acceptanceContractSection(task: Task, contracts: readonly AcceptanceContract[], roster: readonly Task[]): string {
  const tasks = roster.some(({ id }) => id === task.id) ? roster : [...roster, task];
  const blocks = contracts.flatMap((contract) => {
    const role = contractRole(contract, task, tasks);
    switch (role.kind) {
      case "contract-task": return [contractTaskBlock(contract)];
      case "claimant": return [claimantBlock(contract, role.anchors)];
      case "red-window": return [bystanderBlock(contract, task)];
      case "none": return [];
    }
  });
  return blocks.length === 0 ? NO_ACCEPTANCE_CONTRACT : blocks.join("\n\n");
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

  const index = input.spec.kind === "indexed" ? input.spec.index : null;
  const anchors = formattedRequirements(task.spec_anchors ?? [], index);
  const contributions = formattedRequirements(task.spec_contributions ?? [], index);
  if (!anchors.ok || !contributions.ok) {
    const missing = [...(anchors.ok ? [] : anchors.error), ...(contributions.ok ? [] : contributions.error)];
    return refused(
      "requirement-text-unavailable",
      input.spec.kind === "unavailable"
        ? `${task.id} claims Requirements (${missing.join(", ")}) but the protected spec_file has no Spec Index: ` +
          specIndexUnavailableMessage(input.spec.reason)
        : `${task.id} claims Requirements the Spec Index does not define: ${missing.join(", ")}`,
    );
  }

  const predecessors = predecessorOutputs(task, input.roster);
  if (!predecessors.ok) {
    return refused("predecessor-output-unavailable", `${task.id}: ${predecessorOutputErrorMessage(predecessors.error)}`);
  }

  const policy = taskVerificationPolicy(task);
  const values: Readonly<Record<BriefVariable, string>> = {
    rules_content: rulesContent,
    task_id: task.id,
    wave: String(task.wave),
    agent_type: task.agent,
    required_skill: requiredSkill,
    dependencies: task.depends_on.length === 0 ? "none" : task.depends_on.join(", "),
    predecessor_outputs: renderPredecessorOutputs(predecessors.value),
    verification_policy: [
      `- regression: ${requirementRendering(policy.regression)}`,
      `- new_tests: ${requirementRendering(policy.newTests)}`,
    ].join("\n"),
    implementation_retry_context: dispatch.promptAppendix ?? NO_RETRY_CONTEXT,
    task_description: task.description,
    spec_anchors_formatted: anchors.value,
    spec_contributions_formatted: contributions.value,
    scenario_test_names: scenarioTestNames(task.spec_anchors ?? [], index),
    plan_context: task.plan_context?.trim() || "None recorded for this Task; read the full plan.",
    invariant_ownership: invariantOwnership(task.file_list ?? [], input.invariants),
    acceptance_contract: acceptanceContractSection(task, input.contracts, input.roster),
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
