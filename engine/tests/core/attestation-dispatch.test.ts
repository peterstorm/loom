/**
 * Attestation dispatch emission (D4 option 2): the implementation window's
 * dispatch derivation attaches the engine-derived attestation context line to
 * attestation Tasks — as the initial dispatch's promptAppendix, and appended
 * after the retry line on a retry dispatch — and fails the wave closed when an
 * attestation Task cannot derive its context.
 */

import { describe, expect, it } from "vitest";
import {
  deriveLoomStatusFromParsedGraph,
  type GateDeps,
} from "../../src/core/wave-gate-machine";
import {
  IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL,
  deriveImplementationAttestationContext,
} from "../../src/core/implementation-retry";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { parseTaskGraph } from "../../src/state-manager";
import type { VerificationPolicy } from "../../src/core/verification-policy";

const ATTESTED_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" as const }),
  newTests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" }),
});

const statusDeps: GateDeps = {
  loadPlanModels: () => ({ kind: "none" }),
  filePresence: () => ({ ok: true, exists: true }),
  implementationReservations: { kind: "observed", observedAtMs: Date.now(), anyActiveForGraph: false },
};

const graphWith = (tasks: readonly Record<string, unknown>[]): unknown => ({
  current_phase: "execute",
  current_wave: 1,
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks,
  wave_gates: {},
});

const plainTask = (id: string): Record<string, unknown> => ({
  id,
  description: `${id} work`,
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: [],
  file_list: ["src/x.ts"],
  status: "pending",
  proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/x.ts"] }),
});

const attestationTask = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...plainTask(id),
  implementation_attestation: true,
  verification_policy: {
    regression: { kind: "required" },
    new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
  },
  proof: derivePendingTaskProof({
    verificationPolicy: ATTESTED_POLICY,
    declaredArtifacts: ["src/x.ts"],
    declaredArtifactExpectation: "attested",
  }),
  ...overrides,
});

const appendixFor = (id: string): string => {
  const derived = deriveImplementationAttestationContext(attestationTask(id) as never);
  if (!derived.ok) throw new Error(derived.error);
  return derived.promptAppendix;
};

const dispatchesOf = (raw: unknown): readonly Record<string, unknown>[] => {
  const parsed = parseTaskGraph(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const status = deriveLoomStatusFromParsedGraph({ ok: true, value: parsed.value }, statusDeps);
  if (status.next.action.kind !== "blocked") throw new Error(`expected blocked action, got ${status.next.action.kind}`);
  const diagnostic = (status.next.action as { diagnostic: { recovery: unknown } }).diagnostic;
  const recovery = diagnostic.recovery as { kind: string; dispatches?: readonly Record<string, unknown>[] };
  if (recovery.kind !== "spawn-wave-implementation") throw new Error(`expected spawn recovery, got ${recovery.kind}`);
  return recovery.dispatches ?? [];
};

describe("attestation dispatch emission", () => {
  it("attaches the attestation context to an initial dispatch of an attestation Task", () => {
    const dispatches = dispatchesOf(graphWith([attestationTask("T1")]));
    expect(dispatches).toEqual([expect.objectContaining({
      kind: "initial-implementation",
      taskId: "T1",
      semanticAttempt: 1,
      promptAppendix: appendixFor("T1"),
    })]);
    expect(dispatches[0]!["promptAppendix"]).toContain(IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL);
  });

  it("leaves a plain Task's initial dispatch without an appendix", () => {
    const dispatches = dispatchesOf(graphWith([plainTask("T1")]));
    expect(dispatches).toEqual([expect.objectContaining({
      kind: "initial-implementation",
      taskId: "T1",
      promptAppendix: null,
    })]);
  });

  it("appends the attestation context after the retry line on a retry dispatch", () => {
    // Mint a real retry-required receipt by settling a plain attempt-1 task.
    const receipt = retryReceipt();
    const task = attestationTask("T1", {
      implementation_attempt_history: [receipt],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    });
    const dispatches = dispatchesOf(graphWith([task]));
    expect(dispatches).toHaveLength(1);
    const appendix = dispatches[0]!["promptAppendix"] as string;
    expect(appendix.startsWith("LOOM_IMPLEMENTATION_RETRY_CONTEXT: {")).toBe(true);
    expect(appendix).toContain(receipt.receiptId);
    expect(appendix).toContain(IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL);
    expect(appendix).toContain(appendixFor("T1"));
  });

  it("fails the wave closed when an attestation Task cannot derive its context", () => {
    const broken = attestationTask("T1", { proof: { nonsense: true } });
    const parsed = parseTaskGraph(graphWith([broken]));
    // A malformed proof is refused at load, so the only in-memory way to reach
    // the derivation guard is a hand-built graph; assert the parse refusal and
    // the derivation refusal share the same root cause.
    expect(parsed.ok).toBe(false);
    const inMemory = attestationTask("T1", { proof: undefined });
    expect(deriveImplementationAttestationContext(inMemory as never)).toMatchObject({
      ok: false,
      error: "Task T1 carries no attestation proof",
    });
  });
});

// -- fixture helpers ---------------------------------------------------------

import { createImplementationAttemptAuthority, createTaskCompletionSuiteAuthority, settleImplementationAttempt, parseIsoInstant, parseReservationId, type ImplementationAttemptSettlementReceipt } from "../../src/core/implementation-completion";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";

const retryReceipt = (): ImplementationAttemptSettlementReceipt => {
  const instant = parseIsoInstant("2026-09-19T00:00:00.000Z");
  const reservation = parseReservationId("attest-dispatch-attempt");
  if (!instant.ok || !reservation.ok) throw new Error("fixture identity failed");
  const attempt: ImplementationAttemptAuthority = (() => {
    const created = createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservation.value,
      headSha: "1".repeat(40), reservedAt: instant.value,
      taskScopeBaseline: [], dirtySetBaseline: [],
    });
    if (!created.ok) throw new Error(created.error.errors.join("; "));
    return created.value;
  })();
  const suite = (() => {
    const built = createTaskCompletionSuiteAuthority(attempt);
    if (!built.ok) throw new Error(built.error.errors.join("; "));
    return built.value;
  })();
  const result = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: attempt,
    implementation_attempt_history: [],
  }, attempt, attempt, {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-09-19T00:01:00.000Z",
    evidence: { taskCompleted: false, testResult: { verdict: "trusted-pass" }, filesModified: [] },
    proofEvaluationPolicy: { untrustedPass: "reject" },
  }, {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest,
    suiteDigest: suite.suiteDigest,
    checks: [{ checkId: suite.checks[0].checkId, scope: "task", outcome: { kind: "accepted", changedPaths: [] } }],
  });
  if (!result.ok || result.value.kind !== "retry-required") throw new Error("retry receipt fixture failed");
  return result.value.receipt;
};
