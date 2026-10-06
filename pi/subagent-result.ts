/**
 * Apply one finished Pi subagent result through narrow protected-state and
 * repository ports — the imperative shell of Pi subagent settlement.
 *
 * Every applier follows one protocol: parse the stored reservation into a
 * `ReservedSlot` (`reserved-slot.ts`), observe evidence outside the lock
 * (transcript, filesystem artifacts, spec/plan bytes), run one pure reducer
 * from `subagent-settlement.ts` under `TaskGraphStore.updateAndReturn`, and
 * return the outcome. The only decisions left here are the ones that need
 * I/O under the lock: artifact-baseline comparison and new-test collection
 * read the repository against the locked Task, so they cannot leave the shell.
 *
 * Diagnostics are returned, never written. `extension.ts` owns stderr and the
 * decision about which diagnostics become orchestration processing errors.
 */

import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import {
  applyCompletionInfrastructureFailure,
  applyUntrustedStopResolution,
  cumulativeModifiedPaths,
  settleUnavailableImplementation,
} from "../engine/src/core/implementation-application";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN } from "../engine/src/types";
import { observePhaseTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  constrainReviewResolutionToScope,
  resolveTaskReviewFindings,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput } from "../engine/src/core/spec-check";
import { observeWaveSpecCheckDocuments } from "../engine/src/orchestration/wave-spec-check-documents";
import { parseSpecArtifactDirectory } from "../engine/src/core/phase-artifact-paths";
import { agentsOfKind } from "../engine/src/core/model-profiles";
import type { Phase, TaskGraph } from "../engine/src/types";
import type { ParsedTaskGraph } from "../engine/src/state-manager";
import { IMPL_AGENTS, isReviewAgent, type TaskGraphProjectBoundary } from "../engine/src/config";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
  type IsoInstant,
} from "../engine/src/core/implementation-completion";
import { PI_STRUCTURED_EVIDENCE_POLICY } from "../engine/src/core/proof-obligations";
import {
  collectNewTestEvidence,
  describeNewTestObservationError,
  realDiffDepsAt,
} from "../engine/src/handlers/helpers/task-local-completion";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
  type ExactImplementationSettlementPorts,
  type ExactNewTestCollectionArgs,
} from "../engine/src/handlers/helpers/exact-implementation-settlement";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import { compareAttemptBaseline } from "../engine/src/utils/attempt-baseline";
import { requiresNewTests, taskVerificationPolicy } from "../engine/src/core/verification-policy";
import { parsePiMessages, writtenPathsOf, type PiMessage } from "./transcript-adapter";
import { piSubagentFailureSignals, type PiSubagentResult } from "./subagent-result-batch";
import { describeCause } from "./cleanup-actions";
import {
  implementationAuthorityOf,
  parseReservedSlot,
  reviewAuthorityOf,
  specCheckAuthorityOf,
  type PiReviewAttemptAuthority,
  type ReservedSlot,
  type ReservedSlotRecord,
} from "./reserved-slot";
import {
  applicationState,
  clearCurrentReservedAuthority,
  implementationTestResult,
  observeImplementationTranscript,
  outcome,
  pendingMalformedTranscriptState,
  preparePiPhaseResult,
  processingFailure,
  reduceLockedPiPhaseResult,
  reduceLockedReviewEvidence,
  reducePiSpecCheckResult,
  renderExactPiSettlement,
  renderFailedReviewEvidence,
  renderReviewEvidence,
  reservedAuthorityIsCurrent,
  resolveImplementationTaskId,
  retireCompletedOrMissingImplementation,
  transcriptTextOf,
  type ImplementationTestObservation,
  type ImplementationTranscriptObservation,
  type LockedPiSettlement,
  type LockedReviewEvidenceApplication,
  type ParentPromptText,
  type PiResultOutcome,
  type PiSpecCheckObservation,
} from "./subagent-settlement";

const PHASE_AGENTS: ReadonlySet<string> = new Set(agentsOfKind("phase"));

type LoomTask = TaskGraph["tasks"][number];

/**
 * The protected-state seam. `StateManager` satisfies it structurally; a test
 * supplies an in-memory pair. Deliberately narrower than `StateManager` — an
 * applier that needs more than load-and-update is doing something the shell
 * should own.
 */
export type TaskGraphStore = Readonly<{
  load(): ParsedTaskGraph;
  update(mutate: (state: ParsedTaskGraph) => TaskGraph): Promise<void>;
  updateAndReturn<T>(
    mutate: (state: ParsedTaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T>;
}>;

/**
 * The git seam. Only two facts are needed, and both are questions about the
 * repository rather than operations on it, so the port stays a pair of reads.
 */
export type RepositoryProbe = Readonly<{
  root(): string;
  isRepo(): boolean;
}>;

type SlotParse =
  | Readonly<{ ok: true; slot: ReservedSlot | undefined }>
  | Readonly<{ ok: false; outcome: PiResultOutcome }>;

/** Parse the stored reservation once, at the applier seam: a contradictory slot never reaches evidence. */
function parseSlot(record: ReservedSlotRecord | undefined): SlotParse {
  if (record === undefined) return { ok: true, slot: undefined };
  const parsed = parseReservedSlot(record);
  return parsed.ok
    ? { ok: true, slot: parsed.value }
    : { ok: false, outcome: processingFailure(`loom(pi): ${parsed.error} — evidence NOT applied`) };
}

async function settleCompletedOrMissingImplementation(
  store: TaskGraphStore,
  taskId: string,
  expected: ImplementationAttemptAuthority | null,
): Promise<boolean> {
  return store.updateAndReturn((state) => {
    const retired = retireCompletedOrMissingImplementation(state, taskId, { implementationAuthority: expected });
    return { state: retired.state, value: retired.retired };
  });
}

// ---------------------------------------------------------------------------
// Failed results
// ---------------------------------------------------------------------------

type FailedImplementationArgs = Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  slot: ReservedSlot | undefined;
  failure: string;
  now: string;
}>;

type BoundImplementation = Readonly<{ kind: "bound"; taskId: string; inferred: boolean }>;

async function settleFailedExactImplementation(
  args: FailedImplementationArgs,
  binding: BoundImplementation,
  authority: ImplementationAttemptAuthority,
): Promise<PiResultOutcome> {
  const observedAt = parseIsoInstant(args.now, "Pi failed-result instant");
  if (!observedAt.ok) return outcome(observedAt.error.errors, observedAt.error.errors);
  const settlement = await args.store.updateAndReturn((state) => {
    const applied = settleUnavailableImplementation(state, authority, observedAt.value, args.failure);
    return {
      state: applicationState(state, applied),
      value: applied,
    };
  });
  if (settlement.kind === "error") {
    const message = `loom(pi): ${args.failure}; exact Oracle settlement failed: ${JSON.stringify(settlement.error)} — current attempt preserved`;
    return processingFailure(message);
  }
  return settlement.kind === "ignored"
    ? outcome([`loom(pi): ${args.failure}; exact result ignored (${settlement.reason})`])
    : outcome([`loom(pi): ${args.failure} — ${settlement.transition.kind} receipt stored for ${binding.taskId}`]);
}

async function cleanupFailedLegacyImplementation(
  args: FailedImplementationArgs,
  binding: BoundImplementation,
): Promise<PiResultOutcome> {
  const released = await args.store.updateAndReturn((state) => {
    const task = state.tasks.find((candidate) => candidate.id === binding.taskId);
    if (task?.active_implementation_attempt !== undefined) return { state, value: false };
    return {
      state: {
        ...state,
        executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== binding.taskId),
        tasks: state.tasks.map((candidate) => candidate.id === binding.taskId
          ? { ...candidate, reserved_at: undefined, legacy_execution_reservation: undefined }
          : candidate),
      },
      value: true,
    };
  });
  if (!released) {
    const message = `loom(pi): ${args.failure}; modern attempt lacks exact ReservedSlot authority — current attempt preserved`;
    return processingFailure(message);
  }
  const inference = binding.inferred
    ? `loom(pi): ${args.failure} — released ${binding.taskId} legacy reservation inferred from the sole executing ` +
      "Task; completion evidence ignored and the attribution itself is unproven"
    : `loom(pi): ${args.failure} — released ${binding.taskId} legacy reservation; completion evidence ignored`;
  return binding.inferred ? outcome([inference], [inference]) : outcome([inference]);
}

async function applyFailedImplementationResult(args: FailedImplementationArgs): Promise<PiResultOutcome> {
  const executingTasks = args.store.load().executing_tasks ?? [];
  const authority = implementationAuthorityOf(args.slot);
  const binding = resolveImplementationTaskId({
    agentType: args.agentType,
    reservedTaskId: args.slot?.taskId ?? null,
    reservedAuthority: authority,
    resultPrompt: args.result.task,
    parentPrompt: "",
    executingTasks,
  });
  if (binding.kind === "unbound") {
    const message = `loom(pi): ${args.failure}; ${binding.reason} — completion evidence ignored`;
    return outcome([message], executingTasks.length > 0 ? [message] : []);
  }
  if (await settleCompletedOrMissingImplementation(args.store, binding.taskId, authority)) {
    return outcome([`loom(pi): ${binding.taskId} failed after completion; retired exact completed/missing reservation`]);
  }
  return authority === null
    ? cleanupFailedLegacyImplementation(args, binding)
    : settleFailedExactImplementation(args, binding, authority);
}

async function applyFailedReviewResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  slot: ReservedSlot | undefined;
  failure: string;
}>): Promise<PiResultOutcome> {
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.slot?.taskId ?? null;
  if (reservedTaskId === null) {
    const message = `loom(pi): ${args.failure}; failed reviewer has no reserved Task authority — review evidence NOT stored`;
    return processingFailure(message);
  }
  if (returnedTaskId !== reservedTaskId) {
    const message = `loom(pi): ${args.failure}; returned Task ${returnedTaskId ?? "missing"} does not match ` +
      `reserved Task ${reservedTaskId} — review evidence NOT stored`;
    return processingFailure(message);
  }
  const application = await args.store.updateAndReturn<LockedReviewEvidenceApplication>((state) =>
    reduceLockedReviewEvidence(state, {
      agentType: args.agentType,
      taskId: reservedTaskId,
      reviewAuthority: reviewAuthorityOf(args.slot),
      resolutionFor: () => ({
        kind: "evidence-failed" as const,
        agent: args.agentType,
        message: args.failure,
      }),
    }));
  return renderFailedReviewEvidence(args.failure, reservedTaskId, application);
}

type FailedPiResultArgs = Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlotRecord | undefined;
  now: string;
  projectBoundary: TaskGraphProjectBoundary;
}>;

async function applyFailedSpecCheckResult(args: Readonly<{
  store: TaskGraphStore;
  slot: ReservedSlot | undefined;
  failure: string;
  now: string;
  projectBoundary: TaskGraphProjectBoundary;
}>): Promise<PiResultOutcome> {
  let observedState: ParsedTaskGraph;
  try {
    observedState = args.store.load();
  } catch (cause) {
    const diagnostic = `spec-check TaskGraph load failed: ${describeCause(cause)}`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  }
  let specObservation;
  try {
    specObservation = observeWaveSpecCheckDocuments({
      specFile: observedState.spec_file,
      planFile: observedState.plan_file,
      projectBoundary: args.projectBoundary,
    });
  } catch (cause) {
    const diagnostic = `spec-check document observation failed: ${describeCause(cause)}`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  }
  try {
    return await args.store.updateAndReturn((state) =>
      reducePiSpecCheckResult(
        state,
        specCheckAuthorityOf(args.slot),
        { kind: "capture-failed", error: args.failure },
        specObservation.authority,
        args.now,
      ));
  } catch (cause) {
    const diagnostic = `spec-check settlement persistence failed: ${describeCause(cause)}`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  }
}

/**
 * Record the failure of an agent whose process did not succeed.
 *
 * A failed process may retain valid-looking assistant text; none of it is
 * parsed as evidence here. Under exact current reserved authority, the failure
 * is persisted only under the authority each category owns: exact attempt/slot
 * authority for implementation and spec-check agents. Reviewers require a
 * matching Task and, for active Review Runs, exact generation/packet/slot/attempt
 * authority. Unreserved failures never store positive evidence; a proven
 * legacy implementation reservation may still be released during cleanup.
 */
export async function applyFailedPiResult(args: FailedPiResultArgs): Promise<PiResultOutcome> {
  const { store, agentType, result } = args;
  const parsedSlot = parseSlot(args.reservedSlot);
  if (!parsedSlot.ok) return parsedSlot.outcome;
  const { slot } = parsedSlot;
  const failure =
    `${agentType} failed before evidence capture completed (${piSubagentFailureSignals(result)})`;

  if (isReviewAgent(agentType)) {
    return applyFailedReviewResult({ store, agentType, result, slot, failure });
  }

  if (agentType === "spec-check-invoker") {
    return applyFailedSpecCheckResult({ store, slot, failure, now: args.now, projectBoundary: args.projectBoundary });
  }

  // The dispatcher normally settled a reserved failure through
  // finalizeReservedImplementations first. This idempotent release keeps the
  // applier correct in isolation without overwriting that richer proof.
  if (IMPL_AGENTS.has(agentType)) {
    return applyFailedImplementationResult({ store, agentType, result, slot, failure, now: args.now });
  }
  if (PHASE_AGENTS.has(agentType)) {
    const message = `loom(pi): ${failure} — phase was not advanced`;
    return processingFailure(message);
  }
  return outcome([`loom(pi): ${failure} — completion evidence ignored`]);
}

// ---------------------------------------------------------------------------
// Phase agents
// ---------------------------------------------------------------------------

/**
 * Record a phase agent's artifacts and advance the phase.
 *
 * Which written path is the spec/plan file is decided by
 * `core/phase-artifact-paths`, the same resolved-containment rule the Claude
 * Code handler uses. It was previously an inline
 * `filePath.includes(specDir) && endsWith("/spec.md")` here — a substring test
 * that admits `.claude/specs/../../../tmp/evil/spec.md`, which then became the
 * run's authoritative spec artifact.
 */
export async function applyPhaseAgentPiResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  completedPhase: Phase;
  result: PiSubagentResult;
  now: string;
  /** The project boundary the run's artifacts live under, derived from the
   *  TaskGraph's own location. REQUIRED: phase artifacts are stored
   *  project-relative, so probing them against the Pi process's cwd searches
   *  the wrong checkout whenever the parent session is rooted elsewhere than
   *  the graph (the worktree case). Production callers pass
   *  `observeTaskGraphProjectBoundary(...).root`; requiring the argument makes
   *  the omission a compile error instead of a silent cross-checkout drift. */
  phaseArtifactBaseDir: string;
}>): Promise<PiResultOutcome> {
  const parsed = parsePiMessages(args.result.messages);
  if (!parsed.ok) {
    const diagnostic = `${args.agentType} phase artifact extraction failed: ${parsed.errors.join("; ")}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }
  const writtenPaths = writtenPathsOf(parsed.value);
  try {
    const observedState = args.store.load();
    const prepared = preparePiPhaseResult(
      observedState,
      args.completedPhase,
      writtenPaths,
      args.phaseArtifactBaseDir,
    );
    const observation = prepared.kind === "eligible"
      ? (() => {
          const specDir = parseSpecArtifactDirectory(prepared.state.spec_dir);
          if (!specDir.ok) throw new Error(specDir.message);
          return observePhaseTransition(args.completedPhase, prepared.state, specDir.value,
            args.phaseArtifactBaseDir);
        })()
      : null;
    return await args.store.updateAndReturn((locked) =>
      reduceLockedPiPhaseResult(locked, args, writtenPaths, observation));
  } catch (error) {
    const diagnostic = `phase state commit failed: ${describeCause(error)}`;
    return outcome([`loom: ${diagnostic}`], [diagnostic]);
  }
}

// ---------------------------------------------------------------------------
// Implementation agents
// ---------------------------------------------------------------------------

type ImplementationPiResultArgs = Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  authoritativeStatePath: string;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlotRecord | undefined;
  parentPrompt: ParentPromptText;
}>;

/** The implementation arguments after the reservation was parsed at the seam. */
type SlottedImplementationArgs = Omit<ImplementationPiResultArgs, "reservedSlot"> &
  Readonly<{ slot: ReservedSlot | undefined }>;

type ImplementationBindingResolution =
  | Readonly<{ kind: "unbound"; outcome: PiResultOutcome }>
  | Readonly<{
      kind: "bound";
      taskId: string;
      log: readonly string[];
      /** Set when the Task was guessed from `executing_tasks`, never named by the result. */
      inference: string | null;
    }>;

type ResultImplementationBinding = Extract<ImplementationBindingResolution, { kind: "bound" }>;

function resolveImplementationBindingForResult(args: SlottedImplementationArgs): ImplementationBindingResolution {
  const binding = resolveImplementationTaskId({
    agentType: args.agentType,
    reservedTaskId: args.slot?.taskId ?? null,
    reservedAuthority: implementationAuthorityOf(args.slot),
    resultPrompt: args.result.task,
    parentPrompt: args.parentPrompt,
    executingTasks: args.store.load().executing_tasks ?? [],
  });
  if (binding.kind === "unbound") {
    return { kind: "unbound", outcome: outcome([binding.reason], [binding.reason]) };
  }
  const inference = binding.inferred
    ? `${args.agentType} named no Task: attribution was inferred because executing_tasks holds exactly one ` +
      `Task, so ${binding.taskId} is credited on that guess and not on evidence`
    : null;
  return {
    kind: "bound",
    taskId: binding.taskId,
    log: inference === null ? [] : [`WARNING: ${inference}`],
    inference,
  };
}

/**
 * The locked malformed-transcript resolution. Impure by necessity: the
 * artifact-baseline comparison reads the repository against the LOCKED Task,
 * so it runs inside the store callback and stays in the shell.
 */
function malformedTranscriptResolutionState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  expected: ImplementationAttemptAuthority | null;
  failureReason: string;
  root: string;
  comparisonFailures: string[];
}>): TaskGraph {
  const currentTarget = args.state.tasks.find((candidate) => candidate.id === args.taskId);
  if (!reservedAuthorityIsCurrent(args.state, args.taskId, args.expected)) return args.state;
  if (currentTarget === undefined || currentTarget.status === "completed") {
    return {
      ...args.state,
      executing_tasks: (args.state.executing_tasks ?? []).filter((id) => id !== args.taskId),
    };
  }
  const comparison = compareAttemptBaseline(args.root, currentTarget, { kind: "repository-or-declared" });
  if (comparison.failure !== null) {
    args.comparisonFailures.push(
      `loom(pi): cannot compare malformed-transcript attempt baseline for ${args.taskId}: ${comparison.failure} — ` +
      `invalidating stale evidence`,
    );
  }
  if (!comparison.bytesChangedSinceAttempt) return pendingMalformedTranscriptState(args);
  return clearCurrentReservedAuthority(applyUntrustedStopResolution(args.state, args.taskId, {
    taskCompleted: false,
    testResult: {
      verdict: "untrusted",
      passed: false,
      label: "pi-transcript-capture-failed",
      provenance: "unverified",
    },
    testEvidence: args.failureReason,
    filesModified: [],
    changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
    bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
    newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN,
  }).state, args.taskId, args.expected);
}

async function applyMalformedImplementationTranscript(args: Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  taskId: string;
  expected: ImplementationAttemptAuthority | null;
  failureReason: string;
}>): Promise<readonly string[]> {
  const root = args.repository.root();
  const comparisonFailures: string[] = [];
  await args.store.update((state) => malformedTranscriptResolutionState({
    state,
    taskId: args.taskId,
    expected: args.expected,
    failureReason: args.failureReason,
    root,
    comparisonFailures,
  }));
  return [
    ...comparisonFailures,
    `loom(pi): ${args.failureReason} — ${args.taskId} evidence was not accepted`,
  ];
}

type ModifiedPathRead =
  | Readonly<{ ok: true; filesModified: readonly string[] }>
  | Readonly<{ ok: false; message: string }>;

function readImplementationModifiedPaths(
  repository: RepositoryProbe,
  resultMessages: readonly PiMessage[],
  taskId: string,
): ModifiedPathRead {
  const piJsonl = resultMessages.map((message) => JSON.stringify({ type: "message", message })).join("\n");
  try {
    return {
      ok: true,
      filesModified: canonicalRepositoryPaths(
        repository.root(),
        parseFilesModified(piJsonl, "pi"),
        "Pi transcript files_modified",
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: `loom(pi): unsafe modified-file evidence for ${taskId}: ` +
        `${describeCause(error)} — task left pending`,
    };
  }
}

type NewTestRepositoryAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "unavailable"; diagnostic: string }>;

function observeNewTestRepository(
  repository: RepositoryProbe,
  taskId: string,
): NewTestRepositoryAvailability {
  return repository.isRepo()
    ? { kind: "available" }
    : {
        kind: "unavailable",
        diagnostic: `loom(pi): cannot collect new-test evidence for ${taskId}: repository probe reports a non-Git working directory — ` +
          "new-test proof remains unsatisfied",
      };
}

type LegacyImplementationQuarantineArgs = Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  taskId: string;
  filesModified: readonly string[];
  test: ImplementationTestObservation;
}>;

type LegacyImplementationQuarantine = Readonly<{
  log: readonly string[];
  processingErrors: readonly string[];
}>;

/**
 * Legacy (no exact authority) completion. Impure by necessity: the baseline
 * comparison and new-test collection read the repository and Git against the
 * LOCKED Task. The reservation is legacy, so the expected authority is `null`.
 */
async function applyLegacyImplementationQuarantine(
  args: LegacyImplementationQuarantineArgs,
): Promise<LegacyImplementationQuarantine> {
  const repository = observeNewTestRepository(args.repository, args.taskId);
  const log: string[] = [];
  const processingErrors: string[] = [];
  const root = args.repository.root();
  let skippedExistingVerdict = false;
  await args.store.update((state) => {
    if (!reservedAuthorityIsCurrent(state, args.taskId, null)) {
      const diagnostic = `loom(pi): reserved authority for ${args.taskId} is stale — current attempt preserved`;
      log.push(diagnostic);
      return state;
    }
    const currentTarget = state.tasks.find((candidate) => candidate.id === args.taskId);
    const testResult = implementationTestResult(args.test);
    const testEvidence = args.test.evidence.evidence;
    if (currentTarget === undefined || currentTarget.status === "completed") {
      const applied = applyUntrustedStopResolution(state, args.taskId, {
        taskCompleted: true,
        testResult,
        testEvidence,
        filesModified: args.filesModified,
        changedDeclaredArtifacts: [],
        bytesChangedSinceAttempt: false,
        newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN,
      });
      skippedExistingVerdict = applied.skipped;
      return applied.state;
    }
    const comparison = compareAttemptBaseline(root, currentTarget, {
      kind: "repository-or-declared",
      extraModifiedPaths: args.filesModified,
    });
    const quarantineCompletionAuthority = (diagnostic: string): TaskGraph => {
      log.push(diagnostic);
      processingErrors.push(diagnostic);
      return applyCompletionInfrastructureFailure(
        state,
        args.taskId,
        comparison.bytesChangedSinceAttempt,
        undefined,
      );
    };
    if (comparison.failure !== null) {
      return quarantineCompletionAuthority(
        `loom(pi): cannot compare declared-artifact baseline for ${args.taskId}: ${comparison.failure} — ` +
          `completion evidence was not applied`,
      );
    }
    const cumulativeFiles = cumulativeModifiedPaths(currentTarget.files_modified, args.filesModified);
    const verificationPolicy = taskVerificationPolicy(currentTarget);
    if (repository.kind === "unavailable" && requiresNewTests(verificationPolicy)) {
      return quarantineCompletionAuthority(repository.diagnostic);
    }
    const newTestObservation = collectNewTestEvidence(
      cumulativeFiles,
      verificationPolicy.newTests,
      currentTarget.start_sha,
      realDiffDepsAt(root),
    );
    if (!newTestObservation.ok) {
      return quarantineCompletionAuthority(
        `loom(pi): cannot collect new-test evidence for ${args.taskId}: ` +
          describeNewTestObservationError(newTestObservation.error),
      );
    }
    const applied = applyUntrustedStopResolution(state, args.taskId, {
      taskCompleted: true,
      testResult,
      testEvidence,
      filesModified: args.filesModified,
      changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
      bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
      newTests: newTestObservation.value,
    });
    skippedExistingVerdict = applied.skipped;
    return applied.state;
  });

  if (skippedExistingVerdict) {
    log.push(`loom(pi): ${args.taskId} is completed or missing — leaving task evidence untouched`);
  }
  return { log, processingErrors };
}

type ExactPiSettlementArgs = SlottedImplementationArgs & Readonly<{
  binding: ResultImplementationBinding;
  authority: ImplementationAttemptAuthority;
  observedAt: IsoInstant;
  log: string[];
}>;

async function settleExactPiInfrastructure(
  args: ExactPiSettlementArgs,
  reason: string,
): Promise<PiResultOutcome> {
  const settled = await args.store.updateAndReturn((state): Readonly<{ state: TaskGraph; value: LockedPiSettlement }> => {
    const application = settleUnavailableImplementation(state, args.authority, args.observedAt, reason);
    return {
      state: applicationState(state, application),
      value: { application, infrastructureReason: reason },
    };
  });
  return renderExactPiSettlement(args.binding.taskId, args.log, settled);
}

function piExactSettlementPorts(args: ExactPiSettlementArgs): ExactImplementationSettlementPorts {
  const production = productionExactSettlementPorts(
    args.repository.root(),
    args.authoritativeStatePath,
  );
  return Object.freeze({
    ...production,
    newTests: Object.freeze({
      collect: (input: ExactNewTestCollectionArgs) => {
        const waived = input.requirement === false ||
          (typeof input.requirement === "object" && input.requirement.kind === "waived");
        if (!waived && !args.repository.isRepo()) {
          throw new Error(
            `repository probe for ${args.binding.taskId} reports a non-Git working directory`,
          );
        }
        return production.newTests.collect(input);
      },
    }),
  });
}

/** The locked exact settlement. Impure by necessity: its ports read the repository against the locked Task. */
function settleLockedPiResult(
  state: TaskGraph,
  args: ExactPiSettlementArgs,
  transcript: Extract<ImplementationTranscriptObservation, { kind: "accepted" }>,
  modifiedPaths: readonly string[],
): LockedPiSettlement {
  return settleExactImplementation(state, {
    transport: "Pi",
    authority: args.authority,
    observedAt: args.observedAt,
    parserModifiedPaths: modifiedPaths,
    parserPathLabel: "Pi transcript files_modified",
    taskCompleted: true,
    testResult: implementationTestResult(transcript.test),
    testEvidence: transcript.test.evidence.evidence,
    proofEvaluationPolicy: PI_STRUCTURED_EVIDENCE_POLICY,
  }, piExactSettlementPorts(args));
}

async function applyExactImplementationPiResult(args: ExactPiSettlementArgs): Promise<PiResultOutcome> {
  const transcript = observeImplementationTranscript(args.result.messages, args.binding.taskId);
  args.log.push(...transcript.log);
  if (transcript.kind === "malformed") return settleExactPiInfrastructure(args, transcript.failureReason);
  const modified = readImplementationModifiedPaths(args.repository, transcript.resultMessages, args.binding.taskId);
  if (!modified.ok) return settleExactPiInfrastructure(args, modified.message);
  const settled = await args.store.updateAndReturn((state) => {
    const application = settleLockedPiResult(state, args, transcript, modified.filesModified);
    return {
      state: applicationState(state, application.application),
      value: application,
    };
  });
  return renderExactPiSettlement(args.binding.taskId, args.log, settled);
}

async function applyLegacyImplementationPiResult(
  args: SlottedImplementationArgs,
  binding: ResultImplementationBinding,
  log: string[],
): Promise<PiResultOutcome> {
  const transcript = observeImplementationTranscript(args.result.messages, binding.taskId);
  log.push(...transcript.log);
  if (transcript.kind === "malformed") {
    const failures = await applyMalformedImplementationTranscript({
      store: args.store,
      repository: args.repository,
      taskId: binding.taskId,
      expected: null,
      failureReason: transcript.failureReason,
    });
    return outcome([...log, ...failures], failures);
  }
  const modified = readImplementationModifiedPaths(args.repository, transcript.resultMessages, binding.taskId);
  if (!modified.ok) {
    await args.store.update((state) => applyCompletionInfrastructureFailure(state, binding.taskId, true));
    return outcome([...log, modified.message], [modified.message]);
  }
  const settlement = await applyLegacyImplementationQuarantine({
    store: args.store,
    repository: args.repository,
    taskId: binding.taskId,
    filesModified: modified.filesModified,
    test: transcript.test,
  });
  return outcome([...log, ...settlement.log], settlement.processingErrors);
}

async function applyBoundImplementationPiResult(
  args: SlottedImplementationArgs,
  binding: ResultImplementationBinding,
): Promise<PiResultOutcome> {
  const log = [...binding.log];
  const authority = implementationAuthorityOf(args.slot);
  if (await settleCompletedOrMissingImplementation(args.store, binding.taskId, authority)) {
    return outcome([...log, `loom(pi): ${binding.taskId} stopped; retired exact completed/missing reservation`]);
  }
  const currentTask = args.store.load().tasks.find((task) => task.id === binding.taskId);
  if (currentTask?.active_implementation_attempt !== undefined && authority === null) {
    const diagnostic = `loom(pi): modern implementation ${binding.taskId} has no exact ReservedSlot authority — current attempt preserved`;
    return outcome([...log, diagnostic], [diagnostic]);
  }
  if (authority === null) return applyLegacyImplementationPiResult(args, binding, log);
  const observedAt = parseIsoInstant(new Date().toISOString(), "Pi implementation observation instant");
  if (!observedAt.ok) return outcome(observedAt.error.errors, observedAt.error.errors);
  const exactArgs = { ...args, binding, authority, observedAt: observedAt.value, log };
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.slot?.taskId ?? null;
  if (returnedTaskId === null || reservedTaskId === null ||
      returnedTaskId !== reservedTaskId || returnedTaskId !== authority.taskId ||
      binding.taskId !== authority.taskId) {
    return settleExactPiInfrastructure(
      exactArgs,
      `Pi result Task identity mismatch: returned=${returnedTaskId ?? "missing"}, ` +
        `reserved=${reservedTaskId ?? "missing"}, authority=${authority.taskId}`,
    );
  }
  return applyExactImplementationPiResult(exactArgs);
}

/** Resolve one Pi implementation result through exact modern or cleanup-only legacy authority. */
export async function applyImplementationPiResult(args: ImplementationPiResultArgs): Promise<PiResultOutcome> {
  const parsedSlot = parseSlot(args.reservedSlot);
  if (!parsedSlot.ok) return parsedSlot.outcome;
  const slotted: SlottedImplementationArgs = { ...args, slot: parsedSlot.slot };
  const binding = resolveImplementationBindingForResult(slotted);
  if (binding.kind === "unbound") return binding.outcome;
  const result = await applyBoundImplementationPiResult(slotted, binding);
  // An inferred attribution is never a clean processing: the result named no
  // Task of its own, so the harness must see the verdict as unproven instead of
  // reading a warning that only ever reached stderr.
  return binding.inference === null
    ? result
    : outcome([...result.log], [...result.processingErrors, `loom(pi): ${binding.inference}`]);
}

// ---------------------------------------------------------------------------
// Review agents
// ---------------------------------------------------------------------------

type ReviewTaskBinding =
  | Readonly<{ kind: "blocked"; outcome: PiResultOutcome }>
  | Readonly<{ kind: "bound"; taskId: string }>;

function resolveReviewTaskBinding(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  slot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): ReviewTaskBinding {
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.slot?.taskId ?? null;
  if (reservedTaskId !== null && returnedTaskId !== reservedTaskId) {
    const message = `WARNING: ${args.agentType} review result Task identity ${returnedTaskId ?? "missing"} ` +
      `does not match reserved Task ${reservedTaskId} — findings NOT stored`;
    return { kind: "blocked", outcome: processingFailure(message) };
  }
  const taskId = reservedTaskId ?? returnedTaskId ?? extractTaskId(args.parentPrompt);
  if (!taskId) {
    const message = `WARNING: ${args.agentType} review completed without an extractable task ID — findings NOT stored`;
    return { kind: "blocked", outcome: processingFailure(message) };
  }

  const reviewTask = args.store.load().tasks.find((task) => task.id === taskId);
  if (!reviewTask) {
    const message = `WARNING: ${args.agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored`;
    return { kind: "blocked", outcome: processingFailure(message) };
  }
  return { kind: "bound", taskId };
}

/** Apply parsed or malformed reviewer evidence under the one locked review protocol. */
async function applyLockedReviewEvidence(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewAuthority: PiReviewAttemptAuthority | null;
  resolutionFor(task: LoomTask): ReviewResolution;
}>): Promise<PiResultOutcome> {
  const application = await args.store.updateAndReturn<LockedReviewEvidenceApplication>((state) =>
    reduceLockedReviewEvidence(state, args));
  return renderReviewEvidence(args.agentType, args.taskId, application);
}

/**
 * Store one reviewer's findings against the task it names.
 *
 * Transcript text is derived from in-memory result messages outside the lock;
 * packet generation and scope authority are resolved against the current task
 * INSIDE it. The Claude Code
 * shell uses the same state-ownership boundary.
 */
export async function applyReviewPiResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlotRecord | undefined;
  parentPrompt: ParentPromptText;
}>): Promise<PiResultOutcome> {
  const parsedSlot = parseSlot(args.reservedSlot);
  if (!parsedSlot.ok) return parsedSlot.outcome;
  const { slot } = parsedSlot;
  const binding = resolveReviewTaskBinding({ ...args, slot });
  if (binding.kind === "blocked") return binding.outcome;

  const parsedMessages = parsePiMessages(args.result.messages);
  const locked = {
    store: args.store,
    agentType: args.agentType,
    taskId: binding.taskId,
    reviewAuthority: reviewAuthorityOf(slot),
  };
  if (!parsedMessages.ok) {
    const resolution: ReviewResolution = {
      kind: "evidence-failed",
      agent: args.agentType,
      message: `Pi review messages are malformed: ${parsedMessages.errors.join("; ")}`,
    };
    return applyLockedReviewEvidence({ ...locked, resolutionFor: () => resolution });
  }
  const transcriptText = transcriptTextOf(parsedMessages.value);
  return applyLockedReviewEvidence({
    ...locked,
    resolutionFor: (task) => constrainReviewResolutionToScope(
      resolveTaskReviewFindings(transcriptText, args.agentType, task.review_run, task.review_generation),
      [...(task.file_list ?? []), ...(task.files_modified ?? [])],
    ),
  });
}

// ---------------------------------------------------------------------------
// Spec-check invoker
// ---------------------------------------------------------------------------

/**
 * Reconcile the wave's spec-check evidence.
 *
 * `blocked` is DERIVED through `reconcileWaveBlock`, never asserted — the same
 * single rule `store-spec-check-findings` computes from on the Claude Code side,
 * so the two harnesses cannot disagree about whether the wave has a cause.
 */
export async function applySpecCheckPiResult(args: Readonly<{
  store: TaskGraphStore;
  result: PiSubagentResult;
  reservedSlot: ReservedSlotRecord | undefined;
  now: string;
  projectBoundary: TaskGraphProjectBoundary;
}>): Promise<PiResultOutcome> {
  const parsedSlot = parseSlot(args.reservedSlot);
  if (!parsedSlot.ok) return parsedSlot.outcome;
  const authority = specCheckAuthorityOf(parsedSlot.slot);
  const parsedMessages = parsePiMessages(args.result.messages);
  const observation: PiSpecCheckObservation = parsedMessages.ok
    ? { kind: "parsed", findings: parseSpecCheckOutput(transcriptTextOf(parsedMessages.value)) }
    : {
        kind: "capture-failed",
        error: `spec-check-invoker messages are malformed: ${parsedMessages.errors.join("; ")}`,
      };
  try {
    const observedState = args.store.load();
    const specObservation = observeWaveSpecCheckDocuments({
      specFile: observedState.spec_file,
      planFile: observedState.plan_file,
      projectBoundary: args.projectBoundary,
    });
    return await args.store.updateAndReturn((state) =>
      reducePiSpecCheckResult(state, authority, observation, specObservation.authority, args.now));
  } catch (error) {
    const diagnostic = `spec-check state commit failed: ${describeCause(error)}`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  }
}
