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

import { distillTasksReopenedWith, isDistillTask } from "./distill-task";
import { nonEmpty, type DomainResult, type NonEmpty, type OrchestrationRunId } from "./orchestration-contract";
import type { Phase } from "./phases";
import { derivePendingTaskProof, redThenGreenEra } from "./proof-obligations";
import { parseTaskId, type TaskId } from "./task-id";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { taskVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "./wave-gate-registration";
import type { ReopenedTaskIds, Task, TaskGraph } from "../types";

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

/** One Task a reopening returns to revalidation, and whether it returns only
 *  because the engine sweeps it back with a sibling (ADR-0068 §7). */
export type RevalidationTarget = Readonly<{ taskId: TaskId; swept: boolean }>;

declare const REVALIDATION_TARGETS: unique symbol;

/**
 * The Tasks one reopening returns to revalidation, each once: the ones that
 * return on the reopening's own ground and the settled Distill Tasks of their
 * Waves that return with them, so re-implemented code is distilled again
 * (ADR-0068 §7). Each Task carries its one ground, so a swept Task is never
 * also a ground Task, and a swept Task is listed only beside a ground Task of
 * its Wave: the targets are never all swept.
 *
 * Minted only here, by the two ways a reopening states its ids. Both sweep
 * with `distillTasksReopenedWith`, so every reopening path shares one sweep
 * rule and none can return a Task and leave its Wave's distill pass standing:
 *
 * - `revalidationTargets`: the ids are NAMED and the engine adds the sweep.
 *   The swept Tasks are the ones nobody named; a named Distill Task returns on
 *   the namer's ground.
 * - `exactRevalidationTargets`: the ids are the whole RETURNED SET and nothing
 *   is added. The swept Tasks are the Distill Tasks in the set that sit beside
 *   an authored Task of the set, although the set names them too.
 */
export type RevalidationTargets = readonly RevalidationTarget[] & { readonly [REVALIDATION_TARGETS]: true };

/** Every Task the targets return, in the targets' order. */
export const returnedTaskIds = (targets: RevalidationTargets): readonly TaskId[] =>
  Object.freeze(targets.map(({ taskId }) => taskId));

/** The Distill Tasks among the targets that the engine swept back. */
export const sweptDistillTaskIds = (targets: RevalidationTargets): readonly TaskId[] =>
  Object.freeze(targets.flatMap(({ taskId, swept }) => swept ? [taskId] : []));

/**
 * `taskIds` as targets, in the order given: each id that names a roster Task,
 * once, swept when `sweptTaskIds` lists it. A caller passes swept ids that
 * `distillTasksReopenedWith` derived from ground ids among `taskIds`, which is
 * what keeps the targets from being all swept.
 */
function targetsOf(taskIds: readonly string[], sweptTaskIds: readonly string[]): RevalidationTargets {
  const swept = new Set(sweptTaskIds);
  const targets = [...new Set(taskIds)].flatMap((id): readonly RevalidationTarget[] => {
    const taskId = parseTaskId(id);
    return taskId.ok ? [freeze({ taskId: taskId.value, swept: swept.has(id) })] : [];
  });
  return Object.freeze(targets) as RevalidationTargets;
}

/**
 * The targets of a reopening that NAMES its Tasks, in TaskGraph order: the
 * named Tasks and, swept, the settled Distill Tasks of their Waves that it did
 * not name. A named id that is no Task of `tasks` returns nothing.
 */
export function revalidationTargets(tasks: readonly Task[], namedTaskIds: readonly string[]): RevalidationTargets {
  const swept = distillTasksReopenedWith(tasks, namedTaskIds);
  const returned = new Set([...namedTaskIds, ...swept]);
  return targetsOf(tasks.filter(({ id }) => returned.has(id)).map(({ id }) => id), swept);
}

/**
 * The targets of a reopening whose ids are the whole returned set (a
 * completed Wave's exact payload), in the order given. Nothing is added: a
 * set that would leave a settled Distill Task standing beside a returned
 * sibling is refused with those Distill Tasks. Within the set, the swept
 * Tasks are the Distill Tasks the set's authored Tasks would sweep. An id
 * that is no Task of `tasks` returns nothing. `tasks` is the roster before
 * the transition.
 */
export function exactRevalidationTargets(
  tasks: readonly Task[],
  returnedSetTaskIds: readonly string[],
): DomainResult<RevalidationTargets, NonEmpty<string>> {
  const leftStanding = nonEmpty(distillTasksReopenedWith(tasks, returnedSetTaskIds));
  if (leftStanding !== null) return freeze({ ok: false as const, error: leftStanding });
  const returned = new Set(returnedSetTaskIds);
  const onRoster = tasks.filter(({ id }) => returned.has(id));
  const authored = onRoster.filter((task) => !isDistillTask(task)).map(({ id }) => id);
  const swept = distillTasksReopenedWith(tasks, authored).filter((id) => returned.has(id));
  const rosterIds = new Set(onRoster.map(({ id }) => id));
  return freeze({ ok: true as const, value: targetsOf(returnedSetTaskIds.filter((id) => rosterIds.has(id)), swept) });
}

/** Why two id lists are not the ids of one reopening audit. */
export type ReopenedTaskIdsRefusal =
  | Readonly<{ kind: "swept-not-reopened"; taskId: TaskId }>
  /** No reopened Task is left for the swept ones to have returned with. */
  | Readonly<{ kind: "swept-every-reopened" }>;

/** The one place a reopening audit's ids are assembled: the swept field is absent, never empty. */
const mintReopenedTaskIds = (reopened: NonEmpty<TaskId>, swept: NonEmpty<TaskId> | null): ReopenedTaskIds =>
  freeze({ reopenedTaskIds: reopened, ...(swept === null ? {} : { sweptDistillTaskIds: swept }) }) as ReopenedTaskIds;

/**
 * The ids of a reopening audit from lists a caller already holds (the State
 * File's): `swept` must lie within `reopened` and leave at least one reopened
 * Task it could have returned with. The first swept id outside `reopened` is
 * refused before a sweep of everything is.
 */
export function reopenedTaskIds(
  reopened: NonEmpty<TaskId>,
  swept: readonly TaskId[],
): DomainResult<ReopenedTaskIds, ReopenedTaskIdsRefusal> {
  const refuse = (error: ReopenedTaskIdsRefusal) => freeze({ ok: false as const, error: freeze(error) });
  const foreign = swept.find((id) => !reopened.includes(id));
  if (foreign !== undefined) return refuse({ kind: "swept-not-reopened", taskId: foreign });
  if (reopened.every((id) => swept.includes(id))) return refuse({ kind: "swept-every-reopened" });
  return freeze({ ok: true as const, value: mintReopenedTaskIds(reopened, nonEmpty(swept)) });
}

/**
 * The ids a reopening's audit records for the Tasks it returned, in the
 * targets' order, or null when it returned none. The targets already hold the
 * audit's rule (their swept Tasks are a strict subset), so nothing is checked
 * again.
 */
export function reopenedTaskIdsOf(targets: RevalidationTargets): ReopenedTaskIds | null {
  const reopened = nonEmpty(returnedTaskIds(targets));
  return reopened === null ? null : mintReopenedTaskIds(reopened, nonEmpty(sweptDistillTaskIds(targets)));
}

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
  const returnedIds = new Set<string>(returnedTaskIds(returned));
  const tasks = retired.tasks.map((task) =>
    returnedIds.has(task.id) ? returnToRevalidation(task, retired.verification_manifest) : task);
  const existing = retired.wave_gates[String(wave)] ?? newWaveGate();
  const gate = {
    ...existing,
    impl_complete: returned.length > 0 ? false : existing.impl_complete,
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
