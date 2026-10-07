/**
 * Request-bound review run authority under Pi.
 *
 * Everything that ties a Pi spawn or result to an exactly issued Run
 * Directory request: the task's request/context markers, the session's run
 * bindings, the one authentication of an issued review request against its
 * registered program and immutable publication (shared by the Spawn
 * Admission's emission port and result capture), recording native
 * correlators before dispatch, and authenticating and terminalising results
 * against their correlated request. The witnesses of captured transcripts
 * the review-authority bridge replays are a separate injected aggregate,
 * `pi/trusted-review-witness.ts`.
 */

import type { AdmittedSpawnItem, SpawnAdmissionPorts } from "../engine/src/core/spawn-admission";
import {
  issuedReviewerPayloadClaim,
  qualifyIssuedSpawnEmissionRoute,
  type IssuedSpawnEmissionAuthority,
} from "../engine/src/core/issued-emission-capability";
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
  type CorrelatedRequestResolution,
} from "../engine/src/orchestration/harness-capture-runtime";
import { openRegisteredRunDirectory, type RunDirHandle } from "../engine/src/orchestration/run-directory-handle";
import {
  parseRegisteredFacadeProgram,
  publishedReviewerRequest,
  renderSpawnTask,
} from "../engine/src/handlers/helpers/programs";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { captureKey } from "../engine/src/core/harness-capture";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import type {
  AgentRequestAuthority,
  ContextDigest,
  RequestId,
} from "../engine/src/core/orchestration-contract";
import { piSpawnRosterId, replacePiSpawnTask } from "./tool-input";

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

type PublishedPiReviewRequest = Extract<ReturnType<typeof publishedReviewerRequest>, { ok: true }>["value"];

/**
 * What one reserved request means under its Run Directory's registered
 * program. `authenticated` is a review-program or refutation request whose
 * exact immutable publication independently authenticates the same
 * authority; every other arm names the one step that refused, so each shell
 * keeps its own rendering while both read the same facts.
 */
export type PiIssuedReviewRequestAuthentication =
  | Readonly<{
      kind: "authenticated";
      classified: PiIssuedReviewRequestClass;
      published: PublishedPiReviewRequest;
    }>
  | Readonly<{ kind: "registration-unreadable"; message: string }>
  | Readonly<{ kind: "registration-invalid"; message: string }>
  /** The Run Directory claims no program (`registration` is the raw read,
   *  `null` when the file is proven absent). */
  | Readonly<{ kind: "unclaimed-program"; registration: unknown }>
  /** A registered program that is not a review program. */
  | Readonly<{ kind: "other-program" }>
  | Readonly<{ kind: "unclassified"; message: string }>
  | Readonly<{ kind: "publication-unavailable"; message: string }>;

/**
 * The one issued-review-request authentication sequence: read and parse the
 * program registration, classify the request against it, then require its
 * exact immutable publication. Spawn admission (`readPiIssuedSpawnRequest`)
 * and result capture (`pi/review-capture.ts`) both cross this seam, so they
 * cannot drift on what an issued request means. The classified claim is
 * already exact: publication authenticates the same request id and context
 * digest it was derived from, and the program supplies the schema digest.
 */
export function authenticatePiIssuedReviewRequest(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  maximumBytes?: number,
): PiIssuedReviewRequestAuthentication {
  const stored = handle.readProgramRegistration(maximumBytes);
  if (!stored.ok) return Object.freeze({ kind: "registration-unreadable" as const, message: stored.error.message });
  const registration = parseRegisteredFacadeProgram(stored.value);
  if (registration.kind === "invalid") {
    return Object.freeze({ kind: "registration-invalid" as const, message: registration.message });
  }
  if (registration.kind === "unclaimed") {
    return Object.freeze({ kind: "unclaimed-program" as const, registration: stored.value });
  }
  if (registration.program.kind !== "wave-gate" && registration.program.kind !== "standalone-review") {
    return Object.freeze({ kind: "other-program" as const });
  }
  const classified = classifyPiIssuedReviewRequest(handle.runId, registration.program, request);
  if (!classified.ok) return Object.freeze({ kind: "unclassified" as const, message: classified.error.message });
  // Reservation and registration do not issue a spawn. The exact immutable
  // publication receipt must independently authenticate this same authority.
  const published = publishedReviewerRequest(handle, request, maximumBytes);
  if (!published.ok) return Object.freeze({ kind: "publication-unavailable" as const, message: published.message });
  return Object.freeze({ kind: "authenticated" as const, classified: classified.value, published: published.value });
}

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
    const authenticated = authenticatePiIssuedReviewRequest(opened.value, matches[0]!);
    switch (authenticated.kind) {
      case "authenticated":
        return qualifyRoute(authenticated.classified, authenticated.published.authority);
      case "registration-unreadable":
      case "unclassified":
      case "publication-unavailable":
        return failure({ message: authenticated.message });
      case "registration-invalid":
      case "unclaimed-program":
      case "other-program":
        return failure({ message: `request ${requestId} has no matching registered review program` });
    }
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
