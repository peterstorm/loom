/**
 * Wave Gate authority membership: whether one request, captured attempt,
 * persisted retry, panel commit, or user decision still belongs to the exact
 * current Wave Gate run. Every check is a pure judgment over an already-loaded
 * protected TaskGraph; the program volume loads, judges here, then refuses or
 * writes. A `string` result is the exact refusal; `null` means "belongs".
 */
import type { Task, TaskGraph } from "../types";
import type { ContextPacket } from "./context-packets";
import { canonicalStructuralEquals, parseRequestId, parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract";
import type { RefutationPanelAuthority } from "./panel-authority";
import type { IssuedWaveReviewerProtocol } from "./review-output";
import { buildFindingBrief } from "./review-panel";
import { parseWaveRetryDiagnosticSection } from "./reviewer-retry";
import { settleSpecCheck } from "./spec-check";
import { deriveWaveAdvisoryDecisionRequest } from "./wave-gate-preparation";
import { WAVE_REVIEW_AGENTS } from "./model-profiles";
import type { RegisteredWaveGateProgram } from "./wave-gate-program";
import { taskReviewScope, waveSpecCheckDocumentsMatch, type WaveReviewContextAuthority } from "./wave-review-authority";

/**
 * Which dimension of a Wave Gate decision's authority failed to match, or `null`
 * when the decision is the exact pending one for this run.
 *
 * This is the guard that stops a decision meant for one Wave Gate run from being
 * applied to a stale or foreign one — a correctness rule, not I/O plumbing. Its
 * four dimensions (run, wave, authority digest, decision id) each have their
 * own refusal so every mismatch is independently reachable.
 *
 * Pure: the caller reads and parses the protected graph; this only judges it.
 */
export function waveGateDecisionMismatch(
  graph: TaskGraph,
  registration: RegisteredWaveGateProgram,
  runId: string,
  decisionId: string,
): string | null {
  const active = graph.active_wave_gate;
  if (active?.runId !== runId ||
      active.wave !== registration.input.wave ||
      active.authorityDigest !== registration.authorityDigest) {
    return "protected active Wave Gate authority differs from this decision run";
  }
  const pending = deriveWaveAdvisoryDecisionRequest(
    runId,
    graph.tasks.filter(({ id }) => registration.taskIds.includes(id)),
  );
  if (!pending.ok) {
    return `decision request ${decisionId} is not the exact pending advisory request: ${pending.error.message}`;
  }
  return decisionId === pending.value.requestId
    ? null
    : `decision request ${decisionId} is not the exact pending advisory request ${pending.value.requestId}`;
}

/** Whether a run's event journal records an exact `{ kind: "approve" }` user
 *  decision for this advisory decision request. */
export function advisoryDecisionApproved(
  events: readonly Readonly<{ event: unknown }>[],
  requestId: string,
): boolean {
  return events.some(({ event }) => {
    if (typeof event !== "object" || event === null) return false;
    const record = event as Record<string, unknown>;
    const decision = record.decision;
    return record.kind === "user-decision-recorded" &&
      record.decisionId === requestId &&
      typeof decision === "object" && decision !== null && !Array.isArray(decision) &&
      Object.keys(decision).length === 1 && (decision as Record<string, unknown>).kind === "approve";
  });
}

/** Exact spec-check packet membership does not depend on open reviewer runs. */
export function specCheckSlotBelongsToWaveEpoch(
  graph: Pick<TaskGraph, "wave_review_epoch" | "spec_file" | "plan_file">,
  request: Readonly<{ runId: string; slotId: string; attempt: 1 | 2 }>,
  context: Pick<WaveReviewContextAuthority, "wave" | "batchEpoch" | "specCheckDocuments">,
): boolean {
  const epoch = graph.wave_review_epoch;
  return context.specCheckDocuments !== null &&
    graph.spec_file === context.specCheckDocuments.spec.path &&
    graph.plan_file === context.specCheckDocuments.plan.path &&
    waveSpecCheckDocumentsMatch(epoch?.specCheckDocuments, context.specCheckDocuments) &&
    epoch?.runId === request.runId && epoch.wave === context.wave &&
    epoch.batchEpoch === context.batchEpoch &&
    epoch.specCheckSlotAuthority?.slot_id === request.slotId &&
    epoch.specCheckSlotAuthority.attempted === request.attempt;
}

/** Apply a capture rejection only while its exact spec-check capability is current. */
export function applyCurrentSpecCheckCaptureRejection(
  graph: TaskGraph,
  request: Readonly<{ runId: string; slotId: string; attempt: 1 | 2 }>,
  context: Pick<WaveReviewContextAuthority, "wave" | "batchEpoch" | "authorityDigest" | "specCheckDocuments">,
  error: string,
  runAt: string,
): Readonly<{ state: TaskGraph; applied: boolean }> {
  const active = graph.active_wave_gate;
  if (graph.current_phase !== "execute" || graph.current_wave !== context.wave ||
      active?.runId !== request.runId || active.wave !== context.wave ||
      active.authorityDigest !== context.authorityDigest ||
      !specCheckSlotBelongsToWaveEpoch(graph, request, context)) {
    return Object.freeze({ state: graph, applied: false });
  }
  const settlement = settleSpecCheck(graph, {
    kind: "capture-failure",
    wave: context.wave,
    runAt,
    error,
  });
  return Object.freeze({ state: settlement.state, applied: true });
}

export function waveRefutationCommitProblem(
  graph: TaskGraph,
  registration: RegisteredWaveGateProgram,
  expectedActive: Pick<NonNullable<TaskGraph["active_wave_gate"]>, "runId" | "wave" | "authorityDigest" | "revision">,
  panel: Pick<RefutationPanelAuthority, "runId" | "findings">,
): string | null {
  const wave = registration.input.wave;
  const active = graph.active_wave_gate;
  if (wave === null || graph.current_phase !== "execute" || graph.current_wave !== wave ||
      active === undefined || active.terminalOutcome !== null ||
      active.runId !== expectedActive.runId || active.runId !== panel.runId ||
      active.wave !== expectedActive.wave || active.wave !== wave ||
      active.authorityDigest !== expectedActive.authorityDigest ||
      active.authorityDigest !== registration.authorityDigest || active.revision !== expectedActive.revision) {
    return "Refutation Panel no longer owns the exact active Wave Gate authority";
  }
  const waveTaskIds = graph.tasks.filter((task) => task.wave === wave).map(({ id }) => id);
  if (!canonicalStructuralEquals(waveTaskIds, registration.taskIds)) {
    return "Refutation Panel task authority differs from the locked current Wave";
  }
  const collecting = graph.tasks.some((task) => task.wave === wave && task.review_run !== undefined);
  const unreviewed = graph.tasks.some((task) => task.wave === wave &&
    task.review_status !== "passed" && task.review_status !== "blocked");
  if (collecting || unreviewed) {
    return "Refutation Panel cannot commit while locked current-Wave review evidence is incomplete";
  }
  const lockedFindings = buildFindingBrief(wave, graph.tasks).findings;
  return canonicalStructuralEquals(lockedFindings, panel.findings)
    ? null
    : "Refutation Panel findings differ from the locked current-Wave Finding authority";
}

/** Protected membership is rechecked inside every Task write, independently of payload admission. */
export function waveReviewerSlotProblem(
  graph: TaskGraph,
  task: Task,
  context: WaveReviewContextAuthority,
  protocol: IssuedWaveReviewerProtocol,
  checkAttempt = true,
): string | null {
  const request = protocol.request;
  const run = task.review_run;
  const taskRun = context.taskRun;
  const epoch = graph.wave_review_epoch;
  const active = graph.active_wave_gate;
  const slot = run?.slot_authority?.find(({ agent }) => agent === request.role);
  if (graph.current_phase !== "execute" || graph.current_wave !== context.wave ||
      active?.runId !== request.runId || active.wave !== context.wave || active.terminalOutcome !== null ||
      active.authorityDigest !== context.authorityDigest || epoch?.runId !== request.runId ||
      epoch.wave !== context.wave || epoch.batchEpoch !== context.batchEpoch ||
      run === undefined || taskRun === null || taskRun.taskId !== task.id ||
      taskRun.generation !== run.generation || (task.review_generation ?? 0) !== run.generation ||
      taskRun.packetId !== run.packet_id || taskRun.headSha !== run.head_sha ||
      context.batchEpoch !== run.head_sha || slot?.slot_id !== request.slotId ||
      (checkAttempt && slot.attempted !== request.attempt)) {
    return "request does not belong to the exact current Wave Review Packet slot";
  }
  if (protocol.protocolVersion === 2) {
    if (!canonicalStructuralEquals(run.expected_agents, WAVE_REVIEW_AGENTS) ||
        !canonicalStructuralEquals(run.reviewer_protocol, protocol.reviewerProtocol) ||
        run.wave_gate_run_id !== request.runId || run.wave_gate_authority_digest !== context.authorityDigest ||
        run.workspace_head_sha !== taskRun.workspaceHeadSha ||
        !canonicalStructuralEquals(run.workspace_scope, protocol.subject.scope) ||
        !canonicalStructuralEquals(taskReviewScope(task), protocol.subject.scope) ||
        !canonicalStructuralEquals(run.prior_finding_ids, protocol.subject.priorFindingIds) ||
        (checkAttempt && (slot.request_id !== request.requestId || slot.context_digest !== request.contextDigest))) {
      return "current reviewer protocol differs from protected workspace/request/context authority";
    }
  } else if (run.reviewer_protocol !== undefined) {
    return "historical reviewer cannot settle a current Review Run";
  }
  return null;
}

const sameContextSections = (
  left: ContextPacket["fixedContext"],
  right: ContextPacket["fixedContext"],
): boolean => left.length === right.length && left.every((section, index) => {
  const candidate = right[index];
  return candidate !== undefined && section.label === candidate.label &&
    section.byteLength === candidate.byteLength && section.digest === candidate.digest;
});

/** Whether a persisted Wave attempt-2 request/context is the canonical
 *  derivation of its attempt 1: the same envelope with the attempt-2 identity,
 *  unchanged fixed authority, and either the legacy unchanged variable context
 *  or exactly one appended canonical rejection diagnostic. */
export function persistedWaveAttemptTwoCompatibilityProblem(
  attemptOne: AgentRequestAuthority,
  attemptTwo: AgentRequestAuthority,
  first: ContextPacket,
  second: ContextPacket,
): string | null {
  const requestId = parseRequestId(attemptOne.requestId.replace(/:1$/, ":2"));
  if (!requestId.ok || requestId.value === attemptOne.requestId) {
    return `Wave request ${attemptOne.requestId} cannot derive canonical attempt-2 identity`;
  }
  const expectedAuthority = parseStoredAgentRequestAuthority({
    ...attemptOne,
    requestId: requestId.value,
    attempt: 2,
    contextDigest: attemptTwo.contextDigest,
    outputSlot: {
      kind: "fixed-artifact-slot",
      path: attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"),
    },
  });
  if (!expectedAuthority.ok || !canonicalStructuralEquals(expectedAuthority.value, attemptTwo)) {
    return "persisted attempt-2 request envelope does not derive from attempt 1";
  }

  if (first.digest !== attemptOne.contextDigest || first.requestId !== attemptOne.requestId ||
      first.role !== attemptOne.role || first.requiredSkill !== (attemptOne.requiredSkill ?? "none")) {
    return "persisted attempt-1 context does not match its request authority";
  }
  if (second.schemaVersion !== first.schemaVersion ||
      (first.schemaVersion === 2 && (second.schemaVersion !== 2 ||
        !canonicalStructuralEquals(first.reviewerProtocol, second.reviewerProtocol))) ||
      second.digest !== attemptTwo.contextDigest || second.requestId !== attemptTwo.requestId || second.role !== first.role ||
      second.requiredSkill !== first.requiredSkill || second.outputContract !== first.outputContract ||
      !sameContextSections(second.fixedContext, first.fixedContext)) {
    return "persisted attempt-2 context changed fixed attempt-1 authority";
  }

  const unchangedLegacyContext = sameContextSections(second.variableContext, first.variableContext);
  const diagnostic = second.variableContext.length === first.variableContext.length + 1 &&
    sameContextSections(second.variableContext.slice(0, -1), first.variableContext) &&
    second.variableContext.at(-1)?.label === "wave-review-attempt-1-rejection"
    ? parseWaveRetryDiagnosticSection(second.variableContext.at(-1)!.bytes, first.schemaVersion)
    : ({ ok: false as const, message: "attempt-2 context carries no wave-review-attempt-1-rejection section" });
  if (first.schemaVersion === 2 || !unchangedLegacyContext) {
    if (!diagnostic.ok) {
      return `persisted attempt-2 context is neither a legacy retry nor one diagnostic-rich retry (${diagnostic.message})`;
    }
  }
  return null;
}
