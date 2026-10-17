import type { Phase, PlanContract, Task, TaskGraph } from "../types";
import { acceptanceContractsFromPlan, redWindowTaskIds } from "./acceptance-contract";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import type { ProofBoundaryObservation } from "./proof-boundary-observation";
import { newWaveGate } from "./wave-gate-model";
import { derivePendingTaskProof, redThenGreenEra, type RedThenGreenEra } from "./proof-obligations";
import {
  ACCEPTANCE_RED_WINDOW,
  serializeVerificationPolicy,
  taskVerificationPolicy,
  type VerificationPolicy,
} from "./verification-policy";
import type { FrozenVerificationManifest } from "./verification-manifest";
import {
  recordedAnchorHashes,
  renderRequirementTraceEdges,
  specIndexObservationOf,
  specIndexPath,
  specIndexUnavailableMessage,
  unprovenRequirementTrace,
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

/** The roster's ordered distinct Wave set: the one definition read by both the
 *  contiguity check and the Wave Gate construction. */
function taskWaves(tasks: readonly AuthoredTask[]): readonly number[] {
  return Object.freeze([...new Set(tasks.map(({ wave }) => wave))].sort((left, right) => left - right));
}

function taskWaveRosterError(tasks: readonly AuthoredTask[]): string | null {
  const invalid = tasks.find(({ wave }) => !Number.isSafeInteger(wave) || wave < 1);
  if (invalid !== undefined) {
    return `Task ${invalid.id} Wave must be a positive safe integer, got ${JSON.stringify(invalid.wave)}`;
  }
  const waves = taskWaves(tasks);
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

/** The population-time proof boundary: per-Task declared-artifact baselines
 *  captured from GIT, keyed by Task id, at ONE revision — or an honest absence
 *  with its cause, in which case each Task's first dispatch stamps its own. */
export type PopulationProofBoundary =
  | Readonly<{
      kind: "captured";
      baselines: ReadonlyMap<string, readonly DeclaredArtifactBaseline[]>;
      revision: string;
    }>
  | Readonly<{ kind: "absent"; cause: string }>;

/** The compact persisted observation of a boundary: its revision or its cause, never the baselines. */
export function proofBoundaryObservationOf(boundary: PopulationProofBoundary): ProofBoundaryObservation {
  return boundary.kind === "captured"
    ? Object.freeze({ kind: "captured", revision: boundary.revision })
    : Object.freeze({ kind: "absent", cause: boundary.cause });
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
  /** The proof boundary captured from GIT at the population revision. Captured
   *  BEFORE any work exists, so the boundary always predates the Task's
   *  production and the stale-flow wedge is unrepresentable. The `absent` arm
   *  records why Git could not capture it; the graph persists either arm as
   *  its `proof_boundary_observation`. */
  proofBoundary: PopulationProofBoundary;
  /** The validated plan's `## Contracts`; empty when the plan declares none. */
  contracts: readonly PlanContract[];
}>;

export type TaskGraphPopulationError = Readonly<{
  kind:
    | "no-tasks"
    | "invalid-task-waves"
    | "phase-not-populatable"
    | "non-pending-tasks"
    | "spec-authority-changed"
    | "spec-observation-mismatch"
    | "spec-index-unavailable"
    | "unknown-requirement"
    | "invalid-contracts";
  message: string;
}>;

/** First population leaves decompose; re-population happens during execute. */
const POPULATABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>(["decompose", "execute"]);

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

/**
 * Population proves the authored trace against the Spec Index, as amendment
 * does: an id the brief later refuses must not reach the TaskGraph. A declared
 * spec that cannot be indexed is refused even when nothing claims from it, so
 * a non-canonical spec is fixed before work starts rather than discovered when
 * a Wave Gate projects it. Only a plan with no spec_file at all and no
 * Requirement trace populates without one.
 */
function specIndexRefusal(
  specIndex: SpecIndexAvailability,
  tasks: readonly AuthoredTask[],
): TaskGraphPopulationResult | null {
  if (specIndex.kind === "unavailable" && specIndex.reason.kind !== "no-spec-file") {
    return reject(
      "spec-index-unavailable",
      `TaskGraph population refused: ${specIndexUnavailableMessage(specIndex.reason)}. ` +
        "Fix the specification, then re-run populate-task-graph.",
    );
  }
  const edges = tasks.flatMap((task) =>
    [...(task.spec_anchors ?? []), ...(task.spec_contributions ?? [])].map((id) => Object.freeze({ taskId: task.id, id })));
  const unproven = unprovenRequirementTrace(specIndex, edges);
  if (unproven === null) return null;
  // Every other unavailable reason was refused above, so this arm only ever
  // carries `no-spec-file`: a trace with no spec to prove it against.
  return unproven.kind === "spec-index-unavailable"
    ? reject(
        "spec-index-unavailable",
        "TaskGraph population refused: Tasks name Requirement ids but no Spec Index can prove they exist: " +
          specIndexUnavailableMessage(unproven.reason),
      )
    : reject(
        "unknown-requirement",
        "TaskGraph population refused: Tasks name ids the Spec Index does not define as a completable FR or AS entry: " +
          `${renderRequirementTraceEdges(unproven.edges)}. Remove them from spec_anchors/spec_contributions, ` +
          "or add them to the specification.",
      );
}

/**
 * Inside a contract's red window a full-suite run sees the contract's pending
 * acceptance testcases fail, so a required task-level regression obligation
 * could never be met; the Wave Gate's acceptance-aware suite is the authority
 * instead. An authored waiver keeps its own reason.
 */
function windowPolicy(policy: VerificationPolicy, inRedWindow: boolean): VerificationPolicy {
  return inRedWindow && policy.regression.kind === "required"
    ? Object.freeze({ ...policy, regression: Object.freeze({ kind: "waived" as const, reason: ACCEPTANCE_RED_WINDOW }) })
    : policy;
}

function sanitizeTask(
  task: AuthoredTask,
  specIndex: SpecIndexAvailability,
  proofBoundary: PopulationProofBoundary,
  inRedWindow: boolean,
  redThenGreen: RedThenGreenEra,
): Task {
  const verificationPolicy = windowPolicy(taskVerificationPolicy(task), inRedWindow);
  const proofBaseline = proofBoundary.kind === "captured" ? proofBoundary.baselines.get(task.id) : undefined;
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
    ...(proofBaseline === undefined ? {} : { artifact_baseline: proofBaseline }),
    ...(proofBoundary.kind === "captured" ? { start_sha: proofBoundary.revision } : {}),
    proof: derivePendingTaskProof({
      verificationPolicy,
      declaredArtifacts: task.file_list,
      redThenGreen,
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

/**
 * Pure TaskGraph aggregate command. The shell supplies parser-proven authored
 * data and immutable observations; this function owns every state transition
 * performed while the StateManager lock is held.
 *
 * It is also the only way out of decompose: the Tasks and the move to execute
 * land in one write, so an execute graph with no Tasks cannot be written
 * (issue #50). The decompose agent's SubagentStop leaves the phase alone.
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
  if (!POPULATABLE_PHASES.has(existing.current_phase)) {
    return reject(
      "phase-not-populatable",
      "populate-task-graph requires current_phase decompose (first population) or execute " +
        `(re-population), got ${existing.current_phase}; finish the earlier phases first`,
    );
  }
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
  const specRefusal = specIndexRefusal(command.specIndex, command.tasks);
  if (specRefusal !== null) return specRefusal;

  const contracts = acceptanceContractsFromPlan(command.contracts, command.tasks);
  if (!contracts.ok) return reject("invalid-contracts", contracts.error.join("; "));
  const redWindow = redWindowTaskIds(contracts.value, command.tasks);
  const redThenGreen = redThenGreenEra(command.verificationManifest);

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
    spec_trace_amendments: _staleSpecTraceAmendments,
    spec_index_observation: _staleSpecIndexObservation,
    proof_boundary_observation: _staleProofBoundaryObservation,
    acceptance_contracts: _staleAcceptanceContracts,
    ...existingWithoutWaveAuthority
  } = existing;
  const state: TaskGraph = Object.freeze({
    ...existingWithoutWaveAuthority,
    current_phase: "execute",
    phase_artifacts: { ...existing.phase_artifacts, decompose: "task_graph" },
    spec_trace_version: 2,
    plan_title: command.planTitle,
    plan_file: command.validatedPlanFile,
    spec_file: lockedSpecFile,
    spec_index_observation: specIndexObservationOf(command.specIndex),
    proof_boundary_observation: proofBoundaryObservationOf(command.proofBoundary),
    tasks: Object.freeze(command.tasks.map((task) => sanitizeTask(
      task,
      command.specIndex,
      command.proofBoundary,
      redWindow.has(task.id),
      redThenGreen,
    ))),
    ...(contracts.value.length === 0 ? {} : { acceptance_contracts: contracts.value }),
    current_wave: 1,
    executing_tasks: Object.freeze([]),
    wave_gates: waveGates,
    verification_manifest: command.verificationManifest,
    ...(command.issue === undefined ? {} : { github_issue: command.issue }),
    ...(command.repo === undefined ? {} : { github_repo: command.repo }),
  });
  return Object.freeze({ ok: true, value: Object.freeze({ state, waves }) });
}
