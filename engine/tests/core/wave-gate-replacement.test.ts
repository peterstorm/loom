import { describe, expect, it } from "vitest";
import {
  prepareExhaustedWaveGateRestart,
  sameOrphanRecoveryRegistration,
  sameRestartRegistration,
} from "../../src/core/wave-gate-replacement";
import { advisoryDecisionApproved } from "../../src/core/wave-gate-membership";
import { markWaveSpecCheckRetryIssuedTransition, waveBatchSpecCheckAuthority } from "../../src/core/wave-review-issuance";
import type { RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import type { WaveRequestBatch } from "../../src/core/wave-review-authority";
import type { TaskGraph } from "../../src/types";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";

const DIGEST = "a".repeat(64);
const registration = (overrides: Partial<Extract<RegisteredWaveGateProgram, { schemaVersion: 1 }>> = {}):
  Extract<RegisteredWaveGateProgram, { schemaVersion: 1 }> => ({
  schemaVersion: 1, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: DIGEST, ...overrides,
});
const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  current_phase: "execute",
  current_wave: 1,
  tasks: [],
  active_wave_gate: {
    schemaVersion: 1, kind: "active-wave-gate", runId: "run.previous", wave: 1,
    authorityDigest: DIGEST, revision: 0, terminalOutcome: null,
  },
  ...overrides,
} as unknown as TaskGraph);

describe("prepareExhaustedWaveGateRestart refusal ladder", () => {
  const restart = (state: TaskGraph, previous = registration()) =>
    prepareExhaustedWaveGateRestart(state, "run.previous", previous, "run.next", "/runs", new Set());

  it("requires exact protected execute/current_wave authority", () => {
    expect(restart(graph({ current_wave: 2 }))).toEqual({
      ok: false, message: "Wave Gate restart requires exact protected execute/current_wave authority",
    });
    expect(restart(graph(), registration({ input: { wave: null } })).ok).toBe(false);
  });

  it("requires the previous run to still own active authority", () => {
    expect(restart(graph({ active_wave_gate: undefined }))).toEqual({
      ok: false, message: "the previous run no longer owns exact active Wave Gate authority",
    });
  });

  it("requires the previous run's exact review epoch", () => {
    expect(restart(graph())).toEqual({ ok: false, message: "the previous run has no exact active Wave review epoch" });
  });
});

describe("replacement registration identity", () => {
  it("compares restart audits slot by slot", () => {
    const left = registration({ restart: { previousRunId: "run.previous", exhaustedSlots: ["T1/code-reviewer"] } });
    expect(sameRestartRegistration(left, left)).toBe(true);
    expect(sameRestartRegistration(left, { ...left, restart: { previousRunId: "run.previous", exhaustedSlots: ["T1/other"] } })).toBe(false);
    expect(sameRestartRegistration(left, { ...left, restart: { previousRunId: "run.other", exhaustedSlots: ["T1/code-reviewer"] } })).toBe(false);
    expect(sameRestartRegistration(left, { ...left, taskIds: ["T2"] })).toBe(false);
  });

  it("compares orphan-recovery audits and protocol", () => {
    const left = registration({ orphanRecovery: { previousRunId: "run.previous", previousAuthorityDigest: DIGEST } });
    expect(sameOrphanRecoveryRegistration(left, left)).toBe(true);
    expect(sameOrphanRecoveryRegistration(left, { ...left, orphanRecovery: { previousRunId: "run.previous", previousAuthorityDigest: "b".repeat(64) } })).toBe(false);
    expect(sameOrphanRecoveryRegistration(left, { ...left, authorityDigest: "b".repeat(64) })).toBe(false);
  });
});

describe("advisoryDecisionApproved", () => {
  const approve = (decisionId: string, decision: unknown = { kind: "approve" }) =>
    ({ event: { kind: "user-decision-recorded", decisionId, decision } });

  it("accepts only an exact approve decision for this request", () => {
    expect(advisoryDecisionApproved([approve("d1")], "d1")).toBe(true);
    expect(advisoryDecisionApproved([approve("d2")], "d1")).toBe(false);
    expect(advisoryDecisionApproved([approve("d1", { kind: "reject" })], "d1")).toBe(false);
    expect(advisoryDecisionApproved([approve("d1", { kind: "approve", extra: 1 })], "d1")).toBe(false);
    expect(advisoryDecisionApproved([approve("d1", [{ kind: "approve" }])], "d1")).toBe(false);
    expect(advisoryDecisionApproved([{ event: null }, { event: "approve" }], "d1")).toBe(false);
  });
});

describe("Wave review issuance transitions", () => {
  const specCheck = { runId: "run.next", slotId: "slot:spec", role: "spec-check-invoker", attempt: 2 } as unknown as AgentRequestAuthority;
  const epochGraph = (attempted: 1 | 2) => graph({
    active_wave_gate: { ...graph().active_wave_gate!, runId: "run.next" },
    wave_review_epoch: { runId: "run.next", wave: 1, batchEpoch: "epoch", specCheckSlotAuthority: { slot_id: "slot:spec", attempted } },
  } as Partial<TaskGraph>);

  it("marks spec-check attempt 2 on the exact current epoch slot, idempotently", () => {
    const marked = markWaveSpecCheckRetryIssuedTransition(epochGraph(1), specCheck, "epoch");
    expect(marked.ok && marked.value.wave_review_epoch?.specCheckSlotAuthority?.attempted).toBe(2);
    const already = epochGraph(2);
    expect(markWaveSpecCheckRetryIssuedTransition(already, specCheck, "epoch")).toEqual({ ok: true, value: already });
  });

  it("refuses a spec-check retry from another epoch", () => {
    expect(markWaveSpecCheckRetryIssuedTransition(epochGraph(1), specCheck, "older-epoch")).toEqual({
      ok: false, error: { message: "spec-check retry authority does not match the exact current Wave review epoch slot" },
    });
  });

  it("requires every Wave review batch to open with spec-check attempt-1 authority", () => {
    const batch = (requests: readonly unknown[]) => ({ requests: requests.map((authority) => ({ authority })) }) as unknown as WaveRequestBatch;
    expect(waveBatchSpecCheckAuthority(batch([{ role: "code-reviewer", attempt: 1 }])).ok).toBe(false);
    expect(waveBatchSpecCheckAuthority(batch([{ role: "spec-check-invoker", attempt: 2 }])).ok).toBe(false);
    const authority = { role: "spec-check-invoker", attempt: 1 };
    expect(waveBatchSpecCheckAuthority(batch([authority]))).toEqual({ ok: true, value: authority });
  });
});

describe("replacement registration identity is shared by restart and orphan recovery", () => {
  const schemaTwo = (overrides: Partial<Extract<RegisteredWaveGateProgram, { schemaVersion: 2 }>> = {}): RegisteredWaveGateProgram => ({
    schemaVersion: 2,
    reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
    kind: "wave-gate",
    input: { wave: 1 },
    taskIds: ["T1", "T2"],
    authorityDigest: DIGEST,
    ...overrides,
  });
  const schemaOne = (overrides: Partial<Extract<RegisteredWaveGateProgram, { schemaVersion: 1 }>> = {}): RegisteredWaveGateProgram =>
    registration({ taskIds: ["T1", "T2"], ...overrides });
  const restart = { previousRunId: "run.previous", exhaustedSlots: ["T1/code-reviewer"] };
  const orphan = { previousRunId: "run.previous", previousAuthorityDigest: DIGEST };

  it("restart refuses a schema or reviewer-protocol difference, as orphan recovery always did", () => {
    const current = schemaTwo({ restart });
    expect(sameRestartRegistration(current, current)).toBe(true);
    expect(sameRestartRegistration(current, schemaOne({ restart }))).toBe(false);
    expect(CURRENT_REVIEWER_PROTOCOL.rubricDigest).not.toBe(CURRENT_REVIEWER_PROTOCOL.schemaDigest);
    expect(sameRestartRegistration(current, schemaTwo({
      restart,
      reviewerProtocol: { ...CURRENT_REVIEWER_PROTOCOL, schemaDigest: CURRENT_REVIEWER_PROTOCOL.rubricDigest },
    }))).toBe(false);
    const recovered = schemaTwo({ orphanRecovery: orphan });
    expect(sameOrphanRecoveryRegistration(recovered, schemaOne({ orphanRecovery: orphan }))).toBe(false);
  });

  it("both predicates compare the ordered Task roster", () => {
    expect(sameRestartRegistration(schemaTwo({ restart }), schemaTwo({ restart, taskIds: ["T2", "T1"] }))).toBe(false);
    expect(sameOrphanRecoveryRegistration(
      schemaTwo({ orphanRecovery: orphan }), schemaTwo({ orphanRecovery: orphan, taskIds: ["T1"] }),
    )).toBe(false);
  });

  it("restart still compares its exhausted-slot audit in order", () => {
    const two = { previousRunId: "run.previous", exhaustedSlots: ["T1/code-reviewer", "T2/code-reviewer"] };
    expect(sameRestartRegistration(schemaTwo({ restart: two }), schemaTwo({
      restart: { ...two, exhaustedSlots: ["T2/code-reviewer", "T1/code-reviewer"] },
    }))).toBe(false);
    expect(sameRestartRegistration(schemaTwo(), schemaTwo())).toBe(true);
  });
});
