/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { canonicalRecord, failure, parseEffectId, parseOrchestrationRunId, parseRequestId, parseSlotId, success, type DomainResult, type EffectId, type NonEmpty, type OrchestrationRunId, type RequestId, type SlotId } from './identity';
import { causedMessage, includes, readExactDataRecord } from './bytes';
import { parseAgentRequestAuthorityForAttempt, parseAgentRosterSlot, type AgentRequestAuthority, type AgentRosterSlot, type AgentRosterSlotError, type ArtifactRef, type RosterViolation } from './roster';
import { type ContextReference } from './publication';

export type UserDecisionRequest = Readonly<{
  kind: "advisory-triage";
  requestId: RequestId;
  runId: OrchestrationRunId;
  context: ContextReference;
  advisories: NonEmpty<ArtifactRef>;
}>;

export type SemanticAttemptPairAuthority = Readonly<{
  schemaVersion: 1;
  kind: "semantic-attempt-pair-authority";
  attempt1: AgentRequestAuthority<1>;
  attempt2: AgentRequestAuthority<2>;
}>;

export type SemanticRetryDiagnostic = Readonly<{
  kind: "request-blocked";
  category: "missing-result" | "malformed-result" | "result-binding-mismatch";
  runId: OrchestrationRunId;
  requestId: RequestId;
  slotId: SlotId;
  attemptPair: SemanticAttemptPairAuthority;
  message: string;
  retry: Readonly<{ kind: "semantic-attempt"; eligible: true; attempt: 2 }>;
  recovery: Readonly<{ kind: "retry-request"; requestId: RequestId; slotId: SlotId; attempt: 2 }>;
}>;

export type InfrastructureRetryDiagnostic = Readonly<{
  kind: "effect-blocked";
  category: "infrastructure-failure" | "partial-publication";
  runId: OrchestrationRunId;
  effectId: EffectId;
  message: string;
  retry: Readonly<{ kind: "infrastructure"; eligible: true; consumesSemanticAttempt: false }>;
  recovery: Readonly<{ kind: "retry-effect"; effectId: EffectId }>;
}>;

export type TerminalDiagnosticFields = Readonly<{
  kind: "terminal-blocked";
  runId: OrchestrationRunId;
  message: string;
  retry: Readonly<{ kind: "not-retryable"; eligible: false }>;
  recovery: Readonly<{ kind: "inspect-run-and-stop" }>;
}>;

export type TerminalBlockedDiagnostic =
  | Readonly<TerminalDiagnosticFields & { category: "invalid-authority" | "roster-invalid" }>
  | Readonly<TerminalDiagnosticFields & {
      category:
        | "duplicate-result"
        | "stale-request"
        | "surplus-result"
        | "context-drift"
        | "model-mismatch"
        | "skill-mismatch";
      requestId: RequestId;
      slotId: SlotId;
    }>
  | Readonly<TerminalDiagnosticFields & {
      category: "missing-result" | "malformed-result" | "result-binding-mismatch";
      requestId: RequestId;
      slotId: SlotId;
      attempt: 2;
    }>;

export type BlockedDiagnostic =
  | SemanticRetryDiagnostic
  | InfrastructureRetryDiagnostic
  | TerminalBlockedDiagnostic;

export type SemanticRetryDiagnosticInput = Readonly<{
  category: SemanticRetryDiagnostic["category"];
  failedRequest: AgentRequestAuthority<1>;
  retryRequest: AgentRequestAuthority<2>;
  message: string;
}>;

export type InfrastructureRetryDiagnosticInput = Readonly<{
  category: InfrastructureRetryDiagnostic["category"];
  runId: OrchestrationRunId;
  effectId: EffectId;
  message: string;
}>;

export type DiagnosticConstructionError = Readonly<{
  kind: "invalid-blocked-diagnostic";
  field: string;
  message: string;
  rosterViolations?: NonEmpty<RosterViolation>;
}>;

export function diagnosticFailure<T>(
  field: string,
  message: string,
  rosterViolations?: NonEmpty<RosterViolation>,
): DomainResult<T, DiagnosticConstructionError> {
  return failure(canonicalRecord({
    kind: "invalid-blocked-diagnostic",
    field,
    message,
    ...(rosterViolations === undefined ? {} : { rosterViolations }),
  }));
}

export function parseDiagnosticMessage(
  raw: unknown,
  field = "message",
): DomainResult<string, DiagnosticConstructionError> {
  return typeof raw === "string" && raw.length > 0 && raw.trim() === raw
    ? success(raw)
    : diagnosticFailure(field, `${field} must be a non-empty trimmed actionable diagnostic message`);
}

export function rosterViolationSummary(violations: NonEmpty<RosterViolation>): string {
  return violations.map((entry) => {
    if (entry.kind === "malformed-attempt-authority") {
      return `${entry.kind} attempt ${entry.attempt}: ${entry.authorityViolations.map(({ field, message }) => `${field}: ${message}`).join("; ")}`;
    }
    if ("field" in entry) return `${entry.kind} (${entry.field})`;
    return entry.kind;
  }).join("; ");
}

export function parseSemanticAttemptPairAuthority(
  raw: unknown,
): DomainResult<SemanticAttemptPairAuthority, DiagnosticConstructionError> {
  const pair = readExactDataRecord(
    raw,
    ["schemaVersion", "kind", "attempt1", "attempt2"],
    "semantic attempt pair authority",
  );
  if (!pair.ok) return diagnosticFailure("attemptPair", pair.error.message);
  if (pair.value.schemaVersion !== 1) {
    return diagnosticFailure("attemptPair.schemaVersion", "semantic attempt pair authority schemaVersion must be 1");
  }
  if (pair.value.kind !== "semantic-attempt-pair-authority") {
    return diagnosticFailure("attemptPair.kind", "semantic attempt pair authority kind is invalid");
  }
  let slot: DomainResult<AgentRosterSlot, AgentRosterSlotError>;
  try {
    slot = parseAgentRosterSlot(pair.value.attempt1, pair.value.attempt2);
  } catch (cause) {
    return diagnosticFailure(
      "attemptPair",
      causedMessage("semantic attempt pair authority could not be safely parsed", cause),
    );
  }
  if (!slot.ok) {
    return diagnosticFailure(
      "attemptPair",
      `semantic attempt pair authority is invalid: ${rosterViolationSummary(slot.error.violations)}`,
      slot.error.violations,
    );
  }
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "semantic-attempt-pair-authority",
    attempt1: slot.value.attempts[0],
    attempt2: slot.value.attempts[1],
  }));
}

export function semanticRetryDiagnostic(
  input: SemanticRetryDiagnosticInput,
): DomainResult<SemanticRetryDiagnostic, DiagnosticConstructionError> {
  const parsedInput = readExactDataRecord(
    input,
    ["category", "failedRequest", "retryRequest", "message"],
    "semantic retry diagnostic",
  );
  if (!parsedInput.ok) return diagnosticFailure("diagnostic", parsedInput.error.message);
  if (!includes(["missing-result", "malformed-result", "result-binding-mismatch"] as const, parsedInput.value.category)) {
    return diagnosticFailure("category", "semantic retry category is invalid");
  }
  let slot: DomainResult<AgentRosterSlot, AgentRosterSlotError>;
  try {
    slot = parseAgentRosterSlot(parsedInput.value.failedRequest, parsedInput.value.retryRequest);
  } catch (cause) {
    return diagnosticFailure(
      "requests",
      causedMessage("semantic retry attempt authorities could not be safely parsed", cause),
    );
  }
  if (!slot.ok) {
    return diagnosticFailure(
      "requests",
      `semantic retry requires one valid immutable attempt pair: ${rosterViolationSummary(slot.error.violations)}`,
      slot.error.violations,
    );
  }
  const message = parseDiagnosticMessage(parsedInput.value.message);
  if (!message.ok) return message;
  const failedRequest = slot.value.attempts[0];
  const retryRequest = slot.value.attempts[1];
  const attemptPair = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "semantic-attempt-pair-authority" as const,
    attempt1: failedRequest,
    attempt2: retryRequest,
  });
  return success(canonicalRecord({
    kind: "request-blocked",
    category: parsedInput.value.category,
    runId: failedRequest.runId,
    requestId: failedRequest.requestId,
    slotId: slot.value.slotId,
    attemptPair,
    message: message.value,
    retry: canonicalRecord({ kind: "semantic-attempt", eligible: true, attempt: 2 }),
    recovery: canonicalRecord({
      kind: "retry-request",
      requestId: retryRequest.requestId,
      slotId: slot.value.slotId,
      attempt: 2,
    }),
  }));
}

export function infrastructureRetryDiagnostic(
  input: InfrastructureRetryDiagnosticInput,
): DomainResult<InfrastructureRetryDiagnostic, DiagnosticConstructionError> {
  const parsedInput = readExactDataRecord(
    input,
    ["category", "runId", "effectId", "message"],
    "infrastructure retry diagnostic",
  );
  if (!parsedInput.ok) return diagnosticFailure("diagnostic", parsedInput.error.message);
  if (!includes(["infrastructure-failure", "partial-publication"] as const, parsedInput.value.category)) {
    return diagnosticFailure("category", "infrastructure retry category is invalid");
  }
  const runId = parseOrchestrationRunId(parsedInput.value.runId);
  const effectId = parseEffectId(parsedInput.value.effectId);
  const message = parseDiagnosticMessage(parsedInput.value.message);
  if (!runId.ok) return diagnosticFailure("runId", runId.error.message);
  if (!effectId.ok) return diagnosticFailure("effectId", effectId.error.message);
  if (!message.ok) return message;
  return success(canonicalRecord({
    kind: "effect-blocked",
    category: parsedInput.value.category,
    runId: runId.value,
    effectId: effectId.value,
    message: message.value,
    retry: canonicalRecord({ kind: "infrastructure", eligible: true, consumesSemanticAttempt: false }),
    recovery: canonicalRecord({ kind: "retry-effect", effectId: effectId.value }),
  }));
}

export type TerminalBlockedDiagnosticInput =
  | Readonly<{ category: "invalid-authority" | "roster-invalid"; runId: OrchestrationRunId; message: string }>
  | Readonly<{
      category:
        | "duplicate-result"
        | "stale-request"
        | "surplus-result"
        | "context-drift"
        | "model-mismatch"
        | "skill-mismatch";
      runId: OrchestrationRunId;
      requestId: RequestId;
      slotId: SlotId;
      message: string;
    }>
  | Readonly<{
      category: "missing-result" | "malformed-result" | "result-binding-mismatch";
      failedRequest: AgentRequestAuthority<2>;
      message: string;
    }>;

export const RUN_TERMINAL_CATEGORIES = Object.freeze(["invalid-authority", "roster-invalid"] as const);
export const REQUEST_TERMINAL_CATEGORIES = Object.freeze([
  "duplicate-result",
  "stale-request",
  "surplus-result",
  "context-drift",
  "model-mismatch",
  "skill-mismatch",
] as const);
export const EXHAUSTED_RESULT_CATEGORIES = Object.freeze([
  "missing-result",
  "malformed-result",
  "result-binding-mismatch",
] as const);

export function terminalBlockedDiagnostic(
  input: TerminalBlockedDiagnosticInput,
): DomainResult<TerminalBlockedDiagnostic, DiagnosticConstructionError> {
  const categoryRecord = readExactDataRecord(
    input,
    ["category", "runId", "requestId", "slotId", "failedRequest", "message"],
    "terminal blocked diagnostic",
  );
  if (!categoryRecord.ok) return diagnosticFailure("diagnostic", categoryRecord.error.message);
  const category = categoryRecord.value.category;
  const runScoped = includes(RUN_TERMINAL_CATEGORIES, category);
  const requestScoped = includes(REQUEST_TERMINAL_CATEGORIES, category);
  const exhaustedResult = includes(EXHAUSTED_RESULT_CATEGORIES, category);
  if (!runScoped && !requestScoped && !exhaustedResult) {
    return diagnosticFailure("category", "terminal blocked category is invalid");
  }

  const allowed = runScoped
    ? ["category", "runId", "message"]
    : requestScoped
      ? ["category", "runId", "requestId", "slotId", "message"]
      : ["category", "failedRequest", "message"];
  const exactInput = readExactDataRecord(input, allowed, "terminal blocked diagnostic");
  if (!exactInput.ok) return diagnosticFailure("diagnostic", exactInput.error.message);
  const message = parseDiagnosticMessage(exactInput.value.message);
  if (!message.ok) return message;
  const retry = canonicalRecord({ kind: "not-retryable" as const, eligible: false as const });
  const recovery = canonicalRecord({ kind: "inspect-run-and-stop" as const });

  if (exhaustedResult) {
    const failedRequest = parseAgentRequestAuthorityForAttempt(exactInput.value.failedRequest, 2);
    if (!failedRequest.ok) {
      return diagnosticFailure(
        "failedRequest",
        failedRequest.error.violations.map(({ field, message: reason }) => `${field}: ${reason}`).join("; "),
      );
    }
    return success(canonicalRecord({
      kind: "terminal-blocked",
      category,
      runId: failedRequest.value.runId,
      requestId: failedRequest.value.requestId,
      slotId: failedRequest.value.slotId,
      attempt: 2,
      message: message.value,
      retry,
      recovery,
    }));
  }

  const runId = parseOrchestrationRunId(exactInput.value.runId);
  if (!runId.ok) return diagnosticFailure("runId", runId.error.message);
  if (runScoped) {
    return success(canonicalRecord({
      kind: "terminal-blocked",
      category,
      runId: runId.value,
      message: message.value,
      retry,
      recovery,
    }));
  }
  const requestId = parseRequestId(exactInput.value.requestId);
  const slotId = parseSlotId(exactInput.value.slotId);
  if (!requestId.ok) return diagnosticFailure("requestId", requestId.error.message);
  if (!slotId.ok) return diagnosticFailure("slotId", slotId.error.message);
  return success(canonicalRecord({
    kind: "terminal-blocked",
    category,
    runId: runId.value,
    requestId: requestId.value,
    slotId: slotId.value,
    message: message.value,
    retry,
    recovery,
  }));
}

