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
 * to observe an Agent's final payload, and what its own correlator is.
 */

import { match } from "ts-pattern";
import {
  bindCapture,
  captureRejectionAuditRecord,
  captureRejectionDedupKey,
  parseFinalPayload,
  type CaptureReceipt,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../core/harness-capture";
import type { AgentRequestAuthority } from "../core/orchestration-contract";
import { openRunDirectory, type HarnessCorrelatorBinding, type RunDirHandle } from "./run-directory-handle";

/**
 * Where a run directory is announced.
 *
 * Operator/harness-supplied only: NO production code writes either variable.
 * Pi's spawn side publishes a durable session run binding instead
 * (`registerSessionRunBinding`, read back by `pi/extension`), and that binding —
 * not the environment — is what carries capture authority across a process
 * boundary today. These two names are the fallback for a supervisor or a test
 * driving a harness with no binding registry; absent means "this agent is not
 * part of an orchestration run", which is the common case and NOT an error.
 */
export const RUNS_ROOT_ENV = "LOOM_ORCHESTRATION_RUNS_ROOT";
export const RUN_DIR_ENV = "LOOM_ORCHESTRATION_RUN_DIR";

export type CaptureOutcome =
  | Readonly<{ kind: "not-an-orchestration-run" }>
  | Readonly<{ kind: "no-reservation"; agentId: string }>
  | Readonly<{ kind: "captured"; receipt: CaptureReceipt }>
  | Readonly<{ kind: "rejected"; reason: string; message: string }>;

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
    .with({ kind: "rejected" }, ({ reason, message }) => `${reason}: ${message}`)
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
 * The refusal arrives either split (`reason` + `message`, what the shared rules
 * produce) or already composed (`diagnostic`, what the adapters' own authority
 * checks produce); the durable text each harness writes today is preserved
 * exactly, and only the failure handling is shared.
 *
 * It never throws, and it never loses the cause. When the tombstone cannot be
 * written the returned message carries the ORIGINAL refusal as well as the
 * persistence error, because at that point no on-disk trace of the reason exists
 * at all and "rejection-persistence" alone would name the wrong component.
 */
export async function terminalizeCaptureRejection(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  refusal: Readonly<{ reason: string; message: string }> | Readonly<{ diagnostic: string }>,
): Promise<CaptureOutcome> {
  const reason = "reason" in refusal ? refusal.reason : "capture-rejection";
  const message = "message" in refusal ? refusal.message : refusal.diagnostic;
  const diagnostic = "diagnostic" in refusal ? refusal.diagnostic : `${refusal.reason}: ${refusal.message}`;
  const terminal = await handle.rejectCapture(request, diagnostic);
  if (!terminal.ok) {
    return {
      kind: "rejected",
      reason: "rejection-persistence",
      message: `capture refused (${diagnostic}) and its rejection could not be persisted: ${terminal.error.message}`,
    };
  }
  try {
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: captureRejectionDedupKey(request.requestId, request.attempt),
      recordedAtMs: Date.now(),
      event: captureRejectionAuditRecord(request, diagnostic),
    });
    return { kind: "rejected", reason, message };
  } catch (error) {
    return {
      kind: "rejected",
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
  /** The role the reservation recorded for this correlator — never the payload's say-so. */
  correlatorRole: HarnessCorrelatorBinding["role"];
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
      outcome: {
        kind: "rejected",
        reason: "run-authority",
        message: "orchestration capture requires both runsRoot and runDirectory",
      },
    };
  }

  const opened = openRunDirectory(args.runsRoot, args.runDirectory);
  if (!opened.ok) {
    return { ok: false, outcome: { kind: "rejected", reason: "run-directory", message: opened.error.message } };
  }
  const handle = opened.value;

  const correlator = handle.readHarnessCorrelator(args.harness, args.nativeId);
  if (!correlator.ok) {
    return { ok: false, outcome: { kind: "rejected", reason: "correlator", message: correlator.error.message } };
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
  const binding = correlator.value;

  const issued = handle.readIssuedRequests();
  if (!issued.ok) {
    return { ok: false, outcome: { kind: "rejected", reason: "requests", message: issued.error.message } };
  }
  const request = issued.value.find(({ requestId }) => requestId === binding.requestId);
  if (request === undefined) {
    return {
      ok: false,
      outcome: {
        kind: "rejected",
        reason: "unknown-request",
        message: "correlated request has no issued authority",
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
    value: Object.freeze({ handle, correlatorRole: binding.role, issued: issued.value, identity, request }),
  });
}

/**
 * Capture one finished Agent's result into its reserved slot.
 *
 * Pure with respect to decisions: every refusal is returned as a typed outcome
 * the caller audits rather than thrown or guessed at. What is written differs
 * by outcome, not whether anything is written at all — a refusal that reached a
 * real reservation and left it UNFILLED is itself durably recorded
 * (`terminalizeCaptureRejection` tombstones the attempt and journals the audit
 * record), because a rejected attempt that left no trace is indistinguishable
 * from an attempt that never happened.
 *
 * Two families write nothing, both because they have nothing to write against.
 * The refusals that never resolved a reservation — `not-an-orchestration-run`,
 * `no-reservation`, `run-authority`, `run-directory`, `correlator`,
 * `requests`, and `unknown-request` — never reached one. And
 * `duplicate-capture` reached a reservation that is already durably FILLED:
 * `rejectCapture` refuses to tombstone a captured attempt by design, since the
 * accepted evidence is the record.
 *
 * The adapter supplies the two harness-native facts — the native correlator and
 * every candidate final payload it observed — and nothing else differs between
 * them.
 *
 * Candidates are handed over in full rather than pre-selected: pre-selection is
 * exactly where "pick the last text block" hides an ambiguity the engine should
 * have refused.
 */
export async function captureHarnessResult(args: Readonly<{
  harness: HarnessResultIdentity["harness"];
  runsRoot: string | undefined;
  runDirectory: string | undefined;
  nativeId: string;
  candidates: readonly FinalPayloadCandidate[];
}>): Promise<CaptureOutcome> {
  const resolved = resolveCorrelatedRequest(args);
  if (!resolved.ok) return resolved.outcome;
  const { handle, correlatorRole, issued, identity, request } = resolved.value;

  const reject = (reason: string, message: string): Promise<CaptureOutcome> =>
    terminalizeCaptureRejection(handle, request, { reason, message });

  const payload = parseFinalPayload(args.candidates);
  if (!payload.ok) return reject(payload.error.reason, payload.error.message);

  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return reject("transcripts", captured.error.message);
  const bound = bindCapture({
    issued,
    identity,
    payload: payload.value,
    alreadyCaptured: captured.value,
  });
  if (!bound.ok) {
    // `duplicate-capture` is the one bind refusal that must NOT tombstone: the
    // slot already holds accepted bytes, and `rejectCapture` refuses a captured
    // attempt. Every other bind refusal leaves the reservation unfilled.
    return bound.error.reason === "duplicate-capture"
      ? { kind: "rejected", reason: bound.error.reason, message: bound.error.message }
      : reject(bound.error.reason, bound.error.message);
  }

  if (correlatorRole !== request.role) {
    return reject(
      "wrong-agent-role",
      `native ${args.harness} result is bound as ${correlatorRole}, not ${request.role}`,
    );
  }
  const context = handle.readContext(request.contextDigest);
  if (!context.ok) return reject("context", context.error.message);
  if (context.value.requestId !== request.requestId || context.value.role !== request.role) {
    return reject(
      "context-binding",
      `context ${request.contextDigest} does not describe request ${request.requestId}/${request.role}`,
    );
  }
  const written = await handle.captureTranscript(request, payload.value.bytes);
  if (!written.ok) return reject("transcript", written.error.message);

  return { kind: "captured", receipt: bound.value };
}

/**
 * Render a capture outcome for the audit log, or `null` when there was nothing
 * to capture. Both adapters emit the SAME text: a rejection must be visible,
 * because silence here looks exactly like a run that had nothing to capture.
 */
export function captureAuditLine(prefix: string, outcome: CaptureOutcome): string | null {
  if (outcome.kind === "rejected") {
    return `${prefix}: rejected (${outcome.reason}): ${outcome.message}\n`;
  }
  if (outcome.kind === "no-reservation") {
    return `${prefix}: no reservation for ${outcome.agentId}\n`;
  }
  if (outcome.kind === "captured") {
    return `${prefix}: captured ${outcome.receipt.requestId} (${outcome.receipt.byteLength} bytes)\n`;
  }
  return null;
}
