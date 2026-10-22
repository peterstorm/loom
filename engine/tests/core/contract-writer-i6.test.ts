/**
 * Contract writers do not owe I6 (issue 127, G1 x G4).
 *
 * An Acceptance Contract's contract Task writes the frozen acceptance tests
 * (and any types file or stubs), and the contract Wave Gate requires every
 * acceptance testcase collected and FAILING. Its new tests can never turn
 * green in its own attempt, and a test-only contract has no implementation
 * file to write, so a red-then-green obligation on it is unsatisfiable. The
 * contract gate's observed RED window is the writer's red evidence instead.
 *
 * One populated I6-era graph is followed through every site that derives or
 * checks obligations: population, the State File load boundary, the operator
 * validator, the Red-Then-Green Status, the brief, and settlement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
} from "../../src/core/implementation-completion";
import { renderImplementationBrief, RULE_DOCUMENTS, type RuleDocument } from "../../src/core/implementation-brief";
import {
  redThenGreenScope,
  taskRedThenGreenEra,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofObligation,
} from "../../src/core/proof-obligations";
import { NOT_OWED_REASON_TEXT, RTG_NOT_OWED, redThenGreenStatusView, renderRedThenGreenStatus } from "../../src/core/red-then-green-status";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { parseAuthoredTaskRoster, populateTaskGraph, type AuthoredTask } from "../../src/core/task-graph-population";
import { defaultVerificationManifest } from "../../src/core/verification-manifest";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import { parseTaskGraph } from "../../src/state-manager";
import type { PlanContract, Task, TaskGraph } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { withoutRedThenGreen, withRedThenGreen } from "../fixtures/red-then-green-proof";
import { indexedSpec } from "../fixtures/spec-index-fixture";

// --- Fixtures ---

const ACCEPTANCE = "tests/load.acceptance.test.ts";

/** A test-only contract: no types file, one acceptance file. */
const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Load contract",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "the slice consumes another surface" },
    acceptance: [{ path: ACCEPTANCE, anchors: ["FR-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: "Loads.",
  },
};

const task = (id: string, wave: number, overrides: Partial<AuthoredTask> = {}): AuthoredTask => ({
  id,
  description: `task ${id}`,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  file_list: [`src/${id}.ts`],
  ...overrides,
});

/** T1 writes CT-1 (new tests required by decompose Rule 12), T2 claims it, T3 is an ordinary new-tests Task. */
const ROSTER: readonly AuthoredTask[] = [
  task("T1", 1, { file_list: [ACCEPTANCE], spec_contributions: ["FR-001"] }),
  task("T2", 2, {
    depends_on: ["T1"],
    spec_anchors: ["FR-001"],
    verification_policy: {
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "covered-by-acceptance-contract" },
    },
  }),
  task("T3", 1, { file_list: ["src/T3.ts", "tests/T3.test.ts"] }),
];

function populated(): TaskGraph {
  const roster = parseAuthoredTaskRoster(ROSTER);
  if (!roster.ok) throw new Error(roster.error);
  const result = populateTaskGraph({
    current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: "spec.md", plan_file: "plan.md",
    tasks: [], wave_gates: {},
  }, {
    planTitle: "contract writers", validatedPlanFile: "plan.md", tasks: roster.value,
    // No manifest file: the I6-era default every post-feature population freezes.
    verificationManifest: defaultVerificationManifest(),
    specIndex: indexedSpec("spec.md"), observedSpecFile: "spec.md",
    force: false, proofBoundary: { kind: "absent", cause: "fixture" }, contracts: [CONTRACT],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

const wire = (graph: TaskGraph): Record<string, unknown> => JSON.parse(JSON.stringify(graph));
const kinds = (obligations: readonly ProofObligation[] | undefined): readonly string[] =>
  (obligations ?? []).map(({ kind }) => kind);
const taskOf = (graph: Readonly<{ tasks: readonly Task[] }>, id: string): Task => {
  const found = graph.tasks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

/** The populated graph as a writer's Proof should be: no red-then-green on T1. */
const writerProofGraph = (): Record<string, unknown> => withoutRedThenGreen(wire(populated()), "T1");

// --- Population ---

describe("population: contract writers owe no I6", () => {
  it("gives the contract Task its new-tests obligation and no red-then-green", () => {
    const writer = taskOf(populated(), "T1");
    expect(kinds(writer.proof?.obligations)).toContain("new-tests");
    expect(kinds(writer.proof?.obligations)).not.toContain("red-then-green");
  });

  it("keeps red-then-green on a non-writer Task requiring new tests in the same graph", () => {
    // T3 runs inside CT-1's red window, so its regression is waived; its new-tests duty is not.
    expect(kinds(taskOf(populated(), "T3").proof?.obligations)).toEqual([
      "task-completed", "new-tests", "red-then-green", "declared-artifact-changed", "declared-artifact-changed",
    ]);
  });

  it("gives the claimant neither new-tests nor red-then-green", () => {
    const claimant = kinds(taskOf(populated(), "T2").proof?.obligations);
    expect(claimant).not.toContain("new-tests");
    expect(claimant).not.toContain("red-then-green");
  });

  it("freezes every Task's Proof, so no contract writer reaches a no-Proof path", () => {
    // ADR-0026's soundness premise: revalidation and redThenGreenDuty's no-Proof arm take the graph era alone.
    expect(populated().tasks.filter(({ proof }) => proof === undefined).map(({ id }) => id)).toEqual([]);
  });
});

// --- The State File load boundary and the operator validator ---

describe("the State File load boundary holds the writer to the writer era", () => {
  it("loads a writer Proof without red-then-green", () => {
    const parsed = parseTaskGraph(writerProofGraph());
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it("refuses a writer Proof still carrying red-then-green", () => {
    expect(parseTaskGraph(withRedThenGreen(wire(populated()), "T1"))).toMatchObject({
      ok: false,
      error: expect.stringContaining('tasks[0] ("T1"): proof obligations do not exactly match'),
    });
  });

  it("refuses a non-writer new-tests Task missing red-then-green (control)", () => {
    expect(parseTaskGraph(withoutRedThenGreen(writerProofGraph(), "T3"))).toMatchObject({
      ok: false,
      error: expect.stringContaining('tasks[2] ("T3"): proof obligations do not exactly match'),
    });
  });

  it.each<[string, unknown]>([
    ["not an array", "CT-1"],
    ["an entry that is not a contract", [{ id: "CT-1" }]],
  ])("refuses malformed acceptance_contracts (%s) with their own error, before judging any Proof", (_name, contracts) => {
    const parsed = parseTaskGraph({ ...writerProofGraph(), acceptance_contracts: contracts });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("acceptance_contracts");
    expect(parsed.error).not.toContain("proof obligations do not exactly match");
  });

  it("migrates a proof-less pending writer to a Proof without red-then-green", () => {
    const raw = writerProofGraph();
    delete (raw.tasks as Array<Record<string, unknown>>)[0]!.proof;
    const parsed = parseTaskGraph(raw);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(kinds(taskOf(parsed.value, "T1").proof?.obligations)).toEqual(
      kinds(taskOf(populated(), "T1").proof?.obligations));
    expect(kinds(taskOf(parsed.value, "T1").proof?.obligations)).not.toContain("red-then-green");
  });
});

describe("helper validate-task-graph agrees with the loader on contract writers", () => {
  const cases: readonly (readonly [string, () => Record<string, unknown>])[] = [
    ["a writer Proof without red-then-green", writerProofGraph],
    ["a writer Proof carrying red-then-green", () => withRedThenGreen(wire(populated()), "T1")],
    ["a non-writer missing red-then-green", () => withoutRedThenGreen(writerProofGraph(), "T3")],
    ["malformed acceptance_contracts", () => ({ ...writerProofGraph(), acceptance_contracts: "CT-1" })],
  ];

  it.each(cases)("%s: same verdict as parseTaskGraph", (_name, graph) => {
    expect(validateFull(graph()).ok).toBe(parseTaskGraph(graph()).ok);
  });

  it("accepts the writer Proof without red-then-green and refuses the one carrying it", () => {
    const accepted = validateFull(writerProofGraph());
    expect(accepted.ok, accepted.ok ? "" : accepted.errors.join("\n")).toBe(true);
    const refused = validateFull(withRedThenGreen(wire(populated()), "T1"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join("\n")).toContain('tasks[0] ("T1"): proof obligations do not exactly match');
  });
});

// --- Status, brief, settlement ---

const loaded = () => {
  const parsed = parseTaskGraph(writerProofGraph());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value as unknown as TaskGraph;
};

describe("Red-Then-Green Status names the writer's true reason", () => {
  it("reports contract-writer with its contract id, not no-obligation-in-proof", () => {
    expect(redThenGreenStatusView({ graph: loaded(), taskId: "T1", live: { kind: "no-live-attempt" } })).toMatchObject({
      duty: { kind: "not-owed", reason: { kind: "contract-writer", contract: "CT-1" } },
    });
  });

  it("names contract-writer for exactly the Tasks taskRedThenGreenEra exempts", () => {
    const graph = loaded();
    const scope = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
    for (const { id } of graph.tasks) {
      const view = redThenGreenStatusView({ graph, taskId: id, live: { kind: "no-live-attempt" } });
      const named = view.kind === "task" && view.duty.kind === "not-owed" && view.duty.reason.kind === "contract-writer";
      expect(named, id).toBe(scope.era === "owed-if-new-tests" && taskRedThenGreenEra(scope, id) === "not-owed");
    }
  });

  it("renders the reason in the header", () => {
    const rendered = renderRedThenGreenStatus({ graph: loaded(), taskId: "T1", live: { kind: "no-live-attempt" } });
    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(NOT_OWED_REASON_TEXT["contract-writer"]).toContain("the contract gate's red window is its red evidence");
    expect(rendered.lines[0]).toBe(
      `T1 (Wave 1, pending): ${RTG_NOT_OWED} — writes Acceptance Contract CT-1's frozen files; ` +
        "the contract gate's red window is its red evidence",
    );
  });
});

describe("the brief states no I6 duty to a contract writer", () => {
  const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
  const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
    [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));
  const I6_SECTION = "**I6 red-then-green — BINDING for this Task.**";

  const brief = (id: string): string => {
    const graph = loaded();
    const target = taskOf(graph, id);
    const derivation = deriveTaskImplementationDispatch(target);
    if (derivation.kind !== "dispatch") throw new Error(`${id} must be owed a dispatch, got ${derivation.kind}`);
    const rendered = renderImplementationBrief({
      template: TEMPLATE,
      task: target,
      dispatch: derivation.dispatch,
      verificationManifest: graph.verification_manifest,
      planFile: "/repo/plan.md",
      spec: indexedSpec("spec.md"),
      rules: RULES,
      roster: graph.tasks,
      invariants: [],
      contracts: graph.acceptance_contracts ?? [],
      repositoryRoot: "/repo",
      operatorNotes: [],
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    return rendered.value.prompt;
  };

  it("gives the contract writer no green instruction contradicting its contract", () => {
    const prompt = brief("T1");
    expect(prompt).not.toContain(I6_SECTION);
    expect(prompt).toContain("every acceptance testcase is collected and fails");
  });

  it("still binds a non-writer new-tests Task to I6 (control)", () => {
    expect(brief("T3")).toContain(I6_SECTION);
  });
});

describe("settlement implements a test-only contract writer with no implementation write", () => {
  it("settles implemented in an I6-era graph", () => {
    const writer = taskOf(loaded(), "T1");
    const authority = createImplementationAttemptAuthority({
      taskId: "T1",
      wave: 1,
      semanticAttempt: 1,
      reservationId: "contract-writer-attempt",
      headSha: "a".repeat(40),
      reservedAt: "2026-10-21T00:00:00.000Z",
      taskScopeBaseline: [],
      dirtySetBaseline: [],
    });
    if (!authority.ok) throw new Error(authority.error.errors.join("; "));
    const suite = createTaskCompletionSuiteAuthority(authority.value);
    if (!suite.ok) throw new Error(suite.error.errors.join("; "));
    const result = settleImplementationAttempt({
      id: "T1",
      status: "pending",
      proof: writer.proof,
      active_implementation_attempt: authority.value,
      implementation_attempt_history: [],
    }, authority.value, authority.value, {
      schemaVersion: 1,
      kind: "implementation-observed",
      observedAt: "2026-10-21T00:01:00.000Z",
      evidence: {
        taskCompleted: true,
        testResult: { verdict: "trusted-pass" },
        filesModified: [ACCEPTANCE],
        newTestsWritten: true,
        newTestEvidence: "wrote the acceptance tests, all failing",
        // What the ledger judges for a test-only writer: G5b T2's attempt-1 gap.
        redThenGreen: { kind: "unproven", gap: { kind: "implementation-write-missing" } },
      },
      proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    }, {
      schemaVersion: 1,
      kind: "task-completion-suite-result",
      implementationAuthorityDigest: suite.value.implementationAuthorityDigest,
      suiteDigest: suite.value.suiteDigest,
      checks: [{ checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [] } }],
    });
    expect(result).toMatchObject({ ok: true, value: { kind: "implemented", receipt: { failureKinds: [] } } });
  });
});
