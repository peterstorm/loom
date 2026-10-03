/**
 * The run-directory half of harness capture, shared by both adapters.
 *
 * `core/harness-capture` owns the RULES — one unambiguous final payload, exact
 * bytes, bind to issued authority. This module owns everything those rules need
 * from a run directory: which requests the run issued, which slots already
 * accepted a capture, which request a native correlator claims, and the write
 * itself.
 *
 * It lives here, and not inside either adapter, because FR-033 requires Pi and
 * Claude Code to capture into the SAME engine-declared slot under the same
 * refusals. A per-adapter copy of this half is exactly how the two harnesses
 * drift into disagreeing about which results are admissible — the drift the
 * shared rules module was written to prevent, reintroduced one layer down.
 * Each adapter therefore contributes only what is genuinely harness-native: how
 * to observe an Agent's final payload, what its own correlator is, and the
 * preliminary responsibilities each capture performs before that observation —
 * resolving the issued request against its registration, parsing the claimed
 * registration, and resource-bounding final-payload selection before any
 * transcript work.
 */

import { match } from "ts-pattern";
import {
  bindCapture,
  captureKey,
  nativeCaptureObservation,
  recoverNativeCaptureArtifact,
  captureRejectionAuditRecord,
  captureRejectionDedupKey,
  parseFinalPayload,
  type CaptureReceipt,
  type FinalPayload,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../core/harness-capture";
import { parseEffectId, type AgentRequestAuthority, type ArtifactRef, type DomainResult } from "../core/orchestration-contract";
import { createHash } from "node:crypto";
import { parseStandaloneReviewerProtocolV3 } from "../core/standalone-lineage-contract";
import { verifyStandalonePanelView } from "./standalone-panel-context";
import { openRegisteredRunDirectory, type RunDirHandle } from "./run-directory-handle";

/**
 * Where a run directory is announced explicitly.
 *
 * Operator/supervisor-supplied only: NO production code writes either variable.
 * On both harnesses the façade publishes a durable SESSION RUN BINDING instead
 * (`registerSessionRunBinding`, keyed by `PI_SESSION_ID` on Pi and by
 * `CLAUDE_CODE_SESSION_ID` on Claude Code), and that binding — not the
 * environment — is what carries capture authority across a process boundary:
 * `pi/extension` reads it back for Pi, `claude-run-authority` for Claude's
 * PostToolUse and SubagentStop hooks. When either variable is set it takes
 * precedence over the binding and half of it is a fault; a supervisor or a test
 * may use them to pin a harness to one run. Absent, with no binding claiming the
 * agent, means "this agent is not part of an orchestration run", which is the
 * common case and NOT an error.
 */
export const RUNS_ROOT_ENV = "LOOM_ORCHESTRATION_RUNS_ROOT";
export const RUN_DIR_ENV = "LOOM_ORCHESTRATION_RUN_DIR";

export type TerminalCaptureRefusal = Readonly<{
  kind: "terminal-refusal";
  reason: string;
  message: string;
}>;

export type CaptureObservation =
  | Readonly<{ kind: "candidates"; candidates: readonly FinalPayloadCandidate[] }>
  | Readonly<{ kind: "unavailable"; reason: string; message: string }>
  | TerminalCaptureRefusal;

export type CaptureOutcome =
  | Readonly<{ kind: "not-an-orchestration-run" }>
  | Readonly<{ kind: "no-reservation"; agentId: string }>
  | Readonly<{ kind: "captured"; receipt: CaptureReceipt }>
  | Readonly<{ kind: "terminal-rejection"; reason: string; message: string }>
  | Readonly<{ kind: "retriable-failure"; reason: string; message: string }>;

export const terminalCaptureRefusal = (reason: string, message: string): TerminalCaptureRefusal =>
  Object.freeze({ kind: "terminal-refusal", reason, message });

export const captureUnavailable = (reason: string, message: string): CaptureObservation =>
  Object.freeze({ kind: "unavailable", reason, message });

export const captureCandidates = (candidates: readonly FinalPayloadCandidate[]): CaptureObservation =>
  Object.freeze({ kind: "candidates", candidates });

const retriableFailure = (reason: string, message: string): CaptureOutcome =>
  Object.freeze({ kind: "retriable-failure", reason, message });

/**
 * Why a capture did not happen, in operator-facing words.
 *
 * Written beside the union rather than at the call site: `pi/extension` derived
 * it twice, byte-for-byte, in the two branches that report a failed capture, so
 * the two diagnostics could drift apart while describing the same value. A
 * `captured` outcome has no failure to describe and says so rather than
 * pretending to.
 */
export function describeCaptureFailure(outcome: CaptureOutcome): string {
  return match(outcome)
    .with({ kind: "terminal-rejection" }, ({ reason, message }) => `${reason}: ${message}`)
    .with({ kind: "retriable-failure" }, ({ reason, message }) => `${reason}: ${message}`)
    .with({ kind: "no-reservation" }, ({ agentId }) => `no reservation for ${agentId}`)
    .with({ kind: "not-an-orchestration-run" }, () => "orchestration run authority was unavailable")
    .with({ kind: "captured" }, () => "capture succeeded")
    .exhaustive();
}

/**
 * Terminalise one refused capture and return what the operator must be told.
 *
 * ONE home for the whole protocol — tombstone, audit record, and the journal
 * identity that record dedups by — because both adapters need it and two copies
 * had already drifted: the engine copy let a journal-append failure throw out of
 * a function whose stated contract is "refusals are returned, never thrown",
 * while the Pi copy turned the identical fault into a string. One journal fault,
 * two classifications, plus a shared dedup key only one side could change.
 *
 * The refusal is a parsed `TerminalCaptureRefusal`; infrastructure failures
 * cannot inhabit that type and therefore cannot call this protocol accidentally.
 * The durable diagnostic is derived once from its reason and message.
 *
 * It never throws, and it never loses the cause. When the tombstone cannot be
 * written the returned message carries the ORIGINAL refusal as well as the
 * persistence error, because at that point no on-disk trace of the reason exists
 * at all and "rejection-persistence" alone would name the wrong component.
 */
export async function terminalizeCaptureRejection(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  refusal: TerminalCaptureRefusal,
): Promise<CaptureOutcome> {
  const diagnostic = `${refusal.reason}: ${refusal.message}`;
  let terminal: Awaited<ReturnType<RunDirHandle["rejectCapture"]>>;
  try {
    terminal = await handle.rejectCapture(request, diagnostic);
  } catch (error) {
    return retriableFailure(
      "rejection-persistence",
      `capture refused (${diagnostic}) and its rejection persistence crashed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!terminal.ok) {
    return retriableFailure(
      "rejection-persistence",
      `capture refused (${diagnostic}) and its rejection could not be persisted: ${terminal.error.message}`,
    );
  }
  try {
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: captureRejectionDedupKey(request.requestId, request.attempt),
      recordedAtMs: Date.now(),
      event: captureRejectionAuditRecord(request, diagnostic),
    });
    return { kind: "terminal-rejection", reason: refusal.reason, message: refusal.message };
  } catch (error) {
    return {
      kind: "terminal-rejection",
      reason: "rejection-audit-unsynchronized",
      message: `capture refused (${diagnostic}); it was terminalised but its audit event could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The issued request one native correlator resolves to, plus what a caller
 * needs to act on it.
 */
export type CorrelatedRequest = Readonly<{
  handle: RunDirHandle;
  issued: readonly AgentRequestAuthority[];
  identity: HarnessResultIdentity;
  request: AgentRequestAuthority;
}>;

export type CorrelatedRequestResolution =
  | Readonly<{ ok: true; value: CorrelatedRequest }>
  | Readonly<{ ok: false; outcome: CaptureOutcome }>;

/**
 * Resolve "which request does this native correlator answer" in ONE place.
 *
 * Opening the run, reading its correlator binding, and loading the issued
 * authority is the same three-step question for every consumer: the capture path
 * below, and `subagent-stop/dispatch`, which must know the program a stop
 * belongs to BEFORE it decides whether legacy TaskGraph settlement applies. Two
 * copies of that question is how a harness ends up calling a stop "unrelated"
 * while its own capture path still fills the slot, so the question has exactly
 * one asker.
 *
 * Decisions only — nothing here terminalises, tombstones, or writes. What an
 * unresolved correlator MEANS (refusal, tombstone, or silence for an agent in
 * nobody's run) belongs to the caller, and `ok: false` carries the same typed
 * `CaptureOutcome` the capture path already reports, so the caller that refuses
 * and the caller that audits cannot disagree about the words.
 */
export function resolveCorrelatedRequest(args: Readonly<{
  harness: HarnessResultIdentity["harness"];
  runsRoot: string | undefined;
  runDirectory: string | undefined;
  nativeId: string;
}>): CorrelatedRequestResolution {
  if (args.runsRoot === undefined && args.runDirectory === undefined) {
    return { ok: false, outcome: { kind: "not-an-orchestration-run" } };
  }
  if (args.runsRoot === undefined || args.runDirectory === undefined) {
    return {
      ok: false,
      outcome: retriableFailure(
        "run-authority",
        "orchestration capture requires both runsRoot and runDirectory",
      ),
    };
  }

  const opened = openRegisteredRunDirectory(args.runsRoot, args.runDirectory);
  if (!opened.ok) {
    return { ok: false, outcome: retriableFailure("run-directory", opened.error.message) };
  }
  const handle = opened.value;

  const correlator = handle.readHarnessCorrelator(args.harness, args.nativeId);
  if (!correlator.ok) {
    return { ok: false, outcome: retriableFailure("correlator", correlator.error.message) };
  }
  if (correlator.value === null) {
    return {
      ok: false,
      outcome: {
        kind: "no-reservation",
        agentId: args.nativeId.length === 0 ? "(missing)" : args.nativeId,
      },
    };
  }
  return resolveIssuedMatch(handle, correlator.value);
}

function resolveIssuedMatch(handle: RunDirHandle,
  binding: NonNullable<Extract<ReturnType<RunDirHandle["readHarnessCorrelator"]>, { ok: true }>["value"]>,
): CorrelatedRequestResolution {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) {
    return { ok: false, outcome: retriableFailure("requests", issued.error.message) };
  }
  const request = issued.value.find(({ requestId }) => requestId === binding.requestId);
  if (request === undefined) {
    return {
      ok: false,
      outcome: retriableFailure(
        "unknown-request",
        "correlated request has no issued authority",
      ),
    };
  }
  if (binding.role !== request.role || binding.attempt !== request.attempt) {
    return {
      ok: false,
      outcome: {
        kind: "terminal-rejection",
        reason: "correlator-authority",
        message: `correlator authority ${binding.role}/attempt-${binding.attempt} does not match issued request ${request.role}/attempt-${request.attempt}`,
      },
    };
  }

  const identity: HarnessResultIdentity = Object.freeze({
    harness: binding.harness,
    requestId: binding.requestId,
    attempt: binding.attempt,
    nativeId: binding.nativeId,
  });
  return Object.freeze({
    ok: true,
    value: Object.freeze({ handle, issued: issued.value, identity, request }),
  });
}

/**
 * Capture one finished Agent's result into its reserved slot.
 *
 * Pure with respect to decisions: every refusal is returned as a typed outcome
 * the caller audits rather than guessed at. Terminal refusals that reached a
 * real reservation and left it UNFILLED are durably recorded
 * (`terminalizeCaptureRejection` tombstones the attempt and journals the audit
 * record), because a rejected attempt that left no trace is indistinguishable
 * from an attempt that never happened. Retriable infrastructure failures never
 * tombstone the attempt; environment repair may safely retry it.
 *
 * Two other families write nothing, both because they have nothing to write against.
 * The refusals that never resolved a reservation — `not-an-orchestration-run`,
 * `no-reservation`, `run-authority`, `run-directory`, `correlator`,
 * `requests`, and `unknown-request` — never reached one. And
 * `duplicate-capture` reached a reservation that is already durably FILLED:
 * `rejectCapture` refuses to tombstone a captured attempt by design. Current v3
 * alone may recover a missing receipt, after a fresh native observation proves
 * the original write-ahead request/context/correlator and exact captured bytes.
 * Existing receipts and legacy duplicates remain refusals; replay cannot recover.
 *
 * The adapter supplies the two harness-native facts — the native correlator and
 * every candidate final payload it observed — and nothing else differs between
 * them.
 *
 * Candidates are handed over in full rather than pre-selected: pre-selection is
 * exactly where "pick the last text block" hides an ambiguity the engine should
 * have refused.
 */
type CaptureHarnessInput = Readonly<{
  harness: HarnessResultIdentity["harness"];
  runsRoot: string | undefined;
  runDirectory: string | undefined;
  nativeId: string;
}> & (
  | Readonly<{ observe: () => CaptureObservation; candidates?: never }>
  | Readonly<{ candidates: readonly FinalPayloadCandidate[]; observe?: never }>
);

type NativeCapturePurpose = "legacy" | "standalone-successor";

function readNativeCapturePurpose(handle: RunDirHandle): DomainResult<NativeCapturePurpose, string> {
  const registration = handle.readProgramRegistration(16_777_216);
  if (!registration.ok) return { ok: false, error: registration.error.message };
  const raw = registration.value;
  const successor = typeof raw === "object" && raw !== null && Object.getOwnPropertyDescriptor(raw, "schemaVersion")?.value === 3 &&
    Object.getOwnPropertyDescriptor(raw, "kind")?.value === "standalone-review";
  if (successor && !parseStandaloneReviewerProtocolV3(Object.getOwnPropertyDescriptor(raw, "reviewerProtocol")?.value).ok) {
    return { ok: false, error: "successor capture requires the exact registered protocol descriptor" };
  }
  return { ok: true, value: successor ? "standalone-successor" : "legacy" };
}

export async function captureHarnessResult(args: CaptureHarnessInput): Promise<CaptureOutcome> {
  const resolved = resolveCorrelatedRequest(args);
  if (!resolved.ok) return resolved.outcome;
  const { handle, issued, identity, request } = resolved.value;

  const reject = (reason: string, message: string): Promise<CaptureOutcome> =>
    terminalizeCaptureRejection(handle, request, terminalCaptureRefusal(reason, message));

  const observation = args.observe === undefined
    ? captureCandidates(args.candidates)
    : args.observe();
  if (observation.kind === "unavailable") return retriableFailure(observation.reason, observation.message);
  if (observation.kind === "terminal-refusal") {
    return terminalizeCaptureRejection(handle, request, observation);
  }
  const purpose = readNativeCapturePurpose(handle);
  if (!purpose.ok) return retriableFailure("registration", purpose.error);
  if (purpose.value === "standalone-successor" && observation.candidates.some(candidate => Buffer.byteLength(candidate.text, "utf8") > 1_048_576)) {
    return reject("payload-byte-limit", "native successor final exceeds the unchanged 1048576-byte reviewer budget");
  }
  const payload = parseFinalPayload(observation.candidates);
  if (!payload.ok) return reject(payload.error.reason, payload.error.message);

  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return retriableFailure("transcripts", captured.error.message);
  const bound = bindCapture({
    issued,
    identity,
    payload: payload.value,
    // Only current native capture can reconcile an unreceipted write. Its durable
    // observation and exact bytes are proved below; legacy duplicate rules stay intact.
    alreadyCaptured: purpose.value === "standalone-successor" ? new Set() : captured.value,
  });
  if (!bound.ok) {
    // `duplicate-capture` is the one bind refusal that must NOT tombstone: the
    // slot already holds accepted bytes, and `rejectCapture` refuses a captured
    // attempt. Every other bind refusal leaves the reservation unfilled.
    return bound.error.reason === "duplicate-capture"
      ? { kind: "terminal-rejection", reason: bound.error.reason, message: bound.error.message }
      : reject(bound.error.reason, bound.error.message);
  }

  return persistBoundCapture(handle, request, bound.value, payload.value, purpose.value,
    captured.value.has(captureKey(request.slotId, request.attempt)) ? "recapture" : "fresh");
}

async function persistBoundCapture(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  payload: FinalPayload,
  purpose: NativeCapturePurpose,
  observation: "fresh" | "recapture",
): Promise<CaptureOutcome> {
  const context = purpose === "standalone-successor" && request.program === "standalone-review"
    ? handle.readStandaloneSuccessorContext(request.contextDigest, 16_777_216)
    : handle.readContext(request.contextDigest);
  if (!context.ok) return retriableFailure("context", context.error.message);
  if (context.value.requestId !== request.requestId || context.value.role !== request.role) {
    return terminalizeCaptureRejection(handle, request, terminalCaptureRefusal(
      "context-binding",
      `context ${request.contextDigest} does not describe request ${request.requestId}/${request.role}`,
    ));
  }
  if (purpose === "standalone-successor" && request.program === "refutation-panel") {
    if (context.value.schemaVersion === 3) return retriableFailure("context", "refutation uses its own explicit packet contract");
    const view = verifyStandalonePanelView(handle, context.value);
    if (!view.ok) return retriableFailure("context", view.error);
  }
  if (purpose === "standalone-successor") return persistNativeCapture(handle, request, receipt, payload, observation);
  const written = await handle.captureTranscript(request, payload.bytes);
  if (!written.ok) {
    const rejection = handle.readCaptureRejection(request);
    return rejection.ok && rejection.value !== null
      ? { kind: "terminal-rejection", reason: "transcript", message: written.error.message }
      : retriableFailure("transcript", written.error.message);
  }

  return { kind: "captured", receipt };
}

async function observeNativeCaptureArtifact(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  payload: FinalPayload,
  observation: "fresh" | "recapture",
): Promise<DomainResult<ArtifactRef, string>> {
  const path = `native-capture-observations/${request.requestId}.json`;
  if (observation === "recapture") {
    const prior = handle.readArtifactBytes(path, 16_384);
    if (!prior.ok) return { ok: false, error: prior.error.message };
    const bytes = handle.readTranscriptBytes(request, 1_048_576);
    if (!bytes.ok) return { ok: false, error: bytes.error.message };
    return recoverNativeCaptureArtifact({ request, receipt, payload, observation: prior.value, capturedBytes: bytes.value });
  }
  const bytes = Buffer.from(nativeCaptureObservation(request, receipt, payload.origin));
  if (bytes.length > 16_384) return { ok: false, error: "native capture observation exceeds 16384-byte bound" };
  // Freeze request/context/native identity BEFORE the exclusive raw write. This is
  // inert write-ahead evidence, not a receipt; replay never promotes it to authority.
  const observed = await handle.publishArtifactSet([{ relativePath: path, bytes: [...bytes] }]);
  if (!observed.ok) return { ok: false, error: observed.error.message };
  const written = await handle.captureTranscript(request, payload.bytes);
  return written.ok ? written : { ok: false, error: written.error.message };
}

async function persistNativeCapture(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  payload: FinalPayload,
  observation: "fresh" | "recapture",
): Promise<CaptureOutcome> {
  const effect = parseEffectId(`effect:capture:${createHash("sha256").update(`${request.requestId}:${request.attempt}`).digest("hex")}`);
  if (!effect.ok) return retriableFailure("receipt", effect.error.message);
  const existing = handle.readReceipt(effect.value, 16_384);
  if (!existing.ok) return retriableFailure("receipt", existing.error.message);
  // Any existing receipt (including a foreign/contradictory one) precludes repair.
  // Normal already-receipted duplicate delivery remains a refusal, not a new witness.
  if (existing.value !== null) return { kind: "terminal-rejection", reason: "duplicate-capture", message: "native capture already has a durable receipt; duplicate delivery cannot replace it" };
  const rejected = handle.readCaptureRejection(request);
  if (!rejected.ok) return retriableFailure("transcript", rejected.error.message);
  if (rejected.value !== null) return { kind: "terminal-rejection", reason: "transcript", message: rejected.value };
  const artifact = await observeNativeCaptureArtifact(handle, request, receipt, payload, observation);
  if (!artifact.ok) return retriableFailure("transcript", artifact.error);
  const recorded = await handle.recordReceipt({ kind: "raw-transcript-captured", effectId: effect.value,
    runId: handle.runId, requestId: request.requestId, artifact: artifact.value });
  if (!recorded.ok) return retriableFailure("receipt", `native bytes captured but durable receipt unavailable: ${recorded.error.message}`);
  return { kind: "captured", receipt };
}

/**
 * Render a capture outcome for the audit log, or `null` when there was nothing
 * to capture. Both adapters emit the SAME text: a rejection must be visible,
 * because silence here looks exactly like a run that had nothing to capture.
 */
export function captureAuditLine(prefix: string, outcome: CaptureOutcome): string | null {
  if (outcome.kind === "terminal-rejection") {
    return `${prefix}: rejected (${outcome.reason}): ${outcome.message}\n`;
  }
  if (outcome.kind === "retriable-failure") {
    return `${prefix}: retriable failure (${outcome.reason}): ${outcome.message}\n`;
  }
  if (outcome.kind === "no-reservation") {
    return `${prefix}: no reservation for ${outcome.agentId}\n`;
  }
  if (outcome.kind === "captured") {
    return `${prefix}: captured ${outcome.receipt.requestId} (${outcome.receipt.byteLength} bytes)\n`;
  }
  return null;
}
