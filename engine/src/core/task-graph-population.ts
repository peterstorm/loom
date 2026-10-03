import type { Task, TaskGraph } from "../types";
import { newWaveGate } from "./wave-gate-model";
import { derivePendingTaskProof } from "./proof-obligations";
import {
  serializeVerificationPolicy,
  taskVerificationPolicy,
} from "./verification-policy";
import type { FrozenVerificationManifest } from "./verification-manifest";
import {
  recordedAnchorHashes,
  specIndexObservationOf,
  specIndexPath,
  type SpecIndexAvailability,
} from "./requirement-coverage";

/** Agent-authored Task fields admitted by the decompose contract. */
export type AuthoredTask = Readonly<
  Pick<
    Task,
    | "id"
    | "description"
    | "agent"
    | "wave"
    | "depends_on"
    | "spec_anchors"
    | "spec_contributions"
    | "plan_context"
  > & {
    verification_policy: NonNullable<Task["verification_policy"]>;
    file_list: readonly string[];
  }
>;

export type NonEmptyAuthoredTasks = readonly [AuthoredTask, ...AuthoredTask[]];

declare const VALIDATED_AUTHORED_TASK_ROSTER: unique symbol;
export type ValidatedAuthoredTaskRoster = NonEmptyAuthoredTasks & Readonly<{
  [VALIDATED_AUTHORED_TASK_ROSTER]: true;
}>;

export type AuthoredTaskRosterParseResult =
  | Readonly<{ ok: true; value: ValidatedAuthoredTaskRoster }>
  | Readonly<{ ok: false; error: string }>;

function taskWaveRosterError(tasks: readonly AuthoredTask[]): string | null {
  const invalid = tasks.find(({ wave }) => !Number.isSafeInteger(wave) || wave < 1);
  if (invalid !== undefined) {
    return `Task ${invalid.id} Wave must be a positive safe integer, got ${JSON.stringify(invalid.wave)}`;
  }
  const waves = [...new Set(tasks.map(({ wave }) => wave))].sort((left, right) => left - right);
  const gap = waves.findIndex((wave, index) => wave !== index + 1);
  return gap < 0
    ? null
    : `Authored Task Waves must be contiguous from 1; expected Wave ${gap + 1}, got ${waves[gap]}`;
}

/** Parse the authored roster topology before it can become population authority. */
export function parseAuthoredTaskRoster(tasks: readonly AuthoredTask[]): AuthoredTaskRosterParseResult {
  const [first, ...rest] = tasks;
  if (first === undefined) return Object.freeze({ ok: false, error: "TaskGraph population requires at least one authored Task" });
  const error = taskWaveRosterError(tasks);
  if (error !== null) return Object.freeze({ ok: false, error });
  return Object.freeze({
    ok: true,
    value: Object.freeze([first, ...rest]) as ValidatedAuthoredTaskRoster,
  });
}

export type TaskGraphPopulationCommand = Readonly<{
  planTitle: string;
  validatedPlanFile: string;
  authoredSpecFile?: string;
  tasks: ValidatedAuthoredTaskRoster;
  verificationManifest: FrozenVerificationManifest;
  specIndex: SpecIndexAvailability;
  observedSpecFile: string | null;
  force: boolean;
  issue?: number;
  repo?: string;
}>;

export type TaskGraphPopulationError = Readonly<{
  kind: "no-tasks" | "invalid-task-waves" | "non-pending-tasks" | "spec-authority-changed" | "spec-observation-mismatch";
  message: string;
}>;

export type TaskGraphPopulationResult =
  | Readonly<{
      ok: true;
      value: Readonly<{ state: TaskGraph; waves: readonly number[] }>;
    }>
  | Readonly<{ ok: false; error: TaskGraphPopulationError }>;

/** One spec_file precedence for observation, race checks, and persistence. */
export function resolvedSpecFile(
  existing: string | null | undefined,
  authored: string | undefined,
): string | null {
  return existing ?? authored ?? null;
}

function reject(
  kind: TaskGraphPopulationError["kind"],
  message: string,
): TaskGraphPopulationResult {
  return Object.freeze({ ok: false, error: Object.freeze({ kind, message }) });
}

function sanitizeTask(task: AuthoredTask, specIndex: SpecIndexAvailability): Task {
  const verificationPolicy = taskVerificationPolicy(task);
  const completionAnchors = Object.freeze([...(task.spec_anchors ?? [])]);
  const anchorHashes = specIndex.kind === "indexed"
    ? recordedAnchorHashes(specIndex.index, completionAnchors)
    : Object.freeze({});
  return Object.freeze({
    id: task.id,
    description: task.description,
    agent: task.agent,
    wave: task.wave,
    status: "pending",
    depends_on: Object.freeze([...(task.depends_on ?? [])]),
    spec_anchors: completionAnchors,
    spec_contributions: Object.freeze([...(task.spec_contributions ?? [])]),
    ...(Object.keys(anchorHashes).length === 0 ? {} : { spec_anchor_hashes: anchorHashes }),
    verification_policy: serializeVerificationPolicy(verificationPolicy),
    ...(task.plan_context === undefined ? {} : { plan_context: task.plan_context }),
    file_list: Object.freeze([...task.file_list]),
    proof: derivePendingTaskProof({
      verificationPolicy,
      declaredArtifacts: task.file_list,
    }),
    review_status: "pending",
    review_generation: 0,
    findings: Object.freeze([]),
    critical_findings: Object.freeze([]),
    advisory_findings: Object.freeze([]),
    refuted_findings: Object.freeze([]),
    resolved_findings: Object.freeze([]),
  });
}

function taskWaves(tasks: readonly AuthoredTask[]): readonly number[] {
  return Object.freeze([...new Set(tasks.map(({ wave }) => wave))].sort((left, right) => left - right));
}

/**
 * Pure TaskGraph aggregate command. The shell supplies parser-proven authored
 * data and immutable observations; this function owns every state transition
 * performed while the StateManager lock is held.
 */
export function populateTaskGraph(
  existing: TaskGraph,
  command: TaskGraphPopulationCommand,
): TaskGraphPopulationResult {
  // Defensive even though callers need a non-empty tuple: JavaScript and
  // persisted/untyped boundaries can still invoke this exported function.
  if (command.tasks.length === 0) {
    return reject("no-tasks", "TaskGraph population requires at least one authored Task");
  }
  const waveError = taskWaveRosterError(command.tasks);
  if (waveError !== null) return reject("invalid-task-waves", waveError);
  if (!command.force && existing.tasks.some(({ status }) => status !== "pending")) {
    return reject(
      "non-pending-tasks",
      "Cannot overwrite task graph with non-pending tasks. Use --force to override.",
    );
  }
  if (specIndexPath(command.specIndex) !== command.observedSpecFile) {
    return reject(
      "spec-observation-mismatch",
      "prepared Spec Index does not name the observed spec_file authority",
    );
  }
  const lockedSpecFile = resolvedSpecFile(existing.spec_file, command.authoredSpecFile);
  if (lockedSpecFile !== command.observedSpecFile) {
    return reject(
      "spec-authority-changed",
      `spec_file changed from ${command.observedSpecFile ?? "none"} to ${lockedSpecFile ?? "none"} while this ` +
        "population was being prepared; re-run populate-task-graph.",
    );
  }

  const waves = taskWaves(command.tasks);
  const waveGates = Object.freeze(Object.fromEntries(
    waves.map((wave) => [String(wave), newWaveGate()] as const),
  ));
  const {
    active_wave_completion_suite: _staleCompletionSuite,
    active_wave_gate: _staleActiveWaveGate,
    wave_review_epoch: _staleWaveReviewEpoch,
    spec_check: _staleSpecCheck,
    wave_gate_history: _staleWaveGateHistory,
    wave_reopening_history: _staleWaveReopeningHistory,
    orphaned_wave_gate_history: _staleOrphanedWaveGateHistory,
    spec_trace_wave_gate_retirements: _staleSpecTraceRetirements,
    spec_index_observation: _staleSpecIndexObservation,
    ...existingWithoutWaveAuthority
  } = existing;
  const state: TaskGraph = Object.freeze({
    ...existingWithoutWaveAuthority,
    spec_trace_version: 2,
    plan_title: command.planTitle,
    plan_file: command.validatedPlanFile,
    spec_file: lockedSpecFile,
    spec_index_observation: specIndexObservationOf(command.specIndex),
    tasks: Object.freeze(command.tasks.map((task) => sanitizeTask(task, command.specIndex))),
    current_wave: 1,
    executing_tasks: Object.freeze([]),
    wave_gates: waveGates,
    verification_manifest: command.verificationManifest,
    ...(command.issue === undefined ? {} : { github_issue: command.issue }),
    ...(command.repo === undefined ? {} : { github_repo: command.repo }),
  });
  return Object.freeze({ ok: true, value: Object.freeze({ state, waves }) });
}
