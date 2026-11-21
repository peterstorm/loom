/**
 * A reopening names what the Finding needs (ADR-0093): `reopen-task --needs
 * tests` reopens a Task whose Finding new test rows close. Its Proof owes
 * changed test files, unchanged implementation files and regression, and no
 * I6 order. Pinned here: the argument grammar, the decision and its
 * refusals, the State File boundary (the scope proven against the reopening
 * audit it names and the frozen classification), the Proof derivation and
 * evaluation, the baseline the first attempt captures, the settlement
 * lifecycle that ends the scope (pure and against a temp repository), the
 * operations beside a tests-only Task, retro facts, and the brief. The
 * default path is pinned unchanged beside each.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { DeclaredArtifactBaseline } from "../../src/core/artifact-baseline";
import { renderImplementationBrief, RULE_DOCUMENTS, type RuleDocument } from "../../src/core/implementation-brief";
import {
  buildTaskLocalByteObservation,
  NO_ENGINE_SKELETONS,
  settleObservedImplementation,
  type TaskLocalByteObservation,
} from "../../src/core/implementation-application";
import { armImplementationAttestation } from "../../src/core/implementation-lifecycle";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  deriveProofObligations,
  evaluateProofObligations,
  evaluateTaskProof,
  isTestsOnlyProof,
  parseTaskProof,
  redThenGreenScope,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofObligation,
  type SatisfiedTaskProof,
  type TaskProof,
} from "../../src/core/proof-obligations";
import { parseReopenBaseline, reopeningNeedsOf } from "../../src/core/reopen-scope";
import { retroFacts } from "../../src/core/retro-facts";
import { renderWaveDigest } from "../../src/core/retro-status";
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import {
  parseTaskReopeningArgs,
  reopenImplementedTasks,
  type TaskReopening,
  type TaskReopeningRefusal,
  type TaskReopeningRequest,
} from "../../src/core/task-reopening";
import { parseTaskRescopeArgs, rescopeTask } from "../../src/core/task-rescope";
import { returnToRevalidation } from "../../src/core/task-revalidation";
import { registerTaskExecutionBaseline } from "../../src/core/validate-task-execution";
import {
  parseVerificationPolicy,
  REQUIRED_VERIFICATION_POLICY,
  type StoredVerificationPolicy,
} from "../../src/core/verification-policy";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { reconcileTaskFromStoredEvidence } from "../../src/handlers/helpers/reconcile-implementation-proof";
import { observeTaskLocalCompletion, REAL_TASK_LOCAL_PORTS } from "../../src/handlers/helpers/task-local-completion";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import { parseTaskGraph, taskUnionError } from "../../src/state-file-wire";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN, parseNewTestEvidence, type Task, type TaskGraph } from "../../src/types";
import { captureDeclaredArtifactBaseline } from "../../src/utils/declared-artifact-snapshot";
import { captureRepositoryChangeBaseline } from "../../src/utils/repository-change-baseline";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contract, surface } from "../fixtures/contract-status-fixtures";
import { unobservedSkeletons } from "../fixtures/frozen-signatures";
import { i6PlanTask } from "../fixtures/i6-plan-task";
import { i6RunnerManifest } from "../fixtures/i6-runner-manifest";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import { planOwnership } from "../fixtures/owner-obligation";
import { value } from "../fixtures/parse-result";
import {
  distillTaskFixture,
  fileOf,
  graphFixture,
  protectedGraphFixture,
  satisfiedProof,
  shownRedThenGreen,
  siblingTaskFixture,
  trustedPassEvidence,
} from "../fixtures/task-lifecycle";
import { legacyDefaultVerificationManifest } from "../../src/core/verification-manifest";

const IMPL = "src/order.ts";
const TEST = "src/order.test.ts";
const FILES = [IMPL, TEST] as const;
const REASON = "mutation-1: kill the surviving boundary mutant";

const implemented = (id: string, files: readonly string[] = FILES): Task =>
  i6PlanTask(id, 1, files, {
    status: "implemented", proof: satisfiedProof(files, "owed-if-new-tests"), review_status: "passed", review_generation: 2,
  });

const NEW_TESTS_WAIVED: StoredVerificationPolicy = {
  regression: { kind: "required" }, new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
};
/** The satisfied Proof an I6-era Task under `policy` settled with, having changed `files`. */
function satisfiedUnder(policy: StoredVerificationPolicy, files: readonly string[]): SatisfiedTaskProof {
  const proof = evaluateTaskProof(
    {
      verificationPolicy: value(parseVerificationPolicy(policy)),
      declaredArtifacts: files,
      declaredArtifactExpectation: "changed",
      redThenGreen: "owed-if-new-tests",
    },
    trustedPassEvidence(files, { redThenGreen: shownRedThenGreen(files[0]) }),
  );
  if (proof.state !== "satisfied") throw new Error("fixture Proof must be satisfied");
  return proof;
}
const reparsed = (proof: TaskProof) => parseTaskProof(JSON.parse(JSON.stringify(proof)));

/** Wave 1 current under an I6-era manifest: implemented T1 and T2, no Wave Gate registered. */
function graph(tasks?: readonly Task[], overrides: Record<string, unknown> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    verification_manifest: i6RunnerManifest(),
    tasks: tasks ?? [implemented("T1"), implemented("T2", ["src/pay.ts", "src/pay.test.ts"])],
    wave_gates: { "1": { ...newWaveGate(), impl_complete: true } },
    ...overrides,
  });
}

const request = (needs?: string, taskIds: readonly string[] = ["T1"], reason = REASON): TaskReopeningRequest =>
  value(parseTaskReopeningArgs([
    "--wave", "1", ...taskIds.flatMap((id) => ["--task", id]), "--reason", reason, ...(needs === undefined ? [] : ["--needs", needs]),
  ]));
const TESTS = request("tests");

const reopened = (state: TaskGraph, req = TESTS): TaskReopening => {
  const result = reopenImplementedTasks(state, req);
  if (!result.ok) throw new Error(`expected a reopening, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const committed = (state: TaskGraph, req = TESTS): TaskGraph => {
  const outcome = reopened(state, req);
  if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
  return outcome.graph;
};
const refusal = (state: TaskGraph, req = TESTS): TaskReopeningRefusal => {
  const result = reopenImplementedTasks(state, req);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
};
const byId = (state: TaskGraph, id: string): Task => state.tasks.find((candidate) => candidate.id === id)!;
const kinds = (task: Task): readonly string[] => (task.proof?.obligations ?? []).map(({ kind }) => kind);
const roundTrip = (state: TaskGraph) => parseTaskGraph(JSON.parse(JSON.stringify(state)));
/** `state` with T1 replaced by a freshly implemented T1, as if its reopened lineage settled by default. */
const reimplemented = (state: TaskGraph): TaskGraph =>
  ({ ...state, tasks: state.tasks.map((task) => task.id === "T1" ? implemented("T1") : task) });

const SCOPE = { testFiles: [TEST], implementationFiles: [IMPL], reopening: 0 } as const;
const TESTS_ONLY_OBLIGATIONS: readonly ProofObligation[] = [
  { kind: "task-completed" },
  { kind: "regression-test-pass" },
  { kind: "test-files-changed", testFiles: [TEST], reopening: 0 },
  { kind: "implementation-files-unchanged", implementationFiles: [IMPL] },
];

describe("parseTaskReopeningArgs --needs", () => {
  it("defaults to a full re-implementation and accepts tests in any position", () => {
    expect(request().needs).toBe("implementation");
    expect(request("implementation").needs).toBe("implementation");
    expect(value(parseTaskReopeningArgs(["--needs", "tests", "--wave", "1", "--task", "T1", "--reason", "r"])).needs).toBe("tests");
  });

  it.each([
    [["--wave", "1", "--task", "T1", "--reason", "r", "--needs", "docs"], "--needs must be implementation or tests, not 'docs'"],
    [["--wave", "1", "--task", "T1", "--reason", "r", "--needs", "tests", "--needs", "tests"], "--needs is given twice"],
    [["--wave", "1", "--task", "T1", "--reason", "r", "--needs"], "--needs needs a value"],
  ] as const)("refuses %j", (args, problem) => {
    expect(parseTaskReopeningArgs(args)).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });

  it("asks for the Finding to fix in its usage", () => {
    expect(parseTaskReopeningArgs([])).toMatchObject({ ok: false, error: expect.stringContaining('--reason "<the Finding to fix>"') });
  });
});

describe("reopenImplementedTasks --needs tests", () => {
  it("scopes the named Task to its frozen classification and this reopening's audit, with no I6 owed", () => {
    const outcome = reopened(graph());
    if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
    const t1 = byId(outcome.graph, "T1");
    expect(t1).toMatchObject({ status: "pending", revalidation_required: true });
    expect(t1.reopen_scope).toEqual(SCOPE);
    expect(t1.reopen_baseline).toBeUndefined();
    expect(t1.proof).toMatchObject({ state: "pending", obligations: TESTS_ONLY_OBLIGATIONS });
    expect(kinds(t1)).not.toContain("red-then-green");
    expect(byId(outcome.graph, "T2")).toEqual(byId(graph(), "T2"));
    expect(outcome.graph.task_reopening_history).toEqual([outcome.audit]);
    expect(outcome.audit).toMatchObject({ reopenedTaskIds: ["T1"], needs: "tests" });
    expect(reopeningNeedsOf(outcome.audit)).toBe("tests");
  });

  it("leaves the default reopening exactly as before: kept Proof, no scope, no needs in the audit", () => {
    const outcome = reopened(graph(), request());
    if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
    const t1 = byId(outcome.graph, "T1");
    expect(t1.reopen_scope).toBeUndefined();
    expect(t1.proof).toEqual(byId(graph(), "T1").proof);
    expect(kinds(t1)).toContain("red-then-green");
    expect(outcome.audit).not.toHaveProperty("needs");
    expect(reopened(graph(), request("implementation"))).toEqual(outcome);
  });

  it("tells the dispatched implementer what is owed and that implementation files are off limits", () => {
    const derivation = deriveTaskImplementationDispatch(byId(committed(graph()), "T1"));
    if (derivation.kind !== "dispatch") throw new Error(`expected a dispatch, got ${derivation.kind}`);
    expect(derivation.dispatch).toMatchObject({ kind: "initial-implementation", semanticAttempt: 1 });
    const appendix = derivation.dispatch.promptAppendix ?? "";
    expect(appendix).toContain("Tests-only reopening (BINDING, ADR-0093)");
    expect(appendix).toContain("whose bytes differ from the reopening's when you finish");
    expect(appendix).toContain("A write you fully revert leaves no difference");
    expect(appendix).toContain("No red-then-green order is owed");
    expect(appendix.split("Implementation files (off limits):")[1]).toContain(`\`${IMPL}\``);
    expect(appendix.split("Test files (yours to change):")[1]?.split("Implementation files")[0]).toContain(`\`${TEST}\``);
  });

  it("round-trips the scoped Task and its audit through the State File", () => {
    const state = committed(graph());
    const parsed = roundTrip(state);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(byId(parsed.value, "T1").reopen_scope).toEqual(SCOPE);
    expect(byId(parsed.value, "T1").proof).toEqual(byId(state, "T1").proof);
    expect(parsed.value.task_reopening_history).toEqual(state.task_reopening_history);
  });

  it("is idempotent for the same needs and refuses a conflicting repeat by name", () => {
    const state = committed(graph());
    expect(reopened(state)).toEqual({ kind: "already-reopened", audit: state.task_reopening_history![0] });
    expect(refusal(state, request())).toMatchObject({ kind: "needs-conflict", message: expect.stringContaining("--needs tests") });
    expect(refusal(state, request(undefined, ["T1"], "another reason"))).toMatchObject({ kind: "needs-conflict" });
    expect(refusal(committed(graph(), request()), TESTS)).toMatchObject({ kind: "needs-conflict", message: expect.stringContaining("--needs implementation") });
  });

  it("reopens for tests only again, naming the fresh audit, once the scoped attempt settled", () => {
    const second = committed(reimplemented(committed(graph())));
    expect(second.task_reopening_history).toHaveLength(2);
    expect(byId(second, "T1").reopen_scope).toEqual({ ...SCOPE, reopening: 1 });
    expect(roundTrip(second).ok).toBe(true);
  });

  const waivedRegression: StoredVerificationPolicy = {
    regression: { kind: "waived", reason: "documentation-only" }, new_tests: { kind: "required" },
  };
  const legacyGraph = (tasks: readonly Task[]): TaskGraph => protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [], tasks, wave_gates: { "1": newWaveGate() },
  });
  const legacyImplemented = (id: string): Task =>
    siblingTaskFixture({ id, wave: 1, status: "implemented", spec_anchors: [], spec_contributions: [], review_status: "passed" });
  it.each<[string, () => TaskGraph, string, TaskReopeningRefusal["kind"], string]>([
    ["a Task whose policy waives regression", () => graph([
      i6PlanTask("T1", 1, FILES, {
        status: "implemented", verification_policy: waivedRegression, review_status: "passed", proof: satisfiedUnder(waivedRegression, FILES),
      }),
    ]), "T1", "tests-only-regression-waived", "documentation-only"],
    ["a Task with no test file", () => graph([
      i6PlanTask("T1", 1, [IMPL], {
        status: "implemented", verification_policy: NEW_TESTS_WAIVED, review_status: "passed", proof: satisfiedUnder(NEW_TESTS_WAIVED, [IMPL]),
      }),
    ]), "T1", "tests-only-no-test-files", "names no test file"],
    ["a TaskGraph frozen before the Test-File Classification", () => legacyGraph([legacyImplemented("T1")]),
      "T1", "tests-only-unclassified", "Test-File Classification"],
    ["a Distill Task", () => legacyGraph([
      legacyImplemented("T1"),
      distillTaskFixture({ id: "T9", wave: 1, scope: [fileOf("T1")], status: "implemented" }),
    ]), "T9", "tests-only-distill-task", "Distill Task"],
    ["an Acceptance Contract writer", () => ({
      ...graph(),
      acceptance_contracts: [contract({ id: "CT-1", contractTask: "T1", surface: surface("order"), anchors: ["AS-001"], freeze: { state: "awaiting-red" } })],
    }), "T1", "tests-only-contract-task", "CT-1"],
  ])("refuses %s, changing nothing", (_name, build, target, kind, detail) => {
    const state = build();
    expect(refusal(state, request("tests", [target]))).toMatchObject({ kind, message: expect.stringContaining(detail) });
  });

  it("refuses before the scope when an ordinary precondition fails", () => {
    expect(refusal(graph(), request("tests", ["T9"]))).toMatchObject({ kind: "unknown-task" });
    expect(refusal({ ...graph(), executing_tasks: ["T2"] })).toMatchObject({ kind: "implementation-active" });
  });

  it("sweeps the Wave's implemented Distill Task back with no scope and its behaviour-preserved Proof", () => {
    const withDistill = graph([
      implemented("T1"),
      implemented("T2", ["src/pay.ts", "src/pay.test.ts"]),
      distillTaskFixture({ id: "T9", wave: 1, scope: [IMPL, "src/pay.ts"], status: "implemented" }),
    ]);
    const outcome = reopened(withDistill);
    if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
    const t9 = byId(outcome.graph, "T9");
    expect(t9).toMatchObject({ status: "pending", revalidation_required: true });
    expect(t9.reopen_scope).toBeUndefined();
    expect(kinds(t9)).toEqual(["task-completed", "behaviour-preserved"]);
    expect(outcome.audit).toMatchObject({ reopenedTaskIds: ["T1", "T9"], sweptDistillTaskIds: ["T9"], needs: "tests" });
    expect(byId(outcome.graph, "T1").reopen_scope).toEqual(SCOPE);
    const parsed = roundTrip(outcome.graph);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it("scopes every named Task, for any choice of them, and audits needs once", () => {
    const ids = ["T1", "T2", "T4"] as const;
    const files = (id: string) => [`src/${id}.ts`, `src/${id}.test.ts`];
    const state = graph(ids.map((id) => implemented(id, files(id))));
    fc.assert(fc.property(fc.subarray([...ids], { minLength: 1 }), (chosen) => {
      const next = committed(state, request("tests", chosen));
      for (const id of ids) {
        expect(byId(next, id).reopen_scope === undefined).toBe(!chosen.includes(id));
        if (chosen.includes(id)) expect(isTestsOnlyProof(byId(next, id).proof!.obligations)).toBe(true);
      }
      expect(next.task_reopening_history?.at(-1)).toMatchObject({ needs: "tests" });
      expect(roundTrip(next).ok).toBe(true);
    }));
  });
});

describe("the tests-only Proof", () => {
  const OBLIGATIONS = deriveProofObligations({
    verificationPolicy: REQUIRED_VERIFICATION_POLICY,
    declaredArtifacts: [IMPL, "src/helper.ts", TEST],
    testsOnly: { testFiles: [TEST], implementationFiles: [IMPL, "src/helper.ts"], reopening: 0 },
    redThenGreen: "owed-if-new-tests",
  });
  const evaluate = (filesModified: readonly string[], testResult: "trusted-pass" | "trusted-fail" = "trusted-pass") =>
    evaluateProofObligations(OBLIGATIONS, {
      taskCompleted: true, testResult: { verdict: testResult }, filesModified, contractConformance: CONFORMANCE_NOT_OWED,
    }, TRUSTED_LEDGER_ONLY_POLICY);

  it("owes completion, regression, a changed test file and unchanged implementation files, never I6 or new-tests", () => {
    expect(OBLIGATIONS.map((obligation) => obligation.kind))
      .toEqual(["task-completed", "regression-test-pass", "test-files-changed", "implementation-files-unchanged"]);
  });

  it("is satisfied by a test-only change, with the changed test file as evidence", () => {
    expect(evaluate([TEST])).toMatchObject({
      state: "satisfied",
      evidence: [{ kind: "task-completed" }, { kind: "regression-test-pass" }, { kind: "test-files-changed", changed: [TEST] }, { kind: "implementation-files-unchanged" }],
    });
  });

  it("fails a production write by name, however small", () => {
    expect(evaluate([TEST, "src/helper.ts"])).toMatchObject({
      state: "failed", failures: [{ kind: "implementation-files-changed", artifacts: ["src/helper.ts"] }],
    });
  });

  it("fails an attempt that changed no test file", () => {
    expect(evaluate([])).toMatchObject({ state: "failed", failures: [{ kind: "test-files-not-changed" }] });
    expect(evaluate([IMPL])).toMatchObject({
      state: "failed",
      failures: [{ kind: "test-files-not-changed" }, { kind: "implementation-files-changed", artifacts: [IMPL] }],
    });
  });

  it("still owes the regression pass", () => {
    expect(evaluate([TEST], "trusted-fail")).toMatchObject({ state: "failed", failures: [{ kind: "regression-tests-failed" }] });
  });

  it("is satisfied exactly when a test file changed, no implementation file did and the tests passed", () => {
    const declared = [IMPL, "src/helper.ts", TEST] as const;
    fc.assert(fc.property(fc.subarray([...declared]), fc.boolean(), (changed, passed) => {
      const proof = evaluate(changed, passed ? "trusted-pass" : "trusted-fail");
      const expected = passed && changed.includes(TEST) && !changed.some((file) => file !== TEST);
      expect(proof.state === "satisfied").toBe(expected);
      expect(proof.obligations.some((obligation) => obligation.kind === "red-then-green")).toBe(false);
    }));
  });

  it("round-trips every evaluated result through the Proof parser", () => {
    for (const changed of [[TEST], [], [TEST, IMPL], [IMPL, "src/helper.ts"]]) {
      expect(reparsed(evaluate(changed))).toEqual({ ok: true, value: evaluate(changed) });
    }
  });

  it("refuses a stored result whose evidence or failure names a file outside its obligation, or no reopening", () => {
    const satisfied = JSON.parse(JSON.stringify(evaluate([TEST])));
    satisfied.results[2].evidence.changed = [IMPL];
    satisfied.evidence[2].changed = [IMPL];
    expect(parseTaskProof(satisfied)).toMatchObject({ ok: false });
    const failed = JSON.parse(JSON.stringify(evaluate([TEST, IMPL])));
    failed.results[3].failure.artifacts = [TEST];
    failed.failures[0].artifacts = [TEST];
    expect(parseTaskProof(failed)).toMatchObject({ ok: false });
    const unlinked = JSON.parse(JSON.stringify(evaluate([TEST])));
    delete unlinked.obligations[2].reopening;
    delete unlinked.results[2].obligation.reopening;
    expect(parseTaskProof(unlinked)).toMatchObject({ ok: false });
  });
});

describe("the State File proves a tests-only Task", () => {
  const raw = (state: TaskGraph = committed(graph())): Record<string, unknown> => JSON.parse(JSON.stringify(state));
  const editT1 = (edit: (task: Record<string, unknown>) => Record<string, unknown>, state?: TaskGraph) => {
    const document = raw(state);
    const tasks = document.tasks as Record<string, unknown>[];
    return parseTaskGraph({ ...document, tasks: tasks.map((task) => task.id === "T1" ? edit(task) : task) });
  };
  const scopeOf = (task: Record<string, unknown>) => task.reopen_scope as Record<string, unknown>;
  const ATTEMPT_BASELINE = [{ artifact: IMPL, snapshot: { kind: "missing" } }, { artifact: TEST, snapshot: { kind: "missing" } }];

  it.each<[string, (task: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["lists that do not partition file_list", (task) => ({ ...task, reopen_scope: { ...scopeOf(task), implementationFiles: [] } }), "must partition file_list"],
    ["no test file", (task) => ({ ...task, reopen_scope: { ...scopeOf(task), testFiles: [], implementationFiles: [IMPL, TEST] } }), "at least one test file"],
    ["an unknown field", (task) => ({ ...task, reopen_scope: { ...scopeOf(task), extra: 1 } }), "unexpected field"],
    ["no reopening position", (task) => ({ ...task, reopen_scope: { ...scopeOf(task), reopening: -1 } }), "reopening must be a non-negative"],
    ["a reopen baseline over other files", (task) => ({ ...task, reopen_baseline: [{ artifact: IMPL, snapshot: { kind: "missing" } }] }), "snapshot exactly file_list"],
    ["a registered attempt still awaiting its reopen baseline", (task) => ({ ...task, attempt_artifact_baseline: ATTEMPT_BASELINE }), "requires its captured reopen_baseline"],
    ["a reopen baseline without a scope", (task) => {
      const { reopen_scope: _dropped, ...rest } = task;
      return { ...rest, reopen_baseline: ATTEMPT_BASELINE };
    }, "cannot stand without one"],
    ["attestation mode", (task) => ({ ...task, implementation_attestation: true }), "attestation"],
    ["a waived regression", (task) => ({
      ...task, verification_policy: { regression: { kind: "waived", reason: "documentation-only" }, new_tests: { kind: "required" } },
    }), "regression"],
    ["the scope's Proof without the scope", (task) => {
      const { reopen_scope: _dropped, ...rest } = task;
      return rest;
    }, "proof obligations do not exactly match"],
  ])("refuses %s", (_name, edit, problem) => {
    expect(editT1(edit)).toMatchObject({ ok: false, error: expect.stringContaining(problem) });
  });

  it("refuses a scope naming no tests-only reopening of the Task", () => {
    const relinked = (reopening: number) => (task: Record<string, unknown>) => {
      const proof = task.proof as { obligations: Record<string, unknown>[]; results: { obligation: Record<string, unknown> }[] };
      const link = (obligation: Record<string, unknown>) => obligation.kind === "test-files-changed" ? { ...obligation, reopening } : obligation;
      return {
        ...task,
        reopen_scope: { ...scopeOf(task), reopening },
        proof: { ...proof, obligations: proof.obligations.map(link), results: proof.results.map((result) => ({ ...result, obligation: link(result.obligation) })) },
      };
    };
    expect(editT1(relinked(1))).toMatchObject({ ok: false, error: expect.stringContaining("names no task_reopening_history entry") });
    // A default reopening of T1 first, then the tests-only one at position 1: position 0 is no tests-only reopening.
    const both = committed(reimplemented(committed(graph(), request())));
    expect(editT1(relinked(0), both)).toMatchObject({ ok: false, error: expect.stringContaining('did not record needs "tests"') });
  });

  it("refuses a scope, and the Proof derived from it, whose files are not the frozen classification of file_list", () => {
    const swapped = (obligation: Record<string, unknown>) => {
      if (obligation.kind === "test-files-changed") return { ...obligation, testFiles: [IMPL] };
      return obligation.kind === "implementation-files-unchanged" ? { ...obligation, implementationFiles: [TEST] } : obligation;
    };
    const misclassified = editT1((task) => {
      const proof = task.proof as { obligations: Record<string, unknown>[]; results: { obligation: Record<string, unknown> }[] };
      return {
        ...task,
        reopen_scope: { testFiles: [IMPL], implementationFiles: [TEST], reopening: 0 },
        proof: { ...proof, obligations: proof.obligations.map(swapped), results: proof.results.map((result) => ({ ...result, obligation: swapped(result.obligation) })) },
      };
    });
    expect(misclassified).toMatchObject({ ok: false, error: expect.stringContaining("not the frozen Test-File Classification") });
  });

  it("refuses an Acceptance Contract writer's tests-only scope", () => {
    const t1 = (raw().tasks as Record<string, unknown>[]).find((task) => task.id === "T1");
    const writers = redThenGreenScope(i6RunnerManifest(), [{ id: "CT-1", contractTask: "T1" }]);
    expect(taskUnionError(t1, 0, writers)).toContain("an Acceptance Contract writer cannot be reopened for tests only");
  });

  it("refuses a scope on an implemented Task and an audit that spells out the default", () => {
    const document = raw();
    const tasks = document.tasks as Record<string, unknown>[];
    const onImplemented = parseTaskGraph({
      ...document,
      tasks: tasks.map((task) => task.id === "T2" ? { ...task, reopen_scope: { testFiles: ["src/pay.test.ts"], implementationFiles: ["src/pay.ts"], reopening: 0 } } : task),
    });
    expect(onImplemented).toMatchObject({ ok: false, error: expect.stringContaining("requires pending status") });
    const history = document.task_reopening_history as Record<string, unknown>[];
    const spelled = parseTaskGraph({ ...document, task_reopening_history: history.map((audit) => ({ ...audit, needs: "implementation" })) });
    expect(spelled).toMatchObject({ ok: false, error: expect.stringContaining('needs must be "tests"') });
  });
});

// --- The attempt lifecycle: registration, settlement, the end of the scope ---

type Bytes = Readonly<Record<string, string>>;
const REOPENED: Bytes = { [IMPL]: "1", [TEST]: "2" };
const snapshot = (bytes: Bytes): readonly DeclaredArtifactBaseline[] =>
  FILES.map((artifact) => ({ artifact, snapshot: { kind: "sha256" as const, digest: (bytes[artifact] ?? "0").repeat(64) } }));

function authority(semanticAttempt: 1 | 2, before: Bytes): ImplementationAttemptAuthority {
  return value(createImplementationAttemptAuthority({
    taskId: "T1", wave: 1, semanticAttempt, reservationId: `tests-only-${semanticAttempt}`,
    headSha: "a".repeat(40), reservedAt: `2026-11-18T00:00:0${semanticAttempt}.000Z`,
    taskScopeBaseline: snapshot(before), dirtySetBaseline: [],
  }));
}

/** `state` with T1's attempt registered over `proofBaseline`, as registration writes it. */
function registered(
  state: TaskGraph,
  attempt: ImplementationAttemptAuthority,
  proofBaseline: readonly DeclaredArtifactBaseline[],
  repositoryBaseline: readonly DeclaredArtifactBaseline[] = [],
): TaskGraph {
  return {
    ...state,
    executing_tasks: ["T1"],
    tasks: state.tasks.map((task) => task.id !== "T1" ? task : {
      ...registerTaskExecutionBaseline(task, attempt.headSha, proofBaseline, proofBaseline, repositoryBaseline),
      active_implementation_attempt: attempt,
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
      reserved_at: attempt.reservedAt,
    }),
  };
}

const settle = (state: TaskGraph, attempt: ImplementationAttemptAuthority, bytes: TaskLocalByteObservation) => {
  const result = settleObservedImplementation(
    state, attempt, `2026-11-18T00:05:0${attempt.semanticAttempt}.000Z` as never,
    { taskCompleted: true, contractConformance: CONFORMANCE_NOT_OWED, newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN, testResult: { verdict: "trusted-pass" } },
    TRUSTED_LEDGER_ONLY_POLICY,
    bytes,
  );
  if (result.kind !== "applied") throw new Error(`expected an applied settlement, got ${result.kind}`);
  return result;
};

/** Settle T1's registered attempt, which left the files at `after`. */
function settled(state: TaskGraph, attempt: ImplementationAttemptAuthority, before: Bytes, after: Bytes) {
  const t1 = byId(state, "T1");
  const written = FILES.filter((file) => before[file] !== after[file]);
  return settle(state, attempt, buildTaskLocalByteObservation({
    attemptBaseline: snapshot(before),
    currentAttemptScope: snapshot(after),
    proofBaseline: t1.artifact_baseline,
    currentProofScope: snapshot(after),
    ...(t1.reopen_baseline === undefined ? {} : { reopenScope: { baseline: t1.reopen_baseline, current: snapshot(after) } }),
    parserModifiedPaths: written,
    priorAttributedPaths: [],
    repositoryChangedPaths: [],
    siblingOwnedPaths: [],
    engineSkeletons: NO_ENGINE_SKELETONS,
  }));
}

describe("a tests-only attempt from reopening to settlement", () => {
  it("captures the reopen baseline at the first registration and keeps it on later ones", () => {
    const first = registered(committed(graph()), authority(1, REOPENED), snapshot(REOPENED));
    expect(byId(first, "T1").reopen_baseline).toEqual(snapshot(REOPENED));
    const again = registerTaskExecutionBaseline(byId(first, "T1"), "a".repeat(40), snapshot({ [IMPL]: "9", [TEST]: "9" }));
    expect(again.reopen_baseline).toEqual(snapshot(REOPENED));
    expect(registerTaskExecutionBaseline(implemented("T2"), "a".repeat(40), snapshot(REOPENED)).reopen_baseline).toBeUndefined();
    expect(parseReopenBaseline(JSON.parse(JSON.stringify(byId(first, "T1").reopen_baseline)), FILES)).toEqual({ ok: true, value: snapshot(REOPENED) });
  });

  it("settles a test-only change implemented with no I6, ends the scope, and keeps the tests-only Proof as the record", () => {
    const first = authority(1, REOPENED);
    const result = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, { ...REOPENED, [TEST]: "3" });
    expect(result.transition.kind).toBe("implemented");
    const t1 = byId(result.state, "T1");
    expect(t1.reopen_scope).toBeUndefined();
    expect(t1.reopen_baseline).toBeUndefined();
    expect(t1.proof).toMatchObject({ state: "satisfied", obligations: TESTS_ONLY_OBLIGATIONS });
    const parsed = roundTrip(result.state);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it("refuses a settled tests-only Proof once its reopening audit no longer backs it", () => {
    const first = authority(1, REOPENED);
    const result = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, { ...REOPENED, [TEST]: "3" });
    const orphaned = { ...result.state, task_reopening_history: undefined };
    expect(roundTrip(orphaned)).toMatchObject({ ok: false, error: expect.stringContaining("names no task_reopening_history entry") });
  });

  it("fails a production write, keeps the scope for the retry, and measures the retry from the same reopen baseline", () => {
    const first = authority(1, REOPENED);
    const cosmetic = { [IMPL]: "4", [TEST]: "3" };
    const retry = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, cosmetic);
    expect(retry.transition).toMatchObject({ kind: "retry-required", receipt: { failureKinds: ["proof:implementation-files-changed"] } });
    expect(byId(retry.state, "T1").reopen_baseline).toEqual(snapshot(REOPENED));
    expect(roundTrip(retry.state).ok).toBe(true);

    // Attempt 2 leaves the production write in place and only touches the test: still a production change since the reopening.
    const second = authority(2, cosmetic);
    const laundered = settled(registered(retry.state, second, snapshot(cosmetic)), second, cosmetic, { ...cosmetic, [TEST]: "5" });
    expect(laundered.transition).toMatchObject({ kind: "escalation-required", receipt: { failureKinds: ["proof:implementation-files-changed"] } });
  });

  it("settles a retry that reverts the production write", () => {
    const first = authority(1, REOPENED);
    const cosmetic = { [IMPL]: "4", [TEST]: "3" };
    const retry = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, cosmetic);
    const second = authority(2, cosmetic);
    const reverted = settled(registered(retry.state, second, snapshot(cosmetic)), second, cosmetic, { ...cosmetic, [IMPL]: "1" });
    expect(reverted.transition.kind).toBe("implemented");
  });

  it("ends the scope at escalation with the default Proof, so remediation dispatches a full re-implementation", () => {
    const first = authority(1, REOPENED);
    const retry = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, REOPENED);
    expect(retry.transition).toMatchObject({ kind: "retry-required", receipt: { failureKinds: ["proof:test-files-not-changed"] } });
    const second = authority(2, REOPENED);
    const escalated = settled(registered(retry.state, second, snapshot(REOPENED)), second, REOPENED, REOPENED);
    expect(escalated.transition.kind).toBe("escalation-required");
    const t1 = byId(escalated.state, "T1");
    expect(t1.reopen_scope).toBeUndefined();
    expect(t1.reopen_baseline).toBeUndefined();
    expect(t1).toMatchObject({ status: "pending", revalidation_required: true, proof: { state: "pending" } });
    expect(kinds(t1)).toContain("red-then-green");
    const parsed = roundTrip(escalated.state);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  });

  it("re-derives the default Proof when a settled tests-only Task is reopened again by default", () => {
    const first = authority(1, REOPENED);
    const done = settled(registered(committed(graph()), first, snapshot(REOPENED)), first, REOPENED, { ...REOPENED, [TEST]: "3" });
    const again = returnToRevalidation(byId(done.state, "T1"), done.state.verification_manifest);
    expect(again.reopen_scope).toBeUndefined();
    expect(kinds(again)).toContain("red-then-green");
    expect(isTestsOnlyProof(again.proof!.obligations)).toBe(false);
  });
});

describe("a tests-only attempt settled against a repository", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A Git repository holding T1's files, and the reopened graph with T1's attempt registered over them. */
  function repository() {
    const root = canonicalTempDir("loom-tests-only-");
    roots.push(root);
    const git = (...args: readonly string[]) => execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "loom@example.test");
    git("config", "user.name", "Loom Test");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, IMPL), "export const total = (a: number) => a;\n");
    writeFileSync(join(root, TEST), "it('totals', () => {});\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "seed");
    const declared = captureDeclaredArtifactBaseline(root, [...FILES]);
    const dirty = captureRepositoryChangeBaseline(root);
    const attempt = value(createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: "tests-only-repo", headSha: git("rev-parse", "HEAD").trim(),
      reservedAt: "2026-11-18T00:00:01.000Z", taskScopeBaseline: declared, dirtySetBaseline: dirty,
    }));
    const state = registered(committed(graph()), attempt, declared, dirty);
    return { root, attempt, state };
  }
  const observe = (root: string, state: TaskGraph, attempt: ImplementationAttemptAuthority, written: readonly string[]) =>
    observeTaskLocalCompletion({
      repositoryRoot: root, task: byId(state, "T1"), authority: attempt,
      parserModifiedPaths: written.map((path) => join(root, path)), parserPathLabel: "test transcript paths",
      siblingOwnedPaths: [], engineSkeletons: [],
    }, REAL_TASK_LOCAL_PORTS);

  it("settles a test-file edit implemented", () => {
    const { root, attempt, state } = repository();
    writeFileSync(join(root, TEST), "it('totals', () => {});\nit('kills the boundary mutant', () => {});\n");
    const bytes = observe(root, state, attempt, [TEST]);
    expect(bytes.reopenScopeChangedPaths).toEqual([TEST]);
    const result = settle(state, attempt, bytes);
    expect(result.transition.kind).toBe("implemented");
    expect(byId(result.state, "T1").reopen_scope).toBeUndefined();
  });

  it("refuses to observe a registered tests-only attempt whose reopen baseline was never captured", () => {
    const { root, attempt, state } = repository();
    const uncaptured: TaskGraph = {
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== "T1") return task;
        const { reopen_baseline: _missing, ...rest } = task;
        return rest;
      }),
    };
    writeFileSync(join(root, TEST), "it('totals', () => {});\nit('kills the boundary mutant', () => {});\n");
    const bytes = observe(root, uncaptured, attempt, [TEST]);
    expect(bytes.byteScope).toMatchObject({
      kind: "observation-unavailable",
      reason: expect.stringContaining("without capturing its reopen baseline"),
    });
  });
});

describe("operations beside a tests-only Task", () => {
  it("refuses to arm attestation", () => {
    expect(armImplementationAttestation(byId(committed(graph()), "T1"), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "tests-only-not-attestable", taskId: "T1" } });
  });

  it("is left to its attempt by reconcile, however satisfied its stored evidence looks", () => {
    const t1: Task = { ...byId(committed(graph()), "T1"), test_result: { verdict: "trusted-pass" }, files_modified: [TEST] };
    const reconciled = reconcileTaskFromStoredEvidence(
      t1, [TEST], parseNewTestEvidence(true, "1 new test"), i6RunnerManifest(), CONFORMANCE_NOT_OWED,
    );
    expect(reconciled).toBe(t1);
  });

  it("re-scopes it before its first attempt, re-classifying its files, and refuses once the attempt measured from a baseline", () => {
    const state = committed(graph());
    const add = value(parseTaskRescopeArgs(["--task", "T1", "--add-file", "src/order-edge.test.ts", "--reason", "the matrix row lives here"]));
    const rescoped = rescopeTask(state, add, null);
    if (!rescoped.ok || rescoped.value.kind !== "rescoped") throw new Error(`expected a re-scope, got ${JSON.stringify(rescoped)}`);
    const t1 = byId(rescoped.value.graph, "T1");
    expect(t1.reopen_scope).toEqual({ testFiles: [TEST, "src/order-edge.test.ts"], implementationFiles: [IMPL], reopening: 0 });
    expect(t1.proof?.obligations).toContainEqual({ kind: "test-files-changed", testFiles: [TEST, "src/order-edge.test.ts"], reopening: 0 });
    expect(roundTrip(rescoped.value.graph).ok).toBe(true);

    const attempted = settled(registered(state, authority(1, REOPENED), snapshot(REOPENED)), authority(1, REOPENED), REOPENED, REOPENED).state;
    expect(rescopeTask(attempted, add, null)).toMatchObject({ ok: false, error: { kind: "tests-only-attempted" } });
  });

  it("refuses to re-scope away its only test file, changing nothing", () => {
    // New tests waived, so only the tests-only scope (not I6) needs the test file.
    const waived = i6PlanTask("T1", 1, FILES, {
      status: "implemented", verification_policy: NEW_TESTS_WAIVED, review_status: "passed", proof: satisfiedUnder(NEW_TESTS_WAIVED, FILES),
    });
    const state = committed(graph([waived]));
    const before = JSON.stringify(state);
    const remove = value(parseTaskRescopeArgs(["--task", "T1", "--remove-file", TEST, "--reason", "drop the test"]));
    expect(rescopeTask(state, remove, null)).toMatchObject({ ok: false, error: { kind: "tests-only-no-test-files" } });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("retro facts count tests-only reopenings apart", () => {
  it("counts one default and one tests-only reopening of a Task", () => {
    const state = committed(reimplemented(committed(graph(), request())));
    const wave = retroFacts(state).waves[0]!;
    expect(wave).toMatchObject({ taskReopenings: 2, testsOnlyReopenings: 1 });
    expect(wave.tasks.find(({ taskId }) => taskId === "T1")).toMatchObject({ reopenings: 2, testsOnlyReopenings: 1 });
    expect(renderWaveDigest(wave)).toContain("2 Task reopenings, 1 tests-only reopening");
  });

  it("prints no tests-only count when there was none", () => {
    const wave = retroFacts(committed(graph(), request())).waves[0]!;
    expect(wave.testsOnlyReopenings).toBe(0);
    expect(renderWaveDigest(wave)).not.toContain("tests-only");
  });
});

describe("the brief for a tests-only attempt", () => {
  const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
  const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
    [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

  const render = (task: Task) => {
    const derivation = deriveTaskImplementationDispatch(task);
    if (derivation.kind !== "dispatch") throw new Error(`expected a dispatch, got ${derivation.kind}`);
    const rendered = renderImplementationBrief({
      template: TEMPLATE, task, dispatch: derivation.dispatch, verificationManifest: i6RunnerManifest(),
      planFile: null, spec: { kind: "unavailable", reason: { kind: "no-spec-file" } }, rules: RULES, roster: [task],
      ownership: planOwnership(), contracts: [], repositoryRoot: "/repo", commands: loomCommandsAt("/loom"),
      operatorNotes: [], frozenSignatures: unobservedSkeletons(graphFixture([task])),
    });
    if (!rendered.ok) throw new Error(rendered.error.message);
    return rendered.value.prompt;
  };

  it("states the tests-only obligations, lists the off-limits files and owes no I6 section", () => {
    const prompt = render(byId(committed(graph()), "T1"));
    expect(prompt).toContain("Reopened for tests only (ADR-0093) — BINDING.");
    expect(prompt).toContain("Tests-only reopening (BINDING, ADR-0093)");
    expect(prompt).not.toContain("I6 red-then-green — BINDING");
  });

  it("keeps the I6 section on a default reopening", () => {
    const prompt = render(byId(committed(graph(), request()), "T1"));
    expect(prompt).toContain("I6 red-then-green — BINDING");
    expect(prompt).not.toContain("Reopened for tests only");
  });
});
