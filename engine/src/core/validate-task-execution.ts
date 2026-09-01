/** Pure task-execution lifecycle classification and gate decisions. */

import type { Task, TaskGraph } from "../types";
import { extractTaskId } from "../utils/extract-task-id";
import { isImplementationAgent, isStandaloneReviewAgent } from "./model-profiles";
import { stripNamespace } from "../utils/strip-namespace";
import { hasStandaloneReviewContext, invalidateTaskReview } from "./review-output";
import { newWaveGate, reconcileWaveBlock, waveBlockCauses } from "./wave-gate-model";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import {
  canonicalArtifactBaselineDigest,
  createImplementationAttemptAuthority,
  type ArtifactBaselineDigest,
  createReclaimedImplementationAttemptReceipt,
  type ImplementationAttemptAuthority,
  type IsoInstant,
  type ReservationId,
} from "./implementation-completion";

export interface ValidateTaskExecutionInput {
  readonly agentType: string;
  readonly prompt: string;
  readonly description: string;
}

/** Transport-neutral spawn policy decision. Harness adapters decide how an
 * ineligible reason becomes a hook response. */
export type TaskExecutionDecision =
  | Readonly<{ kind: "eligible" }>
  | Readonly<{ kind: "ineligible"; reason: string }>;

/**
 * Parsed lifecycle for one spawn. Only the implementation arm carries text
 * from which a task id may be extracted; review/refutation/phase work cannot
 * accidentally enter implementation execution state.
 */
export type TaskExecutionSpawn =
  | Readonly<{ kind: "standalone" }>
  | Readonly<{ kind: "implementation"; prompt: string; description: string }>
  | Readonly<{ kind: "non-implementation" }>;

/** Pure boundary parser from harness fields to the closed lifecycle union. */
export function classifyTaskExecutionSpawn(input: ValidateTaskExecutionInput): TaskExecutionSpawn {
  const agent = stripNamespace(input.agentType);
  if (hasStandaloneReviewContext(input.prompt) && isStandaloneReviewAgent(agent)) {
    return { kind: "standalone" };
  }
  return isImplementationAgent(agent)
    ? { kind: "implementation", prompt: input.prompt, description: input.description }
    : { kind: "non-implementation" };
}

function dependencyExecutionBlock(state: TaskGraph, task: Task): TaskExecutionDecision | null {
  for (const dependencyId of task.depends_on) {
    const dependency = state.tasks.find((candidate) => candidate.id === dependencyId);
    if (dependency === undefined) {
      return {
        kind: "ineligible",
        reason: `Cannot execute ${task.id} - dependency ${dependencyId} not found in task graph`,
      };
    }
    if (dependency.status !== "completed") {
      return {
        kind: "ineligible",
        reason: `Cannot execute ${task.id} - dependency ${dependencyId} not complete (status: ${dependency.status})`,
      };
    }
  }
  return null;
}

/** Pure task gate used by both single and batch shell entry points. */
export function taskExecutionDecision(state: TaskGraph, taskId: string): TaskExecutionDecision {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { kind: "eligible" };
  if (task.status === "completed") {
    return {
      kind: "ineligible",
      reason: `Cannot execute ${taskId} because it is already completed.`,
    };
  }

  const currentWave = state.current_wave ?? 1;
  if (task.wave > currentWave) {
    return {
      kind: "ineligible",
      reason: `Cannot execute ${taskId} (wave ${task.wave}) - current wave is ${currentWave}\nComplete all wave ${currentWave} tasks first.`,
    };
  }

  const dependencyBlock = dependencyExecutionBlock(state, task);
  if (dependencyBlock !== null) return dependencyBlock;

  if (task.wave === currentWave && currentWave > 1) {
    const prevWave = String(currentWave - 1);
    const gate = state.wave_gates[prevWave];
    if (gate && !gate.reviews_complete) {
      const lines = [`Wave ${prevWave} review gate not passed.`, ""];
      if (gate.blocked) {
        lines.push(`Wave ${prevWave} is BLOCKED due to:`);
        // `tests_passed` is typed `true | null` and no writer ever produces
        // `false` (failing runs are judged by test_result evidence), so there
        // is no "Integration tests failed" branch here to mint. The gate's
        // blocked flag has exactly two causes, and they are read from the ONE
        // function that also decides the flag — `waveBlockCauses`. Enumerating
        // them here instead is what left a spec-check-only block printing this
        // header with nothing under it.
        const causes = waveBlockCauses(state.tasks, state.spec_check, currentWave - 1);
        if (causes.criticalReviewFindings > 0) {
          lines.push(`  - ${causes.criticalReviewFindings} critical review findings`);
        }
        if (causes.criticalSpecCheckFindings > 0) {
          lines.push(`  - ${causes.criticalSpecCheckFindings} critical spec-check findings`);
        }
      } else {
        lines.push(`Wave ${prevWave} gates not yet run.`);
      }
      lines.push("", "Run: /wave-gate");
      return { kind: "ineligible", reason: lines.join("\n") };
    }
  }

  return { kind: "eligible" };
}

export type ImplementationTaskBindings =
  | Readonly<{ ok: true; taskIds: readonly string[] }>
  | Readonly<{ ok: false; error: string }>;

export type ExecutionBatchMode = "parallel" | "sequential";

/**
 * When the shell observed roster liveness for reservation recovery.
 *
 * The ordinary handler probes at registration time. Pi must instead observe
 * immediately before it adds the prospective batch's own roster rows; those
 * rows are lifecycle bookkeeping, not evidence that an older reservation is
 * still served. The pre-roster arm is deliberately limited to timestamped
 * reservations minted by the current protocol, so this is not a migration path
 * for timestamp-less legacy graphs.
 */
export type TaskExecutionRosterObservation =
  | Readonly<{ kind: "at-registration"; anyActiveForGraph: boolean }>
  | Readonly<{ kind: "pre-roster-current-protocol"; anyActiveForGraph: boolean }>;

/**
 * How long a committed reservation is shielded from reclamation.
 *
 * A reservation is committed at PreToolUse; the agent's roster mark is written
 * later, at SubagentStart. Between those two points a LIVE reservation is
 * indistinguishable from one STRANDED by a vetoed spawn — both are `pending`
 * with no active agent for the graph — so reclamation must wait out that
 * window. The grace is a deliberately conservative fixed bound relative to
 * normal dispatch/queue latency; the transport exposes no enforceable upper
 * latency guarantee, so an exceptionally delayed unrostered spawn can outlive
 * it. A reservation stranded by a veto simply
 * ages past the window and is reclaimed on the first spawn attempt after it.
 * A long-RUNNING task is protected independently: its agent is roster-active,
 * so `anyActive` shields it regardless of age.
 */
export const RESERVATION_GRACE_MS = 10 * 60_000;

/**
 * Pure staleness predicate: which committed reservations are provably
 * abandoned, given the roster fact the shell already resolved (`anyActive`)
 * and the current clock. A reservation is abandoned only when ALL hold:
 * its task is not `completed`; no agent is active for this graph; and it has
 * aged past `graceMs`. A reservation whose `reserved_at` is missing or
 * unparseable predates the timestamp (or is corrupt) and stays eligible so
 * legacy stranded entries still recover — the fail-closed direction is to keep
 * recovering deadlocks, which the grace only ever DELAYS.
 *
 * Status is deliberately NOT narrowed to `pending`. A spawn vetoed by a
 * sibling PreToolUse gate strands its reservation whatever the task's status
 * was, and re-spawning against an `implemented` or `failed` task is exactly
 * what wave remediation does — so restricting recovery to `pending` left those
 * strandings with no in-band recovery path at all. Liveness is protected by
 * the two guards that do not depend on status: `anyActive` (fails closed, so
 * any live agent or unreadable roster reclaims nothing) and `graceMs` (shields
 * a reservation whose agent has not yet written its SubagentStart roster
 * mark). `completed` is excluded because such a task can never be re-executed.
 *
 * Keeping this pure (the fs `anyActive` read is hoisted to the shell) lets the
 * locked registration re-derive staleness against the graph held under the
 * lock: once one spawn commits a reservation with a fresh `reserved_at`, a
 * racing sibling's locked re-check sees it as young and refuses to reclaim it,
 * closing the double-registration window.
 */
export function staleReservationsFromState(
  state: TaskGraph,
  anyActive: boolean,
  nowMs: number,
  graceMs: number = RESERVATION_GRACE_MS,
): ReadonlySet<string> {
  const reserved = state.executing_tasks ?? [];
  if (reserved.length === 0 || anyActive) return new Set();
  return new Set(
    reserved.filter((taskId) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      // Parsed TaskGraph authority guarantees this lookup. A fabricated or
      // pre-parse orphan is not migration authority and therefore stays closed.
      if (task === undefined) return false;
      if (task.status === "completed") return false;
      const reservedAt = task.reserved_at === undefined ? Number.NaN : Date.parse(task.reserved_at);
      if (Number.isNaN(reservedAt)) return true; // legacy / corrupt timestamp → eligible
      return nowMs - reservedAt > graceMs;
    }),
  );
}

/**
 * Project stale reservations from the shell's typed roster observation.
 *
 * Registration-time probes retain the established recovery policy. Pi's
 * pre-roster observation admits only timestamped current-protocol reservations;
 * missing/unparseable timestamps remain untouched rather than
 * becoming eligible merely because Pi changed when it sampled its own roster.
 */
export function staleReservationsForRosterObservation(
  state: TaskGraph,
  observation: TaskExecutionRosterObservation,
  nowMs: number,
  graceMs: number = RESERVATION_GRACE_MS,
): ReadonlySet<string> {
  const stale = staleReservationsFromState(
    state,
    observation.anyActiveForGraph,
    nowMs,
    graceMs,
  );
  if (observation.kind === "at-registration") return stale;
  return new Set([...stale].filter((taskId) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    return task?.reserved_at !== undefined && !Number.isNaN(Date.parse(task.reserved_at));
  }));
}

function declaredPathOverlap(left: Task, right: Task): string | undefined {
  return (left.file_list ?? []).find((path) => right.file_list?.includes(path));
}

/**
 * Pure ownership invariant for one execution reservation. Active tasks own
 * their declared paths until stop cleanup. One reservation captures all task
 * baselines before dispatch, so even sequential siblings must be disjoint;
 * path handoff requires separate calls so each task gets a fresh baseline.
 *
 * `staleReservations` names reservations the shell has PROVEN abandoned. The
 * reservation is committed during PreToolUse, before the sibling PreToolUse
 * gates have voted, so a spawn any one of them then denies leaves an entry in
 * `executing_tasks` that no SubagentStop will ever clear — permanently
 * deadlocking the task and every task sharing a declared path with it.
 * Releasing those entries here keeps the invariant honest (a reservation only
 * owns paths while its agent can still be running) without weakening it: the
 * shell only ever proves staleness fail-closed, so an unproven reservation
 * still owns its paths.
 */
export function taskExecutionOwnershipError(
  state: TaskGraph,
  taskIds: readonly string[],
  mode: ExecutionBatchMode,
  staleReservations: ReadonlySet<string> = new Set(),
): string | null {
  const requested = new Set(taskIds);
  const active = new Set(
    (state.executing_tasks ?? []).filter((taskId) => !staleReservations.has(taskId)),
  );
  for (const taskId of taskIds) {
    if (active.has(taskId)) return `Task ${taskId} is already executing.`;
  }

  const requestedTasks = taskIds.flatMap((taskId) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    return task === undefined ? [] : [task];
  });
  const activeTasks = state.tasks.filter((task) => active.has(task.id) && !requested.has(task.id));
  for (const incoming of requestedTasks) {
    for (const owner of activeTasks) {
      if (incoming.wave !== owner.wave) continue;
      const overlap = declaredPathOverlap(incoming, owner);
      if (overlap !== undefined) {
        return `Task ${incoming.id} cannot execute while ${owner.id} owns declared path ${overlap}.`;
      }
    }
  }

  for (let leftIndex = 0; leftIndex < requestedTasks.length; leftIndex++) {
    const left = requestedTasks[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < requestedTasks.length; rightIndex++) {
      const right = requestedTasks[rightIndex]!;
      if (left.wave !== right.wave) continue;
      const overlap = declaredPathOverlap(left, right);
      if (overlap === undefined) continue;
      return mode === "parallel"
        ? `Parallel implementation tasks ${left.id} and ${right.id} both declare ${overlap}; use disjoint scopes.`
        : `Sequential implementation tasks ${left.id} and ${right.id} both declare ${overlap}; overlapping handoff requires separate subagent calls so each task receives a fresh baseline.`;
    }
  }
  return null;
}

/** Pure smart constructor for the task identities carried by one spawn batch. */
export function parseImplementationTaskBindings(
  state: TaskGraph,
  inputs: readonly Extract<TaskExecutionSpawn, { kind: "implementation" }>[],
): ImplementationTaskBindings {
  const taskIds: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const taskId = extractTaskId(input.prompt) ?? extractTaskId(input.description);
    if (taskId === null) {
      return { ok: false, error: `Implementation spawn ${index + 1} has no extractable Task ID while a task graph is active.` };
    }
    if (!state.tasks.some((task) => task.id === taskId)) {
      return { ok: false, error: `Implementation spawn ${index + 1} names unknown task ${taskId}.` };
    }
    if (taskIds.includes(taskId)) {
      return { ok: false, error: `Implementation batch binds task ${taskId} more than once.` };
    }
    taskIds.push(taskId);
  }
  return { ok: true, taskIds };
}

type TaskExecutionBaselineBundle = Readonly<{
  proof: readonly DeclaredArtifactBaseline[];
  attempt: readonly DeclaredArtifactBaseline[];
  repositoryAttempt: readonly DeclaredArtifactBaseline[];
  repositoryObservation: readonly DeclaredArtifactBaseline[];
}>;

export type TaskExecutionBaselines = ReadonlyMap<string, TaskExecutionBaselineBundle>;

export type TaskExecutionAuthorityPlan = Readonly<{
  authority: ImplementationAttemptAuthority;
  baselines: TaskExecutionBaselineBundle;
}>;

export type TaskExecutionAuthorityBatch =
  | Readonly<{ ok: true; plans: readonly TaskExecutionAuthorityPlan[] }>
  | Readonly<{ ok: false; error: string }>;

/** Mint one exact authority per bound Task while preserving binding order. */
export function createTaskExecutionAuthorityBatch(
  state: TaskGraph,
  taskIds: readonly string[],
  reservationIds: readonly ReservationId[],
  headSha: string,
  reservedAt: IsoInstant,
  baselines: TaskExecutionBaselines,
): TaskExecutionAuthorityBatch {
  if (taskIds.length !== reservationIds.length) {
    return { ok: false, error: "Implementation reservation identity count does not match bound Task count." };
  }
  const plans: TaskExecutionAuthorityPlan[] = [];
  for (const [index, taskId] of taskIds.entries()) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    const taskBaselines = baselines.get(taskId);
    const reservationId = reservationIds[index];
    if (task === undefined || taskBaselines === undefined || reservationId === undefined) {
      return { ok: false, error: `Cannot mint exact implementation authority for ${taskId}.` };
    }
    const authority = createImplementationAttemptAuthority({
      taskId,
      wave: task.wave,
      semanticAttempt: 1,
      reservationId,
      headSha,
      reservedAt,
      taskScopeBaseline: taskBaselines.attempt,
      dirtySetBaseline: taskBaselines.repositoryAttempt,
    });
    if (!authority.ok) {
      return { ok: false, error: authority.error.errors.join("; ") };
    }
    plans.push(Object.freeze({ authority: authority.value, baselines: taskBaselines }));
  }
  return { ok: true, plans: Object.freeze(plans) };
}

export type ProvenStaleReservation =
  | Readonly<{ kind: "modern"; taskId: string; authority: ImplementationAttemptAuthority }>
  | Readonly<{ kind: "legacy"; taskId: string }>;

/** Lift Task-id staleness into the exact reservation identities held now. */
export function proveStaleReservations(
  state: TaskGraph,
  staleTaskIds: ReadonlySet<string>,
): readonly ProvenStaleReservation[] {
  return Object.freeze([...staleTaskIds].flatMap((taskId): readonly ProvenStaleReservation[] => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return [];
    return [task.active_implementation_attempt === undefined
      ? Object.freeze({ kind: "legacy" as const, taskId })
      : Object.freeze({ kind: "modern" as const, taskId, authority: task.active_implementation_attempt })];
  }));
}

function exactStaleTaskIds(
  state: TaskGraph,
  stale: readonly ProvenStaleReservation[],
): ReadonlySet<string> {
  return new Set(stale.flatMap((proof) => {
    const task = state.tasks.find((candidate) => candidate.id === proof.taskId);
    if (proof.kind === "legacy") {
      return task !== undefined && task.active_implementation_attempt === undefined ? [proof.taskId] : [];
    }
    return task?.active_implementation_attempt?.authorityDigest === proof.authority.authorityDigest
      ? [proof.taskId]
      : [];
  }));
}

function baselineMatchesAuthority(
  baseline: readonly DeclaredArtifactBaseline[] | undefined,
  expectedDigest: ArtifactBaselineDigest,
): boolean {
  if (baseline === undefined) return false;
  const digest = canonicalArtifactBaselineDigest(baseline);
  return digest.ok && digest.value === expectedDigest;
}

function canPreserveReclaimedEvidence(
  task: Task,
  proof: Extract<ProvenStaleReservation, { kind: "modern" }>,
  replacement: TaskExecutionAuthorityPlan | undefined,
): boolean {
  return replacement !== undefined &&
    replacement.authority.headSha === proof.authority.headSha &&
    baselineMatchesAuthority(task.attempt_artifact_baseline, proof.authority.taskScopeBaselineDigest) &&
    baselineMatchesAuthority(replacement.baselines.attempt, proof.authority.taskScopeBaselineDigest) &&
    baselineMatchesAuthority(task.attempt_repository_baseline, proof.authority.dirtySetBaselineDigest) &&
    baselineMatchesAuthority(replacement.baselines.repositoryObservation, proof.authority.dirtySetBaselineDigest);
}

function invalidateReclaimedEvidence(task: Task): Task {
  const invalidated = {
    ...invalidateTaskReview(task),
    test_result: undefined,
    test_evidence: undefined,
    new_test_observation: undefined,
    failure_reason: "infrastructure-blocked: reservation-reclaimed",
  };
  return task.proof === undefined
    ? invalidated
    : {
        ...invalidated,
        status: "pending",
        proof: task.proof,
        revalidation_required: true,
        legacy_missing_proof: undefined,
      };
}

function reclaimTaskAttempt(
  task: Task,
  stale: readonly ProvenStaleReservation[],
  reclaimedAt: IsoInstant,
  invalidateEvidence = false,
): Task {
  const proof = stale.find((candidate) => candidate.taskId === task.id);
  if (proof === undefined) return task;
  if (proof.kind === "modern") {
    if (task.active_implementation_attempt?.authorityDigest !== proof.authority.authorityDigest) return task;
    const receipt = createReclaimedImplementationAttemptReceipt(proof.authority, reclaimedAt);
    if (!receipt.ok) return task;
    const history = task.implementation_attempt_history ?? [];
    const archived = history.some((candidate) => candidate.authorityDigest === proof.authority.authorityDigest)
      ? history
      : [...history, receipt.value];
    const reclaimed: Task = {
      ...task,
      active_implementation_attempt: undefined,
      attempt_artifact_baseline: undefined,
      attempt_repository_baseline: undefined,
      reserved_at: undefined,
      implementation_attempt_history: archived,
    };
    return invalidateEvidence ? invalidateReclaimedEvidence(reclaimed) : reclaimed;
  }
  if (proof.kind === "legacy" && task.active_implementation_attempt === undefined) {
    return { ...task, reserved_at: undefined, legacy_execution_reservation: undefined };
  }
  return task;
}

/** Install a prevalidated batch and retire only exact stale identities. */
export function applyTaskExecutionAuthorityBatch(
  state: TaskGraph,
  plans: readonly TaskExecutionAuthorityPlan[],
  stale: readonly ProvenStaleReservation[],
  reclaimedAt: IsoInstant,
): TaskGraph {
  const staleTaskIds = exactStaleTaskIds(state, stale);
  const planByTask = new Map<string, TaskExecutionAuthorityPlan>(
    plans.map((plan) => [plan.authority.taskId, plan]),
  );
  const invalidatedTaskIds = new Set(stale.flatMap((proof) => {
    if (proof.kind !== "modern" || !staleTaskIds.has(proof.taskId)) return [];
    const task = state.tasks.find((candidate) => candidate.id === proof.taskId);
    if (task === undefined || canPreserveReclaimedEvidence(task, proof, planByTask.get(proof.taskId))) return [];
    return [proof.taskId];
  }));
  const tasks = state.tasks.map((original): Task => {
    const task = reclaimTaskAttempt(original, stale, reclaimedAt, invalidatedTaskIds.has(original.id));
    const plan = planByTask.get(task.id);
    if (plan === undefined) return task;
    return {
      ...registerTaskExecutionBaseline(
        task,
        plan.authority.headSha,
        plan.baselines.proof,
        plan.baselines.attempt,
        plan.baselines.repositoryAttempt,
      ),
      active_implementation_attempt: plan.authority,
      reserved_at: plan.authority.reservedAt,
      legacy_execution_reservation: undefined,
    };
  });
  const invalidatedWaves = new Set(
    state.tasks.filter((task) => invalidatedTaskIds.has(task.id)).map((task) => task.wave),
  );
  const specCheck = state.spec_check !== undefined && invalidatedWaves.has(state.spec_check.wave)
    ? undefined
    : state.spec_check;
  const waveReviewEpoch = state.wave_review_epoch !== undefined &&
      invalidatedWaves.has(state.wave_review_epoch.wave)
    ? { ...state.wave_review_epoch, specCheckSlotAuthority: undefined }
    : state.wave_review_epoch;
  const waveGates = [...invalidatedWaves].reduce((gates, wave) => {
    const key = String(wave);
    const reopened = {
      ...(gates[key] ?? newWaveGate()),
      impl_complete: tasks.filter((task) => task.wave === wave)
        .every((task) => task.status === "implemented" || task.status === "completed"),
      tests_passed: null,
      reviews_complete: false,
    };
    return reconcileWaveBlock({ ...gates, [key]: reopened }, tasks, specCheck, wave);
  }, state.wave_gates);
  return {
    ...state,
    executing_tasks: [...new Set([
      ...(state.executing_tasks ?? []).filter((taskId) => !staleTaskIds.has(taskId)),
      ...plans.map(({ authority }): string => authority.taskId),
    ])],
    tasks,
    ...(specCheck === undefined && state.spec_check !== undefined ? { spec_check: undefined } : {}),
    ...(waveReviewEpoch === undefined ? {} : { wave_review_epoch: waveReviewEpoch }),
    wave_gates: waveGates,
  };
}

/** Roll back only authorities that are still current; late replacements stand. */
export function rollbackTaskExecutionAuthorityBatch(
  state: TaskGraph,
  authorities: readonly ImplementationAttemptAuthority[],
  rolledBackAt: IsoInstant,
): TaskGraph {
  const stale = authorities.map((authority) => Object.freeze({
    kind: "modern" as const,
    taskId: authority.taskId,
    authority,
  }));
  const exact = exactStaleTaskIds(state, stale);
  if (exact.size === 0) return state;
  return {
    ...state,
    executing_tasks: (state.executing_tasks ?? []).filter((taskId) => !exact.has(taskId)),
    tasks: state.tasks.map((task) => reclaimTaskAttempt(task, stale, rolledBackAt)),
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

/** Revalidate every preflight assumption against the graph held under the
 * state lock. Returning one error keeps batch registration all-or-nothing. */
export function taskExecutionRegistrationError(
  current: TaskGraph,
  inputs: readonly Extract<TaskExecutionSpawn, { kind: "implementation" }>[],
  expectedTaskIds: readonly string[],
  mode: ExecutionBatchMode,
  baselines: TaskExecutionBaselines,
  staleReservations: ReadonlySet<string> = new Set(),
  authorityPlans?: readonly TaskExecutionAuthorityPlan[],
): string | null {
  const rebound = parseImplementationTaskBindings(current, inputs);
  if (!rebound.ok) return rebound.error;
  if (!samePaths(rebound.taskIds, expectedTaskIds)) {
    return "Implementation task bindings changed before execution registration.";
  }
  // Same stale set as preflight: if the locked re-check re-applied a released
  // reservation the two would disagree and the spawn would block under lock
  // after passing preflight.
  const ownership = taskExecutionOwnershipError(current, expectedTaskIds, mode, staleReservations);
  if (ownership !== null) return ownership;
  for (const taskId of expectedTaskIds) {
    const decision = taskExecutionDecision(current, taskId);
    if (decision.kind === "ineligible") return decision.reason;
    const task = current.tasks.find((candidate) => candidate.id === taskId);
    const baseline = baselines.get(taskId);
    if (task === undefined || baseline === undefined) {
      return `Cannot prove locked execution baseline for ${taskId}.`;
    }
    const declared = task.file_list ?? [];
    const attemptScope = [...new Set([...declared, ...(task.files_modified ?? [])])];
    if (!samePaths(declared, baseline.proof.map(({ artifact }) => artifact)) ||
        !samePaths(attemptScope, baseline.attempt.map(({ artifact }) => artifact))) {
      return `Task ${taskId} artifact scope changed before execution registration.`;
    }
    if (task.repository_baseline !== undefined) {
      const retained = canonicalArtifactBaselineDigest(task.repository_baseline);
      const planned = canonicalArtifactBaselineDigest(baseline.repositoryAttempt);
      if (!retained.ok || !planned.ok || retained.value !== planned.value) {
        return `Task ${taskId} retained repository baseline changed before execution registration.`;
      }
    }
    if (authorityPlans !== undefined) {
      const plan = authorityPlans.find((candidate) => candidate.authority.taskId === taskId);
      if (plan === undefined || plan.authority.wave !== task.wave ||
          plan.baselines !== baseline) {
        return `Task ${taskId} implementation authority changed before execution registration.`;
      }
    }
  }
  if (authorityPlans !== undefined && authorityPlans.length !== expectedTaskIds.length) {
    return "Implementation authority batch no longer matches the bound Task roster.";
  }
  return null;
}

/** Preserve the first proof boundary across retries while refreshing the
 * current-attempt boundary. Proof must keep seeing all bytes produced by the
 * task; evidence invalidation must see only bytes produced after this spawn. */
export function registerTaskExecutionBaseline(
  task: Task,
  sha: string,
  proofBaseline: readonly DeclaredArtifactBaseline[],
  attemptBaseline: readonly DeclaredArtifactBaseline[] = proofBaseline,
  repositoryAttemptBaseline: readonly DeclaredArtifactBaseline[] = [],
): Task {
  return {
    ...task,
    start_sha: task.start_sha ?? sha,
    artifact_baseline: task.artifact_baseline ?? proofBaseline,
    attempt_artifact_baseline: attemptBaseline,
    attempt_repository_baseline: task.repository_baseline ?? repositoryAttemptBaseline,
    repository_baseline: task.repository_baseline ?? repositoryAttemptBaseline,
  };
}
