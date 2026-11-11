/**
 * ADR-0068 at the State File load boundary: a Distill Task loads only in the
 * exact shape population writes, and the `distill-pass` waiver loads on
 * nothing else. Each refusal is the one a hand-edited or drifted graph meets.
 */

import { describe, expect, it } from "vitest";
import { DISTILL_AGENT } from "../src/core/model-profiles";
import { derivePendingTaskProof } from "../src/core/proof-obligations";
import { DISTILL_VERIFICATION_POLICY, serializeVerificationPolicy } from "../src/core/verification-policy";
import { validateFull } from "../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../src/state-file-wire";
import { graphFixture, taskFixture } from "./fixtures/task-lifecycle";

const STORED_DISTILL_POLICY = serializeVerificationPolicy(DISTILL_VERIFICATION_POLICY);
const REQUIRED_POLICY = { regression: { kind: "required" }, new_tests: { kind: "required" } };

const sibling = (id: string, wave = 1): Record<string, unknown> => ({
  id,
  description: `implement ${id}`,
  agent: "code-implementer-agent",
  wave,
  status: "pending",
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: REQUIRED_POLICY,
  file_list: ["src/a.ts"],
  proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/a.ts"] }),
});

const distill = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: "T2",
  description: "Distill pass for Wave 1",
  agent: DISTILL_AGENT,
  wave: 1,
  status: "pending",
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: STORED_DISTILL_POLICY,
  file_list: ["src/a.ts"],
  proof: derivePendingTaskProof({
    verificationPolicy: DISTILL_VERIFICATION_POLICY,
    declaredArtifacts: ["src/a.ts"],
    declaredArtifactExpectation: "preserved",
  }),
  ...overrides,
});

const graphOf = (...tasks: readonly Record<string, unknown>[]): unknown => JSON.parse(JSON.stringify({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: "plan.md",
  spec_trace_version: 2,
  current_wave: 1,
  tasks,
  wave_gates: {},
}));

const refusalOf = (...tasks: readonly Record<string, unknown>[]): string => {
  const parsed = parseTaskGraph(graphOf(...tasks));
  return parsed.ok ? "" : parsed.error;
};

describe("a Distill Task at the State File load boundary", () => {
  it("loads beside the sibling whose file it repeats, with exactly task-completed and behaviour-preserved", () => {
    const parsed = parseTaskGraph(graphOf(sibling("T1"), distill()));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.tasks[1]?.proof?.obligations).toEqual([{ kind: "task-completed" }, { kind: "behaviour-preserved" }]);
  });

  it("is refused with any other obligation set", () => {
    const mismatch = 'tasks[1] ("T2"): proof obligations do not exactly match verification policy and file_list';
    const changed = derivePendingTaskProof({ verificationPolicy: DISTILL_VERIFICATION_POLICY, declaredArtifacts: ["src/a.ts"] });
    const attested = derivePendingTaskProof({
      verificationPolicy: DISTILL_VERIFICATION_POLICY,
      declaredArtifacts: ["src/a.ts"],
      declaredArtifactExpectation: "attested",
    });
    expect(refusalOf(sibling("T1"), distill({ proof: changed }))).toBe(mismatch);
    expect(refusalOf(sibling("T1"), distill({ proof: attested }))).toBe(mismatch);
  });

  it("is refused in attestation mode", () => {
    expect(refusalOf(sibling("T1"), distill({ implementation_attestation: true })))
      .toBe('tasks[1] ("T2"): a Distill Task cannot be in attestation mode');
  });

  it.each([
    ["an authored-style policy", REQUIRED_POLICY],
    ["only regression waived as distill-pass", { regression: STORED_DISTILL_POLICY.regression, new_tests: { kind: "required" } }],
    ["a different waiver reason", { regression: { kind: "waived", reason: "documentation-only" }, new_tests: STORED_DISTILL_POLICY.new_tests }],
    ["no stored policy at all", undefined],
  ])("is refused with %s", (_name, verification_policy) => {
    expect(refusalOf(sibling("T1"), distill({ verification_policy }))).toBe(
      'tasks[1] ("T2"): a Distill Task must carry exactly the verification_policy that waives regression and new_tests as distill-pass',
    );
  });

  it.each([
    ["depends_on", { depends_on: ["T1"], wave: 2 }, "a Distill Task must have empty depends_on"],
    ["spec_anchors", { spec_anchors: ["FR-001"] }, "a Distill Task must have empty spec_anchors"],
    ["spec_contributions", { spec_contributions: ["FR-001"] }, "a Distill Task must have empty spec_contributions"],
  ])("is refused with a non-empty %s", (_field, overrides, message) => {
    expect(refusalOf(sibling("T1"), distill(overrides))).toBe(`tasks[1] ("T2"): ${message}`);
  });

  it.each([["an empty", []], ["an absent", undefined]])("is refused with %s file_list", (_name, file_list) => {
    const proof = derivePendingTaskProof({
      verificationPolicy: DISTILL_VERIFICATION_POLICY,
      declaredArtifacts: [],
      declaredArtifactExpectation: "preserved",
    });
    expect(refusalOf(sibling("T1"), distill({ file_list, proof })))
      .toBe('tasks[1] ("T2"): a Distill Task must have a non-empty file_list (its Distill Scope)');
  });

  it("is refused as the second Distill Task of its Wave, and loads as the one of another Wave", () => {
    expect(refusalOf(sibling("T1"), distill(), distill({ id: "T3" })))
      .toBe("Task T3: Wave 1 already has the Distill Task T2; a Wave carries at most one");
    expect(refusalOf(sibling("T1"), sibling("T4", 2), distill(), distill({ id: "T3", wave: 2 }))).toBe("");
  });

  it("is refused by the operator validator with the same sentence", () => {
    const validation = validateFull(
      { ...(graphOf(sibling("T1"), distill({ depends_on: ["T1"], wave: 2 })) as Record<string, unknown>), plan_title: "p", spec_file: "spec.md" },
      "state-file",
    );
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors).toContain('tasks[1] ("T2"): a Distill Task must have empty depends_on');
  });
});

describe("the distill-pass waiver on a Task that is not a Distill Task", () => {
  it.each([
    ["regression", { regression: STORED_DISTILL_POLICY.regression, new_tests: { kind: "required" } }],
    ["new_tests", { regression: { kind: "required" }, new_tests: STORED_DISTILL_POLICY.new_tests }],
    ["both requirements", STORED_DISTILL_POLICY],
  ])("is refused on %s", (_name, verification_policy) => {
    expect(refusalOf({ ...sibling("T1"), verification_policy }))
      .toBe('tasks[0] ("T1"): waiver reason distill-pass is engine-only and belongs to a Distill Task alone');
  });
});

describe("taskFixture yields a loadable Distill Task", () => {
  it("derives its policy and its preserved Proof from the agent alone", () => {
    const task = taskFixture({
      id: "T2",
      description: "Distill pass for Wave 1",
      agent: DISTILL_AGENT,
      wave: 1,
      depends_on: [],
      file_list: ["src/a.ts"],
    });
    expect(task.verification_policy).toEqual(STORED_DISTILL_POLICY);
    expect(task.proof?.obligations).toEqual([{ kind: "task-completed" }, { kind: "behaviour-preserved" }]);
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graphFixture([task]))));
    expect(parsed.ok ? null : parsed.error).toBeNull();
  });

  it("leaves every other fixture Task on the changed expectation", () => {
    const task = taskFixture({ id: "T1", description: "implement", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: ["src/a.ts"] });
    expect("verification_policy" in task).toBe(false);
    expect(task.proof).toEqual(derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/a.ts"] }));
  });
});
