/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { canonicalRecord, failure, success, type DomainResult, type NonEmpty, type SlotId } from './identity';
import { MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH, causedMessage, describeThrownCause, includes, readDenseDataArray, readExactDataRecord, type DataBoundaryReason } from './bytes';
import { CompleteRosterMembership, completeRosterCache, exactRosterCache, immutableMap, parseStoredAgentRequestAuthority, sameHarnessBinding, type AgentRequestAuthority, type ExactRoster, type RosterViolation, type UnissuedResultCause } from './roster';
import { authorityResolutionFailure, issuedRequestCache, parseIssuedSpawnRequestAgainstRegistration, parseIssuedSpawnRequestIdentity, resolveRegisteredPublicationAuthority, samePublicationIdentity, type PublicationAuthorityResolver, type RegisteredBatchPublicationAuthority, type SpawnRequest } from './publication';

export type AcceptedAgentResult<T> = Readonly<{
  kind: "accepted-agent-result";
  authority: AgentRequestAuthority;
  issuedRequest: SpawnRequest;
  value: T;
}>;

export type AcceptedAgentResultError = Readonly<{
  kind: "invalid-accepted-agent-result";
  field?: string;
  message: string;
}>;

/** Associate a payload only with a fresh canonical runtime issuance proof. */
export function acceptedAgentResult<T>(
  request: SpawnRequest,
  value: T,
): DomainResult<AcceptedAgentResult<T>, AcceptedAgentResultError> {
  const issued = typeof request === "object" && request !== null
    ? issuedRequestCache.get(request)
    : undefined;
  if (issued === undefined || issued !== request) {
    return failure(authorityResolutionFailure(
      "accepted results require a fresh canonical issued request; rehydrate durable identity first",
    ));
  }
  return success(canonicalRecord({
    kind: "accepted-agent-result",
    authority: issued.authority,
    issuedRequest: issued,
    value,
  }));
}

export type CompleteRoster<R> = CompleteRosterMembership & Readonly<{
  ordered: NonEmpty<R>;
  bySlot: ReadonlyMap<SlotId, R>;
}>;

export function unissuedResultCause(
  kind: UnissuedResultCause["kind"],
  message: string,
  fields?: NonEmpty<string>,
): UnissuedResultCause {
  return kind === "issued-request-authority-mismatch" && fields !== undefined
    ? canonicalRecord({ kind, fields: Object.freeze([...fields]) as NonEmpty<string>, message })
    : canonicalRecord({ kind, message }) as UnissuedResultCause;
}

export type CompleteRosterError = Readonly<{
  kind: "incomplete-or-invalid-roster";
  violations: NonEmpty<RosterViolation>;
}>;

export function bindingMismatches(
  actual: AgentRequestAuthority,
  expected: AgentRequestAuthority,
): readonly string[] {
  const mismatches: string[] = [];
  if (actual.runId !== expected.runId) mismatches.push("runId");
  if (actual.requestId !== expected.requestId) mismatches.push("requestId");
  if (actual.slotId !== expected.slotId) mismatches.push("slotId");
  if (actual.program !== expected.program) mismatches.push("program");
  if (actual.role !== expected.role) mismatches.push("role");
  if (actual.attempt !== expected.attempt) mismatches.push("attempt");
  if (actual.modelProfile !== expected.modelProfile) mismatches.push("modelProfile");
  if (!sameHarnessBinding(actual.harnessBinding, expected.harnessBinding)) mismatches.push("harnessBinding");
  if (actual.requiredSkill !== expected.requiredSkill) mismatches.push("requiredSkill");
  if (actual.contextDigest !== expected.contextDigest) mismatches.push("contextDigest");
  if (actual.outputSlot.path !== expected.outputSlot.path) mismatches.push("outputSlot");
  return mismatches;
}

export type SemanticPayloadParseError = Readonly<{ message: string }>;
export type SemanticPayloadParser<T> = (
  raw: unknown,
) => DomainResult<T, SemanticPayloadParseError>;

export type SemanticPayloadFailureReason =
  | DataBoundaryReason
  | "non-finite-number"
  | "unsupported-value"
  | "cyclic-value"
  | "wrong-container-prototype"
  | "parser-threw"
  | "invalid-parser-result"
  | "parser-rejected";

export type SemanticPayloadDiagnostic = Readonly<{
  kind: "invalid-semantic-payload";
  phase: "parse" | "canonicalize";
  reason: SemanticPayloadFailureReason;
  field: string | null;
  index: number | null;
  message: string;
}>;

export function semanticPayloadFailure<T>(
  phase: SemanticPayloadDiagnostic["phase"],
  reason: SemanticPayloadFailureReason,
  message: string,
  field: string | null = null,
  index: number | null = null,
): DomainResult<T, SemanticPayloadDiagnostic> {
  return failure(canonicalRecord({
    kind: "invalid-semantic-payload",
    phase,
    reason,
    field,
    index,
    message,
  }));
}

export function canonicalizeSemanticPayload(
  raw: unknown,
  ancestors: ReadonlySet<object> = new Set<object>(),
): DomainResult<unknown, SemanticPayloadDiagnostic> {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return success(raw);
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? success(raw)
      : semanticPayloadFailure("canonicalize", "non-finite-number", "semantic payload numbers must be finite");
  }
  if (typeof raw !== "object") {
    return semanticPayloadFailure(
      "canonicalize",
      "unsupported-value",
      `semantic payload contains unsupported ${typeof raw} data`,
    );
  }
  if (ancestors.has(raw)) {
    return semanticPayloadFailure("canonicalize", "cyclic-value", "semantic payload must be acyclic");
  }

  try {
    const prototype = Object.getPrototypeOf(raw);
    const array = Array.isArray(raw);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return semanticPayloadFailure(
        "canonicalize",
        "wrong-container-prototype",
        "semantic payload must contain only plain objects and arrays",
      );
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(raw);

    if (array) {
      const snapshot = readDenseDataArray(
        raw,
        "semantic payload array",
        MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH,
      );
      if (!snapshot.ok) {
        return semanticPayloadFailure(
          "canonicalize",
          snapshot.error.reason,
          snapshot.error.message,
          snapshot.error.field,
          snapshot.error.index,
        );
      }
      const canonical: unknown[] = [];
      for (const value of snapshot.value) {
        const child = canonicalizeSemanticPayload(value, nextAncestors);
        if (!child.ok) return child;
        canonical.push(child.value);
      }
      return success(Object.freeze(canonical));
    }

    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key === "symbol")) {
      return semanticPayloadFailure(
        "canonicalize",
        "symbol-field",
        "semantic payload must not contain symbol fields",
        "[symbol]",
      );
    }
    const canonical = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return semanticPayloadFailure(
          "canonicalize",
          "accessor-field",
          `semantic payload field '${key}' must be an own data field`,
          key,
        );
      }
      if (!descriptor.enumerable) {
        return semanticPayloadFailure(
          "canonicalize",
          "non-enumerable-field",
          `semantic payload field '${key}' must be enumerable`,
          key,
        );
      }
      const child = canonicalizeSemanticPayload(descriptor.value, nextAncestors);
      if (!child.ok) return child;
      Object.defineProperty(canonical, key, {
        value: child.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return success(Object.freeze(canonical));
  } catch (cause) {
    return semanticPayloadFailure(
      "canonicalize",
      "unsafe-inspection",
      causedMessage("semantic payload could not be safely canonicalized", cause),
    );
  }
}

export function parseAndCanonicalizePayload<T>(
  raw: unknown,
  parser: SemanticPayloadParser<T>,
): DomainResult<T, SemanticPayloadDiagnostic> {
  let parsed: DomainResult<T, SemanticPayloadParseError>;
  try {
    parsed = parser(raw);
  } catch (cause) {
    return semanticPayloadFailure(
      "parse",
      "parser-threw",
      `semantic payload parser threw instead of returning a result: ${describeThrownCause(cause)}`,
    );
  }
  const envelope = readExactDataRecord(parsed, ["ok", "value", "error"], "semantic payload parser result");
  if (!envelope.ok || typeof envelope.value.ok !== "boolean") {
    return semanticPayloadFailure(
      "parse",
      "invalid-parser-result",
      envelope.ok ? "semantic payload parser result has an invalid tag" : envelope.error.message,
      envelope.ok ? "ok" : envelope.error.field,
      envelope.ok ? null : envelope.error.index,
    );
  }
  const envelopeKeys = Object.keys(envelope.value);
  if (envelope.value.ok === false) {
    if (envelopeKeys.length !== 2 || !envelopeKeys.includes("error")) {
      return semanticPayloadFailure(
        "parse",
        "invalid-parser-result",
        "failed semantic payload parser result must contain exactly ok and error",
      );
    }
    const parsedError = readExactDataRecord(envelope.value.error, ["message"], "semantic payload parse error");
    const message = parsedError.ok && typeof parsedError.value.message === "string" && parsedError.value.message.trim().length > 0
      ? parsedError.value.message
      : parsedError.ok
        ? "semantic payload parser rejected the payload"
        : parsedError.error.message;
    return semanticPayloadFailure("parse", "parser-rejected", message, parsedError.ok ? null : parsedError.error.field);
  }
  if (envelopeKeys.length !== 2 || !envelopeKeys.includes("value")) {
    return semanticPayloadFailure(
      "parse",
      "invalid-parser-result",
      "successful semantic payload parser result must contain exactly ok and value",
    );
  }
  const canonical = canonicalizeSemanticPayload(envelope.value.value);
  return canonical.ok ? success(canonical.value as T) : canonical;
}

export function parseCompleteRoster<T>(
  resolver: PublicationAuthorityResolver,
  exactRoster: ExactRoster,
  rawResults: unknown,
  parsePayload: SemanticPayloadParser<T>,
): DomainResult<CompleteRoster<AcceptedAgentResult<T>>, CompleteRosterError> {
  const violations: RosterViolation[] = [];
  if (typeof exactRoster !== "object" || exactRoster === null || !exactRosterCache.has(exactRoster)) {
    return failure(canonicalRecord({
      kind: "incomplete-or-invalid-roster",
      violations: Object.freeze([canonicalRecord({
        kind: "untrusted-exact-roster" as const,
      })]) as NonEmpty<RosterViolation>,
    }));
  }
  const results = readDenseDataArray(rawResults, "accepted Agent results");
  if (!results.ok) {
    return failure(canonicalRecord({
      kind: "incomplete-or-invalid-roster",
      violations: Object.freeze([canonicalRecord({
        kind: "malformed-result-boundary" as const,
        field: results.error.field,
        index: results.error.index,
        reason: results.error.reason,
        message: results.error.message,
      })]) as NonEmpty<RosterViolation>,
    }));
  }
  if (results.value.length !== exactRoster.orderedSlots.length) {
    violations.push(canonicalRecord({ kind: "result-count-mismatch", expected: exactRoster.orderedSlots.length, actual: results.value.length }));
  }

  const candidates = new Map<SlotId, AcceptedAgentResult<T>>();
  const registrationSnapshots = new Map<string, RegisteredBatchPublicationAuthority>();
  results.value.forEach((rawResult, index) => {
    const result = readExactDataRecord(
      rawResult,
      ["kind", "authority", "issuedRequest", "value"],
      `accepted Agent result ${index}`,
    );
    if (!result.ok || result.value.kind !== "accepted-agent-result" || !("value" in result.value)) {
      violations.push(canonicalRecord({ kind: "malformed-result", index }));
      return;
    }
    const parsedAuthority = parseStoredAgentRequestAuthority(result.value.authority);
    if (!parsedAuthority.ok) {
      violations.push(canonicalRecord({ kind: "malformed-result", index, authorityViolations: parsedAuthority.error.violations }));
      return;
    }
    const authority = parsedAuthority.value;
    const publicationIdentity = parseIssuedSpawnRequestIdentity(result.value.issuedRequest);
    if (!publicationIdentity.ok) {
      violations.push(canonicalRecord({
        kind: "unissued-result",
        index,
        requestId: authority.requestId,
        cause: unissuedResultCause("invalid-publication-identity", publicationIdentity.error.message),
      }));
      return;
    }
    const publicationKey = `${publicationIdentity.value.runId}\u0000${publicationIdentity.value.effectId}`;
    let registration = registrationSnapshots.get(publicationKey);
    if (registration === undefined) {
      const resolved = resolveRegisteredPublicationAuthority(resolver, publicationIdentity.value);
      if (!resolved.ok) {
        violations.push(canonicalRecord({
          kind: "unissued-result",
          index,
          requestId: authority.requestId,
          cause: unissuedResultCause("publication-authority-resolution-failed", resolved.error.message),
        }));
        return;
      }
      registration = resolved.value;
      registrationSnapshots.set(publicationKey, registration);
    } else if (!samePublicationIdentity(publicationIdentity.value, registration.identity)) {
      violations.push(canonicalRecord({
        kind: "unissued-result",
        index,
        requestId: authority.requestId,
        cause: unissuedResultCause(
          "publication-identity-mismatch",
          "issued request publication identity differs from the frozen registration for this run/effect lookup",
        ),
      }));
      return;
    }
    const issuedRequest = parseIssuedSpawnRequestAgainstRegistration(registration, result.value.issuedRequest);
    if (!issuedRequest.ok) {
      violations.push(canonicalRecord({
        kind: "unissued-result",
        index,
        requestId: authority.requestId,
        cause: unissuedResultCause("issued-request-invalid", issuedRequest.error.message),
      }));
      return;
    }
    const issuedAuthorityMismatches = bindingMismatches(authority, issuedRequest.value.authority);
    if (issuedAuthorityMismatches.length > 0) {
      const fields = Object.freeze(issuedAuthorityMismatches) as NonEmpty<string>;
      violations.push(canonicalRecord({
        kind: "unissued-result",
        index,
        requestId: authority.requestId,
        cause: unissuedResultCause(
          "issued-request-authority-mismatch",
          `accepted result authority differs from issued request authority in: ${fields.join(", ")}`,
          fields,
        ),
      }));
      return;
    }
    const slot = exactRoster.byId.get(authority.slotId);
    if (slot === undefined) {
      violations.push(canonicalRecord({ kind: "surplus-result", index, slotId: authority.slotId }));
      return;
    }
    if (candidates.has(authority.slotId)) {
      violations.push(canonicalRecord({ kind: "duplicate-result", slotId: authority.slotId }));
      return;
    }
    const expected = authority.attempt === 1 ? slot.attempts[0] : slot.attempts[1];
    const mismatches = bindingMismatches(authority, expected);
    for (const field of mismatches) {
      violations.push(canonicalRecord({ kind: "result-binding-mismatch", slotId: authority.slotId, field }));
    }
    if (mismatches.length === 0) {
      const payload = parseAndCanonicalizePayload(result.value.value, parsePayload);
      if (!payload.ok) {
        violations.push(canonicalRecord({
          kind: "invalid-result-payload",
          index,
          message: payload.error.message,
          diagnostic: payload.error,
        }));
        return;
      }
      candidates.set(authority.slotId, canonicalRecord({
        kind: "accepted-agent-result",
        authority: expected,
        issuedRequest: issuedRequest.value,
        value: payload.value,
      }));
    }
  });

  for (const slot of exactRoster.orderedSlots) {
    if (!candidates.has(slot.slotId)) violations.push(canonicalRecord({ kind: "missing-result", slotId: slot.slotId }));
  }
  const head = violations[0];
  if (head !== undefined) {
    return failure(canonicalRecord({
      kind: "incomplete-or-invalid-roster",
      violations: Object.freeze([head, ...violations.slice(1)]) as NonEmpty<RosterViolation>,
    }));
  }

  const ordered = exactRoster.orderedSlots.map((slot) => candidates.get(slot.slotId));
  if (ordered.some((result) => result === undefined)) {
    return failure(canonicalRecord({
      kind: "incomplete-or-invalid-roster",
      violations: Object.freeze([canonicalRecord({
        kind: "result-count-mismatch",
        expected: exactRoster.orderedSlots.length,
        actual: candidates.size,
      })]) as NonEmpty<RosterViolation>,
    }));
  }
  const proven = Object.freeze(ordered) as NonEmpty<AcceptedAgentResult<T>>;
  const completeRoster = canonicalRecord({
    ordered: proven,
    bySlot: immutableMap(proven.map((result) => [result.authority.slotId, result] as const)),
  }) as CompleteRoster<AcceptedAgentResult<T>>;
  completeRosterCache.add(completeRoster);
  return success(completeRoster);
}

