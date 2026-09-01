import { describe, expect, expectTypeOf, it } from "vitest";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  parseImplementationObservation,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type TaskId,
} from "../src/core/implementation-completion";
import {
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
  evaluateProofObligations,
} from "../src/core/proof-obligations";
import { parseTaskGraph } from "../src/state-manager";
import {
  authorizeImplementationSpawn,
  createImplementationAttemptContext,
  deriveImplementationRetryDisposition,
} from "../src/core/implementation-retry";

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

const attemptBaseline = [{
  artifact: "engine/src/a.ts",
  snapshot: { kind: "sha256", digest: "a".repeat(64) },
}];
const repositoryBaseline = [{
  artifact: "README.md",
  snapshot: { kind: "sha256", digest: "b".repeat(64) },
}];

function authority(
  reservationId = "state-reservation-1",
  semanticAttempt: 1 | 2 = 1,
): ImplementationAttemptAuthority {
  return valueOf(createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt,
    reservationId,
    headSha: "c".repeat(40),
    reservedAt: "2026-08-23T00:00:00.000Z",
    taskScopeBaseline: attemptBaseline,
    dirtySetBaseline: repositoryBaseline,
  }));
}

function initialContext(active: ImplementationAttemptAuthority, prompt = "Task ID: T1") {
  const admission = authorizeImplementationSpawn({ id: "T1" }, prompt);
  if (!admission.ok) throw new Error(admission.error);
  return createImplementationAttemptContext({ authority: active, prompt, admission });
}

const pendingProof = () => derivePendingTaskProof({
  newTestsRequired: false,
  declaredArtifacts: ["engine/src/a.ts"],
});

const baseTask = () => ({
  id: "T1",
  description: "implement completion",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
  new_tests_required: false,
  file_list: ["engine/src/a.ts"],
});

const graph = (task: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [task],
  wave_gates: {},
  ...overrides,
});

function errorOf(raw: Record<string, unknown>): string {
  const parsed = parseTaskGraph(raw);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("expected rejection");
  return parsed.error;
}

function receiptFor(attempt: ImplementationAttemptAuthority, taskCompleted = true) {
  const suite = valueOf(createTaskCompletionSuiteAuthority(attempt));
  const observation = valueOf(parseImplementationObservation({
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-08-23T00:01:00.000Z",
    evidence: {
      taskCompleted,
      filesModified: ["engine/src/a.ts"],
    },
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  }));
  const settled = settleImplementationAttempt(
    {
      id: "T1",
      status: "pending",
      proof: pendingProof(),
      active_implementation_attempt: attempt,
      implementation_attempt_history: [],
    },
    attempt,
    attempt,
    observation,
    {
      schemaVersion: 1,
      kind: "task-completion-suite-result",
      implementationAuthorityDigest: suite.implementationAuthorityDigest,
      suiteDigest: suite.suiteDigest,
      checks: [{
        checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
        scope: "task",
        outcome: { kind: "accepted", changedPaths: ["engine/src/a.ts"] },
      }],
    },
  );
  if (!settled.ok || settled.value.kind === "ignored") throw new Error("fixture must settle");
  return settled.value.receipt;
}

function infrastructureReceiptFor(attempt: ImplementationAttemptAuthority) {
  const suite = valueOf(createTaskCompletionSuiteAuthority(attempt));
  const settled = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: pendingProof(),
    active_implementation_attempt: attempt,
    implementation_attempt_history: [],
  }, attempt, attempt, {
    schemaVersion: 1,
    kind: "implementation-observation-unavailable",
    observedAt: "2026-08-23T00:02:00.000Z",
    failure: { kind: "observation-unavailable", message: "legacy transport failure" },
  }, {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest,
    suiteDigest: suite.suiteDigest,
    checks: [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  });
  if (!settled.ok || settled.value.kind !== "infrastructure-blocked") {
    throw new Error("legacy infrastructure receipt fixture failed");
  }
  return settled.value.receipt;
}

describe("Task lifecycle migration", () => {
  it("derives pending Proof for a legacy pending Task and round-trips the modern arm", () => {
    const parsed = parseTaskGraph(graph(baseTask()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expectTypeOf(parsed.value.tasks[0]!.id).toEqualTypeOf<TaskId>();
    expect(parsed.value.tasks[0]?.status).toBe("pending");
    expect(parsed.value.tasks[0]?.proof?.state).toBe("pending");
    expect(Object.isFrozen(parsed.value.tasks[0]?.proof)).toBe(true);
    expect(parseTaskGraph(JSON.parse(JSON.stringify(parsed.value))).ok).toBe(true);
  });

  it.each(["implemented", "completed"])(
    "classifies legacy %s without Proof using the protected marker instead of inventing evidence",
    (status) => {
      const parsed = parseTaskGraph(graph({ ...baseTask(), status }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const task = parsed.value.tasks[0];
      expect(task?.status).toBe(status);
      expect(task?.proof).toBeUndefined();
      expect(task?.legacy_missing_proof).toBe(true);
      expect(parseTaskGraph(JSON.parse(JSON.stringify(parsed.value))).ok).toBe(true);
    },
  );

  it("rejects every illegal modern status/Proof/revalidation combination", () => {
    const pending = pendingProof();
    const satisfied = evaluateProofObligations(pending.obligations, {
      taskCompleted: true,
      filesModified: ["engine/src/a.ts"],
    });
    if (satisfied.state !== "satisfied") throw new Error("fixture must satisfy");
    const failed = evaluateProofObligations(pending.obligations, {
      taskCompleted: false,
      filesModified: [],
    });
    if (failed.state !== "failed") throw new Error("fixture must fail");

    const invalid = [
      { ...baseTask(), status: "implemented", proof: failed },
      { ...baseTask(), status: "completed", proof: pending },
      { ...baseTask(), status: "failed", proof: satisfied },
      { ...baseTask(), status: "failed" },
      { ...baseTask(), status: "pending", proof: satisfied },
      { ...baseTask(), status: "implemented", proof: satisfied, revalidation_required: true },
      { ...baseTask(), status: "implemented", proof: satisfied, legacy_missing_proof: true },
    ];
    invalid.forEach((task) => expect(parseTaskGraph(graph(task)).ok).toBe(false));
    expect(parseTaskGraph(graph({
      ...baseTask(),
      status: "pending",
      proof: satisfied,
      revalidation_required: true,
    })).ok).toBe(true);
  });
});

describe("Task attempt authority StateManager lockstep", () => {
  it("parses and freezes exact active authority, context, baselines, and history", () => {
    const active = authority();
    const context = initialContext(active);
    const receipt = receiptFor(authority("settled-reservation"));
    const parsed = parseTaskGraph(graph({
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      active_implementation_context: context,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
      implementation_attempt_history: [receipt],
    }, { executing_tasks: ["T1"] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const task = parsed.value.tasks[0];
    expect(task?.active_implementation_attempt).toEqual(active);
    expect(task?.active_implementation_context).toEqual(context);
    expect(task?.implementation_attempt_history).toEqual([receipt]);
    expect(task?.legacy_execution_reservation).toBeUndefined();
    expect(Object.isFrozen(task?.active_implementation_attempt)).toBe(true);
    expect(Object.isFrozen(task?.active_implementation_context)).toBe(true);
    expect(Object.isFrozen(task?.implementation_attempt_history)).toBe(true);
  });

  it("rejects orphaned and digest-tampered active attempt context", () => {
    const active = authority();
    const context = initialContext(active);
    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_context: context,
    }))).toContain("requires active_implementation_attempt");

    const valid = {
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      active_implementation_context: context,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    };
    expect(errorOf(graph({
      ...valid,
      active_implementation_context: { ...context, authorityDigest: "f".repeat(64) },
    }, { executing_tasks: ["T1"] }))).toContain("contextDigest does not match");
    expect(errorOf(graph({
      ...valid,
      active_implementation_context: { ...context, contextDigest: "f".repeat(64) },
    }, { executing_tasks: ["T1"] }))).toContain("contextDigest does not match");
  });

  it("rejects a digest-valid attempt-2 context bound to a stale predecessor receipt", () => {
    const staleRetry = receiptFor(authority("stale-retry-source"), false);
    const currentRetry = receiptFor(authority("current-retry-source"), false);
    const active = authority("retry-active-stale-context", 2);
    const retry = deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [staleRetry],
    });
    if (retry.kind !== "retry") throw new Error("retry fixture failed");
    const prompt = `Task ID: T1\n${retry.promptAppendix}`;
    const staleAdmission = authorizeImplementationSpawn({
      id: "T1",
      implementation_attempt_history: [staleRetry],
    }, prompt);
    if (!staleAdmission.ok) throw new Error(staleAdmission.error);
    const staleContext = createImplementationAttemptContext({ authority: active, prompt, admission: staleAdmission });

    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      active_implementation_context: staleContext,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
      implementation_attempt_history: [currentRetry],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    }, { executing_tasks: ["T1"] }))).toContain("active retry context must match the current retry-required receipt");
  });

  it("requires exact active context for semantic attempt 2", () => {
    const retry = receiptFor(authority("retry-source"), false);
    const active = authority("retry-active", 2);
    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
      implementation_attempt_history: [retry],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    }, { executing_tasks: ["T1"] }))).toContain("protocol-2 active implementation requires active_implementation_context");

    const initial = authority("protocol-two-initial", 1);
    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: initial,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: initial.reservedAt,
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    }, { executing_tasks: ["T1"] }))).toContain(
      "protocol-2 active implementation requires active_implementation_context",
    );
  });

  it("loads pre-protocol Slice-3 attempt-1 histories without rewriting receipts", () => {
    const retry = receiptFor(authority("legacy-retry"), false);
    const implemented = receiptFor(authority("legacy-implemented"), true);
    const infrastructure = infrastructureReceiptFor(authority("legacy-infrastructure"));
    const repeatedRetry = receiptFor(authority("legacy-repeated-retry"), false);

    for (const history of [
      [retry, implemented],
      [retry, infrastructure],
      [retry, repeatedRetry],
    ]) {
      const parsed = parseTaskGraph(graph({
        ...baseTask(),
        proof: pendingProof(),
        implementation_attempt_history: history,
      }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.tasks[0]?.implementation_attempt_history).toEqual(history);
        expect(parsed.value.tasks[0]?.implementation_retry_protocol).toBeUndefined();
      }
    }
  });

  it("rejects active modern authority on the legacy-missing-Proof lifecycle", () => {
    const active = authority();
    expect(errorOf(graph({
      ...baseTask(),
      status: "implemented",
      active_implementation_attempt: active,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    }, { executing_tasks: ["T1"] }))).toContain("requires modern authored Proof");
  });

  it("rejects missing executing membership, baseline/digest drift, reservation-time drift, and receipt Task drift", () => {
    const active = authority();
    const valid = {
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    };
    expect(errorOf(graph(valid))).toContain("requires executing_tasks membership");
    expect(errorOf(graph({
      ...valid,
      attempt_repository_baseline: [{
        artifact: "README.md",
        snapshot: { kind: "sha256", digest: "d".repeat(64) },
      }],
    }, { executing_tasks: ["T1"] }))).toContain("baseline digests do not match");
    expect(errorOf(graph({
      ...valid,
      reserved_at: "2026-08-23T00:00:01.000Z",
    }, { executing_tasks: ["T1"] }))).toContain("reserved_at must equal");
    const receipt = receiptFor(authority("drifted-receipt"));
    expect(errorOf(graph({
      ...valid,
      implementation_attempt_history: [{ ...receipt, taskId: "T2" }],
    }, { executing_tasks: ["T1"] }))).toContain("receiptId does not match");
  });

  it("rejects an active authority whose digest or reservation already appears in history", () => {
    const active = authority("reused-reservation");
    const valid = {
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    };
    expect(errorOf(graph({
      ...valid,
      implementation_attempt_history: [receiptFor(active)],
    }, { executing_tasks: ["T1"] }))).toContain("must be absent from implementation_attempt_history");

    const differentDigestSameReservation = valueOf(createImplementationAttemptAuthority({
      taskId: "T1",
      wave: 1,
      semanticAttempt: 1,
      reservationId: active.reservationId,
      headSha: "d".repeat(40),
      reservedAt: "2026-08-23T00:00:01.000Z",
      taskScopeBaseline: attemptBaseline,
      dirtySetBaseline: repositoryBaseline,
    }));
    expect(differentDigestSameReservation.authorityDigest).not.toBe(active.authorityDigest);
    expect(errorOf(graph({
      ...valid,
      implementation_attempt_history: [receiptFor(differentDigestSameReservation)],
    }, { executing_tasks: ["T1"] }))).toContain("must be absent from implementation_attempt_history");
  });

  it("requires the active attempt baseline path set to equal unique(file_list + files_modified)", () => {
    const scopedBaseline = [
      ...attemptBaseline,
      { artifact: "engine/src/prior.ts", snapshot: { kind: "missing" as const } },
    ];
    const active = valueOf(createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: "scope-reservation",
      headSha: "c".repeat(40), reservedAt: "2026-08-23T00:00:00.000Z",
      taskScopeBaseline: scopedBaseline, dirtySetBaseline: repositoryBaseline,
    }));
    const valid = {
      ...baseTask(),
      files_modified: ["engine/src/prior.ts", "engine/src/a.ts"],
      proof: pendingProof(),
      active_implementation_attempt: active,
      attempt_artifact_baseline: scopedBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    };
    expect(parseTaskGraph(graph(valid, { executing_tasks: ["T1"] })).ok).toBe(true);
    expect(errorOf(graph({
      ...valid,
      attempt_artifact_baseline: attemptBaseline,
    }, { executing_tasks: ["T1"] }))).toContain("unique(file_list + files_modified)");
    expect(errorOf(graph({
      ...valid,
      attempt_artifact_baseline: [
        ...scopedBaseline,
        { artifact: "engine/src/surplus.ts", snapshot: { kind: "missing" } },
      ],
    }, { executing_tasks: ["T1"] }))).toContain("unique(file_list + files_modified)");
  });

  it("keeps legacy executing entries readable but explicitly classified", () => {
    const parsed = parseTaskGraph(graph(baseTask(), { executing_tasks: ["T1"] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tasks[0]?.legacy_execution_reservation).toBe(true);
    expect(parsed.value.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(parseTaskGraph(JSON.parse(JSON.stringify(parsed.value))).ok).toBe(true);
  });

  it("retires stale legacy classifications, rejects orphan reservations with repair guidance, and rejects duplicate receipts", () => {
    const staleMarker = parseTaskGraph(graph({ ...baseTask(), legacy_execution_reservation: true }));
    expect(staleMarker.ok).toBe(true);
    if (staleMarker.ok) expect(staleMarker.value.tasks[0]?.legacy_execution_reservation).toBeUndefined();
    expect(errorOf(graph(baseTask(), { executing_tasks: ["T99"] }))).toContain(
      "orphan execution reservation T99",
    );
    const active = authority();
    const receipt = receiptFor(active);
    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      implementation_attempt_history: [receipt, receipt],
    }))).toContain("duplicate receipt IDs");
  });

  it("parser-enforces persistent repository carry and migrates active legacy authority safely", () => {
    const active = authority("carry-parser");
    const activeTask = {
      ...baseTask(),
      proof: pendingProof(),
      active_implementation_attempt: active,
      attempt_artifact_baseline: attemptBaseline,
      attempt_repository_baseline: repositoryBaseline,
      reserved_at: active.reservedAt,
    };
    const migrated = parseTaskGraph(graph(activeTask, { executing_tasks: ["T1"] }));
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect(migrated.value.tasks[0]?.repository_baseline).toEqual(repositoryBaseline);

    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      repository_baseline: repositoryBaseline,
      unresolved_repository_paths: ["foreign.ts", "foreign.ts"],
    }))).toContain("unresolved_repository_paths");
    expect(errorOf(graph({
      ...baseTask(),
      proof: pendingProof(),
      unresolved_repository_paths: ["foreign.ts"],
    }))).toContain("requires repository_baseline");
  });
});
