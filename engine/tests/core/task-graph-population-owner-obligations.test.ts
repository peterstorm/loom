/**
 * T7 / AD-2: population stamps `owner_obligations` on every graph it
 * populates (`[]` included), derived by `obligationsFromPlan`; re-population
 * replaces the stamp; and a plan whose non-exempt owned Invariant meets a
 * frozen manifest with no `affectedRunner` is refused up front
 * (`owner-verification-runner-missing`). A graph without the stamp is a
 * pre-G5b graph and owes nothing (FR-004).
 */

import { describe, expect, it } from "vitest";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
  type TaskGraphPopulationCommand,
} from "../../src/core/task-graph-population";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import {
  obligationsFromPlan,
  ownerCheckAuthority,
  ownerVerificationOwed,
} from "../../src/core/owner-verification/obligations";
import type { MutationPolicy, OwnerObligation, PlanInvariant, PlanModels, TaskGraph } from "../../src/types";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";

const authoredTask = (id: string, wave: number, fileList: readonly string[]): AuthoredTask =>
  Object.freeze({
    id,
    description: `implement ${id}`,
    agent: "code-implementer-agent",
    wave,
    depends_on: Object.freeze([]),
    spec_anchors: Object.freeze([]),
    spec_contributions: Object.freeze([]),
    verification_policy: Object.freeze({
      regression: Object.freeze({ kind: "required" as const }),
      new_tests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" as const }),
    }),
    file_list: Object.freeze([...fileList]),
  });

const ROSTER = (() => {
  const parsed = parseAuthoredTaskRoster([
    authoredTask("T1", 1, ["src/rule-owner.ts"]),
    authoredTask("T2", 2, ["src/unrelated.ts"]),
  ]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
})();

const ownedInvariant = (id: string, mutation: MutationPolicy = { kind: "verify" }): PlanInvariant => ({
  id,
  title: `Rule ${id}`,
  tier: { status: "ok", tier: "checkable" },
  ruleFile: null,
  statement: `The ${id} rule holds.`,
  ownership: {
    kind: "owned",
    owner: "src/rule-owner.ts",
    siblings: [{ path: "src/rule-sibling.ts", note: "the second entry point" }],
    matrixTest: "tests/rule.matrix.test.ts",
    mutation,
  },
});

const unownedInvariant = (id: string): PlanInvariant => ({
  id,
  title: `Advisory ${id}`,
  tier: { status: "ok", tier: "advisory" },
  ruleFile: null,
  statement: null,
  ownership: { kind: "unowned", reason: "design guidance only" },
});

const models = (invariants: readonly PlanInvariant[]): PlanModels => ({
  lifecycles: [],
  pipeline: null,
  invariants,
  contracts: [],
  strays: [],
});

function frozenManifest(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

const WITH_RUNNER = (): FrozenVerificationManifest => frozenManifest({ schemaVersion: 2, affectedRunner: AFFECTED_RUNNER });
const WITHOUT_RUNNER = (): FrozenVerificationManifest => frozenManifest({ schemaVersion: 2 });

const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  current_phase: "decompose",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: "plan.md",
  tasks: [],
  wave_gates: {},
  ...overrides,
});

const command = (overrides: Partial<TaskGraphPopulationCommand> = {}): TaskGraphPopulationCommand => ({
  planTitle: "Owner obligations plan",
  validatedPlanFile: "plan.md",
  tasks: ROSTER,
  verificationManifest: WITH_RUNNER(),
  specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } },
  observedSpecFile: null,
  force: false,
  proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
  contracts: [],
  invariants: [],
  ...overrides,
});

function populated(existing: TaskGraph, cmd: TaskGraphPopulationCommand): TaskGraph {
  const result = populateTaskGraph(existing, cmd);
  if (!result.ok) throw new Error(`population refused: ${result.error.kind}: ${result.error.message}`);
  return result.value.state;
}

/** The graph a pre-G5b population left: identical, but with no stamp. */
function withoutStamp(state: TaskGraph): TaskGraph {
  const { owner_obligations: _dropped, ...preFeature } = state;
  return preFeature;
}

describe("population stamps owner_obligations (AD-2)", () => {
  it("stamps an empty array when the plan declares no Invariant", () => {
    const state = populated(graph(), command({ invariants: [] }));
    expect(state.owner_obligations).toEqual([]);
  });

  it("stamps an empty array when the plan declares only unowned Invariants", () => {
    const state = populated(graph(), command({ invariants: [unownedInvariant("INV-1")] }));
    expect(state.owner_obligations).toEqual([]);
  });

  it("stamps exactly obligationsFromPlan for owned Invariants, in plan order", () => {
    const invariants = [ownedInvariant("INV-2"), unownedInvariant("INV-1"), ownedInvariant("INV-3")];
    const state = populated(graph(), command({ invariants }));
    expect(state.owner_obligations).toEqual(obligationsFromPlan(models(invariants)));
    expect(state.owner_obligations?.map(({ invariant }) => invariant)).toEqual(["INV-2", "INV-3"]);
    expect(state.owner_obligations?.[0]).toEqual({
      invariant: "INV-2",
      title: "Rule INV-2",
      statement: "The INV-2 rule holds.",
      owner: "src/rule-owner.ts",
      siblings: [{ path: "src/rule-sibling.ts", note: "the second entry point" }],
      matrixTest: "tests/rule.matrix.test.ts",
      mutation: { kind: "verify" },
    } satisfies OwnerObligation);
  });

  it("gives a stamped graph an owner check even for a Wave that owes nothing", () => {
    const state = populated(graph(), command({ invariants: [ownedInvariant("INV-1")] }));
    expect(ownerCheckAuthority(state, 1)?.owed).toEqual(["INV-1"]);
    expect(ownerCheckAuthority(state, 2)?.owed).toEqual([]);
    const empty = populated(graph(), command({ invariants: [] }));
    expect(ownerCheckAuthority(empty, 1)).not.toBeNull();
  });

  it("re-population replaces the stamp, never merging the old one", () => {
    const first = populated(graph(), command({ invariants: [ownedInvariant("INV-1"), ownedInvariant("INV-2")] }));
    expect(first.owner_obligations).toHaveLength(2);
    const replaced = populated(first, command({ invariants: [ownedInvariant("INV-9")] }));
    expect(replaced.owner_obligations?.map(({ invariant }) => invariant)).toEqual(["INV-9"]);
    const emptied = populated(replaced, command({ invariants: [] }));
    expect(emptied.owner_obligations).toEqual([]);
  });

  it("re-population stamps a graph that was populated before owner verification", () => {
    const preFeature = withoutStamp(populated(graph(), command({ invariants: [] })));
    expect("owner_obligations" in preFeature).toBe(false);
    const restamped = populated(preFeature, command({ invariants: [ownedInvariant("INV-4")] }));
    expect(restamped.owner_obligations?.map(({ invariant }) => invariant)).toEqual(["INV-4"]);
  });
});

describe("FR-004: a graph without the stamp owes nothing", () => {
  it("has no owner check and owes no Invariant in any Wave", () => {
    const preFeature = withoutStamp(populated(graph(), command({ invariants: [ownedInvariant("INV-1")] })));
    for (const wave of [1, 2]) {
      expect(ownerVerificationOwed(preFeature, wave)).toEqual([]);
      expect(ownerCheckAuthority(preFeature, wave)).toBeNull();
    }
  });
});

describe("owner-verification-runner-missing refusal", () => {
  it("refuses a non-exempt owned Invariant when the frozen manifest has no affectedRunner", () => {
    const result = populateTaskGraph(graph(), command({
      verificationManifest: WITHOUT_RUNNER(),
      invariants: [ownedInvariant("INV-1"), ownedInvariant("INV-2", { kind: "exempt", reason: "generated code" })],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("owner-verification-runner-missing");
    expect(result.error.message).toContain("INV-1");
    expect(result.error.message).not.toContain("INV-2");
    expect(result.error.message).toContain("affectedRunner");
  });

  it("refuses under the engine-default manifest too, which never carries an affectedRunner", () => {
    const result = populateTaskGraph(graph(), command({
      verificationManifest: defaultVerificationManifest(),
      invariants: [ownedInvariant("INV-1")],
    }));
    expect(!result.ok && result.error.kind).toBe("owner-verification-runner-missing");
  });

  it("populates an exempt-only plan without a runner and records the exemption and its reason (AS-018)", () => {
    const state = populated(graph(), command({
      verificationManifest: WITHOUT_RUNNER(),
      invariants: [ownedInvariant("INV-1", { kind: "exempt", reason: "owner is generated from a schema" })],
    }));
    expect(state.owner_obligations?.[0]?.mutation).toEqual({ kind: "exempt", reason: "owner is generated from a schema" });
  });

  it("populates a plan with no owned Invariant without a runner", () => {
    const state = populated(graph(), command({
      verificationManifest: WITHOUT_RUNNER(),
      invariants: [unownedInvariant("INV-1")],
    }));
    expect(state.owner_obligations).toEqual([]);
  });

  it("populates a non-exempt owned Invariant when the frozen manifest carries an affectedRunner", () => {
    const state = populated(graph(), command({ invariants: [ownedInvariant("INV-1")] }));
    expect(state.owner_obligations).toHaveLength(1);
  });
});
