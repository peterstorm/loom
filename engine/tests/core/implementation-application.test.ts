import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyImplementationCompletionTransition,
  buildTaskLocalByteObservation,
  normalizeImplementationEvidence,
  settleObservedImplementation,
  settleUnavailableImplementation,
  type TaskLocalByteObservation,
} from "../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
} from "../../src/core/proof-obligations";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { Task, TaskGraph } from "../../src/types";

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
    repositoryDirtySetChanged: false,
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
    spec_check: {
      wave: 1,
      run_at: "2026-08-24T00:00:00.000Z",
      verdict: "BLOCKED",
      critical_count: 1,
      high_count: 0,
      critical_findings: ["stale spec finding"],
      high_findings: [],
      medium_findings: [],
    },
  };
}

const completedEvidence = {
  taskCompleted: true,
  newTestsWritten: false,
  newTestEvidence: "verification_policy.new_tests waived: legacy-new-tests-required-false",
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
    expect(bytes.exactTaskBytesChanged).toBe(true);
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
    expect(bytes.exactTaskBytesChanged).toBe(true);
    expect(bytes.invalidationBytesChanged).toBe(true);
  });

  it("never turns repository dirty-set movement into Task attribution or proof", () => {
    const bytes = observedBytes(authority(), {
      currentAttemptScope: baseline("src/a.ts", digest("a")),
      currentProofScope: baseline("src/a.ts", digest("a")),
      parserModifiedPaths: [],
      repositoryDirtySetChanged: true,
    });
    expect(bytes.suite.checks[0]?.outcome).toEqual({ kind: "accepted", changedPaths: [] });
    expect(bytes.cumulativeProofArtifactChanges).toEqual([]);
    expect(bytes.exactTaskBytesChanged).toBe(false);
    expect(bytes.invalidationBytesChanged).toBe(true);
  });
});

describe("shared evidence preservation", () => {
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
          newTestsWritten: false,
        },
        TRUSTED_LEDGER_ONLY_POLICY,
        observedBytes(attempt),
      ));
      expect(result.transition.kind).toBe(semanticAttempt === 1 ? "retry-required" : "escalation-required");
      expect(result.state.tasks[0]).toMatchObject({ status: "pending", proof: { state: "failed" } });
      expect(result.state.tasks[0]?.implementation_attempt_history?.[0]?.consumesSemanticAttempt).toBe(true);
      expect(result.state.executing_tasks).toEqual([]);
      expect(result.state.tasks[0]?.active_implementation_attempt).toBeUndefined();
      expect(result.state.tasks[0]).not.toHaveProperty("retry_request");
    }
  });

  it("keeps satisfied historical Proof pending+revalidation when only the Task suite fails", () => {
    const attempt = authority();
    const result = expectApplied(settleObservedImplementation(
      graph(pendingTask(attempt)),
      attempt,
      "2026-08-24T00:03:00.000Z" as never,
      completedEvidence,
      TRUSTED_LEDGER_ONLY_POLICY,
      observedBytes(attempt, { parserModifiedPaths: ["src/a.ts", "foreign.ts"] }),
    ));
    expect(result.transition.kind).toBe("retry-required");
    expect(result.state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "satisfied" },
      revalidation_required: true,
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
