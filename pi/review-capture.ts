/**
 * Pi capture of one request-bound subagent result.
 *
 * Authenticates a launcher's pre-prompt emission startup refusal against the
 * reserved launch, and turns a finalized Pi transcript into the shared
 * capture runtime's observation: the correlated request is authenticated by
 * the same `authenticatePiIssuedReviewRequest` spawn admission crosses, the
 * issued reviewer emission binding selects between emission-tool arguments
 * and final-message extraction, archived and refutation requests keep
 * explicit extraction, and every refusal stays typed.
 */

import { isRecord } from "../engine/src/core/plain-record";
import { parseSessionId } from "../engine/src/machine";
import {
  captureAuditLine,
  captureCandidates,
  captureHarnessResult,
  captureUnavailable,
  describeCaptureFailure,
  resolveCorrelatedRequest,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  terminalCaptureRefusal,
  type CaptureObservation,
  type CaptureOutcome,
  type TerminalCaptureRefusal,
} from "../engine/src/orchestration/harness-capture-runtime";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { observeEmissionCalls, type FinalPayload } from "../engine/src/core/harness-capture";
import { selectCanonicalPayload } from "../engine/src/core/emission-ingestion";
import { issueEmissionBinding, type IssuedEmissionBindingOf } from "../engine/src/core/emission-tool";
import {
  boundDiagnosticMessage,
  boundedThrownCause,
} from "../engine/src/core/orchestration-contract/identity";
import {
  parseContextDigest,
  parseRequestId,
  type ContextDigest,
  type RequestId,
} from "../engine/src/core/orchestration-contract";
import { piEmissionCallFrames, piResultFinalPayloadCandidates } from "./transcript-adapter";
import type { PiSubagentResultEntry } from "./subagent-result-batch";
import {
  exactFields,
  parsePiSubagentLaunchSlot,
  sameLaunchSlot,
  type PiSubagentLaunchSlot,
} from "./emission-launch-bridge";
import {
  authenticatePiIssuedReviewRequest,
  piRequestCorrelation,
  type PiIssuedReviewRequestClass,
} from "./review-run-authority";
import type { PiSessionId, PiSpawnReservation, PiSpawnReservationItem } from "./spawn-reservation";
import { piSpawnRosterId } from "./tool-input";

type PiEmissionStartupRefusalMarker = Readonly<{
  kind: "emission-startup-refused";
  sessionId: PiSessionId;
  toolCallId: string;
  slot: PiSubagentLaunchSlot;
  requestId: RequestId;
  contextDigest: ContextDigest;
  toolName: string;
  phase: "before-task-prompt";
  reason: string;
}>;

type PiEmissionStartupMarkerObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed"; reason: string }>
  | Readonly<{ kind: "parsed"; marker: PiEmissionStartupRefusalMarker }>;

/** Parse only the installed launcher's closed pre-prompt outcome. This is
 * transport evidence, not model text: stderr, errorMessage, and guessed stop
 * reasons deliberately have no constructor here. */
function parsePiEmissionStartupMarker(rawResult: unknown): PiEmissionStartupMarkerObservation {
  if (!isRecord(rawResult) || !Object.hasOwn(rawResult, "launchOutcome")) {
    return Object.freeze({ kind: "absent" as const });
  }
  const raw = rawResult.launchOutcome;
  const fields = [
    "kind", "sessionId", "toolCallId", "slot", "requestId", "contextDigest", "toolName", "phase", "reason",
  ] as const;
  if (!isRecord(raw) || !exactFields(raw, fields)) {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome is not the exact startup-refusal record" });
  }
  if (raw.kind !== "emission-startup-refused" || raw.phase !== "before-task-prompt") {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome does not attest the before-task-prompt phase" });
  }
  const sessionId = typeof raw.sessionId === "string" ? parseSessionId(raw.sessionId) : null;
  const requestId = parseRequestId(raw.requestId);
  const contextDigest = parseContextDigest(raw.contextDigest);
  const parsedSlot = parsePiSubagentLaunchSlot(raw.slot);
  if (sessionId === null || !requestId.ok || !contextDigest.ok ||
      typeof raw.toolCallId !== "string" || raw.toolCallId.length === 0 ||
      typeof raw.toolName !== "string" || raw.toolName.length === 0 ||
      typeof raw.reason !== "string" || raw.reason.length === 0 || Buffer.byteLength(raw.reason, "utf8") > 1024 ||
      parsedSlot === null) {
    return Object.freeze({ kind: "malformed" as const, reason: "launchOutcome carries malformed identity, slot, or reason fields" });
  }
  return Object.freeze({
    kind: "parsed" as const,
    marker: Object.freeze({
      kind: "emission-startup-refused" as const,
      sessionId,
      toolCallId: raw.toolCallId,
      slot: parsedSlot,
      requestId: requestId.value,
      contextDigest: contextDigest.value,
      toolName: raw.toolName,
      phase: "before-task-prompt" as const,
      reason: raw.reason,
    }),
  });
}

type PiEmissionStartupClassification =
  | Readonly<{ kind: "ordinary" }>
  | Readonly<{ kind: "untrusted-marker"; reason: string }>
  | Readonly<{ kind: "proven-startup-refusal"; marker: PiEmissionStartupRefusalMarker }>;

export function classifyPiEmissionStartupRefusal(input: Readonly<{
  rawResult: unknown;
  result: Extract<PiSubagentResultEntry, { ok: true }>["result"];
  reservation: PiSpawnReservation;
  reservedItem: PiSpawnReservationItem;
  runBinding: SessionRunBinding;
  toolCallId: unknown;
  resultIndex: number;
  agentType: string;
}>): PiEmissionStartupClassification {
  let observed: PiEmissionStartupMarkerObservation;
  try {
    observed = parsePiEmissionStartupMarker(input.rawResult);
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "launchOutcome");
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: `launchOutcome inspection failed (${cause.name}: ${cause.message})`,
    });
  }
  if (observed.kind === "absent") return Object.freeze({ kind: "ordinary" as const });
  if (observed.kind === "malformed") {
    return Object.freeze({ kind: "untrusted-marker" as const, reason: observed.reason });
  }
  const expected = input.reservedItem.emissionLaunch;
  const marker = observed.marker;
  if (expected === null || input.result.exitCode === 0 ||
      !Array.isArray(input.result.messages) || input.result.messages.length !== 0 ||
      marker.sessionId !== input.reservation.sessionId || marker.toolCallId !== input.toolCallId ||
      !sameLaunchSlot(marker.slot, expected.slot) || marker.requestId !== expected.binding.requestId ||
      marker.contextDigest !== expected.contextDigest || marker.toolName !== expected.binding.toolName) {
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: "launchOutcome does not exactly match the reserved failed launch and its empty pre-prompt transcript",
    });
  }
  const correlation = piRequestCorrelation(input.runBinding, input.toolCallId, input.resultIndex, input.agentType);
  if (!correlation.ok || correlation.value.request.requestId !== expected.binding.requestId ||
      correlation.value.request.contextDigest !== expected.contextDigest) {
    return Object.freeze({
      kind: "untrusted-marker" as const,
      reason: "launchOutcome has no independently authenticated issued request binding",
    });
  }
  return Object.freeze({ kind: "proven-startup-refusal" as const, marker });
}

const captureSelectedPiPayload = (payload: FinalPayload): CaptureObservation =>
  captureCandidates(Object.freeze([Object.freeze({ origin: payload.origin, text: payload.text })]));

/**
 * Pure Pi transcript decision for one authenticated reviewer emission binding.
 * The adapter observes finalized execution, then the shared core selects once;
 * this shell projection only translates that closed decision into the existing
 * capture runtime vocabulary.
 */
function piReviewerCaptureFromObservation(
  issued: IssuedEmissionBindingOf<"reviewer-payload">,
  observation: ReturnType<typeof observeEmissionCalls>,
  candidates: Extract<ReturnType<typeof piResultFinalPayloadCandidates>, { ok: true }>["value"],
): CaptureObservation {
  const selection = selectCanonicalPayload(issued, observation, candidates);
  switch (selection.kind) {
    case "emission-tool-arguments":
      return captureSelectedPiPayload(selection.payload);
    case "final-message-extraction":
    case "extraction-over-refused-call":
      return selection.fallback.ok
        ? captureSelectedPiPayload(selection.fallback.value)
        : terminalCaptureRefusal(selection.fallback.error.reason, selection.fallback.error.message);
    case "duplicate-emission-call":
      return terminalCaptureRefusal(
        "ambiguous-emission-call",
        "result carried multiple distinct emission tool calls; exactly one successfully executed call is allowed",
      );
    case "refused-call-no-fallback":
      return terminalCaptureRefusal(
        "emission-and-extraction-refused",
        `emission arguments were refused [${selection.emissionRefusal.code}]: ${selection.emissionRefusal.message}; ` +
          `final-message extraction was refused [${selection.extraction.reason}]: ${selection.extraction.message}`,
      );
    case "observation-refused":
      return terminalCaptureRefusal(selection.refusal.code, selection.refusal.message);
  }
}

export function piReviewerCaptureObservation(
  messages: unknown,
  issued: IssuedEmissionBindingOf<"reviewer-payload">,
): CaptureObservation {
  const frames = piEmissionCallFrames(messages, issued);
  if (!frames.ok) {
    return terminalCaptureRefusal("emission-observation", frames.errors.join("; "));
  }
  const observation = observeEmissionCalls(frames.value);
  const candidates = piResultFinalPayloadCandidates(messages, "standalone-successor");
  if (candidates.ok) return piReviewerCaptureFromObservation(issued, observation, candidates.value);

  // The independent scanner may still prove one successfully executed,
  // correctly bound emission when an unrelated transcript entry is malformed.
  // Empty fallback candidates cannot authorize extraction, so the SAME shared
  // decision runs once more over them: the emission-selected arm still captures
  // via captureSelectedPiPayload, and every other arm's own typed refusal is
  // RETAINED and composed with the transcript scan's refusal — the scan's
  // diagnostics can never erase the selection arm's own code or message.
  const selectionOutcome = piReviewerCaptureFromObservation(issued, observation, Object.freeze([]));
  if (selectionOutcome.kind === "terminal-refusal") {
    return terminalCaptureRefusal(
      selectionOutcome.reason,
      `${selectionOutcome.message}; the independent transcript scan also refused: ${candidates.errors.join("; ")}`,
    );
  }
  return selectionOutcome;
}

const archivedReviewerCaptureObservation = (messages: unknown): CaptureObservation => {
  const candidates = piResultFinalPayloadCandidates(messages ?? [], "standalone-successor");
  return candidates.ok
    ? captureCandidates(candidates.value)
    : terminalCaptureRefusal("transcript-shape", candidates.errors.join("; "));
};

/** The production capture decision after request/program/publication authority
 * has been authenticated. Archived reviewer-v1 and refutation requests retain
 * explicit final-message extraction. Current review programs must mint their
 * exact issued v2/v3 binding; a malformed binding is unavailable evidence and
 * can never be reclassified as an archived extraction result. */
export function piIssuedReviewerCaptureObservation(
  classified: PiIssuedReviewRequestClass,
  messages: unknown,
): CaptureObservation {
  if (classified.kind === "refutation-panel-extraction" || classified.claim.version === "v1") {
    return archivedReviewerCaptureObservation(messages);
  }
  const claim = classified.claim;
  const issued = issueEmissionBinding({
    requestId: claim.requestId,
    kind: "reviewer-payload" as const,
    version: claim.version,
    schemaDigest: claim.schemaDigest,
  });
  if (!issued.ok) {
    return captureUnavailable(
      "emission-binding",
      boundDiagnosticMessage(
        `issued reviewer emission binding is unavailable [${issued.error.code}]: ${issued.error.message}`,
      ),
    );
  }
  return piReviewerCaptureObservation(messages ?? [], issued.value);
}

const captureUnclaimedProgramObservation = (
  registration: unknown | null,
  messages: unknown,
): CaptureObservation => {
  if (registration !== null) {
    return captureUnavailable(
      "program-registration",
      "program registration is unavailable: program registration does not name a registered orchestration program",
    );
  }
  // Proven file absence cannot authorize semantic parsing, but the bounded
  // structural walk still rejects hostile decoded input terminally.
  const bounded = piResultFinalPayloadCandidates(messages ?? [], "standalone-successor");
  return bounded.ok
    ? captureUnavailable("program-registration", "program registration is unavailable: program registration does not name a registered orchestration program")
    : terminalCaptureRefusal("transcript-shape", bounded.errors.join("; "));
};

/**
 * Every successful tool result's text in a Pi child's messages, in order: the
 * read-coverage observation's input (ADR-0022). An error result delivered
 * nothing creditable. Each message is read on its own, like the Claude
 * adapter's line walk: one malformed unrelated message withholds only its own
 * text, never credit for every page read — and no message can grant credit,
 * because each counted page is re-verified against the frozen diff text.
 */
export function piToolOutputs(messages: unknown): readonly string[] {
  if (!Array.isArray(messages)) return Object.freeze([]);
  return Object.freeze(messages.flatMap((message: unknown) => {
    if (!isRecord(message) || message["role"] !== "toolResult" || message["isError"] === true || !Array.isArray(message["content"])) return [];
    return [(message["content"] as unknown[]).flatMap((block) =>
      isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []).join("\n")];
  }));
}

export async function capturePiSubagentResult(
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  messages: unknown,
  runBinding: SessionRunBinding | null = null,
  observationRefusal: TerminalCaptureRefusal | null = null,
): Promise<CaptureOutcome> {
  const runsRoot = runBinding?.runsRoot ?? process.env[RUNS_ROOT_ENV];
  const runDirectory = runBinding?.runDirectory ?? process.env[RUN_DIR_ENV];
  const observe = (): CaptureObservation => {
    if (observationRefusal !== null) return observationRefusal;
    const correlation = resolveCorrelatedRequest({ harness: "pi", runsRoot, runDirectory,
      nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType) });
    if (!correlation.ok) {
      return captureUnavailable("request-correlation", describeCaptureFailure(correlation.outcome));
    }
    const { handle, request } = correlation.value;
    const authenticated = authenticatePiIssuedReviewRequest(handle, request, 16_777_216);
    switch (authenticated.kind) {
      case "authenticated":
        return piIssuedReviewerCaptureObservation(authenticated.classified, messages ?? []);
      case "registration-unreadable":
      case "registration-invalid":
        return captureUnavailable("program-registration", `program registration is unavailable: ${authenticated.message}`);
      case "unclaimed-program":
        return captureUnclaimedProgramObservation(authenticated.registration, messages);
      case "unclassified":
        return captureUnavailable("program-registration", authenticated.message);
      case "publication-unavailable":
        return captureUnavailable("request-publication", `reviewer request publication is unavailable: ${authenticated.message}`);
      case "other-program":
        return archivedReviewerCaptureObservation(messages);
    }
  };
  const outcome = await captureHarnessResult({
    harness: "pi",
    runsRoot,
    runDirectory,
    nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
    observe,
    observeToolOutputs: () => piToolOutputs(messages),
  });
  const audit = captureAuditLine("loom(pi): capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  return outcome;
}
