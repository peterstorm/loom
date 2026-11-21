import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { RUN_RETRO_SKIPPED } from "../fixtures/retro-record";
import fc from "fast-check";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { parseWaveArg } from "../../src/handlers/helpers/wave-args";
import {
  archivedCompletionSuite,
  acceptedWaveCompletionSuite,
  completedWaveGateEntry,
  COMPLETION_SUITE_WORKSPACE,
} from "../fixtures/accepted-wave-completion-suite";
import {
  applyGateDecision,
  checkCriticalFindings,
  checkImplementationProof,
  checkNewTests,
  checkReviews,
  checkSpecAlignment,
  checkTestEvidence,
  computeNextWave,
  deriveWaveStartReadiness,
  evaluateWaveGate,
  gateCheckMessage,
  type GateDeps as CoreGateDeps,
} from "../../src/core/wave-gate-checks";
import {
  deriveLoomStatus,
  deriveLoomStatusFromParsedGraph,
  deriveNextAction,
  renderLoomStatusHuman,
  renderLoomStatusJson,
} from "../../src/core/loom-status";
import {
  parseNewTestEvidence,
  type CapturedSpecCheck,
  type Task,
  type TaskGraph,
} from "../../src/types";
import {
  derivePendingTaskProof,
  evaluateTaskProof,
} from "../../src/core/proof-obligations";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import {
  observedEvidence,
  completedWaveGateFixture,
  satisfiedProof as eraSatisfiedProof,
  taskFixture,
  trustedPassEvidence,
  type TaskFixtureInput,
} from "../fixtures/task-lifecycle";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { legacyDefaultVerificationManifest } from "../../src/core/verification-manifest";
import { capturedSpecCheck } from "../../src/core/spec-check";
import { waveGateAuthorityDigest } from "../../src/core/wave-review-authority";
import {
  commitWaveGateCompletion,
  createWaveGateState,
  deriveWaveReadiness,
  isCanonicalWaveReadiness,
  projectWaveGateLifecycle,
  proveWaveGateNextAction,
  reduceWaveGate,
  snapshotActionProofIsExact,
  type WaveGateEvent,
  type WaveGateState,
} from "../../src/core/wave-gate-machine";
import {
  deriveWaveAdvisoryDecisionRequest,
  deriveWaveAdvisoryNextAction,
  deriveWaveGateDriveStep,
  deriveWaveRefutationPlan,
  waveAdvisoryDecisionActionRequest,
} from "../../src/core/wave-gate-preparation";
import { BASE_WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import {
  blockedAction,
  doneAction,
  infrastructureRetryDiagnostic,
  parseArtifactDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  terminalBlockedDiagnostic,
  type CommitProtectedWaveState,
  type EffectReceipt,
} from "../../src/core/orchestration-contract";
import {
  findRegisteredWaveGateCompletionReplay,
  parseActiveWaveGateRegistration,
  parseTaskGraph,
  StateManager,
} from "../../src/state-manager";
import { findingId } from "../fixtures/finding-id";
import { value } from "../fixtures/parse-result";

const satisfiedProof = eraSatisfiedProof([]);

const MODEL_FREE_PLAN_MODELS = Object.freeze({
  lifecycles: Object.freeze([]),
  pipeline: null,
  invariants: Object.freeze([]),
  contracts: Object.freeze([]),
  strays: Object.freeze([]),
});

const baseTask: Task = {
  id: "T1",
  description: "test",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  proof: satisfiedProof,
  depends_on: [],
  test_result: { verdict: "trusted-pass" },
  test_evidence: "vitest: Tests 5 passed",
  new_test_observation: parseNewTestEvidence(true, "1 new test, 1 assertion"),
  review_status: "passed",
  critical_findings: [],
  advisory_findings: [],
};

const taskState = (overrides: Partial<TaskFixtureInput> = {}): Task => taskFixture({
  ...baseTask,
  ...overrides,
});

describe("checkImplementationProof (pure)", () => {
  it("requires both an implementation-bearing status and satisfied proof", () => {
    const failedProof = evaluateTaskProof(
      { declaredArtifactExpectation: "changed", newTestsRequired: false, declaredArtifacts: ["missing.ts"] },
      observedEvidence({ taskCompleted: true, filesModified: [] }),
    );
    expect(checkImplementationProof([baseTask]).passed).toBe(true);
    for (const task of [
      taskState({ status: "pending" }),
      taskState({ status: "pending", proof: failedProof }),
    ]) {
      const result = checkImplementationProof([task]);
      expect(result.passed).toBe(false);
      expect(gateCheckMessage(result)).toContain("T1");
    }
  });
});

describe("checkTestEvidence (pure)", () => {
  it("passes when all tasks have test evidence", () => {
    const result = checkTestEvidence([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("fails when task has a trusted failure", () => {
    const result = checkTestEvidence([{ ...baseTask, test_result: { verdict: "trusted-fail" } }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("FAILED");
    expect(gateCheckMessage(result)).toContain("T1");
  });

  it("fails when task has no test result at all", () => {
    const result = checkTestEvidence([{ ...baseTask, test_result: undefined }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("T1");
  });

  it("fails on an untrusted result that did not claim a pass", () => {
    const result = checkTestEvidence([
      { ...baseTask, test_result: { verdict: "untrusted", passed: false, label: "transcript-regex (fallback)", provenance: "unverified" } },
    ]);
    expect(result.passed).toBe(false);
  });

  it("passes on a labeled untrusted pass (honest tiering — trust gating is separate)", () => {
    const result = checkTestEvidence([
      { ...baseTask, test_result: { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)", provenance: "unverified" } },
    ]);
    expect(result.passed).toBe(true);
  });

  it("passes when task has new_tests_required=false (e.g. ADR writer)", () => {
    const adrTask: Task = {
      ...baseTask,
      id: "T-ADR-1",
      new_tests_required: false,
      test_result: { verdict: "trusted-fail" },
      test_evidence: undefined,
    };
    const result = checkTestEvidence([adrTask]);
    expect(result.passed).toBe(true);
    expect(gateCheckMessage(result)).toContain("not required");
  });
});

describe("checkNewTests (pure)", () => {
  it("passes when all tasks have new tests", () => {
    const result = checkNewTests([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("passes when task has new_tests_required=false", () => {
    const task = taskState({ new_tests_required: false, new_tests_written: false });
    const result = checkNewTests([task]);
    expect(result.passed).toBe(true);
  });

  it("fails when task missing new tests", () => {
    const task = taskState({ new_tests_written: false, new_tests_required: undefined });
    const result = checkNewTests([task]);
    expect(result.passed).toBe(false);
  });
});

describe("checkReviews (pure)", () => {
  it("passes when all tasks reviewed", () => {
    const result = checkReviews([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("passes with blocked review (still reviewed)", () => {
    const result = checkReviews([{ ...baseTask, review_status: "blocked" }]);
    expect(result.passed).toBe(true);
  });

  it("fails for pending review", () => {
    const result = checkReviews([{ ...baseTask, review_status: "pending" }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("Unreviewed");
  });

  it("reports evidence_capture_failed separately", () => {
    const result = checkReviews([{ ...baseTask, review_status: "evidence_capture_failed" }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("Evidence capture failed");
  });
});

describe("checkCriticalFindings (pure)", () => {
  it("passes with no critical findings", () => {
    const result = checkCriticalFindings([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("fails with critical findings", () => {
    const task = { ...baseTask, critical_findings: ["SQL injection", "XSS"] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("2 critical");
  });

  it("handles undefined critical_findings", () => {
    const task = { ...baseTask, critical_findings: undefined };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(true);
  });

  it("filters empty strings in critical_findings array", () => {
    const task = { ...baseTask, critical_findings: ["", "  ", "Real finding"] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("1 critical");
    expect(gateCheckMessage(result)).toContain("Real finding");
    expect(gateCheckMessage(result)).not.toContain('""');
  });

  it("passes when critical_findings only contains empty strings", () => {
    const task = { ...baseTask, critical_findings: ["", "  ", "   "] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(true);
  });
});

describe("checkSpecAlignment (pure)", () => {
  const captured = (overrides: Readonly<{
    wave?: number;
    criticalFindings?: readonly string[];
  }> = {}): CapturedSpecCheck => capturedSpecCheck({
    wave: overrides.wave ?? 1,
    runAt: "",
    criticalFindings: overrides.criticalFindings ?? [],
  });
  const mkState = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
    current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(),
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  });

  it("fails closed when no spec-check data exists", () => {
    const result = checkSpecAlignment(mkState(), 1);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("missing for wave 1");
    expect(gateCheckMessage(result)).toContain("/spec-check");
  });

  it("fails when spec-check for different wave", () => {
    const state = mkState({
      spec_check: captured({ wave: 1 }),
    });
    const result = checkSpecAlignment(state, 2);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("wave 1");
    expect(gateCheckMessage(result)).toContain("not 2");
  });

  it("passes when spec-check matches wave with no criticals", () => {
    const state = mkState({
      spec_check: captured({ wave: 2 }),
    });
    const result = checkSpecAlignment(state, 2);
    expect(result.passed).toBe(true);
  });

  it("fails when spec-check has critical findings", () => {
    const state = mkState({
      spec_check: captured({ criticalFindings: ["drift", "missing"] }),
    });
    const result = checkSpecAlignment(state, 1);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("2 critical");
  });

  it("fails when a forged zero-critical spec-check verdict is BLOCKED", () => {
    const forged = { ...captured(), verdict: "BLOCKED" } as unknown as CapturedSpecCheck;
    const result = checkSpecAlignment(mkState({ spec_check: forged }), 1);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("verdict is BLOCKED");
  });

  // The `captured()` helper cannot produce this verdict — an evidence failure
  // carries a cause and NO counts, which is the whole point of the separate
  // arm — so this branch had no covering case at the wave-gate layer. It is the
  // fail-closed contract the whole review harness rests on: missing evidence
  // must block the wave rather than read as zero findings.
  it("blocks the wave when spec-check evidence capture failed", () => {
    const state = mkState({
      spec_check: {
        wave: 1,
        run_at: "",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "SPEC_CHECK_CRITICAL_COUNT marker not found",
        cause: "transcript",
      },
    });

    const result = checkSpecAlignment(state, 1);

    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("unusable");
    expect(gateCheckMessage(result)).toContain("EVIDENCE_CAPTURE_FAILED");
    // The cause must survive into the operator-facing message, or a re-run is
    // the only way to learn what went wrong.
    expect(gateCheckMessage(result)).toContain("SPEC_CHECK_CRITICAL_COUNT marker not found");
  });

  it("blocks an evidence-failed spec-check before the wave-mismatch check can excuse it", () => {
    const state = mkState({
      spec_check: {
        wave: 2,
        run_at: "",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "transcript truncated",
        cause: "transcript",
      },
    });

    // Wrong wave AND unusable: either way the gate refuses; what must never
    // happen is a pass.
    expect(checkSpecAlignment(state, 1).passed).toBe(false);
    expect(checkSpecAlignment(state, 2).passed).toBe(false);
  });
});

describe("computeNextWave (pure)", () => {
  const mkTask = (wave: number): Task => ({
    ...baseTask,
    id: `T${wave}`,
    wave,
  });

  it("computes next wave from contiguous waves", () => {
    expect(computeNextWave([mkTask(1), mkTask(2), mkTask(3)], 1)).toBe(2);
    expect(computeNextWave([mkTask(1), mkTask(2), mkTask(3)], 2)).toBe(3);
  });

  it("computes next wave from non-contiguous waves", () => {
    expect(computeNextWave([mkTask(1), mkTask(3), mkTask(5)], 1)).toBe(3);
    expect(computeNextWave([mkTask(1), mkTask(3), mkTask(5)], 3)).toBe(5);
  });

  it("returns null when no next wave", () => {
    expect(computeNextWave([mkTask(1), mkTask(2)], 2)).toBeNull();
    expect(computeNextWave([mkTask(1)], 1)).toBeNull();
  });

  it("returns null for empty tasks", () => {
    expect(computeNextWave([], 1)).toBeNull();
  });
});

describe("evaluateWaveGate + applyGateDecision — checks run on the locked state", () => {
  const specCheck = (wave: number): CapturedSpecCheck =>
    capturedSpecCheck({ wave, runAt: "", criticalFindings: [] });

  const activeGate: NonNullable<TaskGraph["active_wave_gate"]> = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: value(parseOrchestrationRunId("evaluate-wave-run")),
    wave: 1,
    authorityDigest: value(parseArtifactDigest("e".repeat(64))),
    revision: 0,
    terminalOutcome: null,
  };

  const mkGraph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
    current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(),
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: "plan.md",
    current_wave: 1,
    spec_check: specCheck(1),
    tasks: [baseTask, { ...baseTask, id: "T2", wave: 2 }],
    wave_gates: { "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false } },
    active_wave_gate: activeGate,
    active_wave_completion_suite: acceptedWaveCompletionSuite(activeGate),
    ...overrides,
  });

  const countingDeps = () => {
    const calls = { loadPlanModels: 0, fileExists: 0 };
    const deps: CoreGateDeps = {
      loadPlanModels: () => {
        calls.loadPlanModels++;
        return { kind: "loaded", models: MODEL_FREE_PLAN_MODELS };
      },
      filePresence: () => {
        calls.fileExists++;
        return { ok: true, exists: true };
      },
      currentWaveWorkspace: COMPLETION_SUITE_WORKSPACE,
    };
    return { deps, calls };
  };

  it("a task-state change AFTER a passing pre-lock read is honored by evaluation (SubagentStop lands before the lock)", () => {
    // The pre-lock read of the graph passes…
    const preRead = mkGraph();
    const deps = countingDeps().deps;
    expect(evaluateWaveGate(preRead, null, deps).verdict.kind).toBe("pass");

    // …then a SubagentStop lands before the locked update: T1 now carries a
    // trusted failure. Evaluation runs on the LOCKED state, so the gate
    // must fail — never force-complete the wave from the stale pre-read.
    const locked = mkGraph({
      tasks: [
        { ...baseTask, test_result: { verdict: "trusted-fail" } },
        { ...baseTask, id: "T2", wave: 2 },
      ],
    });
    const decision = evaluateWaveGate(locked, null, deps);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("T1");
    }
    expect(applyGateDecision(locked, decision)).toBe(locked); // no-op, nothing stamped
  });

  it("fails closed while any selected-wave task is still executing", () => {
    const state = mkGraph({ executing_tasks: ["T1"] });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);

    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("wave tasks still executing: T1");
    }
    expect(gateCheckMessage(decision.checks[0]!)).toContain("T1");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("does not let an executing task from another wave block the selected wave", () => {
    const decision = evaluateWaveGate(
      mkGraph({ executing_tasks: ["T2"] }),
      1,
      countingDeps().deps,
    );

    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: 2 });
  });

  it("a failed proof can never be force-completed into an unloadable graph", () => {
    const failedProof = evaluateTaskProof(
      { declaredArtifactExpectation: "changed", newTestsRequired: false, declaredArtifacts: ["missing.ts"] },
      observedEvidence({ taskCompleted: true, filesModified: [] }),
    );
    const state = mkGraph({
      tasks: [taskState({ status: "pending", proof: failedProof, new_tests_required: false })],
    });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
    expect(gateCheckMessage(decision.checks[1]!)).toContain("proof=failed");
    expect(gateCheckMessage(decision.checks[1]!)).toContain("declared-artifact-not-changed:missing.ts");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("a passing decision carries the wave's task ids and the next wave", () => {
    const decision = evaluateWaveGate(mkGraph(), null, countingDeps().deps);
    expect(decision.wave).toBe(1);
    expect(decision.checks).toHaveLength(10);
    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: 2 });
  });

  it("applyGateDecision completes the wave, stamps every gate invariant, and is idempotent", () => {
    const state = mkGraph({
      wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
    });
    const frozen = JSON.parse(JSON.stringify(state));
    const decision = evaluateWaveGate(state, null, countingDeps().deps);

    const updated = applyGateDecision(state, decision);
    expect(state).toEqual(frozen); // input untouched
    expect(updated.tasks.find((t) => t.id === "T1")?.status).toBe("completed");
    expect(updated.tasks.find((t) => t.id === "T2")?.status).toBe("implemented"); // other waves untouched
    expect(updated.wave_gates["1"]).toMatchObject({
      impl_complete: true,
      tests_passed: true,
      reviews_complete: true,
      blocked: false,
    });
    expect(updated.wave_gates["2"]).toBeDefined();
    expect(updated.current_wave).toBe(2);
    expect(applyGateDecision(updated, decision)).toEqual(updated);
  });

  it("a failing decision names the first failing check and applies as a no-op", () => {
    const state = mkGraph({
      tasks: [{ ...baseTask, test_result: { verdict: "trusted-fail" } }],
    });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("test evidence");
    }
    expect(applyGateDecision(state, decision)).toBe(state); // unchanged, same reference
  });

  it("always rejects an explicit Wave that disagrees with protected current/active authority", () => {
    const decision = evaluateWaveGate(
      mkGraph({ current_wave: 1, spec_check: specCheck(2) }),
      2,
      countingDeps().deps,
    );
    expect(decision.wave).toBe(2);
    expect(decision.verdict).toMatchObject({ kind: "fail" });
    if (decision.verdict.kind === "fail") expect(decision.verdict.reason).toContain("does not match protected current_wave");
  });

  it("an EMPTY wave fails — never a vacuous pass that stamps the gate", () => {
    const decision = evaluateWaveGate(mkGraph(), 7, countingDeps().deps);
    expect(decision.wave).toBe(7);
    expect(decision.checks).toHaveLength(0);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("does not match protected current_wave");
    }
    // …and applying the failing decision is a no-op: nothing completed,
    // no wave_gates["7"] stamped.
    const state = mkGraph();
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("an empty task graph fails the same way (unpopulated graph)", () => {
    const decision = evaluateWaveGate(mkGraph({ tasks: [] }), null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
  });
});

describe("parseWaveArg — an unvalidated Number() would gate wave NaN vacuously", () => {
  it("parses a positive integer and returns null when absent", () => {
    expect(parseWaveArg(["--wave", "2"])).toBe(2);
    expect(parseWaveArg([])).toBeNull();
    expect(parseWaveArg(["--wave"])).toBeNull();
  });

  it("throws on non-numeric, non-integer, and sub-1 values", () => {
    for (const bad of ["abc", "NaN", "1.5", "0", "-1", "Infinity"]) {
      expect(() => parseWaveArg(["--wave", bad]), bad).toThrow("Invalid --wave value");
    }
  });
});

const lifecycleRunId = value(parseOrchestrationRunId("wave-gate-lifecycle-test"));
const lifecycleEffectId = value(parseEffectId("wave-gate-effect-test"));
const infrastructureDiagnostic = value(infrastructureRetryDiagnostic({
  category: "infrastructure-failure",
  runId: lifecycleRunId,
  effectId: lifecycleEffectId,
  message: "retry the durable publication effect",
}));
const recoveryIntent: CommitProtectedWaveState = {
  kind: "commit-protected-wave-state",
  effectId: lifecycleEffectId,
  runId: lifecycleRunId,
  expectedRevision: 0,
  stateDigest: value(parseArtifactDigest("a".repeat(64))),
};
const recoveryReceipt = {
  kind: "protected-wave-state-committed",
  effectId: lifecycleEffectId,
  runId: lifecycleRunId,
  committedRevision: 1,
  stateDigest: value(parseArtifactDigest("a".repeat(64))),
} as EffectReceipt;

function lifecycleCompletionReadiness() {
  const graph = registeredGraph();
  const registration = graph.active_wave_gate!;
  return value(deriveWaveReadiness({
    ...graph,
    active_wave_gate: { ...registration, runId: lifecycleRunId },
    active_wave_completion_suite: archivedCompletionSuite({
      runId: lifecycleRunId,
      wave: registration.wave,
      authorityDigest: registration.authorityDigest,
    }),
  }, statusDeps));
}

function lifecycleCompletionEvent(): Extract<WaveGateEvent, { kind: "completion-committed" }> {
  const readiness = lifecycleCompletionReadiness();
  const committed = value(commitWaveGateCompletion(readiness));
  return { kind: "completion-committed", readiness, receipt: committed.receipt };
}

function lifecycleInitialState() {
  return value(createWaveGateState(lifecycleCompletionReadiness()));
}

function lifecycleStates(): readonly WaveGateState[] {
  const preparing = lifecycleInitialState();
  const awaitingReview = value(reduceWaveGate(preparing, { kind: "preparation-published" }));
  const awaitingRefutation = value(reduceWaveGate(awaitingReview, { kind: "complete-roster-with-criticals" }));
  const awaitingAdvisory = value(reduceWaveGate(awaitingRefutation, { kind: "complete-roster-with-advisories" }));
  const ready = value(reduceWaveGate(awaitingAdvisory, { kind: "advisory-decision-accepted" }));
  const done = value(reduceWaveGate(ready, lifecycleCompletionEvent()));
  const terminal = value(reduceWaveGate(awaitingReview, { kind: "result-rejected", attempt: 2 }));
  const recoverable = value(reduceWaveGate(awaitingRefutation, {
    kind: "recoverable-effect-failed",
    diagnostic: infrastructureDiagnostic,
    intent: recoveryIntent,
  }));
  return [preparing, awaitingReview, awaitingRefutation, awaitingAdvisory, ready, recoverable, done, terminal];
}

function lifecycleEvents(): readonly WaveGateEvent[] {
  return [
    { kind: "preparation-published" },
    { kind: "result-accepted", completeness: "incomplete" },
    { kind: "result-rejected", attempt: 1 },
    { kind: "result-rejected", attempt: 2 },
    { kind: "complete-roster-with-criticals" },
    { kind: "complete-roster-with-advisories" },
    { kind: "complete-roster-clean" },
    { kind: "advisory-decision-accepted" },
    lifecycleCompletionEvent(),
    { kind: "recoverable-effect-failed", diagnostic: infrastructureDiagnostic, intent: recoveryIntent },
    { kind: "recovery-receipt-accepted", receipt: recoveryReceipt },
  ];
}

const reduceWaveGateAtRuntime = reduceWaveGate as unknown as (
  state: WaveGateState,
  event: WaveGateEvent,
) => Readonly<{ ok: boolean; value?: WaveGateState; error?: unknown }>;

function transitionDeclared(state: WaveGateState, event: WaveGateEvent): boolean {
  if (state.kind === "done" || state.kind === "terminal-blocked") return false;
  if (event.kind === "recoverable-effect-failed") return true;
  if (state.kind === "recoverable-blocked") return event.kind === "recovery-receipt-accepted";
  if (state.kind === "preparing") return event.kind === "preparation-published";
  if (state.kind === "awaiting-review-results") {
    return event.kind === "result-accepted" || event.kind === "result-rejected" ||
      event.kind === "complete-roster-with-criticals" || event.kind === "complete-roster-with-advisories" ||
      event.kind === "complete-roster-clean";
  }
  if (state.kind === "awaiting-refutation") {
    return event.kind === "complete-roster-with-advisories" || event.kind === "complete-roster-clean";
  }
  if (state.kind === "awaiting-advisory-decision") return event.kind === "advisory-decision-accepted";
  return event.kind === "completion-committed";
}

describe("LC-1 Wave Gate lifecycle reducer", () => {
  it("makes undeclared transitions unrepresentable at concrete typed call sites", () => {
    const preparing = lifecycleInitialState();
    if (Date.now() < 0) {
      // @ts-expect-error LC-1 declares completion only from ready-to-complete.
      reduceWaveGate(preparing, lifecycleCompletionEvent());
    }
    expect(preparing.kind).toBe("preparing");
  });

  it("rejects every non-safe accepted-result count before lifecycle replay", () => {
    fc.assert(fc.property(
      fc.oneof(
        fc.integer({ max: -1 }),
        fc.double().filter((value) => !Number.isSafeInteger(value)),
      ),
      (acceptedResults) => {
        expect(projectWaveGateLifecycle(lifecycleCompletionReadiness(), {
          batchPublished: true,
          acceptedResults,
          rejectedAttempt: null,
          rosterComplete: false,
          activeCritical: 0,
          advisoryCount: 0,
          advisoryApproved: false,
          committed: null,
        })).toMatchObject({
          ok: false,
          error: { message: "acceptedResults must be a non-negative safe integer" },
        });
      },
    ));
  });

  it("implements the exact declared transitions, including terminal attempt 2", () => {
    const preparing = lifecycleInitialState();
    const awaiting = value(reduceWaveGate(preparing, { kind: "preparation-published" }));
    expect(reduceWaveGate(awaiting, { kind: "result-rejected", attempt: 1 })).toMatchObject({
      ok: true,
      value: { kind: "awaiting-review-results" },
    });
    expect(reduceWaveGate(awaiting, { kind: "result-rejected", attempt: 2 })).toMatchObject({
      ok: true,
      value: { kind: "terminal-blocked", reason: "semantic-attempt-2-rejected" },
    });
  });

  it("records and restores the exact recoverable predecessor only for a matching receipt", () => {
    const awaiting = lifecycleStates().find((state) => state.kind === "awaiting-refutation")!;
    const blocked = value(reduceWaveGate(awaiting, {
      kind: "recoverable-effect-failed",
      diagnostic: infrastructureDiagnostic,
      intent: recoveryIntent,
    }));
    expect(blocked).toMatchObject({ kind: "recoverable-blocked", predecessor: { kind: "awaiting-refutation" } });
    expect(value(reduceWaveGate(blocked, { kind: "recovery-receipt-accepted", receipt: recoveryReceipt }))).toMatchObject({
      kind: "awaiting-refutation",
      runId: lifecycleRunId,
    });
    expect(reduceWaveGate(blocked, {
      kind: "recovery-receipt-accepted",
      receipt: { ...recoveryReceipt, effectId: value(parseEffectId("wrong-effect")) } as EffectReceipt,
    })).toMatchObject({ ok: false, error: { reason: "recovery-receipt-mismatch" } });
  });

  it("property: every undeclared state/event pair rejects and every declared pair is accepted", () => {
    const states = lifecycleStates();
    fc.assert(fc.property(
      fc.constantFrom(...states),
      fc.constantFrom(...lifecycleEvents()),
      (state, event) => {
        const before = JSON.stringify(state);
        const result = reduceWaveGateAtRuntime(state, event);
        expect(result.ok).toBe(transitionDeclared(state, event));
        expect(JSON.stringify(state)).toBe(before);
      },
    ), { numRuns: 500 });
  });

  it("keeps terminal states monotonic for every late event", () => {
    for (const terminal of lifecycleStates().filter((state) => state.kind === "done" || state.kind === "terminal-blocked")) {
      for (const event of lifecycleEvents()) {
        expect(reduceWaveGateAtRuntime(terminal, event)).toMatchObject({ ok: false, error: { reason: "terminal-state" } });
      }
    }
  });

  it("recognises only the readiness snapshot deriveWaveReadiness minted, through read-only predicates", () => {
    const minted = value(deriveWaveReadiness(registeredGraph(), statusDeps));
    expect(isCanonicalWaveReadiness(minted)).toBe(true);
    expect(isCanonicalWaveReadiness({ ...minted })).toBe(false);
    // An unproven snapshot carries neither half of the lifecycle proof pair.
    expect(snapshotActionProofIsExact(minted)).toBe(true);
    expect(snapshotActionProofIsExact({ ...minted, lifecycleCheckpointDigest: minted.readinessDigest })).toBe(false);
  });

  it("rejects forged readiness, wrong-run/revision/digest receipts, and ineligible completion", () => {
    const preparing = lifecycleInitialState();
    const awaiting = value(reduceWaveGate(preparing, { kind: "preparation-published" }));
    const ready = value(reduceWaveGate(awaiting, { kind: "complete-roster-clean" }));
    const valid = lifecycleCompletionEvent();

    expect(reduceWaveGateAtRuntime(ready, {
      ...valid,
      readiness: { ...valid.readiness },
    } as WaveGateEvent)).toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });
    for (const receipt of [
      { ...valid.receipt, runId: value(parseOrchestrationRunId("foreign-wave-run")) },
      { ...valid.receipt, committedRevision: valid.receipt.committedRevision + 1 },
      { ...valid.receipt, stateDigest: value(parseArtifactDigest("f".repeat(64))) },
    ]) {
      expect(reduceWaveGateAtRuntime(ready, { ...valid, receipt } as WaveGateEvent))
        .toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });
    }

    const graph = registeredGraph({ tasks: [{ ...baseTask, test_result: { verdict: "trusted-fail" } }] });
    const ineligible = value(deriveWaveReadiness(graph, statusDeps));
    const ineligibleReceipt = {
      kind: "protected-wave-state-committed" as const,
      effectId: ineligible.completionIntent.effectId,
      runId: ineligible.registration.runId,
      committedRevision: ineligible.registration.revision + 1,
      stateDigest: ineligible.readinessDigest,
    };
    const ineligibleReady = value(createWaveGateState(ineligible));
    const ineligibleAwaiting = value(reduceWaveGate(ineligibleReady, { kind: "preparation-published" }));
    const ineligibleCompletionState = value(reduceWaveGate(ineligibleAwaiting, { kind: "complete-roster-clean" }));
    expect(reduceWaveGate(ineligibleCompletionState, {
      kind: "completion-committed",
      readiness: ineligible,
      receipt: ineligibleReceipt,
    })).toMatchObject({ ok: false, error: { reason: "completion-ineligible" } });
  });

  it("rejects a recoverable failure diagnostic for another run and a matching-id receipt of the wrong kind", () => {
    const preparing = lifecycleInitialState();
    const foreignRun = value(parseOrchestrationRunId("foreign-recovery-run"));
    const foreignDiagnostic = value(infrastructureRetryDiagnostic({
      category: "infrastructure-failure",
      runId: foreignRun,
      effectId: lifecycleEffectId,
      message: "foreign",
    }));
    expect(reduceWaveGate(preparing, {
      kind: "recoverable-effect-failed",
      diagnostic: foreignDiagnostic,
      intent: recoveryIntent,
    })).toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });

    const blocked = value(reduceWaveGate(preparing, {
      kind: "recoverable-effect-failed",
      diagnostic: infrastructureDiagnostic,
      intent: recoveryIntent,
    }));
    expect(reduceWaveGate(blocked, {
      kind: "recovery-receipt-accepted",
      receipt: {
        kind: "agent-requests-reserved",
        runId: lifecycleRunId,
        effectId: lifecycleEffectId,
        requestIds: [value(parseRequestId("wrong-kind-request"))],
      },
    })).toMatchObject({ ok: false, error: { reason: "recovery-receipt-mismatch" } });
  });
});

const statusDeps: CoreGateDeps = {
  loadPlanModels: () => ({ kind: "loaded", models: MODEL_FREE_PLAN_MODELS }),
  filePresence: () => ({ ok: true, exists: true }),
  currentWaveWorkspace: COMPLETION_SUITE_WORKSPACE,
};

function registeredGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const parsed = parseTaskGraph({
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: "plan.md",
    spec_check: {
      wave: 1,
      run_at: "now",
      verdict: "PASSED",
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    },
    tasks: [baseTask],
    wave_gates: {},
    verification_manifest: legacyDefaultVerificationManifest(),
    active_wave_gate: {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: "status-wave-run",
      wave: 1,
      authorityDigest: "b".repeat(64),
      revision: 0,
      terminalOutcome: null,
    },
    active_wave_completion_suite: archivedCompletionSuite({
      runId: "status-wave-run",
      wave: 1,
      authorityDigest: "b".repeat(64),
    }),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.value, ...overrides };
}

describe("canonical Wave Gate readiness and LoomStatus", () => {
  it("derives the complete fact inventory and completion from the same snapshot", () => {
    const graph = registeredGraph();
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    expect(readiness.value.gateDecision).toEqual(evaluateWaveGate(graph, 1, statusDeps));
    const resumeDecision = deriveNextAction(readiness.value);
    expect(resumeDecision.action).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "engine-resume-required", retry: { eligible: true } },
    });
    expect(deriveLoomStatus(readiness.value).next).toEqual(resumeDecision);

    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
    expect(status.schemaVersion).toBe(1);
    expect(Object.keys(status.facts)).toEqual([
      "location", "tasks", "failedProofObligations", "testReadiness", "reviewRuns", "findingCounts",
      "refutationPanelNeed", "waveCompletionSuiteReadiness", "waveGateCompletionEligibility",
    ]);
    expect(status.facts.location).toEqual({ kind: "known", value: { activePhase: "execute", activeWave: 1 } });
    expect(status.facts.tasks).toMatchObject({ kind: "known", value: { counts: { implemented: 1 } } });
    expect(status.facts.waveGateCompletionEligibility).toMatchObject({ kind: "known", value: { kind: "eligible" } });
    expect(status.next.action).toMatchObject({
      kind: "blocked",
      diagnostic: {
        kind: "engine-resume-required",
        retry: { kind: "engine-resume", eligible: true, consumesSemanticAttempt: false },
        recovery: { kind: "resume-orchestration", runId: graph.active_wave_gate!.runId },
      },
    });
    expect(status.next.reasons.some((entry) => entry.kind === "completion-eligible")).toBe(true);
    expect(status.next.reasons.some((entry) => entry.kind === "engine-resume-required" && entry.message.includes("retry eligible"))).toBe(true);
  });

  it("partitions every Task exactly once and reports roster/evidence/finding gaps", () => {
    const pendingProof = derivePendingTaskProof({ declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: [] });
    const tasks: Task[] = [
      { ...taskState({ id: "T1", wave: 1, status: "completed" }),
        critical_findings: ["critical"], advisory_findings: ["advisory"],
        refuted_findings: [{
          finding: { id: findingId("old-1"), agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "old" },
          refutations: [{ lens: "intent", reason: "false positive" }],
        }],
        resolved_findings: [{
          finding: { id: findingId("old-2"), agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "fixed" },
          resolution: {
            kind: "resolved_by_remediation", generation: 1, packet_id: "packet", head_sha: "head",
            expected_agents: ["code-reviewer"],
            assessments: [{ agent: "code-reviewer", finding_id: "old-2", verdict: "resolved_by_remediation", reason: "fixed" }],
          },
        }] },
      { ...taskState({ id: "T2", wave: 2, status: "pending", proof: pendingProof }), review_status: "pending",
        review_generation: 1,
        review_run: {
          generation: 1, packet_id: "packet-2", head_sha: "head", prior_finding_ids: [],
          expected_agents: ["code-reviewer", "comment-analyzer"],
          evidence: [{ agent: "code-reviewer", prior_assessments: [], new_findings: [] }],
        } },
      { ...taskState({ id: "T3", wave: 2, status: "failed" }),
        review_status: "evidence_capture_failed", review_error: "malformed summary",
        review_evidence_failures: ["type-design-analyzer"] },
      taskState({ id: "T4", wave: 2, status: "implemented" }),
      { ...taskState({ id: "T5", wave: 2, status: "pending", proof: pendingProof }), review_status: "pending" },
    ];
    const graph = registeredGraph({ tasks, executing_tasks: ["T2"] });
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    const facts = readiness.value.facts;
    expect(facts.tasks).toEqual({
      kind: "known",
      value: { counts: { pending: 1, running: 1, implemented: 1, blocked: 1, completed: 1 } },
    });
    expect(facts.reviewRuns).toMatchObject({
      kind: "known",
      value: {
        rosterGaps: [{ taskId: "T2", agent: "comment-analyzer" }],
        evidenceFailures: [{ taskId: "T3", agent: "type-design-analyzer", error: "malformed summary" }],
      },
    });
    expect(facts.findingCounts).toEqual({ kind: "known", value: { activeCritical: 1, advisory: 1, resolved: 1, refuted: 1 } });
    if (facts.tasks.kind === "known") {
      expect(Object.values(facts.tasks.value.counts).reduce((sum, count) => sum + count, 0)).toBe(graph.tasks.length);
    }
  });

  it("uses wave-scoped canonical Finding identities when two Tasks emit the same Finding id", () => {
    const shared = {
      id: findingId("code-reviewer-1"),
      agent: "code-reviewer",
      severity: "critical" as const,
      file: null,
      line: null,
      claim: "same local reviewer identity",
    };
    const graph = registeredGraph({
      tasks: [
        { ...baseTask, id: "T1", findings: [shared], critical_findings: [shared.claim], advisory_findings: [] },
        { ...baseTask, id: "T2", findings: [shared], critical_findings: [shared.claim], advisory_findings: [] },
      ],
    });
    const snapshot = value(deriveWaveReadiness(graph, statusDeps));
    expect(snapshot.facts.refutationPanelNeed).toEqual({
      kind: "known",
      value: {
        kind: "needed",
        findingIds: ["T1:code-reviewer-1", "T2:code-reviewer-1"],
        reasons: ["2 active critical Finding(s) require refutation"],
      },
    });
    expect(new Set((snapshot.facts.refutationPanelNeed as { value: { findingIds: readonly string[] } }).value.findingIds).size).toBe(2);
    expect(value(deriveWaveRefutationPlan(snapshot)).findings.map(({ id }) => id)).toEqual([
      "T1:code-reviewer-1",
      "T2:code-reviewer-1",
    ]);
  });

  it("reports a parsed non-execute Phase with activeWave null instead of inventing Wave authority", () => {
    const parsed = parseTaskGraph({ current_phase: "specify", phase_artifacts: {}, skipped_phases: [] });
    const status = deriveLoomStatusFromParsedGraph(parsed, statusDeps);
    expect(status.facts.location).toEqual({
      kind: "known",
      value: { activePhase: "specify", activeWave: null },
    });
    expect(status.facts.waveGateCompletionEligibility).toMatchObject({
      kind: "known",
      value: { kind: "ineligible" },
    });
    expect(status.next.action.kind).toBe("blocked");
  });

  it("malformed authority keeps every category present but unavailable and returns only blocked", () => {
    const malformed = parseTaskGraph({
      current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      tasks: [], wave_gates: {}, active_wave_gate: { schemaVersion: 99 },
    });
    expect(malformed.ok).toBe(false);
    const status = deriveLoomStatusFromParsedGraph(malformed, statusDeps);
    expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
    expect(status.next.action).toMatchObject({
      kind: "blocked",
      diagnostic: {
        kind: "terminal-blocked",
        category: "invalid-authority",
        retry: { kind: "not-retryable", eligible: false },
        recovery: { kind: "inspect-run-and-stop" },
      },
    });
    expect(status.next.reasons).toHaveLength(1);
    expect(status.next.reasons[0].message).toContain("malformed");
  });

  it("makes every status category unavailable for contradictory active authority", () => {
    const base = registeredGraph();
    const terminalHistoryEntry = completedWaveGateFixture({
      runId: "contradictory-history-run",
      wave: 1,
      authorityDigest: "f".repeat(64),
    });
    const withoutRegistration = (graph: TaskGraph): TaskGraph => {
      const { active_wave_gate: _removed, ...rest } = graph;
      return rest;
    };
    const cases: Readonly<Record<string, TaskGraph>> = {
      "absent current_wave": { ...base, current_wave: undefined },
      "registration wave disagrees with current_wave": { ...base, current_wave: 2 },
      // A missing registration is only healthy when the Wave actually owns
      // Tasks; an empty Wave is a corrupt graph, not an implementation window.
      "current Wave owns no Tasks": withoutRegistration(
        registeredGraph({ tasks: [{ ...baseTask, wave: 2 }] }),
      ),
      // A terminal receipt for the current Wave that committedTerminalStatus
      // refused (later Waves still exist) is a contradiction, not a fresh Wave.
      "terminal history contradicts the graph": withoutRegistration(registeredGraph({
        tasks: [
          taskState({ id: "T1", wave: 1, status: "completed" }),
          taskState({ id: "T2", wave: 2 }),
        ],
        wave_gate_history: [terminalHistoryEntry],
      })),
    };
    for (const [label, graph] of Object.entries(cases)) {
      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
      expect(Object.values(status.facts).every((entry) => entry.kind === "unavailable"), label).toBe(true);
      expect(status.next.action, label).toMatchObject({
        kind: "blocked",
        diagnostic: { kind: "terminal-blocked", retry: { eligible: false } },
      });
    }
  });

  // Completion retires the outgoing registration in the same commit that
  // advances current_wave, so an execute Wave carries none for its entire
  // implementation span. That window used to be reported as terminal invalid
  // authority with all fact categories blanked.
  describe("implementation window (execute Wave with no registered gate)", () => {
    const unstarted = (overrides: Partial<TaskGraph> = {}): TaskGraph => {
      const { active_wave_gate: _removed, ...rest } = registeredGraph(overrides);
      return rest;
    };

    it("keeps every fact known and names the implementation still owed", () => {
      const graph = unstarted({
        tasks: [
          taskState({ id: "T1", wave: 1, status: "completed" }),
          taskState({ id: "T2", wave: 1, status: "pending" }),
          taskState({ id: "T3", wave: 1, status: "pending" }),
        ],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(Object.values(status.facts).every((entry) => entry.kind === "known")).toBe(true);
      expect(status.facts.location).toEqual({
        kind: "known",
        value: { activePhase: "execute", activeWave: 1 },
      });
      expect(status.facts.tasks).toMatchObject({
        kind: "known",
        value: { counts: { pending: 2, completed: 1 } },
      });
      expect(status.facts.waveGateCompletionEligibility).toMatchObject({
        kind: "known",
        value: { kind: "ineligible" },
      });
      expect(status.next.action).toMatchObject({
        kind: "blocked",
        diagnostic: {
          kind: "wave-gate-not-started",
          category: "healthy-wave-unstarted",
          retry: { kind: "advance-wave-lifecycle", eligible: true, consumesSemanticAttempt: false },
          recovery: {
            kind: "spawn-wave-implementation",
            wave: 1,
            dispatches: [
              { kind: "initial-implementation", taskId: "T2", semanticAttempt: 1, promptAppendix: null },
              { kind: "initial-implementation", taskId: "T3", semanticAttempt: 1, promptAppendix: null },
            ],
          },
        },
      });
      expect(status.next.reasons.filter((entry) => entry.kind === "wave-implementation-pending")
        .map((entry) => entry.taskId)).toEqual(["T2", "T3"]);
    });

    it("dispatches only inactive Tasks and waits when every outstanding Task is active", () => {
      const activeAuthority = value(createImplementationAttemptAuthority({
        taskId: "T3",
        wave: 1,
        semanticAttempt: 1,
        reservationId: "status-active-attempt",
        headSha: "a".repeat(40),
        reservedAt: "2026-09-01T00:00:01.000Z",
        taskScopeBaseline: [],
        dirtySetBaseline: [],
      }));
      const mixed = unstarted({
        executing_tasks: ["T2"],
        tasks: [
          { ...taskState({ id: "T2", wave: 1, status: "implemented" }), reserved_at: activeAuthority.reservedAt },
          {
            ...taskState({ id: "T3", wave: 1, status: "implemented" }),
            active_implementation_attempt: activeAuthority,
            reserved_at: activeAuthority.reservedAt,
          },
          taskState({ id: "T4", wave: 1, status: "pending" }),
        ],
      });

      const mixedStatus = deriveLoomStatusFromParsedGraph({ ok: true, value: mixed }, statusDeps);
      expect(mixedStatus.next.action).toMatchObject({
        diagnostic: {
          recovery: {
            kind: "spawn-wave-implementation",
            dispatches: [{ taskId: "T4", semanticAttempt: 1 }],
          },
        },
      });
      expect(mixedStatus.next.reasons.filter((entry) => entry.kind === "task-running")
        .map((entry) => entry.taskId)).toEqual(["T2", "T3"]);

      const waiting = unstarted({
        executing_tasks: ["T2"],
        tasks: [
          { ...taskState({ id: "T2", wave: 1, status: "implemented" }), reserved_at: activeAuthority.reservedAt },
          {
            ...taskState({ id: "T3", wave: 1, status: "implemented" }),
            active_implementation_attempt: activeAuthority,
            reserved_at: activeAuthority.reservedAt,
          },
        ],
      });
      const waitingStatus = deriveLoomStatusFromParsedGraph({ ok: true, value: waiting }, statusDeps);
      expect(waitingStatus.next.action).toMatchObject({
        diagnostic: {
          recovery: {
            kind: "await-wave-implementation",
            wave: 1,
            activeTaskIds: ["T2", "T3"],
          },
        },
      });
      expect(waitingStatus.next.reasons.some(({ kind }) => kind === "wave-implementation-pending")).toBe(false);
    });

    it("reports completed or timestamp-less reservation authority as unavailable", () => {
      const completed = unstarted({
        executing_tasks: ["T1"],
        tasks: [{
          ...taskState({ id: "T1", wave: 1, status: "completed" }),
          reserved_at: "2026-09-01T00:00:00.000Z",
        }],
      });
      const completedStatus = deriveLoomStatusFromParsedGraph({ ok: true, value: completed }, statusDeps);
      expect(Object.values(completedStatus.facts).every(({ kind }) => kind === "unavailable")).toBe(true);
      expect(completedStatus.next.reasons[0]?.message).toContain(
        "completed but retains implementation reservation authority",
      );

      const legacy = unstarted({
        executing_tasks: ["T1"],
        tasks: [taskState({ id: "T1", wave: 1, status: "pending" })],
      });
      const legacyStatus = deriveLoomStatusFromParsedGraph({ ok: true, value: legacy }, {
        ...statusDeps,
        implementationReservations: {
          kind: "observed",
          observedAtMs: Date.now(),
          anyActiveForGraph: false,
        },
      });
      expect(Object.values(legacyStatus.facts).every(({ kind }) => kind === "unavailable")).toBe(true);
      expect(legacyStatus.next.reasons[0]?.message).toContain("timestamp-less legacy implementation authority");
    });

    it("re-dispatches only policy-expired reservations when roster observation proves no active Agent", () => {
      const activeAuthority = value(createImplementationAttemptAuthority({
        taskId: "T1",
        wave: 1,
        semanticAttempt: 1,
        reservationId: "status-expired-attempt",
        headSha: "a".repeat(40),
        reservedAt: "2026-09-01T00:00:00.000Z",
        taskScopeBaseline: [],
        dirtySetBaseline: [],
      }));
      const graph = unstarted({
        executing_tasks: ["T1"],
        tasks: [{
          ...taskState({ id: "T1", wave: 1, status: "implemented" }),
          active_implementation_attempt: activeAuthority,
          reserved_at: activeAuthority.reservedAt,
        }],
      });
      const expired = {
        ...statusDeps,
        implementationReservations: {
          kind: "observed" as const,
          observedAtMs: Date.parse(activeAuthority.reservedAt) + 11 * 60_000,
          anyActiveForGraph: false,
        },
      };
      expect(deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, expired).next.action).toMatchObject({
        diagnostic: {
          recovery: {
            kind: "spawn-wave-implementation",
            dispatches: [{ taskId: "T1", semanticAttempt: 1 }],
          },
        },
      });

      const live = {
        ...expired,
        implementationReservations: { ...expired.implementationReservations, anyActiveForGraph: true },
      };
      expect(deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, live).next.action).toMatchObject({
        diagnostic: { recovery: { kind: "await-wave-implementation", activeTaskIds: ["T1"] } },
      });
    });

    const semanticReceipt = (attemptNumber: 1 | 2, history: readonly ImplementationAttemptSettlementReceipt[]) =>
      semanticAttemptReceipt("T1", attemptNumber, history);

    it("publishes the exact attempt-2 prompt appendix after semantic attempt 1", () => {
      const retry = semanticReceipt(1, []);
      const graph = unstarted({
        tasks: [{
          ...taskState({ id: "T1", wave: 1, status: "pending" }),
          implementation_attempt_history: [retry],
          implementation_retry_protocol: 2,
          implementation_retry_history_start: 0,
          failure_reason: `retry-required: ${retry.failureKinds.join(", ")}`,
          retry_count: 1,
        }],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(status.next.action).toMatchObject({
        diagnostic: {
          retry: { eligible: true },
          recovery: {
            kind: "spawn-wave-implementation",
            dispatches: [{
              kind: "retry-implementation",
              taskId: "T1",
              semanticAttempt: 2,
              promptAppendix: expect.stringContaining(retry.receiptId),
            }],
          },
        },
      });
    });

    it("dispatches the exact attempt-2 context after a Wave Gate run was abandoned for changed bytes", () => {
      const retry = semanticReceipt(1, []);
      const registered = registeredGraph();
      const graph = registeredGraph({
        active_wave_gate: {
          ...registered.active_wave_gate!,
          terminalOutcome: { kind: "terminal-abandoned", reason: "reviewed bytes changed", supersededBy: null },
        },
        tasks: [taskState({ id: "T2", status: "implemented" }), {
          ...taskState({ id: "T1", status: "pending" }),
          implementation_attempt_history: [retry],
          implementation_retry_protocol: 2,
          implementation_retry_history_start: 0,
          failure_reason: `retry-required: ${retry.failureKinds.join(", ")}`,
          retry_count: 1,
        }],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(status.facts.location).toEqual({ kind: "known", value: { activePhase: "execute", activeWave: 1 } });
      expect(status.next.action).toMatchObject({
        diagnostic: { recovery: {
          kind: "spawn-wave-implementation", wave: 1,
          dispatches: [{ kind: "retry-implementation", taskId: "T1", semanticAttempt: 2,
            promptAppendix: expect.stringContaining(retry.receiptId) }],
        } },
      });
      expect(graph.active_wave_gate?.terminalOutcome).toEqual({
        kind: "terminal-abandoned", reason: "reviewed bytes changed", supersededBy: null,
      });
      expect(deriveWaveReadiness(graph, statusDeps)).toMatchObject({
        ok: false, error: { reasons: [{ kind: "authority-contradiction" }] },
      });
    });

    it("offers a fresh Wave Gate once implementation is complete after abandonment", () => {
      const registered = registeredGraph();
      const graph = registeredGraph({ active_wave_gate: {
        ...registered.active_wave_gate!,
        terminalOutcome: { kind: "terminal-abandoned", reason: "reviewed bytes changed", supersededBy: null },
      } });
      expect(deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps).next.action)
        .toMatchObject({ diagnostic: { recovery: { kind: "start-wave-gate", wave: 1 } } });
    });

    it("refuses a foreign-wave tombstone", () => {
      const registered = registeredGraph();
      const graph = registeredGraph({ active_wave_gate: {
        ...registered.active_wave_gate!, wave: 2, terminalOutcome: {
          kind: "terminal-abandoned" as const, reason: "foreign", supersededBy: null,
        },
      } });
      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
      expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
      expect(status.next.action).toMatchObject({
        kind: "blocked", diagnostic: { category: "invalid-authority", recovery: { kind: "inspect-run-and-stop" } },
      });
    });

    // Registration admits only the run a tombstone names, so every start
    // recovery under that tombstone must carry that exact run id.
    describe("a tombstone that names its successor", () => {
      const named = (overrides: Partial<TaskGraph> = {}): TaskGraph => {
        const registered = registeredGraph();
        return registeredGraph({
          active_wave_gate: { ...registered.active_wave_gate!, terminalOutcome: {
            kind: "terminal-abandoned" as const, reason: "successor selected",
            supersededBy: value(parseOrchestrationRunId("next-run")),
          } },
          ...overrides,
        });
      };

      it("asks to start exactly the named successor once implementation is complete", () => {
        const status = deriveLoomStatusFromParsedGraph({ ok: true, value: named() }, statusDeps);
        expect(Object.values(status.facts).every((fact) => fact.kind === "known")).toBe(true);
        expect(status.next.action).toMatchObject({
          kind: "blocked",
          diagnostic: {
            kind: "wave-gate-not-started",
            message: "Wave 1 implementation is complete and abandoned Wave Gate run status-wave-run names " +
              "successor next-run; start the Wave Gate with run id next-run",
            recovery: {
              kind: "start-successor-wave-gate", wave: 1, runId: "next-run", abandonedRunId: "status-wave-run",
            },
          },
        });
      });

      it("asks for start repair, not the successor start, while a start prerequisite is unmet", () => {
        const status = deriveLoomStatusFromParsedGraph({
          ok: true,
          value: named({ tasks: [{ ...taskState({ id: "T1", wave: 1, status: "implemented" }), test_result: undefined }] }),
        }, statusDeps);
        expect(status.next.action).toMatchObject({
          diagnostic: { kind: "wave-start-not-ready", recovery: { kind: "repair-wave-start-readiness", wave: 1 } },
        });
      });

      it("keeps owed implementation dispatchable before the successor starts", () => {
        const status = deriveLoomStatusFromParsedGraph({
          ok: true,
          value: named({ tasks: [taskState({ id: "T1", wave: 1, status: "pending" })] }),
        }, statusDeps);
        expect(status.next.action).toMatchObject({
          diagnostic: { recovery: { kind: "spawn-wave-implementation", wave: 1, dispatches: [{ taskId: "T1" }] } },
        });
      });
    });

    // A Run Directory marker under a registration that still reads as live is
    // never resumable (every advancing operation refuses it); status names the
    // identical abandon replay, each argument shell-quoted to the recorded value.
    it.each([
      ["no successor", null, "exhausted reviewers", "", "'exhausted reviewers'"],
      ["a named successor", "next-run", "exhausted reviewers", " --superseded-by 'next-run'", "'exhausted reviewers'"],
      ["a shell-active reason", null, "cost $(x) it's", "", "'cost $(x) it'\\''s'"],
      ["a flag-shaped reason", null, "--force", "", "'--force'"],
    ] as const)("names the stamping abandon replay for an unstamped marker with %s", (_name, supersededBy, reason, flag, quotedReason) => {
      const graph = registeredGraph();
      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps, null, {
        kind: "abandoned",
        runId: "status-wave-run",
        path: "/runs/status-wave-run",
        runsRoot: "/runs",
        reason,
        supersededBy,
      });
      expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
      expect(status.next.action).toMatchObject({ kind: "blocked", diagnostic: { category: "invalid-authority" } });
      expect(status.next.reasons).toEqual([{
        kind: "authority-unavailable",
        taskId: null,
        message: "Wave Gate run status-wave-run was abandoned in its Run Directory (/runs/status-wave-run), " +
          "but its protected registration was never tombstoned, so it cannot be resumed; repeat the identical " +
          `abandon to stamp it: helper orchestration abandon --runs-root '/runs' --run 'status-wave-run'${flag} ` +
          `--reason ${quotedReason}`,
      }]);
      expect(JSON.stringify(status)).not.toContain("resume-orchestration");
    });

    it("reports terminal non-retryable escalation after semantic attempt 2", () => {
      const retry = semanticReceipt(1, []);
      const escalation = semanticReceipt(2, [retry]);
      const graph = unstarted({
        tasks: [{
          ...taskState({ id: "T1", wave: 1, status: "pending" }),
          implementation_attempt_history: [retry, escalation],
          implementation_retry_protocol: 2,
          implementation_retry_history_start: 0,
          failure_reason: `escalation-required: ${escalation.failureKinds.join(", ")}`,
          retry_count: 2,
        }, taskState({ id: "T2", wave: 1, status: "pending" })],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(status.next.action).toMatchObject({
        diagnostic: {
          kind: "implementation-escalation-required",
          category: "semantic-attempts-exhausted",
          retry: { eligible: false, consumesSemanticAttempt: false },
          recovery: {
            kind: "escalate-wave-implementation",
            wave: 1,
            tasks: [{ taskId: "T1", receiptId: escalation.receiptId }],
          },
        },
      });
      expect(status.next.reasons).toContainEqual(expect.objectContaining({
        kind: "implementation-escalation-required",
        taskId: "T1",
      }));
    });

    it("asks for the Wave Gate once every Task in the Wave is implemented", () => {
      const graph = unstarted({
        tasks: [
          taskState({ id: "T1", wave: 1, status: "implemented" }),
          taskState({ id: "T2", wave: 1, status: "completed" }),
        ],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(Object.values(status.facts).every((entry) => entry.kind === "known")).toBe(true);
      expect(status.next.action).toMatchObject({
        kind: "blocked",
        diagnostic: {
          kind: "wave-gate-not-started",
          recovery: { kind: "start-wave-gate", wave: 1 },
        },
      });
      expect(status.next.reasons.some((entry) => entry.kind === "wave-implementation-pending")).toBe(false);
      expect(status.next.reasons.at(-1)).toMatchObject({ kind: "wave-gate-not-started" });
    });

    it("reports unmet start prerequisites instead of advising a start the Wave Gate would refuse", () => {
      const graph = unstarted({
        tasks: [
          taskState({ id: "T1", wave: 1, status: "implemented", new_test_observation: undefined }),
          { ...taskState({ id: "T2", wave: 1, status: "completed" }), test_result: undefined },
        ],
      });
      const readiness = deriveWaveStartReadiness(graph, graph.tasks.filter((entry) => entry.wave === 1));

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(readiness.kind).toBe("not-ready");
      if (readiness.kind !== "not-ready") return;
      expect(readiness.failures).toEqual([
        expect.stringContaining("Not all tasks have test evidence.\n  Missing: T2"),
        expect.stringContaining("Not all tasks satisfied new-test requirement.\n  Missing: T1"),
      ]);
      // Status projects exactly the prerequisites the start refuses on.
      expect(status.next.action).toMatchObject({
        kind: "blocked",
        diagnostic: {
          kind: "wave-start-not-ready",
          category: "wave-start-prerequisites-unmet",
          message: `Wave 1 implementation stopped but the Wave Gate cannot start: ${readiness.failures.join("; ")}`,
          retry: { kind: "advance-wave-lifecycle", eligible: false, consumesSemanticAttempt: false },
          recovery: { kind: "repair-wave-start-readiness", wave: 1, failures: readiness.failures },
        },
      });
      expect(status.next.reasons.at(-1)).toMatchObject({ kind: "wave-start-not-ready" });
    });

    it("advises a start exactly when the shared start readiness is ready", () => {
      const ready = unstarted({ tasks: [taskState({ id: "T1", wave: 1, status: "implemented" })] });
      expect(deriveWaveStartReadiness(ready, ready.tasks)).toEqual({ kind: "ready" });
      expect(deriveLoomStatusFromParsedGraph({ ok: true, value: ready }, statusDeps).next.action)
        .toMatchObject({ diagnostic: { kind: "wave-gate-not-started", recovery: { kind: "start-wave-gate", wave: 1 } } });
    });

    it("scopes the owed implementation to the current Wave, ignoring later Waves", () => {
      const graph = unstarted({
        tasks: [
          taskState({ id: "T1", wave: 1, status: "implemented" }),
          taskState({ id: "T2", wave: 2, status: "pending" }),
        ],
      });

      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);

      expect(status.next.action).toMatchObject({
        diagnostic: { recovery: { kind: "start-wave-gate", wave: 1 } },
      });
    });

    it("renders as a status rather than an authority failure", () => {
      const graph = unstarted({ tasks: [taskState({ id: "T1", wave: 1, status: "pending" })] });

      const human = renderLoomStatusHuman(
        deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps),
      );

      expect(human).not.toContain(": unavailable (");
      expect(human).toContain("wave-gate-not-started");
      expect(human).toContain("T1 has not reached implemented");
    });

    // deriveWaveReadiness is the program/resume path; it must keep failing
    // closed on a missing registration even though status no longer does.
    it("leaves the readiness path failing closed on the same graph", () => {
      const graph = unstarted({ tasks: [taskState({ id: "T1", wave: 1, status: "pending" })] });

      expect(deriveWaveReadiness(graph, statusDeps)).toMatchObject({
        ok: false,
        error: { reasons: [{ kind: "authority-unavailable" }] },
      });
    });
  });

  it("scopes lifecycle Finding counts and drive decisions to the active Wave", () => {
    const laterWaveTask = taskState({
      id: "T2",
      wave: 2,
      status: "pending",
      review_status: "blocked",
      findings: [
        {
          id: findingId("code-reviewer-1"),
          agent: "code-reviewer",
          severity: "critical",
          file: null,
          line: null,
          claim: "retained later-Wave critical",
        },
        {
          id: findingId("code-reviewer-2"),
          agent: "code-reviewer",
          severity: "advisory",
          file: null,
          line: null,
          claim: "retained later-Wave advisory",
        },
      ],
      critical_findings: ["retained later-Wave critical"],
      advisory_findings: ["retained later-Wave advisory"],
    });
    const graph = registeredGraph({ tasks: [baseTask, laterWaveTask] });
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;

    expect(readiness.value.facts.findingCounts).toEqual({
      kind: "known",
      value: { activeCritical: 0, advisory: 0, resolved: 0, refuted: 0 },
    });
    expect(readiness.value.facts.refutationPanelNeed).toMatchObject({
      kind: "known",
      value: { kind: "not-needed" },
    });
    expect(deriveWaveGateDriveStep(readiness.value, false)).toMatchObject({
      ok: true,
      value: { kind: "ready-to-complete" },
    });
  });

  it("reports terminal blocked from persisted terminal authority", () => {
    const base = registeredGraph();
    const diagnostic = value(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: base.active_wave_gate!.runId,
      message: "persisted terminal",
    }));
    const graph = {
      ...base,
      active_wave_gate: { ...base.active_wave_gate!, terminalOutcome: { kind: "terminal-blocked" as const, diagnostic } },
    };
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
    expect(status.next.action).toMatchObject({ kind: "blocked", diagnostic: { message: "persisted terminal" } });
    expect(status.next.reasons).toEqual([{ kind: "blocked-diagnostic", message: "persisted terminal", taskId: null }]);
  });

  it("preserves terminal-blocked action construction failure as unavailable", () => {
    const base = registeredGraph();
    const diagnostic = value(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: base.active_wave_gate!.runId,
      message: "persisted terminal",
    }));
    const malformed = {
      ...base,
      active_wave_gate: {
        ...base.active_wave_gate!,
        terminalOutcome: {
          kind: "terminal-blocked" as const,
          diagnostic: { ...diagnostic, message: "" } as never,
        },
      },
    };

    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: malformed }, statusDeps);

    expect(Object.values(status.facts).every((entry) => entry.kind === "unavailable")).toBe(true);
    expect(status.next.reasons[0]?.message).toContain(
      "cannot construct persisted terminal-blocked action",
    );
  });

  it("names the retirement only when the committed final Wave leaves every Task completed", () => {
    const base = registeredGraph();
    const runId = value(parseOrchestrationRunId("final-status-run"));
    const { active_wave_gate: _active, ...withoutActive } = base;
    const committed = (tasks: readonly Task[]): TaskGraph => ({
      ...withoutActive,
      tasks: [...tasks],
      wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false } },
      wave_gate_history: [completedWaveGateFixture({ runId, wave: 1, authorityDigest: "f".repeat(64) })],
    });

    const finished = deriveLoomStatusFromParsedGraph(
      { ok: true, value: committed([taskState({ id: "T1", wave: 1, status: "completed" })]) },
      statusDeps,
    );
    expect(finished.next.action.kind).toBe("done");
    // Without the run's retrospective, status names it first (ADR-0083).
    expect(finished.next.reasons.map(({ kind }) => kind)).toEqual(["run-complete", "retro-required"]);
    const retroed = deriveLoomStatusFromParsedGraph(
      { ok: true, value: { ...committed([taskState({ id: "T1", wave: 1, status: "completed" })]), retro_records: RUN_RETRO_SKIPPED } },
      statusDeps,
    );
    expect(retroed.next.reasons.map(({ kind }) => kind)).toEqual(["run-complete", "orchestration-complete"]);
    // A Wave-scoped retro alone does not cover the run: status still names the run's retro.
    const waveOnly = deriveLoomStatusFromParsedGraph(
      { ok: true, value: { ...committed([taskState({ id: "T1", wave: 1, status: "completed" })]), retro_records: [
        { schemaVersion: 1, kind: "retro-recorded", scope: { kind: "wave", wave: 1 }, path: ".claude/retros/w1.md", digest: "a".repeat(64) },
      ] } },
      statusDeps,
    );
    expect(waveOnly.next.reasons.map(({ kind }) => kind)).toEqual(["run-complete", "retro-required"]);
    expect(renderLoomStatusHuman(retroed)).toContain("[orchestration-complete]");
  });

  it("preserves committed done-action construction failure as unavailable", () => {
    const base = registeredGraph();
    const { active_wave_gate: _active, ...withoutActive } = base;
    const malformed: TaskGraph = {
      ...withoutActive,
      tasks: [taskState({ id: "T1", wave: 1, status: "completed" })],
      wave_gates: {
        "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      },
      wave_gate_history: [{
        ...completedWaveGateFixture({ runId: "completed-status-run", wave: 1, authorityDigest: "f".repeat(64) }),
        runId: "not a run id" as never,
      }],
    };

    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: malformed }, statusDeps);

    expect(Object.values(status.facts).every((entry) => entry.kind === "unavailable")).toBe(true);
    expect(status.next.reasons[0]?.message).toContain(
      "cannot construct committed terminal action",
    );
  });

  it("directly rejects lifecycle-proven next-action authority from a foreign run", () => {
    const graph = registeredGraph();
    const foreignRun = value(parseOrchestrationRunId("foreign-status-run"));
    const foreignGraph = registeredGraph({
      active_wave_gate: { ...graph.active_wave_gate!, runId: foreignRun },
    });
    const foreignSnapshot = value(deriveWaveReadiness(foreignGraph, statusDeps));
    const foreignState = value(createWaveGateState(foreignSnapshot));
    const foreignTerminal = value(reduceWaveGate(
      value(reduceWaveGate(foreignState, { kind: "preparation-published" })),
      { kind: "result-rejected", attempt: 2 },
    ));
    const diagnostic = value(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: foreignRun,
      message: "foreign terminal",
    }));
    const action = value(blockedAction(diagnostic));
    const proven = value(proveWaveGateNextAction(foreignSnapshot, foreignTerminal, action));
    const readiness = deriveWaveReadiness(graph, statusDeps, { nextActionAuthority: proven, lifecycleCheckpoint: foreignTerminal });
    expect(readiness).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });
  });

  it("renders versioned human and machine status from the same complete value", () => {
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: registeredGraph() }, statusDeps);
    const json = renderLoomStatusJson(status);
    expect(renderLoomStatusJson(status)).toBe(json);
    expect(JSON.parse(json)).toEqual(status);
    const human = renderLoomStatusHuman(status);
    expect(renderLoomStatusHuman(status)).toBe(human);
    for (const category of Object.keys(status.facts)) expect(human).toContain(category);
    expect(human).toContain(`nextAction: ${status.next.action.kind}`);
    for (const entry of status.next.reasons) expect(human).toContain(entry.message);
  });

  it("rejects pre-commit done proof but accepts terminal blocked only at its exact lifecycle checkpoint", () => {
    const snapshot = lifecycleCompletionReadiness();
    const doneState = lifecycleStates().find((state) => state.kind === "done")!;
    const done = value(doneAction(doneState.runId, {
      runId: doneState.runId,
      slot: "artifacts/wave-result.json",
      digest: "9".repeat(64),
      byteLength: 12,
    }));
    const provenDone = value(proveWaveGateNextAction(snapshot, doneState, done));
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, { nextActionAuthority: provenDone, lifecycleCheckpoint: doneState })).toMatchObject({
      ok: false,
      error: { reasons: [{ message: expect.stringContaining("committed terminal") }] },
    });

    const terminal = lifecycleStates().find((state) => state.kind === "terminal-blocked")!;
    const diagnostic = value(terminalBlockedDiagnostic({
      category: "invalid-authority", runId: terminal.runId, message: "stop",
    }));
    const blocked = value(blockedAction(diagnostic));
    const provenBlocked = value(proveWaveGateNextAction(snapshot, terminal, blocked));
    const blockedReadiness = value(deriveWaveReadiness(snapshot.graph, statusDeps, { nextActionAuthority: provenBlocked, lifecycleCheckpoint: terminal }));
    expect(deriveNextAction(blockedReadiness).action).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "terminal-blocked", retry: { eligible: false } },
    });

    const disconnected = { ...terminal } as WaveGateState;
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, { nextActionAuthority: provenBlocked, lifecycleCheckpoint: disconnected })).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });
  });

  it("reports every failed completion prerequisite rather than only the first", () => {
    const graph = registeredGraph({
      executing_tasks: ["T1"],
      tasks: [{
        ...baseTask,
        test_result: { verdict: "trusted-fail" },
        new_test_observation: parseNewTestEvidence(false, ""),
        review_status: "pending",
        critical_findings: ["blocker"],
      }],
      spec_check: undefined,
    });
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    const eligibility = readiness.value.facts.waveGateCompletionEligibility;
    expect(eligibility.kind).toBe("known");
    if (eligibility.kind === "known" && eligibility.value.kind === "ineligible") {
      expect(eligibility.value.failedPrerequisites).toHaveLength(6);
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("still executing");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("test evidence");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("new-test");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("reviewed");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("Spec alignment");
    }
  });
});

describe("authoritative Wave refutation, panel, and advisory contracts", () => {
  it("rejects a structural copy of advisory material before it can publish an action", () => {
    const graph = advisoryGraph();
    const material = deriveWaveAdvisoryDecisionRequest(
      graph.active_wave_gate!.runId,
      graph.tasks,
    );
    expect(material.ok).toBe(true);
    if (!material.ok) return;

    expect(waveAdvisoryDecisionActionRequest(material.value)).toMatchObject({ ok: true });
    expect(waveAdvisoryDecisionActionRequest({ ...material.value })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("exact core-derived decision material set") },
    });
  });

  it("refuses refutation while a current Review Packet still owns the finding snapshot", () => {
    const collecting = value(deriveWaveReadiness(registeredGraph({
      tasks: [{
        ...baseTask,
        review_run: {
          generation: baseTask.review_generation ?? 0,
          packet_id: "1".repeat(64),
          head_sha: "2".repeat(64),
          expected_agents: BASE_WAVE_REVIEW_AGENTS,
          prior_finding_ids: [],
          evidence: [],
        },
      }],
    }), statusDeps));

    expect(deriveWaveRefutationPlan(collecting)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Review Packet evidence must complete before refutation") },
    });
  });

  it("refuses stale criticals on a pending generation that has no current Review Packet", () => {
    const finding = {
      id: findingId("code-reviewer-1"), agent: "code-reviewer", severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts", line: 1, claim: "stale until current review completes",
    };
    const pending = value(deriveWaveReadiness(registeredGraph({
      tasks: [{
        ...baseTask,
        review_status: "pending",
        review_generation: 2,
        review_run: undefined,
        findings: [finding],
        critical_findings: [finding.claim],
        advisory_findings: [],
      }],
    }), statusDeps));

    expect(deriveWaveRefutationPlan(pending)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("current-generation review evidence must complete") },
    });
  });

  it("binds Wave refutation identity to the exact readiness epoch", () => {
    const finding = {
      id: findingId("code-reviewer-1"), agent: "code-reviewer", severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts", line: 1, claim: "completion can advance without authority",
    };
    const first = value(deriveWaveReadiness(registeredGraph({
      tasks: [{ ...baseTask, findings: [finding], critical_findings: [finding.claim], advisory_findings: [] }],
    }), statusDeps));
    const second = value(deriveWaveReadiness({
      ...first.graph,
      tasks: first.graph.tasks.map((task) => ({ ...task, test_evidence: `${task.test_evidence} (re-observed)` })),
    }, statusDeps));

    expect(value(deriveWaveRefutationPlan(first)).runId)
      .not.toBe(value(deriveWaveRefutationPlan(second)).runId);
  });

  it("refuses an empty panel and derives non-empty idempotent panel authority only from canonical Findings", () => {
    const clean = value(deriveWaveReadiness(registeredGraph(), statusDeps));
    expect(deriveWaveRefutationPlan(clean)).toMatchObject({ ok: false });

    const finding = {
      id: findingId("code-reviewer-1"),
      agent: "code-reviewer",
      severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts",
      line: 1,
      claim: "completion can advance without authority",
    };
    const snapshot = value(deriveWaveReadiness(registeredGraph({
      tasks: [{ ...baseTask, findings: [finding], critical_findings: [finding.claim], advisory_findings: [] }],
    }), statusDeps));
    const plan = value(deriveWaveRefutationPlan(snapshot));
    const replay = value(deriveWaveRefutationPlan(snapshot));
    expect(replay).toEqual(plan);
    expect(plan.findings.map(({ id }) => id)).toEqual(["T1:code-reviewer-1"]);
    expect(plan.lenses.length).toBeGreaterThan(0);
    // The plan's verifier requests are issued by the one shared seam
    // (refutation-verifiers.ts); its catalog routing is pinned there.
  });

  it("derives advisory await-user internally and exposes it as the sole status action", () => {
    const advisory = {
      id: findingId("comment-analyzer-1"),
      agent: "comment-analyzer",
      severity: "advisory" as const,
      file: null,
      line: null,
      claim: "clarify wording",
    };
    const graph = registeredGraph({
      tasks: [{ ...baseTask, findings: [advisory], critical_findings: [], advisory_findings: [advisory.claim] }],
    });
    const snapshot = value(deriveWaveReadiness(graph, statusDeps));
    const preparing = value(createWaveGateState(snapshot));
    const reviewing = value(reduceWaveGate(preparing, { kind: "preparation-published" }));
    const advisoryState = value(reduceWaveGate(reviewing, { kind: "complete-roster-with-advisories" }));
    const proven = value(deriveWaveAdvisoryNextAction(snapshot, advisoryState));
    const advisoryReadiness = value(deriveWaveReadiness(graph, statusDeps, { nextActionAuthority: proven, lifecycleCheckpoint: advisoryState }));
    expect(deriveNextAction(advisoryReadiness).action.kind).toBe("await-user");
    const status = deriveLoomStatus(advisoryReadiness);
    expect(status.next.action.kind).toBe("await-user");
    expect(status.next.reasons.some(({ kind }) => kind === "advisory-decision-required")).toBe(true);
  });

  /**
   * LC-1 is now DRIVEN by the production status path, not only by the hand-wired
   * sequence above. `deriveLoomStatusFromParsedGraph` is what `loom status`
   * calls; before this it passed `null, null` for the lifecycle and so could
   * only ever answer "resume the engine" once a run was in flight — including
   * while a human decision was the one thing that could unblock the wave.
   */
  const advisoryGraph = (): TaskGraph => {
    const advisory = {
      id: findingId("comment-analyzer-1"),
      agent: "comment-analyzer",
      severity: "advisory" as const,
      file: null,
      line: null,
      claim: "clarify wording",
    };
    return registeredGraph({
      tasks: [{ ...baseTask, findings: [advisory], critical_findings: [], advisory_findings: [advisory.claim] }],
    });
  };

  it("reports the pending advisory decision through the real status entry point", () => {
    const graph = advisoryGraph();
    const observation = Object.freeze({
      kind: "present" as const,
      runId: graph.active_wave_gate!.runId,
      path: "/runs/registered-wave-run",
      advisoryApproval: { kind: "not-approved" as const },
    });
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps, null, observation);
    expect(status.next.action.kind).toBe("await-user");
    expect(status.next.reasons.some(({ kind }) => kind === "advisory-decision-required")).toBe(true);
  });

  it("stops asking once the operator's approval is observed in the run", () => {
    const graph = advisoryGraph();
    const observation = Object.freeze({
      kind: "present" as const,
      runId: graph.active_wave_gate!.runId,
      path: "/runs/registered-wave-run",
      advisoryApproval: { kind: "approved" as const },
    });
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps, null, observation);
    expect(status.next.action.kind).not.toBe("await-user");
  });

  it("preserves an advisory action proof failure as unavailable instead of fabricating engine resume", () => {
    const graph = advisoryGraph();
    const invalidRunId = "bad run id" as NonNullable<TaskGraph["active_wave_gate"]>["runId"];
    const forgedParsedGraph: TaskGraph = {
      ...graph,
      active_wave_gate: { ...graph.active_wave_gate!, runId: invalidRunId },
    };

    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: forgedParsedGraph }, statusDeps);

    expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
    expect(status.next.action).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "terminal-blocked", category: "invalid-authority" },
    });
    expect(status.next.reasons[0]?.message).toContain("cannot prove LC-1 advisory action");
    expect(status.next.reasons[0]?.message).not.toContain("engine resume");
  });

  it("blocks status when advisory approval evidence is unavailable", () => {
    const graph = advisoryGraph();
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps, null, {
      kind: "present",
      runId: graph.active_wave_gate!.runId,
      path: "/runs/registered-wave-run",
      advisoryApproval: { kind: "unavailable", reason: "event log is unreadable" },
    });
    expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
    expect(status.next.action).toMatchObject({ kind: "blocked" });
    expect(status.next.reasons[0]?.message).toContain("event log is unreadable");
  });

  it("treats an unobservable run directory as 'decision still required', never as approved", () => {
    const graph = advisoryGraph();
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
    expect(status.next.action.kind).toBe("await-user");
  });
});

describe("protected active Wave Gate registration", () => {
  const registration = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "registered-wave-run",
    wave: 1,
    authorityDigest: "c".repeat(64),
    revision: 0,
    terminalOutcome: null,
  };

  it("parses exact anchored authority and rejects malformed terminal outcomes", () => {
    expect(parseActiveWaveGateRegistration(registration)).toMatchObject({ ok: true, value: { wave: 1, revision: 0 } });
    expect(parseActiveWaveGateRegistration({ ...registration, extra: true })).toMatchObject({ ok: false });
    expect(parseActiveWaveGateRegistration({ ...registration, terminalOutcome: { kind: "done" } })).toMatchObject({ ok: false });
  });

  it("rejects nonterminal active authority that contradicts Phase, current Wave, or terminal history and blocks status", () => {
    const terminalHistory = completedWaveGateEntry({ runId: "completed-wave-run", wave: 1 });
    const raw = {
      current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(),
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [baseTask],
      wave_gates: {},
      active_wave_gate: registration,
    };
    const cases = [
      {
        label: "phase mismatch",
        graph: { ...raw, current_phase: "specify" },
        diagnostic: "requires current_phase execute",
      },
      {
        label: "wave mismatch",
        graph: { ...raw, current_wave: 2 },
        diagnostic: "must match protected current_wave 2",
      },
      {
        label: "terminal overlap",
        graph: { ...raw, wave_gate_history: [terminalHistory] },
        diagnostic: "overlaps terminal wave_gate_history Wave 1 run completed-wave-run",
      },
    ];

    for (const { label, graph, diagnostic } of cases) {
      const parsed = parseTaskGraph(graph);
      expect(parsed.ok, label).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error, label).toContain(diagnostic);
      const status = deriveLoomStatusFromParsedGraph(parsed, statusDeps);
      expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable"), label).toBe(true);
      expect(status.next.action, label).toMatchObject({
        kind: "blocked",
        diagnostic: { kind: "terminal-blocked", category: "invalid-authority" },
      });
      expect(status.next.reasons[0]?.message, label).toContain(diagnostic);
    }
  });

  it("registers atomically, replays idempotently, and refuses a competing active run", async () => {
    const root = canonicalTempDir("loom-active-wave-");
    const path = join(root, "active_task_graph.json");
    const taskIds = ["T1"];
    const initial: TaskGraph = {
      current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, tasks: [baseTask], wave_gates: {},
    };
    const exactRegistration = {
      ...registration,
      authorityDigest: waveGateAuthorityDigest(1, taskIds, initial),
    };
    writeFileSync(path, JSON.stringify(initial));
    const manager = new StateManager(path);
    try {
      const first = await manager.registerActiveWaveGate(exactRegistration, { taskIds: taskIds });
      const replay = await manager.registerActiveWaveGate(exactRegistration, { taskIds: taskIds });
      expect(replay).toEqual(first);
      expect(manager.load().active_wave_gate).toEqual(first);
      await expect(manager.registerActiveWaveGate({ ...exactRegistration, runId: "competing-run" }, { taskIds: taskIds }))
        .rejects.toThrow("already owns wave 1");
      expect(manager.load().active_wave_gate).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects registration for a Wave already present in terminal history", async () => {
    const root = canonicalTempDir("loom-terminal-wave-registration-");
    const path = join(root, "active_task_graph.json");
    writeFileSync(path, JSON.stringify(registeredGraph()));
    const manager = new StateManager(path);
    try {
      const committed = await manager.commitActiveWaveGateCompletion((locked) => {
        const readiness = deriveWaveReadiness(locked, statusDeps);
        return readiness.ok
          ? commitWaveGateCompletion(readiness.value)
          : { ok: false, error: { kind: "wave-completion-commit-rejected" as const, message: "unavailable" } };
      });
      const replay = value(findRegisteredWaveGateCompletionReplay(manager.load(), {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: committed.completedRegistration.runId,
        wave: committed.completedRegistration.wave,
        authorityDigest: committed.completedRegistration.authorityDigest,
        revision: committed.completedRegistration.revision - 1,
        terminalOutcome: null,
      }));
      expect(replay).toEqual(committed.completedRegistration);
      await expect(manager.registerActiveWaveGate(registration, { taskIds: ["T1"] }))
        .rejects.toThrow("already completed or older than terminal Wave history");
      expect(manager.load().active_wave_gate).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-stats lifecycle artifacts inside the completion lock and rejects pre-lock deletion drift", async () => {
    const root = canonicalTempDir("loom-wave-lock-drift-");
    const path = join(root, "active_task_graph.json");
    const relativeArtifact = `tests/.wave-lock-drift-${process.pid}.ts`;
    const artifact = join(root, relativeArtifact);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(artifact, "export {};\n");
    const artifactProof = evaluateTaskProof(
      { declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: [relativeArtifact] },
      trustedPassEvidence([relativeArtifact]),
    );
    if (artifactProof.state !== "satisfied") throw new Error("artifact fixture proof must be satisfied");
    writeFileSync(path, JSON.stringify(registeredGraph({
      plan_file: "plan.md",
      tasks: [taskState({
        status: "implemented",
        file_list: [relativeArtifact],
        files_modified: [relativeArtifact],
        proof: artifactProof,
      })],
    })));
    const manager = new StateManager(path);
    // Live deps: every evaluation stats the workspace afresh, as the Wave Gate program's do.
    const live: CoreGateDeps = {
      ...statusDeps,
      loadPlanModels: () => ({
        kind: "loaded",
        models: {
          lifecycles: [{ id: "LC-1", title: "Wave", machineFile: relativeArtifact }],
          pipeline: null,
          invariants: [],
          contracts: [],
          strays: [],
        },
      }),
      filePresence: (candidate) => ({ ok: true, exists: existsSync(join(root, candidate)) }),
    };
    try {
      expect(evaluateWaveGate(manager.load(), null, live).verdict.kind).toBe("pass");
      rmSync(artifact);
      let lockedFailure = "";
      await expect(manager.commitActiveWaveGateCompletion((locked) => {
        const liveDecision = evaluateWaveGate(locked, null, live);
        lockedFailure = liveDecision.verdict.kind === "fail" ? liveDecision.verdict.reason : "";
        const readiness = deriveWaveReadiness(locked, live);
        return readiness.ok
          ? commitWaveGateCompletion(readiness.value)
          : { ok: false, error: { kind: "wave-completion-commit-rejected", message: "unavailable" } };
      })).rejects.toThrow("completion readiness is ineligible");
      expect(lockedFailure).toContain("lifecycle machine files");
      expect(manager.load().active_wave_gate?.terminalOutcome).toBeNull();
      expect(manager.load().tasks[0]?.status).toBe("implemented");
    } finally {
      rmSync(artifact, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects completion when snapshot.graph.active_wave_gate is replaced after readiness derivation", () => {
    const graph = registeredGraph();
    const readiness = value(deriveWaveReadiness(graph, statusDeps));
    Object.assign(graph, { active_wave_gate: { ...graph.active_wave_gate! } });
    expect(commitWaveGateCompletion(readiness)).toMatchObject({
      ok: false,
      error: { message: "snapshot graph active_wave_gate is not the exact readiness registration" },
    });
  });

  it("rejects completion when the active run is already terminal in history", () => {
    const graph = registeredGraph();
    const readiness = value(deriveWaveReadiness(graph, statusDeps));
    const committed = value(commitWaveGateCompletion(readiness));

    // The same run re-enters the graph as the active gate with its own
    // completed registration already archived — the duplicate-terminal shape
    // the parse boundary refuses at load and the commit machine must also
    // refuse in memory.
    const rerun = registeredGraph({ wave_gate_history: [committed.completedRegistration] });
    const rerunReadiness = value(deriveWaveReadiness(rerun, statusDeps));
    expect(commitWaveGateCompletion(rerunReadiness)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already terminal in history") },
    });
  });

  it("rejects a next-action whose runId differs from the lifecycle state BEFORE readiness derivation", () => {
    // The pre-proof reject arm: a foreign-run action must be refused here, not
    // first minted into a next-action proof that downstream readiness
    // contradiction handling has to clean up.
    const snapshot = lifecycleCompletionReadiness();
    const state = lifecycleStates().find((candidate) => candidate.kind === "done")!;
    const foreignRun = value(parseOrchestrationRunId("foreign-next-action-run"));
    const done = value(doneAction(state.runId, {
      runId: state.runId,
      slot: "artifacts/wave-result.json",
      digest: "9".repeat(64),
      byteLength: 12,
    }));
    const foreign = { ...done, runId: foreignRun };

    const proven = proveWaveGateNextAction(snapshot, state, foreign);

    expect(proven.ok).toBe(false);
    if (!proven.ok) {
      expect(proven.error.kind).toBe("wave-gate-next-action-rejected");
      expect(proven.error.message).toContain("different Wave Gate run");
    }
  });

  it("atomically archives terminal receipt and accepted suite with Task/Wave advancement", async () => {
    const root = canonicalTempDir("loom-complete-wave-");
    const path = join(root, "active_task_graph.json");
    const initial = registeredGraph({
      tasks: [baseTask, { ...baseTask, id: "T2", wave: 2 }],
    });
    writeFileSync(path, JSON.stringify(initial));
    const manager = new StateManager(path);
    try {
      const committed = await manager.commitActiveWaveGateCompletion((locked) => {
        const readiness = deriveWaveReadiness(locked, statusDeps);
        if (!readiness.ok) return { ok: false, error: { kind: "wave-completion-commit-rejected", message: "unavailable" } };
        return commitWaveGateCompletion(readiness.value);
      });
      const stored = manager.load();
      expect(stored.active_wave_gate).toBeUndefined();
      expect(stored.current_wave).toBe(2);
      expect(stored.tasks.find(({ id }) => id === "T1")?.status).toBe("completed");
      expect(stored.wave_gate_history).toEqual([committed.completedRegistration]);
      expect(stored.wave_gate_history?.[0]?.completionReceipt).toEqual(committed.receipt);
      expect(stored.wave_gate_history?.[0]?.completionSuite).toEqual(initial.active_wave_completion_suite);
      expect(stored.active_wave_completion_suite).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

