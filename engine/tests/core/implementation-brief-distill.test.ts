/**
 * The implementation brief of a Distill Task (ADR-0068 §8), read as its agent
 * reads it: the distill appendix is there byte for byte, the waiver that
 * carries its test requirement is explained, and no section tells it to
 * implement, write tests, fill a skeleton or own an Invariant family.
 *
 * It also pins the Task mutation check's section (ADR-0071): an implementer's
 * brief carries it exactly when the Task owes the check, and a Distill Task's
 * never does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { distillPromptAppendix } from "../../src/core/distill-task";
import {
  NO_ACCEPTANCE_CONTRACT,
  NO_INVARIANT_OWNERSHIP,
  NO_RETRY_CONTEXT,
  NO_SCENARIO_TEST_NAMES,
  PLAN_BINDINGS_AGREE,
  renderImplementationBrief,
  RULE_DOCUMENTS,
  triageBriefMarker,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import { DECISION_RECORD_AGENT, DISTILL_AGENT } from "../../src/core/model-profiles";
import { NO_PREDECESSORS } from "../../src/core/predecessor-output";
import { TASK_MUTATION_BASH_TIMEOUT_MS } from "../../src/core/task-mutation-check";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { validateTemplateSubstitution } from "../../src/core/validate-template-substitution";
import { IMPLEMENTATION_BRIEF_TEMPLATE, renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import type { Task, TaskGraph } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { digest } from "../fixtures/acceptance-fixtures";
import { unobservedSkeletons } from "../fixtures/frozen-signatures";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { briefOwnership, ownerObligation, planOwnership } from "../fixtures/owner-obligation";
import { binding, frozenManifestWith } from "../fixtures/skeleton-builders";
import { cleanupSkeletonRepos, PATHS, skeletonRepo } from "../fixtures/skeleton-repo";
import { distillTaskFixture, graphFixture, taskFixture, type TaskFixtureInput } from "../fixtures/task-lifecycle";
import { mutationManifest } from "../fixtures/task-mutation";

const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
  [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

const OWNER = "src/order/pricing.ts";
const SIBLING = "src/order/quotes.ts";
const SCOPE = [OWNER, SIBLING] as const;

const implementer = (id: string, file: string, overrides: Partial<TaskFixtureInput> = {}): Task => taskFixture({
  id, description: `Implement ${file}`, agent: "code-implementer-agent", wave: 2, depends_on: [], status: "implemented",
  file_list: [file], files_modified: [file], ...overrides,
});

const PASS = distillTaskFixture({
  id: "T9",
  wave: 2,
  scope: SCOPE,
  description: "Distill pass for Wave 2: behaviour-preserving simplification of the code T5, T6 implemented, with the distill skill in apply mode. Changing nothing is an acceptable result.",
});
const ROSTER: readonly Task[] = [implementer("T5", OWNER), implementer("T6", SIBLING), PASS];

const render = (task: Task, overrides: Partial<ImplementationBriefInput> = {}): string => {
  const derivation = deriveTaskImplementationDispatch(task);
  if (derivation.kind !== "dispatch") throw new Error(`fixture Task must be owed a dispatch, got ${derivation.kind}`);
  const rendered = renderImplementationBrief({
    template: TEMPLATE,
    task,
    dispatch: derivation.dispatch,
    // An I6-era graph: the frozen classification that gives the Wave its Distill Task.
    verificationManifest: frozenManifestWith([".test.ts"]),
    planFile: "/repo/.claude/plans/plan.md",
    spec: { kind: "unavailable", reason: { kind: "no-spec-file" } },
    rules: RULES,
    roster: ROSTER,
    ownership: planOwnership(),
    contracts: [],
    repositoryRoot: "/repo",
    commands: loomCommandsAt("/loom"),
    operatorNotes: [],
    frozenSignatures: unobservedSkeletons(graphFixture(ROSTER)),
    ...overrides,
  });
  if (!rendered.ok) throw new Error(rendered.error.message);
  return rendered.value.prompt;
};

const section = (prompt: string, heading: string): string =>
  prompt.split(`## ${heading}\n\n`)[1]?.split(/\n\n## /)[0] ?? "";

describe("a Distill Task's implementation brief (ADR-0068 §8)", () => {
  const prompt = render(PASS);

  it("names the distill agent, its catalog Skill and no dependency", () => {
    expect(prompt).toContain(`**Task ID:** T9\n**Wave:** 2\n**Agent:** ${DISTILL_AGENT}\n**Required Loom skill:** distill\n**Dependencies:** none`);
    expect(section(prompt, "What Your Dependencies Produced")).toContain(NO_PREDECESSORS);
  });

  it("carries the dispatch's distill appendix in place of the attempt-1 literal", () => {
    const context = section(prompt, "Engine-Issued Implementation Retry Context");
    // The section's value is everything before the template's own explanation of it.
    const [value, ...explanation] = context.split("\n\nWhen this is an exact");
    expect(value).toBe(distillPromptAppendix(PASS));
    expect(value).not.toContain(NO_RETRY_CONTEXT);
    expect(explanation.join("")).toContain("The appendix then replaces \"Required Workflow\" below");
  });

  it("is admitted by the spawn gate and carries no unsubstituted variable", () => {
    expect(authorizeImplementationSpawn(PASS, prompt)).toMatchObject({ ok: true, kind: "initial", taskId: "T9" });
    expect(validateTemplateSubstitution(prompt, true)).toEqual({ kind: "allow" });
  });

  it("explains the distill-pass waiver as a test requirement, not an exemption", () => {
    const policy = section(prompt, "Verification Policy");
    expect(policy).toContain("- regression: waived (distill-pass)\n- new_tests: waived (distill-pass)");
    expect(policy).toContain("**`distill-pass` is not a licence to skip your test runs.**");
    expect(policy).toContain("`behaviour-preserved`");
    expect(policy).toContain("it owes a trusted passing run after your last edit");
    // The mandatory-final-step lead no longer reads the waiver as a skip.
    expect(prompt).toContain("typed regression waiver other than `distill-pass`");
  });

  it("owes no red-then-green section, scenario test name, claim or contract role", () => {
    expect(prompt).not.toContain("I6 red-then-green");
    expect(section(prompt, "Acceptance Scenario Test Names")).toBe(NO_SCENARIO_TEST_NAMES);
    expect(section(prompt, "Requirement Completion Claims (MUST fully satisfy in this Wave)")).toContain("None.");
    expect(section(prompt, "Acceptance Contract — BINDING")).toContain(NO_ACCEPTANCE_CONTRACT);
    expect(section(prompt, "Invariant Ownership — BINDING")).toContain(NO_INVARIANT_OWNERSHIP);
  });

  it("lists exactly its scope and sends the workflow to the appendix", () => {
    expect(section(prompt, "Files to Create/Modify")).toBe(SCOPE.map((path) => `- ${path}`).join("\n"));
    expect(section(prompt, "Required Workflow").startsWith("A distill pass (a `LOOM_DISTILL_PASS: 1` appendix")).toBe(true);
  });

  it("keeps the retry context ahead of the appendix on semantic attempt 2", () => {
    const retrying: Task = {
      ...PASS,
      implementation_attempt_history: [semanticAttemptReceipt("T9", 1, [])],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    };
    const retried = render(retrying);
    const context = section(retried, "Engine-Issued Implementation Retry Context");
    expect(context).toMatch(/^LOOM_IMPLEMENTATION_RETRY_CONTEXT: \{/);
    expect(context).toContain(`\n${distillPromptAppendix(PASS)}\n\n`);
    expect(authorizeImplementationSpawn(retrying, retried)).toMatchObject({ ok: true, kind: "retry" });
  });

  it("leaves an implementer's brief as it was", () => {
    const pending = implementer("T5", OWNER, { status: "pending" });
    const implementerPrompt = render(pending);
    expect(section(implementerPrompt, "Engine-Issued Implementation Retry Context")).toContain(NO_RETRY_CONTEXT);
    expect(section(implementerPrompt, "Verification Policy")).not.toContain("distill-pass");
    expect(authorizeImplementationSpawn(pending, implementerPrompt)).toMatchObject({ ok: true });
  });
});

describe("brief marker expansion of a withheld Distill Task (renderTaskImplementationBrief)", () => {
  afterEach(cleanupSkeletonRepos);

  it("refuses the brief with the rule status and registration apply, naming the Tasks it waits for", () => {
    const repo = skeletonRepo();
    const scope = [PATHS.tsHelpers];
    repo.rewriteState((raw) => {
      const tasks: readonly unknown[] = Array.isArray(raw.tasks) ? raw.tasks : [];
      return {
        ...raw,
        tasks: [...tasks, distillTaskFixture({ id: "T20", wave: 2, scope })],
      };
    });
    const triage = triageBriefMarker("LOOM_IMPLEMENTATION_BRIEF: T20", (request) =>
      renderTaskImplementationBrief(repo.statePath, LOOM_PACKAGE_ROOT, request));
    expect(triage).toMatchObject({ kind: "unrenderable", taskId: "T20" });
    if (triage.kind !== "unrenderable") return;
    expect(triage.error).toMatch(/^T20 is its Wave's distill pass and runs after every other Task of the Wave is implemented; still outstanding: .*\bT4\b/);
  });
});

describe("a Distill Task's brief over an owned Invariant family", () => {
  const family = (mutation: Parameters<typeof ownerObligation>[0]["mutation"]) => ownerObligation({
    invariant: "INV-3",
    title: "Prices are computed once",
    statement: "Only the pricing module computes a price.",
    owner: OWNER,
    siblings: [{ path: SIBLING, note: "quotes" }],
    matrixTest: "tests/order/pricing.matrix.test.ts",
    mutation,
  });
  const ownership = (mutation: Parameters<typeof ownerObligation>[0]["mutation"]) =>
    section(render(PASS, { ownership: briefOwnership([family(mutation)], [], SCOPE) }), "Invariant Ownership — BINDING");

  it("tells it what a move must leave in place, not to implement the rule", () => {
    const text = ownership({ kind: "verify" });
    expect(text).toContain("**INV-3: Prices are computed once**");
    expect(text).toContain(`- Distill pass: your scope holds \`${OWNER}\`, \`${SIBLING}\`. Simplify in place.`);
    expect(text).toContain("is not a distill move.");
    expect(text).not.toContain("Implement the rule there");
    expect(text).not.toContain("- Owner: you change");
    expect(text).not.toContain("- Sibling: you change");
  });

  it("states Owner Verification as the Wave's duty that still judges its bytes", () => {
    const text = ownership({ kind: "verify" });
    expect(text).toContain("**Owner Verification (INV-3):** owed by this Wave's implementation Tasks, not by your pass.");
    expect(text).toContain(`every line you change in \`${OWNER}\` is one of the owner's lines changed in the Wave`);
    expect(text).not.toContain("**Owner duties");
  });

  it("states a declared mutation exemption instead", () => {
    const text = ownership({ kind: "exempt", reason: "the owner is a lookup table" });
    expect(text).toContain(`\`${OWNER}\` is not mutation-verified; the declared reason: the owner is a lookup table.`);
    expect(text).not.toContain("must be killed");
  });

  it("renders the same role from a plan's Invariants on a graph stamped before owner verification", () => {
    const text = section(render(PASS, {
      ownership: briefOwnership(undefined, [{
        id: family({ kind: "verify" }).invariant,
        title: "Prices are computed once",
        tier: { status: "ok", tier: "advisory" },
        ruleFile: null,
        statement: "Only the pricing module computes a price.",
        ownership: {
          kind: "owned", owner: OWNER, siblings: [{ path: SIBLING, note: "quotes" }],
          matrixTest: "tests/order/pricing.matrix.test.ts", mutation: { kind: "verify" },
        },
      }], SCOPE),
    }), "Invariant Ownership — BINDING");
    expect(text).toContain("- Distill pass: your scope holds");
    expect(text).not.toContain("Owner Verification (INV-3)");
  });
});

describe("a Distill Task's brief over bound exports and a red window", () => {
  const TYPES = "src/order/order-contract.ts";
  const ACCEPTANCE = "tests/order/order.acceptance.test.ts";
  const CONTRACT: AcceptanceContract = {
    schemaVersion: 1,
    id: "CT-1",
    title: "Order pricing contract",
    statement: "Orders are priced from the frozen types.",
    contractTask: "T1",
    types: { kind: "file", path: TYPES },
    acceptance: [{ path: ACCEPTANCE, anchors: ["FR-001"] }],
    supportedDomain: null,
    freeze: {
      state: "frozen",
      wave: 1,
      paths: [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("b") }],
      roster: [{ file: ACCEPTANCE, name: "FR-001: prices", anchors: ["FR-001"] }],
    },
    revisions: [],
  };
  const contractTask = taskFixture({
    id: "T1", description: "Write CT-1", agent: "code-implementer-agent", wave: 1, depends_on: [], status: "completed",
    file_list: [TYPES, ACCEPTANCE], files_modified: [TYPES, ACCEPTANCE],
  });
  // T7 completes FR-001 in Wave 3, so Wave 2 runs inside CT-1's red window.
  const laterClaimant = implementer("T7", "src/order/late.ts", { wave: 3, status: "pending", spec_anchors: ["FR-001"], depends_on: ["T1"] });
  const roster: readonly Task[] = [contractTask, ...ROSTER, laterClaimant];
  const graph: TaskGraph = {
    ...graphFixture(roster),
    current_wave: 2,
    acceptance_contracts: [CONTRACT],
    export_bindings: [binding(OWNER, "CT-1", ["priceOrder", "PriceOrderFn"])],
    skeletons: [],
    verification_manifest: frozenManifestWith([".test.ts"]),
  };
  const prompt = render(PASS, {
    roster,
    contracts: [CONTRACT],
    frozenSignatures: {
      graph,
      observations: new Map([
        [OWNER, { kind: "present", sha256: digest("c"), canonicalSha256: null }],
        [SIBLING, { kind: "present", sha256: digest("d"), canonicalSha256: null }],
      ]),
      surfaces: new Map([["CT-1", { ok: true, value: { language: "typescript", path: TYPES, aliases: [], adts: [{ kind: "brand", name: "OrderId" }] } }]]),
      unresolved: [],
      planBindings: PLAN_BINDINGS_AGREE,
    },
  });

  it("shows the bound exports as frozen signatures of bodies others already wrote", () => {
    const frozen = section(prompt, "Frozen Signatures — BINDING");
    expect(frozen.startsWith("Each production file in your scope, with its skeleton outcome and the exports bound to it.")).toBe(true);
    expect(frozen).toContain(`- \`${OWNER}\` — exists, not skeletonized\n  - \`priceOrder: PriceOrderFn\` (CT-1)`);
    expect(frozen).toContain("simplify a body, never its signature");
    expect(frozen).toContain("the engine then restores your edits");
    expect(frozen).toContain("**Frozen ADTs of CT-1**");
    expect(frozen).not.toContain("replace every body");
    expect(frozen).not.toContain("writes each missing bound skeleton");
    expect(frozen).not.toContain("Each production file you own");
    expect(prompt).not.toContain("A skeleton is yours to fill");
  });

  it("tells it to keep the pending acceptance testcases out of its own final run", () => {
    const contract = section(prompt, "Acceptance Contract — BINDING");
    expect(contract).toContain(`**CT-1: Order pricing contract** — its acceptance testcases in \`${ACCEPTANCE}\` may still fail`);
    expect(contract).toContain("Your pass is judged by your own final run");
    expect(contract).toContain("Run the tests that cover your files without these acceptance files.");
    expect(contract).not.toContain("Failures anywhere else are yours to fix");
    expect(contract).not.toContain("you are its contract Task");
    expect(contract).not.toContain("Turn these acceptance testcases green");
  });
});

describe("the Task mutation check in a brief (ADR-0071)", () => {
  const HEADING = "**Task mutation check.**";
  const pending = (overrides: Partial<TaskFixtureInput> = {}): Task =>
    implementer("T5", OWNER, { status: "pending", file_list: [OWNER, "src/order/pricing.test.ts", "docs/pricing.md"], ...overrides });
  const policy = (task: Task, overrides: Partial<ImplementationBriefInput> = {}): string =>
    section(render(task, { verificationManifest: mutationManifest(), ...overrides }), "Verification Policy");

  it("tells an implementer that owes it the one command, its timeout, and the files it mutates", () => {
    const text = policy(pending());
    expect(text).toContain(`${HEADING} Once your tests pass and before your final verification run, run this as one Bash call with a timeout of ${TASK_MUTATION_BASH_TIMEOUT_MS} ms:`);
    expect(text).toContain(`\n\`${loomCommandsAt("/loom").mutationCheck("T5")}\`\n`);
    expect(text).toContain("at most 8 mutants");
    expect(text).toContain("an equivalent mutant");
    expect(text).toContain("makes the result stale, so run it after your last edit");
    expect(text).toContain("at most 2 times");
    expect(text).toContain("so your final verification run still follows it");
    // Only the implementation file: the Task's test and its document are digested, never mutated.
    expect(text).toMatch(/Files it mutates:\n- src\/order\/pricing\.ts(?!\n- )/);
  });

  it("keeps an owing implementer's brief admissible to the spawn gate", () => {
    const task = pending();
    const prompt = render(task, { verificationManifest: mutationManifest() });
    expect(authorizeImplementationSpawn(task, prompt)).toMatchObject({ ok: true });
    expect(validateTemplateSubstitution(prompt, true)).toEqual({ kind: "allow" });
  });

  it.each<[string, Task, Partial<ImplementationBriefInput>]>([
    ["a Distill Task", PASS, {}],
    ["an ADR Task", pending({ agent: DECISION_RECORD_AGENT, file_list: ["docs/adr/ADR-0001-pricing.md"] }), {}],
    ["a Task with no TypeScript or JavaScript implementation file", pending({ file_list: ["src/order/Pricing.java"] }), {}],
    ["a manifest that switches the check off", pending(), { verificationManifest: mutationManifest({ taskMutationCheck: "off" }) }],
    ["a manifest with no affected runner", pending(), { verificationManifest: mutationManifest({ affectedRunner: undefined }) }],
  ])("says nothing of the check to %s", (_label, task, overrides) => {
    expect(render(task, { verificationManifest: mutationManifest(), ...overrides })).not.toContain(HEADING);
  });
});
