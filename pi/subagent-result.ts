/**
 * Apply one finished Pi subagent result through narrow protected-state and
 * repository ports — the imperative shell of Pi subagent settlement.
 *
 * Every applier follows one protocol: read the reservation's `ReservedSlot`
 * (`reserved-slot.ts`; already parsed at the spawn producer, so a
 * contradictory slot cannot reach evidence), observe evidence outside the lock
 * (transcript, filesystem artifacts, spec/plan bytes), run one pure reducer
 * from `subagent-settlement.ts` under `TaskGraphStore.updateAndReturn`, and
 * return the outcome. An implementation result settles only through the exact
 * attempt authority its slot carries; the byte observation and new-test
 * collection that settlement reads under the lock are its injected ports.
 *
 * Diagnostics are returned, never written. `extension.ts` owns stderr and the
 * decision about which diagnostics become orchestration processing errors.
 */

import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { settleUnavailableImplementation } from "../engine/src/core/implementation-application";
import type { LedgerObservation } from "../engine/src/core/red-then-green-types";
import { observePhaseTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  constrainReviewResolutionToScope,
  resolveTaskReviewFindings,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput } from "../engine/src/core/spec-check";
import { observeWaveSpecCheckDocuments } from "../engine/src/orchestration/wave-spec-check-documents";
import { parseSpecArtifactDirectory } from "../engine/src/core/phase-artifact-paths";
import type { Phase, TaskGraph } from "../engine/src/types";
import type { ParsedTaskGraph } from "../engine/src/state-manager";
import type { TaskGraphProjectBoundary } from "../engine/src/config";
import { agentsOfKind, IMPL_AGENTS, isReviewAgent } from "../engine/src/core/agent-catalog-projections";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
  type IsoInstant,
} from "../engine/src/core/implementation-completion";
import { PI_STRUCTURED_EVIDENCE_POLICY } from "../engine/src/core/proof-obligations";
import {
  productionExactSettlementPorts,
  settleAndPersistExactImplementation,
  type ExactImplementationSettlementPorts,
  type ExactImplementationTransportFacts,
  type ExactNewTestCollectionArgs,
} from "../engine/src/handlers/helpers/exact-implementation-settlement";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import { parsePiMessages, writtenPathsOf, type PiMessage } from "./transcript-adapter";
import { piSubagentFailureSignals, type PiSubagentResult } from "./subagent-result-batch";
import { describeCause } from "./cleanup-actions";
import {
  implementationAuthorityOf,
  reviewAuthorityOf,
  specCheckAuthorityOf,
  type PiReviewAttemptAuthority,
  type ReservedSlot,
} from "./reserved-slot";
import {
  applicationState,
  implementationTestResult,
  observeImplementationTranscript,
  outcome,
  preparePiPhaseResult,
  processingFailure,
  reduceLockedPiPhaseResult,
  reduceLockedReviewEvidence,
  reducePiSpecCheckResult,
  renderExactPiSettlement,
  renderFailedReviewEvidence,
  renderReviewEvidence,
  retireCompletedImplementation,
  transcriptTextOf,
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

async function settleCompletedImplementation(
  store: TaskGraphStore,
  authority: ImplementationAttemptAuthority,
): Promise<boolean> {
  return store.updateAndReturn((state) => {
    const retired = retireCompletedImplementation(state, authority.taskId, authority);
    return { state: retired.state, value: retired.retired };
  });
}

/**
 * An implementation result whose slot carries no exact attempt authority
 * settles nothing. Every executing Task carries an attempt (the State File
 * refuses any other, ADR-0098), so an executing Task belongs to an exact
 * reservation this result does not hold and is preserved; with nothing
 * executing there is nothing the result could settle.
 */
function unauthorizedImplementationOutcome(store: TaskGraphStore, subject: string): PiResultOutcome {
  const executing = store.load().executing_tasks ?? [];
  return executing.length === 0
    ? outcome([`loom(pi): ${subject} without implementation attempt authority and no Task is executing — nothing settled`])
    : processingFailure(
        `loom(pi): ${subject} without exact implementation attempt authority — ` +
          `${executing.length} executing attempt(s) preserved`,
      );
}

// ---------------------------------------------------------------------------
// Failed results
// ---------------------------------------------------------------------------

type FailedImplementationArgs = Readonly<{
  store: TaskGraphStore;
  slot: ReservedSlot | undefined;
  failure: string;
  now: string;
}>;

async function settleFailedExactImplementation(
  args: FailedImplementationArgs,
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
    : outcome([`loom(pi): ${args.failure} — ${settlement.transition.kind} receipt stored for ${authority.taskId}`]);
}

async function applyFailedImplementationResult(args: FailedImplementationArgs): Promise<PiResultOutcome> {
  const authority = implementationAuthorityOf(args.slot);
  if (authority === null) return unauthorizedImplementationOutcome(args.store, args.failure);
  if (await settleCompletedImplementation(args.store, authority)) {
    return outcome([`loom(pi): ${authority.taskId} failed after completion; retired exact completed/missing reservation`]);
  }
  return settleFailedExactImplementation(args, authority);
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
  reservedSlot: ReservedSlot | undefined;
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
 * authority. Unreserved failures never store evidence.
 */
export async function applyFailedPiResult(args: FailedPiResultArgs): Promise<PiResultOutcome> {
  const { store, agentType, result, reservedSlot: slot } = args;
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
    return applyFailedImplementationResult({ store, slot, failure, now: args.now });
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
  reservedSlot: ReservedSlot | undefined;
  /** The child's attempt epoch read back from the parent ledger (I6, FR-035). */
  ledger: LedgerObservation;
}>;

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

type ExactPiSettlementArgs = ImplementationPiResultArgs & Readonly<{
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
  return renderExactPiSettlement(args.authority.taskId, args.log, settled);
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
            `repository probe for ${args.authority.taskId} reports a non-Git working directory`,
          );
        }
        return production.newTests.collect(input);
      },
    }),
  });
}

/** What the Pi transport carries into the exact settlement: the accepted transcript's verdict under the Pi evidence policy. */
function piSettlementFacts(
  args: ExactPiSettlementArgs,
  transcript: Extract<ImplementationTranscriptObservation, { kind: "accepted" }>,
  modifiedPaths: readonly string[],
): ExactImplementationTransportFacts {
  return {
    transport: "Pi",
    authority: args.authority,
    observedAt: args.observedAt,
    parserModifiedPaths: modifiedPaths,
    parserPathLabel: "Pi transcript files_modified",
    taskCompleted: true,
    testResult: implementationTestResult(transcript.test),
    testEvidence: transcript.test.evidence.evidence,
    proofEvaluationPolicy: PI_STRUCTURED_EVIDENCE_POLICY,
    ledger: args.ledger,
  };
}

async function applyExactImplementationPiResult(args: ExactPiSettlementArgs): Promise<PiResultOutcome> {
  const taskId = args.authority.taskId;
  const transcript = observeImplementationTranscript(args.result.messages, taskId);
  args.log.push(...transcript.log);
  if (transcript.kind === "malformed") return settleExactPiInfrastructure(args, transcript.failureReason);
  const modified = readImplementationModifiedPaths(args.repository, transcript.resultMessages, taskId);
  if (!modified.ok) return settleExactPiInfrastructure(args, modified.message);
  const settled = await settleAndPersistExactImplementation(
    args.store,
    piSettlementFacts(args, transcript, modified.filesModified),
    piExactSettlementPorts(args),
  );
  return renderExactPiSettlement(taskId, args.log, settled);
}

/** Resolve one Pi implementation result through the exact attempt authority its slot carries. */
export async function applyImplementationPiResult(args: ImplementationPiResultArgs): Promise<PiResultOutcome> {
  const authority = implementationAuthorityOf(args.reservedSlot);
  if (authority === null) return unauthorizedImplementationOutcome(args.store, `${args.agentType} completed`);
  if (await settleCompletedImplementation(args.store, authority)) {
    return outcome([`loom(pi): ${authority.taskId} stopped; retired exact completed/missing reservation`]);
  }
  const observedAt = parseIsoInstant(new Date().toISOString(), "Pi implementation observation instant");
  if (!observedAt.ok) return outcome(observedAt.error.errors, observedAt.error.errors);
  const exactArgs: ExactPiSettlementArgs = { ...args, authority, observedAt: observedAt.value, log: [] };
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.reservedSlot?.taskId ?? null;
  if (returnedTaskId === null || reservedTaskId === null ||
      returnedTaskId !== reservedTaskId || returnedTaskId !== authority.taskId) {
    return settleExactPiInfrastructure(
      exactArgs,
      `Pi result Task identity mismatch: returned=${returnedTaskId ?? "missing"}, ` +
        `reserved=${reservedTaskId ?? "missing"}, authority=${authority.taskId}`,
    );
  }
  return applyExactImplementationPiResult(exactArgs);
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
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): Promise<PiResultOutcome> {
  const slot = args.reservedSlot;
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
  reservedSlot: ReservedSlot | undefined;
  now: string;
  projectBoundary: TaskGraphProjectBoundary;
}>): Promise<PiResultOutcome> {
  const authority = specCheckAuthorityOf(args.reservedSlot);
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
