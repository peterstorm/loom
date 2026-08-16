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
  applyUntrustedStopResolution,
  collectNewTestEvidence,
  cumulativeModifiedPaths,
  extractTestEvidence,
} from "../engine/src/handlers/subagent-stop/update-task-status";
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
import {
  messagesToClaudeJsonl,
  parsePiMessages,
  piStructuredTestDiagnostics,
  piStructuredTestResult,
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
  messages: unknown;
}>;

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
    `${agentType} failed before evidence capture completed (exitCode=${String(result.exitCode)}, ` +
    `stopReason=${String(result.stopReason ?? "unset")})`;

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

  if (IMPL_AGENTS.has(agentType) && !reservedSlot) {
    const failedTaskId = extractTaskId(result.task ?? "");
    if (failedTaskId !== null) {
      await store.update((state) => ({
        ...state,
        executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== failedTaskId),
      }));
    }
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
  const { store, agentType, completedPhase, result } = args;

  // Parse the untrusted Pi envelope before artifact extraction. A valid
  // envelope with no write calls may still use the documented filesystem
  // fallback; a malformed envelope cannot authorize phase advancement.
  const parsed = parsePiMessages(result.messages ?? []);
  if (!parsed.ok) {
    const diagnostic = `${agentType} phase artifact extraction failed: ${parsed.errors.join("; ")}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }

  try {
    const updates = phaseArtifactUpdates(writtenPathsOf(parsed.value), store.load().spec_dir ?? undefined);
    if (Object.keys(updates).length > 0) await store.update((state) => ({ ...state, ...updates }));
  } catch (error) {
    const diagnostic =
      `${agentType} phase artifact extraction failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom(pi): ${diagnostic} — phase was not advanced`], [diagnostic]);
  }

  const state = store.load();
  const currentIdx = PHASE_ORDER.indexOf(state.current_phase);
  const completedIdx = PHASE_ORDER.indexOf(completedPhase);
  if (completedIdx >= 0 && currentIdx > completedIdx) return outcome();

  const transition = resolveTransition(completedPhase, state);
  if (!transition) return outcome();

  // The transition's artifact is re-classified rather than re-matched on
  // substrings: `resolveTransition` already proved containment, and reusing the
  // shared classifier keeps one rule for "is this path the spec/plan file".
  const artifactUpdates = phaseArtifactUpdates([transition.artifact], state.spec_dir ?? undefined);
  try {
    await store.update((current) => ({
      ...current,
      current_phase: transition.nextPhase,
      phase_artifacts: { ...current.phase_artifacts, [completedPhase]: transition.artifact },
      ...artifactUpdates,
      skipped_phases: transition.skipClarify
        ? [...new Set([...current.skipped_phases, "clarify" as const])]
        : current.skipped_phases,
      updated_at: args.now,
    }));
  } catch (error) {
    const diagnostic = `phase advancement failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome([`loom: ${diagnostic}`], [diagnostic]);
  }
  return outcome();
}

// ---------------------------------------------------------------------------
// Implementation agents
// ---------------------------------------------------------------------------

/**
 * Which task an implementation result belongs to, or why it cannot be told.
 *
 * Pure: the reservation, the two prompt texts, and the currently-executing set
 * are all the inputs. An unextractable id must not vanish silently — exactly one
 * executing task infers it; ambiguous or empty is reported and clears
 * `executing_tasks` rather than failing tasks, which would cascade into
 * evidence overwrites downstream.
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

/**
 * Resolve one implementation agent's completion into task state.
 *
 * Every state decision runs INSIDE the locked update via the shared pure
 * `applyUntrustedStopResolution`: the pre-lock reads here are a fast path only,
 * and a concurrent writer may outdate them (TOCTOU). The incoming resolution is
 * always untrusted, so an existing trusted verdict — or a completed task —
 * always stands.
 */
export async function applyImplementationPiResult(args: Readonly<{
  store: TaskGraphStore;
  repository: RepositoryProbe;
  agentType: string;
  result: PiSubagentResult;
  reservedSlot: ReservedSlot | undefined;
  parentPrompt: ParentPromptText;
}>): Promise<PiResultOutcome> {
  const { store, repository, agentType, result, reservedSlot } = args;
  const log: string[] = [];

  const binding = resolveImplementationTaskId({
    agentType,
    reservedTaskId: reservedSlot?.taskId,
    resultPrompt: result.task ?? "",
    parentPrompt: args.parentPrompt,
    executingTasks: store.load().executing_tasks ?? [],
  });
  if (binding.kind === "unbound") {
    await store.update((state) => ({ ...state, executing_tasks: [] }));
    return outcome([binding.reason]);
  }
  const taskId = binding.taskId;
  if (binding.inferred) {
    log.push(`WARNING: ${agentType} task ID extraction failed, inferred task ${taskId} from executing_tasks`);
  }

  const parsedMessages = parsePiMessages(result.messages ?? []);

  // Pre-lock snapshot: needed for start_sha / new_tests_required in the evidence
  // collection below. The skip guard is a cheap fast path — the authoritative
  // re-check runs inside the locked update.
  const task = store.load().tasks.find((candidate) => candidate.id === taskId);
  // Evidence collection below needs a live unresolved task. A stopped
  // missing/completed task still needs locked execution cleanup; skipping it
  // outright leaves a ghost marker forever.
  if (!task || task.status === "completed") {
    await store.update((state) => ({
      ...state,
      executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
    }));
    log.push(`loom(pi): ${taskId} stopped; preserved completed/missing state and cleared executing_tasks`);
    return outcome(log);
  }

  // parseBashTestOutput deliberately accepts only paired Bash tool calls and
  // results in Claude-compatible JSONL. Passing flattened prose here silently
  // discards every Pi test run as spoofable free text.
  const adaptedTranscript = parsedMessages.ok ? messagesToClaudeJsonl(parsedMessages.value) : parsedMessages;
  const structuredEvidence = parsedMessages.ok ? piStructuredTestResult(parsedMessages.value) : parsedMessages;
  if (structuredEvidence.ok && structuredEvidence.value === null) {
    // The wave gate rejects the transcript fallback, so a null structured
    // verdict is a latent blocker: say exactly why, instead of letting the next
    // gate run surface a bare "untrusted-regression-pass" mystery.
    const trace = piStructuredTestDiagnostics(result.messages ?? []);
    if (trace.ok) {
      const summary = trace.value.classifiedCommands.length === 0
        ? "no Bash call was classified as a test run"
        : `verdict=${trace.value.verdict}, classified=[${trace.value.classifiedCommands.join(" | ")}]`;
      log.push(
        `loom(pi): ${taskId} produced no structured test evidence (${summary}) — transcript fallback used; ` +
        `the wave gate will reject it`,
      );
    }
  }

  if (!adaptedTranscript.ok || !structuredEvidence.ok || !parsedMessages.ok) {
    const errors = !parsedMessages.ok
      ? parsedMessages.errors
      : !adaptedTranscript.ok
        ? adaptedTranscript.errors
        : !structuredEvidence.ok
          ? structuredEvidence.errors
          : [];
    const failureReason = `Pi transcript evidence capture failed: ${errors.join("; ")}`;
    const root = repository.root();
    const comparisonFailures: string[] = [];
    await store.update((current) => {
      const currentTarget = current.tasks.find((candidate) => candidate.id === taskId);
      if (currentTarget === undefined || currentTarget.status === "completed") {
        return {
          ...current,
          executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
        };
      }
      const comparison = compareAttemptBaseline(root, currentTarget, { kind: "repository-or-declared" });
      if (comparison.failure !== null) {
        comparisonFailures.push(
          `loom(pi): cannot compare malformed-transcript attempt baseline for ${taskId}: ${comparison.failure} — ` +
          `invalidating stale evidence`,
        );
      }
      if (!comparison.bytesChangedSinceAttempt) {
        return {
          ...current,
          executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
          tasks: current.tasks.map((candidate) =>
            candidate.id === taskId && candidate.status === "pending"
              ? { ...candidate, failure_reason: failureReason }
              : candidate
          ),
        };
      }
      return applyUntrustedStopResolution(current, taskId, {
        taskCompleted: false,
        testResult: { verdict: "untrusted", passed: false, label: "pi-transcript-capture-failed" },
        testEvidence: failureReason,
        // Malformed messages provide no task-attributed path evidence. The
        // batch-wide repository delta is invalidation-only.
        filesModified: [],
        changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
        bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
        newTestsWritten: false,
        newTestEvidence: "",
      }).state;
    });
    log.push(...comparisonFailures, `loom(pi): ${failureReason} — ${taskId} evidence was not accepted`);
    return outcome(log);
  }

  const resultMessages = parsedMessages.value;
  const transcriptEvidence = extractTestEvidence(parseBashTestOutput(adaptedTranscript.value));
  const structuredTestEvidence = structuredEvidence.value;
  const testEvidence = structuredTestEvidence ?? transcriptEvidence;

  // files_modified feeds lint-wave-gate's target collection (it collects lint
  // targets EXCLUSIVELY from tasks' files_modified) — parse it from the
  // per-result messages, re-encoded as the pi-format JSONL parseFilesModified's
  // pi branch reads, so the pi path persists the same field the engine does.
  const piJsonl = resultMessages.map((message) => JSON.stringify({ type: "message", message })).join("\n");
  let filesModified: readonly string[];
  try {
    filesModified = canonicalRepositoryPaths(
      repository.root(),
      parseFilesModified(piJsonl, "pi"),
      "Pi transcript files_modified",
    );
  } catch (error) {
    await store.update((state) => ({
      ...state,
      executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),
    }));
    log.push(
      `loom(pi): unsafe modified-file evidence for ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)} — task left pending`,
    );
    return outcome(log);
  }

  // The SAME comparison and the SAME fail-closed contract as the other two
  // sites. The helper fails closed (`bytesChangedSinceAttempt: true`, declared
  // artifacts from `file_list`) and this path falls through to the untrusted
  // resolution below, exactly as the others do.
  const comparison = compareAttemptBaseline(
    repository.root(),
    task,
    { kind: "repository-or-declared", extraModifiedPaths: filesModified },
  );
  if (comparison.failure !== null) {
    log.push(
      `loom(pi): cannot compare declared-artifact baseline for ${taskId}: ${comparison.failure} — ` +
      `invalidating stale evidence`,
    );
  }

  let skippedExistingVerdict = false;
  await store.update((state) => {
    const currentTarget = state.tasks.find((candidate) => candidate.id === taskId);
    const cumulativeFiles = cumulativeModifiedPaths(currentTarget?.files_modified, filesModified);
    const newTestEvidence = repository.isRepo()
      ? collectNewTestEvidence(cumulativeFiles, currentTarget?.new_tests_required, currentTarget?.start_sha)
      : { written: false, evidence: "" };
    const applied = applyUntrustedStopResolution(state, taskId, {
      taskCompleted: true,
      // Pi has no Loom evidence ledger. Preserve the real provenance: paired
      // tool-result evidence may discharge Pi's structured proof policy;
      // flattened transcript output may not.
      testResult: {
        verdict: "untrusted" as const,
        passed: testEvidence.passed,
        label: structuredTestEvidence !== null
          ? `pi-structured: ${structuredTestEvidence.evidence || "test tool result"}`
          : "transcript-regex (fallback)",
      },
      testEvidence: testEvidence.evidence,
      filesModified,
      changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
      bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
      newTestsWritten: newTestEvidence.written,
      newTestEvidence: newTestEvidence.evidence,
    });
    skippedExistingVerdict = applied.skipped;
    // applyUntrustedStopResolution reconciles impl_complete in both directions
    // in the same locked state transition as the proof.
    return applied.state;
  });

  if (skippedExistingVerdict) {
    log.push(
      `loom(pi): ${taskId} is completed or carries a trusted verdict this untrusted resolution cannot supersede — ` +
      `leaving it untouched`,
    );
  }
  return outcome(log);
}

// ---------------------------------------------------------------------------
// Review agents
// ---------------------------------------------------------------------------

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
  const { store, agentType, result, reservedSlot } = args;
  const taskId = reservedSlot?.taskId ?? extractTaskId(result.task ?? "") ?? extractTaskId(args.parentPrompt);
  if (!taskId) {
    // A review whose task ID is unextractable stores nothing — its findings
    // silently never gate the wave. Say so instead of vanishing (review agents
    // don't sit in executing_tasks, so there is no inference to fall back on).
    return outcome([`WARNING: ${agentType} review completed without an extractable task ID — findings NOT stored`]);
  }

  // `tasks.map` over an id no task holds is a total no-op, and the log below
  // asserts the findings were stored regardless. `extractTaskId` falls back to
  // any standalone `T\d+` in the transcript, so a reviewer quoting an unrelated
  // id resolves to a task the graph does not have — and that reviewer's
  // criticals were discarded while stderr reported them recorded. Both
  // harnesses guard it, or they drift.
  const reviewTask = store.load().tasks.find((task) => task.id === taskId);
  if (!reviewTask) {
    return outcome([
      `WARNING: ${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored`,
    ]);
  }

  const parsedMessages = parsePiMessages(result.messages ?? []);
  if (!parsedMessages.ok) {
    const message = `Pi review messages are malformed: ${parsedMessages.errors.join("; ")}`;
    const resolution = { kind: "evidence-failed" as const, agent: agentType, message };
    let appliedTask = reviewTask;
    await store.update((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== taskId) return task;
        appliedTask = applyReviewResolution(task, resolution);
        return appliedTask;
      }),
    }));
    return outcome([reviewResolutionLog(taskId, resolution, appliedTask, true)]);
  }

  let resolution: ReviewResolution = {
    kind: "evidence-failed",
    agent: agentType,
    message: "review task disappeared before evidence could be applied",
  };
  let appliedTask = reviewTask;
  let applicationChanged = false;
  let taskFound = false;
  const transcriptText = transcriptTextOf(parsedMessages.value);
  await store.update((state) => ({
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== taskId) return task;
      taskFound = true;
      resolution = constrainReviewResolutionToScope(
        resolveTaskReviewFindings(transcriptText, agentType, task.review_run, task.review_generation),
        [...(task.file_list ?? []), ...(task.files_modified ?? [])],
      );
      appliedTask = applyReviewResolution(task, resolution);
      applicationChanged = appliedTask !== task;
      return appliedTask;
    }),
  }));
  if (!taskFound) {
    return outcome([
      `WARNING: ${agentType} review task ${taskId} disappeared before evidence application — findings NOT stored`,
    ]);
  }
  return outcome([reviewResolutionLog(taskId, resolution, appliedTask, applicationChanged)]);
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
  const parsedMessages = parsePiMessages(result.messages ?? []);
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
