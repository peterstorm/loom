/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { awaitUserAction, parseAgentRequestAuthority, parseStoredAgentRequestAuthority, canonicalStructuralEquals, parseArtifactDigest, parseOrchestrationRunId, parseRequestId, type AgentRequestAuthority, type AwaitUserAction, type InitialSpawnRequestInput, type SpawnRequest } from '../../../core/orchestration-contract';
import { defaultRefutationThreshold } from '../../../core/review-panel';
import { completePersistentRefutationPanel, deriveRefutationVerifierBinding, panelRequestIdentity, parseRefutationPanelAuthority, startPersistentRefutationPanel, submitRefutationVerdict } from '../../../core/panel-program';
import type { FindingOutcome } from '../../../core/review-panel';
import { buildContextPacket, encodeByteSection, type ContextPacket } from '../../../orchestration/context-packets';
import { captureKey } from '../../../core/harness-capture';
import { inspectRunDirectoryEntry, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { commitWaveGateCompletion, deriveWaveAdvisoryDecisionRequest, deriveWaveGateDriveStep, deriveWaveReadiness, deriveWaveRefutationPlan, waveAdvisoryDecisionActionRequest, WAVE_REVIEW_AGENTS, type WaveAdvisoryDecisionRequest } from '../../../core/wave-gate-machine';
import { inspectFilePresence, loadPlanModelsSource } from '../complete-wave-gate';
import { runFullTierWaveLint } from '../lint-wave-gate';
import { ensureWaveCompletionSuite, observeCurrentWaveWorkspace } from '../wave-completion-suite';
import { observeReviewedWorkspace } from '../reviewed-workspace';
import { applyFindingOutcomes, preserveAcceptedReviewRunFindings } from '../../../core/findings';
import { applyReviewResolution, constrainReviewResolutionToScope, resolveTaskReviewFindings } from '../../../core/review-output';
import type { Task, TaskGraph } from '../../../types';
import { anyActiveSubagent } from '../../../machine';
import { parseSpecCheckOutput, reconcileSpecCheck } from '../../../core/spec-check';
import { reconcileWaveBlock } from '../../../core/wave-gate-model';
import { resolveModelProfile, lowerModelProfile } from '../../../core/model-profiles';
import {
  prepareWaveReviewBatch,
  readWaveReviewContext,
  waveSpecCheckScope,
  type WaveRequestBatch,
  type WaveReviewContextRead,
  type WaveReviewRegistrationAuthority,
  type WaveSpecCheckTaskAuthority,
  type WaveTaskRunAuthority,
} from '../../../core/wave-review-authority';
import { durableCaptureRejection, durableRefutationRequests, exactObject, executableRefutationRequests, failed, parseRegisteredFacadeProgram, publicationResolver, publishInitialBatch, recoverOrPublishRefutationRetry, refutationRejectionDiagnostic, renderSpawnTask, type FacadeDriveResult, type RegisteredWaveGateProgram } from './helpers';

export const waveGateDeps = Object.freeze({
  loadPlanModels: loadPlanModelsSource,
  filePresence: inspectFilePresence,
  reviewedWorkspace: observeReviewedWorkspace,
});

function currentWaveGateDeps(graph: TaskGraph, authorityStartPath: string) {
  return graph.verification_manifest === undefined
    ? waveGateDeps
    : Object.freeze({
        ...waveGateDeps,
        currentWaveWorkspace: observeCurrentWaveWorkspace(graph, authorityStartPath),
      });
}

export function waveAdvisoryDecisionRequestId(
  runId: string,
  tasks: readonly Task[],
): string {
  const request = deriveWaveAdvisoryDecisionRequest(runId, tasks);
  if (!request.ok) throw new Error(request.error.message);
  return request.value.requestId;
}

/** Publish every byte referenced by the canonical user-decision request. */
export async function publishWaveAdvisoryDecisionRequest(
  handle: RunDirHandle,
  material: WaveAdvisoryDecisionRequest,
): Promise<Readonly<{ ok: true; request: AwaitUserAction["request"] }> | Readonly<{ ok: false; message: string }>> {
  const actionRequest = waveAdvisoryDecisionActionRequest(material);
  if (!actionRequest.ok) return { ok: false, message: actionRequest.error.message };
  const action = awaitUserAction(actionRequest.value);
  if (!action.ok) return { ok: false, message: action.error.message };
  if (material.advisories[0].reference.runId !== handle.runId) {
    return { ok: false, message: "advisory decision material belongs to a different run" };
  }
  const published = await handle.publishArtifactSet(material.advisories.map(({ reference, bytes }) => ({
    relativePath: reference.slot.path.slice("artifacts/".length),
    bytes,
  })));
  if (!published.ok) return { ok: false, message: published.error.message };
  const expectedRefs = material.advisories.map(({ reference }) => reference);
  if (!canonicalStructuralEquals(published.value, expectedRefs)) {
    return { ok: false, message: "published advisory artifacts differ from core-derived references" };
  }
  const context = await handle.publishDecisionContext(material.context.digest, material.context.bytes);
  if (!context.ok) return { ok: false, message: context.error.message };
  if (context.value.digest !== material.context.digest) {
    return { ok: false, message: "published advisory context differs from core-derived context authority" };
  }
  return { ok: true, request: action.value.request };
}

/**
 * Which dimension of a Wave Gate decision's authority failed to match, or `null`
 * when the decision is the exact pending one for this run.
 *
 * This is the guard that stops a decision meant for one Wave Gate run from being
 * applied to a stale or foreign one — a correctness rule, not I/O plumbing. It
 * lived inline in `decideOperation` as a raw boolean chain inside the CLI
 * dispatcher, so its four dimensions (run, wave, authority digest, decision id)
 * had no interface of their own and no test that could tell them apart: the only
 * coverage ran the whole CLI against fixture files and matched stderr. Named
 * here, beside the two functions it compares against, each mismatch is
 * independently reachable.
 *
 * Pure: the caller reads and parses the protected graph; this only judges it.
 */
export function waveGateDecisionMismatch(
  graph: TaskGraph,
  registration: RegisteredWaveGateProgram,
  runId: string,
  decisionId: string,
): string | null {
  const active = graph.active_wave_gate;
  if (active?.runId !== runId ||
      active.wave !== registration.input.wave ||
      active.authorityDigest !== registration.authorityDigest) {
    return "protected active Wave Gate authority differs from this decision run";
  }
  const pending = deriveWaveAdvisoryDecisionRequest(
    runId,
    graph.tasks.filter(({ id }) => registration.taskIds.includes(id)),
  );
  if (!pending.ok) {
    return `decision request ${decisionId} is not the exact pending advisory request: ${pending.error.message}`;
  }
  return decisionId === pending.value.requestId
    ? null
    : `decision request ${decisionId} is not the exact pending advisory request ${pending.value.requestId}`;
}

export function waveBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "wave-gate-blocked", message } } };
}

export function waveGateAuthorityDigest(wave: number, taskIds: readonly string[], graph: TaskGraph): string {
  return createHash("sha256").update(JSON.stringify({ wave, taskIds, graph })).digest("hex");
}

export type WaveGateRestartPreparation = Readonly<{
  graph: TaskGraph;
  registration: RegisteredWaveGateProgram;
  exhaustedSlots: readonly string[];
}>;

export type WaveGateRestartResult =
  | Readonly<{ ok: true; value: WaveGateRestartPreparation }>
  | Readonly<{ ok: false; message: string }>;

function retireActiveReviewRun(task: Task): Task {
  const preserved = preserveAcceptedReviewRunFindings(task);
  return {
    ...preserved,
    review_status: "pending",
    // Packet retirement changes no implementation bytes. Keep generation
    // stable; fresh packet/run identities make old transcripts stale.
    review_generation: task.review_generation,
    review_run: undefined,
    review_error: undefined,
    review_evidence_failures: undefined,
  };
}

/**
 * Pure protected-state transition for replacing one exhausted Wave review run.
 * Existing findings survive as prior findings; only packet-bound evidence is
 * invalidated. Review Generation stays stable because implementation bytes did
 * not change; fresh packet, epoch, and Run identities reject stale transcripts.
 */
export function prepareExhaustedWaveGateRestart(
  graph: TaskGraph,
  previousRunId: string,
  previous: RegisteredWaveGateProgram,
  nextRunId: string,
  nextRunsRoot: string,
  exhaustedAttempts: ReadonlySet<string>,
): WaveGateRestartResult {
  const wave = previous.input.wave;
  if (wave === null || graph.current_phase !== "execute" || graph.current_wave !== wave) {
    return { ok: false, message: "Wave Gate restart requires exact protected execute/current_wave authority" };
  }
  const active = graph.active_wave_gate;
  if (active === undefined || active.runId !== previousRunId || active.wave !== wave ||
      active.authorityDigest !== previous.authorityDigest || active.terminalOutcome !== null) {
    return { ok: false, message: "the previous run no longer owns exact active Wave Gate authority" };
  }
  const epoch = graph.wave_review_epoch;
  if (epoch === undefined || epoch.runId !== active.runId || epoch.wave !== wave) {
    return { ok: false, message: "the previous run has no exact active Wave review epoch" };
  }
  const waveTasks = graph.tasks.filter((task) => previous.taskIds.includes(task.id));
  if (waveTasks.length !== previous.taskIds.length) {
    return { ok: false, message: "the previous Wave Gate task authority no longer matches the protected graph" };
  }
  for (const task of waveTasks) {
    const run = task.review_run;
    if (run === undefined) continue;
    if (run.head_sha !== epoch.batchEpoch ||
        run.expected_agents.length !== WAVE_REVIEW_AGENTS.length ||
        run.expected_agents.some((agent, index) => agent !== WAVE_REVIEW_AGENTS[index]) ||
        run.slot_authority === undefined || run.slot_authority.length !== WAVE_REVIEW_AGENTS.length ||
        WAVE_REVIEW_AGENTS.some((agent, index) => run.slot_authority?.[index]?.agent !== agent)) {
      return { ok: false, message: `task ${task.id} Review Packet is not bound to the active epoch and exact reviewer roster` };
    }
  }
  const outstanding = waveTasks.flatMap((task) => {
    const run = task.review_run;
    if (run === undefined) return [];
    return run.slot_authority!.filter((slot) =>
      !run.evidence.some(({ agent }) => agent === slot.agent),
    ).map((slot) => ({ task, slot }));
  });
  if (outstanding.length === 0) {
    return { ok: false, message: "the active Wave Gate has no outstanding reviewer slots to restart" };
  }
  const nonExhausted = outstanding.filter(({ slot }) =>
    slot.attempted !== 2 || !exhaustedAttempts.has(captureKey(slot.slot_id, 2)));
  if (nonExhausted.length > 0) {
    return {
      ok: false,
      message: `Wave Gate restart refused before final-attempt rejection for: ${nonExhausted.map(({ task, slot }) => `${task.id}/${slot.agent}`).join(", ")}`,
    };
  }
  const resetGraph: TaskGraph = {
    ...graph,
    tasks: graph.tasks.map((task) => previous.taskIds.includes(task.id) && task.review_run !== undefined
      ? retireActiveReviewRun(task)
      : task),
    spec_check: undefined,
    wave_review_epoch: undefined,
    active_wave_gate: undefined,
  };
  const authorityDigest = waveGateAuthorityDigest(wave, previous.taskIds, resetGraph);
  const exhaustedSlots = Object.freeze(outstanding.map(({ task, slot }) => `${task.id}/${slot.agent}`));
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 1,
    kind: "wave-gate",
    input: Object.freeze({ wave }),
    taskIds: previous.taskIds,
    authorityDigest,
    restart: Object.freeze({ previousRunId, exhaustedSlots }),
  });
  const parsedNextRunId = parseOrchestrationRunId(nextRunId);
  const parsedAuthorityDigest = parseArtifactDigest(authorityDigest);
  if (!parsedNextRunId.ok) return { ok: false, message: parsedNextRunId.error.message };
  if (!parsedAuthorityDigest.ok) return { ok: false, message: parsedAuthorityDigest.error.message };
  const nextGraph: TaskGraph = {
    ...resetGraph,
    active_wave_gate: {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: parsedNextRunId.value,
      wave,
      authorityDigest: parsedAuthorityDigest.value,
      revision: 0,
      runsRoot: nextRunsRoot,
      terminalOutcome: null,
    },
  };
  return {
    ok: true,
    value: Object.freeze({
      graph: nextGraph,
      registration,
      exhaustedSlots,
    }),
  };
}

export type OrphanedWaveGateRecoveryExpectation = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
}>;

export type OrphanedWaveGateRecoveryPreparation = Readonly<{
  graph: TaskGraph;
  registration: RegisteredWaveGateProgram;
}>;

export type OrphanedWaveGateRecoveryResult =
  | Readonly<{ ok: true; value: OrphanedWaveGateRecoveryPreparation }>
  | Readonly<{ ok: false; message: string }>;

/** Pure state transition for replacing an active Wave Gate whose authoritative
 * Run Directory has been proven absent by the shell. Packet-bound evidence is
 * retired, accepted findings are materialized, and every durable finding,
 * refutation, resolution, and review generation survives unchanged. */
export function prepareOrphanedWaveGateRecovery(
  graph: TaskGraph,
  expected: OrphanedWaveGateRecoveryExpectation,
  authoritativeRunsRoot: string,
  nextRunId: string,
  nextRunsRoot: string,
): OrphanedWaveGateRecoveryResult {
  const active = graph.active_wave_gate;
  if (graph.current_phase !== "execute" || graph.current_wave !== expected.wave ||
      active === undefined || active.terminalOutcome !== null || active.runId !== expected.runId ||
      active.wave !== expected.wave || active.authorityDigest !== expected.authorityDigest ||
      (active.runsRoot !== undefined && active.runsRoot !== authoritativeRunsRoot)) {
    return { ok: false, message: "orphan recovery requires the exact protected active run ID, wave, authority digest, and runs root" };
  }
  if (nextRunId === expected.runId) {
    return { ok: false, message: "orphan recovery requires a distinct replacement run identity" };
  }
  if ((graph.orphaned_wave_gate_history ?? []).some(({ runId }) => runId === active.runId)) {
    return { ok: false, message: `active Wave Gate run ${active.runId} already has a retirement audit record` };
  }
  const taskIds = Object.freeze(graph.tasks.filter(({ wave }) => wave === expected.wave).map(({ id }) => id));
  if (taskIds.length === 0) return { ok: false, message: `active Wave ${expected.wave} has no protected tasks` };

  const resetGraph: TaskGraph = {
    ...graph,
    tasks: graph.tasks.map((task) => taskIds.includes(task.id) && task.review_run !== undefined
      ? retireActiveReviewRun(task)
      : task),
    spec_check: undefined,
    wave_review_epoch: undefined,
    active_wave_gate: undefined,
  };
  const authorityDigest = waveGateAuthorityDigest(expected.wave, taskIds, resetGraph);
  const parsedNextRunId = parseOrchestrationRunId(nextRunId);
  const parsedAuthorityDigest = parseArtifactDigest(authorityDigest);
  if (!parsedNextRunId.ok) return { ok: false, message: parsedNextRunId.error.message };
  if (!parsedAuthorityDigest.ok) return { ok: false, message: parsedAuthorityDigest.error.message };

  const retirement = Object.freeze({
    schemaVersion: 1 as const,
    kind: "orphaned-wave-gate-retirement" as const,
    runId: active.runId,
    wave: active.wave,
    authorityDigest: active.authorityDigest,
    revision: active.revision,
    reason: "authoritative-run-directory-missing" as const,
    runsRoot: authoritativeRunsRoot,
    runDirectory: join(authoritativeRunsRoot, active.runId),
    replacementRunId: parsedNextRunId.value,
    replacementAuthorityDigest: parsedAuthorityDigest.value,
  });
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 1,
    kind: "wave-gate",
    input: Object.freeze({ wave: expected.wave }),
    taskIds,
    authorityDigest,
    orphanRecovery: Object.freeze({
      previousRunId: active.runId,
      previousAuthorityDigest: active.authorityDigest,
    }),
  });
  const nextGraph: TaskGraph = {
    ...resetGraph,
    orphaned_wave_gate_history: Object.freeze([...(graph.orphaned_wave_gate_history ?? []), retirement]),
    active_wave_gate: Object.freeze({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: parsedNextRunId.value,
      wave: expected.wave,
      authorityDigest: parsedAuthorityDigest.value,
      revision: 0,
      runsRoot: nextRunsRoot,
      terminalOutcome: null,
    }),
  };
  return {
    ok: true,
    value: Object.freeze({ graph: nextGraph, registration }),
  };
}

export { waveSpecCheckScope };
export type { WaveRequestBatch, WaveSpecCheckTaskAuthority, WaveTaskRunAuthority };

/** Imperative shell: observe current bytes, then delegate every authority
 * decision to the single pure Wave review preparation function. */
export function waveRequests(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  attempt: 1 | 2,
): WaveRequestBatch {
  const wave = registration.input.wave;
  if (wave === null) throw new Error("registered Wave review authority lacks an exact Wave");
  const tasks = registration.taskIds.flatMap((taskId) => {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    return task === undefined ? [] : [task];
  });
  const authority: WaveReviewRegistrationAuthority = Object.freeze({
    ...registration,
    input: Object.freeze({ wave }),
  });
  const prepared = prepareWaveReviewBatch(
    handle.runId,
    authority,
    graph,
    attempt,
    observeReviewedWorkspace(tasks),
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
}

export function resolveWaveReviewerTranscript(task: Task, agent: string, bytes: Uint8Array) {
  return constrainReviewResolutionToScope(
    resolveTaskReviewFindings(
      Buffer.from(bytes).toString("utf8"),
      agent,
      task.review_run,
      task.review_generation,
    ),
    [...(task.file_list ?? []), ...(task.files_modified ?? [])],
  );
}

export function reviewerRejectionReason(task: Task, agent: string, bytes: Uint8Array): string | null {
  const resolution = resolveWaveReviewerTranscript(task, agent, bytes);
  if (resolution.kind === "evidence-failed" || resolution.kind === "ignored-stale") return resolution.message;
  const slot = task.review_run?.slot_authority?.find((candidate) => candidate.agent === agent);
  const applied = applyReviewResolution(task, resolution, slot);
  const accepted = applied.review_run?.evidence.some((evidence) => evidence.agent === agent) === true ||
    // A final valid slot closes the roster and `finalizeReviewRun` removes the
    // packet entirely. That terminal transition is acceptance, not rejection.
    (task.review_run !== undefined && applied.review_run === undefined &&
      applied.review_error === undefined && applied.review_status !== "evidence_capture_failed");
  if (accepted) return null;
  return applied.review_error ?? "attempt did not produce accepted packet evidence";
}

export type WaveTaskReviewRetry = Readonly<{
  taskId: string;
  packetId: string;
  agent: string;
  slotId: string;
  retryDiagnostic: string;
  request: InitialSpawnRequestInput;
  packet: ContextPacket;
}>;

/**
 * The attempt-2 diagnostic a rejected reviewer sees. It names the parser's
 * exact complaint AND restates the exact wire schema, because the failure this
 * exists to break is a model inferring `{id, status}` from prose and repeating
 * it on retry. Concrete keys, not description.
 *
 * The template is split into a FIXED preamble (through the reason separator)
 * and a FIXED schema tail; only the parser rejection reason is variable, so
 * persisted attempt-2 contexts can be re-validated byte-exactly instead of
 * trusting a section label (see parseWaveRetryDiagnosticSection).
 */

export const WAVE_RETRY_PREAMBLE = [
  "YOUR PREVIOUS ATTEMPT WAS REJECTED. This is your final attempt.",
  "",
  "Parser rejection reason: ",
].join("\n");

export const WAVE_RETRY_FIXED_TAIL = [
  "Emit the review_lifecycle block with these EXACT keys — the parser accepts",
  "`finding_id` (NOT `id`), `verdict` (NOT `status`), and `reason`. The only",
  "legal verdict values are `resolved_by_remediation` and `still_present`:",
  "",
  "```review_lifecycle",
  "{",
  '  "prior_findings": [',
  '    { "finding_id": "<exact id from task.priorFindings>", "verdict": "still_present", "reason": "<concrete non-empty reason>" }',
  "  ]",
  "}",
  "```",
  "",
  "Also emit the REVIEW_GENERATION and REVIEW_PACKET_ID marker lines copied",
  "verbatim from the packet, and assess every task.priorFindings id exactly",
  "once in packet order. Use an empty array when there are no prior findings.",
].join("\n");

export function waveRetryDiagnosticText(reason: string): string {
  return `${WAVE_RETRY_PREAMBLE}${reason}\n\n${WAVE_RETRY_FIXED_TAIL}`;
}

/**
 * Parse the persisted `wave-review-attempt-1-rejection` section back into its
 * canonical shape. The label alone is not authority — an attacker who can write
 * to the run directory could reuse it — so compatibility with a persisted
 * attempt-2 context requires the section bytes to be exactly
 * `<fixed preamble><non-empty reason>\n\n<fixed schema tail>`.
 */
export function parseWaveRetryDiagnosticSection(
  bytes: readonly number[],
): Readonly<{ ok: true; reason: string }> | Readonly<{ ok: false; message: string }> {
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return { ok: false, message: "wave attempt-1 rejection section is not valid UTF-8" };
  }
  if (!text.startsWith(WAVE_RETRY_PREAMBLE)) {
    return { ok: false, message: "wave attempt-1 rejection section lacks the canonical retry preamble" };
  }
  const remainder = text.slice(WAVE_RETRY_PREAMBLE.length);
  const tailMarker = `\n\n${WAVE_RETRY_FIXED_TAIL}`;
  const markerIndex = remainder.indexOf(tailMarker);
  if (markerIndex < 0 || remainder.slice(markerIndex + tailMarker.length) !== "") {
    return { ok: false, message: "wave attempt-1 rejection section is not one canonical diagnostic-rich retry" };
  }
  const reason = remainder.slice(0, markerIndex);
  if (reason.trim().length === 0) {
    return { ok: false, message: "wave attempt-1 rejection section carries an empty parser rejection reason" };
  }
  return { ok: true, reason };
}

export function deriveWaveAttemptTwo(
  handle: RunDirHandle,
  attemptOne: AgentRequestAuthority,
  retryDiagnostic: string | null = null,
): Readonly<{ request: InitialSpawnRequestInput; packet: ContextPacket }> {
  if (attemptOne.program !== "wave-gate" || attemptOne.attempt !== 1) {
    throw new Error(`slot ${attemptOne.slotId} has no canonical Wave attempt-1 authority`);
  }
  const requestId = parseRequestId(attemptOne.requestId.replace(/:1$/, ":2"));
  if (!requestId.ok || requestId.value === attemptOne.requestId) {
    throw new Error(`Wave request ${attemptOne.requestId} cannot derive canonical attempt-2 identity`);
  }
  const original = handle.readContext(attemptOne.contextDigest);
  if (!original.ok) throw new Error(original.error.message);
  // Attempt 1 was rejected. Surface the parser's exact reason plus the exact
  // required schema so the model corrects the specific defect instead of
  // re-emitting the same malformed shape into its final attempt — a silent
  // identical retry is how a whole reviewer batch exhausts its allowance.
  const variableContext = retryDiagnostic === null
    ? original.value.variableContext
    : (() => {
        const section = encodeByteSection("wave-review-attempt-1-rejection", waveRetryDiagnosticText(retryDiagnostic));
        if (!section.ok) throw new Error(section.error.message);
        return Object.freeze([...original.value.variableContext, section.value]);
      })();
  const packet = buildContextPacket({
    requestId: requestId.value,
    role: original.value.role,
    requiredSkill: original.value.requiredSkill,
    outputContract: original.value.outputContract,
    fixedContext: original.value.fixedContext,
    variableContext,
  });
  if (!packet.ok) throw new Error(packet.error.message);
  // Stored mode: attemptOne was read back from this run's durable artifacts, so
  // its role->profile/skill couplings belong to the policy tables in force when
  // it was ISSUED. Re-checking them against today's tables strands every run on
  // disk across an agent's profile promotion, and would also disagree with
  // persistedWaveAttemptTwoCompatibilityProblem, which derives this same
  // attempt-2 in stored mode.
  const authority = parseStoredAgentRequestAuthority({
    ...attemptOne,
    requestId: requestId.value,
    attempt: 2,
    contextDigest: packet.value.digest,
    outputSlot: {
      kind: "fixed-artifact-slot",
      path: attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"),
    },
  });
  if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
  return Object.freeze({
    request: Object.freeze({
      authority: authority.value,
      context: Object.freeze({
        digest: packet.value.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
      }),
    }),
    packet: packet.value,
  });
}

export async function currentWaveTaskReviewRetries(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  issued: readonly AgentRequestAuthority[],
): Promise<readonly WaveTaskReviewRetry[]> {
  const events = await handle.readEvents();
  const rejectionReason = (authority: AgentRequestAuthority): string | null => {
    const found = events.find(({ event }) => {
      if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
      const record = event as Record<string, unknown>;
      return record.kind === "request-capture-rejected" && record.requestId === authority.requestId &&
        record.slotId === authority.slotId && record.attempt === authority.attempt;
    });
    if (found === undefined || typeof found.event !== "object" || found.event === null) return null;
    const diagnostic = (found.event as Record<string, unknown>).diagnostic;
    return typeof diagnostic === "string" && diagnostic.trim() !== "" ? diagnostic : "capture was rejected without a diagnostic";
  };
  return graph.tasks.filter((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined)
    .flatMap((task) => {
      const run = task.review_run!;
      if (run.slot_authority === undefined || run.slot_authority.length !== run.expected_agents.length) {
        throw new Error(`Task ${task.id} active Review Run lacks engine-issued exact slot authority`);
      }
      return run.expected_agents.flatMap((agent, index) => {
        if (run.evidence.some((entry) => entry.agent === agent)) return [];
        const slot = run.slot_authority![index];
        if (slot === undefined || slot.agent !== agent) {
          throw new Error(`Task ${task.id}/${agent} active Review Run slot authority drifted`);
        }
        const attemptOne = issued.find((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
          authority.slotId === slot.slot_id && authority.role === agent);
        if (attemptOne === undefined) {
          throw new Error(`Task ${task.id}/${agent} has no issued attempt-1 authority for current packet ${run.packet_id}`);
        }
        const captured = handle.readTranscriptBytes(attemptOne);
        const retryReason = captured.ok
          ? reviewerRejectionReason(task, agent, captured.value) ??
            "attempt 1 was accepted but did not close this outstanding slot"
          : rejectionReason(attemptOne) ?? task.review_error ?? captured.error.message;
        const retryDiagnostic = waveRetryDiagnosticText(retryReason);
        const retry = deriveWaveAttemptTwo(handle, attemptOne, retryReason);
        return [Object.freeze({
          taskId: task.id,
          packetId: run.packet_id,
          agent,
          slotId: slot.slot_id,
          retryDiagnostic,
          request: retry.request,
          packet: retry.packet,
        })];
      });
    });
}

export async function markWaveTaskReviewRetriesIssued(
  manager: StateManager,
  retries: readonly WaveTaskReviewRetry[],
): Promise<void> {
  if (retries.length === 0) return;
  await manager.update((locked) => ({
    ...locked,
    tasks: locked.tasks.map((task) => {
      const mine = retries.filter((retry) => retry.taskId === task.id);
      if (mine.length === 0) return task;
      const run = task.review_run;
      if (run === undefined || mine.some((retry) => retry.packetId !== run.packet_id)) {
        throw new Error(`Task ${task.id} Review Packet changed before attempt-2 issuance could commit`);
      }
      if (run.slot_authority === undefined) {
        throw new Error(`Task ${task.id} active Review Run lost exact slot authority`);
      }
      return {
        ...task,
        review_run: {
          ...run,
          slot_authority: run.slot_authority.map((slot) => mine.some((retry) =>
            retry.agent === slot.agent && retry.slotId === slot.slot_id)
            ? { ...slot, attempted: 2 as const }
            : slot) as unknown as typeof run.slot_authority,
        },
      };
    }),
  }));
}

export async function installWaveReviewRuns(
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  batch: WaveRequestBatch,
): Promise<void> {
  const specCheckAuthority = batch.requests.map(({ authority }) => authority as AgentRequestAuthority)
    .find(({ role }) => role === "spec-check-invoker");
  if (specCheckAuthority === undefined || specCheckAuthority.attempt !== 1) {
    throw new Error("Wave review batch lacks exact spec-check attempt-1 authority");
  }
  const reviewAuthorities = batch.requests.filter(({ authority }) =>
    (authority as AgentRequestAuthority).role !== "spec-check-invoker");
  await manager.update((locked) => ({
    ...locked,
    spec_check: undefined,
    wave_review_epoch: {
      runId: specCheckAuthority.runId,
      wave: registration.input.wave ?? locked.current_wave ?? 0,
      batchEpoch: batch.batchEpoch,
      specCheckSlotAuthority: {
        slot_id: specCheckAuthority.slotId,
        attempted: 1,
      },
    },
    tasks: locked.tasks.map((task) => {
      if (!registration.taskIds.includes(task.id)) return task;
      const taskRun = batch.taskRuns.find(({ taskId }) => taskId === task.id);
      const currentWorkspace = observeReviewedWorkspace([task])[0];
      if (taskRun === undefined || taskRun.generation !== (task.review_generation ?? 0) ||
          currentWorkspace === undefined || currentWorkspace.headSha !== (taskRun.workspaceHeadSha ?? taskRun.headSha)) {
        throw new Error(`Task ${task.id} changed before its current Review Packet could be installed`);
      }
      const authorities = reviewAuthorities.map(({ authority }) => authority as AgentRequestAuthority)
        .filter((authority) => {
          const context = handleWaveReviewContext(batch.packets, authority.contextDigest);
          if (context.kind === "corrupt") {
            throw new Error(`Task ${task.id} Review Packet corruption: ${context.message}`);
          }
          return waveReviewContextTaskId(context) === task.id;
        });
      if (authorities.length !== WAVE_REVIEW_AGENTS.length) {
        throw new Error(`Task ${task.id} current Review Packet lacks the exact reviewer roster`);
      }
      if (task.review_run !== undefined) {
        const same = task.review_run.packet_id === taskRun.packetId && task.review_run.generation === taskRun.generation;
        if (same) return task;
        throw new Error(`Task ${task.id} already has a different Review Packet in progress`);
      }
      return {
        ...task,
        review_status: "pending" as const,
        review_error: undefined,
        review_evidence_failures: undefined,
        review_run: {
          generation: taskRun.generation,
          packet_id: taskRun.packetId,
          head_sha: taskRun.headSha,
          expected_agents: WAVE_REVIEW_AGENTS,
          prior_finding_ids: (task.findings ?? []).map(({ id }) => id),
          evidence: [],
          slot_authority: authorities.map((authority) => ({
            agent: authority.role,
            slot_id: authority.slotId,
            attempted: 1 as const,
          })) as never,
          workspace_scope: currentWorkspace.scope,
          workspace_head_sha: taskRun.workspaceHeadSha ?? taskRun.headSha,
          wave_gate_run_id: registration.input.wave === null ? undefined : (batch.requests[0]!.authority as AgentRequestAuthority).runId,
          wave_gate_authority_digest: registration.authorityDigest,
        },
      };
    }),
  }));
}

/** The façade preserves its public compatibility name while the producer-owned core codec parses the wire bytes. */
export const handleWaveReviewContext = readWaveReviewContext;
export type { WaveReviewContextAuthority } from '../../../core/wave-review-authority';

export function waveReviewContextTaskId(context: WaveReviewContextRead): string | null {
  return context.kind === "loaded" ? (context.value.taskRun?.taskId ?? null) : null;
}

/** Exact spec-check packet membership does not depend on open reviewer runs. */
export function specCheckSlotBelongsToWaveEpoch(
  graph: Readonly<{ wave_review_epoch?: Readonly<{
    runId: string;
    wave: number;
    batchEpoch: string;
    specCheckSlotAuthority?: Readonly<{ slot_id: string; attempted: 1 | 2 }>;
  }> }>,
  request: Readonly<{ runId: string; slotId: string; attempt: 1 | 2 }>,
  context: Readonly<{ wave: number; batchEpoch: string }>,
): boolean {
  const epoch = graph.wave_review_epoch;
  return epoch?.runId === request.runId && epoch.wave === context.wave &&
    epoch.batchEpoch === context.batchEpoch &&
    epoch.specCheckSlotAuthority?.slot_id === request.slotId &&
    epoch.specCheckSlotAuthority.attempted === request.attempt;
}

/** Apply a capture rejection only while its exact spec-check capability is current. */
export function applyCurrentSpecCheckCaptureRejection(
  graph: TaskGraph,
  request: Readonly<{ runId: string; slotId: string; attempt: 1 | 2 }>,
  context: Readonly<{ wave: number; batchEpoch: string; authorityDigest: string }>,
  specCheck: NonNullable<TaskGraph["spec_check"]>,
): Readonly<{ state: TaskGraph; applied: boolean }> {
  const active = graph.active_wave_gate;
  if (graph.current_phase !== "execute" || graph.current_wave !== context.wave ||
      active?.runId !== request.runId || active.wave !== context.wave ||
      active.authorityDigest !== context.authorityDigest ||
      !specCheckSlotBelongsToWaveEpoch(graph, request, context)) {
    return Object.freeze({ state: graph, applied: false });
  }
  return Object.freeze({
    state: {
      ...graph,
      spec_check: specCheck,
      wave_gates: reconcileWaveBlock(graph.wave_gates, graph.tasks, specCheck, context.wave),
    },
    applied: true,
  });
}

export function waveRefutationPreparation(
  handle: RunDirHandle,
  readiness: Extract<ReturnType<typeof deriveWaveReadiness>, { ok: true }>["value"],
) {
  const plan = deriveWaveRefutationPlan(readiness);
  if (!plan.ok) throw new Error(plan.error.message);
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  const slots = [];
  const packets: ContextPacket[] = [];
  const inputs: InitialSpawnRequestInput[] = [];
  const retryInputs: Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[] = [];
  for (const lens of plan.value.lenses) {
    const binding = deriveRefutationVerifierBinding(
      plan.value.runId,
      lens,
      [plan.value.findings[0].id, ...plan.value.findings.slice(1).map(({ id }) => id)],
    );
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const section = encodeByteSection("wave-refutation-authority", JSON.stringify({
        panelRunId: plan.value.runId, lens, findings: plan.value.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({ requestId, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate every Wave Finding through lens '${lens}' and emit exact refutation verdict JSON.`,
        fixedContext: [section.value], variableContext: [] });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const authority = parseAgentRequestAuthority({ runId: handle.runId, requestId, slotId: binding.value.slotId,
        program: "refutation-panel", role: "review-verifier-agent", attempt, modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest, outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw` });
      if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
      const input = { authority: authority.value, context: { digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` } } };
      if (attempt === 1) inputs.push(input);
      else retryInputs.push(Object.freeze({ input: Object.freeze(input), packet: packet.value }));
      return authority.value;
    });
    slots.push({ slotId: binding.value.slotId, attempts });
  }
  const panel = parseRefutationPanelAuthority({
    runId: handle.runId,
    identityRunId: plan.value.runId,
    findings: plan.value.findings,
    lenses: plan.value.lenses,
    verifierSlots: slots,
  });
  if (!panel.ok) throw new Error(panel.error.message);
  return { panel: panel.value, inputs, packets, retryInputs, threshold: defaultRefutationThreshold(plan.value.lenses.length) };
}

export function persistedWaveAttemptTwoCompatibilityProblem(
  attemptOne: AgentRequestAuthority,
  attemptTwo: AgentRequestAuthority,
  first: ContextPacket,
  second: ContextPacket,
): string | null {
  const requestId = parseRequestId(attemptOne.requestId.replace(/:1$/, ":2"));
  if (!requestId.ok || requestId.value === attemptOne.requestId) {
    return `Wave request ${attemptOne.requestId} cannot derive canonical attempt-2 identity`;
  }
  const expectedAuthority = parseStoredAgentRequestAuthority({
    ...attemptOne,
    requestId: requestId.value,
    attempt: 2,
    contextDigest: attemptTwo.contextDigest,
    outputSlot: {
      kind: "fixed-artifact-slot",
      path: attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"),
    },
  });
  if (!expectedAuthority.ok || !canonicalStructuralEquals(expectedAuthority.value, attemptTwo)) {
    return "persisted attempt-2 request envelope does not derive from attempt 1";
  }

  if (first.digest !== attemptOne.contextDigest || first.requestId !== attemptOne.requestId ||
      first.role !== attemptOne.role || first.requiredSkill !== (attemptOne.requiredSkill ?? "none")) {
    return "persisted attempt-1 context does not match its request authority";
  }
  if (second.digest !== attemptTwo.contextDigest || second.requestId !== attemptTwo.requestId || second.role !== first.role ||
      second.requiredSkill !== first.requiredSkill || second.outputContract !== first.outputContract ||
      !canonicalStructuralEquals(second.fixedContext, first.fixedContext)) {
    return "persisted attempt-2 context changed fixed attempt-1 authority";
  }

  const unchangedLegacyContext = canonicalStructuralEquals(second.variableContext, first.variableContext);
  const diagnostic = second.variableContext.length === first.variableContext.length + 1 &&
    canonicalStructuralEquals(second.variableContext.slice(0, -1), first.variableContext) &&
    second.variableContext.at(-1)?.label === "wave-review-attempt-1-rejection"
    ? parseWaveRetryDiagnosticSection(second.variableContext.at(-1)!.bytes)
    : ({ ok: false as const, message: "attempt-2 context carries no wave-review-attempt-1-rejection section" });
  if (!unchangedLegacyContext) {
    if (!diagnostic.ok) {
      return `persisted attempt-2 context is neither a legacy retry nor one diagnostic-rich retry (${diagnostic.message})`;
    }
  }
  return null;
}

export async function exhaustedWaveReviewerAttempts(
  handle: RunDirHandle,
  graph: TaskGraph,
  registration: RegisteredWaveGateProgram,
): Promise<Readonly<{ ok: true; value: ReadonlySet<string> }> | Readonly<{ ok: false; message: string }>> {
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const events = await handle.readEvents();
  const exhausted = new Set<string>();
  for (const task of graph.tasks.filter(({ id }) => registration.taskIds.includes(id))) {
    const run = task.review_run;
    if (run === undefined) continue;
    for (const slot of run.slot_authority ?? []) {
      if (run.evidence.some(({ agent }) => agent === slot.agent) || slot.attempted !== 2) continue;
      const attempts = issued.value.filter((candidate) =>
        candidate.program === "wave-gate" && candidate.attempt === 2 &&
        candidate.slotId === slot.slot_id && candidate.role === slot.agent);
      if (attempts.length !== 1) {
        return { ok: false, message: `Wave Gate restart requires exactly one attempt-2 authority for ${task.id}/${slot.agent}` };
      }
      const authority = attempts[0]!;
      const attemptOne = issued.value.find((candidate) => candidate.program === "wave-gate" && candidate.attempt === 1 &&
        candidate.slotId === slot.slot_id && candidate.role === slot.agent);
      if (attemptOne === undefined) return { ok: false, message: `Wave Gate restart lacks attempt-1 authority for ${task.id}/${slot.agent}` };
      const firstContext = handle.readContext(attemptOne.contextDigest);
      if (!firstContext.ok) return { ok: false, message: firstContext.error.message };
      const secondContext = handle.readContext(authority.contextDigest);
      if (!secondContext.ok) return { ok: false, message: secondContext.error.message };
      const authorityProblem = persistedWaveAttemptTwoCompatibilityProblem(
        attemptOne,
        authority,
        firstContext.value,
        secondContext.value,
      );
      if (authorityProblem !== null) {
        return { ok: false, message: `Wave Gate restart attempt-2 authority drifted for ${task.id}/${slot.agent}: ${authorityProblem}` };
      }
      const key = captureKey(slot.slot_id, 2);
      if (captured.value.has(key)) {
        const transcript = handle.readTranscriptBytes(authority);
        if (!transcript.ok) return { ok: false, message: transcript.error.message };
        const rejection = reviewerRejectionReason(task, slot.agent, transcript.value);
        if (rejection === null) {
          return {
            ok: false,
            message: `Wave Gate restart refused: ${task.id}/${slot.agent} has valid captured attempt-2 evidence; resume must apply it`,
          };
        }
        exhausted.add(key);
        continue;
      }
      const rejected = events.some(({ event }) => {
        if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
        const record = event as Record<string, unknown>;
        return record.kind === "request-capture-rejected" && record.requestId === authority.requestId &&
          record.slotId === authority.slotId && record.attempt === authority.attempt;
      });
      if (rejected) {
        const terminal = await handle.rejectCapture(authority);
        if (!terminal.ok) return { ok: false, message: terminal.error.message };
        exhausted.add(terminal.value);
      }
    }
  }
  return { ok: true, value: exhausted };
}

export async function restartWaveGateFacade(
  previousHandle: RunDirHandle,
  nextHandle: RunDirHandle,
  previousRegistration: RegisteredWaveGateProgram,
): Promise<FacadeDriveResult> {
  try {
    if (previousHandle.runId === nextHandle.runId) {
      return failed("Wave Gate restart requires a distinct fresh run directory");
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    const before = manager.load();
    const alreadyRestarted = before.active_wave_gate?.runId === nextHandle.runId;
    const completedRestart = before.wave_gate_history?.some((entry) => entry.runId === nextHandle.runId) === true;
    const existingProgram = nextHandle.readProgramRegistration();
    if (!existingProgram.ok) return failed(existingProgram.error.message);
    const storedProgramParse = existingProgram.value === null ? null : parseRegisteredFacadeProgram(existingProgram.value);
    if (storedProgramParse?.kind === "invalid") {
      return failed(`replacement run's registered program is invalid: ${storedProgramParse.message}`);
    }
    const storedProgram = storedProgramParse?.kind === "registered" ? storedProgramParse.program : null;
    if (completedRestart) {
      if (storedProgram === null || storedProgram.kind !== "wave-gate" ||
          storedProgram.restart?.previousRunId !== previousHandle.runId) {
        return failed("completed replacement lacks exact registered restart authority");
      }
      return resumeWaveGateFacade(nextHandle, storedProgram);
    }
    if (!alreadyRestarted) {
      const pristine = nextHandle.isPristine();
      if (!pristine.ok) return failed(pristine.error.message);
      if (!pristine.value) return failed("replacement Wave Gate run must be pristine before authority installation");
    }
    const exhausted = alreadyRestarted
      ? null
      : await exhaustedWaveReviewerAttempts(previousHandle, before, previousRegistration);
    if (exhausted !== null && !exhausted.ok) return failed(exhausted.message);
    const sameRegistration = (left: RegisteredWaveGateProgram, right: RegisteredWaveGateProgram): boolean =>
      left.input.wave === right.input.wave && left.authorityDigest === right.authorityDigest &&
      left.taskIds.length === right.taskIds.length && left.taskIds.every((taskId, index) => taskId === right.taskIds[index]) &&
      left.restart?.previousRunId === right.restart?.previousRunId &&
      (left.restart?.exhaustedSlots.length ?? 0) === (right.restart?.exhaustedSlots.length ?? 0) &&
      (left.restart?.exhaustedSlots.every((slot, index) => slot === right.restart?.exhaustedSlots[index]) ?? true);

    let prepared: WaveGateRestartPreparation;
    if (alreadyRestarted) {
      const active = before.active_wave_gate!;
      const stored = storedProgram;
      if (stored === null || stored.kind !== "wave-gate" || active.wave !== stored.input.wave ||
          active.authorityDigest !== stored.authorityDigest || active.terminalOutcome !== null) {
        return failed("replacement run does not own compatible registered Wave Gate authority");
      }
      if (stored.restart?.previousRunId !== previousHandle.runId) {
        return failed("replacement run registration lacks exact previous-run restart audit authority");
      }
      prepared = Object.freeze({ graph: before, registration: stored, exhaustedSlots: stored.restart.exhaustedSlots });
    } else {
      const candidate = prepareExhaustedWaveGateRestart(
        before,
        previousHandle.runId,
        previousRegistration,
        nextHandle.runId,
        nextHandle.identity.runsRoot,
        exhausted!.value,
      );
      if (!candidate.ok) return failed(candidate.message);
      if (existingProgram.value === null) {
        const registered = await nextHandle.registerProgram(candidate.value.registration);
        if (!registered.ok) return failed(registered.error.message);
      } else {
        const stored = storedProgram;
        if (stored === null || stored.kind !== "wave-gate" || !sameRegistration(stored, candidate.value.registration)) {
          return failed("replacement Wave Gate run is already registered under different authority");
        }
      }
      prepared = await manager.updateAndReturn((locked) => {
        const transition = prepareExhaustedWaveGateRestart(
          locked,
          previousHandle.runId,
          previousRegistration,
          nextHandle.runId,
          nextHandle.identity.runsRoot,
          exhausted!.value,
        );
        if (!transition.ok) throw new Error(transition.message);
        if (!sameRegistration(transition.value.registration, candidate.value.registration)) {
          throw new Error("protected Wave authority changed while restart was being installed");
        }
        return { state: transition.value.graph, value: transition.value };
      });
    }
    if (prepared.exhaustedSlots.length === 0) {
      return failed("replacement registration contains no exhausted-slot restart audit evidence");
    }
    await previousHandle.writeCheckpoint(JSON.stringify({
      schemaVersion: 1,
      kind: "wave-gate-retired",
      previousRunId: previousHandle.runId,
      replacementRunId: nextHandle.runId,
      wave: previousRegistration.input.wave,
      exhaustedSlots: prepared.exhaustedSlots,
    }));
    return resumeWaveGateFacade(nextHandle, prepared.registration);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

function sameOrphanRecoveryRegistration(
  left: RegisteredWaveGateProgram,
  right: RegisteredWaveGateProgram,
): boolean {
  return left.input.wave === right.input.wave && left.authorityDigest === right.authorityDigest &&
    left.taskIds.length === right.taskIds.length && left.taskIds.every((taskId, index) => taskId === right.taskIds[index]) &&
    left.orphanRecovery?.previousRunId === right.orphanRecovery?.previousRunId &&
    left.orphanRecovery?.previousAuthorityDigest === right.orphanRecovery?.previousAuthorityDigest;
}

/** Engine-owned recovery for a protected active run whose Run Directory is
 * gone. The shell proves filesystem/subagent facts; the pure transition is
 * re-derived under the state lock before retirement audit + replacement
 * authority are committed together. */
export async function recoverOrphanedWaveGateFacade(
  runsRoot: string,
  expected: OrphanedWaveGateRecoveryExpectation,
  nextHandle: RunDirHandle,
): Promise<FacadeDriveResult> {
  try {
    const parsedRunId = parseOrchestrationRunId(expected.runId);
    const parsedDigest = parseArtifactDigest(expected.authorityDigest);
    if (!parsedRunId.ok) return failed(parsedRunId.error.message);
    if (!parsedDigest.ok) return failed(parsedDigest.error.message);
    if (!Number.isSafeInteger(expected.wave) || expected.wave < 1) {
      return failed("orphan recovery wave must be a positive safe integer");
    }
    if (nextHandle.runId === parsedRunId.value) {
      return failed("orphan recovery requires a distinct replacement run identity");
    }
    const requestedRunsRoot = resolve(runsRoot);
    const legacyCanonicalRunsRoot = join(dirname(dirname(resolve(TASK_GRAPH_PATH))), "reviews", "wave-gate-runs");
    const manager = new StateManager(TASK_GRAPH_PATH);
    const before = manager.load();
    const authoritativeRunsRoot = before.active_wave_gate?.runsRoot ?? legacyCanonicalRunsRoot;
    if (requestedRunsRoot !== authoritativeRunsRoot) {
      return failed(`orphan recovery runs root ${requestedRunsRoot} does not match authoritative root ${authoritativeRunsRoot}`);
    }
    if (nextHandle.identity.runsRoot !== authoritativeRunsRoot) {
      return failed("replacement run must be a direct child of the authoritative Wave Gate runs root");
    }
    const inspectOrphan = () => inspectRunDirectoryEntry(
      authoritativeRunsRoot,
      join(authoritativeRunsRoot, parsedRunId.value),
    );
    const absent = inspectOrphan();
    if (!absent.ok) return failed(absent.error.message);
    if (absent.value.kind !== "absent") {
      return failed(`orphan recovery refused: authoritative Run Directory ${absent.value.reference.runDirectory} still exists`);
    }
    if (anyActiveSubagent(TASK_GRAPH_PATH)) {
      return failed("orphan recovery refused while a review or implementation subagent is active for this task graph");
    }

    const storedRaw = nextHandle.readProgramRegistration();
    if (!storedRaw.ok) return failed(storedRaw.error.message);
    const storedParse = storedRaw.value === null ? null : parseRegisteredFacadeProgram(storedRaw.value);
    if (storedParse?.kind === "invalid") {
      return failed(`replacement run's registered program is invalid: ${storedParse.message}`);
    }
    const stored = storedParse?.kind === "registered" ? storedParse.program : null;
    const replayAudit = before.orphaned_wave_gate_history?.find((audit) =>
      audit.runId === parsedRunId.value && audit.wave === expected.wave && audit.authorityDigest === parsedDigest.value &&
      audit.runsRoot === authoritativeRunsRoot && audit.runDirectory === join(authoritativeRunsRoot, parsedRunId.value) &&
      audit.replacementRunId === nextHandle.runId);
    if (before.active_wave_gate?.runId === nextHandle.runId) {
      const active = before.active_wave_gate;
      if (replayAudit === undefined || stored === null || stored.kind !== "wave-gate" ||
          stored.orphanRecovery?.previousRunId !== parsedRunId.value ||
          stored.orphanRecovery.previousAuthorityDigest !== parsedDigest.value ||
          active.wave !== expected.wave || active.authorityDigest !== stored.authorityDigest ||
          active.runsRoot !== nextHandle.identity.runsRoot ||
          replayAudit.replacementAuthorityDigest !== active.authorityDigest || active.terminalOutcome !== null) {
        return failed("replacement run lacks exact committed orphan-recovery authority");
      }
      return resumeWaveGateFacade(nextHandle, stored);
    }

    const pristine = nextHandle.isPristine();
    if (!pristine.ok) return failed(pristine.error.message);
    if (!pristine.value) return failed("replacement Wave Gate run must be pristine before orphan recovery");
    const candidate = prepareOrphanedWaveGateRecovery(before, {
      runId: parsedRunId.value,
      wave: expected.wave,
      authorityDigest: parsedDigest.value,
    }, authoritativeRunsRoot, nextHandle.runId, nextHandle.identity.runsRoot);
    if (!candidate.ok) return failed(candidate.message);
    if (storedRaw.value === null) {
      const registered = await nextHandle.registerProgram(candidate.value.registration);
      if (!registered.ok) return failed(registered.error.message);
    } else if (stored === null || stored.kind !== "wave-gate" ||
        !sameOrphanRecoveryRegistration(stored, candidate.value.registration)) {
      return failed("replacement Wave Gate run is already registered under different authority");
    }

    const committed = await manager.updateAndReturn((locked) => {
      const lockedAbsence = inspectOrphan();
      if (!lockedAbsence.ok) throw new Error(lockedAbsence.error.message);
      if (lockedAbsence.value.kind !== "absent") {
        throw new Error("authoritative Run Directory reappeared before orphan recovery could commit");
      }
      if (anyActiveSubagent(TASK_GRAPH_PATH)) {
        throw new Error("a review or implementation subagent became active before orphan recovery could commit");
      }
      const transition = prepareOrphanedWaveGateRecovery(locked, {
        runId: parsedRunId.value,
        wave: expected.wave,
        authorityDigest: parsedDigest.value,
      }, authoritativeRunsRoot, nextHandle.runId, nextHandle.identity.runsRoot);
      if (!transition.ok) throw new Error(transition.message);
      if (!sameOrphanRecoveryRegistration(transition.value.registration, candidate.value.registration)) {
        throw new Error("protected Wave authority changed while orphan recovery was being installed");
      }
      return { state: transition.value.graph, value: transition.value };
    });
    return resumeWaveGateFacade(nextHandle, committed.registration);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

export async function startWaveGateFacade(
  handle: RunDirHandle,
  input: RegisteredWaveGateProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const manager = new StateManager(TASK_GRAPH_PATH);
    const initial = manager.load();
    const wave = input.wave ?? initial.current_wave;
    if (initial.current_phase !== "execute" || wave === undefined || wave !== initial.current_wave) {
      return waveBlocked(handle, "wave-gate start requires exact protected execute/current_wave authority");
    }
    const taskIds = initial.tasks.filter((task) => task.wave === wave).map(({ id }) => id);
    if (taskIds.length === 0) return waveBlocked(handle, `wave ${wave} has no tasks`);
    const authorityDigest = waveGateAuthorityDigest(wave, taskIds, initial);
    await manager.registerActiveWaveGate({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: handle.runId,
      wave,
      authorityDigest,
      revision: 0,
      runsRoot: handle.identity.runsRoot,
      terminalOutcome: null,
    });
    const registration: RegisteredWaveGateProgram = Object.freeze({
      schemaVersion: 1, kind: "wave-gate", input: Object.freeze({ wave }),
      taskIds: Object.freeze(taskIds), authorityDigest,
    });
    const stored = await handle.registerProgram(registration);
    if (!stored.ok) return failed(stored.error.message);
    return resumeWaveGateFacade(handle, registration);
  } catch (error) {
    return waveBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

export async function markWaveSpecCheckRetryIssued(
  manager: StateManager,
  authority: AgentRequestAuthority,
  batchEpoch: string,
): Promise<void> {
  if (authority.role !== "spec-check-invoker" || authority.attempt !== 2) {
    throw new Error("spec-check retry issuance requires exact attempt-2 authority");
  }
  await manager.update((locked) => {
    const epoch = locked.wave_review_epoch;
    const slot = epoch?.specCheckSlotAuthority;
    if (epoch === undefined || epoch.runId !== authority.runId || epoch.batchEpoch !== batchEpoch ||
        locked.current_phase !== "execute" || locked.current_wave !== epoch.wave ||
        locked.active_wave_gate?.runId !== authority.runId || locked.active_wave_gate.wave !== epoch.wave ||
        slot === undefined || slot.slot_id !== authority.slotId) {
      throw new Error("spec-check retry authority does not match the exact current Wave review epoch slot");
    }
    if (slot.attempted === 2) return locked;
    return {
      ...locked,
      wave_review_epoch: {
        ...epoch,
        specCheckSlotAuthority: { ...slot, attempted: 2 },
      },
    };
  });
}

export async function applyWaveFacadeSubmission(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  raw: string,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  try {
    const packet = handle.readContext(authority.contextDigest);
    if (!packet.ok) return { ok: false, message: packet.error.message };
    const parsedContext = handleWaveReviewContext([packet.value], authority.contextDigest);
    if (parsedContext.kind === "absent") return { ok: false, message: "Wave request context lacks subject authority" };
    if (parsedContext.kind === "corrupt") return { ok: false, message: parsedContext.message };
    const context = parsedContext.value;
    if (context.subject.role !== authority.role || context.runId !== authority.runId) {
      return { ok: false, message: "Wave request role drifted from immutable subject authority" };
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    if (authority.role === "spec-check-invoker") {
      const parsed = parseSpecCheckOutput(raw);
      const wave = context.wave;
      const batchEpoch = context.batchEpoch;
      const resolution = reconcileSpecCheck(parsed, wave, new Date().toISOString());
      await manager.update((locked) => {
        const epoch = locked.wave_review_epoch;
        if (locked.current_wave !== wave || locked.active_wave_gate?.runId !== authority.runId ||
            locked.active_wave_gate.authorityDigest !== context.authorityDigest ||
            epoch?.runId !== authority.runId || epoch.wave !== wave || epoch.batchEpoch !== batchEpoch ||
            epoch.specCheckSlotAuthority?.slot_id !== authority.slotId ||
            epoch.specCheckSlotAuthority.attempted !== authority.attempt) {
          const expected = `${locked.current_wave}/${locked.active_wave_gate?.runId ?? "none"}/${locked.active_wave_gate?.authorityDigest ?? "none"}/${epoch?.runId ?? "none"}/${epoch?.wave ?? "none"}/${(epoch?.batchEpoch ?? "none").slice(0, 12)}`;
          throw new Error(`Wave spec-check request ${authority.requestId} does not belong to the exact current review epoch (expected current_wave/runId/digest/epoch-runId/epoch-wave/epoch-batch: ${expected}; request wave ${wave}, digest ${context.authorityDigest}, runId ${authority.runId}, batch ${batchEpoch.slice(0, 12)})`);
        }
        return {
          ...locked,
          spec_check: resolution.specCheck,
          wave_gates: reconcileWaveBlock(locked.wave_gates, locked.tasks, resolution.specCheck, wave),
        };
      });
      return { ok: true };
    }
    const taskId = context.subject.taskId;
    if (typeof taskId !== "string") return { ok: false, message: "Wave reviewer request lacks Task identity" };
    await manager.update((locked) => {
      const target = locked.tasks.find((task) => task.id === taskId);
      if (target === undefined) {
        throw new Error(`Wave reviewer task ${taskId} is no longer in the protected task graph`);
      }
      const epoch = locked.wave_review_epoch;
      const run = target.review_run;
      const taskRun = context.taskRun;
      const slot = run?.slot_authority?.find((candidate) => candidate.agent === authority.role);
      if (run === undefined || taskRun === null || taskRun === undefined ||
          taskRun.taskId !== target.id || taskRun.generation !== run.generation ||
          taskRun.packetId !== run.packet_id || taskRun.headSha !== run.head_sha ||
          context.batchEpoch !== run.head_sha || epoch?.runId !== authority.runId ||
          epoch.wave !== context.wave || epoch.batchEpoch !== context.batchEpoch || slot === undefined ||
          slot.slot_id !== authority.slotId || slot.attempted !== authority.attempt) {
        throw new Error(`Wave reviewer request ${authority.requestId} does not belong to Task ${taskId}'s exact current Review Packet slot`);
      }
      const resolution = constrainReviewResolutionToScope(
        resolveTaskReviewFindings(raw, authority.role, run, target.review_generation),
        [...(target.file_list ?? []), ...(target.files_modified ?? [])],
      );
      const tasks = locked.tasks.map((task) =>
        task.id === taskId ? applyReviewResolution(task, resolution, slot) : task);
      return {
        ...locked,
        tasks,
        wave_gates: reconcileWaveBlock(locked.wave_gates, tasks, locked.spec_check, context.wave),
      };
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Upper bound on same-invocation re-derivations of the Wave Gate reducer.
 * Every legitimate recursion consumes durable progress (a captured retry
 * applied, an accepted spec-check retry, a tally that retired a finding), each
 * at most once per resume invocation, so a depth beyond this is a reducer
 * defect, not a large run. The bound converts a hypothetical spin back into a
 * loud blocked diagnostic instead of an engine hang.
 */
const MAX_WAVE_GATE_REDERIVATIONS = 64;

export async function resumeWaveGateFacade(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  depth = 0,
): Promise<FacadeDriveResult> {
  try {
    if (depth > MAX_WAVE_GATE_REDERIVATIONS) {
      return waveBlocked(handle, `Wave Gate resume exceeded ${MAX_WAVE_GATE_REDERIVATIONS} re-derivations without durable progress; refusing to spin`);
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    const graph = manager.load();
    const terminal = await handle.readCheckpoint();
    if (terminal !== null) {
      let raw: unknown;
      try { raw = JSON.parse(terminal); }
      catch (error) { return waveBlocked(handle, `Wave Gate checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return waveBlocked(handle, "Wave Gate checkpoint must be a typed object");
      }
      const record = raw as Record<string, unknown>;
      if (record.kind === "wave-gate-done") {
        if (!exactObject(record, ["schemaVersion", "kind", "receipt"]) || record.schemaVersion !== 1) {
          return waveBlocked(handle, "terminal Wave Gate checkpoint has invalid schema");
        }
        const receipt = record.receipt;
        const history = graph.wave_gate_history?.find((entry) => entry.runId === handle.runId);
        if (history === undefined || !canonicalStructuralEquals(history.completionReceipt, receipt)) {
          return waveBlocked(handle, "terminal Wave Gate checkpoint does not match protected completion history");
        }
        return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt } };
      }
      return waveBlocked(handle, `unknown or non-terminal Wave Gate checkpoint kind: ${String(record.kind ?? "missing")}`);
    }
    // Completion crash-window recovery: the graph commit is atomic and durable
    // BEFORE the terminal checkpoint is written, so a crash between
    // commitActiveWaveGateCompletion and writeCheckpoint leaves the run with a
    // retired active authority, a completed wave_gate_history entry, and NO
    // checkpoint. The history entry is the authoritative completion record —
    // heal the missing checkpoint from it and report done instead of blocking
    // forever on the already-retired active authority.
    const completed = graph.wave_gate_history?.find((entry) =>
      entry.runId === handle.runId && entry.wave === registration.input.wave &&
      entry.authorityDigest === registration.authorityDigest);
    if (completed !== undefined) {
      await handle.writeCheckpoint(JSON.stringify({
        schemaVersion: 1,
        kind: "wave-gate-done",
        receipt: completed.completionReceipt,
      }));
      return { ok: true, action: { kind: "done", runId: handle.runId, outcome: completed.completionReceipt } };
    }
    const active = graph.active_wave_gate;
    if (active === undefined || active.runId !== handle.runId || active.wave !== registration.input.wave ||
        active.authorityDigest !== registration.authorityDigest || active.terminalOutcome !== null) {
      return waveBlocked(handle, "protected active Wave Gate authority differs from the registered façade run");
    }
    const readiness = deriveWaveReadiness(graph, currentWaveGateDeps(graph, handle.runDirectory));
    if (!readiness.ok) return waveBlocked(handle, readiness.error.reasons.map(({ message }) => message).join("; "));
    const preliminary = readiness.value.gateDecision.checks.slice(0, 4).find((check) => !check.passed);
    if (preliminary !== undefined && !preliminary.passed) return waveBlocked(handle, preliminary.reason);

    if (graph.verification_manifest !== undefined) {
      const ensured = await ensureWaveCompletionSuite({ handle, manager, graph, registration });
      if (!ensured.ok) {
        return {
          ok: true,
          action: {
            kind: "blocked",
            runId: handle.runId,
            diagnostic: ensured.error.diagnostic,
          },
        };
      }
      if (ensured.value.disposition === "installed") {
        return resumeWaveGateFacade(handle, registration, depth + 1);
      }
    }

    const issued = handle.readIssuedRequests();
    const captured = handle.readCapturedAttempts();
    if (!issued.ok) return waveBlocked(handle, issued.error.message);
    if (!captured.ok) return waveBlocked(handle, captured.error.message);
    const initialBatchMissingOrPartial = graph.wave_review_epoch === undefined &&
      graph.tasks.every((task) => !registration.taskIds.includes(task.id) || task.review_run === undefined);
    if (initialBatchMissingOrPartial) {
      const batch = waveRequests(handle, registration, graph, 1);
      // Publication is deterministic and idempotent per context/request slot.
      // Re-running the complete effect reconciles a crash after any strict
      // prefix of requests was reserved instead of treating partial issuance
      // as a corrupt batch and stranding the active replacement authority.
      const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
      if (!published.ok) return failed(published.message);
      const action = published.action as { requests: readonly Record<string, unknown>[] };
      await installWaveReviewRuns(manager, registration, batch);
      return { ok: true, action: {
        ...action,
        requests: action.requests.map((request, index) => ({
          ...request,
          task: index === 0
            ? `${String(request.task)}\nSpec-check Wave ${registration.input.wave}.`
            : `${String(request.task)}\nReview Task ${registration.taskIds[Math.floor((index - 1) / WAVE_REVIEW_AGENTS.length)]}.`,
        })),
      } };
    }

    let refreshed = manager.load();
    const hasCollectingPacket = refreshed.tasks.some((task) =>
      registration.taskIds.includes(task.id) && task.review_run !== undefined);
    const needsFreshPacket = refreshed.tasks.some((task) =>
      registration.taskIds.includes(task.id) && task.review_run === undefined &&
      task.review_status !== "passed" && task.review_status !== "blocked");
    if (!hasCollectingPacket && needsFreshPacket) {
      const batch = waveRequests(handle, registration, refreshed, 1);
      await installWaveReviewRuns(manager, registration, batch);
      const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
      return published.ok ? { ok: true, action: published.action } : failed(published.message);
    }

    refreshed = manager.load();
    const currentRuns = refreshed.tasks.filter((task) =>
      registration.taskIds.includes(task.id) && task.review_run !== undefined);
    let currentIssued = issued.value;
    if (currentRuns.length > 0) {
      const epoch = refreshed.wave_review_epoch;
      if (epoch?.runId !== handle.runId || epoch.wave !== registration.input.wave) {
        return waveBlocked(handle, "active Wave Review Packets lack exact persisted batch epoch authority");
      }
      const candidates: { authority: AgentRequestAuthority; packet: ContextPacket; context: WaveReviewContextRead }[] = [];
      for (const authority of issued.value.filter((request) => request.program === "wave-gate" && request.attempt === 1)) {
        const read = handle.readContext(authority.contextDigest);
        if (!read.ok) return waveBlocked(handle, read.error.message);
        const context = handleWaveReviewContext([read.value], authority.contextDigest);
        if (context.kind === "corrupt") {
          return waveBlocked(handle, `${context.message} (request ${authority.requestId})`);
        }
        if (context.kind === "loaded" && context.value.batchEpoch === epoch.batchEpoch) {
          candidates.push({ authority, packet: read.value, context });
        }
      }
      const rank = (candidate: typeof candidates[number]): number => {
        if (candidate.authority.role === "spec-check-invoker") return 0;
        const taskIndex = registration.taskIds.indexOf(waveReviewContextTaskId(candidate.context) ?? "");
        const reviewerIndex = WAVE_REVIEW_AGENTS.indexOf(candidate.authority.role as typeof WAVE_REVIEW_AGENTS[number]);
        return taskIndex < 0 || reviewerIndex < 0 ? Number.MAX_SAFE_INTEGER : 1 + taskIndex * WAVE_REVIEW_AGENTS.length + reviewerIndex;
      };
      candidates.sort((left, right) => rank(left) - rank(right));
      const expectedCount = 1 + registration.taskIds.length * WAVE_REVIEW_AGENTS.length;
      if (candidates.length !== expectedCount || candidates.some((candidate, index) => rank(candidate) !== index)) {
        const expectedBatch = waveRequests(handle, registration, refreshed, 1);
        if (expectedBatch.batchEpoch !== epoch.batchEpoch) {
          return waveBlocked(handle, "persisted current Wave review batch differs from deterministic protected authority");
        }
        const republished = await publishInitialBatch(
          handle,
          expectedBatch.requests,
          expectedBatch.packets,
          "wave-gate-current",
        );
        if (!republished.ok) return failed(republished.message);
        return { ok: true, action: republished.action };
      }
      const inputs = candidates.map(({ authority }) => Object.freeze({
        authority,
        context: Object.freeze({
          digest: authority.contextDigest,
          slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
        }),
      }));
      const recovered = durableRefutationRequests(
        handle, inputs, publicationResolver(handle), "wave-gate-current",
      );
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      if (recovered.kind === "found") {
        currentIssued = Object.freeze(recovered.requests.map(({ authority }) => authority));
      } else {
        const published = await publishInitialBatch(
          handle, inputs, candidates.map(({ packet }) => packet), "wave-gate-current",
        );
        if (!published.ok) return failed(published.message);
        currentIssued = Object.freeze(published.requests.map(({ authority }) => authority));
      }
    }
    // Read and classify every current context once. Packet-membership filters
    // consume this cache rather than translating a later I/O failure into
    // `absent` or racing a second read against the pre-scan.
    const currentPacketMembership = new Map<string, boolean>();
    for (const authority of currentIssued.filter((request) => request.program === "wave-gate")) {
      const contextRead = handle.readContext(authority.contextDigest);
      if (!contextRead.ok) return waveBlocked(handle, contextRead.error.message);
      const context = handleWaveReviewContext([contextRead.value], authority.contextDigest);
      if (context.kind === "corrupt") {
        return waveBlocked(handle, `${context.message} (request ${authority.requestId})`);
      }
      if (context.kind === "absent") {
        currentPacketMembership.set(authority.requestId, false);
        continue;
      }
      if (authority.role === "spec-check-invoker") {
        currentPacketMembership.set(
          authority.requestId,
          specCheckSlotBelongsToWaveEpoch(refreshed, authority, context.value),
        );
        continue;
      }
      const taskRun = context.value.taskRun;
      const task = taskRun === null ? undefined : currentRuns.find(({ id }) => id === taskRun.taskId);
      currentPacketMembership.set(
        authority.requestId,
        taskRun !== null && task?.review_run?.packet_id === taskRun.packetId &&
          task.review_run.generation === taskRun.generation &&
          task.review_run.slot_authority?.some(({ agent, slot_id, attempted }) =>
            agent === authority.role && slot_id === authority.slotId && attempted === authority.attempt) === true,
      );
    }
    const belongsToCurrentPacket = (request: AgentRequestAuthority): boolean =>
      currentPacketMembership.get(request.requestId) === true;

    // Transcript capture is durable before semantic application. Reconcile the
    // crash window idempotently under exact current packet/slot authority.
    for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" &&
      belongsToCurrentPacket(authority) && captured.value.has(captureKey(authority.slotId, authority.attempt)))) {
      const now = manager.load();
      if (request.role === "spec-check-invoker" && now.spec_check?.wave === registration.input.wave &&
          now.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED") continue;
      const contextRead = handle.readContext(request.contextDigest);
      if (!contextRead.ok) return waveBlocked(handle, contextRead.error.message);
      const context = handleWaveReviewContext([contextRead.value], request.contextDigest);
      if (context.kind === "corrupt") {
        return waveBlocked(handle, `${context.message} (request ${request.requestId})`);
      }
      const taskId = context.kind === "loaded" ? context.value.taskRun?.taskId : undefined;
      if (request.role !== "spec-check-invoker") {
        const task = now.tasks.find(({ id }) => id === taskId);
        if (task?.review_run === undefined || task.review_run.evidence.some(({ agent }) => agent === request.role)) continue;
      }
      const bytes = handle.readTranscriptBytes(request);
      if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
      const applied = await applyWaveFacadeSubmission(handle, request, Buffer.from(bytes.value).toString("utf8"));
      if (!applied.ok) return waveBlocked(handle, `captured Wave evidence could not be reconciled: ${applied.message}`);
    }

    // A durable harness capture rejection is a completed FAILED semantic
    // attempt, not an invitation to respawn attempt 1 forever. Terminalize the
    // slot and project a typed evidence failure so ordinary attempt-2 recovery
    // issues the diagnostic-rich retry.
    for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
      belongsToCurrentPacket(authority) && !captured.value.has(captureKey(authority.slotId, authority.attempt)))) {
      const rejection = await durableCaptureRejection(handle, request);
      if (rejection === null) continue;
      const terminal = await handle.rejectCapture(request);
      if (!terminal.ok) return waveBlocked(handle, terminal.error.message);
      const contextRead = handle.readContext(request.contextDigest);
      if (!contextRead.ok) return waveBlocked(handle, contextRead.error.message);
      const context = handleWaveReviewContext([contextRead.value], request.contextDigest);
      if (context.kind === "corrupt") {
        return waveBlocked(handle, `${context.message} (request ${request.requestId})`);
      }
      if (request.role === "spec-check-invoker") {
        if (context.kind !== "loaded") {
          return waveBlocked(handle, "rejected spec-check request lacks exact Wave authority");
        }
        const resolution = reconcileSpecCheck(
          parseSpecCheckOutput(""),
          context.value.wave,
          new Date().toISOString(),
        );
        await manager.updateAndReturn((locked) => {
          const applied = applyCurrentSpecCheckCaptureRejection(
            locked,
            request,
            context.value,
            resolution.specCheck,
          );
          return { state: applied.state, value: applied.applied };
        });
      } else {
        const taskRun = context.kind === "loaded" ? context.value.taskRun : null;
        if (context.kind !== "loaded" || taskRun === null) {
          return waveBlocked(handle, "rejected reviewer request lacks exact Task authority");
        }
        await manager.update((locked) => {
          const target = locked.tasks.find(({ id }) => id === taskRun.taskId);
          const run = target?.review_run;
          const slot = run?.slot_authority?.find(({ agent }) => agent === request.role);
          const epoch = locked.wave_review_epoch;
          const active = locked.active_wave_gate;
          if (locked.current_phase !== "execute" || locked.current_wave !== context.value.wave ||
              active?.runId !== request.runId || active.wave !== context.value.wave ||
              active.authorityDigest !== context.value.authorityDigest ||
              epoch?.runId !== request.runId || epoch.wave !== context.value.wave ||
              epoch.batchEpoch !== context.value.batchEpoch || run === undefined ||
              run.generation !== taskRun.generation || run.packet_id !== taskRun.packetId ||
              run.head_sha !== taskRun.headSha || slot?.slot_id !== request.slotId ||
              slot.attempted !== request.attempt) return locked;
          const resolution = {
            kind: "evidence-failed" as const,
            agent: request.role,
            message: `attempt 1 capture rejected: ${rejection}`,
          };
          return {
            ...locked,
            tasks: locked.tasks.map((task) => task.id === taskRun.taskId
              ? applyReviewResolution(task, resolution, slot)
              : task),
          };
        });
      }
    }

    // Only current Wave review requests may outrank Review Packet recovery.
    // Refutation requests are resumed below, after every packet has closed.
    const rejectedInitials = new Set<string>();
    for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" && authority.attempt === 1)) {
      if (await durableCaptureRejection(handle, request) !== null) rejectedInitials.add(request.requestId);
    }
    const settledSpecCheck = refreshed.spec_check?.wave === registration.input.wave &&
      refreshed.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED";
    const uncapturedInitialReviews = currentIssued.filter((request) => request.program === "wave-gate" && request.attempt === 1 &&
      belongsToCurrentPacket(request) && !(request.role === "spec-check-invoker" && settledSpecCheck) &&
      !captured.value.has(captureKey(request.slotId, request.attempt)) &&
      !rejectedInitials.has(request.requestId));
    if (uncapturedInitialReviews.length > 0) {
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: uncapturedInitialReviews.map((authority) => ({
          authority,
          context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
          task: renderSpawnTask(handle, authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request."),
        })),
      } };
    }

    refreshed = manager.load();
    const collecting = refreshed.tasks.some((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined);
    if (collecting) {
      const retries = await currentWaveTaskReviewRetries(handle, registration, refreshed, currentIssued);
      if (retries.length === 0) return waveBlocked(handle, "active Wave Review Packets have no recoverable outstanding reviewer slots");
      const resolver = publicationResolver(handle);
      const durableRequests: SpawnRequest[] = [];
      for (const retry of retries) {
        const label = `wave-gate-retry:${retry.slotId}`;
        const recovered = durableRefutationRequests(handle, [retry.request], resolver, label);
        if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
        if (recovered.kind === "found") {
          durableRequests.push(...recovered.requests);
          continue;
        }
        const published = await publishInitialBatch(handle, [retry.request], [retry.packet], label);
        if (!published.ok) return failed(published.message);
        durableRequests.push(...published.requests);
      }
      await markWaveTaskReviewRetriesIssued(manager, retries);
      const spawnRetries = (requests: readonly SpawnRequest[]): FacadeDriveResult => ({ ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: requests.map((request) => {
          const retry = retries.find(({ slotId }) => slotId === request.authority.slotId);
          return {
            ...request,
            task: [
              renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave Review Packet slot."),
              retry?.retryDiagnostic ?? "Attempt 1 was rejected; correct the packet evidence contract.",
            ].join("\n"),
          };
        }),
      } });
      const captureRejected: { request: SpawnRequest; rejection: string }[] = [];
      for (const request of durableRequests) {
        const rejection = await durableCaptureRejection(handle, request.authority);
        if (rejection !== null) captureRejected.push({ request, rejection });
      }
      const capturedRetries = durableRequests.filter(({ authority }) =>
        captured.value.has(captureKey(authority.slotId, authority.attempt)));
      for (const request of capturedRetries) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        const applied = await applyWaveFacadeSubmission(handle, request.authority, Buffer.from(bytes.value).toString("utf8"));
        if (!applied.ok) return waveBlocked(handle, `captured Wave retry could not be reconciled: ${applied.message}`);
      }
      const afterReplay = manager.load();
      const packetRejected = capturedRetries.filter(({ authority }) => {
        const retry = retries.find(({ slotId }) => slotId === authority.slotId);
        const task = retry === undefined ? undefined : afterReplay.tasks.find(({ id }) => id === retry.taskId);
        return retry === undefined || (task?.review_run !== undefined &&
          !task.review_run.evidence.some(({ agent }) => agent === retry.agent));
      });
      const rejectedRequestIds = new Set(captureRejected.map(({ request }) => request.authority.requestId));
      const pendingRetries = durableRequests.filter(({ authority }) =>
        !captured.value.has(captureKey(authority.slotId, authority.attempt)) &&
        !rejectedRequestIds.has(authority.requestId));
      // A terminal retry in one slot must not hide exact attempt-2 authority
      // that is still safely spawnable in another. Drain every pending slot
      // before reporting exhaustion, so restart sees one coherent terminal
      // reviewer generation rather than a mixed exhausted/pending state.
      if (pendingRetries.length > 0) return spawnRetries(pendingRetries);
      if (captureRejected.length > 0) {
        return waveBlocked(handle, `Wave reviewer attempt 2 exhausted after capture rejection: ${captureRejected[0]!.rejection}`);
      }
      if (packetRejected.length > 0) {
        return waveBlocked(handle, `Wave reviewer attempt 2 exhausted without accepted packet evidence: ${packetRejected.map(({ authority }) => authority.role).join(", ")}`);
      }
      if (capturedRetries.length > 0) return resumeWaveGateFacade(handle, registration, depth + 1);
      return waveBlocked(handle, "active Wave Review Packets have no recoverable attempt-2 reviewer slots");
    }

    refreshed = manager.load();
    const specAccepted = refreshed.spec_check?.wave === registration.input.wave &&
      refreshed.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED";
    if (!specAccepted) {
      // Attempt-2 must derive from the CURRENT epoch's attempt-1, never the
      // first spec-check authority in the issued journal. The journal spans
      // every batch epoch a run has installed, and in this non-collecting
      // phase currentIssued is the unfiltered journal: a role-only find picks
      // an OLD epoch's authority whose fixed packet binds an older batchEpoch,
      // and the captured retry then fails the exact-epoch gate in
      // applyWaveFacadeSubmission as a durable terminal block (loom#20 Finding
      // 5). Reviewer retries are immune because their attempt-1 lookup is keyed
      // by current-packet slot identity; mirror that binding here by matching
      // the persisted epoch's batchEpoch before deriving the attempt-2 context.
      const epoch = refreshed.wave_review_epoch;
      // Linear scan so an unreadable/corrupt context can DEGRADE to a wave
      // verdict (like the sibling candidate scan above) instead of throwing
      // out of the facade: a pruned context packet must not hard-fail resume.
      // Fail-closed note: the batchEpoch lives INSIDE the context, so the
      // epoch cannot be filtered before reading — every attempt-1 context is
      // read, and a corrupt context for ANY candidate attempt-1 (even a stale
      // one from an older epoch) blocks resume rather than risking a retry
      // derived from an identity that cannot be proven current. That is the
      // same judgment applyWaveFacadeSubmission would make on the retry
      // packet, surfaced earlier with a better diagnostic.
      let attemptOne: AgentRequestAuthority | undefined;
      if (epoch !== undefined) {
        for (const authority of currentIssued) {
          if (authority.program !== "wave-gate" || authority.attempt !== 1 || authority.role !== "spec-check-invoker") continue;
          const contextRead = handle.readContext(authority.contextDigest);
          if (!contextRead.ok) return waveBlocked(handle, contextRead.error.message);
          const context = handleWaveReviewContext([contextRead.value], authority.contextDigest);
          if (context.kind === "corrupt") return waveBlocked(handle, context.message);
          if (context.kind === "loaded" && context.value.batchEpoch === epoch.batchEpoch) {
            attemptOne = authority;
            break;
          }
        }
      }
      if (attemptOne === undefined || epoch === undefined) {
        return waveBlocked(handle, "current Wave spec-check has no issued attempt-1 authority");
      }
      const retry = deriveWaveAttemptTwo(handle, attemptOne);
      const recovered = durableRefutationRequests(
        handle, [retry.request], publicationResolver(handle), "wave-gate-spec-retry",
      );
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      let durable: SpawnRequest;
      if (recovered.kind === "found") durable = recovered.requests[0]!;
      else {
        const published = await publishInitialBatch(handle, [retry.request], [retry.packet], "wave-gate-spec-retry");
        if (!published.ok) return failed(published.message);
        durable = published.requests[0]!;
      }
      await markWaveSpecCheckRetryIssued(manager, durable.authority, epoch.batchEpoch);
      const captureRejection = await durableCaptureRejection(handle, durable.authority);
      if (captureRejection !== null) {
        return waveBlocked(handle, `Wave spec-check attempt 2 exhausted after capture rejection: ${captureRejection}`);
      }
      if (captured.value.has(captureKey(durable.authority.slotId, durable.authority.attempt))) {
        const bytes = handle.readTranscriptBytes(durable.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        const applied = await applyWaveFacadeSubmission(handle, durable.authority, Buffer.from(bytes.value).toString("utf8"));
        if (!applied.ok) return waveBlocked(handle, `captured Wave spec-check retry could not be reconciled: ${applied.message}`);
        const accepted = manager.load().spec_check;
        if (accepted?.wave !== registration.input.wave || accepted.verdict === "EVIDENCE_CAPTURE_FAILED") {
          return waveBlocked(handle, "Wave spec-check attempt 2 exhausted without accepted current-wave evidence");
        }
        return resumeWaveGateFacade(handle, registration, depth + 1);
      }
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: [{
          ...durable,
          task: renderSpawnTask(handle, durable.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave spec-check slot."),
        }],
      } };
    }

    const current = deriveWaveReadiness(refreshed, currentWaveGateDeps(refreshed, handle.runDirectory));
    if (!current.ok) return waveBlocked(handle, current.error.reasons.map(({ message }) => message).join("; "));
    if (current.value.facts.findingCounts.kind === "known" && current.value.facts.findingCounts.value.activeCritical > 0) {
      const preparation = waveRefutationPreparation(handle, current.value);
      const resolver = publicationResolver(handle);
      const recovered = durableRefutationRequests(handle, preparation.inputs, resolver, "wave-refutation");
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      if (recovered.kind === "absent") {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "wave-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const requests = recovered.requests;
      const panelCaptured = handle.readCapturedAttempts();
      if (!panelCaptured.ok) return waveBlocked(handle, panelCaptured.error.message);
      const missing = requests.filter((request) => !panelCaptured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) {
        return {
          ok: true,
          action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(handle, missing, false) },
        };
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      for (const request of requests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        let submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return waveBlocked(handle, submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const retry = await recoverOrPublishRefutationRetry(
            handle, retryAuthority, preparation.retryInputs, resolver, "wave-refutation",
          );
          if (!retry.ok) return waveBlocked(handle, retry.message);
          const attempts = handle.readCapturedAttempts();
          if (!attempts.ok) return waveBlocked(handle, attempts.error.message);
          if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
            return { ok: true, action: {
              kind: "spawn-batch", runId: handle.runId,
              requests: executableRefutationRequests(
                handle, [retry.request], false, refutationRejectionDiagnostic(submitted.value.recordedEvent),
              ),
            } };
          }
          const retryBytes = handle.readTranscriptBytes(retry.request.authority);
          if (!retryBytes.ok) return waveBlocked(handle, retryBytes.error.message);
          submitted = submitRefutationVerdict(
            panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return waveBlocked(handle, submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.action?.kind === "refutation-blocked") {
            return waveBlocked(handle, submitted.value.action.diagnostic.message);
          }
        }
      }
      const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completed.ok || completed.value.state.stage !== "done") {
        return waveBlocked(handle, completed.ok ? "Wave Refutation Panel did not reach done" : completed.error.message);
      }
      const donePanel = completed.value.state;
      const refutingOutcomes = donePanel.decision.outcomes.filter(
        (outcome): outcome is Extract<FindingOutcome, { survives: false }> => !outcome.survives,
      );
      if (refutingOutcomes.length > 0) {
        await manager.update((locked) => {
          const tasks = locked.tasks.map((task) => applyFindingOutcomes(task, donePanel.decision.outcomes));
          return {
            ...locked,
            tasks,
            wave_gates: reconcileWaveBlock(locked.wave_gates, tasks, locked.spec_check, registration.input.wave!),
          };
        });
        // The tally retired at least one finding, so the derived snapshot
        // changed: re-derive readiness under it (the wave gate may now pass).
        return resumeWaveGateFacade(handle, registration, depth + 1);
      }
      // Every adjudicated critical was UPHELD. `applyFindingOutcomes` records
      // only refutations, so re-deriving now would reproduce the identical
      // readiness snapshot, the identical deterministic tally, and recurse
      // forever at ~100% CPU (loom#20 Finding 4) — a surviving critical is
      // exactly the `checkCriticalFindings` failure the gate must surface as
      // blocked until remediation retires it. Fall through to the advisory and
      // gate-decision steps below with the unchanged snapshot.
    }
    const pendingDrive = deriveWaveGateDriveStep(current.value, false);
    if (!pendingDrive.ok) return waveBlocked(handle, pendingDrive.error.message);
    let drive = pendingDrive.value;
    if (drive.kind === "await-advisory-decision") {
      const advisoryDrive = drive;
      const decisions = await handle.readEvents();
      const advisoryApproved = decisions.some(({ event }) => {
        if (typeof event !== "object" || event === null) return false;
        const record = event as Record<string, unknown>;
        const decision = record.decision;
        return record.kind === "user-decision-recorded" &&
          record.decisionId === advisoryDrive.material.requestId &&
          typeof decision === "object" && decision !== null && !Array.isArray(decision) &&
          Object.keys(decision).length === 1 && (decision as Record<string, unknown>).kind === "approve";
      });
      if (!advisoryApproved) {
        const published = await publishWaveAdvisoryDecisionRequest(handle, advisoryDrive.material);
        return published.ok
          ? { ok: true, action: { kind: "await-user", runId: handle.runId, request: published.request } }
          : waveBlocked(handle, published.message);
      }
      const approvedDrive = deriveWaveGateDriveStep(current.value, true);
      if (!approvedDrive.ok) return waveBlocked(handle, approvedDrive.error.message);
      drive = approvedDrive.value;
    }
    if (drive.kind === "blocked") return waveBlocked(handle, drive.message);
    if (drive.kind !== "ready-to-complete") {
      return waveBlocked(handle, `Wave Gate lifecycle produced unexpected drive step ${drive.kind}`);
    }
    const lint = runFullTierWaveLint(current.value.waveTasks);
    if (lint.kind === "block") return waveBlocked(handle, lint.message);
    const committed = await manager.commitActiveWaveGateCompletion((locked) => {
      const lockedReadiness = deriveWaveReadiness(locked, currentWaveGateDeps(locked, handle.runDirectory));
      return lockedReadiness.ok ? commitWaveGateCompletion(lockedReadiness.value) : {
        ok: false as const,
        error: { kind: "wave-completion-commit-rejected" as const, message: lockedReadiness.error.reasons.map(({ message }) => message).join("; ") },
      };
    });
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, kind: "wave-gate-done", receipt: committed.receipt }));
    return { ok: true, action: { kind: "done", runId: handle.runId, outcome: committed.receipt } };
  } catch (error) {
    return waveBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

