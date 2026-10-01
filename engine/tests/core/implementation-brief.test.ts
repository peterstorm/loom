import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOM_PACKAGE_ROOT } from "../../src/config";
import {
  NO_CODE_RULES,
  NO_RETRY_CONTEXT,
  parseImplementationBriefMarker,
  renderImplementationBrief,
  ruleDocumentsFor,
  RULE_DOCUMENTS,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import { parseSpec, type ParsedSpec } from "../../src/core/parse-spec";
import { validateTemplateSubstitution } from "../../src/core/validate-template-substitution";
import { deriveTaskImplementationDispatch } from "../../src/core/wave-gate-machine";
import type { Task, WaveImplementationDispatch } from "../../src/types";
import { extractTaskId } from "../../src/utils/extract-task-id";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { parseTaskGraph } from "../../src/state-manager";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { taskFixture } from "../fixtures/task-lifecycle";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";

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
const SPEC: ParsedSpec = parsed.value;

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

const input = (value: Task, overrides: Partial<ImplementationBriefInput> = {}): ImplementationBriefInput => ({
  template: TEMPLATE,
  task: value,
  dispatch: dispatchFor(value),
  planFile: "/repo/.claude/plans/plan.md",
  spec: SPEC,
  rules: RULES,
  ...overrides,
});

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

    const rendered = renderImplementationBrief(input(value, { dispatch, spec: null }));
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
    ["claims without a Spec Index", (value) => input(value, { spec: null }), "requirement-text-unavailable"],
    ["plan text the gate reads as a variable", (value) => input({ ...value, plan_context: "Use {placeholder} here" }), "residual-placeholders"],
  ])("refuses %s", (_name, build, kind) => {
    expect(renderImplementationBrief(build(task()))).toMatchObject({ ok: false, error: { kind } });
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
