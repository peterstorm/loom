import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import {
  NO_EXPORT_BINDING_STAMP,
  contractStubAuthor,
  PLAN_BINDINGS_AGREE,
  renderFrozenSignatures,
  triageBriefMarker,
  type FrozenSignaturesInput,
  NO_ACCEPTANCE_CONTRACT,
  NO_CODE_RULES,
  NO_INVARIANT_OWNERSHIP,
  NO_RETRY_CONTEXT,
  NO_OPERATOR_NOTE,
  NO_SCENARIO_TEST_NAMES,
  MAX_OPERATOR_NOTE_LENGTH,
  MAX_OPERATOR_NOTES,
  parseImplementationBriefRequest,
  parseOperatorNote,
  renderImplementationBrief,
  renderImplementationBriefRequest,
  ruleDocumentsFor,
  RULE_DOCUMENTS,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import { NO_PREDECESSORS } from "../../src/core/predecessor-output";
import { parseSpec } from "../../src/core/parse-spec";
import { digest } from "../fixtures/acceptance-fixtures";
import type { SpecIndexAvailability } from "../../src/core/requirement-coverage";
import { validateTemplateSubstitution } from "../../src/core/validate-template-substitution";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import type { DomainResult } from "../../src/core/orchestration-contract";
import type { UnresolvedSkeletonBinding } from "../../src/core/skeleton/status";
import type { ExportBinding, FrozenSurface, PathObservation, SkeletonRecord } from "../../src/core/skeleton/types";
import type { PlanInvariant, Task, TaskGraph, WaveImplementationDispatch } from "../../src/types";
import { extractTaskId } from "../../src/utils/extract-task-id";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { parseTaskGraph } from "../../src/state-manager";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { binding } from "../fixtures/skeleton-builders";
import { cleanupSkeletonRepos, PATHS, skeletonRepo, TS_CONTRACT, TS_TYPES_TEXT, type SkeletonRepo } from "../fixtures/skeleton-repo";
import { IMPLEMENTATION_BRIEF_TEMPLATE, NO_PLAN_TO_CHECK, renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import { stubbedContracts } from "../../src/orchestration/contract-stub-materialization";
import { unobservedSkeletons } from "../fixtures/frozen-signatures";
import { admittedNote } from "../fixtures/operator-note";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { invariantId, planOwnership } from "../fixtures/owner-obligation";

const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
  [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

const parsed = parseSpec([
  "# Feature: Brief fixture",
  "",
  "## User Scenarios",
  "",
  "### US1: [P1] Render a brief",
  "",
  "**Acceptance Scenarios:**",
  "- AS-001: Given an owed dispatch, When the brief renders, Then the gates admit it",
  "",
  "## Functional Requirements",
  "",
  "- FR-001: System MUST render implementation briefs from protected authority",
  "- FR-002: System MUST refuse briefs the spawn gate would refuse",
  "",
  "## Out of Scope",
  "",
  "- OOS-001: Rewriting the template",
  "",
  "## Appendix: Glossary",
  "",
  "| Term | Definition |",
  "|------|------------|",
  "| Brief | The prompt one implementation dispatch gives its child |",
  "",
].join("\n"));
if (!parsed.ok) throw new Error("spec fixture must parse");
const SPEC: SpecIndexAvailability = {
  kind: "indexed",
  path: "/repo/.claude/specs/brief/spec.md",
  contentDigest: digest("a"),
  index: parsed.value,
};
const NO_SPEC_FILE: SpecIndexAvailability = { kind: "unavailable", reason: { kind: "no-spec-file" } };

const task = (overrides: Partial<Parameters<typeof taskFixture>[0]> = {}): Task => taskFixture({
  id: "T5",
  description: "Render briefs in the engine",
  agent: "code-implementer-agent",
  wave: 2,
  depends_on: ["T3", "T4"],
  file_list: ["engine/src/core/implementation-brief.ts", "engine/tests/core/implementation-brief.test.ts"],
  spec_anchors: ["FR-001", "AS-001"],
  spec_contributions: ["FR-002"],
  plan_context: "AD-1: render from protected authority.",
  ...overrides,
});

const dispatchFor = (value: Task): WaveImplementationDispatch => {
  const derivation = deriveTaskImplementationDispatch(value);
  if (derivation.kind !== "dispatch") throw new Error(`fixture Task must be owed a dispatch, got ${derivation.kind}`);
  return derivation.dispatch;
};

const completedDependency = (id: string): Task => taskFixture({
  id,
  description: `Build the ${id} seam`,
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: [],
  status: "completed",
  file_list: [`engine/src/${id}.ts`],
  files_modified: [`engine/src/${id}.ts`],
  spec_anchors: [],
});
const ROSTER: readonly Task[] = [completedDependency("T3"), completedDependency("T4")];

const input = (value: Task, overrides: Partial<ImplementationBriefInput> = {}): ImplementationBriefInput => ({
  template: TEMPLATE,
  task: value,
  dispatch: dispatchFor(value),
  // These Tasks owe no red-then-green, so no frozen classification is needed.
  verificationManifest: undefined,
  planFile: "/repo/.claude/plans/plan.md",
  spec: SPEC,
  rules: RULES,
  roster: ROSTER,
  ownership: planOwnership(),
  contracts: [],
  repositoryRoot: "/repo",
  operatorNotes: [],
  frozenSignatures: unobservedSkeletons(graphFixture(ROSTER)),
  ...overrides,
});

const PROBE_FAMILY: PlanInvariant = {
  id: invariantId("INV-3"),
  title: "Path probes fail closed",
  tier: { status: "ok", tier: "advisory" },
  ruleFile: null,
  statement: "Only ENOENT proves a path absent.",
  ownership: {
    kind: "owned",
    owner: "engine/src/utils/path-presence.ts",
    siblings: [{ path: "engine/src/utils/route-endpoint.ts", note: "models.json" }, { path: "engine/src/config.ts", note: null }],
    matrixTest: "engine/tests/utils/path-presence.matrix.test.ts",
    mutation: { kind: "verify" },
  },
};

const ownershipSection = (prompt: string): string =>
  prompt.split("## Invariant Ownership — BINDING\n\n")[1]?.split("\n\nThe engine derives this section")[0] ?? "";

const contractSection = (prompt: string): string =>
  prompt.split("## Acceptance Contract — BINDING\n\n")[1]?.split("\n\nThe engine derives this section")[0] ?? "";

const CONTRACT: AcceptanceContract = {
  schemaVersion: 1,
  id: "CT-1",
  title: "Brief rendering contract",
  statement: "A rendered brief is admissible by construction.",
  contractTask: "T3",
  types: { kind: "file", path: "engine/src/core/brief-contract.ts" },
  acceptance: [{ path: "engine/tests/acceptance/brief.acceptance.test.ts", anchors: ["FR-001", "AS-001"] }],
  supportedDomain: "engine/tests/acceptance/brief.acceptance.test.ts",
  freeze: { state: "awaiting-red" },
  revisions: [],
};
const FROZEN_CONTRACT: AcceptanceContract = {
  ...CONTRACT,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [
      { path: "engine/src/core/brief-contract.ts", sha256: digest("a") },
      { path: "engine/tests/acceptance/brief.acceptance.test.ts", sha256: digest("b") },
    ],
    roster: [
      { file: "engine/tests/acceptance/brief.acceptance.test.ts", name: "brief > FR-001: renders", anchors: ["FR-001"] },
      { file: "engine/tests/acceptance/brief.acceptance.test.ts", name: "brief > AS-001: admitted", anchors: ["AS-001"] },
    ],
  },
};

describe("ruleDocumentsFor", () => {
  it.each<[string, readonly string[], readonly RuleDocument[]]>([
    ["TypeScript", ["src/a.ts", "src/b.tsx"], ["architecture.md", "typescript-patterns.md"]],
    ["Java", ["src/Main.java"], ["architecture.md", "java-patterns.md", "property-testing.md"]],
    ["Rust", ["src/lib.rs"], ["architecture.md", "rust-patterns.md"]],
    ["a mixed stack, in rule order", ["src/lib.rs", "web/a.ts"], ["architecture.md", "typescript-patterns.md", "rust-patterns.md"]],
    ["documentation only", ["docs/adr/0011-x.md", "README.md"], []],
    ["no declared artifacts", [], []],
  ])("selects %s", (_name, files, expected) => {
    expect(ruleDocumentsFor(files)).toEqual(expected);
  });
});

describe("renderImplementationBrief", () => {
  it("renders an initial brief the real spawn gates admit", () => {
    const value = task();
    const rendered = renderImplementationBrief(input(value));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const { prompt } = rendered.value;
    expect(prompt).toContain("**Task ID:** T5\n**Wave:** 2\n**Agent:** code-implementer-agent\n**Required Loom skill:** code-implementer\n**Dependencies:** T3, T4");
    expect(prompt).toContain(RULES.get("architecture.md")!.trimEnd());
    expect(prompt).toContain(RULES.get("typescript-patterns.md")!.trimEnd());
    expect(prompt).not.toContain(RULES.get("java-patterns.md")!.trimEnd());
    expect(prompt).toContain("- **FR-001** — System MUST render implementation briefs from protected authority");
    expect(prompt).toContain("- **AS-001** — Given an owed dispatch");
    expect(prompt).toContain("- **FR-002** — System MUST refuse briefs");
    expect(prompt).toContain("- regression: required\n- new_tests: required");
    expect(prompt).toContain(`## Engine-Issued Implementation Retry Context\n\n${NO_RETRY_CONTEXT}\n\n`);
    expect(prompt).toContain(`## Operator Note\n\n${NO_OPERATOR_NOTE}\n\n`);
    expect(prompt).toContain("- engine/src/core/implementation-brief.ts\n- engine/tests/core/implementation-brief.test.ts");
    expect(prompt).toContain("Available at: /repo/.claude/plans/plan.md");
    // The harness gates, exactly as they judge a spawn prompt.
    expect(validateTemplateSubstitution(prompt, true)).toEqual({ kind: "allow" });
    expect(extractTaskId(prompt)).toBe("T5");
    expect(authorizeImplementationSpawn(value, prompt)).toMatchObject({ ok: true, kind: "initial" });
  });

  it("carries the exact attempt-2 appendix the spawn gate authorizes", () => {
    const retry = semanticAttemptReceipt("T5", 1, []);
    const value: Task = {
      ...task({ status: "pending" }),
      implementation_attempt_history: [retry],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
      failure_reason: `retry-required: ${retry.failureKinds.join(", ")}`,
      retry_count: 1,
    } as Task;
    const dispatch = dispatchFor(value);
    expect(dispatch.kind).toBe("retry-implementation");

    const rendered = renderImplementationBrief(input(value, { dispatch }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain(`## Engine-Issued Implementation Retry Context\n\n${dispatch.promptAppendix}\n\n`);
    expect(authorizeImplementationSpawn(value, rendered.value.prompt)).toMatchObject({ ok: true, kind: "retry" });
    // Discriminating control: the hand-assembly mistake of keeping the
    // attempt-1 literal is refused by the same gate.
    const attemptOneLiteral = rendered.value.prompt.replace(dispatch.promptAppendix ?? "", NO_RETRY_CONTEXT);
    expect(authorizeImplementationSpawn(value, attemptOneLiteral).ok).toBe(false);
  });

  it("binds an attestation Task's attempt-1 brief to its attestation context, which the gate requires", () => {
    const policy = {
      regression: { kind: "required" as const },
      newTests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
    };
    const graph = parseTaskGraph({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T5", description: "Re-attest T5", agent: "code-implementer-agent", wave: 1, depends_on: [],
        file_list: ["src/x.ts"], status: "pending", implementation_attestation: true,
        verification_policy: { regression: { kind: "required" }, new_tests: { kind: "waived", reason: "existing-tests-sufficient" } },
        proof: derivePendingTaskProof({ verificationPolicy: policy, declaredArtifacts: ["src/x.ts"], declaredArtifactExpectation: "attested" }),
      }],
    });
    if (!graph.ok) throw new Error(graph.error);
    const value = graph.value.tasks[0]!;
    const dispatch = dispatchFor(value);
    expect(dispatch).toMatchObject({ kind: "initial-implementation", promptAppendix: expect.stringContaining("LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT:") });

    const rendered = renderImplementationBrief(input(value, { dispatch, spec: NO_SPEC_FILE }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(authorizeImplementationSpawn(value, rendered.value.prompt)).toMatchObject({ ok: true });
    // The old hand rule ("attempt 1 → None — semantic attempt 1.") is refused.
    const handAssembled = rendered.value.prompt.replace(dispatch.promptAppendix ?? "", NO_RETRY_CONTEXT);
    expect(authorizeImplementationSpawn(value, handAssembled).ok).toBe(false);
  });

  it("inlines no rules for a documentation-only Task", () => {
    const value = task({ file_list: ["docs/adr/0011-x.md"], agent: "adr-writer-agent", spec_anchors: [], spec_contributions: [] });
    const rendered = renderImplementationBrief(input(value));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain(`## Architecture & Language Rules — BINDING`);
    expect(rendered.value.prompt).toContain(NO_CODE_RULES);
    expect(rendered.value.prompt).not.toContain(RULES.get("architecture.md")!.trimEnd());
    expect(rendered.value.prompt).toContain("## Requirement Completion Claims (MUST fully satisfy in this Wave)\n\nNone.");
    expect(rendered.value.prompt).toContain(`## Acceptance Scenario Test Names\n\n${NO_SCENARIO_TEST_NAMES}\n`);
  });

  // spec-check links an Acceptance Scenario to its tests only by the
  // `AS-NNN:` prefix of a test name, so the brief names the prefixes it owes.
  it("names the test prefix owed for each claimed Acceptance Scenario, and only those", () => {
    const rendered = renderImplementationBrief(input(task({ spec_anchors: ["FR-001", "AS-001"], spec_contributions: ["FR-002"] })));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const section = rendered.value.prompt.split("## Acceptance Scenario Test Names\n\n")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("- `AS-001: …`");
    expect(section).toContain("it('AS-001: …'");
    expect(section).toContain('@DisplayName("AS-001: …")');
    expect(section).not.toContain("FR-00");
  });

  it("shows what each dependency produced, derived from its settled state", () => {
    const rendered = renderImplementationBrief(input(task()));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const section = rendered.value.prompt.split("## What Your Dependencies Produced\n\n")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("- **T3** — Build the T3 seam\n  - Completed: no Requirement Completion Claims\n  - Changed:\n    - engine/src/T3.ts");
    expect(section).toContain("- **T4** — Build the T4 seam");
    expect(section.indexOf("**T3**")).toBeLessThan(section.indexOf("**T4**"));
  });

  it("states that a Task without dependencies has none", () => {
    const rendered = renderImplementationBrief(input(task({ depends_on: [] })));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain(`## What Your Dependencies Produced\n\n${NO_PREDECESSORS}\n`);
  });

  it("owes no scenario test names when its only scenario is a Contribution", () => {
    const rendered = renderImplementationBrief(input(task({ spec_anchors: ["FR-001"], spec_contributions: ["AS-001"] })));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain(`## Acceptance Scenario Test Names\n\n${NO_SCENARIO_TEST_NAMES}\n`);
  });

  describe("invariant ownership", () => {
    const render = (fileList: readonly string[], invariants: readonly PlanInvariant[] = [PROBE_FAMILY]): string => {
      const rendered = renderImplementationBrief(input(task({ file_list: [...fileList] }), { ownership: planOwnership(invariants) }));
      if (!rendered.ok) throw new Error(rendered.error.message);
      return ownershipSection(rendered.value.prompt);
    };

    it("states that no invariant applies when the plan declares none", () => {
      expect(render(["engine/src/x.ts"], [])).toBe(NO_INVARIANT_OWNERSHIP);
    });

    it("states that no invariant applies when the Task touches no declared family", () => {
      expect(render(["engine/src/unrelated.ts"])).toBe(NO_INVARIANT_OWNERSHIP);
    });

    it("tells the owner-module Task it owns the rule, with the full family", () => {
      const section = render(["engine/src/utils/path-presence.ts"]);
      expect(section).toContain("**INV-3: Path probes fail closed**");
      expect(section).toContain("Only ENOENT proves a path absent.");
      expect(section).toContain("- Owner: you change the owner module `engine/src/utils/path-presence.ts`. Implement the rule there, once; every sibling entry point must call it.");
      expect(section).toContain("**Sibling entry points:**\n- `engine/src/utils/route-endpoint.ts` — models.json\n- `engine/src/config.ts`");
      expect(section).toContain("**Matrix test:** `engine/tests/utils/path-presence.matrix.test.ts`");
    });

    it("tells a sibling Task to call the owner, naming the siblings it changes", () => {
      const section = render(["/repo/engine/src/utils/route-endpoint.ts"]);
      expect(section).toContain("- Sibling: you change `engine/src/utils/route-endpoint.ts`. Call the owner module `engine/src/utils/path-presence.ts`; never re-implement the rule.");
      expect(section).not.toContain("- Owner:");
    });

    it("tells the matrix-test Task to exercise every sibling, and combines roles", () => {
      const section = render(["engine/src/utils/path-presence.ts", "engine/tests/utils/path-presence.matrix.test.ts"]);
      expect(section).toContain("- Owner:");
      expect(section).toContain("- Matrix test: you change `engine/tests/utils/path-presence.matrix.test.ts`. It must exercise every sibling entry point listed below against the owner module.");
    });

    it("renders nothing for unowned or malformed invariants", () => {
      const unowned: PlanInvariant = { ...PROBE_FAMILY, id: invariantId("INV-4"), ownership: { kind: "unowned", reason: "a prohibition" } };
      const malformed: PlanInvariant = { ...PROBE_FAMILY, id: invariantId("INV-5"), ownership: { kind: "malformed", problems: [{ kind: "missing-owner" }] } };
      expect(render(["engine/src/utils/path-presence.ts"], [unowned, malformed])).toBe(NO_INVARIANT_OWNERSHIP);
    });
  });

  describe("acceptance contract", () => {
    /** CT-1's binding in the export-binding stamp: what makes the engine write its stubs. */
    const CT1_STAMP: readonly ExportBinding[] = [
      binding("engine/src/core/brief.ts", "CT-1", ["renderBrief", "RenderBriefFn"]),
    ];
    /** The brief's Acceptance Contract section over a graph stamped `stamp` ("unstamped": populated before export bindings). */
    const render = (
      value: Task,
      contracts: readonly AcceptanceContract[],
      roster: readonly Task[] = ROSTER,
      stamp: readonly ExportBinding[] | "unstamped" = CT1_STAMP,
    ): string => {
      const graph: TaskGraph = { ...graphFixture(roster), acceptance_contracts: [...contracts], ...(stamp === "unstamped" ? {} : { export_bindings: stamp }) };
      const rendered = renderImplementationBrief(input(value, { contracts, roster, frozenSignatures: unobservedSkeletons(graph) }));
      if (!rendered.ok) throw new Error(rendered.error.message);
      return contractSection(rendered.value.prompt);
    };
    const contractWriter = (): Task => task({
      id: "T3", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: ["FR-001", "AS-001"],
      file_list: ["engine/src/core/brief-contract.ts", "engine/tests/acceptance/brief.acceptance.test.ts"],
    });
    const HAND_STUBS = "Stub every function the acceptance tests import";
    const ENGINE_STUBS = "The engine writes the stubs, not you";

    it("states that no contract involves a Task outside every contract", () => {
      expect(render(task({ spec_anchors: ["FR-001"] }), [])).toBe(NO_ACCEPTANCE_CONTRACT);
    });

    it("tells the contract Task to write the frozen surface and stubs, and that its gate needs every testcase red", () => {
      const contractTask = task({
        id: "T3", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: ["FR-001", "AS-001"],
        file_list: ["engine/src/core/brief-contract.ts", "engine/tests/acceptance/brief.acceptance.test.ts", "engine/src/core/brief.ts"],
      });
      const section = render(contractTask, [CONTRACT], []);
      expect(section).toContain("**CT-1: Brief rendering contract** — you are its contract Task.");
      expect(section).toContain("A rendered brief is admissible by construction.");
      expect(section).toContain("- Types file `engine/src/core/brief-contract.ts` — declarations only");
      expect(section).toContain("  - `engine/tests/acceptance/brief.acceptance.test.ts` — FR-001, AS-001");
      expect(section).toContain("Supported domain: `engine/tests/acceptance/brief.acceptance.test.ts`");
      expect(section).toContain("The engine writes the stubs, not you");
      expect(section).not.toContain("Stub every function the acceptance tests import");
      expect(section).toContain("every acceptance testcase is collected and fails");
    });

    it("FR-041, AS-045: tells the contract Task the engine writes the bound stubs at its stop, and it no longer does", () => {
      const contractTask = task({
        id: "T3", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: ["FR-001", "AS-001"],
        file_list: ["engine/src/core/brief-contract.ts", "engine/tests/acceptance/brief.acceptance.test.ts"],
      });
      const section = render(contractTask, [CONTRACT], []);
      expect(section).toMatch(/engine writes the stubs, not you/);
      expect(section).toContain("when you stop, before the stop checks");
      expect(section).toContain("`unimplemented: <name>`");
      expect(section).toMatch(/Do not write a bound file/);
    });

    it("keeps the contract Task's own stub duty when its contract declares no types file: nothing is bound to it", () => {
      const typeless: AcceptanceContract = { ...CONTRACT, types: { kind: "none", reason: "drives an existing entry point" } };
      const contractTask = task({
        id: "T3", wave: 1, depends_on: [], spec_anchors: [], spec_contributions: ["FR-001", "AS-001"],
        file_list: ["engine/tests/acceptance/brief.acceptance.test.ts"],
      });
      const section = render(contractTask, [typeless], []);
      expect(section).toContain(HAND_STUBS);
      expect(section).not.toContain("The engine writes the stubs");
    });

    // ADR-0056: the engine writes contract stubs only for a types-file contract
    // the stamp binds an export to; the brief must say the same, or a contract
    // Task leaves its tests importing files nobody writes.
    it("keeps the contract Task's stub duty on a graph populated before export bindings were stamped", () => {
      const section = render(contractWriter(), [CONTRACT], [], "unstamped");
      expect(section).toContain("- Types file `engine/src/core/brief-contract.ts` — declarations only");
      expect(section).toContain(HAND_STUBS);
      expect(section).not.toContain(ENGINE_STUBS);
    });

    it("keeps the contract Task's stub duty when the stamp binds nothing to its types-file contract", () => {
      const otherContract: readonly ExportBinding[] = CT1_STAMP.map((entry) => ({ ...entry, contract: "CT-9" }));
      for (const stamp of [[], otherContract]) {
        const section = render(contractWriter(), [CONTRACT], [], stamp);
        expect(section).toContain(HAND_STUBS);
        expect(section).not.toContain(ENGINE_STUBS);
      }
    });

    it("tells the contract Task the engine writes the stubs exactly when the stamp binds an export to its types-file contract", () => {
      const section = render(contractWriter(), [CONTRACT], [], CT1_STAMP);
      expect(section).toContain(ENGINE_STUBS);
      expect(section).not.toContain(HAND_STUBS);
    });

    it("decides stub authorship by the stop's own rule (stubbedContracts), for every stamp shape", () => {
      const typeless: AcceptanceContract = { ...CONTRACT, id: "CT-2", types: { kind: "none", reason: "an existing entry point" } };
      const typelessBinding: ExportBinding = { ...CT1_STAMP[0]!, contract: "CT-2" };
      const writer = contractWriter();
      for (const stamp of [undefined, [], CT1_STAMP, [typelessBinding], [...CT1_STAMP, typelessBinding]]) {
        const graph: TaskGraph = {
          ...graphFixture([writer]),
          acceptance_contracts: [CONTRACT, typeless],
          ...(stamp === undefined ? {} : { export_bindings: stamp }),
        };
        const engineStubbed = new Set(stubbedContracts(graph, writer.id).map(({ id }) => id));
        for (const contract of [CONTRACT, typeless]) {
          expect(contractStubAuthor(contract, stamp).kind).toBe(engineStubbed.has(contract.id) ? "engine" : "contract-task");
        }
      }
    });

    it("tells a claimant which frozen testcases it turns green, and that frozen files are read-only", () => {
      const section = render(task({ spec_anchors: ["AS-001"], spec_contributions: [] }), [FROZEN_CONTRACT]);
      expect(section).toContain("**CT-1: Brief rendering contract** — you complete AS-001 (contract Task T3).");
      expect(section).toContain("Frozen — read them, never write them");
      expect(section).toContain("- `engine/src/core/brief-contract.ts`");
      expect(section).toContain("- `brief > AS-001: admitted` (`engine/tests/acceptance/brief.acceptance.test.ts`)");
      expect(section).not.toContain("brief > FR-001: renders");
      expect(section).toContain("only an operator Contract Revision changes a frozen file");
    });

    // T3 writes CT-1 in Wave 1 and T6 completes AS-001 in Wave 3, so a Wave 2 Task runs inside the red window.
    const WINDOW_ROSTER: readonly Task[] = [
      ...ROSTER,
      task({ id: "T6", wave: 3, depends_on: ["T3"], spec_anchors: ["AS-001"], spec_contributions: [], file_list: ["engine/src/t6.ts"] }),
    ];
    const bystanderTask = (regressionReason: "acceptance-red-window" | "documentation-only") => task({
      spec_anchors: [], spec_contributions: [], file_list: ["engine/src/other.ts"],
      verification_policy: {
        regression: { kind: "waived", reason: regressionReason },
        new_tests: { kind: "required" },
      },
    });

    it("tells a red-window bystander which pending failures are not its own", () => {
      const section = render(bystanderTask("acceptance-red-window"), [FROZEN_CONTRACT], WINDOW_ROSTER);
      expect(section).toContain("**CT-1: Brief rendering contract** — its acceptance testcases in `engine/tests/acceptance/brief.acceptance.test.ts` may still fail");
      expect(section).toContain("Your regression run is waived for that reason (`acceptance-red-window`)");
      expect(section).toContain("Failures anywhere else are yours to fix.");
    });

    it("gives the bystander note to a Task in the window that authored its own regression waiver, without claiming the engine's", () => {
      const section = render(bystanderTask("documentation-only"), [FROZEN_CONTRACT], WINDOW_ROSTER);
      expect(section).toContain("may still fail in a full-suite run");
      expect(section).not.toContain("Your regression run is waived");
    });

    it("says nothing to a Task outside the red window", () => {
      expect(render(bystanderTask("documentation-only"), [FROZEN_CONTRACT], ROSTER)).toBe(NO_ACCEPTANCE_CONTRACT);
    });
  });

  it("substitutes the template in one pass, never re-scanning Task text for variables", () => {
    const value = task({ description: "Keep the literal {task_id} in docs" });
    const rendered = renderImplementationBrief(input(value));
    expect(rendered).toMatchObject({ ok: false, error: { kind: "residual-placeholders" } });
    if (rendered.ok) return;
    expect(rendered.error.message).toContain("{task_id}");
  });

  it.each<[string, (value: Task) => ImplementationBriefInput, string]>([
    ["a dispatch for another Task", (value) => input(value, { dispatch: { ...dispatchFor(value), taskId: "T9" } }), "dispatch-task-mismatch"],
    ["an agent outside the catalog", (value) => input({ ...value, agent: "ghost-agent" }), "unknown-agent"],
    ["a template missing a variable", (value) => input(value, { template: TEMPLATE.replace("{plan_context}", "") }), "template-variables-mismatch"],
    ["a template with an unowned variable", (value) => input(value, { template: `${TEMPLATE}\n{surprise}` }), "template-variables-mismatch"],
    ["a missing rule document", (value) => input(value, { rules: new Map() }), "rule-document-missing"],
    ["a Requirement the Spec Index lacks", (value) => input({ ...value, spec_anchors: ["FR-099"] }), "requirement-text-unavailable"],
    ["claims without a Spec Index", (value) => input(value, { spec: NO_SPEC_FILE }), "requirement-text-unavailable"],
    ["plan text the gate reads as a variable", (value) => input({ ...value, plan_context: "Use {placeholder} here" }), "residual-placeholders"],
    ["a dependency missing from the roster", (value) => input(value, { roster: [completedDependency("T3")] }), "predecessor-output-unavailable"],
    ["a dependency that is not completed", (value) => input(value, {
      roster: [completedDependency("T3"), { ...completedDependency("T4"), status: "implemented" } as Task],
    }), "predecessor-output-unavailable"],
  ])("refuses %s", (_name, build, kind) => {
    expect(renderImplementationBrief(build(task()))).toMatchObject({ ok: false, error: { kind } });
  });

  it.each<[string, SpecIndexAvailability, string]>([
    ["no spec_file", NO_SPEC_FILE, "the TaskGraph records no spec_file"],
    [
      "an unreadable spec file",
      { kind: "unavailable", reason: { kind: "unreadable", path: "/repo/spec.md", reason: "ENOENT: no such file" } },
      "spec file /repo/spec.md could not be read: ENOENT: no such file",
    ],
    [
      "a spec file that is not UTF-8",
      {
        kind: "unavailable",
        reason: { kind: "invalid-encoding", path: "/repo/spec.md", contentDigest: digest("b"), reason: "bad byte" },
      },
      "spec file /repo/spec.md is not valid UTF-8: bad byte",
    ],
    [
      "a spec file that does not parse",
      {
        kind: "unavailable",
        reason: {
          kind: "unparsed",
          path: "/repo/spec.md",
          contentDigest: digest("c"),
          errors: [{ kind: "no-acceptance-block" }],
        },
      },
      "spec file /repo/spec.md is not a canonical specification: ",
    ],
  ])("names why the Spec Index is unavailable when claims cannot be resolved: %s", (_name, spec, cause) => {
    const rendered = renderImplementationBrief(input(task(), { spec }));
    expect(rendered).toMatchObject({ ok: false, error: { kind: "requirement-text-unavailable" } });
    if (rendered.ok) return;
    expect(rendered.error.message).toContain(
      "T5 claims Requirements (FR-001, AS-001, FR-002) but the protected spec_file has no Spec Index: ",
    );
    expect(rendered.error.message).toContain(cause);
  });
});

describe("parseImplementationBriefRequest", () => {
  it.each<[string, string]>([
    ["no marker at all", "**Task ID:** T5"],
    ["a marker with trailing words", "LOOM_IMPLEMENTATION_BRIEF: T5 and more"],
    ["a marker inside prose", "Implement LOOM_IMPLEMENTATION_BRIEF: T5"],
    ["a lowercase Task id", "LOOM_IMPLEMENTATION_BRIEF: t5"],
  ])("is none for %s", (_label, text) => {
    expect(parseImplementationBriefRequest(text)).toEqual({ kind: "none" });
  });

  it("reads a bare marker, trimmed, as a request with no notes", () => {
    expect(parseImplementationBriefRequest("  LOOM_IMPLEMENTATION_BRIEF: T12\n")).toEqual({ kind: "request", request: { taskId: "T12", operatorNotes: [] } });
  });

  it("reads each following LOOM_OPERATOR_NOTE line as a note, skipping blank lines (#119)", () => {
    expect(parseImplementationBriefRequest([
      "LOOM_IMPLEMENTATION_BRIEF: T2",
      "LOOM_OPERATOR_NOTE: touch handler-routes.ts so the affected check selects its importers",
      "",
      "LOOM_OPERATOR_NOTE:   keep the change minimal  ",
    ].join("\n"))).toEqual({
      kind: "request",
      request: { taskId: "T2", operatorNotes: ["touch handler-routes.ts so the affected check selects its importers", "keep the change minimal"] },
    });
  });

  it.each<[string, string, string]>([
    ["an ordinary line after the marker", "LOOM_IMPLEMENTATION_BRIEF: T2\nalso touch handler-routes.ts", "line 2 is neither"],
    ["the marker after an operator line", "please be careful\nLOOM_IMPLEMENTATION_BRIEF: T2", "the marker elsewhere or more than once"],
    ["two markers", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_IMPLEMENTATION_BRIEF: T3", "the marker elsewhere or more than once"],
    ["an empty note", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE:   ", "an operator note is empty"],
    ["a note carrying a LOOM_ token", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: LOOM_REQUEST_ID: req-1", "may not carry a LOOM_ token"],
    ["a note carrying a template variable", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: fill {task_id}", "may not carry a {template variable}"],
    ["a note carrying a Task ID binding", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: **Task ID:** T9", "may not carry a Task ID binding"],
    ["a note carrying a carriage return", "LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: one\rtwo", "line 2 is neither"],
    ["an overlong note", `LOOM_IMPLEMENTATION_BRIEF: T2\nLOOM_OPERATOR_NOTE: ${"x".repeat(MAX_OPERATOR_NOTE_LENGTH + 1)}`, `at most ${MAX_OPERATOR_NOTE_LENGTH}`],
    ["too many notes", ["LOOM_IMPLEMENTATION_BRIEF: T2", ...Array.from({ length: MAX_OPERATOR_NOTES + 1 }, (_, i) => `LOOM_OPERATOR_NOTE: note ${i}`)].join("\n"), `at most ${MAX_OPERATOR_NOTES} are allowed`],
  ])("is malformed, naming the grammar, for %s", (_label, text, reason) => {
    const parsed = parseImplementationBriefRequest(text);
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind === "malformed") expect(parsed.reason).toContain(reason);
  });

  it("admits only one-line notes, so every OperatorNote renders to exactly one marker line", () => {
    for (const text of ["one\ntwo", "one\rtwo", "one\r\ntwo"]) {
      expect(parseOperatorNote(text)).toEqual({ ok: false, error: "an operator note must be one line" });
    }
    expect(parseOperatorNote("  one line  ")).toEqual({ ok: true, value: "one line" });
  });

  it("property: rendering a request and parsing it back is the identity", () => {
    const requests = [
      { taskId: "T1", operatorNotes: [] },
      { taskId: "T42", operatorNotes: [admittedNote("one"), admittedNote("two: with a colon"), admittedNote("x".repeat(MAX_OPERATOR_NOTE_LENGTH))] },
    ];
    for (const request of requests) {
      expect(parseImplementationBriefRequest(renderImplementationBriefRequest(request))).toEqual({ kind: "request", request });
    }
  });
});

describe("the brief's Operator Note section (#119)", () => {
  it("lists each note, and the brief stays admissible to the real gates", () => {
    const value = task();
    const rendered = renderImplementationBrief(input(value, { operatorNotes: [admittedNote("touch handler-routes.ts"), admittedNote("report the affected run time")] }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain("## Operator Note\n\n- touch handler-routes.ts\n- report the affected run time\n\n");
    expect(rendered.value.prompt).toContain("never widens your file list");
    expect(validateTemplateSubstitution(rendered.value.prompt, true)).toEqual({ kind: "allow" });
    expect(extractTaskId(rendered.value.prompt)).toBe("T5");
    expect(authorizeImplementationSpawn(value, rendered.value.prompt)).toMatchObject({ ok: true, kind: "initial" });
  });
});

// ---------------------------------------------------------------------------
// Frozen signatures (T14: FR-024, FR-040, AS-038..AS-041, AS-046..AS-048)
// ---------------------------------------------------------------------------

const frozenSection = (prompt: string): string =>
  prompt.split("## Frozen Signatures — BINDING\n\n")[1]?.split("\n\nThe engine derives this section")[0] ?? "";

const lineWith = (text: string, ...needles: readonly string[]): boolean =>
  text.split("\n").some((line) => needles.every((needle) => line.includes(needle)));

const paragraphWith = (text: string, ...needles: readonly (string | RegExp)[]): boolean =>
  text.split(/\n[ \t]*\n/).some((paragraph) =>
    needles.every((needle) => (typeof needle === "string" ? paragraph.includes(needle) : needle.test(paragraph))));

describe("the brief's Frozen Signatures section", () => {
  const TYPES = "src/order/order-contract.ts";
  const JAVA_TYPES = "src/main/java/com/acme/OrderContract.java";
  const typedContract = (id: string, path: string, anchor: string): AcceptanceContract => ({
    ...FROZEN_CONTRACT,
    id,
    title: `${id} contract`,
    contractTask: "T1",
    types: { kind: "file", path },
    acceptance: [{ path: `tests/${id}.acceptance.test.ts`, anchors: [anchor] }],
    supportedDomain: null,
    freeze: {
      state: "frozen",
      wave: 1,
      paths: [{ path, sha256: digest("a") }, { path: `tests/${id}.acceptance.test.ts`, sha256: digest("b") }],
      roster: [{ file: `tests/${id}.acceptance.test.ts`, name: `${anchor}: decides`, anchors: [anchor] }],
    },
  });
  const TS_TYPED = typedContract("CT-1", TYPES, "FR-001");
  const JAVA_TYPED = typedContract("CT-2", JAVA_TYPES, "AS-001");
  const TYPELESS: AcceptanceContract = { ...typedContract("CT-3", "unused", "FR-002"), types: { kind: "none", reason: "an existing entry point" } };

  const TS_SURFACE: FrozenSurface = {
    language: "typescript",
    path: TYPES,
    aliases: [],
    adts: [
      { kind: "discriminated-union", name: "OrderState", discriminant: "status", tags: ["draft", "paid"], variants: [] },
      { kind: "brand", name: "OrderId" },
    ],
  };
  const JAVA_SURFACE: FrozenSurface = {
    language: "java",
    path: JAVA_TYPES,
    package: "com.acme",
    holder: "OrderContract",
    aliases: [],
    adts: [{ kind: "sealed-interface", name: "OrderState", variants: ["Draft", "Paid"] }, { kind: "record", name: "Order" }],
  };

  const BINDINGS: readonly ExportBinding[] = [
    binding("src/order/pricing.ts", "CT-1", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
    binding("src/order/legacy.ts", "CT-1", ["quoteOrder", "PriceOrderFn"]),
    binding("src/order/rates.py", "CT-1", ["rate", "PriceOrderFn"]),
    binding("src/main/java/com/acme/Pricing.java", "CT-2", ["priceOrder", "PriceOrderFn"]),
  ];

  const implementer = task({
    id: "T5",
    depends_on: ["T3"],
    spec_anchors: ["FR-001"],
    spec_contributions: [],
    file_list: ["src/order/pricing.ts", "src/order/legacy.ts", "src/order/rates.py", "src/order/helpers.ts", "tests/order/pricing.test.ts"],
  });
  const javaImplementer = task({
    id: "T6",
    depends_on: ["T3"],
    spec_anchors: ["AS-001"],
    spec_contributions: [],
    file_list: ["src/main/java/com/acme/Pricing.java", "src/main/java/com/acme/Discounts.java"],
  });
  const auditor = task({ id: "T7", depends_on: ["T3"], spec_anchors: ["FR-002"], spec_contributions: [], file_list: ["src/audit/audit-log.ts"] });
  const attested = task({
    id: "T8", depends_on: ["T3"], spec_anchors: ["FR-001"], spec_contributions: [], file_list: ["src/order/view.ts"],
    verification_policy: { regression: { kind: "waived", reason: "documentation-only" }, new_tests: { kind: "waived", reason: "documentation-only" } },
  });

  const skeletonGraph = (skeletons: readonly SkeletonRecord[] = []): TaskGraph => ({
    ...graphFixture([...ROSTER, implementer, javaImplementer, auditor, attested]),
    current_wave: 2,
    acceptance_contracts: [TS_TYPED, JAVA_TYPED, TYPELESS],
    export_bindings: BINDINGS,
    skeletons,
  });

  const OBSERVATIONS: ReadonlyMap<string, PathObservation> = new Map([
    ["src/order/legacy.ts", { kind: "present", sha256: digest("c"), canonicalSha256: null }],
    ["src/order/view.ts", { kind: "present", sha256: digest("c"), canonicalSha256: null }],
  ]);
  const SURFACES: ReadonlyMap<string, DomainResult<FrozenSurface, string>> = new Map([
    ["CT-1", { ok: true, value: TS_SURFACE }],
    ["CT-2", { ok: true, value: JAVA_SURFACE }],
  ]);

  const frozenInput = (overrides: Partial<FrozenSignaturesInput> = {}): FrozenSignaturesInput => ({
    graph: skeletonGraph(),
    observations: OBSERVATIONS,
    surfaces: SURFACES,
    unresolved: [],
    planBindings: PLAN_BINDINGS_AGREE,
    ...overrides,
  });

  /** The rendered brief's Frozen Signatures section. */
  const brief = (value: Task, frozen: FrozenSignaturesInput = frozenInput()): string => {
    const rendered = renderImplementationBrief(input(value, {
      rules: RULES,
      contracts: frozen.graph.acceptance_contracts ?? [],
      frozenSignatures: frozen,
    }));
    if (!rendered.ok) throw new Error(rendered.error.message);
    return frozenSection(rendered.value.prompt);
  };

  it("AS-046: lists each bound export with its alias under its file, and says the signatures are frozen and the marker must go", () => {
    const section = brief(implementer);
    expect(lineWith(section, "`src/order/pricing.ts`", "skeleton written")).toBe(true);
    expect(lineWith(section, "`priceOrder: PriceOrderFn`")).toBe(true);
    expect(lineWith(section, "`parseOrder: ParseOrderFn`")).toBe(true);
    expect(paragraphWith(section, "src/order/pricing.ts", "priceOrder", "PriceOrderFn")).toBe(true);
    expect(paragraphWith(section, /signatures are frozen/, "`PriceOrderFn`", "`ParseOrderFn`")).toBe(true);
    expect(paragraphWith(section, "`unimplemented: <name>`", /remove/i, /at completion/)).toBe(true);
  });

  it("FR-024: lists the bound exports of every owned file, whatever its outcome", () => {
    const section = brief(implementer);
    expect(section).toContain("- `src/order/legacy.ts` — exists, not skeletonized\n  - `quoteOrder: PriceOrderFn` (CT-1)");
    expect(section).toContain("- `src/order/rates.py` — unsupported language, no skeleton\n  - `rate: PriceOrderFn` (CT-1)");
  });

  it("AS-047: names the frozen ADTs of each in-scope contract and says to import them, never re-declare or re-list them", () => {
    const section = brief(implementer);
    expect(paragraphWith(section, "**Frozen ADTs of CT-1**", "`OrderState` (discriminated union on `status`: `draft`, `paid`)", "`OrderId` (brand)", /import/i, /re-declare/, /re-list/)).toBe(true);
    const java = brief(javaImplementer);
    expect(paragraphWith(java, "**Frozen ADTs of CT-2**", "`OrderState` (sealed interface: `Draft`, `Paid`)", "`Order` (record)", /import/i, /re-declare/)).toBe(true);
    expect(java).not.toContain("CT-1**");
  });

  it("AS-038: names a file with no bound exports \"no bound exports, no skeleton\"", () => {
    expect(lineWith(brief(implementer), "`src/order/helpers.ts`", "no bound exports, no skeleton")).toBe(true);
    expect(lineWith(brief(javaImplementer), "`src/main/java/com/acme/Discounts.java`", "no bound exports, no skeleton")).toBe(true);
  });

  it("AS-039: names a claimant's file of a Types-file-none contract \"contract has no types file, no skeletons\", with no frozen duty", () => {
    const section = brief(auditor);
    expect(lineWith(section, "`src/audit/audit-log.ts`", "contract has no types file, no skeletons")).toBe(true);
    expect(section).not.toContain("Frozen ADTs");
    expect(section).not.toMatch(/signatures are frozen/);
  });

  it("AS-040: names a bound file in an unsupported language \"unsupported language, no skeleton\"", () => {
    expect(lineWith(brief(implementer), "`src/order/rates.py`", "unsupported language, no skeleton")).toBe(true);
  });

  it("AS-041: names an existing file_list path \"exists, not skeletonized\"", () => {
    expect(lineWith(brief(implementer), "`src/order/legacy.ts`", "exists, not skeletonized")).toBe(true);
  });

  it("AS-048: states each fallback outcome on the line naming its file, and names no test file", () => {
    const section = brief(implementer);
    expect(lineWith(section, "`src/order/helpers.ts`", "no bound exports, no skeleton")).toBe(true);
    expect(lineWith(section, "`src/order/legacy.ts`", "exists, not skeletonized")).toBe(true);
    expect(lineWith(section, "`src/order/rates.py`", "unsupported language, no skeleton")).toBe(true);
    expect(section).not.toContain("tests/order/pricing.test.ts");
  });

  it("AS-051: names every unresolved export binding, and that registration refuses the spawn until it is repaired", () => {
    const missing: UnresolvedSkeletonBinding = {
      problem: { kind: "missing-alias", alias: "ParseOrderFn", path: "src/order/pricing.ts", typesFile: TYPES },
      message: `src/order/pricing.ts binds ParseOrderFn, but the frozen types file ${TYPES} declares no ParseOrderFn`,
    };
    const section = brief(implementer, frozenInput({ unresolved: [missing] }));
    expect(paragraphWith(section, "**Unresolved export bindings.**", missing.message, /refuses/, /Contract Revision/)).toBe(true);
    expect(brief(implementer)).not.toContain("Unresolved export bindings");
  });

  it("FR-040: flags a stale skeleton on the line naming its file", () => {
    const stale: SkeletonRecord = {
      path: "src/order/legacy.ts", contract: "CT-1", language: "typescript", origin: "spawn",
      engineSha256: digest("e"), typesSha256: digest("f"), stale: { revision: 2 },
    };
    const section = brief(implementer, frozenInput({ graph: skeletonGraph([stale]) }));
    expect(lineWith(section, "`src/order/legacy.ts`", "exists, not skeletonized", "stale against revised contract CT-1 (revision 2)")).toBe(true);
  });

  it("owes no frozen duty to a Task conformance does not judge, but still states its outcomes", () => {
    const section = brief(attested);
    expect(lineWith(section, "`src/order/view.ts`", "exists, not skeletonized")).toBe(true);
    expect(section).not.toContain("Frozen ADTs");
    expect(section).not.toMatch(/signatures are frozen/);
  });

  it("names a frozen types file it could not read instead of its ADTs", () => {
    const section = brief(implementer, frozenInput({
      surfaces: new Map([["CT-1", { ok: false, error: `the frozen types file ${TYPES} no longer matches its Acceptance Freeze stamp` }]]),
    }));
    expect(paragraphWith(section, "**Frozen ADTs of CT-1**", "could not be read", "no longer matches its Acceptance Freeze stamp")).toBe(true);
  });

  it("says so when the TaskGraph carries no export-binding stamp", () => {
    const { export_bindings: _dropped, ...unstamped } = skeletonGraph();
    expect(brief(implementer, frozenInput({ graph: unstamped }))).toBe(NO_EXPORT_BINDING_STAMP);
  });

  it("leads with what registration does: writes missing skeletons, may refresh untouched ones, never touches a changed file", () => {
    const lead = brief(implementer).split("\n\n")[0] ?? "";
    expect(lead).toContain("it writes each missing bound skeleton before your attempt starts");
    expect(lead).toContain("may refresh a skeleton that is still the engine's untouched bytes");
    expect(lead).toContain("never modifies a file you or anyone else has changed");
    expect(lead).not.toContain("never modifies a file that already exists");
  });

  it("states, last, that the plan's export bindings could not be checked against the stamp, and stays silent when they agree", () => {
    const unchecked = brief(implementer, frozenInput({ planBindings: NO_PLAN_TO_CHECK }));
    const paragraphs = unchecked.split("\n\n");
    expect(paragraphs.at(-1)).toMatch(/^\*\*Export bindings unchecked\.\*\* The TaskGraph stamps export bindings but records no plan_file, so the engine could not check/);
    // The rest of the section is the agreeing section, byte for byte.
    expect(paragraphs.slice(0, -1).join("\n\n")).toBe(brief(implementer));
    expect(brief(implementer)).not.toContain("Export bindings unchecked");
    // A Task with no skeleton outcome still hears it: the check is about the stamp, not its files.
    expect(brief(auditor, frozenInput({ planBindings: NO_PLAN_TO_CHECK }))).toContain("**Export bindings unchecked.**");
  });

  it("renders the section renderFrozenSignatures renders, and the brief stays admissible", () => {
    const rendered = renderImplementationBrief(input(implementer, { contracts: [TS_TYPED, JAVA_TYPED, TYPELESS], frozenSignatures: frozenInput() }));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(frozenSection(rendered.value.prompt)).toBe(renderFrozenSignatures(implementer, frozenInput()));
    expect(validateTemplateSubstitution(rendered.value.prompt, true)).toEqual({ kind: "allow" });
  });
});

describe("brief marker expansion over the skeleton repository (renderTaskImplementationBrief)", () => {
  afterEach(cleanupSkeletonRepos);

  const expand = (repo: SkeletonRepo, taskId: string) =>
    triageBriefMarker(`LOOM_IMPLEMENTATION_BRIEF: ${taskId}`, (request) => renderTaskImplementationBrief(repo.statePath, LOOM_PACKAGE_ROOT, request));

  it("AS-046, AS-047: the expanded brief carries the observed Frozen Signatures section", () => {
    const repo = skeletonRepo();
    const expanded = expand(repo, "T4");
    expect(expanded.kind).toBe("expanded");
    if (expanded.kind !== "expanded") return;
    const section = frozenSection(expanded.brief.prompt);
    expect(lineWith(section, `\`${PATHS.tsPricing}\``, "skeleton written")).toBe(true);
    expect(lineWith(section, "`priceOrder: PriceOrderFn`")).toBe(true);
    expect(lineWith(section, `\`${PATHS.tsLegacy}\``, "exists, not skeletonized")).toBe(true);
    expect(paragraphWith(section, "**Frozen ADTs of CT-1**", "OrderState", "OrderId")).toBe(true);
  });

  it("AS-051: a frozen types file missing a bound alias is named in the expanded brief, with the binding file and types file", () => {
    const repo = skeletonRepo({ tsTypesText: TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "") });
    const expanded = expand(repo, "T4");
    expect(expanded.kind).toBe("expanded");
    if (expanded.kind !== "expanded") return;
    const section = frozenSection(expanded.brief.prompt);
    expect(paragraphWith(section, "**Unresolved export bindings.**", "ParseOrderFn", PATHS.tsPricing, TS_CONTRACT.types)).toBe(true);
  });

  it("refuses the brief when the plan's export bindings drifted from the TaskGraph stamp", () => {
    const repo = skeletonRepo();
    repo.rewriteState((raw) => ({
      ...raw,
      export_bindings: (raw.export_bindings as readonly Readonly<{ path: string }>[]).filter(({ path }) => path !== PATHS.tsQuotes),
    }));
    const expanded = expand(repo, "T4");
    expect(expanded.kind).toBe("unrenderable");
    if (expanded.kind !== "unrenderable") return;
    expect(expanded.error).toContain("drifted from the TaskGraph stamp");
    expect(expanded.error).toContain(PATHS.tsQuotes);
  });

  it("renders a stamped graph that records no plan, and says its bindings could not be checked against the plan", () => {
    const repo = skeletonRepo();
    expect(frozenSection((() => {
      const agreeing = expand(repo, "T4");
      if (agreeing.kind !== "expanded") throw new Error(agreeing.kind);
      return agreeing.brief.prompt;
    })())).not.toContain("Export bindings unchecked");
    repo.rewriteState((raw) => ({ ...raw, plan_file: null }));
    const expanded = expand(repo, "T4");
    expect(expanded.kind).toBe("expanded");
    if (expanded.kind !== "expanded") return;
    const section = frozenSection(expanded.brief.prompt);
    expect(lineWith(section, `\`${PATHS.tsPricing}\``, "skeleton written")).toBe(true);
    expect(paragraphWith(section, "**Export bindings unchecked.**", "records no plan_file", "could not check")).toBe(true);
  });
});
