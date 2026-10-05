/**
 * Replacing an active Wave Gate run. Two pure protected-state transitions —
 * restart after every outstanding reviewer slot exhausted its final attempt,
 * and orphan recovery after the shell proved the authoritative Run Directory
 * absent — each produce the next TaskGraph plus the replacement run's exact
 * registration. The shell re-derives the transition under the state lock and
 * compares registrations with the matching `same…Registration` predicate.
 */
import type { TaskGraph } from "../types";
import { captureKey } from "./harness-capture";
import { canonicalStructuralEquals, parseArtifactDigest, parseOrchestrationRunId } from "./orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL } from "./reviewer-contract";
import { resetWaveGateReviewAuthority } from "./wave-gate-registration";
import { WAVE_REVIEW_AGENTS } from "./model-profiles";
import type { RegisteredWaveGateProgram } from "./wave-gate-program";
import { waveGateAuthorityDigest } from "./wave-review-authority";

type ReplacementRefusal = Readonly<{ ok: false; message: string }>;

function replacementWaveGate(
  resetGraph: TaskGraph,
  wave: number,
  taskIds: readonly string[],
  nextRunId: string,
  nextRunsRoot: string,
): ReplacementRefusal | Readonly<{
  ok: true;
  active: NonNullable<TaskGraph["active_wave_gate"]>;
}> {
  const authorityDigest = waveGateAuthorityDigest(wave, taskIds, resetGraph);
  const parsedNextRunId = parseOrchestrationRunId(nextRunId);
  const parsedAuthorityDigest = parseArtifactDigest(authorityDigest);
  if (!parsedNextRunId.ok) return { ok: false, message: parsedNextRunId.error.message };
  if (!parsedAuthorityDigest.ok) return { ok: false, message: parsedAuthorityDigest.error.message };
  return {
    ok: true,
    active: Object.freeze({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: parsedNextRunId.value,
      wave,
      authorityDigest: parsedAuthorityDigest.value,
      revision: 0,
      runsRoot: nextRunsRoot,
      terminalOutcome: null,
    }),
  };
}

export type WaveGateRestartPreparation = Readonly<{
  graph: TaskGraph;
  registration: RegisteredWaveGateProgram;
  exhaustedSlots: readonly string[];
}>;

export type WaveGateRestartResult =
  | Readonly<{ ok: true; value: WaveGateRestartPreparation }>
  | ReplacementRefusal;

/**
 * Pure protected-state transition for replacing one exhausted Wave review run.
 * Existing findings survive as prior findings; only packet-bound evidence is
 * invalidated. Review Generation stays stable because implementation bytes did
 * not change; fresh packet, epoch, and Run identities reject stale transcripts.
 * `exhaustedAttempts` holds the capture keys the shell proved terminally
 * rejected at attempt 2.
 */
export function prepareExhaustedWaveGateRestart(
  graph: TaskGraph,
  previousRunId: string,
  previous: RegisteredWaveGateProgram,
  nextRunId: string,
  nextRunsRoot: string,
  exhaustedAttempts: ReadonlySet<string>,
): WaveGateRestartResult {
  const wave = previous.input.wave;
  if (wave === null || graph.current_phase !== "execute" || graph.current_wave !== wave) {
    return { ok: false, message: "Wave Gate restart requires exact protected execute/current_wave authority" };
  }
  const active = graph.active_wave_gate;
  if (active === undefined || active.runId !== previousRunId || active.wave !== wave ||
      active.authorityDigest !== previous.authorityDigest || active.terminalOutcome !== null) {
    return { ok: false, message: "the previous run no longer owns exact active Wave Gate authority" };
  }
  const epoch = graph.wave_review_epoch;
  if (epoch === undefined || epoch.runId !== active.runId || epoch.wave !== wave) {
    return { ok: false, message: "the previous run has no exact active Wave review epoch" };
  }
  const waveTasks = graph.tasks.filter((task) => previous.taskIds.includes(task.id));
  if (waveTasks.length !== previous.taskIds.length) {
    return { ok: false, message: "the previous Wave Gate task authority no longer matches the protected graph" };
  }
  for (const task of waveTasks) {
    const run = task.review_run;
    if (run === undefined) continue;
    if (run.head_sha !== epoch.batchEpoch ||
        run.expected_agents.length !== WAVE_REVIEW_AGENTS.length ||
        run.expected_agents.some((agent, index) => agent !== WAVE_REVIEW_AGENTS[index]) ||
        run.slot_authority === undefined || run.slot_authority.length !== WAVE_REVIEW_AGENTS.length ||
        WAVE_REVIEW_AGENTS.some((agent, index) => run.slot_authority?.[index]?.agent !== agent)) {
      return { ok: false, message: `task ${task.id} Review Packet is not bound to the active epoch and exact reviewer roster` };
    }
  }
  const outstanding = waveTasks.flatMap((task) => {
    const run = task.review_run;
    if (run === undefined) return [];
    return run.slot_authority!.filter((slot) =>
      !run.evidence.some(({ agent }) => agent === slot.agent),
    ).map((slot) => ({ task, slot }));
  });
  if (outstanding.length === 0) {
    return { ok: false, message: "the active Wave Gate has no outstanding reviewer slots to restart" };
  }
  const nonExhausted = outstanding.filter(({ slot }) =>
    slot.attempted !== 2 || !exhaustedAttempts.has(captureKey(slot.slot_id, 2)));
  if (nonExhausted.length > 0) {
    return {
      ok: false,
      message: `Wave Gate restart refused before final-attempt rejection for: ${nonExhausted.map(({ task, slot }) => `${task.id}/${slot.agent}`).join(", ")}`,
    };
  }
  const resetGraph = resetWaveGateReviewAuthority(graph, previous.taskIds);
  const replacement = replacementWaveGate(resetGraph, wave, previous.taskIds, nextRunId, nextRunsRoot);
  if (!replacement.ok) return replacement;
  const exhaustedSlots = Object.freeze(outstanding.map(({ task, slot }) => `${task.id}/${slot.agent}`));
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 2,
    reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
    kind: "wave-gate",
    input: Object.freeze({ wave }),
    taskIds: previous.taskIds,
    authorityDigest: replacement.active.authorityDigest,
    restart: Object.freeze({ previousRunId, exhaustedSlots }),
  });
  const nextGraph: TaskGraph = {
    ...resetGraph,
    active_wave_gate: replacement.active,
  };
  return {
    ok: true,
    value: Object.freeze({
      graph: nextGraph,
      registration,
      exhaustedSlots,
    }),
  };
}

/** Restart registrations agree on wave, authority, Task roster, and the exact
 *  restart audit (predecessor and ordered exhausted slots). */
export function sameRestartRegistration(left: RegisteredWaveGateProgram, right: RegisteredWaveGateProgram): boolean {
  return left.input.wave === right.input.wave && left.authorityDigest === right.authorityDigest &&
    left.taskIds.length === right.taskIds.length && left.taskIds.every((taskId, index) => taskId === right.taskIds[index]) &&
    left.restart?.previousRunId === right.restart?.previousRunId &&
    (left.restart?.exhaustedSlots.length ?? 0) === (right.restart?.exhaustedSlots.length ?? 0) &&
    (left.restart?.exhaustedSlots.every((slot, index) => slot === right.restart?.exhaustedSlots[index]) ?? true);
}

export type OrphanedWaveGateRecoveryExpectation = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
}>;

export type OrphanedWaveGateRecoveryPreparation = Readonly<{
  graph: TaskGraph;
  registration: RegisteredWaveGateProgram;
}>;

export type OrphanedWaveGateRecoveryResult =
  | Readonly<{ ok: true; value: OrphanedWaveGateRecoveryPreparation }>
  | ReplacementRefusal;

/** Pure state transition for replacing an active Wave Gate whose authoritative
 * Run Directory has been proven absent by the shell. Packet-bound evidence is
 * retired, accepted findings are materialized, and every durable finding,
 * refutation, resolution, and review generation survives unchanged.
 * `authoritativeRunsRoot` is the shell-resolved (absolute, normalized) runs
 * root; the retired Run Directory is its direct child named by the run ID. */
export function prepareOrphanedWaveGateRecovery(
  graph: TaskGraph,
  expected: OrphanedWaveGateRecoveryExpectation,
  authoritativeRunsRoot: string,
  nextRunId: string,
  nextRunsRoot: string,
): OrphanedWaveGateRecoveryResult {
  const active = graph.active_wave_gate;
  if (graph.current_phase !== "execute" || graph.current_wave !== expected.wave ||
      active === undefined || active.terminalOutcome !== null || active.runId !== expected.runId ||
      active.wave !== expected.wave || active.authorityDigest !== expected.authorityDigest ||
      (active.runsRoot !== undefined && active.runsRoot !== authoritativeRunsRoot)) {
    return { ok: false, message: "orphan recovery requires the exact protected active run ID, wave, authority digest, and runs root" };
  }
  if (nextRunId === expected.runId) {
    return { ok: false, message: "orphan recovery requires a distinct replacement run identity" };
  }
  if ((graph.orphaned_wave_gate_history ?? []).some(({ runId }) => runId === active.runId)) {
    return { ok: false, message: `active Wave Gate run ${active.runId} already has a retirement audit record` };
  }
  const taskIds = Object.freeze(graph.tasks.filter(({ wave }) => wave === expected.wave).map(({ id }) => id));
  if (taskIds.length === 0) return { ok: false, message: `active Wave ${expected.wave} has no protected tasks` };

  const resetGraph = resetWaveGateReviewAuthority(graph, taskIds);
  const replacement = replacementWaveGate(resetGraph, expected.wave, taskIds, nextRunId, nextRunsRoot);
  if (!replacement.ok) return replacement;

  const retirement = Object.freeze({
    schemaVersion: 1 as const,
    kind: "orphaned-wave-gate-retirement" as const,
    runId: active.runId,
    wave: active.wave,
    authorityDigest: active.authorityDigest,
    revision: active.revision,
    reason: "authoritative-run-directory-missing" as const,
    runsRoot: authoritativeRunsRoot,
    runDirectory: `${authoritativeRunsRoot.replace(/\/+$/, "")}/${active.runId}`,
    replacementRunId: replacement.active.runId,
    replacementAuthorityDigest: replacement.active.authorityDigest,
  });
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 2,
    reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
    kind: "wave-gate",
    input: Object.freeze({ wave: expected.wave }),
    taskIds,
    authorityDigest: replacement.active.authorityDigest,
    orphanRecovery: Object.freeze({
      previousRunId: active.runId,
      previousAuthorityDigest: active.authorityDigest,
    }),
  });
  const nextGraph: TaskGraph = {
    ...resetGraph,
    orphaned_wave_gate_history: Object.freeze([...(graph.orphaned_wave_gate_history ?? []), retirement]),
    active_wave_gate: replacement.active,
  };
  return {
    ok: true,
    value: Object.freeze({ graph: nextGraph, registration }),
  };
}

/** Orphan-recovery registrations agree on protocol, wave, authority, Task
 *  roster, and the exact retired predecessor. */
export function sameOrphanRecoveryRegistration(
  left: RegisteredWaveGateProgram,
  right: RegisteredWaveGateProgram,
): boolean {
  return left.schemaVersion === right.schemaVersion && canonicalStructuralEquals(left.reviewerProtocol, right.reviewerProtocol) &&
    left.input.wave === right.input.wave && left.authorityDigest === right.authorityDigest &&
    left.taskIds.length === right.taskIds.length && left.taskIds.every((taskId, index) => taskId === right.taskIds[index]) &&
    left.orphanRecovery?.previousRunId === right.orphanRecovery?.previousRunId &&
    left.orphanRecovery?.previousAuthorityDigest === right.orphanRecovery?.previousAuthorityDigest;
}
