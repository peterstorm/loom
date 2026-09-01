import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  parseImplementationAttemptSettlementReceipt,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import {
  authorizeImplementationSpawn,
  createImplementationAttemptContext,
  deriveImplementationRetryDisposition,
  parseImplementationAttemptContext,
  parseImplementationRetryContext,
  renderImplementationRetryContext,
} from "../../src/core/implementation-retry";
import { canonicalJson, sha256Hex, type JsonValue } from "../../src/core/review-packet";
import {
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
} from "../../src/core/proof-obligations";

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

function authority(
  semanticAttempt: 1 | 2,
  reservationId: string,
  second: number,
  taskId = "T1",
): ImplementationAttemptAuthority {
  return valueOf(createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  }));
}

const proof = () => derivePendingTaskProof({
  newTestsRequired: false,
  declaredArtifacts: [],
});

function suite(attempt: ImplementationAttemptAuthority) {
  const authorized = valueOf(createTaskCompletionSuiteAuthority(attempt));
  return {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: authorized.implementationAuthorityDigest,
    suiteDigest: authorized.suiteDigest,
    checks: [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  };
}

function observation(observedAt: string, taskCompleted: boolean) {
  return {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt,
    evidence: {
      taskCompleted,
      testResult: { verdict: "trusted-pass" },
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "waived",
    },
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  };
}

function unavailable(observedAt: string) {
  return {
    schemaVersion: 1,
    kind: "implementation-observation-unavailable",
    observedAt,
    failure: { kind: "observation-unavailable", message: "temporary transport failure" },
  };
}

function settle(
  attempt: ImplementationAttemptAuthority,
  history: readonly ImplementationAttemptSettlementReceipt[],
  observed: unknown,
): ImplementationAttemptSettlementReceipt {
  const result = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: proof(),
    active_implementation_attempt: attempt,
    implementation_attempt_history: history,
  }, attempt, attempt, observed, suite(attempt));
  if (!result.ok || result.value.kind === "ignored") throw new Error("settlement fixture failed");
  return result.value.receipt;
}

function retryReceipt(): ImplementationAttemptSettlementReceipt {
  const attempt = authority(1, "attempt-one", 1);
  return settle(attempt, [], observation("2026-09-01T00:01:00.000Z", false));
}

function retryTask(history: readonly ImplementationAttemptSettlementReceipt[]) {
  return {
    id: "T1",
    implementation_attempt_history: history,
    implementation_retry_protocol: 2 as const,
    implementation_retry_history_start: 0,
  };
}

describe("bounded implementation retry admission", () => {
  it("starts a fresh lineage at semantic attempt 1 and rejects invented retry context", () => {
    const task = retryTask([]);
    expect(deriveImplementationRetryDisposition(task)).toEqual({ kind: "initial", semanticAttempt: 1 });
    expect(authorizeImplementationSpawn(task, "Task ID: T1")).toMatchObject({
      ok: true,
      kind: "initial",
      semanticAttempt: 1,
    });

    const foreign = deriveImplementationRetryDisposition(retryTask([retryReceipt()]));
    if (foreign.kind !== "retry") throw new Error("retry fixture failed");
    expect(authorizeImplementationSpawn(task, `Task ID: T1\n${foreign.promptAppendix}`)).toEqual({
      ok: false,
      error: "Task T1 has no current retry authority; refusing a caller-supplied retry context",
    });
  });

  it("requires the byte-exact current retry appendix before minting semantic attempt 2", () => {
    const receipt = retryReceipt();
    const task = retryTask([receipt]);
    const disposition = deriveImplementationRetryDisposition(task);
    expect(disposition.kind).toBe("retry");
    if (disposition.kind !== "retry") return;

    expect(authorizeImplementationSpawn(task, "Task ID: T1")).toEqual({
      ok: false,
      error: "Task T1 requires the exact attempt-2 retry context from orchestration status",
    });
    expect(authorizeImplementationSpawn(task, `Task ID: T1\n${disposition.promptAppendix}`)).toMatchObject({
      ok: true,
      kind: "retry",
      taskId: "T1",
      semanticAttempt: 2,
      promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      retryContext: disposition.context,
      predecessorReceiptId: receipt.receiptId,
    });
    const tampered = disposition.promptAppendix.replace(receipt.receiptId, "f".repeat(64));
    expect(authorizeImplementationSpawn(task, `Task ID: T1\n${tampered}`)).toMatchObject({ ok: false });
    const reformatted = disposition.promptAppendix.replace(": {", ": { ");
    expect(authorizeImplementationSpawn(task, `Task ID: T1\n${reformatted}`)).toEqual({
      ok: false,
      error: `Task T1 retry context bytes do not match current receipt ${receipt.receiptId}`,
    });
    expect(authorizeImplementationSpawn(
      task,
      `Task ID: T1\n${disposition.promptAppendix}\n${disposition.promptAppendix}`,
    )).toEqual({
      ok: false,
      error: "implementation prompt must contain at most one retry context",
    });
  });

  it("keeps both unknown-input parsers total", () => {
    fc.assert(fc.property(fc.anything(), (raw) => {
      expect(() => parseImplementationRetryContext(raw)).not.toThrow();
      expect(() => parseImplementationAttemptContext(raw)).not.toThrow();
    }));
  });

  it("round-trips exact retry and attempt contexts and rejects digest tampering", () => {
    const receipt = retryReceipt();
    const disposition = deriveImplementationRetryDisposition(retryTask([receipt]));
    if (disposition.kind !== "retry") throw new Error("retry fixture failed");
    const parsedRetry = parseImplementationRetryContext(JSON.parse(
      renderImplementationRetryContext(disposition.context).split(": ", 2)[1]!,
    ));
    expect(parsedRetry).toEqual({ ok: true, value: disposition.context });
    expect(parseImplementationRetryContext({ ...disposition.context, extra: true })).toMatchObject({ ok: false });
    expect(parseImplementationRetryContext({
      ...disposition.context,
      failureKinds: [...disposition.context.failureKinds, disposition.context.failureKinds[0]],
    })).toMatchObject({ ok: false });
    expect(parseImplementationRetryContext({
      ...disposition.context,
      semanticAttempt: 1,
    })).toMatchObject({ ok: false });

    const attempt = authority(2, "attempt-two", 2);
    const prompt = `Task ID: T1\n${disposition.promptAppendix}`;
    const admission = authorizeImplementationSpawn(retryTask([receipt]), prompt);
    if (!admission.ok || admission.kind !== "retry") throw new Error("retry admission fixture failed");
    const context = createImplementationAttemptContext({
      authority: attempt,
      prompt,
      admission,
    });
    expect(parseImplementationAttemptContext(JSON.parse(JSON.stringify(context)))).toEqual({
      ok: true,
      value: context,
    });
    expect(parseImplementationAttemptContext({ ...context, promptDigest: "b".repeat(64) })).toMatchObject({ ok: false });

    const initialAdmission = authorizeImplementationSpawn(retryTask([]), "Task ID: T1");
    if (!initialAdmission.ok) throw new Error("initial admission fixture failed");
    expect(() => createImplementationAttemptContext({
      authority: attempt,
      prompt: "Task ID: T1",
      admission: initialAdmission,
    })).toThrow("spawn admission authorizes 1");
    expect(() => createImplementationAttemptContext({
      authority: authority(2, "foreign-task", 3, "T2"),
      prompt,
      admission,
    })).toThrow("belongs to Task T2, but spawn admission belongs to T1");
    expect(() => createImplementationAttemptContext({
      authority: attempt,
      prompt: `${prompt}\nrepresentation drift`,
      admission,
    })).toThrow("does not match admitted prompt bytes");
    expect(() => createImplementationAttemptContext({
      authority: attempt,
      prompt,
      admission: {
        ...admission,
        retryContext: { ...admission.retryContext, taskId: "T2" as typeof admission.taskId },
      },
    })).toThrow("contradictory nested authority");
  });

  it("rejects settlement failure kinds that cannot inhabit Retry Context", () => {
    const receipt = retryReceipt();
    const { receiptId: _receiptId, ...body } = receipt;
    const oversized = {
      ...body,
      failureKinds: Array.from({ length: 65 }, (_, index) => `failure-${String(index).padStart(2, "0")}`),
    };
    expect(parseImplementationAttemptSettlementReceipt({
      ...oversized,
      receiptId: sha256Hex(canonicalJson(oversized as unknown as JsonValue)),
    })).toMatchObject({
      ok: false,
      error: { errors: [expect.stringContaining("must contain at most 64 entries")] },
    });
  });

  it("terminalizes attempt-2 semantic failure as explicit escalation", () => {
    const retry = retryReceipt();
    const attempt2 = authority(2, "attempt-two", 2);
    const escalation = settle(
      attempt2,
      [retry],
      observation("2026-09-01T00:02:00.000Z", false),
    );
    const task = retryTask([retry, escalation]);
    expect(deriveImplementationRetryDisposition(task)).toMatchObject({
      kind: "escalated",
      receiptId: escalation.receiptId,
    });
    expect(authorizeImplementationSpawn(task, "Task ID: T1")).toMatchObject({
      ok: false,
      error: expect.stringContaining("requires escalation"),
    });
  });

  it("starts a new attempt-1 lineage after an accepted implementation is deliberately reopened", () => {
    const retry = retryReceipt();
    const attempt2 = authority(2, "attempt-two", 2);
    const implemented = settle(
      attempt2,
      [retry],
      observation("2026-09-01T00:02:00.000Z", true),
    );
    expect(deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [retry, implemented],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    })).toEqual({ kind: "initial", semanticAttempt: 1 });
  });

  it("rejects every contradictory settlement transition in wire order", () => {
    const retry = retryReceipt();
    const attempt2Infrastructure = settle(
      authority(2, "attempt-two-infrastructure", 2),
      [retry],
      unavailable("2026-09-01T00:02:00.000Z"),
    );
    const escalation = settle(
      authority(2, "attempt-two-escalation", 3),
      [retry],
      observation("2026-09-01T00:03:00.000Z", false),
    );
    const attempt1Implemented = settle(
      authority(1, "attempt-one-implemented", 4),
      [],
      observation("2026-09-01T00:04:00.000Z", true),
    );
    const afterEscalation = settle(
      authority(2, "attempt-two-after-escalation", 5),
      [retry],
      unavailable("2026-09-01T00:05:00.000Z"),
    );

    const contradictory = [
      [attempt2Infrastructure, retry],
      [escalation, retry],
      [retry, attempt1Implemented],
      [retry, escalation, afterEscalation],
    ];
    for (const history of contradictory) {
      expect(deriveImplementationRetryDisposition(retryTask(history))).toMatchObject({ kind: "invalid" });
    }
    for (const receipt of [attempt2Infrastructure, escalation]) {
      expect(deriveImplementationRetryDisposition({
        id: "T1",
        implementation_attempt_history: [receipt],
      })).toMatchObject({
        kind: "invalid",
        errors: [expect.stringContaining("pre-protocol Slice-3 compatibility")],
      });
    }
  });

  it("projects pre-protocol Slice-3 attempt-1 histories without rewriting receipts", () => {
    const retry = retryReceipt();
    const implemented = settle(
      authority(1, "legacy-implemented", 6),
      [],
      observation("2026-09-01T00:06:00.000Z", true),
    );
    const infrastructure = settle(
      authority(1, "legacy-infrastructure", 7),
      [],
      unavailable("2026-09-01T00:07:00.000Z"),
    );
    const repeatedRetry = settle(
      authority(1, "legacy-repeated-retry", 8),
      [],
      observation("2026-09-01T00:08:00.000Z", false),
    );

    expect(deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [retry, implemented],
    })).toEqual({ kind: "initial", semanticAttempt: 1 });
    const legacyInfrastructureTask = {
      id: "T1",
      implementation_attempt_history: [retry, infrastructure],
    };
    const legacyInfrastructureDisposition = deriveImplementationRetryDisposition(legacyInfrastructureTask);
    expect(legacyInfrastructureDisposition).toMatchObject({
      kind: "retry",
      predecessor: { receiptId: retry.receiptId },
    });
    if (legacyInfrastructureDisposition.kind !== "retry") throw new Error("legacy retry projection failed");
    const migrationPrompt = `Task ID: T1\n${legacyInfrastructureDisposition.promptAppendix}`;
    const migrationAdmission = authorizeImplementationSpawn(legacyInfrastructureTask, migrationPrompt);
    if (!migrationAdmission.ok) throw new Error(migrationAdmission.error);
    expect(migrationAdmission).toMatchObject({
      historyStart: 2,
      lineagePredecessorReceiptId: retry.receiptId,
    });
    expect(deriveImplementationRetryDisposition({
      ...legacyInfrastructureTask,
      implementation_retry_protocol: 2,
      implementation_retry_history_start: migrationAdmission.historyStart,
      implementation_retry_predecessor_receipt_id: migrationAdmission.lineagePredecessorReceiptId ?? undefined,
    })).toMatchObject({ kind: "retry", predecessor: { receiptId: retry.receiptId } });
    expect(deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [retry, repeatedRetry],
    })).toMatchObject({ kind: "retry", predecessor: { receiptId: repeatedRetry.receiptId } });
    expect(deriveImplementationRetryDisposition({
      ...legacyInfrastructureTask,
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 2,
    })).toMatchObject({ kind: "invalid" });
    expect(deriveImplementationRetryDisposition({
      ...legacyInfrastructureTask,
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 2,
      implementation_retry_predecessor_receipt_id: repeatedRetry.receiptId,
    })).toMatchObject({ kind: "invalid" });
    expect(deriveImplementationRetryDisposition({
      ...retryTask([retry]),
      implementation_retry_predecessor_receipt_id: retry.receiptId,
    })).toMatchObject({ kind: "invalid" });

    const attempt2 = authority(2, "legacy-terminal", 9);
    const escalation = settle(
      attempt2,
      [retry],
      observation("2026-09-01T00:09:00.000Z", false),
    );
    expect(deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [retry, escalation, implemented],
    })).toMatchObject({ kind: "invalid" });
    expect(deriveImplementationRetryDisposition({
      id: "T1",
      implementation_attempt_history: [retry, escalation],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 2,
    })).toMatchObject({ kind: "invalid" });
  });

  it("infrastructure receipts never consume the semantic attempt budget", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.uuid(), { maxLength: 20 }),
      (reservationIds) => {
        const infrastructure = reservationIds.map((reservationId, index) => {
          const attempt = authority(1, reservationId, 10 + index);
          return settle(
            attempt,
            [],
            unavailable(`2026-09-01T00:03:${String(index).padStart(2, "0")}.000Z`),
          );
        });
        const retry = retryReceipt();
        expect(deriveImplementationRetryDisposition(retryTask([...infrastructure, retry]))).toMatchObject({
          kind: "retry",
          semanticAttempt: 2,
        });
      },
    ));
  });

  it("preserves semantic attempt 2 across one or many infrastructure failures", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 20 }),
      (reservationIds) => {
        const retry = retryReceipt();
        const infrastructure = reservationIds.map((reservationId, index) => settle(
          authority(2, reservationId, 10 + index),
          [retry],
          unavailable(`2026-09-01T00:04:${String(index).padStart(2, "0")}.000Z`),
        ));
        expect(deriveImplementationRetryDisposition(retryTask([retry, ...infrastructure]))).toMatchObject({
          kind: "retry",
          semanticAttempt: 2,
          predecessor: { receiptId: retry.receiptId },
        });
      },
    ));
  });
});
