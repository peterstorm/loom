import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyImplementationCompletionTransition,
  buildTaskLocalByteObservation,
  describeSettlement,
  INFRASTRUCTURE_REASON_LIMIT,
  NAMED_SCOPE_VIOLATION_PATHS,
  NO_ENGINE_SKELETONS,
  normalizeImplementationEvidence,
  settleObservedImplementation,
  settleUnavailableImplementation,
  type EngineSkeletonObservation,
  type TaskLocalByteObservation,
} from "../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
  parseContractViolatedFailureKind,
} from "../../src/core/proof-obligations";
import { taskFixture } from "../fixtures/task-lifecycle";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { ConformanceViolation, ContractConformance, SkeletonRecord } from "../../src/core/skeleton/types";
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import { authorizeImplementationSpawn, deriveImplementationRetryDisposition } from "../../src/core/implementation-retry";
import type { Task, TaskGraph } from "../../src/types";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN, parseNewTestEvidence } from "../../src/types";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const baseline = (path: string, value: string | null) => [{
  artifact: path,
  snapshot: value === null
    ? { kind: "missing" as const }
    : { kind: "sha256" as const, digest: value },
}];

function authority(
  semanticAttempt: 1 | 2 = 1,
  reservationId = `application-${semanticAttempt}`,
): ImplementationAttemptAuthority {
  const created = createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: `2026-08-24T00:00:0${semanticAttempt}.000Z`,
    taskScopeBaseline: baseline("src/a.ts", digest("a")),
    dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

function observedBytes(
  attempt: ImplementationAttemptAuthority,
  overrides: Partial<Parameters<typeof buildTaskLocalByteObservation>[0]> = {},
): TaskLocalByteObservation {
  return buildTaskLocalByteObservation({
    authority: attempt,
    attemptBaseline: baseline("src/a.ts", digest("a")),
    currentAttemptScope: baseline("src/a.ts", digest("b")),
    proofBaseline: baseline("src/a.ts", digest("a")),
    currentProofScope: baseline("src/a.ts", digest("b")),
    parserModifiedPaths: ["src/a.ts"],
    priorAttributedPaths: [],
    repositoryChangedPaths: [],
    siblingOwnedPaths: [],
    engineSkeletons: NO_ENGINE_SKELETONS,
    ...overrides,
  });
}

function pendingTask(
  attempt: ImplementationAttemptAuthority,
  overrides: Partial<Task> = {},
): Task {
  return taskFixture({
    id: "T1",
    description: "settle",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    new_tests_required: false,
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: ["src/a.ts"] }),
    active_implementation_attempt: attempt,
    attempt_artifact_baseline: baseline("src/a.ts", digest("a")),
    attempt_repository_baseline: [],
    repository_baseline: [],
    artifact_baseline: baseline("src/a.ts", digest("a")),
    reserved_at: attempt.reservedAt,
    ...overrides,
  });
}

function graph(task: Task): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [task],
    wave_gates: {
      "1": { impl_complete: false, tests_passed: true, reviews_complete: true, blocked: true },
    },
    spec_check: capturedSpecCheck({
      wave: 1,
      runAt: "2026-08-24T00:00:00.000Z",
      criticalFindings: ["stale spec finding"],
    }),
  };
}

const completedEvidence = {
  taskCompleted: true,
  contractConformance: CONFORMANCE_NOT_OWED,
  newTests: parseNewTestEvidence(false, "verification_policy.new_tests waived: legacy-new-tests-required-false"),
};

function expectApplied(result: ReturnType<typeof settleObservedImplementation>) {
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return result;
}

describe("Task-local byte-scope application core", () => {
  it("accepts only parser-proven changed bytes inside the attempt baseline", () => {
    const bytes = observedBytes(authority(), {
      parserModifiedPaths: ["src/a.ts"],
      priorAttributedPaths: ["src/old.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: ["src/a.ts"] });
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
    expect(bytes.taskBytesChangedOrUnobservable).toBe(true);
  });

  it("keeps a no-op parser path unattributed while the proof boundary still sees all task production", () => {
    // Production regression (T13): attempt 1's writes were never recorded
    // because its settlement was infrastructure-blocked; a verify-only re-run
    // then failed declared-artifact-not-changed for bytes that had changed.
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("b")),
      parserModifiedPaths: [],
      priorAttributedPaths: [],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.attributedAttemptChangedPaths).toEqual([]);
    expect(bytes.taskBytesChangedOrUnobservable).toBe(false);
    // INV-DF1: the proof boundary predates the Task's production, so the
    // proof-scope change is task production the settlement must see — the
    // no-op parser path gains no ATTRIBUTION, but the cumulative paths and the
    // Oracle's filesModified still credit it.
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
  });

  it("credits committed production even when the child makes no edits (stale flow)", () => {
    const attempt = authority(1, "stale-flow-committed");
    // The population-time proof baseline predates the committed production; the
    // re-registered child makes no edits and its attempt scope never moves.
    const bytes = observedBytes(attempt, {
      attemptBaseline: baseline("src/a.ts", digest("b")),
      currentAttemptScope: baseline("src/a.ts", digest("b")),
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.attributedAttemptChangedPaths).toEqual([]);
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);

    const result = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:08:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      bytes,
    ));
    expect(result.transition.kind).toBe("implemented");
    expect(result.state.tasks[0]).toMatchObject({
      status: "implemented",
      files_modified: ["src/a.ts"],
      proof: { state: "satisfied" },
    });
    expect(result.state.executing_tasks).toEqual([]);
  });

  it("property: proof credit is exactly the declared bytes changed from the first Task baseline", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.subarray(["src/a.ts"]),
      fc.subarray(["src/a.ts"]),
      (attemptChanged, proofChanged, parserPaths, priorPaths) => {
        const bytes = observedBytes(authority(), {
          currentAttemptScope: baseline("src/a.ts", digest(attemptChanged ? "b" : "a")),
          currentProofScope: baseline("src/a.ts", digest(proofChanged ? "b" : "a")),
          parserModifiedPaths: parserPaths,
          priorAttributedPaths: priorPaths,
        });
        expect(bytes.cumulativeProofArtifactChanges).toEqual(proofChanged ? ["src/a.ts"] : []);
        if (proofChanged) expect(bytes.cumulativeModifiedPaths).toContain("src/a.ts");
      },
    ));
  });

  it("retains a prior allowed attribution while refusing an additional no-op parser credit", () => {
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("b")),
      parserModifiedPaths: ["src/a.ts"],
      priorAttributedPaths: ["src/a.ts"],
    });
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
  });

  it("classifies transcript paths outside the registered attempt scope as semantic failure", () => {
    const bytes = observedBytes(authority(), { parserModifiedPaths: ["foreign.ts"] });
    expect(bytes.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["foreign.ts"],
    });
  });

  it("classifies malformed/mismatched baseline observations as infrastructure unavailable", () => {
    const bytes = observedBytes(authority(), { currentAttemptScope: [] });
    expect(bytes.suite.checks[0]?.outcome).toMatchObject({ kind: "observation-unavailable" });
    expect(bytes.taskBytesChangedOrUnobservable).toBe(true);
    expect(bytes.invalidationBytesChanged).toBe(true);
  });

  it("never turns sibling repository movement into Task attribution, proof, or invalidation", () => {
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("a")),
      parserModifiedPaths: [],
      repositoryChangedPaths: ["src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.cumulativeProofArtifactChanges).toEqual([]);
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
    expect(bytes.taskBytesChangedOrUnobservable).toBe(false);
    expect(bytes.invalidationBytesChanged).toBe(false);
  });

  it("carries every unowned repository delta even when the parser omits it", () => {
    const first = observedBytes(authority(), {
      parserModifiedPaths: ["src/a.ts"],
      repositoryChangedPaths: ["src/foreign.ts", "src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(first.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["src/foreign.ts"],
    });
    expect(first.unresolvedRepositoryPaths).toEqual(["src/foreign.ts"]);
    expect(first.invalidationBytesChanged).toBe(true);

    const persistent = observedBytes(authority(), {
      parserModifiedPaths: [],
      repositoryChangedPaths: ["src/foreign.ts", "src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(persistent.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["src/foreign.ts"],
    });
    expect(persistent.unresolvedRepositoryPaths).toEqual(["src/foreign.ts"]);
  });

  it("keeps a current Task-owned repository path local without granting parser attribution", () => {
    const scoped = [
      ...baseline("src/a.ts", digest("a")),
      ...baseline("src/foreign.ts", digest("f")),
    ];
    const bytes = observedBytes(authority(), {
      attemptBaseline: scoped,
      currentAttemptScope: scoped,
      parserModifiedPaths: [],
      repositoryChangedPaths: ["src/foreign.ts", "src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
  });

  it("accepts cleanup once foreign bytes return to the retained baseline", () => {
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("a")),
      parserModifiedPaths: [],
      repositoryChangedPaths: ["src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
    expect(bytes.invalidationBytesChanged).toBe(false);
  });

  it("scopes, attributes and proves a directory artifact through writes below it", () => {
    const scoped = [...baseline("src/a.ts", digest("a")), ...baseline("calibration/run", null)];
    const current = [...baseline("src/a.ts", digest("a")), ...baseline("calibration/run", digest("d"))];
    const bytes = observedBytes(authority(), {
      attemptBaseline: scoped,
      currentAttemptScope: current,
      proofBaseline: scoped,
      currentProofScope: current,
      parserModifiedPaths: ["calibration/run/result.json"],
      repositoryChangedPaths: ["calibration/run/result.json", "calibration/runner.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["calibration/runner.ts"],
    });
    expect(bytes.attributedAttemptChangedPaths).toEqual(["calibration/run"]);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["calibration/run"]);
    expect(bytes.unresolvedRepositoryPaths).toEqual(["calibration/runner.ts"]);
  });

  it("treats repository movement below a sibling-owned directory as inert", () => {
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("a")),
      parserModifiedPaths: [],
      repositoryChangedPaths: ["calibration/run/result.json"],
      siblingOwnedPaths: ["calibration/run"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
  });

  it("fails raw parser paths outside Task scope even when a sibling owns them", () => {
    const bytes = observedBytes(authority(), {
      parserModifiedPaths: ["src/sibling.ts"],
      repositoryChangedPaths: ["src/sibling.ts"],
      siblingOwnedPaths: ["src/sibling.ts"],
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({
      kind: "out-of-scope-writes",
      paths: ["src/sibling.ts"],
    });
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
  });
});

describe("shared evidence preservation", () => {
  it("reads an absent new-test ADT as the canonical not-written observation", () => {
    const attempt = authority();
    const normalized = normalizeImplementationEvidence(
      pendingTask(attempt),
      { taskCompleted: true, contractConformance: CONFORMANCE_NOT_OWED },
      observedBytes(attempt),
    );
    expect(normalized.newTests).toEqual({ kind: "not-written", written: false, evidence: "" });
  });

  it.each([
    ["trusted-fail", true, false, "trusted-fail"],
    ["trusted-pass", false, false, "trusted-pass"],
    ["trusted-pass", true, false, "untrusted"],
    ["trusted-pass", false, true, "untrusted"],
  ] as const)(
    "%s with bytesChanged=%s revalidation=%s resolves to %s",
    (trusted, bytesChanged, revalidation, expected) => {
      const attempt = authority();
      const task = pendingTask(attempt, {
        test_result: { verdict: trusted },
        test_evidence: "trusted history",
        ...(revalidation ? { revalidation_required: true } : {}),
      });
      const bytes = observedBytes(attempt, {
        currentAttemptScope: baseline("src/a.ts", bytesChanged ? digest("b") : digest("a")),
      });
      const normalized = normalizeImplementationEvidence(task, {
        taskCompleted: true,
        contractConformance: CONFORMANCE_NOT_OWED,
        testResult: { verdict: "untrusted", passed: true, label: "fallback", provenance: "unverified" },
        testEvidence: "fallback",
      }, bytes);
      expect(normalized.testResult?.verdict).toBe(expected);
      expect(normalized.testEvidence).toBe(expected === "untrusted" ? "fallback" : "trusted history");
    },
  );
});

describe("exact transition application", () => {
  it("implements, appends one receipt, clears exact authority, invalidates review/spec/Wave, and recomputes projection", () => {
    const attempt = authority();
    const initial = graph(pendingTask(attempt, { review_status: "passed", review_generation: 4 }));
    const result = expectApplied(settleObservedImplementation(
      initial,
      attempt,
      "2026-08-24T00:01:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(result.transition.kind).toBe("implemented");
    const task = result.state.tasks[0]!;
    expect(task).toMatchObject({
      status: "implemented",
      review_status: "pending",
      review_generation: 5,
      files_modified: ["src/a.ts"],
    });
    expect(task.active_implementation_attempt).toBeUndefined();
    expect(task.repository_baseline).toBeUndefined();
    expect(task).not.toHaveProperty("unresolved_repository_paths");
    expect(task.implementation_attempt_history).toHaveLength(1);
    expect(task.implementation_attempt_history?.[0]).toMatchObject({
      transition: "implemented",
      consumesSemanticAttempt: false,
    });
    expect(result.state.executing_tasks).toEqual([]);
    expect(result.state.spec_check).toBeUndefined();
    expect(result.state.wave_gates["1"]).toEqual({
      impl_complete: true,
      tests_passed: null,
      reviews_complete: false,
      blocked: false,
    });
  });

  it("re-derives Wave blocked from surviving critical review causes", () => {
    const attempt = authority(1, "critical-review-cause");
    const initial = graph(pendingTask(attempt, {
      critical_findings: ["still active"],
      review_status: "blocked",
    }));
    const result = expectApplied(settleObservedImplementation(
      initial,
      attempt,
      "2026-08-24T00:01:30.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(result.state.spec_check).toBeUndefined();
    expect(result.state.wave_gates["1"]?.blocked).toBe(true);
  });

  it("records attempt-1 retry and attempt-2 escalation without dispatching either", () => {
    for (const semanticAttempt of [1, 2] as const) {
      const attempt = authority(semanticAttempt, `semantic-${semanticAttempt}`);
      const task = pendingTask(attempt, {
        proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/a.ts"] }),
        new_tests_required: true,
      });
      const result = expectApplied(settleObservedImplementation(
        graph(task),
        attempt,
        `2026-08-24T00:02:0${semanticAttempt}.000Z` as never,
        {
          taskCompleted: true,
          testResult: { verdict: "trusted-fail" },
          testEvidence: "red",
          newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN,
          contractConformance: CONFORMANCE_NOT_OWED,
        },
        TRUSTED_LEDGER_ONLY_POLICY,
        observedBytes(attempt),
      ));
      expect(result.transition.kind).toBe(semanticAttempt === 1 ? "retry-required" : "escalation-required");
      expect(result.state.tasks[0]).toMatchObject({ status: "pending", proof: { state: "failed" } });
      expect(result.state.tasks[0]?.implementation_attempt_history?.[0]?.consumesSemanticAttempt).toBe(true);
      expect(result.state.executing_tasks).toEqual([]);
      expect(result.state.tasks[0]?.active_implementation_attempt).toBeUndefined();
      // Both semantic-failure arms retire the attempt's repository boundary:
      // the re-armed attempt freezes a fresh one at its own registration.
      expect(result.state.tasks[0]?.repository_baseline).toBeUndefined();
      expect(result.state.tasks[0]).not.toHaveProperty("unresolved_repository_paths");
      expect(result.state.tasks[0]).not.toHaveProperty("retry_request");
    }
  });

  it("implements a verify-only retry whose declared bytes an infrastructure-blocked attempt produced", () => {
    const attempt = authority(1, "verify-only-after-infrastructure-block");
    const result = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt, { attempt_artifact_baseline: baseline("src/a.ts", digest("b")) })),
      attempt,
      "2026-08-24T00:02:30.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt, {
        attemptBaseline: baseline("src/a.ts", digest("b")),
        currentAttemptScope: baseline("src/a.ts", digest("b")),
        parserModifiedPaths: [],
      }),
    ));
    expect(result.transition.kind).toBe("implemented");
    expect(result.state.tasks[0]).toMatchObject({ status: "implemented", files_modified: ["src/a.ts"] });
  });

  it("keeps satisfied historical Proof pending+revalidation and retires the attempt boundary on retry", () => {
    const attempt = authority();
    const result = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:03:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt, {
        parserModifiedPaths: ["src/a.ts", "foreign.ts"],
        repositoryChangedPaths: ["foreign.ts", "sibling.ts"],
        siblingOwnedPaths: ["sibling.ts"],
      }),
    ));
    expect(result.transition.kind).toBe("retry-required");
    expect(result.state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "satisfied" },
      revalidation_required: true,
    });
    // The unowned foreign delta observed DURING the attempt still invalidates
    // its review; only the boundary and its diagnostics retire with the
    // attempt, so the re-armed attempt freezes a fresh repository boundary.
    expect(result.state.tasks[0]).toMatchObject({ review_status: "pending", review_generation: 1 });
    expect(result.state.tasks[0]?.repository_baseline).toBeUndefined();
    expect(result.state.tasks[0]).not.toHaveProperty("unresolved_repository_paths");
    expect(result.state.tasks[0]?.attempt_repository_baseline).toBeUndefined();
  });

  it("infrastructure settlement after exact byte observation retires the attempt boundary", () => {
    const attempt = authority(1, "infrastructure-unowned-path");
    const bytes = observedBytes(attempt, {
      parserModifiedPaths: [],
      repositoryChangedPaths: ["foreign.ts", "sibling.ts"],
      siblingOwnedPaths: ["sibling.ts"],
    });
    const result = settleUnavailableImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:03:30.000Z" as never,
      "new-test observation failed",
      bytes,
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    // Newly discovered unowned paths invalidate this attempt (the settlement
    // diagnostics carry them) but retire WITH the attempt: they are evidence
    // against this attempt's boundary, not a durable carry into the next one.
    expect(result.state.tasks[0]).toMatchObject({
      repository_baseline: undefined,
      failure_reason: expect.stringContaining("infrastructure-blocked"),
    });
  });

  it("infrastructure settlement appends a non-consuming receipt, preserves history evidence, and releases exact authority", () => {
    const attempt = authority();
    const initial = graph(pendingTask(attempt, {
      test_result: { verdict: "trusted-pass" },
      test_evidence: "historical pass",
      files_modified: ["src/a.ts"],
    }));
    const result = settleUnavailableImplementation(
      initial,
      attempt,
      "2026-08-24T00:04:00.000Z" as never,
      "transcript unreadable",
    );
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.transition.kind).toBe("infrastructure-blocked");
    expect(result.state.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      test_result: { verdict: "trusted-pass" },
      test_evidence: "historical pass",
      files_modified: ["src/a.ts"],
    });
    expect(result.state.tasks[0]?.implementation_attempt_history?.[0]).toMatchObject({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
    });
    // The retired boundary leaves no unresolved-path carry behind.
    expect(result.state.tasks[0]).not.toHaveProperty("unresolved_repository_paths");
    expect(result.state.tasks[0]?.repository_baseline).toBeUndefined();
    expect(result.state.executing_tasks).toEqual([]);
  });

  it("refuses a transition receipt minted for a different authority", () => {
    const old = authority(1, "transition-old");
    const replacement = authority(1, "transition-new");
    const oldTransition = expectApplied(settleObservedImplementation(
      graph(pendingTask(old)),
      old,
      "2026-08-24T00:04:30.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(old),
    )).transition;
    const current = graph(pendingTask(replacement));
    const applied = applyImplementationCompletionTransition(
      current,
      replacement,
      oldTransition,
      { bytes: observedBytes(replacement) },
    );
    expect(applied).toMatchObject({ kind: "ignored", reason: "stale" });
    expect(applied.state).toBe(current);
  });

  it("preserves a newer reservation when a late result arrives", () => {
    const old = authority(1, "old-result");
    const replacement = authority(1, "new-reservation");
    const initial = graph(pendingTask(replacement));
    const result = settleUnavailableImplementation(
      initial,
      old,
      "2026-08-24T00:05:00.000Z" as never,
      "late failed process",
    );
    expect(result).toMatchObject({ kind: "ignored", reason: "stale" });
    expect(result.state).toBe(initial);
  });

  it("is idempotent for a duplicate result", () => {
    const attempt = authority();
    const first = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:06:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    const duplicate = settleObservedImplementation(
      first.state,
      attempt,
      "2026-08-24T00:06:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    );
    expect(duplicate).toMatchObject({ kind: "ignored", reason: "duplicate" });
    expect(duplicate.state).toBe(first.state);
  });

  it("property: a byte-scope settlement names the first ten offending paths and counts the rest", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 25 }), (count) => {
      const attempt = authority(1, `scope-description-${count}`);
      const foreign = Array.from({ length: count }, (_, index) => `foreign/${String(index).padStart(2, "0")}.ts`);
      const result = expectApplied(settleObservedImplementation(
        graph(pendingTask(attempt)),
        attempt,
        "2026-08-24T00:03:45.000Z" as never,
        completedEvidence,
        TRUSTED_LEDGER_ONLY_POLICY,
        observedBytes(attempt, { parserModifiedPaths: ["src/a.ts", ...foreign] }),
      ));
      const named = foreign.slice(0, NAMED_SCOPE_VIOLATION_PATHS).join(", ");
      const rest = count > NAMED_SCOPE_VIOLATION_PATHS ? ` and ${count - NAMED_SCOPE_VIOLATION_PATHS} more` : "";
      const expected = `retry-required: task-byte-scope-violation (outside the declared files: ${named}${rest})`;
      expect(result.transition.kind).toBe("retry-required");
      expect(describeSettlement(result.transition)).toBe(expected);
      expect(result.state.tasks[0]?.failure_reason).toBe(expected);
    }));
  });

  it("describes a proof failure by its kind alone, exactly as failure_reason records it", () => {
    const attempt = authority(1, "proof-description");
    const result = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt, {
        proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/a.ts"] }),
        new_tests_required: true,
      })),
      attempt,
      "2026-08-24T00:03:50.000Z" as never,
      { taskCompleted: true, testResult: { verdict: "trusted-fail" }, testEvidence: "red", newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN, contractConformance: CONFORMANCE_NOT_OWED },
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(describeSettlement(result.transition)).toBe("retry-required: regression-tests-failed, new-tests-not-observed");
    expect(result.state.tasks[0]?.failure_reason).toBe(describeSettlement(result.transition));
  });

  it("names each infrastructure failure's own reason, so a blocked settlement explains itself", () => {
    const attempt = authority(1, "infrastructure-distinct-reasons");
    const result = expectApplied(settleUnavailableImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:03:59.000Z" as never,
      "Claude JSONL transcript record 16.message.role must be user or assistant",
      observedBytes(attempt, { currentAttemptScope: [] }),
    ));
    const description = describeSettlement(result.transition);
    expect(description).toMatch(
      /^infrastructure-blocked: implementation-observation-unavailable \(Claude JSONL transcript record 16\.message\.role must be user or assistant\), task-byte-scope-unavailable \(.+\)$/,
    );
    expect(result.state.tasks[0]?.failure_reason).toBe(description);
  });

  it("property: an infrastructure description bounds every reason it names", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 5_000 }).filter((reason) => reason.trim() !== ""), (reason) => {
      const attempt = authority(1, "infrastructure-bounded-reason");
      const result = expectApplied(settleUnavailableImplementation(
        graph(pendingTask(attempt)),
        attempt,
        "2026-08-24T00:03:59.500Z" as never,
        reason,
      ));
      const description = describeSettlement(result.transition);
      expect(description.startsWith("infrastructure-blocked: implementation-observation-unavailable (")).toBe(true);
      expect(description.length).toBeLessThanOrEqual(
        "infrastructure-blocked: ".length + 2 * (INFRASTRUCTURE_REASON_LIMIT + 64),
      );
    }), { numRuns: 50 });
  });

  it("describes implemented and infrastructure settlements by kind, the latter with its failure kinds", () => {
    const attempt = authority(1, "kind-description");
    const implemented = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:03:55.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(describeSettlement(implemented.transition)).toBe("implemented");

    const blocked = authority(1, "infrastructure-description");
    const infrastructure = expectApplied(settleUnavailableImplementation(
      graph(pendingTask(blocked)),
      blocked,
      "2026-08-24T00:03:58.000Z" as never,
      "transcript unreadable",
    ));
    // The default byte-scope reason repeats the observation's, so it is named once.
    expect(describeSettlement(infrastructure.transition))
      .toBe("infrastructure-blocked: implementation-observation-unavailable (transcript unreadable), task-byte-scope-unavailable");
    expect(infrastructure.state.tasks[0]?.failure_reason).toBe(describeSettlement(infrastructure.transition));
  });

  it("property: infrastructure receipts never consume a semantic attempt", () => {
    fc.assert(fc.property(fc.constantFrom(1 as const, 2 as const), (semanticAttempt) => {
      const attempt = authority(semanticAttempt, `infra-property-${semanticAttempt}`);
      const result = settleUnavailableImplementation(
        graph(pendingTask(attempt)),
        attempt,
        `2026-08-24T00:07:0${semanticAttempt}.000Z` as never,
        "infrastructure unavailable",
      );
      expect(result.kind).toBe("applied");
      if (result.kind === "applied") {
        expect(result.transition.kind).toBe("infrastructure-blocked");
        expect(result.transition.receipt.consumesSemanticAttempt).toBe(false);
      }
    }));
  });
});

describe("engine skeleton bytes are no implementer write (FR-012)", () => {
  const ENGINE = digest("e");
  const record = (path: string): SkeletonRecord => ({
    path,
    contract: "CT-1",
    language: "typescript",
    origin: "spawn",
    engineSha256: ENGINE,
    typesSha256: digest("t"),
    stale: null,
  });
  /** The engine's records at `paths`, each observed holding `currentDigest`
   *  (`null`: no regular file there now). */
  const engineAt = (currentDigest: string | null, ...paths: readonly string[]): EngineSkeletonObservation =>
    paths.map((path) => ({ record: record(path), currentDigest }));
  /** The engine wrote `src/a.ts` before the attempt baselines; the first Task
   *  baseline still predates it. */
  const skeletonBytes = (attempt: ImplementationAttemptAuthority, current: string | null, overrides: Partial<Parameters<typeof buildTaskLocalByteObservation>[0]> = {}) =>
    observedBytes(attempt, {
      attemptBaseline: baseline("src/a.ts", ENGINE),
      currentAttemptScope: baseline("src/a.ts", current),
      proofBaseline: baseline("src/a.ts", null),
      currentProofScope: baseline("src/a.ts", current),
      parserModifiedPaths: [],
      engineSkeletons: engineAt(current, "src/a.ts"),
      ...overrides,
    });

  it("AS-015: an untouched engine skeleton never counts as changed and never enters the attempt-scope delta", () => {
    const bytes = skeletonBytes(authority(), ENGINE);
    expect(bytes.cumulativeProofArtifactChanges).toEqual([]);
    expect(bytes.cumulativeModifiedPaths).toEqual([]);
    expect(bytes.attemptScopeChangedPaths).toEqual([]);
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
  });

  it("AS-015: without the recorded engine digest the same bytes are the Task's own production", () => {
    const bytes = skeletonBytes(authority(), ENGINE, { engineSkeletons: NO_ENGINE_SKELETONS });
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
  });

  it("FR-012: implementing the skeleton is the implementer's write", () => {
    const bytes = skeletonBytes(authority(), digest("f"), { parserModifiedPaths: ["src/a.ts"] });
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
    expect(bytes.cumulativeModifiedPaths).toEqual(["src/a.ts"]);
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: ["src/a.ts"] });
  });

  it("FR-012: deleting the skeleton is the implementer's write too", () => {
    const bytes = skeletonBytes(authority(), null, { parserModifiedPaths: ["src/a.ts"], proofBaseline: baseline("src/a.ts", digest("a")) });
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
  });

  it("FR-012: a repository-changed path still holding a recorded engine digest stays out of the out-of-scope set", () => {
    const attempt = authority();
    const stub = observedBytes(attempt, {
      repositoryChangedPaths: ["src/stub.ts"],
      engineSkeletons: engineAt(ENGINE, "src/stub.ts"),
    });
    expect(stub.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: ["src/a.ts"] });
    expect(stub.unresolvedRepositoryPaths).toEqual([]);

    const edited = observedBytes(attempt, {
      repositoryChangedPaths: ["src/stub.ts"],
      engineSkeletons: engineAt(digest("f"), "src/stub.ts"),
    });
    expect(edited.suite.checks[0]?.outcome).toEqual({ kind: "out-of-scope-writes", paths: ["src/stub.ts"] });
    expect(edited.unresolvedRepositoryPaths).toEqual(["src/stub.ts"]);

    const removed = observedBytes(attempt, {
      repositoryChangedPaths: ["src/stub.ts"],
      engineSkeletons: engineAt(null, "src/stub.ts"),
    });
    expect(removed.unresolvedRepositoryPaths).toEqual(["src/stub.ts"]);

    const unrecorded = observedBytes(attempt, {
      repositoryChangedPaths: ["src/stub.ts"],
      engineSkeletons: NO_ENGINE_SKELETONS,
    });
    expect(unrecorded.unresolvedRepositoryPaths).toEqual(["src/stub.ts"]);
  });

  it("matches recorded engine paths through the plan-path rule", () => {
    const bytes = skeletonBytes(authority(), ENGINE, {
      engineSkeletons: engineAt(ENGINE, "./src/a.ts", "./src/stub.ts"),
      repositoryChangedPaths: ["src/stub.ts"],
    });
    expect(bytes.cumulativeProofArtifactChanges).toEqual([]);
    expect(bytes.unresolvedRepositoryPaths).toEqual([]);
  });
});

describe("contract conformance at settlement (AD-5, FR-021)", () => {
  const UNIMPLEMENTED: ConformanceViolation = { subject: "priceOrder", reason: "still-unimplemented", remedy: null };
  const RELISTED: ConformanceViolation = {
    subject: "OrderState",
    reason: "re-lists-frozen-variants",
    remedy: "LegacyState re-lists the variants of the frozen union OrderState",
  };
  const violated = (violations: readonly [ConformanceViolation, ...ConformanceViolation[]]): ContractConformance =>
    ({ kind: "judged", violations: new Map([["src/a.ts", violations]]) });
  const retryTask = (attempt: ImplementationAttemptAuthority) =>
    pendingTask(attempt, { implementation_retry_protocol: 2, implementation_retry_history_start: 0 });

  it("FR-021: a violated contract refuses completion through declared-artifact-contract-violated, listing every violation", () => {
    const attempt = authority(1, "contract-violated");
    const result = expectApplied(settleObservedImplementation(
      graph(retryTask(attempt)),
      attempt,
      "2026-08-24T00:05:00.000Z" as never,
      { ...completedEvidence, contractConformance: violated([UNIMPLEMENTED, RELISTED]) },
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(result.transition.kind).toBe("retry-required");
    const task = result.state.tasks[0]!;
    expect(task.proof?.state === "failed" ? task.proof.failures : []).toEqual([
      { kind: "declared-artifact-contract-violated", artifact: "src/a.ts", violations: [UNIMPLEMENTED, RELISTED] },
    ]);
    expect(task.failure_reason).toBe("retry-required: declared-artifact-contract-violated");
    const [kind, ...rest] = task.implementation_attempt_history?.[0]?.failureKinds ?? [];
    expect(rest).toEqual([]);
    expect(parseContractViolatedFailureKind(kind ?? "")).toEqual({
      ok: true,
      value: { artifact: "src/a.ts", shown: [UNIMPLEMENTED, RELISTED], omitted: 0 },
    });
  });

  it("FR-021: the semantic retry appendix lists every violation of the refused attempt", () => {
    const attempt = authority(1, "contract-retry-appendix");
    const result = expectApplied(settleObservedImplementation(
      graph(retryTask(attempt)),
      attempt,
      "2026-08-24T00:05:01.000Z" as never,
      { ...completedEvidence, contractConformance: violated([UNIMPLEMENTED, RELISTED]) },
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    const retried = result.state.tasks[0]!;
    const disposition = deriveImplementationRetryDisposition(retried);
    expect(disposition.kind).toBe("retry");
    if (disposition.kind !== "retry") return;
    const [contextLine, ...violationLines] = disposition.promptAppendix.split("\n");
    expect(contextLine?.startsWith("LOOM_IMPLEMENTATION_RETRY_CONTEXT: {")).toBe(true);
    expect(violationLines).toEqual([
      "Declared-artifact contract violations (declared-artifact-contract-violated) the previous attempt left; " +
        "fix every one before completing:",
      "src/a.ts:",
      "  - priceOrder: still-unimplemented",
      "  - OrderState: re-lists-frozen-variants — LegacyState re-lists the variants of the frozen union OrderState",
    ]);
    // The spawn gate admits the exact appendix and refuses one stripped of its violations.
    expect(authorizeImplementationSpawn(retried, `Task ID: T1\n${disposition.promptAppendix}`))
      .toMatchObject({ ok: true, kind: "retry" });
    expect(authorizeImplementationSpawn(retried, `Task ID: T1\n${contextLine}`)).toMatchObject({ ok: false });
  });

  it("bounds an over-long violation list in its failure kind, naming how many it leaves out", () => {
    const attempt = authority(1, "contract-violated-bounded");
    const many = Array.from({ length: 400 }, (_, index): ConformanceViolation => ({
      subject: `export${index}`,
      reason: "deleted",
      remedy: null,
    }));
    const result = expectApplied(settleObservedImplementation(
      graph(retryTask(attempt)),
      attempt,
      "2026-08-24T00:05:02.000Z" as never,
      { ...completedEvidence, contractConformance: violated(many as unknown as readonly [ConformanceViolation, ...ConformanceViolation[]]) },
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    const [kind] = result.state.tasks[0]?.implementation_attempt_history?.[0]?.failureKinds ?? [];
    expect(kind?.length).toBeLessThanOrEqual(4_096);
    const decoded = parseContractViolatedFailureKind(kind ?? "");
    if (!decoded.ok) throw new Error(decoded.errors.join("; "));
    expect(decoded.value.shown[0]).toEqual({ subject: "export0", reason: "deleted", remedy: null });
    expect(decoded.value.omitted).toBeGreaterThan(0);
    expect(decoded.value.shown.length + decoded.value.omitted).toBe(400);
    const disposition = deriveImplementationRetryDisposition(result.state.tasks[0]!);
    expect(disposition.kind === "retry" ? disposition.promptAppendix : "")
      .toContain(`  - and ${decoded.value.omitted} more violations not shown`);
    // The stored Proof still carries every violation.
    const proof = result.state.tasks[0]?.proof;
    expect(proof?.state === "failed" ? proof.failures[0] : undefined).toMatchObject({ violations: many });
  });

  it("AS-037: a not-owed observation settles exactly as before", () => {
    const attempt = authority(1, "contract-not-owed");
    const result = expectApplied(settleObservedImplementation(
      graph(retryTask(attempt)),
      attempt,
      "2026-08-24T00:05:03.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt),
    ));
    expect(result.transition.kind).toBe("implemented");
  });
});
