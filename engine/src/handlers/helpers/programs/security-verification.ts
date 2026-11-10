/**
 * The `security-verification` facade program (ADR-0067): the security audit's
 * verifier spawns, issued per brief, captured through the native capture path,
 * admitted, retried once, and published as a digest-bound ballot set.
 *
 * This is a SHELL over `core/security-verification`. Each drive reads the
 * audit (re-authenticated every time: a run whose audit moved stops), the
 * run's durable requests, captures and capture rejections, lets the pure core
 * decide every slot, and performs the one effect that decision names: publish
 * the attempt-1 batch, publish an attempt-2 retry, emit the owed spawns, block,
 * or write `result.json`. There is no checkpoint — every decision is recomputed
 * from durable evidence, so `verify --from` can replay a finished run from the
 * same evidence and refuse a `result.json` that differs.
 */
import { join } from "node:path";
import { match } from "ts-pattern";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../../core/context-packets";
import { captureKey } from "../../../core/harness-capture";
import { sha256Bytes } from "../../../core/digest";
import {
  mintAgentRosterSlot,
  parseArtifactRef,
  parseRequestId,
  rosterSlotErrorMessages,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type SpawnRequest,
} from "../../../core/orchestration-contract";
import type { PreparedVerifierRequest } from "../../../core/refutation-verifiers";
import {
  authenticateAudit,
  bindBallots,
  buildVerificationResult,
  decideVerificationSlot,
  deriveVerificationBriefs,
  foldVerificationProgress,
  recordedVerifierSlot,
  registerSecurityVerification,
  serializeVerificationResult,
  verificationBriefText,
  verificationRequestIds,
  verifierSlotIdentities,
  VERIFICATION_BRIEF_SECTION,
  VERIFICATION_RESULT_KIND,
  type AttemptEvidence,
  type RegisteredSecurityVerificationProgram,
  type SecurityVerificationResult,
  type SecurityVerificationStart,
  type VerificationBrief,
} from "../../../core/security-verification";
import { SECURITY_VERIFIER_ROLE, type VerificationVerdict } from "../../../core/security-adjudication";
import { readRunBytesNoFollow, writeRunBytesExclusiveNoFollow } from "../../../utils/no-follow-fs";
import { parseRunDirectoryReference, type RunDirHandle } from "../../../orchestration/run-directory-handle";
import { readAuditSnapshot, SECURITY_VERIFICATION_RESULT_FILE, verificationRunsRoot, type AuditSnapshot } from "../security-audit-run";
import { registerSecurityAuditRun } from "../../../orchestration/security-audit-run-registry";
import { durableCaptureRejection, durablePublishedReceipt, durableRefutationRequests, publicationResolver, refutationBatchEffectId } from "./durable-requests";
import { recoverOrPublishRefutationRetry } from "./refutation-requests";
import { publishLegacyInitialBatch } from "./request-publication";
import { renderSpawnTask } from "./spawn-task";
import { failed, type FacadeDriveResult, type FacadeSpawnRequest, type ProgramParse } from "./program-result";

/** The durable effect label every verification batch is published under. */
const LABEL = "security-verification";

const OUTPUT_CONTRACT =
  `Try to refute every candidate in the ${VERIFICATION_BRIEF_SECTION} section and return exactly one ` +
  `${VERIFICATION_RESULT_KIND} JSON object: one verdict per fingerprint in the brief, each with exactly ` +
  "fingerprint, vote (critical | advisory), reason and missingFact (null when none). No agent, profile or wave.";

const VERIFIER_INSTRUCTION =
  `Read your brief with LOOM_CONTEXT_SECTION_COMMAND --section ${VERIFICATION_BRIEF_SECTION}, try to refute ` +
  `every candidate in it, and make your FINAL message exactly one ${VERIFICATION_RESULT_KIND} JSON object.`;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// --- Start ---

/**
 * Prepare a fresh run: the destination must be the audit's own
 * `verification-runs` root, the audit as it stands must be the one the input
 * names (locator, run id, ledger and findings digests), an unpublished audit,
 * and the run name the one its briefs derive.
 */
export function prepareSecurityVerificationFacadeStart(
  input: SecurityVerificationStart,
  runsRoot: string,
  run: string,
): ProgramParse<RegisteredSecurityVerificationProgram> {
  const destination = parseRunDirectoryReference(runsRoot, run);
  if (!destination.ok) return { ok: false, message: destination.error.message };
  if (destination.value.runsRoot !== verificationRunsRoot(input.audit.locator)) {
    return { ok: false, message: `a verification run lives under ${verificationRunsRoot(input.audit.locator)}, not ${destination.value.runsRoot}` };
  }
  const snapshot = authenticatedAudit(input);
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.run.published) return { ok: false, message: `audit ${input.audit.runId} is published; a published audit takes no more ballots` };
  const guarded = guardAuditRun(input);
  if (!guarded.ok) return guarded;
  const briefs = deriveVerificationBriefs({
    issue: input, findings: snapshot.value.findings, verdicts: snapshot.value.verdicts,
  });
  const registration = registerSecurityVerification(destination.value.runId, input, briefs);
  return registration.ok ? { ok: true, value: registration.value } : { ok: false, message: registration.error };
}

/**
 * How a drive or a replay holds the audit to the run's issuance:
 * - `current`: the audit's ledger and findings must still be the ones the run
 *   was issued against (driving, starting, importing — a moved audit stops);
 * - `issued`: only the audit's identity (locator, run id) must match. This is
 *   the replay of an ALREADY-IMPORTED run whose ballots `verdicts.json` caches:
 *   later waves move the ledger and findings, and that must not unprove the
 *   ballots this run cast over its frozen briefs.
 */
export type AuditBinding = "current" | "issued";

/** The audit as it stands, proven to be the audit `input` names. */
function authenticatedAudit(input: SecurityVerificationStart, binding: AuditBinding = "current"): ProgramParse<AuditSnapshot> {
  const snapshot = readAuditSnapshot(input.audit.locator);
  if (!snapshot.ok) return { ok: false, message: snapshot.error };
  const authentic = binding === "current"
    ? authenticateAudit(input.audit, snapshot.value.reference)
    : authenticateAudit(input.audit, { ...snapshot.value.reference,
      ledgerDigest: input.audit.ledgerDigest, findingsDigest: input.audit.findingsDigest });
  return authentic.ok ? { ok: true, value: snapshot.value } : { ok: false, message: authentic.error };
}

/**
 * Register (or refresh) the audit run with the subagent write guard's
 * registry before the program writes anything (ADR-0067, amended). While a
 * verification run is live its verifier spawns run beside the audit, so the
 * guard must know the audit's directory even when its registry was wiped
 * since the audit's last write. Idempotent; a run the guard cannot know is
 * not driven.
 */
function guardAuditRun(input: SecurityVerificationStart): ProgramParse<void> {
  const registered = registerSecurityAuditRun(input.audit.locator);
  return registered.ok
    ? { ok: true, value: undefined }
    : { ok: false, message: `cannot register audit run ${input.audit.locator} with the subagent write guard: ${registered.error}` };
}

export async function startSecurityVerificationFacade(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
): Promise<FacadeDriveResult> {
  const stored = await handle.registerProgram(registration);
  return stored.ok ? resumeSecurityVerificationFacade(handle, registration) : failed(stored.error.message);
}

// --- Preparation: each brief's packets and requests ---

/** One brief's prepared verifier slot: its two attempts' requests and packets. */
type PreparedSlot = Readonly<{
  brief: VerificationBrief;
  first: PreparedVerifierRequest;
  retry: PreparedVerifierRequest;
}>;

function briefPacket(
  registration: RegisteredSecurityVerificationProgram,
  snapshot: AuditSnapshot,
  brief: VerificationBrief,
  attempt: 1 | 2,
): ProgramParse<ContextPacket> {
  const requestId = parseRequestId(verificationRequestIds(brief.slotId)[attempt - 1]);
  if (!requestId.ok) return { ok: false, message: requestId.error.message };
  const text = verificationBriefText({ registration, brief, findings: snapshot.findings,
    audit: { target: snapshot.run.target, commit: snapshot.run.sourceRef.commit }, requestId: requestId.value, attempt });
  if (!text.ok) return { ok: false, message: text.error };
  const section = encodeByteSection(VERIFICATION_BRIEF_SECTION, text.value);
  if (!section.ok) return { ok: false, message: section.error.message };
  const packet = buildContextPacket({ requestId: requestId.value, role: SECURITY_VERIFIER_ROLE, requiredSkill: "none",
    outputContract: OUTPUT_CONTRACT, fixedContext: [section.value], variableContext: [] });
  return packet.ok ? { ok: true, value: packet.value } : { ok: false, message: packet.error.message };
}

const preparedRequest = (authority: AgentRequestAuthority, packet: ContextPacket): PreparedVerifierRequest => Object.freeze({
  input: Object.freeze({
    authority,
    context: Object.freeze({ digest: packet.digest, slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }) }),
  }),
  packet,
});

/** The attempt-1 authorities the batch receipt recorded, keyed by request id;
 *  null when the batch was never published (the slots are minted today). */
function recordedFirstRequests(handle: RunDirHandle, briefs: readonly VerificationBrief[]): ProgramParse<ReadonlyMap<string, AgentRequestAuthority> | null> {
  const effectId = refutationBatchEffectId(LABEL, briefs.map((brief) => verificationRequestIds(brief.slotId)[0]));
  if (!effectId.ok) return { ok: false, message: effectId.error.message };
  const receipt = durablePublishedReceipt(handle, effectId.value);
  if (receipt.kind === "corrupt") return { ok: false, message: receipt.message };
  if (receipt.kind === "absent") return { ok: true, value: null };
  return { ok: true, value: new Map<string, AgentRequestAuthority>(receipt.receipt.issuedRequests.map(({ authority }) => [authority.requestId, authority] as const)) };
}

function prepareSlot(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
  snapshot: AuditSnapshot,
  brief: VerificationBrief,
  recorded: ReadonlyMap<string, AgentRequestAuthority> | null,
): ProgramParse<PreparedSlot> {
  const first = briefPacket(registration, snapshot, brief, 1);
  if (!first.ok) return first;
  const retry = briefPacket(registration, snapshot, brief, 2);
  if (!retry.ok) return retry;
  const identities = verifierSlotIdentities(handle.runId, brief, [first.value.digest, retry.value.digest]);
  const slot = slotAuthority(identities, recorded);
  if (!slot.ok) return slot;
  return { ok: true, value: { brief,
    first: preparedRequest(slot.value.attempts[0], first.value),
    retry: preparedRequest(slot.value.attempts[1], retry.value) } };
}

/** A slot read back as history when its batch is on record, minted from today's catalog otherwise. */
function slotAuthority(
  identities: Parameters<typeof recordedVerifierSlot>[0],
  recorded: ReadonlyMap<string, AgentRequestAuthority> | null,
): ProgramParse<AgentRosterSlot> {
  if (recorded !== null) {
    const record = recorded.get(identities[0].requestId);
    if (record === undefined) return { ok: false, message: `verification batch record lacks request ${identities[0].requestId}` };
    const slot = recordedVerifierSlot(identities, record);
    return slot.ok ? { ok: true, value: slot.value } : { ok: false, message: slot.error };
  }
  const minted = mintAgentRosterSlot(identities[0], identities[1]);
  return minted.ok
    ? { ok: true, value: minted.value }
    : { ok: false, message: `verifier slot ${identities[0].slotId} cannot be minted: ${rosterSlotErrorMessages(minted.error).join("; ")}` };
}

function prepareSlots(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
  snapshot: AuditSnapshot,
): ProgramParse<readonly PreparedSlot[]> {
  const recorded = recordedFirstRequests(handle, registration.briefs);
  if (!recorded.ok) return recorded;
  const slots: PreparedSlot[] = [];
  for (const brief of registration.briefs) {
    const slot = prepareSlot(handle, registration, snapshot, brief, recorded.value);
    if (!slot.ok) return slot;
    slots.push(slot.value);
  }
  return { ok: true, value: slots };
}

// --- Evidence and the run's outcome ---

/** What the run directory holds for one attempt: its captured bytes, its
 *  durable capture rejection, or nothing. An unreserved attempt holds nothing. */
async function attemptEvidence(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  reserved: ReadonlySet<string>,
  captured: ReadonlySet<string>,
): Promise<ProgramParse<AttemptEvidence>> {
  if (!reserved.has(authority.requestId)) return { ok: true, value: { kind: "absent" } };
  if (captured.has(captureKey(authority.slotId, authority.attempt))) {
    const bytes = handle.readTranscriptBytes(authority);
    if (!bytes.ok) return { ok: false, message: bytes.error.message };
    const digest = sha256Bytes(bytes.value);
    return { ok: true, value: { kind: "captured", text: Buffer.from(bytes.value).toString("utf8"), digest } };
  }
  const rejection = await durableCaptureRejection(handle, authority);
  return { ok: true, value: rejection === null ? { kind: "absent" } : { kind: "capture-rejected", diagnostic: rejection } };
}

/** Where a run stands, decided by the pure core from durable evidence. */
type VerificationOutcome =
  | Readonly<{ kind: "unpublished"; slots: readonly PreparedSlot[] }>
  | Readonly<{ kind: "awaiting"; slots: readonly Readonly<{ slot: PreparedSlot; attempt: 1 | 2; diagnostic: string | null }>[]; requests: readonly SpawnRequest[] }>
  | Readonly<{ kind: "blocked"; messages: readonly string[] }>
  | Readonly<{ kind: "complete"; result: SecurityVerificationResult }>;

/**
 * Derive a run's outcome from its durable evidence, writing nothing. The
 * driver acts on it; `verify --from` replays it to prove `result.json`.
 */
async function deriveVerificationOutcome(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
  binding: AuditBinding = "current",
): Promise<ProgramParse<VerificationOutcome>> {
  const snapshot = authenticatedAudit(registration.input, binding);
  if (!snapshot.ok) return { ok: true, value: { kind: "blocked", messages: [snapshot.message] } };
  const slots = prepareSlots(handle, registration, snapshot.value);
  if (!slots.ok) return slots;
  const recovered = durableRefutationRequests(handle, slots.value.map(({ first }) => first.input), publicationResolver(handle), LABEL);
  if (recovered.kind === "corrupt") return { ok: false, message: recovered.message };
  if (recovered.kind === "absent") return { ok: true, value: { kind: "unpublished", slots: slots.value } };
  return decideFromEvidence(handle, registration, slots.value, recovered.requests);
}

async function decideFromEvidence(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
  slots: readonly PreparedSlot[],
  requests: readonly SpawnRequest[],
): Promise<ProgramParse<VerificationOutcome>> {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const reserved = new Set(issued.value.map(({ requestId }) => requestId));
  const decisions = [];
  for (const slot of slots) {
    const first = await attemptEvidence(handle, slot.first.input.authority, reserved, captured.value);
    if (!first.ok) return first;
    const retry = await attemptEvidence(handle, slot.retry.input.authority, reserved, captured.value);
    if (!retry.ok) return retry;
    decisions.push({ slot, decision: decideVerificationSlot(slot.brief, first.value, retry.value) });
  }
  return match(foldVerificationProgress(decisions))
    .returnType<ProgramParse<VerificationOutcome>>()
    .with({ kind: "awaiting" }, ({ slots: awaiting }) => ({ ok: true, value: { kind: "awaiting", slots: awaiting, requests } }))
    .with({ kind: "blocked" }, ({ messages }) => ({ ok: true, value: { kind: "blocked", messages } }))
    .with({ kind: "complete" }, ({ admitted }) => completedResult(registration, admitted))
    .exhaustive();
}

/** Bind every admitted brief's votes to the request that answered it, and build the result. */
function completedResult(
  registration: RegisteredSecurityVerificationProgram,
  admitted: readonly Readonly<{ slot: PreparedSlot; attempt: 1 | 2; votes: Parameters<typeof bindBallots>[0]["votes"]; digest: string }>[],
): ProgramParse<VerificationOutcome> {
  const ballots: VerificationVerdict[] = [];
  for (const { slot, attempt, votes, digest } of admitted) {
    const authority = attempt === 1 ? slot.first.input.authority : slot.retry.input.authority;
    const bound = bindBallots({ votes, authority, captureDigest: digest, wave: registration.input.wave });
    if (!bound.ok) return { ok: false, message: bound.error };
    ballots.push(...bound.value);
  }
  const result = buildVerificationResult(registration, ballots);
  return result.ok ? { ok: true, value: { kind: "complete", result: result.value } } : { ok: false, message: result.error };
}

// --- The driver ---

/** One spawn task: the extraction-only render, plus the retry's diagnostic. */
function verifierTask(handle: RunDirHandle, authority: AgentRequestAuthority, diagnostic: string | null): string {
  const task = renderSpawnTask(handle, authority, VERIFIER_INSTRUCTION);
  return authority.attempt === 1 ? task : [
    task, "", "Your previous attempt was rejected:", "", diagnostic ?? "its result could not be admitted", "",
    `Your FINAL message must be exactly one ${VERIFICATION_RESULT_KIND} JSON object and nothing else, with one verdict per fingerprint in the brief.`,
  ].join("\n");
}

const spawnRequest = <R extends Readonly<{ authority: AgentRequestAuthority; context: SpawnRequest["context"] }>>(
  handle: RunDirHandle, request: R, diagnostic: string | null,
): R & FacadeSpawnRequest =>
  Object.freeze({ ...request, task: verifierTask(handle, request.authority, diagnostic) });

/** Publish the attempt-1 batch and emit it with verifier tasks. */
async function publishFirstBatch(handle: RunDirHandle, slots: readonly PreparedSlot[]): Promise<FacadeDriveResult> {
  const published = await publishLegacyInitialBatch(handle, slots.map(({ first }) => first.input), slots.map(({ first }) => first.packet), LABEL);
  if (!published.ok) return failed(published.message);
  return { ok: true, action: { ...published.action,
    requests: Object.freeze(published.action.requests.map((request) => spawnRequest(handle, request, null))) } };
}

/** Emit every owed spawn: an attempt-1 request from its batch, an attempt-2
 *  retry recovered or published first. */
async function emitOwedSpawns(
  handle: RunDirHandle,
  outcome: Extract<VerificationOutcome, { kind: "awaiting" }>,
): Promise<FacadeDriveResult> {
  const resolver = publicationResolver(handle);
  const owed: FacadeSpawnRequest[] = [];
  for (const { slot, attempt, diagnostic } of outcome.slots) {
    if (attempt === 1) {
      const request = outcome.requests.find(({ authority }) => authority.requestId === slot.first.input.authority.requestId);
      if (request === undefined) return failed(`verification batch lacks request ${slot.first.input.authority.requestId}`);
      owed.push(spawnRequest(handle, request, null));
      continue;
    }
    const retry = await recoverOrPublishRefutationRetry(handle, slot.retry.input.authority, [slot.retry], resolver, LABEL);
    if (!retry.ok) return blocked(handle, [retry.message]);
    owed.push(spawnRequest(handle, retry.request, diagnostic));
  }
  return { ok: true, action: { kind: "spawn-batch", runId: handle.runId, requests: Object.freeze(owed) } };
}

const blocked = (handle: RunDirHandle, messages: readonly string[]): FacadeDriveResult => ({
  ok: true,
  action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "security-verification-blocked", message: messages.join("; ") } },
});

/** Write `result.json` exactly once: a repeat with identical bytes converges, different bytes are a collision. */
function publishResult(handle: RunDirHandle, result: SecurityVerificationResult): FacadeDriveResult {
  const bytes = Buffer.from(serializeVerificationResult(result), "utf8");
  const path = join(handle.runDirectory, SECURITY_VERIFICATION_RESULT_FILE);
  try {
    writeRunBytesExclusiveNoFollow(path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return failed(describe(error));
    let existing: Buffer;
    try { existing = readRunBytesNoFollow(path); } catch (cause) { return failed(describe(cause)); }
    if (!existing.equals(bytes)) return failed(`${path} already holds a different verification result`);
  }
  const artifact = parseArtifactRef({ runId: handle.runId, slot: { kind: "fixed-artifact-slot", path: SECURITY_VERIFICATION_RESULT_FILE },
    digest: sha256Bytes(bytes), byteLength: bytes.byteLength });
  return artifact.ok
    ? { ok: true, action: { kind: "done", runId: handle.runId, outcome: artifact.value } }
    : failed(artifact.error.message);
}

export async function resumeSecurityVerificationFacade(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
): Promise<FacadeDriveResult> {
  try {
    const guarded = guardAuditRun(registration.input);
    if (!guarded.ok) return failed(guarded.message);
    const outcome = await deriveVerificationOutcome(handle, registration);
    if (!outcome.ok) return outcome;
    return await match(outcome.value)
      .returnType<Promise<FacadeDriveResult> | FacadeDriveResult>()
      .with({ kind: "unpublished" }, ({ slots }) => publishFirstBatch(handle, slots))
      .with({ kind: "awaiting" }, (awaiting) => emitOwedSpawns(handle, awaiting))
      .with({ kind: "blocked" }, ({ messages }) => blocked(handle, messages))
      .with({ kind: "complete" }, ({ result }) => publishResult(handle, result))
      .exhaustive();
  } catch (error) {
    return failed(describe(error));
  }
}

/** Where a run stands when replayed from its durable evidence, writing nothing. */
export type VerificationReplay =
  | Readonly<{ kind: "complete"; result: SecurityVerificationResult }>
  /** Still owes spawns (or its first batch): a live run. */
  | Readonly<{ kind: "in-flight"; message: string }>
  /** Terminally blocked: this run can never finish. */
  | Readonly<{ kind: "blocked"; message: string }>;

/** Replay a run's outcome from its durable evidence (no effect). A run whose
 *  evidence cannot be read is a refusal, never a guess. */
export async function replayVerificationOutcome(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
  binding: AuditBinding = "current",
): Promise<ProgramParse<VerificationReplay>> {
  try {
    const outcome = await deriveVerificationOutcome(handle, registration, binding);
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      value: match(outcome.value)
        .returnType<VerificationReplay>()
        .with({ kind: "complete" }, ({ result }) => ({ kind: "complete", result }))
        .with({ kind: "blocked" }, ({ messages }) => ({ kind: "blocked", message: messages.join("; ") }))
        .with({ kind: "unpublished" }, () => ({ kind: "in-flight", message: "its verifier batch is not yet published" }))
        .with({ kind: "awaiting" }, ({ slots }) => ({ kind: "in-flight", message: `${slots.length} verifier spawn(s) are still owed` }))
        .exhaustive(),
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** The bytes a finished run's `result.json` must hold, replayed from durable
 *  evidence; a run that is not finished has none. */
export async function replayVerificationResult(
  handle: RunDirHandle,
  registration: RegisteredSecurityVerificationProgram,
): Promise<ProgramParse<string>> {
  const replayed = await replayVerificationOutcome(handle, registration);
  if (!replayed.ok) return replayed;
  return replayed.value.kind === "complete"
    ? { ok: true, value: serializeVerificationResult(replayed.value.result) }
    : { ok: false, message: `verification run ${handle.runId} is not complete (${replayed.value.kind}: ${replayed.value.message})` };
}
