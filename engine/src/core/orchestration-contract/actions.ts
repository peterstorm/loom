/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { canonicalRecord, parseEffectId, parseOrchestrationRunId, parseRequestId, parseSlotId, success, type DomainResult, type NonEmpty, type OrchestrationRunId, type RequestId, type SlotId } from './identity';
import { includes, readDenseDataArray, readExactDataRecord } from './bytes';
import { actionFailure, type ExternalActionError } from './errors';
import { parseArtifactRef, type ArtifactRef } from './roster';
import { batchPublicationIdentity, clearInitialPublicationIssuance, initialPublicationClaimKey, issuancePublicationIdentity, readInitialPublicationIssuance, issuedSpawnRequest, parseContextReference, parseIssuedSpawnRequestAgainstRegistration, parseIssuedSpawnRequestProof, parsePublishedSpawnRequest, registeredBatchPublicationAuthority, resolveRegisteredPublicationAuthority, samePublicationIdentity, samePublishedRequest, type BatchPublicationIdentity, type BatchPublishedReceipt, type InitialPublicationClaimKey, type InitialPublicationIssuanceAuthority, type PublicationAuthorityResolver, type SpawnRequest } from './publication';
import { EXHAUSTED_RESULT_CATEGORIES, REQUEST_TERMINAL_CATEGORIES, RUN_TERMINAL_CATEGORIES, diagnosticFailure, parseDiagnosticMessage, parseSemanticAttemptPairAuthority, terminalBlockedDiagnostic, type BlockedDiagnostic, type DiagnosticConstructionError, type UserDecisionRequest } from './diagnostics';

export type SpawnBatchAction = Readonly<{
  kind: "spawn-batch";
  runId: OrchestrationRunId;
  publicationIdentity: BatchPublicationIdentity;
  idempotencyKey: InitialPublicationClaimKey;
  receipt: BatchPublishedReceipt;
  requests: NonEmpty<SpawnRequest>;
}>;
export type AwaitUserAction = Readonly<{ kind: "await-user"; runId: OrchestrationRunId; request: UserDecisionRequest }>;
export type BlockedAction = Readonly<{ kind: "blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>;
export type DoneAction = Readonly<{ kind: "done"; runId: OrchestrationRunId; outcome: ArtifactRef }>;
export type ExternalAction = SpawnBatchAction | AwaitUserAction | BlockedAction | DoneAction;

export function inspectInitialPublicationIssuanceAuthority(
  raw: unknown,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  if (typeof raw !== "object" || raw === null) {
    return actionFailure("initial issuance requires a fresh initial publication capability", "publicationAuthority");
  }
  const state = readInitialPublicationIssuance(raw);
  if (state === undefined) {
    return actionFailure(
      "initial publication capability is forged, incompatible with restart authority, or already consumed",
      "publicationAuthority",
    );
  }
  const authority = raw as InitialPublicationIssuanceAuthority;
  return samePublicationIdentity(authority.identity, batchPublicationIdentity(state.receipt))
    ? success(state.receipt)
    : actionFailure("initial publication capability is internally inconsistent", "publicationAuthority.identity");
}

export function consumeInitialPublicationIssuanceAuthority(
  raw: InitialPublicationIssuanceAuthority,
  expectedReceipt: BatchPublishedReceipt,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  const current = inspectInitialPublicationIssuanceAuthority(raw);
  if (!current.ok) return current;
  if (current.value !== expectedReceipt) {
    return actionFailure("initial publication capability changed during request construction", "publicationAuthority");
  }
  clearInitialPublicationIssuance(raw);
  return success(current.value);
}

export function issueInitialSpawnRequestsFromReceipt(
  receipt: BatchPublishedReceipt,
  rawRequests: unknown,
): DomainResult<NonEmpty<SpawnRequest>, ExternalActionError> {
  const entries = readDenseDataArray(rawRequests, "initial spawn batch requests");
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? "spawn batch must be a non-empty array" : entries.error.message, "requests");
  }
  const expectedRequests = receipt.issuedRequests;
  if (entries.value.length !== expectedRequests.length) {
    return actionFailure("initial publication request count does not match initial spawn requests", "requests");
  }
  const publicationSnapshot = registeredBatchPublicationAuthority(receipt);
  const requests: SpawnRequest[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const envelope = readExactDataRecord(entries.value[index], ["authority", "context"], `initial spawn request ${index}`);
    if (!envelope.ok) {
      return actionFailure(
        envelope.error.message,
        `requests[${index}]${envelope.error.field === null ? "" : `.${envelope.error.field}`}`,
      );
    }
    const published = parsePublishedSpawnRequest(envelope.value, `requests[${index}]`);
    if (!published.ok) return published;
    const expected = expectedRequests[index]!;
    if (!samePublishedRequest(published.value, expected)) {
      return actionFailure(
        "initial spawn request does not match published run/request/context/order/output/model/Skill authority",
        `requests[${index}]`,
      );
    }
    requests.push(issuedSpawnRequest(expected, publicationSnapshot, index));
  }
  return success(Object.freeze(requests) as NonEmpty<SpawnRequest>);
}

/** Initial publication-time issuance accepts only bare request/context envelopes. */
export function issueInitialSpawnRequests(
  publicationAuthority: InitialPublicationIssuanceAuthority,
  rawRequests: unknown,
): DomainResult<NonEmpty<SpawnRequest>, ExternalActionError> {
  const receipt = inspectInitialPublicationIssuanceAuthority(publicationAuthority);
  if (!receipt.ok) return receipt;
  const requests = issueInitialSpawnRequestsFromReceipt(receipt.value, rawRequests);
  if (!requests.ok) return requests;
  const consumed = consumeInitialPublicationIssuanceAuthority(publicationAuthority, receipt.value);
  return consumed.ok ? requests : consumed;
}

/**
 * Restart-only rehydration. Every request must carry durable issuance identity;
 * bare request/context envelopes are rejected rather than silently upgraded.
 */
export function rehydrateIssuedSpawnRequests(
  resolver: PublicationAuthorityResolver,
  rawRequests: unknown,
): DomainResult<NonEmpty<SpawnRequest>, ExternalActionError> {
  const entries = readDenseDataArray(rawRequests, "durable issued spawn requests");
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? "durable issued requests must be a non-empty array" : entries.error.message, "requests");
  }

  const firstEnvelope = readExactDataRecord(entries.value[0], ["authority", "context", "issuance"], "durable issued spawn request 0");
  if (!firstEnvelope.ok || !Object.hasOwn(firstEnvelope.value, "issuance")) {
    return actionFailure(
      firstEnvelope.ok ? "every rehydrated request requires durable issuance identity" : firstEnvelope.error.message,
      "requests[0].issuance",
    );
  }
  const firstIssuance = parseIssuedSpawnRequestProof(firstEnvelope.value.issuance);
  if (!firstIssuance.ok) return actionFailure(firstIssuance.error.message, "requests[0].issuance");
  const identity = issuancePublicationIdentity(firstIssuance.value);
  const registered = resolveRegisteredPublicationAuthority(resolver, identity);
  if (!registered.ok) return actionFailure(registered.error.message, "publicationAuthority");
  if (entries.value.length !== registered.value.receipt.issuedRequests.length) {
    return actionFailure("registered publication request count does not match durable requests", "requests");
  }

  // Freeze one resolved registration snapshot for the entire rehydration. A
  // stateful loader cannot swap registrations between requests in the batch.
  const registrationSnapshot = registered.value;
  const requests: SpawnRequest[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const issued = parseIssuedSpawnRequestAgainstRegistration(registrationSnapshot, entries.value[index]);
    if (!issued.ok) return actionFailure(issued.error.message, `requests[${index}].issuance`);
    if (issued.value.issuance.batchIndex !== index) {
      return actionFailure("durable requests must preserve registered publication order", `requests[${index}].issuance.batchIndex`);
    }
    requests.push(issued.value);
  }
  return success(Object.freeze(requests) as NonEmpty<SpawnRequest>);
}

export function spawnBatchAction(
  publicationAuthority: InitialPublicationIssuanceAuthority,
  rawRequests: unknown,
): DomainResult<SpawnBatchAction, ExternalActionError> {
  const receipt = inspectInitialPublicationIssuanceAuthority(publicationAuthority);
  if (!receipt.ok) return receipt;
  const requests = issueInitialSpawnRequestsFromReceipt(receipt.value, rawRequests);
  if (!requests.ok) return requests;
  const publicationIdentity = batchPublicationIdentity(receipt.value);
  const action = canonicalRecord({
    kind: "spawn-batch" as const,
    runId: receipt.value.runId,
    publicationIdentity,
    idempotencyKey: initialPublicationClaimKey(publicationIdentity),
    receipt: receipt.value,
    requests: requests.value,
  });
  const consumed = consumeInitialPublicationIssuanceAuthority(publicationAuthority, receipt.value);
  return consumed.ok ? success(action) : consumed;
}

export function awaitUserAction(rawRequest: unknown): DomainResult<AwaitUserAction, ExternalActionError> {
  const raw = readExactDataRecord(rawRequest, ["kind", "requestId", "runId", "context", "advisories"], "user decision request");
  if (!raw.ok) return actionFailure(raw.error.message, `request${raw.error.field === null ? "" : `.${raw.error.field}`}`);
  if (raw.value.kind !== "advisory-triage") return actionFailure("request.kind must be 'advisory-triage'", "request.kind");
  const requestId = parseRequestId(raw.value.requestId);
  const runId = parseOrchestrationRunId(raw.value.runId);
  const context = parseContextReference(raw.value.context);
  if (!requestId.ok) return actionFailure(requestId.error.message, "request.requestId");
  if (!runId.ok) return actionFailure(runId.error.message, "request.runId");
  if (!context.ok) return actionFailure(context.error.message, `request.${context.error.field}`);
  const rawAdvisories = readDenseDataArray(raw.value.advisories, "advisories");
  if (!rawAdvisories.ok || rawAdvisories.value.length === 0) {
    return actionFailure(rawAdvisories.ok ? "advisories must be a non-empty array" : rawAdvisories.error.message, "request.advisories");
  }
  const advisories: ArtifactRef[] = [];
  const advisorySlots = new Set<string>();
  for (let index = 0; index < rawAdvisories.value.length; index++) {
    const parsed = parseArtifactRef(rawAdvisories.value[index]);
    if (!parsed.ok) return actionFailure(parsed.error.message, `request.advisories[${index}].${parsed.error.field}`);
    if (parsed.value.runId !== runId.value) return actionFailure("advisory belongs to a different run", `request.advisories[${index}].runId`);
    if (advisorySlots.has(parsed.value.slot.path)) {
      return actionFailure("advisory artifact slots must be unique within the run-scoped decision", `request.advisories[${index}].slot`);
    }
    advisorySlots.add(parsed.value.slot.path);
    advisories.push(parsed.value);
  }
  const request: UserDecisionRequest = canonicalRecord({
    kind: "advisory-triage",
    requestId: requestId.value,
    runId: runId.value,
    context: context.value,
    advisories: Object.freeze(advisories) as NonEmpty<ArtifactRef>,
  });
  return success(canonicalRecord({ kind: "await-user", runId: runId.value, request }));
}

/**
 * A GATE, not a parser: it proves a diagnostic sub-record carries exactly the
 * constant fields its diagnostic kind fixes, and nothing more.
 *
 * The success type is `void` because that is the truth. It used to return the
 * validated record, which promised callers a structure every one of them
 * discards — all four read only `.ok` and return the failure. A return type
 * that over-promises invites a caller to start reading fields the constants
 * already determine.
 */
export function exactDiagnosticConstants(
  raw: unknown,
  expected: Readonly<Record<string, unknown>>,
  field: string,
): DomainResult<void, DiagnosticConstructionError> {
  const parsed = readExactDataRecord(raw, Object.keys(expected), field);
  if (!parsed.ok) return diagnosticFailure(field, parsed.error.message);
  for (const [key, value] of Object.entries(expected)) {
    if (parsed.value[key] !== value) return diagnosticFailure(`${field}.${key}`, `${field}.${key} is invalid`);
  }
  return success(undefined);
}

function terminalBlockedFieldNames(
  runScoped: boolean,
  exhaustedResult: boolean,
): readonly string[] {
  if (runScoped) return ["kind", "category", "runId", "message", "retry", "recovery"];
  if (exhaustedResult) {
    return ["kind", "category", "runId", "requestId", "slotId", "attempt", "message", "retry", "recovery"];
  }
  return ["kind", "category", "runId", "requestId", "slotId", "message", "retry", "recovery"];
}

export function parseBlockedDiagnostic(
  raw: unknown,
): DomainResult<BlockedDiagnostic, DiagnosticConstructionError> {
  const base = readExactDataRecord(
    raw,
    ["kind", "category", "runId", "requestId", "slotId", "effectId", "attempt", "attemptPair", "message", "retry", "recovery"],
    "blocked diagnostic",
  );
  if (!base.ok) return diagnosticFailure("diagnostic", base.error.message);

  if (base.value.kind === "request-blocked") {
    const exact = readExactDataRecord(
      raw,
      ["kind", "category", "runId", "requestId", "slotId", "attemptPair", "message", "retry", "recovery"],
      "semantic retry diagnostic",
    );
    if (!exact.ok) return diagnosticFailure("diagnostic", exact.error.message);
    if (!includes(["missing-result", "malformed-result", "result-binding-mismatch"] as const, exact.value.category)) {
      return diagnosticFailure("category", "semantic retry category is invalid");
    }
    const attemptPair = parseSemanticAttemptPairAuthority(exact.value.attemptPair);
    if (!attemptPair.ok) return attemptPair;
    const failedRequest = attemptPair.value.attempt1;
    const retryRequest = attemptPair.value.attempt2;
    const runId = parseOrchestrationRunId(exact.value.runId);
    const requestId = parseRequestId(exact.value.requestId);
    const slotId = parseSlotId(exact.value.slotId);
    const message = parseDiagnosticMessage(exact.value.message);
    const retry = exactDiagnosticConstants(exact.value.retry, {
      kind: "semantic-attempt",
      eligible: true,
      attempt: 2,
    }, "retry");
    const recovery = readExactDataRecord(
      exact.value.recovery,
      ["kind", "requestId", "slotId", "attempt"],
      "recovery",
    );
    if (!runId.ok) return diagnosticFailure("runId", runId.error.message);
    if (!requestId.ok) return diagnosticFailure("requestId", requestId.error.message);
    if (!slotId.ok) return diagnosticFailure("slotId", slotId.error.message);
    if (runId.value !== failedRequest.runId) {
      return diagnosticFailure("runId", "blocked run must be derived from the canonical attempt pair authority");
    }
    if (requestId.value !== failedRequest.requestId) {
      return diagnosticFailure("requestId", "blocked request must be the canonical attempt-1 request");
    }
    if (slotId.value !== failedRequest.slotId) {
      return diagnosticFailure("slotId", "blocked slot must be derived from the canonical attempt pair authority");
    }
    if (!message.ok) return message;
    if (!retry.ok) return retry;
    if (!recovery.ok) {
      return diagnosticFailure(`recovery${recovery.error.field === null ? "" : `.${recovery.error.field}`}`, recovery.error.message);
    }
    if (recovery.value.kind !== "retry-request" || recovery.value.attempt !== 2) {
      return diagnosticFailure("recovery", "semantic recovery must be an attempt-2 retry request");
    }
    const recoveryRequestId = parseRequestId(recovery.value.requestId);
    const recoverySlotId = parseSlotId(recovery.value.slotId);
    if (!recoveryRequestId.ok) return diagnosticFailure("recovery.requestId", recoveryRequestId.error.message);
    if (!recoverySlotId.ok) return diagnosticFailure("recovery.slotId", recoverySlotId.error.message);
    if (recoveryRequestId.value !== retryRequest.requestId) {
      return diagnosticFailure(
        "recovery.requestId",
        "recovery request must be the exact canonical engine-issued attempt-2 request",
      );
    }
    if (recoverySlotId.value !== retryRequest.slotId) {
      return diagnosticFailure("recovery.slotId", "recovery slot must match the canonical attempt-2 authority");
    }
    return success(canonicalRecord({
      kind: "request-blocked",
      category: exact.value.category,
      runId: failedRequest.runId,
      requestId: failedRequest.requestId,
      slotId: failedRequest.slotId,
      attemptPair: attemptPair.value,
      message: message.value,
      retry: canonicalRecord({ kind: "semantic-attempt", eligible: true, attempt: 2 }),
      recovery: canonicalRecord({
        kind: "retry-request",
        requestId: retryRequest.requestId,
        slotId: retryRequest.slotId,
        attempt: 2,
      }),
    }));
  }

  if (base.value.kind === "effect-blocked") {
    const exact = readExactDataRecord(
      raw,
      ["kind", "category", "runId", "effectId", "message", "retry", "recovery"],
      "infrastructure retry diagnostic",
    );
    if (!exact.ok) return diagnosticFailure("diagnostic", exact.error.message);
    if (!includes(["infrastructure-failure", "partial-publication"] as const, exact.value.category)) {
      return diagnosticFailure("category", "infrastructure retry category is invalid");
    }
    const runId = parseOrchestrationRunId(exact.value.runId);
    const effectId = parseEffectId(exact.value.effectId);
    const message = parseDiagnosticMessage(exact.value.message);
    const retry = exactDiagnosticConstants(exact.value.retry, {
      kind: "infrastructure",
      eligible: true,
      consumesSemanticAttempt: false,
    }, "retry");
    const recovery = readExactDataRecord(exact.value.recovery, ["kind", "effectId"], "recovery");
    if (!runId.ok) return diagnosticFailure("runId", runId.error.message);
    if (!effectId.ok) return diagnosticFailure("effectId", effectId.error.message);
    if (!message.ok) return message;
    if (!retry.ok) return retry;
    if (!recovery.ok) {
      return diagnosticFailure(`recovery${recovery.error.field === null ? "" : `.${recovery.error.field}`}`, recovery.error.message);
    }
    if (recovery.value.kind !== "retry-effect") return diagnosticFailure("recovery.kind", "recovery.kind must be retry-effect");
    const recoveryEffectId = parseEffectId(recovery.value.effectId);
    if (!recoveryEffectId.ok) return diagnosticFailure("recovery.effectId", recoveryEffectId.error.message);
    if (recoveryEffectId.value !== effectId.value) return diagnosticFailure("recovery.effectId", "recovery effect must match blocked effect");
    return success(canonicalRecord({
      kind: "effect-blocked",
      category: exact.value.category,
      runId: runId.value,
      effectId: effectId.value,
      message: message.value,
      retry: canonicalRecord({ kind: "infrastructure", eligible: true, consumesSemanticAttempt: false }),
      recovery: canonicalRecord({ kind: "retry-effect", effectId: effectId.value }),
    }));
  }

  if (base.value.kind === "terminal-blocked") {
    const category = base.value.category;
    const runScoped = includes(RUN_TERMINAL_CATEGORIES, category);
    const requestScoped = includes(REQUEST_TERMINAL_CATEGORIES, category);
    const exhaustedResult = includes(EXHAUSTED_RESULT_CATEGORIES, category);
    if (!runScoped && !requestScoped && !exhaustedResult) {
      return diagnosticFailure("category", "terminal blocked category is invalid");
    }
    const exact = readExactDataRecord(
      raw,
      terminalBlockedFieldNames(runScoped, exhaustedResult),
      "terminal blocked diagnostic",
    );
    if (!exact.ok) return diagnosticFailure("diagnostic", exact.error.message);
    const retry = exactDiagnosticConstants(exact.value.retry, { kind: "not-retryable", eligible: false }, "retry");
    const recovery = exactDiagnosticConstants(exact.value.recovery, { kind: "inspect-run-and-stop" }, "recovery");
    if (!retry.ok) return retry;
    if (!recovery.ok) return recovery;
    if (exhaustedResult) {
      const runId = parseOrchestrationRunId(exact.value.runId);
      const requestId = parseRequestId(exact.value.requestId);
      const slotId = parseSlotId(exact.value.slotId);
      const message = parseDiagnosticMessage(exact.value.message);
      if (!runId.ok) return diagnosticFailure("runId", runId.error.message);
      if (!requestId.ok) return diagnosticFailure("requestId", requestId.error.message);
      if (!slotId.ok) return diagnosticFailure("slotId", slotId.error.message);
      if (exact.value.attempt !== 2) return diagnosticFailure("attempt", "terminal semantic result diagnostic must exhaust attempt 2");
      if (!message.ok) return message;
      return success(canonicalRecord({
        kind: "terminal-blocked",
        category,
        runId: runId.value,
        requestId: requestId.value,
        slotId: slotId.value,
        attempt: 2,
        message: message.value,
        retry: canonicalRecord({ kind: "not-retryable", eligible: false }),
        recovery: canonicalRecord({ kind: "inspect-run-and-stop" }),
      }));
    }
    return terminalBlockedDiagnostic(runScoped
      ? { category, runId: exact.value.runId as OrchestrationRunId, message: exact.value.message as string }
      : {
          category: category as (typeof REQUEST_TERMINAL_CATEGORIES)[number],
          runId: exact.value.runId as OrchestrationRunId,
          requestId: exact.value.requestId as RequestId,
          slotId: exact.value.slotId as SlotId,
          message: exact.value.message as string,
        });
  }

  return diagnosticFailure("kind", "blocked diagnostic kind is invalid");
}

export function blockedAction(rawDiagnostic: unknown): DomainResult<BlockedAction, ExternalActionError> {
  const diagnostic = parseBlockedDiagnostic(rawDiagnostic);
  return diagnostic.ok
    ? success(canonicalRecord({ kind: "blocked", runId: diagnostic.value.runId, diagnostic: diagnostic.value }))
    : actionFailure(diagnostic.error.message, `diagnostic.${diagnostic.error.field}`);
}

export function doneAction(rawRunId: unknown, rawOutcome: unknown): DomainResult<DoneAction, ExternalActionError> {
  const runId = parseOrchestrationRunId(rawRunId);
  if (!runId.ok) return actionFailure(runId.error.message, "runId");
  const outcome = parseArtifactRef(rawOutcome);
  if (!outcome.ok) return actionFailure(outcome.error.message, `outcome.${outcome.error.field}`);
  return outcome.value.runId === runId.value
    ? success(canonicalRecord({ kind: "done", runId: runId.value, outcome: outcome.value }))
    : actionFailure("done outcome must belong to the completed run", "outcome.runId");
}

