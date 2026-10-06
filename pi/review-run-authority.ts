/**
 * Request-bound review run authority under Pi.
 *
 * Everything that ties a Pi spawn or result to an exactly issued Run
 * Directory request: the task's request/context markers, the session's run
 * bindings, the issued-request read the Spawn Admission's emission port
 * performs, recording native correlators before dispatch, authenticating and
 * terminalising results against their correlated request, and the
 * process-local witnesses of captured transcripts that the Loom review
 * authority bridge replays before it accepts a Standalone Review as done.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  issuedReviewerPayloadClaim,
  qualifyIssuedSpawnEmissionRoute,
  type AdmittedSpawnItem,
  type IssuedSpawnEmissionAuthority,
  type SpawnAdmissionPorts,
} from "../engine/src/core/spawn-admission";
import type { LoomAgentName } from "../engine/src/core/model-profiles";
import { hasStandaloneReviewContext } from "../engine/src/core/review-output";
import { subagentDir } from "../engine/src/config";
import {
  describeCaptureFailure,
  resolveCorrelatedRequest,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  terminalCaptureRefusal,
  terminalizeCaptureRejection,
  type CaptureOutcome,
  type CorrelatedRequestResolution,
} from "../engine/src/orchestration/harness-capture-runtime";
import { openRegisteredRunDirectory, type RunDirHandle } from "../engine/src/orchestration/run-directory-handle";
import {
  parseRegisteredFacadeProgram,
  publishedReviewerRequest,
  readStandaloneReviewedSource,
  renderSpawnTask,
  replayStandaloneResultFromEvidence,
  replayStandaloneCapturedEvidence,
} from "../engine/src/handlers/helpers/programs";
import type { LoomReviewAuthorityReceipt } from "../engine/src/handlers/helpers/programs/review-authority-bridge";
import { readRunBytesNoFollow } from "../engine/src/orchestration/no-follow-fs";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { captureKey, type CaptureKey } from "../engine/src/core/harness-capture";
import { reduceStandaloneReviewMachine } from "../engine/src/core/standalone-review-machine";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import {
  parseArtifactDigest,
  parseContextDigest,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
  type SlotId,
} from "../engine/src/core/orchestration-contract";
import { piSpawnRosterId, replacePiSpawnTask } from "./tool-input";

type TrustedReviewCapture = Readonly<{
  /** The receipt's own branded identities: the witness is compared against
   *  issued authority, so it keeps the authority's types, not bare strings. */
  requestId: RequestId;
  slotId: SlotId;
  attempt: 1 | 2;
  /** The harness-reported agent type, compared against the issued role. */
  role: string;
  /** Branded, because this proof compares two 64-hex fields: as plain strings
   *  the context digest and the transcript digest were mutually interchangeable
   *  at the construction site, which is the one place a swap must be impossible.
   */
  contextDigest: ContextDigest;
  digest: ArtifactDigest;
  byteLength: number;
}>;

type TrustedReviewRun = Readonly<{
  binding: SessionRunBinding;
  captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>;
  touchedAt: number;
}>;

type TrustedReviewRoot = Readonly<{
  nextTouch: number;
  runs: ReadonlyMap<string, TrustedReviewRun>;
}>;

const trustedReviewRuns = new Map<string, Map<string, TrustedReviewRoot>>();
const trustedRunIdentity = ({ runsRoot, runDirectory }: Pick<SessionRunBinding, "runsRoot" | "runDirectory">): string =>
  `${runsRoot}\0${runDirectory}`;

function updateTrustedReviewRun(
  sessionId: string,
  binding: SessionRunBinding,
  updateCaptures: (captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>) => ReadonlyMap<CaptureKey, TrustedReviewCapture>,
): void {
  const sessionRoots = trustedReviewRuns.get(sessionId) ?? new Map<string, TrustedReviewRoot>();
  trustedReviewRuns.set(sessionId, sessionRoots);
  const rootIdentity = resolve(binding.runsRoot);
  const root = sessionRoots.get(rootIdentity) ?? Object.freeze({
    nextTouch: 1,
    runs: new Map<string, TrustedReviewRun>(),
  });
  const identity = trustedRunIdentity(binding);
  const previous = root.runs.get(identity);
  const runs = new Map(root.runs);
  runs.set(identity, Object.freeze({
    binding,
    captures: updateCaptures(previous?.captures ?? new Map<CaptureKey, TrustedReviewCapture>()),
    touchedAt: previous?.touchedAt ?? root.nextTouch,
  }));
  sessionRoots.set(rootIdentity, Object.freeze({
    nextTouch: previous === undefined ? root.nextTouch + 1 : root.nextTouch,
    runs,
  }));
}

/** First exact standalone spawn selects the current run; retries never reorder runs. */
function touchTrustedReviewRun(sessionId: string, binding: SessionRunBinding): void {
  updateTrustedReviewRun(sessionId, binding, captures => captures);
}

/** Session shutdown retires every witness the session accumulated. */
export function forgetTrustedReviewRuns(sessionId: string): void {
  trustedReviewRuns.delete(sessionId);
}

export type PiOrchestrationMarkers = Readonly<{
  requestId: string;
  contextDigest: string;
}>;

export function orchestrationMarkers(task: string, item: string): PiOrchestrationMarkers | null {
  const requestIds = [...task.matchAll(/^LOOM_REQUEST_ID:[ \t]*(\S+)[ \t]*$/gm)].map((match) => match[1]!);
  const contextDigests = [...task.matchAll(/^LOOM_CONTEXT_DIGEST:[ \t]*(\S+)[ \t]*$/gm)].map((match) => match[1]!);
  if (requestIds.length === 0 && contextDigests.length === 0) return null;
  if (requestIds.length !== 1 || contextDigests.length !== 1) {
    throw new Error(`${item} must carry exactly one LOOM_REQUEST_ID and one LOOM_CONTEXT_DIGEST authority marker`);
  }
  return Object.freeze({ requestId: requestIds[0]!, contextDigest: contextDigests[0]! });
}

export function rememberTrustedReviewCapture(
  sessionId: string,
  binding: SessionRunBinding,
  role: string,
  task: string,
  outcome: Extract<CaptureOutcome, { kind: "captured" }>,
): void {
  const markers = orchestrationMarkers(task, `captured ${outcome.receipt.requestId}`);
  if (markers === null || markers.requestId !== outcome.receipt.requestId) {
    throw new Error(`captured request ${outcome.receipt.requestId} is missing its exact task authority markers`);
  }
  const contextDigest = parseContextDigest(markers.contextDigest);
  if (!contextDigest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid context marker: ${contextDigest.error.message}`);
  }
  const digest = parseArtifactDigest(outcome.receipt.digest);
  if (!digest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid receipt digest: ${digest.error.message}`);
  }
  updateTrustedReviewRun(sessionId, binding, previous => {
    const captures = new Map(previous);
    captures.set(
      captureKey(outcome.receipt.slotId, outcome.receipt.attempt),
      Object.freeze({
        requestId: outcome.receipt.requestId,
        slotId: outcome.receipt.slotId,
        attempt: outcome.receipt.attempt,
        role,
        contextDigest: contextDigest.value,
        digest: digest.value,
        byteLength: outcome.receipt.byteLength,
      }),
    );
    return captures;
  });
}

function environmentRunBinding(): SessionRunBinding | null {
  const runsRoot = process.env[RUNS_ROOT_ENV];
  const runDirectory = process.env[RUN_DIR_ENV];
  if (runsRoot === undefined && runDirectory === undefined) return null;
  if (runsRoot === undefined || runDirectory === undefined) {
    throw new Error("Pi orchestration requires both run-root and run-directory authority");
  }
  const opened = openRegisteredRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) throw new Error(issued.error.message);
  return Object.freeze({
    ...opened.value.identity,
    requestIds: Object.freeze(issued.value.map(({ requestId }) => requestId)),
    resultDigest: null,
  });
}

export function sessionRunBinding(
  rawSessionId: string,
  markers: readonly PiOrchestrationMarkers[],
): SessionRunBinding {
  const bindings = readSessionRunBindings(subagentDir(), rawSessionId, "pi");
  if (!bindings.ok) throw new Error(bindings.message);
  const requestIds = new Set(markers.map(({ requestId }) => requestId));
  const candidates = bindings.value.filter((binding) =>
    [...requestIds].every((requestId) => binding.requestIds.some((candidate) => candidate === requestId))
  );
  const matches = candidates.filter((binding) => {
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) throw new Error(issued.error.message);
    return markers.every((marker) => issued.value.some((request) =>
      request.requestId === marker.requestId && request.contextDigest === marker.contextDigest));
  });
  if (matches.length !== 1) {
    const identities = markers.map(({ requestId, contextDigest }) => `${requestId}@${contextDigest}`).join(", ");
    throw new Error(
      matches.length === 0
        ? `no Pi session run binding contains issued request/context authority ${identities}`
        : `multiple Pi session run bindings contain issued request/context authority ${identities}`,
    );
  }
  return matches[0]!;
}

type PiRegisteredReviewProgram =
  | Readonly<{ kind: "standalone-review" | "wave-gate"; schemaVersion: 1 }>
  | Readonly<{
      kind: "standalone-review" | "wave-gate";
      schemaVersion: 2;
      reviewerProtocol: Readonly<{ schemaDigest: string }>;
    }>
  | Readonly<{
      kind: "standalone-review";
      schemaVersion: 3;
      reviewerProtocol: Readonly<{ schemaDigest: string }>;
    }>;

type PiIssuedReviewRequest = Readonly<{
  runId: string;
  requestId: RequestId;
  contextDigest: ContextDigest;
  program: string;
  role: string;
}>;

export type PiIssuedReviewRequestClass =
  | Readonly<{
      kind: "review-program-emission";
      claim: ReturnType<typeof issuedReviewerPayloadClaim>;
    }>
  | Readonly<{
      kind: "refutation-panel-extraction";
      claim: ReturnType<typeof issuedReviewerPayloadClaim>;
    }>;

/**
 * Classify one exactly reserved request against its enclosing registered
 * review program. A refutation panel is a child program of standalone-review
 * or wave-gate, not a second facade registration. Until that child request
 * carries its own issued emission descriptor, its authenticated capability is
 * deliberately represented by the archived no-schema claim: the parent gate
 * therefore preserves final-message extraction and cannot infer a tool from
 * the verifier Agent's broader catalog eligibility.
 */
export function classifyPiIssuedReviewRequest(
  registeredRunId: string,
  program: PiRegisteredReviewProgram,
  request: PiIssuedReviewRequest,
): DomainResult<PiIssuedReviewRequestClass, Readonly<{ message: string }>> {
  if (request.runId !== registeredRunId) {
    return failure({ message: `request ${request.requestId} belongs to another orchestration run` });
  }
  if (request.program === program.kind) {
    return success({
      kind: "review-program-emission",
      claim: issuedReviewerPayloadClaim(program, request),
    });
  }
  if (request.program === "refutation-panel" && request.role === "review-verifier-agent") {
    return success({
      kind: "refutation-panel-extraction",
      claim: issuedReviewerPayloadClaim({ schemaVersion: 1 }, request),
    });
  }
  return failure({ message: `request ${request.requestId} has no matching registered review program` });
}

type PublishedPiReviewRouteAuthority = Readonly<{
  role: LoomAgentName;
  harnessBinding: Readonly<{
    pi: Readonly<{ provider: string; model: string }>;
  }>;
}>;

/**
 * Qualify one classified request from its exact authenticated publication.
 * The request's frozen Pi provider/model binding is the only route input:
 * task text, role eligibility, and the parent's mutable model cannot upgrade
 * extraction-only authority. A hard qualification refusal remains a typed
 * authority failure for the spawn gate rather than a silent degradation.
 */
export function qualifyPiIssuedReviewRequest(
  classified: PiIssuedReviewRequestClass,
  published: PublishedPiReviewRouteAuthority,
): DomainResult<IssuedSpawnEmissionAuthority, Readonly<{ message: string }>> {
  const route = qualifyIssuedSpawnEmissionRoute(classified.claim, published, true);
  if (route.kind === "refused") {
    return failure({
      message: `emission route qualification refused for request ${classified.claim.requestId}: ${route.reason}`,
    });
  }
  return success({ role: published.role, claim: classified.claim, route });
}

/** Route qualification is the one substitutable pure adapter in this read:
 * RunDirectory reservation, registration, and publication authentication stay
 * fixed here. Production uses the frozen issued route; acceptance supplies the
 * explicit capable-route adapter already used by the T6 projection fixtures. */
export type PiIssuedReviewRouteQualifier = typeof qualifyPiIssuedReviewRequest;

/** Authenticate a descriptor against this session's reserved Run Directory
 *  request before the pure admission may enable an emission capability. */
export function readPiIssuedSpawnRequest(
  sessionId: string | null,
  requestId: RequestId,
  contextDigest: ContextDigest,
  agent: LoomAgentName,
  qualifyRoute: PiIssuedReviewRouteQualifier = qualifyPiIssuedReviewRequest,
): ReturnType<SpawnAdmissionPorts["readIssuedRequest"]> {
  if (sessionId === null) return failure({ message: "Pi session identity is unavailable" });
  try {
    const binding = environmentRunBinding() ?? sessionRunBinding(sessionId, [{ requestId, contextDigest }]);
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) return failure({ message: opened.error.message });
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) return failure({ message: issued.error.message });
    const matches = issued.value.filter((candidate) => candidate.requestId === requestId);
    if (matches.length !== 1 || matches[0]!.contextDigest !== contextDigest || matches[0]!.role !== agent) {
      return failure({ message: `no unique reserved ${agent} request ${requestId} binds context ${contextDigest}` });
    }
    const request = matches[0]!;
    const stored = opened.value.readProgramRegistration();
    if (!stored.ok) return failure({ message: stored.error.message });
    const registration = parseRegisteredFacadeProgram(stored.value);
    if (registration.kind !== "registered" ||
        (registration.program.kind !== "wave-gate" && registration.program.kind !== "standalone-review")) {
      return failure({ message: `request ${requestId} has no matching registered review program` });
    }
    const classified = classifyPiIssuedReviewRequest(opened.value.runId, registration.program, request);
    if (!classified.ok) return classified;
    // Reservation and registration do not issue a spawn. The exact immutable
    // publication receipt must independently authenticate this same authority.
    const published = publishedReviewerRequest(opened.value, request);
    if (!published.ok) return failure({ message: published.message });
    return qualifyRoute(classified.value, published.value.authority);
  } catch (error) {
    return failure({ message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Record Pi spawn correlators into their reserved run-directory slots before dispatch.
 *
 * Pi's native correlator is `piSpawnRosterId(toolCallId, index, agent)` — the
 * same stable per-spawn identity the lifecycle registry already uses, and the
 * only thing available on both the spawn and result sides of a Pi batch. The
 * spawn side records it beside the reservation.
 *
 * What an ABSENT correlator means then depends on whether this result is bound
 * to a run at all. An unbound agent (no session run binding, no request markers)
 * belongs to nobody's run and is left alone — that is the ordinary ad-hoc case,
 * not a failure. A REQUEST-BOUND result whose correlator cannot be resolved is
 * the opposite: `piResultAuthorityProblem` names it, the result loop records it
 * as a processing error, and `persistCaptureRejection` terminalises the
 * reservation, because a run directory exists precisely to collect that result.
 *
 * This is a fail-spawn boundary and therefore throws when exact run/request
 * authority cannot be recorded. The tool-call guard catches the failure,
 * rolls back lifecycle reservations, and refuses dispatch.
 */
export async function recordPiSpawnCorrelators(
  itemAdmissions: readonly AdmittedSpawnItem[],
  rosterIds: readonly string[],
  rawSessionId: string,
  rawInput: unknown,
): Promise<SessionRunBinding | null> {
  if (itemAdmissions.length !== rosterIds.length) throw new Error("Pi correlator roster length does not match spawn batch");
  const parsedMarkers = itemAdmissions.map(({ item }, index) =>
    orchestrationMarkers(item.task, `Pi spawn item ${index + 1}/${item.agent}`));
  const marked = parsedMarkers.filter((markers): markers is PiOrchestrationMarkers => markers !== null);
  const explicit = environmentRunBinding();
  if (marked.length === 0 && explicit === null) return null;
  if (marked.length !== itemAdmissions.length) {
    throw new Error("Pi orchestration spawn batch must not mix request-bound and unbound items");
  }
  const runBinding = explicit ?? sessionRunBinding(rawSessionId, marked);
  const opened = openRegisteredRunDirectory(runBinding.runsRoot, runBinding.runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) throw new Error(issued.error.message);
  const captured = opened.value.readCapturedAttempts();
  if (!captured.ok) throw new Error(captured.error.message);
  const available = issued.value.filter(
    (request) => !captured.value.has(captureKey(request.slotId, request.attempt)),
  );
  const consumed = new Set<string>();
  const canonicalTasks: string[] = [];

  for (const [index, admission] of itemAdmissions.entries()) {
    const { item } = admission;
    const markers = parsedMarkers[index]!;
    if (markers === null) throw new Error("Pi orchestration marker completeness invariant failed");
    const exactRequestId = markers.requestId;
    const request = available.find((candidate) => candidate.requestId === exactRequestId);
    if (request === undefined || consumed.has(request.requestId)) {
      throw new Error(`issued request ${exactRequestId} is unavailable for Pi spawn item ${index + 1}/${item.agent}`);
    }
    const captureRejection = opened.value.readCaptureRejection(request);
    if (!captureRejection.ok) throw new Error(captureRejection.error.message);
    if (captureRejection.value !== null) {
      const retryAuthority = request.attempt === 1
        ? "a new attempt-2 issuance is required"
        : "attempt 2 is terminal; no further issuance is permitted";
      throw new Error(
        `issued request ${exactRequestId} attempt ${request.attempt} is terminally rejected; ${retryAuthority}`,
      );
    }
    if (request.role !== item.agent) {
      throw new Error(`issued request ${exactRequestId} belongs to ${request.role}, not Pi spawn item role ${item.agent}`);
    }
    if (request.contextDigest !== markers.contextDigest) {
      throw new Error(`issued request ${exactRequestId} context digest does not match the Pi spawn marker`);
    }
    const nativeId = rosterIds[index];
    if (nativeId === undefined) throw new Error(`Pi spawn item ${index + 1} has no native correlator`);
    const recorded = await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    // Emission admission already authenticated this exact task's issuance
    // markers and descriptor. Re-rendering through the durable fallback here
    // could erase a descriptor selected by an explicit transport-route adapter;
    // extraction-only tasks retain the established canonical re-render.
    canonicalTasks[index] = admission.emissionExpectation.kind === "emission-enabled"
      ? item.task
      : renderSpawnTask(
          opened.value,
          request,
          "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required result.",
          { standalone: hasStandaloneReviewContext(item.task) },
        );
    consumed.add(request.requestId);
  }
  for (const [index, task] of canonicalTasks.entries()) replacePiSpawnTask(rawInput, index, task);
  if (itemAdmissions.some(({ item }) => hasStandaloneReviewContext(item.task))) {
    touchTrustedReviewRun(rawSessionId, runBinding);
  }
  return runBinding;
}

/** Resolve one Pi result through the shared harness correlation protocol. */
export function piRequestCorrelation(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
): CorrelatedRequestResolution {
  return resolveCorrelatedRequest({
    harness: "pi",
    runsRoot: runBinding.runsRoot,
    runDirectory: runBinding.runDirectory,
    nativeId: piSpawnRosterId(toolCallId, resultIndex, agentType),
  });
}

/**
 * Terminalise one Pi-side capture refusal against its exact reservation.
 *
 * Only the CORRELATION step is Pi-specific here; the tombstone, the journal
 * record, and the audit outcome come from `terminalizeCaptureRejection`, so the
 * two harnesses cannot disagree about what a refusal durably means. Returns the
 * operator-facing failure text, or null when the refusal was recorded cleanly.
 */
export async function recordPiRequestCaptureRejection(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  diagnostic: string,
): Promise<string | null> {
  const correlation = piRequestCorrelation(runBinding, toolCallId, resultIndex, agentType);
  if (!correlation.ok) {
    const unresolved = correlation.outcome;
    if (unresolved.kind === "no-reservation") {
      return `cannot resolve correlator for ${agentType}[${resultIndex}]: no binding found`;
    }
    if (unresolved.kind === "not-an-orchestration-run") {
      return `cannot open run directory ${runBinding.runDirectory}: orchestration run authority was unavailable`;
    }
    if (unresolved.kind === "captured") {
      return `cannot resolve correlator for ${agentType}[${resultIndex}]: correlation returned a capture receipt`;
    }
    switch (unresolved.reason) {
      case "run-directory":
        return `cannot open run directory ${runBinding.runDirectory}: ${unresolved.message}`;
      case "correlator":
        return `cannot resolve correlator for ${agentType}[${resultIndex}]: ${unresolved.message}`;
      case "requests":
        return `cannot read issued requests: ${unresolved.message}`;
      case "unknown-request":
        return unresolved.message;
      default:
        return describeCaptureFailure(unresolved);
    }
  }

  const outcome = await terminalizeCaptureRejection(
    correlation.value.handle,
    correlation.value.request,
    terminalCaptureRefusal("capture-rejection", diagnostic),
  );
  return outcome.kind === "retriable-failure" ||
      (outcome.kind === "terminal-rejection" && outcome.reason === "rejection-audit-unsynchronized")
    ? `${agentType}[${resultIndex}] ${outcome.message}`
    : null;
}

export function piResultAuthorityProblem(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  markers: PiOrchestrationMarkers,
): string | null {
  const correlation = piRequestCorrelation(runBinding, toolCallId, resultIndex, agentType);
  if (!correlation.ok) {
    const unresolved = correlation.outcome;
    if (unresolved.kind === "no-reservation") {
      return `no durable Pi correlator exists for result index ${resultIndex}`;
    }
    if (unresolved.kind === "not-an-orchestration-run") {
      return "orchestration run authority was unavailable";
    }
    return unresolved.kind === "captured"
      ? "correlation returned a capture receipt instead of request authority"
      : unresolved.message;
  }
  const { request } = correlation.value;
  if (request.requestId !== markers.requestId) {
    return `result marker ${markers.requestId} does not match correlated request ${request.requestId}`;
  }
  return request.contextDigest === markers.contextDigest
    ? null
    : `result context marker does not match correlated request ${request.requestId}`;
}

export function standaloneCompletionCheckpointProblem(checkpoint: string): string | null {
  try {
    const parsed = JSON.parse(checkpoint) as { kind?: unknown };
    return parsed.kind === "done" ? null : "review is not done";
  } catch (error) {
    return `completion checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type TrustedRunVerification =
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "accepted"; receipt: LoomReviewAuthorityReceipt }>;

function trustedCaptureProblem(handle: RunDirHandle, run: TrustedReviewRun): string | null {
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) return issued.error.message;
  if (!captured.ok) return captured.error.message;
  for (const key of captured.value) {
    const authority = issued.value.find((request) =>
      captureKey(request.slotId, request.attempt) === key);
    const trusted = run.captures.get(key);
    if (authority === undefined || trusted === undefined || authority.requestId !== trusted.requestId ||
        authority.role !== trusted.role || authority.contextDigest !== trusted.contextDigest) {
      return `captured slot ${key} was not witnessed with identical request authority`;
    }
    const bytes = handle.readTranscriptBytes(authority);
    if (!bytes.ok) return bytes.error.message;
    const digest = createHash("sha256").update(bytes.value).digest("hex");
    if (digest !== trusted.digest || bytes.value.byteLength !== trusted.byteLength) {
      return `captured slot ${key} changed after Pi witnessed it`;
    }
  }
  const absentWitness = [...run.captures.keys()].find((key) => !captured.value.has(key));
  if (absentWitness !== undefined) {
    return `witnessed slot ${absentWitness} is absent from the Run Directory`;
  }
  return run.captures.size === 0 ? "no transcript capture was witnessed" : null;
}

async function verifyTrustedReviewRun(
  input: Readonly<{ sessionId: string }>,
  run: TrustedReviewRun,
): Promise<TrustedRunVerification> {
  const reject = (message: string): TrustedRunVerification => ({
    kind: "rejected",
    message: `${run.binding.runId}: ${message}`,
  });
  const opened = openRegisteredRunDirectory(run.binding.runsRoot, run.binding.runDirectory);
  if (!opened.ok) return reject(opened.error.message);
  const programRaw = opened.value.readProgramRegistration();
  if (!programRaw.ok || programRaw.value === null) {
    return reject(programRaw.ok ? "registered program is missing" : programRaw.error.message);
  }
  const program = parseRegisteredFacadeProgram(programRaw.value);
  if (program.kind !== "registered" || program.program.kind !== "standalone-review") {
    return reject("registered program is not a valid Standalone Review");
  }
  const captureProblem = trustedCaptureProblem(opened.value, run);
  if (captureProblem !== null) return reject(captureProblem);
  const replayed = program.program.schemaVersion === 3
    ? await replayStandaloneCapturedEvidence(opened.value, program.program, run.captures)
    : replayStandaloneResultFromEvidence(opened.value, program.program, run.captures);
  if (!replayed.ok) return reject(`engine evidence replay did not prove completion: ${replayed.message}`);
  let resultBytes: Buffer;
  try {
    resultBytes = readRunBytesNoFollow(join(opened.value.runDirectory, "result.json"));
  } catch (error) {
    return reject(`cannot read canonical result artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resultBytes.equals(Buffer.from(replayed.json, "utf8"))) {
    return reject("result.json does not match checkpoint-independent evidence replay");
  }
  if (program.program.schemaVersion === 3) {
    const receipt = opened.value.readReceipt(replayed.ready.publicationIntent.effectId, 16_384);
    if (!receipt.ok || receipt.value?.kind !== "artifact-set-published") return reject("successor result publication receipt is unavailable");
    const published = reduceStandaloneReviewMachine(replayed.ready, { kind: "result-published", result: JSON.parse(replayed.json), receipt: receipt.value });
    if (!published.ok || published.value.kind !== "done") return reject("successor result publication receipt differs from native replay");
  }
  const reviewedSource = readStandaloneReviewedSource(opened.value, program.program, 16_777_216,
    replayed.ready.authority.schemaVersion === 3 ? replayed.ready.authority.successor : undefined);
  if (!reviewedSource.ok) return reject(`reviewed source attestation failed: ${reviewedSource.message}`);
  return { kind: "accepted", receipt: Object.freeze({
    schemaVersion: 1,
    kind: "loom-review-authority-receipt",
    sessionId: input.sessionId,
    runId: run.binding.runId,
    runsRoot: run.binding.runsRoot,
    runDirectory: run.binding.runDirectory,
    requestIds: Object.freeze([...new Set([...run.captures.values()].map(({ requestId }) => requestId))].sort()),
    resultDigest: replayed.digest,
    reviewedSource: reviewedSource.value,
  }) };
}

export async function verifyTrustedStandaloneReview(input: Readonly<{ cwd: string; sessionId: string }>): Promise<LoomReviewAuthorityReceipt> {
  const sessionRoots = trustedReviewRuns.get(input.sessionId);
  if (sessionRoots === undefined) throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId}`);
  const expectedRoot = resolve(input.cwd, ".claude/reviews/review-and-fix-runs");
  const root = sessionRoots.get(expectedRoot);
  if (root === undefined || root.runs.size === 0) {
    throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId} and root ${expectedRoot}`);
  }
  const current = [...root.runs.entries()].reduce((latest, candidate) =>
    candidate[1].touchedAt > latest[1].touchedAt ? candidate : latest);
  const outcome = await verifyTrustedReviewRun(input, current[1]);
  if (trustedReviewRuns.get(input.sessionId)?.get(expectedRoot) !== root) {
    throw new Error("current witnessed Standalone Review changed during verification; no older authority accepted");
  }
  if (outcome.kind === "rejected") {
    throw new Error(`current witnessed Standalone Review rejected: ${outcome.message}`);
  }
  // Exact accepted replay is idempotent. Once accepted, older witnesses for
  // this root are retired so they can never make a later verification
  // ambiguous or become fallback authority after a new run is touched.
  sessionRoots.set(expectedRoot, Object.freeze({
    nextTouch: root.nextTouch,
    runs: new Map([[current[0], current[1]]]),
  }));
  return outcome.receipt;
}
