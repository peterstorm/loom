/**
 * The legacy panel program's Run Directory shell (AD-8/AD-9, FR-006/009/011/012).
 *
 * Every decision — registration, the dispatch program's next action, the
 * verdict-source selection policy, submission settlement, and deterministic
 * operations — lives in the pure core (core/panel-program and
 * core/legacy-panel-decisions) and takes already-read evidence. This module
 * only moves bytes across the Run Directory, behind three entry points the
 * orchestration façade calls:
 *
 *   - `driveRegisteredPanel` reads the run's journal, hands it to the core's
 *     `nextPanelProgramAction` replay, and drives deterministic operations until the next external
 *     boundary: materializing and reserving a spawn batch, re-emitting the
 *     pending requests, or reporting done/blocked;
 *   - `resumeRegisteredPanel` first settles every captured-but-unsettled
 *     attempt, then drives;
 *   - `submitRegisteredPanelAttempt` settles one submitted attempt, records
 *     its outcome, then drives.
 *
 * Both settlement paths share `settleAndRecordPanelAttempt`, the one
 * derive-logical-id, settle, then record sequence.
 *
 * Underneath them, `resolvePanelAttemptVerdictSource` reads one attempt's
 * durable panel-verdict-source record (after the issuance joins hold) and
 * hands it to the core's selection; `settlePanelAttemptSubmission` settles the
 * attempt and publishes the write-ahead source record the settlement owes; and
 * `panelOperationEvidence` is the Run Directory adapter of a deterministic
 * operation's capture lookup.
 */
import { createHash } from "node:crypto";
import {
  AGENT_REQUIRED_SKILLS,
  parseAgentRequestAuthority,
  parseEffectId,
  parseFixedArtifactSlot,
  parseRequestId,
  parseSlotId,
  type AgentRequestAuthority,
  type DomainResult,
} from "../../../core/orchestration-contract";
import type { PanelVerdictSource, PanelVerdictSourceRecord } from "../../../core/panel-verdict-source";
import { captureKey } from "../../../core/harness-capture";
import type { NextPanelProgramAction, PanelProgramAction, SpawnRequest as PanelSpawnRequest } from "../../../core/panel-program";
import { lowerModelProfile, resolveModelProfile } from "../../../core/model-profiles";
import {
  describePanelJournalReplayError,
  executeDeterministicPanelOperation,
  joinPanelAttemptIssuance,
  logicalPanelRequestId,
  nextPanelProgramAction,
  parsePanelVerdictSourceRecordBytes,
  selectPanelAttemptVerdictSource,
  settlePanelAttempt,
  type PanelAttempt,
  type PanelAttemptVerdictSource,
  type PanelOperationEvidence,
  type PanelSubmission,
  type RegisteredPanelProgram,
} from "../../../core/legacy-panel-decisions";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../../orchestration/context-packets";
import type { RunDirHandle } from "../../../orchestration/run-directory-handle";
import { failed, type FacadeDriveResult, type ProgramParse } from "./program-result";
import { runDirectoryEffectRunner } from "./run-directory-effects";
import { renderSpawnTask } from "./spawn-task";

// ---------------------------------------------------------------------------
// Verdict-source shell: the durable record's read and write-ahead publication
// ---------------------------------------------------------------------------

const PANEL_VERDICT_SOURCES_BOUND_BYTES = 65_536;

const panelVerdictSourceArtifactPath = (requestId: string): string => `panel-verdict-sources/${requestId}.json`;

const bytesEqual = (left: Uint8Array, right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

function readPanelVerdictSourceRecord(handle: RunDirHandle, request: AgentRequestAuthority): DomainResult<PanelVerdictSourceRecord | null, string> {
  const bytes = handle.readArtifactBytes(panelVerdictSourceArtifactPath(request.requestId), PANEL_VERDICT_SOURCES_BOUND_BYTES);
  if (!bytes.ok) return { ok: false, error: `the durable panel verdict source for request ${request.requestId} is unreadable: ${bytes.error.message}` };
  return parsePanelVerdictSourceRecordBytes(request.requestId, bytes.value);
}

/**
 * Resolve ONE panel attempt's verdict source from its Run Directory. The
 * issuance joins are checked before the durable record is read: a caller
 * defect never reads (or consumes) attempt evidence.
 */
export function resolvePanelAttemptVerdictSource(args: PanelAttempt & Readonly<{ handle: RunDirHandle }>): DomainResult<PanelAttemptVerdictSource, string> {
  const joined = joinPanelAttemptIssuance({ request: args.request, raw: args.raw, emission: args.emission });
  if (!joined.ok) return joined;
  const record = readPanelVerdictSourceRecord(args.handle, args.request);
  if (!record.ok) return record;
  return selectPanelAttemptVerdictSource(joined.value, record.value);
}

/** Publish one attempt's accepted source record BEFORE its outcome is declared
 *  (write-ahead, the capture seam's exact posture): an identical prior record
 *  proceeds, a DIFFERENT one refuses — the recorded selection is authoritative
 *  and is never rewritten. */
async function publishPanelVerdictSourceRecord(handle: RunDirHandle, request: AgentRequestAuthority, record: PanelVerdictSourceRecord): Promise<DomainResult<true, string>> {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Object.freeze([...Buffer.from(serialized, "utf-8")]);
  if (bytes.length > PANEL_VERDICT_SOURCES_BOUND_BYTES) {
    return { ok: false, error: `the panel verdict source record for request ${request.requestId} exceeds the ${PANEL_VERDICT_SOURCES_BOUND_BYTES}-byte publication bound` };
  }
  const path = panelVerdictSourceArtifactPath(request.requestId);
  const prior = handle.readArtifactBytes(path, PANEL_VERDICT_SOURCES_BOUND_BYTES);
  if (!prior.ok) return { ok: false, error: prior.error.message };
  if (prior.value !== null) {
    return bytesEqual(prior.value, bytes)
      ? { ok: true, value: true }
      : { ok: false, error: `panel verdict source provenance for request ${request.requestId} is already published with a different accepted source; the recorded selection is authoritative and is never rewritten` };
  }
  const published = await handle.publishArtifactSet([{ relativePath: path, bytes }]);
  return published.ok ? { ok: true, value: true } : { ok: false, error: published.error.message };
}

/**
 * Settle ONE panel attempt's submission through the resolved verdict source:
 * the decision, then the write-ahead source record when the settlement owes
 * one.
 */
export async function settlePanelAttemptSubmission(
  args: PanelSubmission & Readonly<{ handle: RunDirHandle }>,
): Promise<DomainResult<Readonly<{ problem: string | null; source: PanelVerdictSource | null }>, string>> {
  const resolved = resolvePanelAttemptVerdictSource(args);
  if (!resolved.ok) return resolved;
  const settlement = settlePanelAttempt(args, resolved.value);
  if (!settlement.ok) return settlement;
  const { problem, source, publication } = settlement.value;
  if (publication !== null) {
    const published = await publishPanelVerdictSourceRecord(args.handle, args.request, publication);
    if (!published.ok) return published;
  }
  return { ok: true, value: Object.freeze({ problem, source }) };
}

// ---------------------------------------------------------------------------
// Deterministic operation evidence: the Run Directory capture lookup
// ---------------------------------------------------------------------------

/** The latest captured attempt of one logical panel request. */
function capturedPanelAttempt(
  handle: RunDirHandle,
  logicalRequestId: string,
): Readonly<{ ok: true; request: AgentRequestAuthority; raw: string }> | Readonly<{ ok: false; message: string }> {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const candidates = issued.value
    .filter((request) => logicalPanelRequestId(request.requestId, request.attempt) === logicalRequestId &&
      captured.value.has(captureKey(request.slotId, request.attempt)))
    .sort((left, right) => right.attempt - left.attempt);
  const request = candidates[0];
  if (request === undefined) return { ok: false, message: `operation is missing captured result for ${logicalRequestId}` };
  const bytes = handle.readTranscriptBytes(request);
  return bytes.ok
    ? { ok: true, request, raw: Buffer.from(bytes.value).toString("utf-8") }
    : { ok: false, message: bytes.error.message };
}

/** The Run Directory adapter of a deterministic operation's evidence lookup. */
export function panelOperationEvidence(handle: RunDirHandle): PanelOperationEvidence {
  return Object.freeze({
    capturedRaw: (logicalRequestId: string): ProgramParse<string> => {
      const captured = capturedPanelAttempt(handle, logicalRequestId);
      return captured.ok ? { ok: true, value: captured.raw } : captured;
    },
    parseTarget: (logicalRequestId: string): ProgramParse<string> => {
      const captured = capturedPanelAttempt(handle, logicalRequestId);
      if (!captured.ok) return captured;
      const resolved = resolvePanelAttemptVerdictSource({ handle, request: captured.request, raw: captured.raw });
      if (!resolved.ok) return { ok: false, message: resolved.error };
      return resolved.value.kind === "selected" && resolved.value.selection.kind === "emission-tool-arguments"
        ? { ok: true, value: resolved.value.selection.rawJson }
        : { ok: true, value: captured.raw };
    },
  });
}

// ---------------------------------------------------------------------------
// The panel driver: journal replay, request materialization, deterministic operations
// ---------------------------------------------------------------------------

/**
 * Record how one semantic attempt settled, keyed so a replay is a no-op.
 *
 * The dedup key is derived from the RESERVED request id and attempt (the pair
 * that names the slot on disk), while the event carries the LOGICAL request id
 * the panel program reasons about — the two differ for a retried panel attempt.
 * One function owns that pairing, because a dedup key that drifted from the
 * slot identity would make a replayed submission mint a second outcome for the
 * same attempt.
 */
async function appendSpawnOutcome(
  handle: RunDirHandle,
  reservedRequestId: string,
  attempt: 1 | 2,
  logicalRequestId: string,
  problem: string | null,
): Promise<void> {
  await handle.appendEvent({
    schemaVersion: 1,
    sequence: 0,
    dedupKey: `result:${createHash("sha256").update(`${reservedRequestId}:${attempt}`).digest("hex")}`,
    recordedAtMs: Date.now(),
    event: {
      type: "spawn-outcome",
      requestId: logicalRequestId,
      attempt,
      outcome: problem === null ? "succeeded" : "failed",
      ...(problem === null ? {} : { error: problem }),
    },
  });
}

type MaterializedPanelRequest = Readonly<{
  request: PanelSpawnRequest;
  authority: AgentRequestAuthority;
  packet: ContextPacket;
}>;

function materializePanelRequest(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  request: PanelSpawnRequest,
): ProgramParse<MaterializedPanelRequest> {
  const requestId = parseRequestId(
    request.attempt === 1 ? request.id : `${request.id}:attempt-${request.attempt}`,
  );
  const slotId = parseSlotId(`slot:${createHash("sha256").update(request.id).digest("hex").slice(0, 32)}`);
  const profile = resolveModelProfile(request.modelProfile);
  const role = request.agent as keyof typeof AGENT_REQUIRED_SKILLS;
  if (!requestId.ok) return { ok: false, message: requestId.error.message };
  if (!slotId.ok) return { ok: false, message: slotId.error.message };
  if (!profile.ok) return { ok: false, message: profile.error.message };
  if (!Object.hasOwn(AGENT_REQUIRED_SKILLS, role)) {
    return { ok: false, message: `unknown panel agent ${request.agent}` };
  }
  const requiredSkill = AGENT_REQUIRED_SKILLS[role];
  const authoritySection = encodeByteSection("panel-authority", JSON.stringify({
    panel: registration.kind,
    input: registration.input,
    context: registration.context,
  }));
  if (!authoritySection.ok) return { ok: false, message: authoritySection.error.message };
  const requestSection = encodeByteSection("panel-request", JSON.stringify({
    panel: registration.kind,
    logicalRequestId: request.id,
    requestId: requestId.value,
    attempt: request.attempt,
    role: request.agent,
    outputContract: request.outputContract,
  }));
  if (!requestSection.ok) return { ok: false, message: requestSection.error.message };
  const packet = buildContextPacket({
    requestId: requestId.value,
    role: request.agent,
    requiredSkill: requiredSkill ?? "none",
    outputContract: request.outputContract,
    fixedContext: Object.freeze([authoritySection.value]),
    variableContext: Object.freeze([requestSection.value]),
  });
  if (!packet.ok) return { ok: false, message: packet.error.message };
  const outputSlot = parseFixedArtifactSlot(
    `transcripts/${slotId.value}/attempt-${request.attempt}.raw`,
  );
  if (!outputSlot.ok) return { ok: false, message: outputSlot.error.message };
  const authority = parseAgentRequestAuthority({
    runId: handle.runId,
    requestId: requestId.value,
    slotId: slotId.value,
    program: registration.kind === "architecture" ? "architecture-panel" : "refutation-panel",
    role,
    attempt: request.attempt,
    modelProfile: profile.value.id,
    harnessBinding: {
      pi: lowerModelProfile(profile.value, "pi"),
      claude: lowerModelProfile(profile.value, "claude-code"),
    },
    requiredSkill,
    contextDigest: packet.value.digest,
    outputSlot: outputSlot.value,
  });
  return authority.ok
    ? { ok: true, value: Object.freeze({ request, authority: authority.value, packet: packet.value }) }
    : { ok: false, message: authority.error.violations.map(({ message }) => message).join("; ") };
}

async function materializePanelAction(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  action: Exclude<PanelProgramAction, Readonly<{ type: "engine-operation" }>>,
): Promise<FacadeDriveResult> {
  if (action.type === "done") {
    return { ok: true, action: Object.freeze({ kind: "done", panel: action.panel, outcome: action.outcome }) };
  }
  if (action.type === "blocked") return { ok: true, action: Object.freeze({ kind: "blocked", runId: handle.runId, diagnostic: action }) };
  const panelRequests: readonly PanelSpawnRequest[] = action.type === "spawn-batch" ? action.requests : [action.request];

  const materialized: MaterializedPanelRequest[] = [];
  for (const request of panelRequests) {
    const parsed = materializePanelRequest(handle, registration, request);
    if (!parsed.ok) return parsed;
    materialized.push(parsed.value);
  }
  for (const entry of materialized) {
    const published = await handle.publishContext(entry.packet);
    if (!published.ok) return { ok: false, message: published.error.message };
  }
  const effectId = parseEffectId(`effect:reserve:${createHash("sha256").update(JSON.stringify(
    materialized.map(({ authority }) => authority.requestId),
  )).digest("hex")}`);
  if (!effectId.ok) return { ok: false, message: effectId.error.message };
  const reserved = await runDirectoryEffectRunner(handle)({
    kind: "reserve-agent-requests",
    effectId: effectId.value,
    runId: handle.runId,
    requests: materialized.map(({ authority }) => authority) as [AgentRequestAuthority, ...AgentRequestAuthority[]],
  });
  if (!reserved.ok) return { ok: false, message: reserved.error.message };

  const enriched = materialized.map(({ request, authority, packet }) => Object.freeze({
    ...request,
    authority,
    // Harness adapters execute this exact task text. The marker binds a Pi
    // batch item to one issued request without reconstructing authority from
    // role or lexical request ordering.
    task: renderSpawnTask(handle, authority, `Read the immutable context packet at LOOM_CONTEXT_PATH, then ${request.outputContract}`),
    context: Object.freeze({
      digest: packet.digest,
      slot: Object.freeze({ kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` }),
    }),
  }));
  return { ok: true, action: Object.freeze({
    kind: "spawn-batch",
    runId: handle.runId,
    requests: Object.freeze(enriched),
  }) };
}

/** The journal read; the replay itself is the core's `nextPanelProgramAction`,
 *  whose typed refusal becomes operator text here, at the shell's edge. */
async function nextRegisteredPanelAction(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<ProgramParse<NextPanelProgramAction>> {
  const records = await handle.readEvents();
  const next = nextPanelProgramAction(registration, records.map(({ event }) => event));
  return next.ok ? next : { ok: false, message: describePanelJournalReplayError(next.error) };
}

/**
 * Drive deterministic operations internally until the program reaches a true
 * external boundary. Publication precedes the immutable success event; resume
 * safely republishes byte-identical artifacts after a publication→event crash.
 */
export async function driveRegisteredPanel(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<FacadeDriveResult> {
  for (let operationCount = 0; operationCount <= 4; operationCount += 1) {
    const next = await nextRegisteredPanelAction(handle, registration);
    if (!next.ok) return next;
    if (next.value.type === "await-results") {
      const issued = handle.readIssuedRequests();
      const captured = handle.readCapturedAttempts();
      if (!issued.ok) return { ok: false, message: issued.error.message };
      if (!captured.ok) return { ok: false, message: captured.error.message };
      const pending = issued.value.filter((request) => !captured.value.has(captureKey(request.slotId, request.attempt)));
      return { ok: true, action: Object.freeze({
        kind: "spawn-batch",
        runId: handle.runId,
        requests: Object.freeze(pending.map((authority) => Object.freeze({
          authority,
          context: Object.freeze({
            digest: authority.contextDigest,
            slot: Object.freeze({ kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` }),
          }),
          task: renderSpawnTask(handle, authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending panel request."),
        }))),
      }) };
    }
    if (next.value.type !== "engine-operation") {
      return materializePanelAction(handle, registration, next.value);
    }
    const operationId = next.value.operation;
    const executed = executeDeterministicPanelOperation(handle.runId, registration, operationId, panelOperationEvidence(handle));
    if (!executed.ok) return executed;
    const published = await handle.publishArtifactSet(executed.artifacts);
    if (!published.ok) return { ok: false, message: published.error.message };
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `engine:${createHash("sha256").update(`${operationId}:succeeded`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: { type: "engine-outcome", operationId, outcome: "succeeded" },
    });
  }
  return { ok: false, message: "panel emitted more deterministic operations than its closed operation vocabulary allows" };
}

// ---------------------------------------------------------------------------
// Settlement entry points: one submitted attempt, or every captured attempt
// ---------------------------------------------------------------------------

/**
 * Settle ONE attempt's raw bytes and record how it settled: the logical id is
 * derived, the attempt settled through its verdict source, then its outcome
 * appended under the reserved slot's dedup key. Both settlement entry points
 * go through here, so the logical-id/dedup-key pairing `appendSpawnOutcome`
 * owns has one caller sequence; they differ only in where `raw` comes from.
 * Recording has no value of its own, so success is the unit `true`; a failure
 * is already the façade's failure shape, which an entry point passes through.
 */
async function settleAndRecordPanelAttempt(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  request: AgentRequestAuthority,
  raw: string,
): Promise<ProgramParse<true>> {
  const logicalRequestId = logicalPanelRequestId(request.requestId, request.attempt);
  const settled = await settlePanelAttemptSubmission({ handle, registration, request, logicalRequestId, raw });
  if (!settled.ok) return failed(settled.error);
  await appendSpawnOutcome(handle, request.requestId, request.attempt, logicalRequestId, settled.value.problem);
  return { ok: true, value: true };
}

/**
 * Settle one submitted attempt through its resolved verdict source, record how
 * it settled, and drive the panel to its next external boundary.
 */
export async function submitRegisteredPanelAttempt(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
  request: AgentRequestAuthority,
  raw: string,
): Promise<FacadeDriveResult> {
  const recorded = await settleAndRecordPanelAttempt(handle, registration, request, raw);
  if (!recorded.ok) return recorded;
  return driveRegisteredPanel(handle, registration);
}

/**
 * Fold every captured-but-unsettled panel attempt into a `spawn-outcome` event.
 *
 * A transcript can be captured into its reserved slot without the program yet
 * having judged it — the capture and the judgement are separate writes. This
 * settles each such attempt through the same verdict-source seam a submission
 * uses and records the verdict, keyed so a repeat is a no-op. It decides no
 * policy of its own: the first failure, or the unit `true` once every attempt
 * settled.
 */
async function reconcileCapturedPanelResults(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<ProgramParse<true>> {
  const events = await handle.readEvents();
  const settled = new Set(events.flatMap(({ event }) => {
    if (typeof event !== "object" || event === null) return [];
    const record = event as Record<string, unknown>;
    return record["type"] === "spawn-outcome" && typeof record["requestId"] === "string" &&
      (record["attempt"] === 1 || record["attempt"] === 2)
      ? [`${record["requestId"]}:${record["attempt"]}`]
      : [];
  }));
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return failed(issued.error.message);
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return failed(captured.error.message);

  for (const request of issued.value) {
    if (!captured.value.has(captureKey(request.slotId, request.attempt))) continue;
    if (settled.has(`${logicalPanelRequestId(request.requestId, request.attempt)}:${request.attempt}`)) continue;
    const bytes = handle.readTranscriptBytes(request);
    if (!bytes.ok) return failed(bytes.error.message);
    // The verdict-source seam resolves this attempt's emission evidence — the
    // durable record's replay when one was published, otherwise the extraction
    // baseline — and the submission decision runs over exactly that resolution
    // (the same policy every later scan of the same attempt reproduces).
    const recorded = await settleAndRecordPanelAttempt(handle, registration, request, Buffer.from(bytes.value).toString("utf-8"));
    if (!recorded.ok) return recorded;
  }
  return { ok: true, value: true };
}

/**
 * Resume a registered panel: settle every captured-but-unsettled attempt, then
 * drive to the next external boundary. Idempotent — a settled attempt is
 * never settled twice.
 */
export async function resumeRegisteredPanel(
  handle: RunDirHandle,
  registration: RegisteredPanelProgram,
): Promise<FacadeDriveResult> {
  const reconciled = await reconcileCapturedPanelResults(handle, registration);
  if (!reconciled.ok) return reconciled;
  return driveRegisteredPanel(handle, registration);
}
