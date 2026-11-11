/**
 * Returning a Task to revalidation: the one reset shared by every operator
 * transition that invalidates accepted completion without discarding it — a
 * reopened completed Wave, a Contract Revision of the bytes a claimant
 * implemented against, and a Task reopened in the active Wave to fix a Wave
 * Gate Finding.
 *
 * The two active-Wave reopenings (Contract Revision and Task Reopening) also
 * share ONE precondition, `reopenableWave`, whose proof is the only way into
 * `returnWaveTasksToRevalidation`: neither operation can reach the transition
 * over a live gate, so the transition has nothing left to refuse.
 */

import { distillTasksReopenedWith } from "./distill-task";
import type { DomainResult, NonEmpty, OrchestrationRunId } from "./orchestration-contract";
import type { Phase } from "./phases";
import { derivePendingTaskProof, redThenGreenEra } from "./proof-obligations";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { taskVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "./wave-gate-registration";
import type { Task, TaskGraph } from "../types";

/**
 * The Task back in protected `pending` revalidation: its accepted completion
 * and review authority are void and fresh Proof is required. Retained Findings
 * and test evidence remain active remediation/audit inputs wherever gate and
 * status projections read them; only a fresh implementation settlement clears
 * the revalidation marker. A legacy Task without Proof gets its pending Proof
 * derived from its policy, its declared artifacts and its TaskGraph's I6 era
 * (`redThenGreenEra` of the graph's frozen `verificationManifest`, INV-6).
 * `verificationManifest` is required so every caller states its graph's era;
 * `undefined` means the graph has no manifest, which is the legacy era.
 */
export function returnToRevalidation(task: Task, verificationManifest: FrozenVerificationManifest | undefined): Task {
  const proof = task.proof ?? derivePendingTaskProof({
    verificationPolicy: taskVerificationPolicy(task),
    declaredArtifacts: task.file_list ?? [],
    redThenGreen: redThenGreenEra(verificationManifest),
  });
  return {
    ...task,
    status: "pending",
    proof,
    revalidation_required: true,
    legacy_missing_proof: undefined,
    review_status: "pending",
    review_generation: (task.review_generation ?? 0) + 1,
    review_run: undefined,
    accepted_review_authority: undefined,
    review_error: undefined,
    review_evidence_failures: undefined,
  };
}

declare const REOPENABLE_WAVE: unique symbol;

/**
 * Proof that `graph`'s current Wave may have Tasks returned to revalidation:
 * the execute Phase, no Wave Gate owning the Wave's verification, and no
 * implementation reservation or active attempt. `abandonedRunId` names the
 * terminal-abandoned tombstone of the current Wave that the transition
 * retires, or is null when no gate is registered. Minted only by
 * `reopenableWave`.
 */
export type ReopenableWave = Readonly<{
  graph: TaskGraph;
  wave: number;
  abandonedRunId: OrchestrationRunId | null;
  readonly [REOPENABLE_WAVE]: true;
}>;

/** Why the current Wave cannot have Tasks returned to revalidation. Each
 *  operation renders its own message from these facts. */
export type WaveReopeningRefusal =
  | Readonly<{ kind: "not-executing"; phase: Phase }>
  /** A gate that is not a terminal-abandoned tombstone of the current Wave. */
  | Readonly<{ kind: "live-wave-gate"; runId: OrchestrationRunId; wave: number }>
  /** Executing Tasks, then current-Wave Tasks holding an active attempt, without repeats. */
  | Readonly<{ kind: "implementation-active"; holders: NonEmpty<string> }>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const refuse = (error: WaveReopeningRefusal): DomainResult<never, WaveReopeningRefusal> =>
  freeze({ ok: false as const, error: freeze(error) });

/**
 * The one Wave-reopening precondition shared by Contract Revision and Task
 * Reopening, checked in this order: the execute Phase with a current Wave; no
 * Wave Gate other than a terminal-abandoned tombstone of that Wave; no
 * executing Task and no Task of that Wave holding an active implementation
 * attempt.
 */
export function reopenableWave(graph: TaskGraph): DomainResult<ReopenableWave, WaveReopeningRefusal> {
  const wave = graph.current_wave;
  if (graph.current_phase !== "execute" || wave === undefined) {
    return refuse({ kind: "not-executing", phase: graph.current_phase });
  }
  const active = graph.active_wave_gate;
  if (active !== undefined && (active.wave !== wave || active.terminalOutcome?.kind !== "terminal-abandoned")) {
    return refuse({ kind: "live-wave-gate", runId: active.runId, wave: active.wave });
  }
  const attempting = graph.tasks
    .filter((task) => task.wave === wave && task.active_implementation_attempt !== undefined)
    .map(({ id }) => id);
  const [holder, ...holders] = [...new Set([...(graph.executing_tasks ?? []), ...attempting])];
  if (holder !== undefined) return refuse({ kind: "implementation-active", holders: freeze([holder, ...holders] as const) });
  const proof = freeze({ graph, wave, abandonedRunId: active?.runId ?? null }) as ReopenableWave;
  return freeze({ ok: true as const, value: proof });
}

/**
 * The Tasks one reopening returns to revalidation: the ones it names and the
 * settled Distill Tasks of their Waves the engine sweeps back with them
 * (ADR-0068 §7, `distillTasksReopenedWith`), so re-implemented code is
 * distilled again. Every reopening path asks here, so none can return a Task
 * and leave its Wave's distill pass standing.
 */
export type RevalidationTargets = Readonly<{
  /** Every Task returned, named and swept, in TaskGraph order. */
  taskIds: readonly string[];
  /** The Distill Tasks among them that the engine added; never a named Task. */
  sweptDistillTaskIds: readonly string[];
}>;

export function revalidationTargets(tasks: readonly Task[], namedTaskIds: readonly string[]): RevalidationTargets {
  const sweptDistillTaskIds = distillTasksReopenedWith(tasks, namedTaskIds);
  const returned = new Set([...namedTaskIds, ...sweptDistillTaskIds]);
  return freeze({
    taskIds: Object.freeze(tasks.filter(({ id }) => returned.has(id)).map(({ id }) => id)),
    sweptDistillTaskIds,
  });
}

/**
 * The Tasks among `returnedTaskIds` that the sweep would have returned had
 * they not been listed: each settled Distill Task with another returned Task
 * in its Wave. A reopening whose ids all arrive named (a completed Wave's
 * exact payload) asks here which of them returned only because a sibling did.
 * `tasks` is the roster before the transition.
 */
export const sweptAmongReturned = (tasks: readonly Task[], returnedTaskIds: readonly string[]): readonly string[] =>
  Object.freeze(returnedTaskIds.filter((id) =>
    distillTasksReopenedWith(tasks, returnedTaskIds.filter((other) => other !== id)).includes(id)));

/** One Wave revalidation: the graph after it, and exactly which Tasks it returned. */
export type WaveRevalidation = Readonly<{ graph: TaskGraph; returned: RevalidationTargets }>;

/**
 * Return `taskIds` of the proven Wave to revalidation, with the Wave's settled
 * Distill Task (`revalidationTargets`), and retire the review and suite
 * authority that judged them, as one transition: the shared core of a Contract
 * Revision and a Task reopening. The Wave's review authority (an abandoned
 * run's tombstone, epoch, spec-check and suite receipt) is retired first, so
 * review evidence the run accepted is kept as Findings before each returned
 * Task resets; then the gate bits that judged the Wave are cleared and its
 * block re-derived. The other Tasks of the Wave keep their status.
 */
export function returnWaveTasksToRevalidation(reopenable: ReopenableWave, taskIds: readonly string[]): WaveRevalidation {
  const { graph, wave, abandonedRunId } = reopenable;
  const retired = retireUnownedWaveReviewAuthority(graph, wave, abandonedRunId);
  const returned = revalidationTargets(retired.tasks, taskIds);
  const tasks = retired.tasks.map((task) =>
    returned.taskIds.includes(task.id) ? returnToRevalidation(task, retired.verification_manifest) : task);
  const existing = retired.wave_gates[String(wave)] ?? newWaveGate();
  const gate = {
    ...existing,
    impl_complete: returned.taskIds.length > 0 ? false : existing.impl_complete,
    tests_passed: null,
    reviews_complete: false,
  };
  return freeze({
    graph: {
      ...retired,
      tasks,
      wave_gates: reconcileWaveBlock({ ...retired.wave_gates, [String(wave)]: gate }, tasks, retired.spec_check, wave),
    },
    returned,
  });
}
