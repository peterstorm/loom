/**
 * The functional core of Pi subagent settlement: every decision the appliers
 * in `subagent-result.ts` act on, as pure functions over a locked TaskGraph
 * snapshot and already-observed evidence.
 *
 * Each locked reducer has one shape — `(state, input) => LockedReduction<T>`
 * — the exact callback `TaskGraphStore.updateAndReturn` runs under the state
 * lock, so the shell's protocol for every role is the same three steps:
 * observe outside the lock, run one reducer here under it, emit the outcome.
 * Nothing in this module touches the store, the filesystem, Git or stderr;
 * the one ledger read (`piImplementationLedger`) goes through the registry
 * port its caller injects.
 */

import type { TestEvidence } from "../engine/src/core/test-evidence";
import type { ResolvedTestEvidence } from "../engine/src/core/implementation-evidence";
import { match } from "ts-pattern";
import {
  decidePhaseResult,
  isPhaseResultEligible,
  notReadyDiagnostic,
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
import {
  describeSettlement,
  type ImplementationSettlementApplicationResult,
} from "../engine/src/core/implementation-application";
import type { LedgerObservation } from "../engine/src/core/red-then-green-types";
import { parseAgentType, type SessionId, type SessionRegistry } from "../engine/src/machine";
import { piChildEvidence } from "./evidence-recorder";
import {
  parsePiMessages,
  piStructuredTestDiagnostics,
  piStructuredTestResult,
  piTranscriptToolCalls,
  piWriteTargets,
  type PiMessage,
  type PiTranscriptToolCall,
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

/** Text of the parent's own tool-call content, a reviewer's last task-id fallback. */
export type ParentPromptText = string;

/** The assistant and tool-result text a reviewer or spec-check transcript carries, in order. */
export const transcriptTextOf = (messages: readonly PiMessage[]): string =>
  messages
    .filter((message) => message.role === "assistant" || message.role === "toolResult")
    .flatMap((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []))
    .join("\n");

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
    const decision = decidePhaseResult(observation.resolution);
    if (decision.kind !== "advance") {
      const value = match(decision)
        .with({ kind: "refuse" }, ({ reason }) => {
          const diagnostic = notReadyDiagnostic(args.agentType, reason);
          return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
        })
        .with({ kind: "note" }, ({ reason }) => outcome([`loom(pi): ${reason}`]))
        .exhaustive();
      return { state: prepared.state, value };
    }
    return {
      state: reducePiPhaseTransition(
        prepared.state,
        args.completedPhase,
        decision.transition,
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

/** Whether the reserved implementation authority is still the Task's current attempt (exact digest match). */
export function reservedAuthorityIsCurrent(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority,
): boolean {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return task?.active_implementation_attempt?.authorityDigest === expected.authorityDigest;
}

/** Release the Task's attempt state, only when it still carries exactly the reserved authority. */
export function clearCurrentReservedAuthority(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority,
): TaskGraph {
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
 * Retire a reservation whose Task is already completed, under the slot's exact
 * authority: release the attempt and executing membership, and drop the
 * completed Task's repository baseline.
 */
export function retireCompletedImplementation(
  state: TaskGraph,
  taskId: string,
  expected: ImplementationAttemptAuthority,
): Readonly<{ state: TaskGraph; retired: boolean }> {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task?.status !== "completed" || !reservedAuthorityIsCurrent(state, taskId, expected)) {
    return { state, retired: false };
  }
  const cleared = clearCurrentReservedAuthority({
    ...state,
    executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
  }, taskId, expected);
  return {
    state: {
      ...cleared,
      tasks: cleared.tasks.map((candidate) =>
        candidate.id === taskId ? { ...candidate, repository_baseline: undefined } : candidate),
    },
    retired: true,
  };
}

/**
 * What an implementation transcript proves about its tests: a structured
 * verdict from a paired, attributable test run, or nothing. There is no
 * third, weaker reading: transcript text that merely looks like a runner
 * summary is not evidence, so a transcript without a structured verdict
 * records no test result and the regression proof fails as
 * `test-result-missing`.
 */
export type ImplementationTestObservation =
  | Readonly<{ kind: "structured"; evidence: TestEvidence }>
  | Readonly<{ kind: "missing" }>;

export type ImplementationTranscriptObservation =
  | Readonly<{ kind: "malformed"; failureReason: string; log: readonly string[] }>
  | Readonly<{
      kind: "accepted";
      /** Every path the transcript's file-tool calls targeted (`piWriteTargets`). */
      writeTargets: readonly string[];
      test: ImplementationTestObservation;
      log: readonly string[];
    }>;

function missingStructuredEvidenceLog(taskId: string, calls: readonly PiTranscriptToolCall[]): string {
  const trace = piStructuredTestDiagnostics(calls);
  const summary = trace.classifiedCommands.length === 0
    ? "no Bash call was classified as a test run"
    : `verdict=${trace.verdict}, classified=[${trace.classifiedCommands.join(" | ")}]`;
  return `loom(pi): ${taskId} produced no structured test evidence (${summary}) — no test result recorded ` +
    `(test-result-missing); the wave gate will reject it`;
}

/**
 * Parse an implementation transcript once and fold its projected tool calls
 * into the write targets and test evidence settlement reads, or name why it is
 * malformed. `cwd` is the directory its relative paths are read against.
 */
export function observeImplementationTranscript(
  messages: unknown,
  taskId: string,
  cwd: string,
): ImplementationTranscriptObservation {
  const parsedMessages = parsePiMessages(messages);
  if (!parsedMessages.ok) {
    return {
      kind: "malformed",
      failureReason: `Pi transcript evidence capture failed: ${parsedMessages.errors.join("; ")}`,
      log: [],
    };
  }
  const calls = piTranscriptToolCalls(parsedMessages.value, cwd);
  const structured = piStructuredTestResult(calls);
  return {
    kind: "accepted",
    writeTargets: piWriteTargets(calls),
    test: structured === null ? { kind: "missing" } : { kind: "structured", evidence: structured },
    log: structured === null ? [missingStructuredEvidenceLog(taskId, calls)] : [],
  };
}

/** The untrusted, provenance-labelled test result an implementation
 *  observation contributes, or `null` when it proves none. */
export function implementationTestResult(test: ImplementationTestObservation): ResolvedTestEvidence | null {
  return match(test)
    .with({ kind: "structured" }, ({ evidence }): ResolvedTestEvidence => ({
      result: {
        verdict: "untrusted",
        passed: evidence.passed,
        label: `pi-structured: ${evidence.evidence || "test tool result"}`,
        provenance: "pi-structured",
      },
      evidence: evidence.evidence,
    }))
    .with({ kind: "missing" }, () => null)
    .exhaustive();
}

/**
 * The Pi implementation child's attempt epoch, as exact settlement judges it
 * (I6, FR-035): the parent session's ledger read back under the epoch of the
 * child's parent-issued write grant (`piChildEvidence`). Every missing input
 * is a named `unreadable` observation, never an empty epoch, so settlement
 * records infrastructure rather than a red-then-green gap the child never
 * had a chance to close. The one read goes through the injected registry.
 */
export function piImplementationLedger(
  parentSession: SessionId | null,
  grantToken: string | null,
  agentType: string,
  registry: Pick<SessionRegistry, "readEvidence">,
): LedgerObservation {
  if (parentSession === null) {
    return Object.freeze({ kind: "unreadable", reason: "the batch names no parent session, so no child ledger epoch was read" });
  }
  if (grantToken === null) {
    return Object.freeze({ kind: "unreadable", reason: "the reserved slot holds no write grant, so the child recorded no ledger epoch" });
  }
  const parsedAgentType = parseAgentType(agentType);
  if (parsedAgentType === null) {
    return Object.freeze({ kind: "unreadable", reason: `agent type ${JSON.stringify(agentType)} names no ledger epoch` });
  }
  return piChildEvidence(parentSession, grantToken, parsedAgentType, registry);
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
  const log = [...priorLog, `loom(pi): ${taskId} settlement: ${describeSettlement(applied.transition)}`];
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
