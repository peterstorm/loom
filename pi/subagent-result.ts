/**
 * What one finished Pi subagent result DOES to protected state.
 *
 * `extension.ts`'s `tool_result` handler used to hold all of this inline: one
 * ~980-line closure that reconciled request authority, advanced phases, resolved
 * implementation evidence, stored review findings, and reconciled spec-checks,
 * with every decision written between the `StateManager` and git calls that
 * carried it out. Nothing in it could be exercised without a live filesystem, a
 * real git repository, and a real State File — including rules as small as
 * "which written path is the spec file", which was an inline
 * `filePath.includes(specDir)` sitting between two `mgr.update(...)` awaits.
 *
 * Here each concern is one named function with explicit parameters and two
 * injected ports — `TaskGraphStore` for protected state, `RepositoryProbe` for
 * git — so a test supplies plain objects instead of a working tree. Every
 * function is a shell orchestrator in the repo's sense: load through the port,
 * decide with pure engine functions, persist through the port. The genuinely
 * pure rules live further in, in `engine/src/core` (see
 * `core/phase-artifact-paths`), shared verbatim with the Claude Code handlers so
 * the two harnesses cannot drift.
 *
 * Diagnostics are RETURNED, never written. `extension.ts` owns stderr and owns
 * which diagnostics become orchestration processing errors; an applier that
 * wrote its own log could not be asserted against without capturing a stream.
 */

import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";
import {
  applyCompletionInfrastructureFailure,
  applyUntrustedStopResolution,
  collectNewTestEvidence,
  cumulativeModifiedPaths,
} from "../engine/src/handlers/subagent-stop/update-task-status";
import { extractTestEvidence, type TestEvidence } from "../engine/src/core/test-evidence";
import { resolveTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  resolveTaskReviewFindings,
  reviewResolutionLog,
  type ReviewResolution,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../engine/src/core/spec-check";
import { reconcileWaveBlock } from "../engine/src/core/wave-gate-model";
import { phaseArtifactUpdates } from "../engine/src/core/phase-artifact-paths";
import { IMPL_AGENTS, PHASE_ORDER, isReviewAgent } from "../engine/src/config";
import type { Phase, TaskGraph } from "../engine/src/types";
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

/**
 * The protected-state seam. `StateManager` satisfies it structurally; a test
 * supplies an in-memory pair. Deliberately narrower than `StateManager` — an
 * applier that needs more than load-and-update is doing something the shell
 * should own.
 */
export type TaskGraphStore = Readonly<{
  load(): TaskGraph;
  update(mutate: (state: TaskGraph) => TaskGraph): Promise<void>;
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
  const failed = results.find((result) => !result.ok);
  return failed === undefined || failed.ok ? [] : failed.errors;
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
    if (typeof record.exitCode !== "number") return reject(`exitCode is ${typeof record.exitCode}, expected number`);
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
 * A failure that hit EVERY slot at once is a shared-infrastructure signature,
 * not N independent agent faults — and it is invisible from inside any single
 * slot's rejection. Reported once per batch, beside the per-slot diagnostics,
 * so the operator reads the pattern where the symptoms are. `null` below two
 * results or when any slot survived: one slot is not a pattern, and a surviving
 * sibling refutes the shared-fault reading outright.
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
export type ReservedSlot = Readonly<{ agentType: string; taskId: string | null }>;

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

async function applyFailedImplementationResult(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  failure: string;
}>): Promise<PiResultOutcome> {
  const executingTasks = args.store.load().executing_tasks ?? [];
  const binding = resolveImplementationTaskId({
    agentType: args.agentType,
    reservedTaskId: args.reservedSlot?.taskId,
    resultPrompt: args.result.task ?? "",
    parentPrompt: "",
    executingTasks,
  });
  if (binding.kind === "unbound") {
    const message = `loom(pi): ${args.failure}; ${binding.reason} — completion evidence ignored`;
    return outcome([message], executingTasks.length > 0 ? [message] : []);
  }
  await args.store.update((state) => ({
    ...state,
    executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== binding.taskId),
  }));
  const inference = binding.inferred ? " (inferred from the sole executing Task)" : "";
  return outcome([
    `loom(pi): ${args.failure} — released ${binding.taskId}${inference}; completion evidence ignored`,
  ]);
}

/**
 * Record the failure of an agent whose process did not succeed.
 *
 * A failed process may retain valid-looking assistant text; none of it is
 * parsed as evidence here. The failure is nonetheless PERSISTED for gate-owned
 * agents, so a healthy sibling or a stale pass cannot make the missing evidence
 * disappear at the wave gate.
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
    const failedTaskId = reservedSlot?.taskId ?? extractTaskId(result.task ?? "");
    if (failedTaskId === null || !store.load().tasks.some((task) => task.id === failedTaskId)) {
      return outcome([`loom(pi): ${failure}; trusted task binding is missing or unknown — review evidence NOT stored`]);
    }
    const resolution = { kind: "evidence-failed" as const, agent: agentType, message: failure };
    await store.update((state) => ({
      ...state,
      tasks: state.tasks.map((task) => task.id === failedTaskId ? applyReviewResolution(task, resolution) : task),
    }));
    return outcome([reviewResolutionLog(failedTaskId, resolution)]);
  }

  if (agentType === "spec-check-invoker") {
    await store.update((state) => ({
      ...state,
      spec_check: {
        wave: state.current_wave ?? 1,
        run_at: args.now,
        verdict: "EVIDENCE_CAPTURE_FAILED" as const,
        error: failure,
      },
    }));
    return outcome([`loom(pi): ${failure} — marking spec-check evidence_capture_failed`]);
  }

  // The dispatcher normally settled a reserved failure through
  // finalizeReservedImplementations first. This idempotent release keeps the
  // applier correct in isolation without overwriting that richer proof.
  if (IMPL_AGENTS.has(agentType)) {
    return applyFailedImplementationResult({ store, agentType, result, reservedSlot, failure });
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
      const path = (args?.path as string | undefined) ?? (args?.file_path as string | undefined);
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }
  return Object.freeze(paths);
}

type PhaseTransition = NonNullable<ReturnType<typeof resolveTransition>>;

async function recordPhaseWrites(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
}>): Promise<PiResultOutcome | null> {
  const parsed = parsePiMessages(args.result.messages);
  if (!parsed.ok) {
    const diagnostic = `${args.agentType} phase artifact extraction failed: ${parsed.errors.join("; ")}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }

  try {
    const updates = phaseArtifactUpdates(writtenPathsOf(parsed.value), args.store.load().spec_dir ?? undefined);
    if (Object.keys(updates).length > 0) await args.store.update((state) => ({ ...state, ...updates }));
    return null;
  } catch (error) {
    const diagnostic =
      `${args.agentType} phase artifact extraction failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }
}

function phaseAlreadyAdvanced(state: TaskGraph, completedPhase: Phase): boolean {
  const currentIdx = PHASE_ORDER.indexOf(state.current_phase);
  const completedIdx = PHASE_ORDER.indexOf(completedPhase);
  return completedIdx >= 0 && currentIdx > completedIdx;
}

async function applyPhaseTransition(args: Readonly<{
  store: TaskGraphStore;
  completedPhase: Phase;
  transition: PhaseTransition;
  now: string;
}>): Promise<PiResultOutcome> {
  const state = args.store.load();
  const artifactUpdates = phaseArtifactUpdates([args.transition.artifact], state.spec_dir ?? undefined);
  try {
    await args.store.update((current) => ({
      ...current,
      current_phase: args.transition.nextPhase,
      phase_artifacts: { ...current.phase_artifacts, [args.completedPhase]: args.transition.artifact },
      ...artifactUpdates,
      skipped_phases: args.transition.skipClarify
        ? [...new Set([...current.skipped_phases, "clarify" as const])]
        : current.skipped_phases,
      updated_at: args.now,
    }));
    return outcome();
  } catch (error) {
    const diagnostic = `phase advancement failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom: ${diagnostic}`], [diagnostic]);
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
  const writesOutcome = await recordPhaseWrites(args);
  if (writesOutcome !== null) return writesOutcome;

  const state = args.store.load();
  if (phaseAlreadyAdvanced(state, args.completedPhase)) return outcome();
  const transition = resolveTransition(args.completedPhase, state);
  return transition ? applyPhaseTransition({ ...args, transition }) : outcome();
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
 * caller (`applyImplementationPiResult`) then clears `executing_tasks` rather
 * than failing tasks, which would cascade into evidence overwrites downstream.
 */
export type ImplementationTaskBinding =
  | Readonly<{ kind: "bound"; taskId: string; inferred: boolean }>
  | Readonly<{ kind: "unbound"; reason: string }>;

export function resolveImplementationTaskId(args: Readonly<{
  agentType: string;
  reservedTaskId: string | null | undefined;
  resultPrompt: string;
  parentPrompt: ParentPromptText;
  executingTasks: readonly string[];
}>): ImplementationTaskBinding {
  const direct = args.reservedTaskId ?? extractTaskId(args.resultPrompt) ?? extractTaskId(args.parentPrompt);
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
  | Readonly<{ kind: "bound"; taskId: string; log: readonly string[] }>;

type ImplementationTranscriptObservation =
  | Readonly<{ kind: "malformed"; failureReason: string; log: readonly string[] }>
  | Readonly<{
      kind: "accepted";
      resultMessages: readonly PiMessage[];
      testEvidence: TestEvidence;
      structuredTestEvidence: TestEvidence | null;
      log: readonly string[];
    }>;

async function clearExecutingTask(store: TaskGraphStore, taskId: string): Promise<void> {
  await store.update((state) => ({
    ...state,
    executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
  }));
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
    resultPrompt: args.result.task ?? "",
    parentPrompt: args.parentPrompt,
    executingTasks: args.store.load().executing_tasks ?? [],
  });
  if (binding.kind === "unbound") {
    await args.store.update((state) => ({ ...state, executing_tasks: [] }));
    return { kind: "unbound", outcome: outcome([binding.reason]) };
  }
  const log = binding.inferred
    ? [`WARNING: ${args.agentType} task ID extraction failed, inferred task ${binding.taskId} from executing_tasks`]
    : [];
  return { kind: "bound", taskId: binding.taskId, log };
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
  const adaptedTranscript = parsedMessages.ok ? messagesToClaudeJsonl(parsedMessages.value) : parsedMessages;
  const structuredEvidence = parsedMessages.ok ? piStructuredTestResult(parsedMessages.value) : parsedMessages;

  if (structuredEvidence.ok && structuredEvidence.value === null) {
    const structuredLog = missingStructuredEvidenceLog(taskId, result.messages);
    if (structuredLog !== null) log.push(structuredLog);
  }
  if (!adaptedTranscript.ok || !structuredEvidence.ok || !parsedMessages.ok) {
    const errors = firstFailureErrors(adaptedTranscript, structuredEvidence);
    return {
      kind: "malformed",
      failureReason: `Pi transcript evidence capture failed: ${errors.join("; ")}`,
      log,
    };
  }

  const transcriptEvidence = extractTestEvidence(parseBashTestOutput(adaptedTranscript.value));
  const structuredTestEvidence = structuredEvidence.value;
  return {
    kind: "accepted",
    resultMessages: parsedMessages.value,
    testEvidence: structuredTestEvidence ?? transcriptEvidence,
    structuredTestEvidence,
    log,
  };
}

function malformedTranscriptResolutionState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  failureReason: string;
  root: string;
  comparisonFailures: string[];
}>): TaskGraph {
  const currentTarget = args.state.tasks.find((candidate) => candidate.id === args.taskId);
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
  return applyUntrustedStopResolution(args.state, args.taskId, {
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
  }).state;
}

function pendingMalformedTranscriptState(args: Readonly<{
  state: TaskGraph;
  taskId: string;
  failureReason: string;
}>): TaskGraph {
  return {
    ...args.state,
    executing_tasks: (args.state.executing_tasks ?? []).filter((id) => id !== args.taskId),
    tasks: args.state.tasks.map((candidate) =>
      candidate.id === args.taskId && candidate.status === "pending"
        ? { ...candidate, failure_reason: args.failureReason }
        : candidate
    ),
  };
}

async function applyMalformedImplementationTranscript(args: Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  taskId: string;
  failureReason: string;
}>): Promise<readonly string[]> {
  const root = args.repository.root();
  const comparisonFailures: string[] = [];
  await args.store.update((state) => malformedTranscriptResolutionState({
    state,
    taskId: args.taskId,
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

function implementationTestResult(
  structuredTestEvidence: TestEvidence | null,
  testEvidence: TestEvidence,
) {
  return structuredTestEvidence !== null
    ? {
        verdict: "untrusted" as const,
        passed: testEvidence.passed,
        label: `pi-structured: ${structuredTestEvidence.evidence || "test tool result"}`,
        provenance: "pi-structured" as const,
      }
    : {
        verdict: "untrusted" as const,
        passed: testEvidence.passed,
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

type AcceptedImplementationResolutionArgs = Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  taskId: string;
  filesModified: readonly string[];
  testEvidence: TestEvidence;
  structuredTestEvidence: TestEvidence | null;
}>;

type AcceptedImplementationResolution = Readonly<{
  log: readonly string[];
  processingErrors: readonly string[];
}>;

async function applyAcceptedImplementationResolution(
  args: AcceptedImplementationResolutionArgs,
): Promise<AcceptedImplementationResolution> {
  const repository = observeNewTestRepository(args.repository, args.taskId);
  const log: string[] = [];
  const processingErrors: string[] = [];
  const root = args.repository.root();
  let skippedExistingVerdict = false;
  await args.store.update((state) => {
    const currentTarget = state.tasks.find((candidate) => candidate.id === args.taskId);
    if (currentTarget === undefined || currentTarget.status === "completed") {
      const applied = applyUntrustedStopResolution(state, args.taskId, {
        taskCompleted: true,
        testResult: implementationTestResult(args.structuredTestEvidence, args.testEvidence),
        testEvidence: args.testEvidence.evidence,
        filesModified: args.filesModified,
        changedDeclaredArtifacts: [],
        bytesChangedSinceAttempt: false,
        newTestsWritten: false,
        newTestEvidence: "",
      });
      skippedExistingVerdict = applied.skipped;
      return applied.state;
    }
    const comparison = compareAttemptBaseline(root, currentTarget, {
      kind: "repository-or-declared",
      extraModifiedPaths: args.filesModified,
    });
    if (comparison.failure !== null) {
      const diagnostic = `loom(pi): cannot compare declared-artifact baseline for ${args.taskId}: ${comparison.failure} — ` +
        `completion evidence was not applied`;
      log.push(diagnostic);
      processingErrors.push(diagnostic);
      return applyCompletionInfrastructureFailure(
        state,
        args.taskId,
        comparison.bytesChangedSinceAttempt,
      );
    }
    const cumulativeFiles = cumulativeModifiedPaths(currentTarget.files_modified, args.filesModified);
    const verificationPolicy = taskVerificationPolicy(currentTarget);
    if (repository.kind === "unavailable" && requiresNewTests(verificationPolicy)) {
      log.push(repository.diagnostic);
      processingErrors.push(repository.diagnostic);
      return applyCompletionInfrastructureFailure(
        state,
        args.taskId,
        comparison.bytesChangedSinceAttempt,
      );
    }
    let newTestEvidence = { written: false, evidence: "" };
    try {
      newTestEvidence = collectNewTestEvidence(
        cumulativeFiles,
        verificationPolicy.newTests,
        currentTarget.start_sha,
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const diagnostic = `loom(pi): cannot collect new-test evidence for ${args.taskId}: ${cause}`;
      log.push(diagnostic);
      processingErrors.push(diagnostic);
      return applyCompletionInfrastructureFailure(
        state,
        args.taskId,
        comparison.bytesChangedSinceAttempt,
      );
    }
    const applied = applyUntrustedStopResolution(state, args.taskId, {
      taskCompleted: true,
      testResult: implementationTestResult(args.structuredTestEvidence, args.testEvidence),
      testEvidence: args.testEvidence.evidence,
      filesModified: args.filesModified,
      changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
      bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
      newTestsWritten: newTestEvidence.written,
      newTestEvidence: newTestEvidence.evidence,
    });
    skippedExistingVerdict = applied.skipped;
    return applied.state;
  });

  if (skippedExistingVerdict) {
    log.push(`loom(pi): ${args.taskId} is completed or missing — leaving task evidence untouched`);
  }
  return { log, processingErrors };
}

/**
 * Resolve one implementation agent's completion into task state.
 *
 * Every state decision runs INSIDE the locked update via the shared pure
 * `applyUntrustedStopResolution`: the pre-lock reads here are a fast path only,
 * and a concurrent writer may outdate them (TOCTOU). The incoming resolution is
 * always untrusted. A completed Task always stands; trusted failures stand
 * unless explicit revalidation is required, and trusted passes stand only
 * while no newer Task bytes were attributed.
 */
export async function applyImplementationPiResult(args: Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): Promise<PiResultOutcome> {
  const binding = await resolveImplementationBindingForResult(args);
  if (binding.kind === "unbound") return binding.outcome;
  const log = [...binding.log];
  const task = args.store.load().tasks.find((candidate) => candidate.id === binding.taskId);

  if (task?.status === "completed") {
    await clearExecutingTask(args.store, binding.taskId);
    log.push(`loom(pi): ${binding.taskId} stopped; preserved completed/missing state and cleared executing_tasks`);
    return outcome(log);
  }

  const transcript = observeImplementationTranscript(args.result, binding.taskId);
  log.push(...transcript.log);
  if (transcript.kind === "malformed") {
    log.push(...await applyMalformedImplementationTranscript({ ...args, taskId: binding.taskId, ...transcript }));
    return outcome(log);
  }

  const modifiedPaths = readImplementationModifiedPaths(args.repository, transcript.resultMessages, binding.taskId);
  if (!modifiedPaths.ok) {
    await args.store.update((state) =>
      applyCompletionInfrastructureFailure(state, binding.taskId, true)
    );
    log.push(modifiedPaths.message);
    return outcome(log, [modifiedPaths.message]);
  }

  const settlement = await applyAcceptedImplementationResolution({
    ...args,
    taskId: binding.taskId,
    filesModified: modifiedPaths.filesModified,
    testEvidence: transcript.testEvidence,
    structuredTestEvidence: transcript.structuredTestEvidence,
  });
  log.push(...settlement.log);
  return outcome(log, settlement.processingErrors);
}

// ---------------------------------------------------------------------------
// Review agents
// ---------------------------------------------------------------------------

type ReviewTaskBinding =
  | Readonly<{ kind: "blocked"; outcome: PiResultOutcome }>
  | Readonly<{ kind: "bound"; taskId: string; reviewTask: LoomTask }>;

function resolveReviewTaskBinding(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): ReviewTaskBinding {
  const taskId = args.reservedSlot?.taskId ?? extractTaskId(args.result.task ?? "") ?? extractTaskId(args.parentPrompt);
  if (!taskId) {
    return {
      kind: "blocked",
      outcome: outcome([`WARNING: ${args.agentType} review completed without an extractable task ID — findings NOT stored`]),
    };
  }

  const reviewTask = args.store.load().tasks.find((task) => task.id === taskId);
  if (!reviewTask) {
    return {
      kind: "blocked",
      outcome: outcome([
        `WARNING: ${args.agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored`,
      ]),
    };
  }
  return { kind: "bound", taskId, reviewTask };
}

async function applyMalformedReviewMessages(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewTask: LoomTask;
  errors: readonly string[];
}>): Promise<PiResultOutcome> {
  const message = `Pi review messages are malformed: ${args.errors.join("; ")}`;
  const resolution = { kind: "evidence-failed" as const, agent: args.agentType, message };
  let appliedTask = args.reviewTask;
  await args.store.update((state) => ({
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== args.taskId) return task;
      appliedTask = applyReviewResolution(task, resolution);
      return appliedTask;
    }),
  }));
  return outcome([reviewResolutionLog(args.taskId, resolution, appliedTask, true)]);
}

async function applyParsedReviewMessages(args: Readonly<{
  store: TaskGraphStore;
  agentType: string;
  taskId: string;
  reviewTask: LoomTask;
  messages: readonly PiMessage[];
}>): Promise<PiResultOutcome> {
  let resolution: ReviewResolution = {
    kind: "evidence-failed",
    agent: args.agentType,
    message: "review task disappeared before evidence could be applied",
  };
  let appliedTask = args.reviewTask;
  let applicationChanged = false;
  let taskFound = false;
  const transcriptText = transcriptTextOf(args.messages);
  await args.store.update((state) => ({
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== args.taskId) return task;
      taskFound = true;
      resolution = constrainReviewResolutionToScope(
        resolveTaskReviewFindings(transcriptText, args.agentType, task.review_run, task.review_generation),
        [...(task.file_list ?? []), ...(task.files_modified ?? [])],
      );
      appliedTask = applyReviewResolution(task, resolution);
      applicationChanged = appliedTask !== task;
      return appliedTask;
    }),
  }));
  if (!taskFound) {
    return outcome([
      `WARNING: ${args.agentType} review task ${args.taskId} disappeared before evidence application — findings NOT stored`,
    ]);
  }
  return outcome([reviewResolutionLog(args.taskId, resolution, appliedTask, applicationChanged)]);
}

/**
 * Store one reviewer's findings against the task it names.
 *
 * Transcript bytes are read outside the lock; packet generation and scope
 * authority are resolved against the current task INSIDE it. The Claude Code
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
  if (!parsedMessages.ok) {
    return applyMalformedReviewMessages({ ...args, ...binding, errors: parsedMessages.errors });
  }
  return applyParsedReviewMessages({ ...args, ...binding, messages: parsedMessages.value });
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
  now: string;
}>): Promise<PiResultOutcome> {
  const { store, result } = args;
  const parsedMessages = parsePiMessages(result.messages);
  if (!parsedMessages.ok) {
    const error = `spec-check-invoker messages are malformed: ${parsedMessages.errors.join("; ")}`;
    await store.update((state) => ({
      ...state,
      spec_check: {
        wave: state.current_wave ?? 1,
        run_at: args.now,
        verdict: "EVIDENCE_CAPTURE_FAILED" as const,
        error,
      },
    }));
    return outcome([`loom(pi): ${error} — marking spec-check evidence_capture_failed`]);
  }

  const findings = parseSpecCheckOutput(transcriptTextOf(parsedMessages.value));
  const wave = findings.wave ?? store.load().current_wave ?? 1;
  const resolution = reconcileSpecCheck(findings, wave, args.now);
  if (resolution.kind === "evidence-failed") {
    await store.update((state) => ({ ...state, spec_check: resolution.specCheck }));
    return outcome([`loom(pi): ${resolution.specCheck.error} — marking spec-check evidence_capture_failed`]);
  }

  await store.update((state) => ({
    ...state,
    spec_check: resolution.specCheck,
    wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, resolution.specCheck, wave),
  }));
  return outcome();
}
