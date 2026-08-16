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

import { createHash } from "node:crypto";
import {
  bindCapture,
  parseFinalPayload,
  type CaptureKey,
  type CaptureReceipt,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../core/harness-capture";
import type { AgentRequestAuthority } from "../core/orchestration-contract";
import { openRunDirectory, type RunDirHandle } from "./run-directory-handle";

/**
 * Where a run directory is announced. Set by the spawn side; absent for every
 * agent that is not part of an orchestration run, which is the common case and
 * NOT an error.
 */
export const RUNS_ROOT_ENV = "LOOM_ORCHESTRATION_RUNS_ROOT";
export const RUN_DIR_ENV = "LOOM_ORCHESTRATION_RUN_DIR";

export type CaptureOutcome =
  | Readonly<{ kind: "not-an-orchestration-run" }>
  | Readonly<{ kind: "no-reservation"; agentId: string }>
  | Readonly<{ kind: "captured"; receipt: CaptureReceipt }>
  | Readonly<{ kind: "rejected"; reason: string; message: string }>;

/** Every request this run reserved, read through the anchored handle. */
export function readIssuedRequests(handle: RunDirHandle): readonly AgentRequestAuthority[] {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) throw new Error(issued.error.message);
  return issued.value;
}

/** Exact semantic attempts whose transcript already landed. */
export function alreadyCapturedAttempts(handle: RunDirHandle): ReadonlySet<CaptureKey> {
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) throw new Error(captured.error.message);
  return captured.value;
}

/** Historical import name retained while its value is now attempt-specific. */
export const alreadyCapturedSlots = alreadyCapturedAttempts;

/**
 * Resolve the reservation a finished Agent answers for.
 *
 * Neither harness hands the request id back, so it is recovered by matching the
 * spawn-time correlator recorded in its immutable, descriptor-anchored binding
 * beside the reservation. A result with no binding belongs to some other agent
 * — a `no-reservation`, not a failure; an unreadable binding is a rejection.
 */
export function readCorrelatorIdentity(
  handle: RunDirHandle,
  harness: HarnessResultIdentity["harness"],
  nativeId: string,
): HarnessResultIdentity | null {
  if (nativeId.length === 0) return null;
  const resolved = handle.readHarnessCorrelator(harness, nativeId);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.value === null
    ? null
    : Object.freeze({
        harness: resolved.value.harness,
        requestId: resolved.value.requestId,
        attempt: resolved.value.attempt,
        nativeId: resolved.value.nativeId,
      });
}

/**
 * Capture one finished Agent's result into its reserved slot.
 *
 * Pure with respect to decisions: every refusal is returned as a typed outcome
 * the caller audits rather than thrown or guessed at. What is written differs
 * by outcome, not whether anything is written at all — a refusal that reached a
 * real reservation is itself durably recorded (`rejectCapture` tombstones the
 * attempt and a `request-capture-rejected` event lands in the journal), because
 * a rejected attempt that left no trace is indistinguishable from an attempt
 * that never happened. Only the refusals that never resolved a reservation —
 * `not-an-orchestration-run`, `no-reservation`, and the run-authority/
 * run-directory/correlator rejections above it — write nothing, having nothing
 * to write against.
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
  if (args.runsRoot === undefined && args.runDirectory === undefined) {
    return { kind: "not-an-orchestration-run" };
  }
  if (args.runsRoot === undefined || args.runDirectory === undefined) {
    return {
      kind: "rejected",
      reason: "run-authority",
      message: "orchestration capture requires both runsRoot and runDirectory",
    };
  }

  const opened = openRunDirectory(args.runsRoot, args.runDirectory);
  if (!opened.ok) return { kind: "rejected", reason: "run-directory", message: opened.error.message };
  const handle = opened.value;

  const correlator = handle.readHarnessCorrelator(args.harness, args.nativeId);
  if (!correlator.ok) {
    return { kind: "rejected", reason: "correlator", message: correlator.error.message };
  }
  if (correlator.value === null) {
    return { kind: "no-reservation", agentId: args.nativeId.length === 0 ? "(missing)" : args.nativeId };
  }
  const identity: HarnessResultIdentity = Object.freeze({
    harness: correlator.value.harness,
    requestId: correlator.value.requestId,
    attempt: correlator.value.attempt,
    nativeId: correlator.value.nativeId,
  });

  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { kind: "rejected", reason: "requests", message: issued.error.message };
  const request = issued.value.find(({ requestId }) => requestId === identity.requestId);
  if (request === undefined) {
    return { kind: "rejected", reason: "unknown-request", message: "correlated request has no issued authority" };
  }
  const reject = async (reason: string, message: string): Promise<CaptureOutcome> => {
    const terminal = await handle.rejectCapture(request, `${reason}: ${message}`);
    if (!terminal.ok) {
      return { kind: "rejected", reason: "rejection-persistence", message: terminal.error.message };
    }
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `capture-rejected:${createHash("sha256").update(`${request.requestId}:${request.attempt}`).digest("hex")}`,
      recordedAtMs: Date.now(),
      event: {
        kind: "request-capture-rejected",
        requestId: request.requestId,
        slotId: request.slotId,
        attempt: request.attempt,
        diagnostic: `${reason}: ${message}`,
      },
    });
    return { kind: "rejected", reason, message };
  };

  const payload = parseFinalPayload(args.candidates);
  if (!payload.ok) return reject(payload.error.reason, payload.error.message);

  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { kind: "rejected", reason: "transcripts", message: captured.error.message };
  const bound = bindCapture({
    issued: issued.value,
    identity,
    payload: payload.value,
    alreadyCaptured: captured.value,
  });
  if (!bound.ok) return { kind: "rejected", reason: bound.error.reason, message: bound.error.message };

  if (correlator.value.role !== request.role) {
    return {
      kind: "rejected",
      reason: "wrong-agent-role",
      message: `native ${args.harness} result is bound as ${correlator.value.role}, not ${request.role}`,
    };
  }
  const context = handle.readContext(request.contextDigest);
  if (!context.ok) {
    return { kind: "rejected", reason: "context", message: context.error.message };
  }
  if (context.value.requestId !== request.requestId || context.value.role !== request.role) {
    return {
      kind: "rejected",
      reason: "context-binding",
      message: `context ${request.contextDigest} does not describe request ${request.requestId}/${request.role}`,
    };
  }
  const written = await handle.captureTranscript(request, payload.value.bytes);
  if (!written.ok) return { kind: "rejected", reason: "transcript", message: written.error.message };

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
  if (outcome.kind === "captured") {
    return `${prefix}: captured ${outcome.receipt.requestId} (${outcome.receipt.byteLength} bytes)\n`;
  }
  return null;
}
