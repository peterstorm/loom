/**
 * The red-then-green duty is decided once (`redThenGreenOwing`, INV-6).
 *
 * It used to be decided in four places: `deriveProofObligations` (policy and
 * the Task's era), task-scope-rules' `owesRedThenGreen` (policy and era),
 * the Red-Then-Green Status's `notOwedReason` (re-deriving the era, the
 * contract writer and the waiver) and `redThenGreenDuty` (the frozen Proof).
 * The first three now consume the rule; the fourth stays the frozen Proof's
 * reader. These properties compare every consumer, over generated Tasks and
 * TaskGraphs, against the retired decisions, copied here verbatim as the
 * oracle, so the refactor provably changed no answer.
 */

import fc from "fast-check";
import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import { redThenGreenDuty } from "../../src/core/implementation-application";
import {
  deriveProofObligations,
  derivePendingTaskProof,
  redThenGreenOwing,
  redThenGreenScope,
  taskRedThenGreenEra,
  writtenContract,
  type RedThenGreenEra,
  type RedThenGreenScope,
} from "../../src/core/proof-obligations";
import { redThenGreenStatusView, type NotOwedReason } from "../../src/core/red-then-green-status";
import { rosterScopeProblems, type ScopeAuthority, type ScopedTask } from "../../src/core/task-scope-rules";
import { isTestFileBySuffixes } from "../../src/core/test-file-classification";
import { legacyDefaultVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import {
  COVERED_BY_ACCEPTANCE_CONTRACT,
  NEW_TEST_WAIVER_REASONS,
  REGRESSION_WAIVER_REASONS,
  requiresNewTests,
  taskVerificationPolicy,
  type VerificationPolicy,
} from "../../src/core/verification-policy";
import type { Task, TaskGraph } from "../../src/types";
import { I6_MANIFEST, base } from "../fixtures/red-then-green-status-fixtures";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

// --- The retired decisions, verbatim ---

const retiredTaskEra = (scope: RedThenGreenScope, taskId: string): RedThenGreenEra =>
  writtenContract(scope, taskId) === undefined ? scope.era : "not-owed";

const retiredScopeOwes = (task: ScopedTask, { manifest, contracts }: ScopeAuthority): boolean =>
  requiresNewTests(task.policy) && retiredTaskEra(redThenGreenScope(manifest, contracts), task.id) === "owed-if-new-tests";

const retiredDerivationOwes = (policy: VerificationPolicy, era: RedThenGreenEra | undefined): boolean =>
  requiresNewTests(policy) && era === "owed-if-new-tests";

function retiredNotOwedReason(task: Task, graph: TaskGraph): NotOwedReason {
  const scope = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
  if (scope.era === "not-owed") return { kind: "predates-i6" };
  const contract = writtenContract(scope, task.id);
  if (contract !== undefined) return { kind: "contract-writer", contract };
  return match(taskVerificationPolicy(task).newTests)
    .returnType<NotOwedReason>()
    .with({ kind: "waived", reason: COVERED_BY_ACCEPTANCE_CONTRACT }, () => ({ kind: "claimant" }))
    .with({ kind: "waived" }, ({ reason }) => ({ kind: "new-tests-waived", reason }))
    .with({ kind: "required" }, () => ({ kind: "no-obligation-in-proof" }))
    .exhaustive();
}

// --- Generators ---

const TASK_IDS = ["T1", "T2", "T3"] as const;
const FILES = ["src/a.ts", "src/a.test.ts", "src/b.ts"] as const;

const policy: fc.Arbitrary<VerificationPolicy> = fc.record({
  regression: fc.oneof(
    fc.constant({ kind: "required" as const }),
    fc.constantFrom(...REGRESSION_WAIVER_REASONS).map((reason) => ({ kind: "waived" as const, reason })),
  ),
  newTests: fc.oneof(
    fc.constant({ kind: "required" as const }),
    fc.constantFrom(...NEW_TEST_WAIVER_REASONS).map((reason) => ({ kind: "waived" as const, reason })),
  ),
});

const manifest: fc.Arbitrary<FrozenVerificationManifest | undefined> =
  fc.constantFrom(I6_MANIFEST, legacyDefaultVerificationManifest(), undefined);

const contracts = fc.array(
  fc.record({ id: fc.constantFrom("CT-1", "CT-2", "CT-3"), contractTask: fc.constantFrom(...TASK_IDS, "T9") }),
  { maxLength: 3 },
);

const scopedTask: fc.Arbitrary<ScopedTask> = fc.record({
  id: fc.constantFrom(...TASK_IDS),
  fileList: fc.subarray([...FILES]),
  policy,
});

/** A Task whose frozen Proof was derived under `proofEra`, which may disagree with its graph (INV-6 refuses that on load; the status stays total). */
const statusCase = fc.record({
  manifest,
  contracts,
  taskId: fc.constantFrom(...TASK_IDS),
  policy,
  proofEra: fc.constantFrom<RedThenGreenEra>("owed-if-new-tests", "not-owed"),
}).map(({ manifest: frozen, contracts: written, taskId, policy: verificationPolicy, proofEra }) => {
  const task = taskFixture({
    ...base(taskId, 1, FILES),
    verification_policy: { regression: verificationPolicy.regression, new_tests: verificationPolicy.newTests },
    proof: derivePendingTaskProof({
      declaredArtifactExpectation: "changed",
      verificationPolicy,
      declaredArtifacts: FILES,
      redThenGreen: proofEra,
    }),
  });
  const graph: TaskGraph = {
    ...graphFixture([task]),
    ...(frozen === undefined ? {} : { verification_manifest: frozen }),
    acceptance_contracts: written.map(({ id, contractTask }) => ({
      schemaVersion: 1 as const,
      id,
      title: id,
      statement: "s",
      contractTask,
      types: { kind: "none" as const, reason: "r" },
      acceptance: [{ path: "src/a.test.ts", anchors: ["FR-001"] }],
      supportedDomain: null,
      freeze: { state: "awaiting-red" as const },
      revisions: [],
    })),
  };
  return { task, graph };
});

describe("redThenGreenOwing — the one red-then-green duty rule, against the retired decisions", () => {
  it("owes exactly when task-scope-rules' retired owesRedThenGreen did", () => {
    fc.assert(fc.property(scopedTask, manifest, contracts, (task, frozen, written) => {
      const owing = redThenGreenOwing(redThenGreenScope(frozen, written), task.id, task.policy);
      expect(owing.kind === "owed").toBe(retiredScopeOwes(task, { manifest: frozen, contracts: written }));
    }), { numRuns: 2000 });
  });

  it("keeps each Task's era exactly as taskRedThenGreenEra decided it", () => {
    fc.assert(fc.property(fc.constantFrom(...TASK_IDS, "T9"), manifest, contracts, (taskId, frozen, written) => {
      const scope = redThenGreenScope(frozen, written);
      expect(taskRedThenGreenEra(scope, taskId)).toBe(retiredTaskEra(scope, taskId));
    }), { numRuns: 500 });
  });

  it("derives a red-then-green obligation exactly when the retired derivation did", () => {
    fc.assert(fc.property(
      policy,
      fc.constantFrom<RedThenGreenEra | undefined>("owed-if-new-tests", "not-owed", undefined),
      fc.constantFrom("changed" as const, "attested" as const, "preserved" as const),
      (verificationPolicy, era, declaredArtifactExpectation) => {
        const obligations = deriveProofObligations({
          declaredArtifactExpectation,
          verificationPolicy,
          declaredArtifacts: FILES,
          ...(era === undefined ? {} : { redThenGreen: era }),
        });
        expect(obligations.some(({ kind }) => kind === "red-then-green")).toBe(retiredDerivationOwes(verificationPolicy, era));
      },
    ), { numRuns: 1000 });
  });

  it("refuses the same rosters the retired scope rule refused", () => {
    const suffixes = I6_MANIFEST.testFiles?.suffixes ?? [];
    fc.assert(fc.property(fc.array(scopedTask, { maxLength: 4 }), manifest, contracts, (tasks, frozen, written) => {
      const authority: ScopeAuthority = { manifest: frozen, contracts: written };
      const owing = tasks.filter((task) => retiredScopeOwes(task, authority));
      const classified = frozen?.testFiles !== undefined;
      const expected = [
        ...owing
          .filter((task) => classified && !task.fileList.some((file) => isTestFileBySuffixes(file, suffixes)))
          .map((task) => ({ kind: "no-test-file", taskId: task.id, suffixes })),
        ...(owing.length > 0 && frozen?.affectedRunner === undefined
          ? [{ kind: "no-engine-runner", taskIds: owing.map(({ id }) => id) }]
          : []),
      ];
      expect(rosterScopeProblems(tasks, authority)).toEqual(expected);
    }), { numRuns: 1500 });
  });

  it("explains a not-owed duty with the reason the retired notOwedReason gave", () => {
    fc.assert(fc.property(statusCase, ({ task, graph }) => {
      const view = redThenGreenStatusView({ graph, taskId: task.id, live: { kind: "no-live-attempt" } });
      expect(view.kind).toBe("task");
      if (view.kind !== "task") return;
      const duty = redThenGreenDuty(task, graph.verification_manifest);
      if (duty.kind === "not-owed") {
        expect(view.duty).toEqual({ kind: "not-owed", reason: retiredNotOwedReason(task, graph) });
      } else {
        expect(view.duty.kind).not.toBe("not-owed");
      }
    }), { numRuns: 2000 });
  });

  it("reaches every not-owed reason and every other duty answer", () => {
    const seen = new Set<string>();
    fc.assert(fc.property(statusCase, ({ task, graph }) => {
      const view = redThenGreenStatusView({ graph, taskId: task.id, live: { kind: "no-live-attempt" } });
      if (view.kind === "task") seen.add(view.duty.kind === "not-owed" ? view.duty.reason.kind : view.duty.kind);
    }), { numRuns: 2000 });
    expect([...seen].sort()).toEqual([
      "claimant", "contract-writer", "new-tests-waived", "no-obligation-in-proof", "owed", "predates-i6", "undeterminable",
    ]);
  });
});
