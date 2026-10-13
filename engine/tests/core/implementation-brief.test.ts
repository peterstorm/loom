import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import {
  NO_ACCEPTANCE_CONTRACT,
  NO_CODE_RULES,
  NO_INVARIANT_OWNERSHIP,
  NO_RETRY_CONTEXT,
  NO_SCENARIO_TEST_NAMES,
  parseImplementationBriefMarker,
  renderImplementationBrief,
  ruleDocumentsFor,
  RULE_DOCUMENTS,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import { NO_PREDECESSORS } from "../../src/core/predecessor-output";
import { parseSpec } from "../../src/core/parse-spec";
import { parseArtifactDigest, type ArtifactDigest } from "../../src/core/orchestration-contract";
import type { SpecIndexAvailability } from "../../src/core/requirement-coverage";
import { validateTemplateSubstitution } from "../../src/core/validate-template-substitution";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import type { PlanInvariant, Task, WaveImplementationDispatch } from "../../src/types";
import { extractTaskId } from "../../src/utils/extract-task-id";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { parseTaskGraph } from "../../src/state-manager";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { taskFixture } from "../fixtures/task-lifecycle";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";

const digest = (fill: string): ArtifactDigest => {
  const parsed = parseArtifactDigest(fill.repeat(64));
  if (!parsed.ok) throw new Error("fixture digest must parse");
  return parsed.value;
};

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
  planFile: "/repo/.claude/plans/plan.md",
  spec: SPEC,
  rules: RULES,
  roster: ROSTER,
  invariants: [],
  contracts: [],
  ...overrides,
});

const PROBE_FAMILY: PlanInvariant = {
  id: "INV-3",
  title: "Path probes fail closed",
  tier: { status: "ok", tier: "advisory" },
  ruleFile: null,
  statement: "Only ENOENT proves a path absent.",
  ownership: {
    kind: "owned",
    owner: "engine/src/utils/path-presence.ts",
    siblings: [{ path: "engine/src/utils/route-endpoint.ts", note: "models.json" }, { path: "engine/src/config.ts", note: null }],
    matrixTest: "engine/tests/utils/path-presence.matrix.test.ts",
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
      const rendered = renderImplementationBrief(input(task({ file_list: [...fileList] }), { invariants }));
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
      const unowned: PlanInvariant = { ...PROBE_FAMILY, id: "INV-4", ownership: { kind: "unowned", reason: "a prohibition" } };
      const malformed: PlanInvariant = { ...PROBE_FAMILY, id: "INV-5", ownership: { kind: "malformed", problems: [{ kind: "missing-owner" }] } };
      expect(render(["engine/src/utils/path-presence.ts"], [unowned, malformed])).toBe(NO_INVARIANT_OWNERSHIP);
    });
  });

  describe("acceptance contract", () => {
    const render = (value: Task, contracts: readonly AcceptanceContract[], roster: readonly Task[] = ROSTER): string => {
      const rendered = renderImplementationBrief(input(value, { contracts, roster }));
      if (!rendered.ok) throw new Error(rendered.error.message);
      return contractSection(rendered.value.prompt);
    };

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
      expect(section).toContain("Stub every function the acceptance tests import");
      expect(section).toContain("every acceptance testcase is collected and fails");
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

    it("tells a red-window bystander which pending failures are not its own", () => {
      const bystander = task({
        spec_anchors: [], spec_contributions: [], file_list: ["engine/src/other.ts"],
        verification_policy: {
          regression: { kind: "waived", reason: "acceptance-red-window" },
          new_tests: { kind: "required" },
        },
      });
      const section = render(bystander, [FROZEN_CONTRACT]);
      expect(section).toContain("**CT-1: Brief rendering contract** — its acceptance testcases in `engine/tests/acceptance/brief.acceptance.test.ts` may still fail");
      expect(section).toContain("Failures anywhere else are yours to fix.");
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

describe("parseImplementationBriefMarker", () => {
  it.each<[string, string | null]>([
    ["LOOM_IMPLEMENTATION_BRIEF: T5", "T5"],
    ["  LOOM_IMPLEMENTATION_BRIEF: T12\n", "T12"],
    ["LOOM_IMPLEMENTATION_BRIEF: T5 and more", null],
    ["Implement LOOM_IMPLEMENTATION_BRIEF: T5", null],
    ["LOOM_IMPLEMENTATION_BRIEF: t5", null],
    ["**Task ID:** T5", null],
  ])("parses %j", (text, expected) => {
    expect(parseImplementationBriefMarker(text)).toBe(expected);
  });
});
