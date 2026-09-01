/**
 * Apply one finished Pi subagent result through narrow protected-state and
 * repository ports. Phase and spec-check appliers additionally observe their
 * explicitly supplied filesystem artifacts. Parsing and lifecycle decisions
 * remain pure; exported appliers orchestrate observation and persistence.
 *
 * Diagnostics are returned, never written. `extension.ts` owns stderr and the
 * decision about which diagnostics become orchestration processing errors.
 */

import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";
import {
  applyCompletionInfrastructureFailure,
  applyUntrustedStopResolution,
  cumulativeModifiedPaths,
} from "../engine/src/core/implementation-application";
import { extractTestEvidence, testEvidenceOf, type TestEvidence } from "../engine/src/core/test-evidence";
import {
  isPhaseResultEligible,
  observePhaseTransition,
  transitionAuthorityMatches,
  type PhaseTransitionObservation,
} from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  resolveTaskReviewFindings,
  reviewResolutionLog,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import {
  parseSpecCheckOutput,
  reconcileSpecCheck,
  type ParsedSpecCheckOutput,
} from "../engine/src/core/spec-check";
import { waveSpecCheckDocumentsMatch } from "../engine/src/core/wave-review-authority";
import { observeWaveSpecCheckDocuments } from "../engine/src/orchestration/wave-spec-check-documents";
import { reconcileWaveBlock } from "../engine/src/core/wave-gate-model";
import {
  parseSpecArtifactDirectory,
  phaseArtifactUpdates,
} from "../engine/src/core/phase-artifact-paths";
import { agentsOfKind } from "../engine/src/core/model-profiles";
import { PHASES } from "../engine/src/core/phases";
import type {
  Phase,
  TaskGraph,
  WaveReviewEpochAuthority,
  WaveSpecCheckDocumentsAuthority,
  WaveSpecCheckSlotAuthority,
} from "../engine/src/types";
import type { ParsedTaskGraph } from "../engine/src/state-manager";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
  type IsoInstant,
} from "../engine/src/core/implementation-completion";
import {
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
} from "../engine/src/core/implementation-application";
import { PI_STRUCTURED_EVIDENCE_POLICY } from "../engine/src/core/proof-obligations";
import {
  collectNewTestEvidence,
  describeNewTestObservationError,
} from "../engine/src/handlers/helpers/task-local-completion";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
  type ExactImplementationSettlementPorts,
  type ExactNewTestCollectionArgs,
} from "../engine/src/handlers/helpers/exact-implementation-settlement";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import { compareAttemptBaseline } from "../engine/src/utils/artifact-baseline";
import { requiresNewTests, taskVerificationPolicy } from "../engine/src/core/verification-policy";
import {
  messagesToClaudeJsonl,
  parsePiMessages,
  piStructuredTestDiagnostics,
  piStructuredTestResult,
  type PiMessage,
  type PiTranscriptResult,
} from "./transcript-adapter";

const IMPL_AGENTS: ReadonlySet<string> = new Set(agentsOfKind("impl"));
const PHASE_AGENTS: ReadonlySet<string> = new Set(agentsOfKind("phase"));
const REVIEW_AGENTS: ReadonlySet<string> = new Set(agentsOfKind("reviewer"));
const isReviewAgent = (agentType: string): boolean => REVIEW_AGENTS.has(agentType);

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

const outcome = (
  log: readonly string[] = [],
  processingErrors: readonly string[] = [],
): PiResultOutcome => Object.freeze({ processingErrors: Object.freeze(processingErrors), log: Object.freeze(log) });

const processingFailure = (message: string): PiResultOutcome => outcome([message], [message]);

/** One Pi subagent result, in the shape the appliers actually read. */
export type PiSubagentResult = Readonly<{
  agent: string;
  task: string;
  exitCode: number;
  stopReason?: string;
  /** Harness-supplied cause line; absent on pi versions that do not emit it. */
  errorMessage?: unknown;
  messages: unknown;
}>;

/**
 * One element of the harness's `details.results`, parsed rather than asserted.
 *
 * The batch was only ever checked with `Array.isArray` before being cast to
 * `PiSubagentResult[]`, so the required `agent`/`task`/`exitCode` fields were a
 * compile-time promise nothing established: a pi version that renamed or
 * dropped one of them reached `stripNamespace(result.agent)` typed as a
 * guaranteed string. That is the same per-element drift the array-level guard
 * one layer up already treats as a loud no-op, and it gets the same treatment
 * here.
 *
 * A rejected element keeps its INDEX rather than being filtered out: results
 * are positionally bound to reserved slots, so dropping one would silently
 * re-point every later result at the wrong slot.
 */
export type PiSubagentResultEntry =
  | Readonly<{ ok: true; result: PiSubagentResult }>
  | Readonly<{ ok: false; problem: string }>;

/** The errors of the FIRST failed result, or none when all succeeded. */
function firstFailureErrors(
  ...results: readonly PiTranscriptResult<unknown>[]
): readonly string[] {
  for (const result of results) {
    if (!result.ok) return result.errors;
  }
  return [];
}

/**
 * The problem with an optional string field, or `null` when there is none.
 *
 * `null` therefore covers BOTH acceptable states — the field is absent (pi
 * versions differ on `stopReason`) and the field is a string. A non-null return
 * is the offending type name, for the caller's rejection message.
 */
const optionalString = (value: unknown): string | null =>
  value === undefined || typeof value === "string" ? null : `${typeof value}`;

export function parsePiSubagentResults(raw: readonly unknown[]): readonly PiSubagentResultEntry[] {
  return raw.map((entry, index): PiSubagentResultEntry => {
    const reject = (problem: string): PiSubagentResultEntry =>
      Object.freeze({
        ok: false as const,
        problem: `result ${index + 1} has an unrecognized shape (${problem}) — its evidence was not applied`,
      });
    if (entry === null || typeof entry !== "object") return reject(`expected an object, got ${entry === null ? "null" : typeof entry}`);
    const record = entry as Record<string, unknown>;
    if (typeof record.agent !== "string") return reject(`agent is ${typeof record.agent}, expected string`);
    if (typeof record.task !== "string") return reject(`task is ${typeof record.task}, expected string`);
    if (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode)) {
      return reject(`exitCode must be a finite safe integer, got ${String(record.exitCode)}`);
    }
    if (!("messages" in record)) return reject("messages is missing, expected transcript evidence");
    const stopReasonProblem = optionalString(record.stopReason);
    if (stopReasonProblem !== null) return reject(`stopReason is ${stopReasonProblem}, expected string or absent`);
    return Object.freeze({
      ok: true as const,
      result: Object.freeze({
        agent: record.agent,
        task: record.task,
        exitCode: record.exitCode,
        ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason as string }),
        ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
        messages: record.messages,
      }),
    });
  });
}

/** Pi result failure boundary. Missing/malformed exit codes fail closed. */
export function piSubagentResultFailed(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
}): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * A failure that hit EVERY slot at once is consistent with shared
 * infrastructure rather than N independent agent faults — a hypothesis that
 * is invisible from inside any single slot's rejection. Reported once per
 * batch, beside the per-slot diagnostics,
 * so the operator reads the pattern where the symptoms are. `null` below two
 * results or when any slot survived: one slot is not a pattern, and a surviving
 * sibling removes the all-slot failure signature this helper reports. Partial or
 * intermittent shared infrastructure faults remain possible but are not inferred
 * from this batch-level heuristic.
 */
export function piAllSlotsFailedNote(
  results: readonly {
    readonly exitCode?: unknown;
    readonly stopReason?: unknown;
  }[],
): string | null {
  if (results.length < 2 || !results.every((result) => piSubagentResultFailed(result))) return null;
  const stopReasons = [...new Set(results.map(({ stopReason }) =>
    typeof stopReason === "string" ? stopReason : "n/a"))].sort();
  return `all ${results.length} slots in this batch failed (stopReason=${stopReasons.join("|")}) — ` +
    "a shared-infrastructure fault (endpoint, auth, memory) fits that signature better than " +
    "independent agent faults; consider re-spawning serially before treating it as an agent defect";
}

/**
 * The failure signals a diagnostic about a failed result must CARRY.
 *
 * "Exited without a successful result" is true of every failure mode there is:
 * a model-server drop, an OOM, an auth expiry, and an agent that ignored its
 * contract all read identically. Classifying them then costs a hand parse of
 * the parent session JSONL — where these discriminating fields were in scope at
 * the diagnostic site all along.
 *
 * `errorMessage` is typed `unknown` and read defensively rather than declared
 * as a string: it is the harness's own cause line ("Connection error."), the
 * single most diagnostic field when the transport is at fault, and a pi version
 * that stops emitting it must degrade to the exit/stop pair rather than print
 * `undefined`.
 */
export function piSubagentFailureSignals(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}): string {
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : "";
  return [
    `exitCode=${typeof result.exitCode === "number" ? String(result.exitCode) : "n/a"}`,
    `stopReason=${typeof result.stopReason === "string" ? result.stopReason : "n/a"}`,
    ...(errorMessage === "" ? [] : [`errorMessage=${JSON.stringify(errorMessage)}`]),
  ].join(", ");
}

/** The reserved slot this result answers for, when the spawn reserved one. */
export type PiSpecCheckAttemptAuthority = Readonly<{
  runId: WaveReviewEpochAuthority["runId"];
  wave: number;
  batchEpoch: WaveReviewEpochAuthority["batchEpoch"];
  slotId: WaveSpecCheckSlotAuthority["slot_id"];
  attempt: WaveSpecCheckSlotAuthority["attempted"];
}>;

export type PiReviewAttemptAuthority = Readonly<{
  taskId: string;
  agentType: string;
  generation: number;
  packetId: string | null;
  slotId: string | null;
  attempted: 1 | 2 | null;
}>;

function reviewAuthorityForTask(
  task: LoomTask,
  agentType: string,
): PiReviewAttemptAuthority | null {
  const run = task.review_run;
  if (run === undefined) {
    const explicitlyLegacy = task.review_generation === undefined &&
      task.accepted_review_authority === undefined &&
      (task.issued_review_packets?.length ?? 0) === 0;
    return explicitlyLegacy
      ? Object.freeze({
          taskId: task.id,
          agentType,
          generation: 0,
          packetId: null,
          slotId: null,
          attempted: null,
        })
      : null;
  }
  const slot = run.slot_authority?.find((candidate) => candidate.agent === agentType);
  if (slot === undefined) return null;
  return Object.freeze({
    taskId: task.id,
    agentType,
    generation: run.generation,
    packetId: run.packet_id,
    slotId: slot.slot_id,
    attempted: slot.attempted,
  });
}

/** Freeze exact current Task/Review Run authority for a Pi reviewer reservation. */
export function currentPiReviewAuthority(
  state: TaskGraph,
  agentType: string,
  taskId: string,
): PiReviewAttemptAuthority | null {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return task === undefined ? null : reviewAuthorityForTask(task, agentType);
}

/** Explain why failed reviewer evidence cannot mutate this locked Task. */
export function piReviewAuthorityProblem(
  task: LoomTask,
  agentType: string,
  reservedAuthority: PiReviewAttemptAuthority | null | undefined,
): string | null {
  const currentAuthority = reviewAuthorityForTask(task, agentType);
  if (reservedAuthority == null) {
    const explicitlyLegacy = task.review_run === undefined &&
      task.review_generation === undefined &&
      task.accepted_review_authority === undefined &&
      (task.issued_review_packets?.length ?? 0) === 0;
    return explicitlyLegacy
      ? null
      : "reviewer has no exact current or retained review-generation authority";
  }
  return currentAuthority !== null &&
      currentAuthority.taskId === reservedAuthority.taskId &&
      currentAuthority.agentType === reservedAuthority.agentType &&
      currentAuthority.generation === reservedAuthority.generation &&
      currentAuthority.packetId === reservedAuthority.packetId &&
      currentAuthority.slotId === reservedAuthority.slotId &&
      currentAuthority.attempted === reservedAuthority.attempted
    ? null
    : "failed reviewer reservation does not match exact current Task/Review Run slot authority";
}

/** The reserved slot this result answers for, including exact role authority. */
export type ReservedSlot = Readonly<{
  agentType: string;
  taskId: string | null;
  /** Required on every modern implementation reservation; absent/null is legacy compatibility-only. */
  implementationAuthority?: ImplementationAttemptAuthority | null;
  /** Required before failed modern reviewer evidence may mutate the current Review Run. */
  reviewAuthority?: PiReviewAttemptAuthority | null;
  /** Required before a non-run-bound spec-check may mutate protected Wave state. */
  specCheckAuthority?: PiSpecCheckAttemptAuthority | null;
}>;

/** Text of the parent's own tool-call content, the last task-id fallback. */
export type ParentPromptText = string;

const transcriptTextOf = (messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[]): string =>
  messages
    .filter((message) => message.role === "assistant" || message.role === "toolResult")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text ?? ""))
    .join("\n");

// ---------------------------------------------------------------------------
// Failed results
// ---------------------------------------------------------------------------

function reservedAuthorityIsCurrent(
  state: TaskGraph,
  taskId: string,
  reservedSlot: ReservedSlot | undefined,
): boolean {
  const expected = reservedSlot?.implementationAuthority;
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return expected === undefined || expected === null
    ? task?.active_implementation_attempt === undefined
    : task?.active_implementation_attempt?.authorityDigest === expected.authorityDigest;
}

function clearCurrentReservedAuthority(
  state: TaskGraph,
  taskId: string,
  reservedSlot: ReservedSlot | undefined,
): TaskGraph {
  const expected = reservedSlot?.implementationAuthority;
  if (expected == null) return state;
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === taskId && task.active_implementation_attempt?.authorityDigest === expected.authorityDigest
        ? {
            ...task,
            active_implementation_attempt: undefined,
            attempt_artifact_baseline: undefined,
            attempt_repository_baseline: undefined,
            reserved_at: undefined,
          }
        : task),
  };
}

type FailedImplementationArgs = Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
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
  const settled: { value?: ImplementationSettlementApplicationResult } = {};
  await args.store.update((state) => {
    const settlement = settleUnavailableImplementation(state, authority, observedAt.value, args.failure);
    settled.value = settlement;
    return settlement.kind === "error" ? state : settlement.state;
  });
  const settlement = settled.value;
  if (settlement === undefined) {
    const message = `loom(pi): ${args.failure}; exact Oracle settlement produced no transition — current attempt preserved`;
    return processingFailure(message);
  }
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
  let released = false;
  await args.store.update((state) => {
    const task = state.tasks.find((candidate) => candidate.id === binding.taskId);
    if (task?.active_implementation_attempt !== undefined) return state;
    released = true;
    return {
      ...state,
      executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== binding.taskId),
      tasks: state.tasks.map((candidate) => candidate.id === binding.taskId
        ? { ...candidate, reserved_at: undefined, legacy_execution_reservation: undefined }
        : candidate),
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
  const binding = resolveImplementationTaskId({
    agentType: args.agentType,
    reservedTaskId: args.reservedSlot?.taskId,
    reservedAuthority: args.reservedSlot?.implementationAuthority,
    resultPrompt: args.result.task,
    parentPrompt: "",
    executingTasks,
  });
  if (binding.kind === "unbound") {
    const message = `loom(pi): ${args.failure}; ${binding.reason} — completion evidence ignored`;
    return outcome([message], executingTasks.length > 0 ? [message] : []);
  }
  const authority = args.reservedSlot?.implementationAuthority;
  return authority == null
    ? cleanupFailedLegacyImplementation(args, binding)
    : settleFailedExactImplementation(args, binding, authority);
}

type FailedReviewApplication =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "authority-rejected"; problem: string }>
  | Readonly<{ kind: "applied"; task: TaskGraph["tasks"][number] }>;

function reduceFailedReviewResult(
  state: TaskGraph,
  taskId: string,
  agentType: string,
  reviewAuthority: PiReviewAttemptAuthority | null | undefined,
  resolution: ReviewResolution,
): Readonly<{ state: TaskGraph; value: FailedReviewApplication }> {
  const target = state.tasks.find((task) => task.id === taskId);
  if (target === undefined) return { state, value: { kind: "missing" } };
  const authorityProblem = piReviewAuthorityProblem(target, agentType, reviewAuthority);
  if (authorityProblem !== null) {
    return { state, value: { kind: "authority-rejected", problem: authorityProblem } };
  }
  const appliedTask = applyReviewResolution(target, resolution);
  if (appliedTask === target) return { state, value: { kind: "unchanged" } };
  return {
    state: {
      ...state,
      tasks: state.tasks.map((task) => task.id === taskId ? appliedTask : task),
    },
    value: { kind: "applied", task: appliedTask },
  };
}

async function applyFailedReviewResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  failure: string;
}>): Promise<PiResultOutcome> {
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.reservedSlot?.taskId;
  if (reservedTaskId === undefined || reservedTaskId === null) {
    const message = `loom(pi): ${args.failure}; failed reviewer has no reserved Task authority — review evidence NOT stored`;
    return processingFailure(message);
  }
  if (returnedTaskId !== reservedTaskId) {
    const message = `loom(pi): ${args.failure}; returned Task ${returnedTaskId ?? "missing"} does not match ` +
      `reserved Task ${reservedTaskId} — review evidence NOT stored`;
    return processingFailure(message);
  }
  const failedTaskId = reservedTaskId;
  const resolution = { kind: "evidence-failed" as const, agent: args.agentType, message: args.failure };
  const application = await args.store.updateAndReturn((state) =>
    reduceFailedReviewResult(
      state,
      failedTaskId,
      args.agentType,
      args.reservedSlot?.reviewAuthority,
      resolution,
    ));
  switch (application.kind) {
    case "applied":
      return outcome([reviewResolutionLog(failedTaskId, resolution, application.task, true)]);
    case "missing": {
      const message = `loom(pi): ${args.failure}; review task ${failedTaskId} disappeared ` +
        "under the state lock — review evidence NOT stored";
      return processingFailure(message);
    }
    case "unchanged": {
      const message = `loom(pi): ${args.failure}; review task ${failedTaskId} rejected duplicate/stale failure evidence ` +
        "under the state lock — review evidence NOT stored";
      return processingFailure(message);
    }
    case "authority-rejected": {
      const message = `loom(pi): ${args.failure}; review task ${failedTaskId} ${application.problem} ` +
        "under the state lock — review evidence NOT stored";
      return processingFailure(message);
    }
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
export async function applyFailedPiResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  now: string;
}>): Promise<PiResultOutcome> {
  const { store, agentType, result, reservedSlot } = args;
  const failure =
    `${agentType} failed before evidence capture completed (${piSubagentFailureSignals(result)})`;

  if (isReviewAgent(agentType)) {
    return applyFailedReviewResult({ store, agentType, result, reservedSlot, failure });
  }

  if (agentType === "spec-check-invoker") {
    try {
      const observedState = store.load();
      const documents = observeWaveSpecCheckDocuments(observedState.spec_file, observedState.plan_file);
      return store.updateAndReturn((state) =>
        reducePiSpecCheckResult(
          state,
          reservedSlot?.specCheckAuthority,
          { kind: "capture-failed", error: failure },
          documents,
          args.now,
        ));
    } catch (error) {
      const diagnostic = `spec-check document observation failed: ${error instanceof Error ? error.message : String(error)}`;
      return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
    }
  }

  // The dispatcher normally settled a reserved failure through
  // finalizeReservedImplementations first. This idempotent release keeps the
  // applier correct in isolation without overwriting that richer proof.
  if (IMPL_AGENTS.has(agentType)) {
    return applyFailedImplementationResult({ store, agentType, result, reservedSlot, failure, now: args.now });
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

/** Every path a transcript's `write`/`Write` tool calls targeted, in order. */
export function writtenPathsOf(
  messages: readonly { role: string; content?: readonly { type: string; name?: string; arguments?: unknown }[] }[],
): readonly string[] {
  const paths: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "Write")) continue;
      const args = block.arguments as Record<string, unknown> | undefined;
      const path = (args?.path as string | undefined) ??
        (args?.file_path as string | undefined) ??
        (args?.filePath as string | undefined);
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }
  return Object.freeze(paths);
}

type PhaseTransition = Extract<PhaseTransitionObservation["resolution"], { kind: "ready" }>;

type PiPhasePreparation =
  | Readonly<{ kind: "eligible"; state: TaskGraph }>
  | Readonly<{ kind: "mismatch"; state: TaskGraph; relation: "past" | "future" }>;

/** Pure locked-state reducer: stale/future phase results cannot route artifacts or advance. */
function preparePiPhaseResult(
  state: TaskGraph,
  completedPhase: Phase,
  writtenPaths: readonly string[],
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
  const updates = phaseArtifactUpdates(writtenPaths, specDir.value);
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
): TaskGraph {
  if (!isPhaseResultEligible(state.current_phase, completedPhase)) return state;
  const artifactUpdates = phaseArtifactUpdates([transition.artifact], state.spec_dir ?? undefined);
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

function reduceLockedPiPhaseResult(
  locked: TaskGraph,
  args: Readonly<{ agentType: string; completedPhase: Phase; now: string }>,
  writtenPaths: readonly string[],
  observation: PhaseTransitionObservation | null,
): Readonly<{ state: TaskGraph; value: PiResultOutcome }> {
  let prepared: PiPhasePreparation;
  try {
    prepared = preparePiPhaseResult(locked, args.completedPhase, writtenPaths);
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
      state: reducePiPhaseTransition(prepared.state, args.completedPhase, transition, args.now),
      value: outcome(),
    };
  } catch (error) {
    const diagnostic = `phase advancement failed: ${error instanceof Error ? error.message : String(error)}`;
    return { state: prepared.state, value: outcome([`loom: ${diagnostic}`], [diagnostic]) };
  }
}

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
}>): Promise<PiResultOutcome> {
  const parsed = parsePiMessages(args.result.messages);
  if (!parsed.ok) {
    const diagnostic = `${args.agentType} phase artifact extraction failed: ${parsed.errors.join("; ")}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }
  const writtenPaths = writtenPathsOf(parsed.value);
  try {
    const observedState = args.store.load();
    const prepared = preparePiPhaseResult(observedState, args.completedPhase, writtenPaths);
    const observation = prepared.kind === "eligible"
      ? (() => {
          const specDir = parseSpecArtifactDirectory(prepared.state.spec_dir);
          if (!specDir.ok) throw new Error(specDir.message);
          return observePhaseTransition(args.completedPhase, prepared.state, specDir.value);
        })()
      : null;
    return await args.store.updateAndReturn((locked) =>
      reduceLockedPiPhaseResult(locked, args, writtenPaths, observation));
  } catch (error) {
    const diagnostic = `phase state commit failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom: ${diagnostic}`], [diagnostic]);
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
  reservedTaskId: string | null | undefined;
  reservedAuthority?: ImplementationAttemptAuthority | null;
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

type LoomTask = TaskGraph["tasks"][number];

type ImplementationBindingResolution =
  | Readonly<{ kind: "unbound"; outcome: PiResultOutcome }>
  | Readonly<{
      kind: "bound";
      taskId: string;
      log: readonly string[];
      /** Set when the Task was guessed from `executing_tasks`, never named by the result. */
      inference: string | null;
    }>;

type ImplementationTestObservation =
  | Readonly<{ kind: "structured"; evidence: TestEvidence }>
  | Readonly<{ kind: "fallback"; evidence: TestEvidence }>;

type ImplementationTranscriptObservation =
  | Readonly<{ kind: "malformed"; failureReason: string; log: readonly string[] }>
  | Readonly<{
      kind: "accepted";
      resultMessages: readonly PiMessage[];
      test: ImplementationTestObservation;
      log: readonly string[];
    }>;

async function settleCompletedOrMissingImplementation(
  store: TaskGraphStore,
  taskId: string,
  reservedSlot: ReservedSlot | undefined,
): Promise<boolean> {
  let settled = false;
  await store.update((state) => {
    if (!reservedAuthorityIsCurrent(state, taskId, reservedSlot)) return state;
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined && task.status !== "completed") return state;
    settled = true;
    return clearCurrentReservedAuthority({
      ...state,
      executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
    }, taskId, reservedSlot);
  });
  return settled;
}

async function resolveImplementationBindingForResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): Promise<ImplementationBindingResolution> {
  const binding = resolveImplementationTaskId({
    agentType: args.agentType,
    reservedTaskId: args.reservedSlot?.taskId,
    reservedAuthority: args.reservedSlot?.implementationAuthority,
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

function missingStructuredEvidenceLog(taskId: string, messages: unknown): string | null {
  const trace = piStructuredTestDiagnostics(messages);
  if (!trace.ok) return null;
  const summary = trace.value.classifiedCommands.length === 0
    ? "no Bash call was classified as a test run"
    : `verdict=${trace.value.verdict}, classified=[${trace.value.classifiedCommands.join(" | ")}]`;
  return `loom(pi): ${taskId} produced no structured test evidence (${summary}) — transcript fallback used; ` +
    `the wave gate will reject it`;
}

function observeImplementationTranscript(result: PiSubagentResult, taskId: string): ImplementationTranscriptObservation {
  const log: string[] = [];
  const parsedMessages = parsePiMessages(result.messages);
  if (!parsedMessages.ok) {
    return {
      kind: "malformed",
      failureReason: `Pi transcript evidence capture failed: ${parsedMessages.errors.join("; ")}`,
      log,
    };
  }

  const adaptedTranscript = messagesToClaudeJsonl(parsedMessages.value);
  const structuredEvidence = piStructuredTestResult(parsedMessages.value);
  if (structuredEvidence.ok && structuredEvidence.value === null) {
    const structuredLog = missingStructuredEvidenceLog(taskId, result.messages);
    if (structuredLog !== null) log.push(structuredLog);
  }
  if (!adaptedTranscript.ok || !structuredEvidence.ok) {
    const errors = firstFailureErrors(adaptedTranscript, structuredEvidence);
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

function malformedTranscriptResolutionState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  reservedSlot: ReservedSlot | undefined;
  failureReason: string;
  root: string;
  comparisonFailures: string[];
}>): TaskGraph {
  const currentTarget = args.state.tasks.find((candidate) => candidate.id === args.taskId);
  if (!reservedAuthorityIsCurrent(args.state, args.taskId, args.reservedSlot)) return args.state;
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
    newTestsWritten: false,
    newTestEvidence: "",
  }).state, args.taskId, args.reservedSlot);
}

function pendingMalformedTranscriptState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  reservedSlot: ReservedSlot | undefined;
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
  }, args.taskId, args.reservedSlot);
}

async function applyMalformedImplementationTranscript(args: Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  taskId: string;
  reservedSlot: ReservedSlot | undefined;
  failureReason: string;
}>): Promise<readonly string[]> {
  const root = args.repository.root();
  const comparisonFailures: string[] = [];
  await args.store.update((state) => malformedTranscriptResolutionState({
    state,
    taskId: args.taskId,
    reservedSlot: args.reservedSlot,
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
        `${error instanceof Error ? error.message : String(error)} — task left pending`,
    };
  }
}

function implementationTestResult(test: ImplementationTestObservation) {
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
  reservedSlot: ReservedSlot | undefined;
  filesModified: readonly string[];
  test: ImplementationTestObservation;
}>;

type LegacyImplementationQuarantine = Readonly<{
  log: readonly string[];
  processingErrors: readonly string[];
}>;

async function applyLegacyImplementationQuarantine(
  args: LegacyImplementationQuarantineArgs,
): Promise<LegacyImplementationQuarantine> {
  const repository = observeNewTestRepository(args.repository, args.taskId);
  const log: string[] = [];
  const processingErrors: string[] = [];
  const root = args.repository.root();
  let skippedExistingVerdict = false;
  await args.store.update((state) => {
    if (!reservedAuthorityIsCurrent(state, args.taskId, args.reservedSlot)) {
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
        newTestsWritten: false,
        newTestEvidence: "",
      });
      skippedExistingVerdict = applied.skipped;
      return clearCurrentReservedAuthority(applied.state, args.taskId, args.reservedSlot);
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
        args.reservedSlot?.implementationAuthority ?? undefined,
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
    );
    if (!newTestObservation.ok) {
      return quarantineCompletionAuthority(
        `loom(pi): cannot collect new-test evidence for ${args.taskId}: ` +
          describeNewTestObservationError(newTestObservation.error),
      );
    }
    const newTestEvidence = newTestObservation.value;
    const applied = applyUntrustedStopResolution(state, args.taskId, {
      taskCompleted: true,
      testResult,
      testEvidence,
      filesModified: args.filesModified,
      changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
      bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
      newTestsWritten: newTestEvidence.written,
      newTestEvidence: newTestEvidence.evidence,
    });
    skippedExistingVerdict = applied.skipped;
    return clearCurrentReservedAuthority(applied.state, args.taskId, args.reservedSlot);
  });

  if (skippedExistingVerdict) {
    log.push(`loom(pi): ${args.taskId} is completed or missing — leaving task evidence untouched`);
  }
  return { log, processingErrors };
}

type ImplementationPiResultArgs = Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>;

type ResultImplementationBinding = Extract<ImplementationBindingResolution, { kind: "bound" }>;

type ExactPiSettlementArgs = ImplementationPiResultArgs & Readonly<{
  binding: ResultImplementationBinding;
  authority: ImplementationAttemptAuthority;
  observedAt: IsoInstant;
  log: string[];
}>;

type LockedPiSettlement = Readonly<{
  application: ImplementationSettlementApplicationResult;
  infrastructureReason?: string;
}>;

function applicationState(state: TaskGraph, application: ImplementationSettlementApplicationResult): TaskGraph {
  return application.kind === "error" ? state : application.state;
}

function renderExactPiSettlement(
  args: ExactPiSettlementArgs,
  settled: LockedPiSettlement | undefined,
): PiResultOutcome {
  const applied = settled?.application;
  if (applied === undefined) {
    const diagnostic = `loom(pi): exact Oracle settlement produced no transition for ${args.binding.taskId} — current attempt preserved`;
    return outcome([...args.log, diagnostic], [diagnostic]);
  }
  if (applied.kind === "error") {
    const diagnostic = `loom(pi): exact Oracle settlement failed for ${args.binding.taskId}: ${JSON.stringify(applied.error)} — current attempt preserved`;
    return outcome([...args.log, diagnostic], [diagnostic]);
  }
  if (applied.kind === "ignored") {
    return outcome([...args.log, `loom(pi): ${args.binding.taskId} result ignored (${applied.reason})`]);
  }
  const reason = settled?.infrastructureReason;
  const log = [...args.log, `loom(pi): ${args.binding.taskId} settlement: ${applied.transition.kind}`];
  if (applied.transition.kind === "infrastructure-blocked" && reason !== undefined) {
    log.push(`loom(pi): ${reason}`);
  }
  return outcome(log, applied.transition.kind === "infrastructure-blocked" ? [reason ?? "infrastructure unavailable"] : []);
}

async function settleExactPiInfrastructure(
  args: ExactPiSettlementArgs,
  reason: string,
): Promise<PiResultOutcome> {
  const settled: { value?: LockedPiSettlement } = {};
  await args.store.update((state) => {
    const application = settleUnavailableImplementation(state, args.authority, args.observedAt, reason);
    settled.value = { application, infrastructureReason: reason };
    return applicationState(state, application);
  });
  return renderExactPiSettlement(args, settled.value);
}

function piExactSettlementPorts(args: ExactPiSettlementArgs): ExactImplementationSettlementPorts {
  const production = productionExactSettlementPorts(args.repository.root());
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
  const transcript = observeImplementationTranscript(args.result, args.binding.taskId);
  args.log.push(...transcript.log);
  if (transcript.kind === "malformed") return settleExactPiInfrastructure(args, transcript.failureReason);
  const modified = readImplementationModifiedPaths(args.repository, transcript.resultMessages, args.binding.taskId);
  if (!modified.ok) return settleExactPiInfrastructure(args, modified.message);
  const settled: { value?: LockedPiSettlement } = {};
  await args.store.update((state) => {
    const application = settleLockedPiResult(state, args, transcript, modified.filesModified);
    settled.value = application;
    return applicationState(state, application.application);
  });
  return renderExactPiSettlement(args, settled.value);
}

async function applyLegacyImplementationPiResult(
  args: ImplementationPiResultArgs,
  binding: ResultImplementationBinding,
  log: string[],
): Promise<PiResultOutcome> {
  if (await settleCompletedOrMissingImplementation(args.store, binding.taskId, args.reservedSlot)) {
    return outcome([...log, `loom(pi): ${binding.taskId} stopped; preserved completed/missing legacy state`]);
  }
  const transcript = observeImplementationTranscript(args.result, binding.taskId);
  log.push(...transcript.log);
  if (transcript.kind === "malformed") {
    const failures = await applyMalformedImplementationTranscript({ ...args, taskId: binding.taskId, ...transcript });
    return outcome([...log, ...failures], failures);
  }
  const modified = readImplementationModifiedPaths(args.repository, transcript.resultMessages, binding.taskId);
  if (!modified.ok) {
    await args.store.update((state) => applyCompletionInfrastructureFailure(state, binding.taskId, true));
    return outcome([...log, modified.message], [modified.message]);
  }
  const settlement = await applyLegacyImplementationQuarantine({
    ...args,
    taskId: binding.taskId,
    reservedSlot: args.reservedSlot,
    filesModified: modified.filesModified,
    test: transcript.test,
  });
  return outcome([...log, ...settlement.log], settlement.processingErrors);
}

/** Resolve one Pi implementation result through exact modern or cleanup-only legacy authority. */
export async function applyImplementationPiResult(args: ImplementationPiResultArgs): Promise<PiResultOutcome> {
  const binding = await resolveImplementationBindingForResult(args);
  if (binding.kind === "unbound") return binding.outcome;
  const result = await applyBoundImplementationPiResult(args, binding);
  // An inferred attribution is never a clean processing: the result named no
  // Task of its own, so the harness must see the verdict as unproven instead of
  // reading a warning that only ever reached stderr.
  return binding.inference === null
    ? result
    : outcome([...result.log], [...result.processingErrors, `loom(pi): ${binding.inference}`]);
}

async function applyBoundImplementationPiResult(
  args: ImplementationPiResultArgs,
  binding: ResultImplementationBinding,
): Promise<PiResultOutcome> {
  const log = [...binding.log];
  const authority = args.reservedSlot?.implementationAuthority;
  const currentTask = args.store.load().tasks.find((task) => task.id === binding.taskId);
  if (currentTask?.active_implementation_attempt !== undefined && authority == null) {
    const diagnostic = `loom(pi): modern implementation ${binding.taskId} has no exact ReservedSlot authority — current attempt preserved`;
    return outcome([...log, diagnostic], [diagnostic]);
  }
  if (authority == null) return applyLegacyImplementationPiResult(args, binding, log);
  const observedAt = parseIsoInstant(new Date().toISOString(), "Pi implementation observation instant");
  if (!observedAt.ok) return outcome(observedAt.error.errors, observedAt.error.errors);
  const exactArgs = { ...args, binding, authority, observedAt: observedAt.value, log };
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.reservedSlot?.taskId;
  if (returnedTaskId === null || reservedTaskId === null || reservedTaskId === undefined ||
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
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): ReviewTaskBinding {
  const returnedTaskId = extractTaskId(args.result.task);
  const reservedTaskId = args.reservedSlot?.taskId;
  if (reservedTaskId !== undefined && reservedTaskId !== null && returnedTaskId !== reservedTaskId) {
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

type LockedReviewEvidenceApplication =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "authority-rejected"; problem: string }>
  | Readonly<{
      kind: "applied";
      resolution: ReviewResolution;
      task: LoomTask;
      changed: boolean;
    }>;

/** Apply either parsed or malformed reviewer evidence under one locked protocol. */
async function applyLockedReviewEvidence(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewAuthority: PiReviewAttemptAuthority | null | undefined;
  resolutionFor(task: LoomTask): ReviewResolution;
}>): Promise<PiResultOutcome> {
  const result: { application: LockedReviewEvidenceApplication } = {
    application: { kind: "missing" },
  };
  await args.store.update((state) => {
    const task = state.tasks.find((candidate) => candidate.id === args.taskId);
    if (task === undefined) return state;
    const authorityProblem = piReviewAuthorityProblem(task, args.agentType, args.reviewAuthority);
    if (authorityProblem !== null) {
      result.application = { kind: "authority-rejected", problem: authorityProblem };
      return state;
    }
    const resolution = args.resolutionFor(task);
    const appliedTask = applyReviewResolution(task, resolution);
    result.application = {
      kind: "applied",
      resolution,
      task: appliedTask,
      changed: appliedTask !== task,
    };
    return appliedTask === task
      ? state
      : {
          ...state,
          tasks: state.tasks.map((candidate) => candidate.id === args.taskId ? appliedTask : candidate),
        };
  });

  const application = result.application;
  if (application.kind === "missing") {
    const message = `WARNING: ${args.agentType} review task ${args.taskId} disappeared before evidence application — findings NOT stored`;
    return processingFailure(message);
  }
  if (application.kind === "authority-rejected") {
    const message = `WARNING: ${args.agentType} review task ${args.taskId} ${application.problem} — findings NOT stored`;
    return processingFailure(message);
  }
  return outcome([
    reviewResolutionLog(args.taskId, application.resolution, application.task, application.changed),
  ]);
}

async function applyMalformedReviewMessages(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewAuthority: PiReviewAttemptAuthority | null | undefined;
  errors: readonly string[];
}>): Promise<PiResultOutcome> {
  const resolution: ReviewResolution = {
    kind: "evidence-failed",
    agent: args.agentType,
    message: `Pi review messages are malformed: ${args.errors.join("; ")}`,
  };
  return applyLockedReviewEvidence({ ...args, resolutionFor: () => resolution });
}

async function applyParsedReviewMessages(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewAuthority: PiReviewAttemptAuthority | null | undefined;
  messages: readonly PiMessage[];
}>): Promise<PiResultOutcome> {
  const transcriptText = transcriptTextOf(args.messages);
  return applyLockedReviewEvidence({
    ...args,
    resolutionFor: (task) => constrainReviewResolutionToScope(
      resolveTaskReviewFindings(transcriptText, args.agentType, task.review_run, task.review_generation),
      [...(task.file_list ?? []), ...(task.files_modified ?? [])],
    ),
  });
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
  const binding = resolveReviewTaskBinding(args);
  if (binding.kind === "blocked") return binding.outcome;

  const parsedMessages = parsePiMessages(args.result.messages);
  const reviewAuthority = args.reservedSlot?.reviewAuthority;
  if (!parsedMessages.ok) {
    return applyMalformedReviewMessages({ ...args, ...binding, reviewAuthority, errors: parsedMessages.errors });
  }
  return applyParsedReviewMessages({ ...args, ...binding, reviewAuthority, messages: parsedMessages.value });
}

// ---------------------------------------------------------------------------
// Spec-check invoker
// ---------------------------------------------------------------------------

type PiSpecCheckObservation =
  | Readonly<{ kind: "capture-failed"; error: string }>
  | Readonly<{ kind: "parsed"; findings: ParsedSpecCheckOutput }>;

/** Freeze the exact current Wave/spec-check capability for a Pi reservation. */
export function currentPiSpecCheckAuthority(state: TaskGraph): PiSpecCheckAttemptAuthority | null {
  const epoch = state.wave_review_epoch;
  const slot = epoch?.specCheckSlotAuthority;
  if (state.current_phase !== "execute" || epoch === undefined || slot === undefined ||
      state.current_wave !== epoch.wave || state.active_wave_gate?.runId !== epoch.runId ||
      state.active_wave_gate.wave !== epoch.wave) return null;
  return Object.freeze({
    runId: epoch.runId,
    wave: epoch.wave,
    batchEpoch: epoch.batchEpoch,
    slotId: slot.slot_id,
    attempt: slot.attempted,
  });
}

type PiSpecCheckAuthorityDecision =
  | Readonly<{ kind: "accepted"; authority: PiSpecCheckAttemptAuthority }>
  | Readonly<{ kind: "rejected"; problem: string }>;

function decidePiSpecCheckAuthority(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null | undefined,
  documents?: WaveSpecCheckDocumentsAuthority,
): PiSpecCheckAuthorityDecision {
  if (authority == null) {
    return { kind: "rejected", problem: "spec-check result has no exact reserved Wave slot/attempt authority" };
  }
  const current = currentPiSpecCheckAuthority(state);
  if (current === null) {
    return { kind: "rejected", problem: "current TaskGraph has no active exact Wave spec-check authority" };
  }
  if (documents !== undefined &&
      (!waveSpecCheckDocumentsMatch(state.wave_review_epoch?.specCheckDocuments, documents) ||
       state.spec_file !== documents.spec.path || state.plan_file !== documents.plan.path)) {
    return { kind: "rejected", problem: "current spec/plan bytes do not match exact Wave spec-check authority" };
  }
  return current.runId === authority.runId && current.wave === authority.wave &&
      current.batchEpoch === authority.batchEpoch && current.slotId === authority.slotId &&
      current.attempt === authority.attempt
    ? { kind: "accepted", authority }
    : {
        kind: "rejected",
        problem: `reserved spec-check authority ${authority.runId}/${authority.wave}/${authority.slotId}/${authority.attempt} ` +
          `does not match current ${current.runId}/${current.wave}/${current.slotId}/${current.attempt}`,
      };
}

/** Explain why a reserved spec-check capability cannot mutate this snapshot. */
export function piSpecCheckAuthorityProblem(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null | undefined,
): string | null {
  const decision = decidePiSpecCheckAuthority(state, authority);
  return decision.kind === "accepted" ? null : decision.problem;
}

function commitPiSpecCheck(
  state: TaskGraph,
  specCheck: NonNullable<TaskGraph["spec_check"]>,
  value: PiResultOutcome,
): Readonly<{ state: TaskGraph; value: PiResultOutcome }> {
  return {
    state: {
      ...state,
      spec_check: specCheck,
      wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, specCheck, specCheck.wave),
    },
    value,
  };
}

/** Pure spec-check command under exact locked Wave slot authority. */
function reducePiSpecCheckResult(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null | undefined,
  observation: PiSpecCheckObservation,
  documents: WaveSpecCheckDocumentsAuthority,
  now: string,
): Readonly<{ state: TaskGraph; value: PiResultOutcome }> {
  const authorityDecision = decidePiSpecCheckAuthority(state, authority, documents);
  if (authorityDecision.kind === "rejected") {
    const diagnostic = `spec-check evidence rejected: ${authorityDecision.problem}; protected state unchanged`;
    return { state, value: outcome([`loom(pi): ${diagnostic}`], [diagnostic]) };
  }
  const wave = authorityDecision.authority.wave;
  if (observation.kind === "capture-failed") {
    const specCheck = {
      wave,
      run_at: now,
      verdict: "EVIDENCE_CAPTURE_FAILED" as const,
      error: observation.error,
    };
    return commitPiSpecCheck(
      state,
      specCheck,
      outcome([`loom(pi): ${observation.error} — marking spec-check evidence_capture_failed`]),
    );
  }

  const resolution = reconcileSpecCheck(observation.findings, wave, now);
  if (resolution.kind === "evidence-failed") {
    return commitPiSpecCheck(
      state,
      resolution.specCheck,
      outcome([`loom(pi): ${resolution.specCheck.error} — marking spec-check evidence_capture_failed`]),
    );
  }
  return commitPiSpecCheck(state, resolution.specCheck, outcome());
}

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
}>): Promise<PiResultOutcome> {
  const parsedMessages = parsePiMessages(args.result.messages);
  const observation: PiSpecCheckObservation = parsedMessages.ok
    ? { kind: "parsed", findings: parseSpecCheckOutput(transcriptTextOf(parsedMessages.value)) }
    : {
        kind: "capture-failed",
        error: `spec-check-invoker messages are malformed: ${parsedMessages.errors.join("; ")}`,
      };
  try {
    const observedState = args.store.load();
    const documents = observeWaveSpecCheckDocuments(observedState.spec_file, observedState.plan_file);
    return await args.store.updateAndReturn((state) =>
      reducePiSpecCheckResult(state, args.reservedSlot?.specCheckAuthority, observation, documents, args.now));
  } catch (error) {
    const diagnostic = `spec-check state commit failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  }
}
