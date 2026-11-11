import type { OwnerObligation, Phase, PlanContract, PlanInvariant, Task, TaskGraph } from "../types";
import { acceptanceContractsFromPlan, frozenPaths, redWindowTaskIds, type AcceptanceContract } from "./acceptance-contract";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import { authoredDistillTaskRefusal, isDistillTask, planDistillTasks, type DistillTaskPlan } from "./distill-task";
import { DISTILL_AGENT } from "./model-profiles";
import { contractTaskIdsOf, obligationsFromInvariants, renderObligationsError, verifyOwed } from "./owner-verification/obligations";
import type { ProofBoundaryObservation } from "./proof-boundary-observation";
import { newWaveGate } from "./wave-gate-model";
import type { DomainResult } from "./orchestration-contract";
import { bindingTaskView, NO_EXPORT_BINDINGS, renderBindingProblem, validateExportBindings } from "./skeleton/bindings";
import type { ExportBinding, ExportBindingsDeclaration, SkeletonRecord } from "./skeleton/types";
import {
  derivePendingTaskProof,
  frozenRedThenGreenEra,
  redThenGreenScope,
  taskRedThenGreenEra,
  type RedThenGreenEra,
} from "./proof-obligations";
import { taskArtifactExpectation } from "./task-artifact-expectation";
import {
  ACCEPTANCE_RED_WINDOW,
  DISTILL_VERIFICATION_POLICY,
  serializeVerificationPolicy,
  taskVerificationPolicy,
  type VerificationPolicy,
} from "./verification-policy";
import { distillPassSetting, type FrozenVerificationManifest } from "./verification-manifest";
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

/**
 * The refusal of an authored Task naming the distill agent (ADR-0068): the
 * distill pass is engine-added, so a roster that authors one would carry two,
 * or one over a scope the engine never derived.
 */
function authoredDistillTaskError(tasks: readonly AuthoredTask[]): string | null {
  const authored = tasks.find(isDistillTask);
  return authored === undefined ? null : authoredDistillTaskRefusal(authored.id);
}

/** Parse the authored roster topology before it can become population authority. */
export function parseAuthoredTaskRoster(tasks: readonly AuthoredTask[]): AuthoredTaskRosterParseResult {
  const [first, ...rest] = tasks;
  if (first === undefined) return Object.freeze({ ok: false, error: "TaskGraph population requires at least one authored Task" });
  const error = taskWaveRosterError(tasks) ?? authoredDistillTaskError(tasks);
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
  /** The validated plan's `## Invariants`; empty when the plan declares none.
   *  Population stamps their Owner Obligations, `[]` included (AD-2). */
  invariants: readonly PlanInvariant[];
  /** The plan's `**Export bindings:**` as `parsePlanExportBindings` read them
   *  (AD-3). Population re-runs `validateExportBindings` against `contracts`
   *  and the roster and stamps the bindings only when it refuses nothing.
   *  Absent means the plan binds nothing, the same as an empty declaration. */
  exportBindings?: ExportBindingsDeclaration;
}>;

export type TaskGraphPopulationError = Readonly<{
  kind:
    | "no-tasks"
    | "invalid-task-waves"
    | "authored-distill-task"
    | "phase-not-populatable"
    | "non-pending-tasks"
    | "spec-authority-changed"
    | "spec-observation-mismatch"
    | "spec-index-unavailable"
    | "unknown-requirement"
    | "invalid-contracts"
    | "invalid-owner-obligations"
    | "owner-verification-runner-missing"
    | "invalid-export-bindings";
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

/** A refusal: a failed population result, and a failed `DomainResult` of any step. */
type PopulationRefusal = Readonly<{ ok: false; error: TaskGraphPopulationError }>;

function reject(
  kind: TaskGraphPopulationError["kind"],
  message: string,
): PopulationRefusal {
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
 * Mutation verification runs each mutant through the frozen `affectedRunner`
 * (AD-8), so a plan owing it to some owned Invariant cannot be honoured by a
 * manifest without one: refuse it now rather than block every Wave Gate that
 * changes the family. An exempt Invariant owes coverage only, which needs no
 * runner.
 */
function ownerRunnerRefusal(
  obligations: readonly OwnerObligation[],
  manifest: FrozenVerificationManifest,
): TaskGraphPopulationResult | null {
  if (manifest.affectedRunner !== undefined) return null;
  const verified = verifyOwed(obligations).map(({ invariant }) => invariant);
  return verified.length === 0
    ? null
    : reject(
        "owner-verification-runner-missing",
        `TaskGraph population refused: owned Invariant(s) ${verified.join(", ")} owe mutation verification, ` +
          "which runs through the frozen manifest's affectedRunner, and the verification manifest declares none. " +
          "Install .loom/verification-manifest.json with an \"affectedRunner\" (schemaVersion 2), or give each such " +
          "Invariant a reasoned **Mutation exemption:**, then re-run populate-task-graph.",
      );
}

/**
 * The `export_bindings` stamp (AD-4): the declaration's bindings in plan
 * order, once `validateExportBindings` refuses nothing against the plan's
 * contracts and this roster. Plan validation already refused every problem;
 * re-validating here keeps the aggregate command total over its own input,
 * so no graph is ever stamped with a binding plan validation would refuse.
 */
function exportBindingsStamp(
  declaration: ExportBindingsDeclaration,
  contracts: readonly PlanContract[],
  tasks: readonly AuthoredTask[],
): DomainResult<readonly ExportBinding[], TaskGraphPopulationError> {
  // The roster as plan validation reads it: the authored regression waiver,
  // never the red-window one population adds.
  const views = tasks.map((task) =>
    bindingTaskView({ id: task.id, file_list: task.file_list, depends_on: task.depends_on ?? [] }, taskVerificationPolicy(task)));
  const problems = validateExportBindings(declaration, contracts, views);
  if (problems.length > 0) {
    return reject(
      "invalid-export-bindings",
      `TaskGraph population refused: ${problems.map(renderBindingProblem).join("; ")}; ` +
        "fix the plan's **Export bindings:**, then re-run populate-task-graph.",
    );
  }
  return { ok: true, value: Object.freeze(declaration.bindings.map((binding) => Object.freeze({ ...binding }))) };
}

/**
 * The engine-written skeleton records re-population keeps (FR-031): those
 * whose path the new stamp still binds to the same contract, in their sorted
 * order. The bytes on disk outlive population, so dropping such a record
 * would misreport an untouched skeleton as "exists, not skeletonized"; a
 * record whose binding is gone describes no skeleton any more.
 */
function carriedSkeletons(
  records: readonly SkeletonRecord[],
  stamp: readonly ExportBinding[],
): readonly SkeletonRecord[] {
  return Object.freeze(records.filter((record) =>
    stamp.some((binding) => binding.path === record.path && binding.contract === record.contract)));
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

/** The revision every populated Task starts from, when Git captured the proof boundary. */
const populationRevision = (boundary: PopulationProofBoundary): string | undefined =>
  boundary.kind === "captured" ? boundary.revision : undefined;

/** What population decided of one Task: everything its pending record is written from. */
type PopulatedTaskFields = Readonly<{
  id: string;
  description: string;
  agent: string;
  wave: number;
  dependsOn: readonly string[];
  specAnchors: readonly string[];
  specContributions: readonly string[];
  anchorHashes: Readonly<Record<string, string>>;
  verificationPolicy: VerificationPolicy;
  planContext: string | undefined;
  fileList: readonly string[];
  /** The declared-artifact baseline captured at population; undefined leaves the first registration to stamp it. */
  proofBaseline: readonly DeclaredArtifactBaseline[] | undefined;
  /** The population revision, when Git captured the proof boundary. */
  startSha: string | undefined;
  redThenGreen: RedThenGreenEra;
}>;

/**
 * The one pending Task record population writes, for an authored Task and a
 * Distill Task alike: no execution state, a pending Proof derived under the
 * Task's own expectation (`taskArtifactExpectation`), and an unreviewed
 * review record.
 */
function populatedTask(fields: PopulatedTaskFields): Task {
  const { agent, verificationPolicy, proofBaseline, startSha } = fields;
  return Object.freeze({
    id: fields.id,
    description: fields.description,
    agent,
    wave: fields.wave,
    status: "pending",
    depends_on: Object.freeze([...fields.dependsOn]),
    spec_anchors: Object.freeze([...fields.specAnchors]),
    spec_contributions: Object.freeze([...fields.specContributions]),
    ...(Object.keys(fields.anchorHashes).length === 0 ? {} : { spec_anchor_hashes: fields.anchorHashes }),
    verification_policy: serializeVerificationPolicy(verificationPolicy),
    ...(fields.planContext === undefined ? {} : { plan_context: fields.planContext }),
    file_list: Object.freeze([...fields.fileList]),
    ...(proofBaseline === undefined ? {} : { artifact_baseline: proofBaseline }),
    ...(startSha === undefined ? {} : { start_sha: startSha }),
    proof: derivePendingTaskProof({
      verificationPolicy,
      declaredArtifacts: fields.fileList,
      declaredArtifactExpectation: taskArtifactExpectation({ agent }),
      redThenGreen: fields.redThenGreen,
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

function sanitizeTask(
  task: AuthoredTask,
  specIndex: SpecIndexAvailability,
  proofBoundary: PopulationProofBoundary,
  inRedWindow: boolean,
  redThenGreen: RedThenGreenEra,
): Task {
  const specAnchors = task.spec_anchors ?? [];
  return populatedTask({
    id: task.id,
    description: task.description,
    agent: task.agent,
    wave: task.wave,
    dependsOn: task.depends_on ?? [],
    specAnchors,
    specContributions: task.spec_contributions ?? [],
    anchorHashes: specIndex.kind === "indexed" ? recordedAnchorHashes(specIndex.index, specAnchors) : Object.freeze({}),
    verificationPolicy: windowPolicy(taskVerificationPolicy(task), inRedWindow),
    planContext: task.plan_context,
    fileList: task.file_list,
    proofBaseline: proofBoundary.kind === "captured" ? proofBoundary.baselines.get(task.id) : undefined,
    startSha: populationRevision(proofBoundary),
    redThenGreen,
  });
}

/**
 * One planned Distill Task as its pending record (ADR-0068 §2): the distill
 * agent, no dependency and no Requirement trace, the engine-only policy, and
 * the Distill Scope as its file list. It carries no population baseline: the
 * scope's bytes at population are the bytes before its siblings implemented
 * anything, so its declared-artifact baseline is stamped at its first
 * registration, which is what its siblings left.
 */
function distillTask(plan: DistillTaskPlan, proofBoundary: PopulationProofBoundary, redThenGreen: RedThenGreenEra): Task {
  return populatedTask({
    id: plan.id,
    description: plan.description,
    agent: DISTILL_AGENT,
    wave: plan.wave,
    dependsOn: [],
    specAnchors: [],
    specContributions: [],
    anchorHashes: Object.freeze({}),
    verificationPolicy: DISTILL_VERIFICATION_POLICY,
    planContext: undefined,
    fileList: plan.scope,
    proofBaseline: undefined,
    startSha: populationRevision(proofBoundary),
    redThenGreen,
  });
}

/**
 * The Distill Tasks this roster gets, from the one planner
 * (`planDistillTasks`): the authored roster, the contract Tasks and frozen
 * paths of the contracts population is about to stamp, the frozen manifest's
 * Test-File Classification, and the operator's `distillPass` setting.
 */
function plannedDistillTasks(
  command: Pick<TaskGraphPopulationCommand, "tasks" | "verificationManifest">,
  contracts: readonly AcceptanceContract[],
): readonly DistillTaskPlan[] {
  return planDistillTasks({
    tasks: command.tasks,
    contractTaskIds: contractTaskIdsOf({ acceptance_contracts: contracts }),
    frozenPaths: contracts.flatMap((contract) => frozenPaths(contract)),
    era: frozenRedThenGreenEra(command.verificationManifest),
    setting: distillPassSetting(command.verificationManifest),
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
 *
 * The roster it writes is the authored Tasks followed by the Distill Tasks it
 * adds itself (ADR-0068), at most one per Wave and never a Wave of its own:
 * the Wave Gates are still the authored Waves'. Every population replaces the
 * whole roster, so re-population never keeps an earlier graph's Distill Task.
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
  const authoredDistill = authoredDistillTaskError(command.tasks);
  if (authoredDistill !== null) return reject("authored-distill-task", authoredDistill);
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
  // The one derivation (INV-3): an owned Invariant whose paths play two roles,
  // or one owned twice, derives no stamp, so the graph is never stamped with
  // obligations the State File parser would refuse to load.
  const derived = obligationsFromInvariants(command.invariants);
  if (!derived.ok) {
    return reject("invalid-owner-obligations", `TaskGraph population refused: ${renderObligationsError(derived.error)}; fix the plan's owned Invariants, then re-run populate-task-graph.`);
  }
  const ownerObligations = derived.value;
  const runnerRefusal = ownerRunnerRefusal(ownerObligations, command.verificationManifest);
  if (runnerRefusal !== null) return runnerRefusal;
  const exportBindings = exportBindingsStamp(command.exportBindings ?? NO_EXPORT_BINDINGS, command.contracts, command.tasks);
  if (!exportBindings.ok) return exportBindings;
  const skeletons = carriedSkeletons(existing.skeletons ?? [], exportBindings.value);
  const redWindow = redWindowTaskIds(contracts.value, command.tasks);
  const redThenGreen = redThenGreenScope(command.verificationManifest, contracts.value);

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
    task_reopening_history: _staleTaskReopeningHistory,
    orphaned_wave_gate_history: _staleOrphanedWaveGateHistory,
    spec_trace_wave_gate_retirements: _staleSpecTraceRetirements,
    spec_trace_amendments: _staleSpecTraceAmendments,
    spec_index_observation: _staleSpecIndexObservation,
    proof_boundary_observation: _staleProofBoundaryObservation,
    acceptance_contracts: _staleAcceptanceContracts,
    owner_obligations: _staleOwnerObligations,
    export_bindings: _staleExportBindings,
    skeletons: _staleSkeletons,
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
    tasks: Object.freeze([
      ...command.tasks.map((task) => sanitizeTask(
        task,
        command.specIndex,
        command.proofBoundary,
        redWindow.has(task.id),
        taskRedThenGreenEra(redThenGreen, task.id),
      )),
      ...plannedDistillTasks(command, contracts.value).map((plan) =>
        distillTask(plan, command.proofBoundary, taskRedThenGreenEra(redThenGreen, plan.id))),
    ]),
    ...(contracts.value.length === 0 ? {} : { acceptance_contracts: contracts.value }),
    // Always stamped, `[]` included: only a graph populated before owner
    // verification lacks the field, and it alone owes nothing (FR-004).
    owner_obligations: ownerObligations,
    // Always stamped, `[]` included: only a graph populated before G2 lacks
    // it, so a binding the plan gains later reads as drift, never as absence.
    export_bindings: exportBindings.value,
    ...(skeletons.length === 0 ? {} : { skeletons }),
    current_wave: 1,
    executing_tasks: Object.freeze([]),
    wave_gates: waveGates,
    verification_manifest: command.verificationManifest,
    ...(command.issue === undefined ? {} : { github_issue: command.issue }),
    ...(command.repo === undefined ? {} : { github_repo: command.repo }),
  });
  return Object.freeze({ ok: true, value: Object.freeze({ state, waves }) });
}
