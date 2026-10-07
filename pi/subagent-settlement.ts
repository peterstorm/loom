/**
 * The functional core of Pi subagent settlement: every decision the appliers
 * in `subagent-result.ts` act on, as pure functions over a locked TaskGraph
 * snapshot and already-observed evidence.
 *
 * Each locked reducer has one shape — `(state, input) => LockedReduction<T>`
 * — the exact callback `TaskGraphStore.updateAndReturn` runs under the state
 * lock, so the shell's protocol for every role is the same three steps:
 * observe outside the lock, run one reducer here under it, emit the outcome.
 * Nothing in this module touches the store, the filesystem, Git or stderr.
 */

import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";
import { extractTestEvidence, testEvidenceOf, type TestEvidence } from "../engine/src/core/test-evidence";
import {
  isPhaseResultEligible,
  transitionAuthorityMatches,
  type PhaseTransitionObservation,
} from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  applyReviewResolution,
  reviewResolutionLog,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import { settleSpecCheck, type ParsedSpecCheckOutput } from "../engine/src/core/spec-check";
import { epochSettledFloor } from "../engine/src/core/wave-review-authority";
import {
  SPEC_ARTIFACT_DIR,
  parseSpecArtifactDirectory,
  phaseArtifactUpdates,
} from "../engine/src/core/phase-artifact-paths";
import { PHASES } from "../engine/src/core/phases";
import type { Phase, TaskGraph, WaveSpecCheckDocumentsAuthority } from "../engine/src/types";
import type { ImplementationAttemptAuthority } from "../engine/src/core/implementation-completion";
import type { ImplementationSettlementApplicationResult } from "../engine/src/core/implementation-application";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import {
  messagesToClaudeJsonl,
  parsePiMessages,
  piStructuredTestDiagnostics,
  piStructuredTestResult,
  type PiMessage,
  type PiTranscriptResult,
} from "./transcript-adapter";
import {
  decidePiSpecCheckAuthority,
  piReviewAuthorityProblem,
  type PiReviewAttemptAuthority,
  type PiSpecCheckAttemptAuthority,
} from "./reserved-slot";

type LoomTask = TaskGraph["tasks"][number];

/** The next TaskGraph plus what the reduction decided, as one locked step. */
export type LockedReduction<T> = Readonly<{ state: TaskGraph; value: T }>;

/**
 * What an applier did, as data.
 *
 * `processingErrors` are the failures the caller must report back to Pi as an
 * error response; `log` is everything the operator should see on stderr,
 * already ordered. Splitting them keeps the "is this an orchestration failure?"
 * decision inside the applier that knows, instead of in a caller matching on
 * message text.
 */
export type PiResultOutcome = Readonly<{
  processingErrors: readonly string[];
  log: readonly string[];
}>;

export const outcome = (
  log: readonly string[] = [],
  processingErrors: readonly string[] = [],
): PiResultOutcome => Object.freeze({ processingErrors: Object.freeze(processingErrors), log: Object.freeze(log) });

/** A failure that is both logged and reported to Pi as a processing error. */
export const processingFailure = (message: string): PiResultOutcome => outcome([message], [message]);

/** Text of the parent's own tool-call content, the last task-id fallback. */
export type ParentPromptText = string;

/** The assistant and tool-result text a reviewer or spec-check transcript carries, in order. */
export const transcriptTextOf = (messages: readonly PiMessage[]): string =>
  messages
    .filter((message) => message.role === "assistant" || message.role === "toolResult")
    .flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []))
    .join("\n");

/** The errors of the FIRST failed result, or none when all succeeded. */
function firstFailureErrors(
  ...results: readonly PiTranscriptResult<unknown>[]
): readonly string[] {
  for (const result of results) {
    if (!result.ok) return result.errors;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Phase agents
// ---------------------------------------------------------------------------

type PhaseTransition = Extract<PhaseTransitionObservation["resolution"], { kind: "ready" }>;

export type PiPhasePreparation =
  | Readonly<{ kind: "eligible"; state: TaskGraph }>
  | Readonly<{ kind: "mismatch"; state: TaskGraph; relation: "past" | "future" }>;

/** Stale/future phase results cannot route artifacts or advance. Throws on a corrupt `spec_dir`. */
export function preparePiPhaseResult(
  state: TaskGraph,
  completedPhase: Phase,
  writtenPaths: readonly string[],
  phaseArtifactBaseDir: string,
): PiPhasePreparation {
  if (!isPhaseResultEligible(state.current_phase, completedPhase)) {
    const currentIndex = PHASES.indexOf(state.current_phase);
    const completedIndex = PHASES.indexOf(completedPhase);
    return Object.freeze({
      kind: "mismatch",
      state,
      relation: currentIndex > completedIndex ? "past" : "future",
    });
  }
  const specDir = parseSpecArtifactDirectory(state.spec_dir);
  if (!specDir.ok) throw new Error(specDir.message);
  const updates = phaseArtifactUpdates(writtenPaths, specDir.value, phaseArtifactBaseDir);
  return Object.freeze({
    kind: "eligible",
    state: Object.keys(updates).length === 0 ? state : { ...state, ...updates },
  });
}

/** Pure phase command: rechecks exact eligibility before applying a transition. */
function reducePiPhaseTransition(
  state: TaskGraph,
  completedPhase: Phase,
  transition: PhaseTransition,
  now: string,
  phaseArtifactBaseDir: string,
): TaskGraph {
  if (!isPhaseResultEligible(state.current_phase, completedPhase)) return state;
  const artifactUpdates = phaseArtifactUpdates(
    [transition.artifact],
    // A null spec_dir keeps the shared default root — the exact value the
    // retired parameter default supplied.
    state.spec_dir ?? SPEC_ARTIFACT_DIR,
    phaseArtifactBaseDir,
  );
  return {
    ...state,
    current_phase: transition.nextPhase,
    phase_artifacts: { ...state.phase_artifacts, [completedPhase]: transition.artifact },
    ...artifactUpdates,
    skipped_phases: transition.skipClarify
      ? [...new Set([...state.skipped_phases, "clarify" as const])]
      : state.skipped_phases,
    updated_at: now,
  };
}

function phaseMismatchOutcome(
  prepared: Extract<PiPhasePreparation, { kind: "mismatch" }>,
  agentType: string,
  completedPhase: Phase,
): PiResultOutcome {
  const diagnostic = prepared.relation === "past"
    ? `Phase ${completedPhase} is already past (current: ${prepared.state.current_phase}); stale result ignored`
    : `${agentType} result cannot advance current Phase ${prepared.state.current_phase}; exact Phase authority required`;
  return outcome(
    [`loom(pi): ${diagnostic}`],
    prepared.relation === "future" ? [diagnostic] : [],
  );
}

/** The locked phase settlement: re-prepare against the locked graph, then apply only an unchanged, ready observation. */
export function reduceLockedPiPhaseResult(
  locked: TaskGraph,
  args: Readonly<{
    agentType: string;
    completedPhase: Phase;
    now: string;
    phaseArtifactBaseDir: string;
  }>,
  writtenPaths: readonly string[],
  observation: PhaseTransitionObservation | null,
): LockedReduction<PiResultOutcome> {
  let prepared: PiPhasePreparation;
  try {
    prepared = preparePiPhaseResult(
      locked,
      args.completedPhase,
      writtenPaths,
      args.phaseArtifactBaseDir,
    );
  } catch (error) {
    const diagnostic = `${args.agentType} phase artifact extraction failed: ` +
      `${error instanceof Error ? error.message : String(error)}`;
    return {
      state: locked,
      value: outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]),
    };
  }
  if (prepared.kind === "mismatch") {
    return {
      state: prepared.state,
      value: phaseMismatchOutcome(prepared, args.agentType, args.completedPhase),
    };
  }
  try {
    if (observation === null || !transitionAuthorityMatches(prepared.state, observation.authority)) {
      const diagnostic = `${args.agentType} phase artifact authority changed after filesystem observation`;
      return {
        state: locked,
        value: outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]),
      };
    }
    const transition = observation.resolution;
    if (transition.kind === "not-ready") {
      const diagnostic = `${args.agentType} completed but phase transition is not ready: ${transition.reason}`;
      return {
        state: prepared.state,
        value: outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]),
      };
    }
    return {
      state: reducePiPhaseTransition(
        prepared.state,
        args.completedPhase,
        transition,
        args.now,
        args.phaseArtifactBaseDir,
      ),
      value: outcome(),
    };
  } catch (error) {
    const diagnostic = `phase advancement failed: ${error instanceof Error ? error.message : String(error)}`;
    return { state: prepared.state, value: outcome([`loom: ${diagnostic}`], [diagnostic]) };
  }
}

// ---------------------------------------------------------------------------
// Implementation agents
// ---------------------------------------------------------------------------

/**
 * Which task an implementation result belongs to, or why it cannot be told.
 *
 * Pure: the reservation, the two prompt texts, and the currently-executing set
 * are all the inputs, and the answer is the only output — this function mutates
 * nothing. An unextractable id must not vanish silently: exactly one executing
 * task infers it, while ambiguous or empty is reported as `unbound`. The
 * caller (`applyImplementationPiResult`) reports an unbound failure and keeps
 * execution authority: without attribution it cannot safely release one Task.
 * Exact Oracle settlement releases matching modern authority for every proven
 * terminal transition, while compatibility settlement releases only a proven
 * legacy reservation; both ordinary terminal paths and completed/missing
 * cleanup therefore release the reservation they can identify.
 */
export type ImplementationTaskBinding =
  | Readonly<{ kind: "bound"; taskId: string; inferred: boolean }>
  | Readonly<{ kind: "unbound"; reason: string }>;

export function resolveImplementationTaskId(args: Readonly<{
  agentType: string;
  reservedTaskId: string | null;
  reservedAuthority: ImplementationAttemptAuthority | null;
  resultPrompt: string;
  parentPrompt: ParentPromptText;
  executingTasks: readonly string[];
}>): ImplementationTaskBinding {
  const direct = args.reservedAuthority?.taskId ?? args.reservedTaskId ??
    extractTaskId(args.resultPrompt) ?? extractTaskId(args.parentPrompt);
  if (direct) return Object.freeze({ kind: "bound" as const, taskId: direct, inferred: false });
  const executing = args.executingTasks;
  if (executing.length === 1) {
    return Object.freeze({ kind: "bound" as const, taskId: executing[0]!, inferred: true });
  }
  return Object.freeze({
    kind: "unbound" as const,
    reason: executing.length > 0
      ? `WARNING: ${args.agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)`
      : `WARNING: ${args.agentType} completed without task ID and executing_tasks is empty — task status was NOT recorded`,
  });
}

/**
 * Whether the reserved implementation authority is still the Task's current
 * attempt: an exact digest match for a modern reservation, and "no modern
 * attempt exists" for a legacy one (`expected === null`).
 */
export function reservedAuthorityIsCurrent(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority | null,
): boolean {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return expected === null
    ? task?.active_implementation_attempt === undefined
    : task?.active_implementation_attempt?.authorityDigest === expected.authorityDigest;
}

/** Release the Task's attempt state, only when it still carries exactly the reserved authority. */
export function clearCurrentReservedAuthority(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority | null,
): TaskGraph {
  if (expected === null) return state;
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId && task.active_implementation_attempt?.authorityDigest === expected.authorityDigest
        ? {
            ...task,
            active_implementation_attempt: undefined,
            active_implementation_context: undefined,
            attempt_artifact_baseline: undefined,
            attempt_repository_baseline: undefined,
            reserved_at: undefined,
          }
        : task),
  };
}

/**
 * Retire a reservation whose Task is already completed or gone. Takes only the
 * slot's implementation authority (`null`: a legacy reservation holding none).
 */
export function retireCompletedOrMissingImplementation(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority | null,
): Readonly<{ state: TaskGraph; retired: boolean }> {
  if (!reservedAuthorityIsCurrent(state, taskId, expected)) return { state, retired: false };
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task !== undefined && task.status !== "completed") return { state, retired: false };
  const cleared = clearCurrentReservedAuthority({
    ...state,
    executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
  }, taskId, expected);
  return {
    state: {
      ...cleared,
      tasks: cleared.tasks.map((candidate) =>
        candidate.id === taskId && candidate.status === "completed"
          ? {
              ...candidate,
              repository_baseline: undefined,
              unresolved_repository_paths: undefined,
            }
          : candidate),
    },
    retired: true,
  };
}

/** A malformed transcript with no byte change: release the attempt and record why the Task stays pending. */
export function pendingMalformedTranscriptState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  expected: ImplementationAttemptAuthority | null;
  failureReason: string;
}>): TaskGraph {
  return clearCurrentReservedAuthority({
    ...args.state,
    executing_tasks: (args.state.executing_tasks ?? []).filter((id) => id !== args.taskId),
    tasks: args.state.tasks.map((candidate) =>
      candidate.id === args.taskId && candidate.status === "pending"
        ? { ...candidate, failure_reason: args.failureReason }
        : candidate
    ),
  }, args.taskId, args.expected);
}

export type ImplementationTestObservation =
  | Readonly<{ kind: "structured"; evidence: TestEvidence }>
  | Readonly<{ kind: "fallback"; evidence: TestEvidence }>;

export type ImplementationTranscriptObservation =
  | Readonly<{ kind: "malformed"; failureReason: string; log: readonly string[] }>
  | Readonly<{
      kind: "accepted";
      resultMessages: readonly PiMessage[];
      test: ImplementationTestObservation;
      log: readonly string[];
    }>;

function missingStructuredEvidenceLog(taskId: string, messages: unknown):
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; errors: readonly string[] }> {
  const trace = piStructuredTestDiagnostics(messages);
  if (!trace.ok) return trace;
  const summary = trace.value.classifiedCommands.length === 0
    ? "no Bash call was classified as a test run"
    : `verdict=${trace.value.verdict}, classified=[${trace.value.classifiedCommands.join(" | ")}]`;
  return {
    ok: true,
    value: `loom(pi): ${taskId} produced no structured test evidence (${summary}) — transcript fallback used; ` +
      `the wave gate will reject it`,
  };
}

/** Parse an implementation transcript into accepted test evidence, or the reason it is malformed. */
export function observeImplementationTranscript(messages: unknown, taskId: string): ImplementationTranscriptObservation {
  const log: string[] = [];
  const parsedMessages = parsePiMessages(messages);
  if (!parsedMessages.ok) {
    return {
      kind: "malformed",
      failureReason: `Pi transcript evidence capture failed: ${parsedMessages.errors.join("; ")}`,
      log,
    };
  }

  const adaptedTranscript = messagesToClaudeJsonl(parsedMessages.value);
  const structuredEvidence = piStructuredTestResult(parsedMessages.value);
  const diagnostics = structuredEvidence.ok && structuredEvidence.value === null
    ? missingStructuredEvidenceLog(taskId, messages)
    : null;
  if (diagnostics?.ok) log.push(diagnostics.value);
  if (!adaptedTranscript.ok || !structuredEvidence.ok || diagnostics?.ok === false) {
    const errors = firstFailureErrors(
      adaptedTranscript,
      structuredEvidence,
      ...(diagnostics === null ? [] : [diagnostics]),
    );
    return {
      kind: "malformed",
      failureReason: `Pi transcript evidence capture failed: ${errors.join("; ")}`,
      log,
    };
  }

  const transcriptEvidence = extractTestEvidence(parseBashTestOutput(adaptedTranscript.value));
  const test: ImplementationTestObservation = structuredEvidence.value === null
    ? { kind: "fallback", evidence: transcriptEvidence }
    : {
        kind: "structured",
        evidence: testEvidenceOf(structuredEvidence.value.passed, structuredEvidence.value.evidence),
      };
  return {
    kind: "accepted",
    resultMessages: parsedMessages.value,
    test,
    log,
  };
}

/** The untrusted test result an implementation observation contributes, labelled by provenance. */
export function implementationTestResult(test: ImplementationTestObservation) {
  const { evidence } = test;
  return test.kind === "structured"
    ? {
        verdict: "untrusted" as const,
        passed: evidence.passed,
        label: `pi-structured: ${evidence.evidence || "test tool result"}`,
        provenance: "pi-structured" as const,
      }
    : {
        verdict: "untrusted" as const,
        passed: evidence.passed,
        label: "transcript-regex (fallback)",
        provenance: "unverified" as const,
      };
}

export function applicationState(state: TaskGraph, application: ImplementationSettlementApplicationResult): TaskGraph {
  return application.kind === "error" ? state : application.state;
}

/** An exact settlement application, plus the infrastructure reason when the shell settled one. */
export type LockedPiSettlement = Readonly<{
  application: ImplementationSettlementApplicationResult;
  infrastructureReason?: string;
}>;

/** Render an exact Oracle settlement for a bound Task into the applier's outcome. */
export function renderExactPiSettlement(
  taskId: string,
  priorLog: readonly string[],
  settled: LockedPiSettlement,
): PiResultOutcome {
  const applied = settled.application;
  if (applied.kind === "error") {
    const diagnostic = `loom(pi): exact Oracle settlement failed for ${taskId}: ${JSON.stringify(applied.error)} — current attempt preserved`;
    return outcome([...priorLog, diagnostic], [diagnostic]);
  }
  if (applied.kind === "ignored") {
    return outcome([...priorLog, `loom(pi): ${taskId} result ignored (${applied.reason})`]);
  }
  const reason = settled.infrastructureReason;
  const log = [...priorLog, `loom(pi): ${taskId} settlement: ${applied.transition.kind}`];
  if (applied.transition.kind === "infrastructure-blocked" && reason !== undefined) {
    log.push(`loom(pi): ${reason}`);
  }
  return outcome(log, applied.transition.kind === "infrastructure-blocked" ? [reason ?? "infrastructure unavailable"] : []);
}

// ---------------------------------------------------------------------------
// Review agents
// ---------------------------------------------------------------------------

export type LockedReviewEvidenceApplication =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "authority-rejected"; problem: string }>
  | Readonly<{
      kind: "applied";
      resolution: ReviewResolution;
      task: LoomTask;
      changed: boolean;
    }>;

/**
 * The pure locked-review application shared by EVERY reviewer evidence path —
 * parsed findings, malformed transcripts, and failed results alike. Authority
 * validation and resolution derivation stay inside one reducer so the callers
 * cannot drift: it derives the resolution under the lock and applies it;
 * `changed: false` folds the failed path's former "unchanged" arm into the same
 * "applied" shape for its caller to interpret.
 */
export function reduceLockedReviewEvidence(
  state: TaskGraph,
  args: Readonly<{
    agentType: string;
    taskId: string;
    reviewAuthority: PiReviewAttemptAuthority | null;
    resolutionFor(task: LoomTask): ReviewResolution;
  }>,
): LockedReduction<LockedReviewEvidenceApplication> {
  const task = state.tasks.find((candidate) => candidate.id === args.taskId);
  if (task === undefined) return { state, value: { kind: "missing" } };
  const authorityProblem = piReviewAuthorityProblem(task, args.agentType, args.reviewAuthority);
  if (authorityProblem !== null) {
    return { state, value: { kind: "authority-rejected", problem: authorityProblem } };
  }
  const resolution = args.resolutionFor(task);
  const appliedTask = applyReviewResolution(task, resolution);
  return {
    state: appliedTask === task
      ? state
      : {
          ...state,
          tasks: state.tasks.map((candidate) => candidate.id === args.taskId ? appliedTask : candidate),
        },
    value: {
      kind: "applied",
      resolution,
      task: appliedTask,
      changed: appliedTask !== task,
    },
  };
}

/** Render a parsed or malformed reviewer evidence application for a bound review Task. */
export function renderReviewEvidence(
  agentType: string,
  taskId: string,
  application: LockedReviewEvidenceApplication,
): PiResultOutcome {
  switch (application.kind) {
    case "missing":
      return processingFailure(
        `WARNING: ${agentType} review task ${taskId} disappeared before evidence application — findings NOT stored`,
      );
    case "authority-rejected":
      return processingFailure(`WARNING: ${agentType} review task ${taskId} ${application.problem} — findings NOT stored`);
    case "applied":
      return outcome([reviewResolutionLog(taskId, application.resolution, application.task, application.changed)]);
  }
}

/** Render a FAILED reviewer's evidence application: an unchanged Task means the failure was not stored. */
export function renderFailedReviewEvidence(
  failure: string,
  taskId: string,
  application: LockedReviewEvidenceApplication,
): PiResultOutcome {
  switch (application.kind) {
    case "applied":
      // `changed: false` is the shared reducer's folded "unchanged" arm: the
      // task already rejected this failure evidence, so storing nothing is a
      // processing failure, not a clean log line.
      return application.changed
        ? outcome([reviewResolutionLog(taskId, application.resolution, application.task, true)])
        : processingFailure(
            `loom(pi): ${failure}; review task ${taskId} rejected duplicate/stale failure evidence ` +
              "under the state lock — review evidence NOT stored",
          );
    case "missing":
      return processingFailure(
        `loom(pi): ${failure}; review task ${taskId} disappeared under the state lock — review evidence NOT stored`,
      );
    case "authority-rejected":
      return processingFailure(
        `loom(pi): ${failure}; review task ${taskId} ${application.problem} under the state lock — review evidence NOT stored`,
      );
  }
}

// ---------------------------------------------------------------------------
// Spec-check invoker
// ---------------------------------------------------------------------------

export type PiSpecCheckObservation =
  | Readonly<{ kind: "capture-failed"; error: string }>
  | Readonly<{ kind: "parsed"; findings: ParsedSpecCheckOutput }>;

/** Pure spec-check authority adapter around the shared aggregate command. */
export function reducePiSpecCheckResult(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null,
  observation: PiSpecCheckObservation,
  documents: WaveSpecCheckDocumentsAuthority,
  now: string,
): LockedReduction<PiResultOutcome> {
  const authorityDecision = decidePiSpecCheckAuthority(state, authority, documents);
  if (authorityDecision.kind === "rejected") {
    const diagnostic = `spec-check evidence rejected: ${authorityDecision.problem}; protected state unchanged`;
    return { state, value: outcome([`loom(pi): ${diagnostic}`], [diagnostic]) };
  }
  const wave = authorityDecision.authority.wave;
  const settlement = observation.kind === "capture-failed"
    ? settleSpecCheck(state, { kind: "capture-failure", wave, runAt: now, error: observation.error })
    : settleSpecCheck(state, {
        kind: "registered-transcript",
        parsed: observation.findings,
        wave,
        runAt: now,
        floor: epochSettledFloor(state.wave_review_epoch),
      });
  const value = settlement.specCheck.verdict === "EVIDENCE_CAPTURE_FAILED"
    ? outcome([`loom(pi): ${settlement.specCheck.error} — marking spec-check evidence_capture_failed`])
    : outcome();
  return { state: settlement.state, value };
}
