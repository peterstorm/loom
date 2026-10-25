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
import { match } from "ts-pattern";
import { invariantRoles } from "./plan-paths";
import { obligationsTouchedBy, type OwnerScope } from "./owner-verification/obligations";
import type { OwnerObligation } from "./owner-verification/types";
import { contractRole, coveredAnchors, frozenPaths, type AcceptanceContract } from "./acceptance-contract";
import { redThenGreenDuty } from "./implementation-application";
import { deriveImplementationRetryDisposition } from "./implementation-retry";
import { isRedThenGreenFailureKind } from "./red-then-green";
import type { RedThenGreenFailureKind, TestFileClassification } from "./red-then-green-types";
import { quoteShellArgument } from "./shell-quoting";
import { classifyTaskFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
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
  "operator_note",
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
  /** The TaskGraph's Owner Obligations (`ownerScopeOf(graph)`). A graph
   *  populated before owner verification carries no stamp and is owed no
   *  owner duty, so the brief states none. */
  ownerScope: OwnerScope;
  /** The TaskGraph's Acceptance Contracts, with their freeze; empty when none. */
  contracts: readonly AcceptanceContract[];
  /** The TaskGraph's frozen verification manifest (`graph.verification_manifest`),
   *  absent only on a TaskGraph frozen before it existed. Its frozen test-file
   *  classification splits an I6-owing Task's file list for the I6 section. */
  verificationManifest: FrozenVerificationManifest | undefined;
  /** The TaskGraph's project root, absolute: where the I6 restore command
   *  runs, spelled literally so no command substitution reaches the guard. */
  repositoryRoot: string;
  /** The operator's notes from the dispatch marker (#119); empty for none. */
  operatorNotes: readonly OperatorNote[];
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
  | Readonly<{ kind: "task-id-binding"; message: string }>
  | Readonly<{ kind: "test-file-classification-unavailable"; message: string }>
  | Readonly<{ kind: "red-then-green-proof-unfrozen"; message: string }>;

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
 *
 * Each owned Invariant the Task touches by the population stamp (`touched`,
 * decided by INV-3's owner `obligationsTouchedBy`) also gets its owner duties
 * (`ownerDuties`). A touched obligation with no plan block of its own (a stamp
 * that drifted from the plan, which the Wave Gate blocks) still states its
 * duties, after the plan's blocks, rather than silently owing nothing.
 */
function invariantOwnership(
  fileList: readonly string[],
  invariants: readonly PlanInvariant[],
  touched: readonly OwnerObligation[],
): string {
  const dutyOf = new Map(touched.map((obligation) => [obligation.invariant, obligation] as const));
  const planBlocks = invariants.flatMap((invariant) => {
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
    return [{ id: invariant.id, text: [
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
    ].join("\n") }];
  });
  const rendered = new Set(planBlocks.map(({ id }) => id));
  const blocks = [
    ...planBlocks.map(({ id, text }) => {
      const duty = dutyOf.get(id);
      return duty === undefined ? text : `${text}\n\n${ownerDuties(duty)}`;
    }),
    ...touched.filter(({ invariant }) => !rendered.has(invariant)).map((duty) =>
      `**${duty.invariant}: ${duty.title}**\n\n${ownerDuties(duty)}`),
  ];
  return blocks.length === 0 ? NO_INVARIANT_OWNERSHIP : blocks.join("\n\n");
}

const quoted = (path: string): string => `\`${path}\``;

/**
 * The owner duties the Wave Gate holds an owned Invariant's family to (plan
 * AD-10, FR-027): sibling coverage of the matrix test, then mutation
 * verification of the owner's changed lines, or the declared exemption.
 */
function ownerDuties({ invariant, owner, siblings, matrixTest, mutation }: OwnerObligation): string {
  const reached = siblings.length === 0
    ? `the owner module ${quoted(owner)} (${invariant} declares no sibling entry point)`
    : `the owner module ${quoted(owner)} and every sibling entry point: ${siblings.map(({ path }) => quoted(path)).join(", ")}`;
  const coverage = `**Owner duties (${invariant}):** the matrix test ${quoted(matrixTest)} must import ${reached}. ` +
    "The Wave Gate checks that its imports, followed through re-exports, reach each of them.";
  const mutationDuty = match(mutation)
    .with({ kind: "verify" }, () =>
      `The owner's lines changed in the Wave, in ${quoted(owner)}, will be mutation-verified: every mutant the fixed ` +
      `operator set makes of them must be killed by ${quoted(matrixTest)}.`)
    .with({ kind: "exempt" }, ({ reason }) =>
      `${invariant} declares a mutation exemption, so ${quoted(owner)} is exempt from mutation verification; ` +
      `the declared reason: ${reason}. Sibling coverage still applies.`)
    .exhaustive();
  return `${coverage}\n\n${mutationDuty}`;
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
    "When the project declares an acceptance runner, the engine runs these testcases when you stop and keeps you working while one you owe still fails.",
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

/** The I6 failure kinds the retry this dispatch admits inherits, in receipt order. */
function inheritedRedThenGreenFailures(task: Task, dispatch: WaveImplementationDispatch): readonly RedThenGreenFailureKind[] {
  if (dispatch.kind !== "retry-implementation") return [];
  const disposition = deriveImplementationRetryDisposition(task);
  return disposition.kind === "retry" ? disposition.context.failureKinds.filter(isRedThenGreenFailureKind) : [];
}

/**
 * The one Bash call that returns `files` (repository-relative paths) to
 * `source`: restore what `source` has, delete what it lacks. A file the Task
 * created does not exist at the baseline, and `git restore` refuses the whole
 * call if one pathspec matches nothing, so each file is decided on its own.
 *
 * "Absent at `source`" is only ever concluded after the command has proved
 * where it stands: it runs in a subshell from `repositoryRoot` (the paths are
 * root-relative whatever the agent's cwd), and it verifies that `source`
 * names a commit (`^0`) before touching any file. A wrong or unknown
 * `source`, or a root that is no repository, therefore stops the call before
 * the loop, so `git cat-file` cannot misreport every file as absent and
 * nothing is deleted. A failed restore stops the loop too. The root and the
 * paths are shell-quoted literals: a command substitution such as
 * `$(git rev-parse --show-toplevel)` is opaque to the state-file guard, which
 * must assume it could name guarded state and refuses the call (#118).
 */
export function baselineRestoreCommand(source: string, files: readonly string[], repositoryRoot: string): string {
  return `(cd ${quoteShellArgument(repositoryRoot)} && git rev-parse --verify --quiet ${source}^0 && ` +
    `for f in ${files.map(quoteShellArgument).join(" ")}; do ` +
    `if git cat-file -e ${source}:"$f"; then git restore --source ${source} -- "$f" || exit 1; else rm -f -- "$f"; fi; done)`;
}

/**
 * The repair a retry owes after an I6 failure (AD-7). I6 is judged per
 * attempt epoch and the order lies in the past, so a retry that keeps its
 * predecessor's implementation can never show red: it restores the Task's
 * implementation files to the attempt baseline (`baselineRestoreCommand`, a
 * Bash call, which mints no FileWrite), observes red, and only then
 * implements. A Task populated without a start commit restores from HEAD: the
 * command stays runnable, and the brief says which uncommitted work that
 * discards.
 */
function redThenGreenRemedy(
  task: Task,
  classification: TestFileClassification,
  failures: readonly RedThenGreenFailureKind[],
  repositoryRoot: string,
): readonly string[] {
  if (failures.length === 0) return [];
  const source = task.start_sha ?? "HEAD";
  const baseline = task.start_sha === undefined
    ? "No start commit was recorded for this Task, so `HEAD` stands in: the restore discards your files' uncommitted changes since the last commit. "
    : "";
  return [
    "",
    `**I6 repair for this retry.** The previous attempt failed I6 (${failures.map((kind) => `\`${kind}\``).join(", ")}). ` +
      "This attempt is judged on its own ledger epoch, so it must show the order afresh:",
    classification.implementationFiles.length === 0
      ? "1. Your file list declares no implementation file to restore; skip to step 2."
      : `1. Return your implementation files to the attempt baseline with one Bash call: \`${baselineRestoreCommand(source, classification.implementationFiles, repositoryRoot)}\`. ` +
        `It runs from the repository root, first checks that \`${source}\` is a commit (if it is not, the call fails and changes nothing), then restores each file \`${source}\` has and deletes each one your Task created since; \`git cat-file\` reports every created file as missing, which is expected. ` +
        baseline +
        "Neither the restore nor the delete mints a FileWrite, so neither is your first implementation write. Touch only these files: they are yours, and no sibling's work lives in them. " +
        "This exact command is the one exception to the Constraints' never-`git restore` rule: it restores only your own files. Run it as given; do not rewrite it.",
    `2. Run your tests and observe red: ${TESTCASE_RED}${createdFilesRed(classification.createdImplementationFiles)}`,
    "3. Then implement, and run your tests green.",
  ];
}

/** What red is for every Task (FR-007), stated once for both red steps. */
const TESTCASE_RED = "at least one testcase in one of your test files fails.";

/**
 * The FR-007a sentence for a Task that creates implementation files, appended
 * to each statement of the red step; empty for a Task that creates none, which
 * keeps strict FR-007.
 */
function createdFilesRed(created: readonly string[]): string {
  if (created.length === 0) return "";
  const them = created.length === 1 ? "it" : "them";
  return ` Your Task creates ${created.map((file) => `\`${file}\``).join(", ")}: before you write ${them}, ` +
    `your tests failing to load ${them} (a collection or import error in one of your test files) IS red.`;
}

/** Why a brief cannot state I6: the duty's own named disagreement. */
type RedThenGreenSectionRefusal = Readonly<{
  kind: Extract<ImplementationBriefError["kind"], "test-file-classification-unavailable" | "red-then-green-proof-unfrozen">;
  message: string;
}>;

/**
 * The I6 section for a Task whose `redThenGreenDuty` is `owed` (AD-7): its
 * test and implementation files under the frozen classification the duty
 * carries (INV-2), the required order, what counts as a run, and — on a retry
 * after an I6 failure — the repair. Null for a Task that owes no I6; each
 * named disagreement refuses the brief instead of omitting the section.
 */
function redThenGreenSection(
  task: Task,
  dispatch: WaveImplementationDispatch,
  manifest: FrozenVerificationManifest | undefined,
  repositoryRoot: string,
): DomainResult<string | null, RedThenGreenSectionRefusal> {
  const duty = redThenGreenDuty(task, manifest);
  switch (duty.kind) {
    case "not-owed":
      return { ok: true, value: null };
    case "classification-unfrozen":
      return { ok: false, error: { kind: "test-file-classification-unavailable", message: `${duty.reason}, so the brief cannot name its test files` } };
    case "proof-unfrozen":
      return { ok: false, error: { kind: "red-then-green-proof-unfrozen", message: duty.reason } };
    case "owed":
      break;
  }
  const classification = classifyTaskFiles(task.file_list ?? [], duty.testFiles, task.artifact_baseline);
  const created = classification.createdImplementationFiles;
  return {
    ok: true,
    value: [
      "**I6 red-then-green — BINDING for this Task.** Settlement proves this Task test-first from your attempt's evidence ledger, and only from it, in this order:",
      `1. **Red.** A trusted test run in which ${TESTCASE_RED}` +
        (created.length === 0 ? " A collection or import error with no failing testcase is not red." : createdFilesRed(created)),
      "2. **First implementation write.** Your first write to any implementation file below, by a file tool or a shell command (a baseline restore of your own files via `git restore` mints no FileWrite and is exempt). Fixtures, helpers and type files count; writing a test file never does.",
      "3. **Green.** A later trusted run that exits 0 in which every one of your test files runs at least one testcase and none fails or fails to collect.",
      "",
      "Test files:",
      bulleted(classification.testFiles, "None — your file list matches no test file, so I6 fails with `no-test-files`; report it instead of finishing."),
      "",
      "Implementation files:",
      bulleted(classification.implementationFiles, "None."),
      "",
      "Only ledger runs with an exit code and a parsed structured report count, under every evaluation policy: a run without its report, a chained, piped or redirected run, and transcript test evidence never satisfy a step. " +
        "Run each step's tests as one bare report-writing command, in the forms the final verification table at the top of this brief lists. " +
        "I6 is judged per attempt: an earlier attempt's red never counts for this one.",
      ...redThenGreenRemedy(task, classification, inheritedRedThenGreenFailures(task, dispatch), repositoryRoot),
    ].join("\n"),
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

  const redThenGreen = redThenGreenSection(task, dispatch, input.verificationManifest, input.repositoryRoot);
  if (!redThenGreen.ok) return refused(redThenGreen.error.kind, redThenGreen.error.message);

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
      ...(redThenGreen.value === null ? [] : ["", redThenGreen.value]),
    ].join("\n"),
    implementation_retry_context: dispatch.promptAppendix ?? NO_RETRY_CONTEXT,
    operator_note: bulleted(input.operatorNotes, NO_OPERATOR_NOTE),
    task_description: task.description,
    spec_anchors_formatted: anchors.value,
    spec_contributions_formatted: contributions.value,
    scenario_test_names: scenarioTestNames(task.spec_anchors ?? [], index),
    plan_context: task.plan_context?.trim() || "None recorded for this Task; read the full plan.",
    invariant_ownership: invariantOwnership(
      task.file_list ?? [],
      input.invariants,
      obligationsTouchedBy(input.ownerScope, task.file_list ?? []),
    ),
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
 * The dispatch marker: a spawn whose task is `LOOM_IMPLEMENTATION_BRIEF: T5`
 * asks Loom (the Pi extension, or the Claude Code spawn gate) to substitute the
 * engine-rendered brief before any spawn gate reads the prompt, so the
 * orchestrating model never copies the brief into a tool call.
 */
export const IMPLEMENTATION_BRIEF_MARKER = "LOOM_IMPLEMENTATION_BRIEF";

/**
 * The operator channel beside the marker (#119): each following
 * `LOOM_OPERATOR_NOTE: <text>` line becomes an item of the brief's
 * Operator Note section. The marker must otherwise be the whole prompt, so an
 * operator line typed any other way is refused with this channel's grammar
 * instead of reaching the gates as a hand-written prompt.
 */
export const IMPLEMENTATION_BRIEF_OPERATOR_NOTE = "LOOM_OPERATOR_NOTE";

/** The bounds the Operator Note section keeps: guidance, not a second brief. */
export const MAX_OPERATOR_NOTES = 8;
export const MAX_OPERATOR_NOTE_LENGTH = 500;

/** Literal substituted for `{operator_note}` when the marker carries no note. */
export const NO_OPERATOR_NOTE = "None — no operator note.";

/** One admitted operator note: only `parseOperatorNote` makes one. */
export type OperatorNote = string & { readonly __brand: "OperatorNote" };

/** A parsed dispatch marker: the Task to expand and the operator's notes for it. */
export type ImplementationBriefRequest = Readonly<{ taskId: string; operatorNotes: readonly OperatorNote[] }>;

export type ImplementationBriefRequestParse =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "request"; request: ImplementationBriefRequest }>
  | Readonly<{ kind: "malformed"; reason: string }>;

const MARKER_LINE = new RegExp(`^${IMPLEMENTATION_BRIEF_MARKER}: (T\\d+)$`);
const NOTE_LINE = new RegExp(`^${IMPLEMENTATION_BRIEF_OPERATOR_NOTE}:(.*)$`);
/** A note may not pass for engine authority or for a template variable. */
const LOOM_TOKEN = /\bLOOM_[A-Z_]+/;
const TASK_ID_BINDING = /task id:/i;

/**
 * One note's text, or why it is refused: non-empty, at most
 * `MAX_OPERATOR_NOTE_LENGTH` characters, and nothing the gates read as engine
 * authority. A `LOOM_*` token could pass for a request or retry marker, a
 * `{variable}` would fail the brief as an unsubstituted template variable, and
 * a `Task ID:` could rebind the brief.
 */
export function parseOperatorNote(raw: string): DomainResult<OperatorNote, string> {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "an operator note is empty" };
  // One note is one marker line: a line break would split it on render, and
  // the second half would come back as a malformed line.
  if (/[\r\n]/.test(text)) return { ok: false, error: "an operator note must be one line" };
  if (text.length > MAX_OPERATOR_NOTE_LENGTH) {
    return { ok: false, error: `an operator note is ${text.length} characters; at most ${MAX_OPERATOR_NOTE_LENGTH} are allowed` };
  }
  if (LOOM_TOKEN.test(text)) return { ok: false, error: `an operator note may not carry a LOOM_ token: ${JSON.stringify(text)}` };
  if (findResidualPlaceholders(text).length > 0) {
    return { ok: false, error: `an operator note may not carry a {template variable}: ${JSON.stringify(text)}` };
  }
  if (TASK_ID_BINDING.test(text)) return { ok: false, error: `an operator note may not carry a Task ID binding: ${JSON.stringify(text)}` };
  return { ok: true, value: text as OperatorNote };
}

/**
 * What a spawn's task text asks for. `none`: no marker line, so it is an
 * ordinary prompt. `request`: the marker on the first line, followed only by
 * blank lines and at most `MAX_OPERATOR_NOTES` admitted note lines.
 * `malformed`: a marker anywhere else, a second marker, or any other line,
 * named with the channel's grammar.
 */
export function parseImplementationBriefRequest(task: string): ImplementationBriefRequestParse {
  const lines = task.trim().split("\n").map((line) => line.trim());
  const markers = lines.flatMap((line, index) => {
    const taskId = MARKER_LINE.exec(line)?.[1];
    return taskId === undefined ? [] : [{ index, taskId }];
  });
  const [marker, ...otherMarkers] = markers;
  if (marker === undefined) return { kind: "none" };
  const grammar = `the brief marker must be the first line, followed only by "${IMPLEMENTATION_BRIEF_OPERATOR_NOTE}: <text>" lines`;
  if (otherMarkers.length > 0 || marker.index !== 0) return { kind: "malformed", reason: `${grammar}; this prompt has the marker elsewhere or more than once` };
  const { taskId } = marker;
  const notes: OperatorNote[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line === "") continue;
    const text = NOTE_LINE.exec(line)?.[1];
    if (text === undefined) return { kind: "malformed", reason: `${grammar}; line ${index + 1} is neither: ${JSON.stringify(line.slice(0, 80))}` };
    const note = parseOperatorNote(text);
    if (!note.ok) return { kind: "malformed", reason: `line ${index + 1}: ${note.error}` };
    notes.push(note.value);
  }
  if (notes.length > MAX_OPERATOR_NOTES) {
    return { kind: "malformed", reason: `the brief marker carries ${notes.length} operator notes; at most ${MAX_OPERATOR_NOTES} are allowed` };
  }
  return { kind: "request", request: Object.freeze({ taskId, operatorNotes: Object.freeze(notes) }) };
}

/** Port: render the brief a marker requests against the governing TaskGraph. */
export type RenderTaskBrief = (request: ImplementationBriefRequest) => DomainResult<ImplementationBrief, string>;

/**
 * What one spawn's task text asks for, decided once for both harnesses:
 * nothing (`none`), a refusal of the marker's grammar (`malformed`), a marker
 * whose brief cannot render (`unrenderable`), or the rendered brief. Each
 * harness maps it to its own wire shape and wording, and checks the spawned
 * agent against `brief.agent` in its own field.
 */
export type BriefMarkerTriage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "malformed"; reason: string }>
  | Readonly<{ kind: "unrenderable"; taskId: string; error: string }>
  | Readonly<{ kind: "expanded"; request: ImplementationBriefRequest; brief: ImplementationBrief }>;

/** Triage `task` and render the brief it requests. Pure over `render`, which runs only for a well-formed marker. */
export function triageBriefMarker(task: string, render: RenderTaskBrief): BriefMarkerTriage {
  const parsed = parseImplementationBriefRequest(task);
  if (parsed.kind !== "request") return parsed;
  const rendered = render(parsed.request);
  return rendered.ok
    ? { kind: "expanded", request: parsed.request, brief: rendered.value }
    : { kind: "unrenderable", taskId: parsed.request.taskId, error: rendered.error };
}

/** The spawn task text for `request`: the marker, then one line per note. The inverse of `parseImplementationBriefRequest`. */
export function renderImplementationBriefRequest(request: ImplementationBriefRequest): string {
  return [
    `${IMPLEMENTATION_BRIEF_MARKER}: ${request.taskId}`,
    ...request.operatorNotes.map((note) => `${IMPLEMENTATION_BRIEF_OPERATOR_NOTE}: ${note}`),
  ].join("\n");
}
