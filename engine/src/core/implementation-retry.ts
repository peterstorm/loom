/**
 * Pure bounded implementation retry admission and prompt/context authority.
 *
 * Settlement history is the only semantic-attempt budget. Infrastructure
 * receipts never advance it; an exact attempt-1 retry receipt authorizes one
 * attempt 2; an attempt-2 escalation receipt is terminal.
 */

import { readDenseDataArray, readExactDataRecord } from "./orchestration-contract/bytes";
import { parseArtifactDigest, type ArtifactDigest } from "./orchestration-contract";
import {
  MAX_IMPLEMENTATION_FAILURE_KINDS,
  parseImplementationAttemptHistory,
  parseImplementationAuthorityDigest,
  parseImplementationSettlementReceiptId,
  parseSemanticAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
  type ImplementationAuthorityDigest,
  type ImplementationSettlementReceiptId,
  type RetryRequiredSettlementReceipt,
  type SemanticAttempt,
} from "./implementation-completion";
import { compareStrings } from "./ordering";
import { canonicalJson, sha256Hex, type JsonValue } from "./review-packet";
import { parseTaskId, type TaskId } from "./task-id";
import {
  parseTaskProof,
  type TaskProof,
} from "./proof-obligations";
import { taskVerificationPolicy } from "./verification-policy";

const MAX_FAILURE_KIND_LENGTH = 4_096;
export const IMPLEMENTATION_RETRY_CONTEXT_LABEL = "LOOM_IMPLEMENTATION_RETRY_CONTEXT";
export const IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL = "LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

export type ImplementationRetryContext = Readonly<{
  schemaVersion: 1;
  kind: "implementation-retry-context";
  taskId: TaskId;
  semanticAttempt: 2;
  predecessorReceiptId: ImplementationSettlementReceiptId;
  failureKinds: readonly [string, ...string[]];
}>;

export type ImplementationAttemptContext = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attempt-context";
  taskId: TaskId;
  semanticAttempt: SemanticAttempt;
  authorityDigest: ImplementationAuthorityDigest;
  promptDigest: ArtifactDigest;
  predecessorReceiptId: ImplementationSettlementReceiptId | null;
  retryContext: ImplementationRetryContext | null;
  contextDigest: ArtifactDigest;
}>;

export type RetryableImplementationTask = Readonly<{
  id: string;
  implementation_attempt_history?: readonly ImplementationAttemptSettlementReceipt[];
  implementation_retry_protocol?: 2;
  implementation_retry_history_start?: number;
  implementation_retry_predecessor_receipt_id?: ImplementationSettlementReceiptId;
  /** Attestation-mode fields; present only on a Task the attest program authored. */
  implementation_attestation?: true;
  proof?: TaskProof;
  verification_policy?: unknown;
  new_tests_required?: unknown;
}>;

export type ImplementationRetryDisposition =
  | Readonly<{ kind: "initial"; semanticAttempt: 1 }>
  | Readonly<{
      kind: "retry";
      semanticAttempt: 2;
      predecessor: RetryRequiredSettlementReceipt;
      context: ImplementationRetryContext;
      promptAppendix: string;
    }>
  | Readonly<{
      kind: "escalated";
      receiptId: ImplementationSettlementReceiptId;
      failureKinds: readonly [string, ...string[]];
    }>
  | Readonly<{ kind: "invalid"; errors: readonly [string, ...string[]] }>;

export type ImplementationSpawnAdmission =
  | Readonly<{
      ok: true;
      kind: "initial";
      taskId: TaskId;
      semanticAttempt: SemanticAttempt & 1;
      promptDigest: ArtifactDigest;
      historyStart: number;
      lineagePredecessorReceiptId: ImplementationSettlementReceiptId | null;
      retryContext: null;
      predecessorReceiptId: null;
    }>
  | Readonly<{
      ok: true;
      kind: "retry";
      taskId: TaskId;
      semanticAttempt: SemanticAttempt & 2;
      promptDigest: ArtifactDigest;
      historyStart: number;
      lineagePredecessorReceiptId: ImplementationSettlementReceiptId | null;
      retryContext: ImplementationRetryContext;
      predecessorReceiptId: ImplementationSettlementReceiptId;
    }>
  | Readonly<{ ok: false; error: string }>;

type AdmittedImplementationSpawn = Extract<ImplementationSpawnAdmission, { readonly ok: true }>;

export type AttemptContextParseResult =
  | Readonly<{ ok: true; value: ImplementationAttemptContext }>
  | Readonly<{ ok: false; errors: readonly [string, ...string[]] }>;

function nonEmptyErrors(errors: readonly string[]): readonly [string, ...string[]] {
  const [head, ...tail] = errors;
  return Object.freeze([head ?? "implementation retry input is invalid", ...tail]);
}

function sha256(text: string): ArtifactDigest {
  const digest = parseArtifactDigest(sha256Hex(text));
  if (!digest.ok) throw new Error("internal implementation context digest is invalid");
  return digest.value;
}

function failureKinds(raw: unknown, path: string):
  | Readonly<{ ok: true; value: readonly [string, ...string[]] }>
  | Readonly<{ ok: false; errors: readonly string[] }> {
  const array = readDenseDataArray(raw, path, MAX_IMPLEMENTATION_FAILURE_KINDS);
  if (!array.ok) return { ok: false, errors: [array.error.message] };
  const errors: string[] = [];
  const values: string[] = [];
  for (const [index, value] of array.value.entries()) {
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_FAILURE_KIND_LENGTH) {
      errors.push(`${path}[${index}] must be non-empty and at most ${MAX_FAILURE_KIND_LENGTH} characters`);
    } else {
      values.push(value);
    }
  }
  if (values.length === 0) errors.push(`${path} must be non-empty`);
  const sorted = [...values].sort(compareStrings);
  if (new Set(values).size !== values.length || values.some((value, index) => value !== sorted[index])) {
    errors.push(`${path} must be sorted and unique`);
  }
  const [head, ...tail] = values;
  return errors.length > 0 || head === undefined
    ? { ok: false, errors }
    : { ok: true, value: Object.freeze([head, ...tail]) };
}

export function parseImplementationRetryContext(raw: unknown, path = "implementationRetryContext"):
  | Readonly<{ ok: true; value: ImplementationRetryContext }>
  | Readonly<{ ok: false; errors: readonly [string, ...string[]] }> {
  const record = readExactDataRecord(raw, [
    "schemaVersion",
    "kind",
    "taskId",
    "semanticAttempt",
    "predecessorReceiptId",
    "failureKinds",
  ], path);
  if (!record.ok) return { ok: false, errors: nonEmptyErrors([record.error.message]) };
  const taskId = parseTaskId(record.value.taskId, `${path}.taskId`);
  const predecessor = parseImplementationSettlementReceiptId(
    record.value.predecessorReceiptId,
    `${path}.predecessorReceiptId`,
  );
  const failures = failureKinds(record.value.failureKinds, `${path}.failureKinds`);
  const errors = [
    ...(record.value.schemaVersion === 1 ? [] : [`${path}.schemaVersion must equal 1`]),
    ...(record.value.kind === "implementation-retry-context" ? [] : [`${path}.kind must equal implementation-retry-context`]),
    ...(record.value.semanticAttempt === 2 ? [] : [`${path}.semanticAttempt must equal 2`]),
    ...(taskId.ok ? [] : taskId.error.errors),
    ...(predecessor.ok ? [] : predecessor.error.errors),
    ...(failures.ok ? [] : failures.errors),
  ];
  if (errors.length > 0 || !taskId.ok || !predecessor.ok || !failures.ok) {
    return { ok: false, errors: nonEmptyErrors(errors) };
  }
  return {
    ok: true,
    value: freeze({
      schemaVersion: 1,
      kind: "implementation-retry-context",
      taskId: taskId.value,
      semanticAttempt: 2,
      predecessorReceiptId: predecessor.value,
      failureKinds: failures.value,
    }),
  };
}

function retryContextFor(receipt: RetryRequiredSettlementReceipt): ImplementationRetryContext {
  return freeze({
    schemaVersion: 1,
    kind: "implementation-retry-context",
    taskId: receipt.taskId,
    semanticAttempt: 2,
    predecessorReceiptId: receipt.receiptId,
    failureKinds: receipt.failureKinds,
  });
}

export function renderImplementationRetryContext(context: ImplementationRetryContext): string {
  return `${IMPLEMENTATION_RETRY_CONTEXT_LABEL}: ${canonicalJson(context as unknown as JsonValue)}`;
}

type PromptContextParse<T> =
  | Readonly<{ ok: true; value: T | null; sourceLine: string | null }>
  | Readonly<{ ok: false; error: string }>;

type ContextPayloadParser<T> = (raw: unknown) =>
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

function parsePromptContext<T>(
  prompt: string,
  label: string,
  name: string,
  parse: ContextPayloadParser<T>,
): PromptContextParse<T> {
  const lines = prompt.split(/\r?\n/u).filter((line) => line.startsWith(`${label}:`));
  if (lines.length === 0) return { ok: true, value: null, sourceLine: null };
  if (lines.length !== 1) return { ok: false, error: `implementation prompt must contain at most one ${name} context` };
  const prefix = `${label}: `;
  const line = lines[0]!;
  if (!line.startsWith(prefix)) return { ok: false, error: `implementation ${name} context must use the canonical label separator` };
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(prefix.length));
  } catch (cause) {
    return { ok: false, error: `implementation ${name} context is not JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = parse(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value, sourceLine: line }
    : { ok: false, error: parsed.errors.join("; ") };
}

const parsePromptRetryContext = (prompt: string): PromptContextParse<ImplementationRetryContext> =>
  parsePromptContext(prompt, IMPLEMENTATION_RETRY_CONTEXT_LABEL, "retry", parseImplementationRetryContext);

/** The engine-derived authority a dispatched child needs to prove EXISTING
 * work. The digest binds the exact attested obligation set and verification
 * policy the attest program authored, so a prompt carrying this line cannot
 * have been written for any other proof state. */
export type ImplementationAttestationContext = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attestation-context";
  taskId: TaskId;
  attestationProofDigest: ArtifactDigest;
}>;

export type AttestationContextSource = Readonly<{
  id: string;
  implementation_attestation?: true;
  proof?: TaskProof;
  verification_policy?: unknown;
  new_tests_required?: unknown;
}>;

export type AttestationContextDerivation =
  | Readonly<{ ok: true; context: ImplementationAttestationContext; promptAppendix: string }>
  | Readonly<{ ok: false; error: string }>;

export function parseImplementationAttestationContext(raw: unknown, path = "implementationAttestationContext"):
  | Readonly<{ ok: true; value: ImplementationAttestationContext }>
  | Readonly<{ ok: false; errors: readonly [string, ...string[]] }> {
  const record = readExactDataRecord(raw, [
    "schemaVersion",
    "kind",
    "taskId",
    "attestationProofDigest",
  ], path);
  if (!record.ok) return { ok: false, errors: nonEmptyErrors([record.error.message]) };
  const taskId = parseTaskId(record.value.taskId, `${path}.taskId`);
  const digest = parseArtifactDigest(record.value.attestationProofDigest);
  const errors = [
    ...(record.value.schemaVersion === 1 ? [] : [`${path}.schemaVersion must equal 1`]),
    ...(record.value.kind === "implementation-attestation-context"
      ? []
      : [`${path}.kind must equal implementation-attestation-context`]),
    ...(taskId.ok ? [] : taskId.error.errors),
    ...(digest.ok ? [] : [`${path}.attestationProofDigest: ${digest.error.message}`]),
  ];
  if (errors.length > 0 || !taskId.ok || !digest.ok) {
    return { ok: false, errors: nonEmptyErrors(errors) };
  }
  return {
    ok: true,
    value: freeze({
      schemaVersion: 1,
      kind: "implementation-attestation-context",
      taskId: taskId.value,
      attestationProofDigest: digest.value,
    }),
  };
}

/** Derive the attestation context from a Task's stored attestation proof and
 * verification policy. Refuses anything that is not exactly attestation mode
 * with a parser-proven, attested-arm-only proof — the same invariants the
 * load boundary proves for persisted Tasks, re-proven at the binding boundary
 * so an in-memory graph cannot bind authority its own loader would refuse. */
export function deriveImplementationAttestationContext(
  task: AttestationContextSource,
): AttestationContextDerivation {
  if (task.implementation_attestation !== true) {
    return { ok: false, error: `Task ${task.id} is not in attestation mode` };
  }
  const taskId = parseTaskId(task.id, "attestation task id");
  if (!taskId.ok) return { ok: false, error: taskId.error.errors.join("; ") };
  if (task.proof === undefined) {
    return { ok: false, error: `Task ${task.id} carries no attestation proof` };
  }
  const proof = parseTaskProof(task.proof);
  if (!proof.ok) {
    return { ok: false, error: `Task ${task.id} carries malformed proof: ${proof.errors.join("; ")}` };
  }
  if (proof.value.obligations.some((obligation) => obligation.kind === "declared-artifact-changed")) {
    return {
      ok: false,
      error: `Task ${task.id} attestation proof carries declared-artifact-changed obligations; attestation requires the attested arm`,
    };
  }
  let policy: ReturnType<typeof taskVerificationPolicy>;
  try {
    policy = taskVerificationPolicy(task);
  } catch (cause) {
    return {
      ok: false,
      error: `Task ${task.id} carries malformed verification policy: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const attestationProofDigest = sha256Hex(canonicalJson({
    obligations: proof.value.obligations as unknown as JsonValue,
    verificationPolicy: policy as unknown as JsonValue,
  }));
  const digest = parseArtifactDigest(attestationProofDigest);
  if (!digest.ok) throw new Error("internal attestation context digest is invalid");
  const context = freeze({
    schemaVersion: 1 as const,
    kind: "implementation-attestation-context" as const,
    taskId: taskId.value,
    attestationProofDigest: digest.value,
  });
  return {
    ok: true,
    context,
    promptAppendix: `${IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL}: ${canonicalJson(context as unknown as JsonValue)}`,
  };
}

const parsePromptAttestationContext = (prompt: string): PromptContextParse<ImplementationAttestationContext> =>
  parsePromptContext(prompt, IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL, "attestation", parseImplementationAttestationContext);

type ImplementationRetryLineage =
  | Readonly<{ kind: "initial" }>
  | Readonly<{ kind: "retry"; predecessor: RetryRequiredSettlementReceipt }>
  | Readonly<{
      kind: "escalated";
      receiptId: ImplementationSettlementReceiptId;
      authorityDigest: ImplementationAuthorityDigest;
      failureKinds: readonly [string, ...string[]];
    }>;

function invalidLineage(
  index: number,
  receipt: ImplementationAttemptSettlementReceipt,
  error: string,
): ImplementationRetryDisposition {
  return freeze({
    kind: "invalid",
    errors: [`implementation_attempt_history[${index}] (${receipt.receiptId}): ${error}`],
  });
}

function projectedDisposition(lineage: ImplementationRetryLineage): ImplementationRetryDisposition {
  if (lineage.kind === "escalated") {
    return freeze({
      kind: "escalated",
      receiptId: lineage.receiptId,
      failureKinds: lineage.failureKinds,
    });
  }
  if (lineage.kind === "retry") {
    const context = retryContextFor(lineage.predecessor);
    return freeze({
      kind: "retry",
      semanticAttempt: 2,
      predecessor: lineage.predecessor,
      context,
      promptAppendix: renderImplementationRetryContext(context),
    });
  }
  return freeze({ kind: "initial", semanticAttempt: 1 });
}

/**
 * Project one wire-order history slice onto the attempt-lineage state machine.
 *
 * Returns the final lineage, or the rejection reason for the first
 * contradictory receipt. The remediation receipt is the ONE legal successor of
 * a terminal escalation: it closes the escalated lineage so the walk can reset
 * to a fresh attempt 1. Every other receipt after a terminal escalation is a
 * contradiction.
 */
function projectLineage(
  start: ImplementationRetryLineage,
  history: readonly ImplementationAttemptSettlementReceipt[],
  attestation: boolean,
): ImplementationRetryLineage | string {
  let lineage = start;
  for (const [index, receipt] of history.entries()) {
    if (lineage.kind === "escalated" && receipt.transition !== "escalation-remediated") {
      return `implementation_attempt_history[${index}] (${receipt.receiptId}): receipt appears after terminal escalation ${lineage.receiptId}`;
    }
    const expectedAttempt = lineage.kind === "initial" ? 1 : 2;
    if (receipt.semanticAttempt !== expectedAttempt) {
      return `implementation_attempt_history[${index}] (${receipt.receiptId}): semantic attempt ${receipt.semanticAttempt} is not the current attempt ${expectedAttempt}`;
    }
    if (receipt.transition === "infrastructure-blocked") continue;
    if (receipt.transition === "implemented") {
      lineage = freeze({ kind: "initial" });
      continue;
    }
    if (receipt.transition === "retry-required") {
      if (lineage.kind !== "initial") {
        return `implementation_attempt_history[${index}] (${receipt.receiptId}): retry authorization requires semantic attempt 1`;
      }
      lineage = attestation && receipt.failureKinds.some((kind) =>
        kind === "proof:attempt-scope-drifted" || kind === "proof:declared-artifact-drifted")
        ? freeze({ kind: "escalated", receiptId: receipt.receiptId,
            authorityDigest: receipt.authorityDigest, failureKinds: receipt.failureKinds })
        : freeze({ kind: "retry", predecessor: receipt });
      continue;
    }
    if (receipt.transition === "escalation-remediated") {
      if (lineage.kind !== "escalated") {
        return `implementation_attempt_history[${index}] (${receipt.receiptId}): escalation remediation requires a terminal escalation`;
      }
      const terminal = lineage;
      const sameFailures = receipt.failureKinds.length === terminal.failureKinds.length &&
        receipt.failureKinds.every((kind, failureIndex) => kind === terminal.failureKinds[failureIndex]);
      if (receipt.authorityDigest !== terminal.authorityDigest || !sameFailures) {
        return `implementation_attempt_history[${index}] (${receipt.receiptId}): escalation remediation does not bind the exact terminal authority and failure set`;
      }
      lineage = freeze({ kind: "initial" });
      continue;
    }
    if (lineage.kind !== "retry") {
      return `implementation_attempt_history[${index}] (${receipt.receiptId}): escalation requires a preceding retry authorization`;
    }
    lineage = freeze({
      kind: "escalated",
      receiptId: receipt.receiptId,
      authorityDigest: receipt.authorityDigest,
      failureKinds: receipt.failureKinds,
    });
  }
  return lineage;
}

/**
 * Derive the only legal next semantic attempt from settlement history plus the
 * persisted protocol-2 lineage fields.
 *
 * A Task with NO settlement history is a fresh lineage: the first modern
 * registration writes the protocol-2 fields. Attempt history WITHOUT them is
 * refused — there is no read-only compatibility projection; such a Task must
 * be re-registered through a modern implementation dispatch (or re-populated).
 */
export function deriveImplementationRetryDisposition(
  task: RetryableImplementationTask,
): ImplementationRetryDisposition {
  const parsedTaskId = parseTaskId(task.id, "retry task id");
  const parsedHistory = parseImplementationAttemptHistory(task.implementation_attempt_history ?? []);
  const parseErrors = [
    ...(parsedTaskId.ok ? [] : parsedTaskId.error.errors),
    ...(parsedHistory.ok ? [] : parsedHistory.error.errors),
  ];
  if (parseErrors.length > 0 || !parsedTaskId.ok || !parsedHistory.ok) {
    return freeze({ kind: "invalid", errors: nonEmptyErrors(parseErrors) });
  }

  const history = parsedHistory.value;
  for (const [index, receipt] of history.entries()) {
    if (receipt.taskId !== parsedTaskId.value) {
      return invalidLineage(index, receipt, `receipt task ${receipt.taskId} does not match ${parsedTaskId.value}`);
    }
  }
  if (history.length === 0) return freeze({ kind: "initial", semanticAttempt: 1 });
  if (task.implementation_retry_protocol !== 2) {
    return freeze({
      kind: "invalid",
      errors: nonEmptyErrors([
        "attempt history requires protocol-2 retry lineage; re-register the Task through a modern implementation dispatch",
      ]),
    });
  }
  const historyStart = task.implementation_retry_history_start;
  if (historyStart === undefined || !Number.isSafeInteger(historyStart) ||
      historyStart < 0 || historyStart > history.length) {
    return freeze({
      kind: "invalid",
      errors: nonEmptyErrors(["implementation retry protocol 2 requires a valid history start index"]),
    });
  }
  const attestation = task.implementation_attestation === true;
  const prefix = projectLineage(freeze({ kind: "initial" }), history.slice(0, historyStart), attestation);
  if (typeof prefix === "string") {
    return freeze({
      kind: "invalid",
      errors: nonEmptyErrors([`implementation retry history start skips an invalid lineage: ${prefix}`]),
    });
  }
  if (prefix.kind === "escalated") {
    return freeze({
      kind: "invalid",
      errors: nonEmptyErrors(["implementation retry history start cannot skip terminal authority"]),
    });
  }
  const seedId = task.implementation_retry_predecessor_receipt_id;
  if (prefix.kind === "retry") {
    if (seedId !== prefix.predecessor.receiptId) {
      return freeze({
        kind: "invalid",
        errors: nonEmptyErrors(["implementation retry predecessor must match the compatibility prefix disposition"]),
      });
    }
  } else if (seedId !== undefined) {
    return freeze({
      kind: "invalid",
      errors: nonEmptyErrors(["initial compatibility prefix cannot carry a retry predecessor"]),
    });
  }
  const walked = projectLineage(prefix, history.slice(historyStart), attestation);
  if (typeof walked === "string") {
    return freeze({ kind: "invalid", errors: nonEmptyErrors([walked]) });
  }
  return projectedDisposition(walked);
}

/** Require the exact engine-derived retry appendix before attempt-2 authority can be minted. */
export function authorizeImplementationSpawn(
  task: RetryableImplementationTask,
  prompt: string,
): ImplementationSpawnAdmission {
  const disposition = deriveImplementationRetryDisposition(task);
  switch (disposition.kind) {
    case "invalid":
      return { ok: false, error: disposition.errors.join("; ") };
    case "escalated":
      return {
        ok: false,
        error: disposition.failureKinds.includes("proof:attempt-scope-drifted")
          ? `Task ${task.id} has terminal attestation drift and requires escalation (${disposition.failureKinds.join(", ")})`
          : `Task ${task.id} exhausted semantic attempt 2 and requires escalation (${disposition.failureKinds.join(", ")})`,
      };
    case "initial":
    case "retry":
      break;
  }
  const parsedTaskId = parseTaskId(task.id, "implementation spawn task id");
  if (!parsedTaskId.ok) return { ok: false, error: parsedTaskId.error.errors.join("; ") };
  const history = task.implementation_attempt_history ?? [];
  const historyStart = task.implementation_retry_protocol === 2
    ? task.implementation_retry_history_start!
    : history.length;
  const lineagePredecessorReceiptId: ImplementationSettlementReceiptId | null =
    task.implementation_retry_protocol === 2
      ? task.implementation_retry_predecessor_receipt_id ?? null
      : null;
  const promptDigest = sha256(prompt);
  const supplied = parsePromptRetryContext(prompt);
  if (!supplied.ok) return supplied;
  // Attestation binding is orthogonal to the retry budget: EVERY dispatched
  // prompt for an attestation Task (attempt 1 or attempt 2) must carry the
  // exact engine-derived attestation context, and no other prompt may carry
  // one. The context digest binds the stored attested obligation set and
  // verification policy, so a drifted proof cannot ride an old appendix.
  const suppliedAttestation = parsePromptAttestationContext(prompt);
  if (!suppliedAttestation.ok) return suppliedAttestation;
  const expectedAttestation = task.implementation_attestation === true
    ? deriveImplementationAttestationContext(task)
    : null;
  if (expectedAttestation !== null) {
    if (!expectedAttestation.ok) return { ok: false, error: expectedAttestation.error };
    if (suppliedAttestation.value === null) {
      return {
        ok: false,
        error: `Task ${task.id} is in attestation mode and requires the exact attestation context from orchestration status`,
      };
    }
    if (suppliedAttestation.sourceLine !== expectedAttestation.promptAppendix) {
      return {
        ok: false,
        error: `Task ${task.id} attestation context bytes do not match the stored attestation proof`,
      };
    }
  } else if (suppliedAttestation.value !== null) {
    return { ok: false, error: `Task ${task.id} is not in attestation mode; refusing a caller-supplied attestation context` };
  }
  if (disposition.kind === "initial") {
    return supplied.value === null
      ? {
          ok: true,
          kind: "initial",
          taskId: parsedTaskId.value,
          semanticAttempt: 1 as SemanticAttempt & 1,
          promptDigest,
          historyStart,
          lineagePredecessorReceiptId,
          retryContext: null,
          predecessorReceiptId: null,
        }
      : { ok: false, error: `Task ${task.id} has no current retry authority; refusing a caller-supplied retry context` };
  }
  if (supplied.value === null) {
    return {
      ok: false,
      error: `Task ${task.id} requires the exact attempt-2 retry context from orchestration status`,
    };
  }
  if (supplied.sourceLine !== disposition.promptAppendix) {
    return {
      ok: false,
      error: `Task ${task.id} retry context bytes do not match current receipt ${disposition.predecessor.receiptId}`,
    };
  }
  return {
    ok: true,
    kind: "retry",
    taskId: parsedTaskId.value,
    semanticAttempt: 2 as SemanticAttempt & 2,
    promptDigest,
    historyStart,
    lineagePredecessorReceiptId,
    retryContext: disposition.context,
    predecessorReceiptId: disposition.predecessor.receiptId,
  };
}

type AttemptContextIdentity = Readonly<Pick<
  ImplementationAttemptAuthority,
  "taskId" | "semanticAttempt" | "authorityDigest"
>>;

function attemptContextBody(args: Readonly<{
  authority: AttemptContextIdentity;
  promptDigest: ArtifactDigest;
  predecessorReceiptId: ImplementationSettlementReceiptId | null;
  retryContext: ImplementationRetryContext | null;
}>): Omit<ImplementationAttemptContext, "contextDigest"> {
  return freeze({
    schemaVersion: 1,
    kind: "implementation-attempt-context",
    taskId: args.authority.taskId,
    semanticAttempt: args.authority.semanticAttempt,
    authorityDigest: args.authority.authorityDigest,
    promptDigest: args.promptDigest,
    predecessorReceiptId: args.predecessorReceiptId,
    retryContext: args.retryContext,
  });
}

export function createImplementationAttemptContext(args: Readonly<{
  authority: ImplementationAttemptAuthority;
  prompt: string;
  admission: AdmittedImplementationSpawn;
}>): ImplementationAttemptContext {
  if (args.authority.taskId !== args.admission.taskId) {
    throw new Error(
      `implementation attempt authority ${args.authority.authorityDigest} belongs to Task ${args.authority.taskId}, ` +
      `but spawn admission belongs to ${args.admission.taskId}`,
    );
  }
  if (args.authority.semanticAttempt !== args.admission.semanticAttempt) {
    throw new Error(
      `implementation attempt authority ${args.authority.authorityDigest} uses semantic attempt ` +
      `${args.authority.semanticAttempt}, but spawn admission authorizes ${args.admission.semanticAttempt}`,
    );
  }
  const promptDigest = sha256(args.prompt);
  if (promptDigest !== args.admission.promptDigest) {
    throw new Error(`implementation attempt prompt does not match admitted prompt bytes for Task ${args.authority.taskId}`);
  }
  if (args.admission.kind === "retry" && (
    args.admission.retryContext.taskId !== args.admission.taskId ||
    args.admission.retryContext.predecessorReceiptId !== args.admission.predecessorReceiptId
  )) {
    throw new Error(`implementation retry admission carries contradictory nested authority for Task ${args.admission.taskId}`);
  }
  const body = attemptContextBody({
    authority: args.authority,
    promptDigest,
    predecessorReceiptId: args.admission.predecessorReceiptId,
    retryContext: args.admission.retryContext,
  });
  return freeze({ ...body, contextDigest: sha256(canonicalJson(body as unknown as JsonValue)) });
}

export function parseImplementationAttemptContext(
  raw: unknown,
  path = "implementationAttemptContext",
): AttemptContextParseResult {
  const record = readExactDataRecord(raw, [
    "schemaVersion",
    "kind",
    "taskId",
    "semanticAttempt",
    "authorityDigest",
    "promptDigest",
    "predecessorReceiptId",
    "retryContext",
    "contextDigest",
  ], path);
  if (!record.ok) return { ok: false, errors: nonEmptyErrors([record.error.message]) };
  const taskId = parseTaskId(record.value.taskId, `${path}.taskId`);
  const attempt = parseSemanticAttempt(record.value.semanticAttempt, `${path}.semanticAttempt`);
  const authorityDigest = parseImplementationAuthorityDigest(record.value.authorityDigest, `${path}.authorityDigest`);
  const predecessor = record.value.predecessorReceiptId === null
    ? null
    : parseImplementationSettlementReceiptId(record.value.predecessorReceiptId, `${path}.predecessorReceiptId`);
  const retry = record.value.retryContext === null
    ? null
    : parseImplementationRetryContext(record.value.retryContext, `${path}.retryContext`);
  const promptDigest = parseArtifactDigest(record.value.promptDigest);
  const contextDigest = parseArtifactDigest(record.value.contextDigest);
  const errors = [
    ...(record.value.schemaVersion === 1 ? [] : [`${path}.schemaVersion must equal 1`]),
    ...(record.value.kind === "implementation-attempt-context" ? [] : [`${path}.kind must equal implementation-attempt-context`]),
    ...(taskId.ok ? [] : taskId.error.errors),
    ...(attempt.ok ? [] : attempt.error.errors),
    ...(authorityDigest.ok ? [] : authorityDigest.error.errors),
    ...(predecessor === null || predecessor.ok ? [] : predecessor.error.errors),
    ...(retry === null || retry.ok ? [] : retry.errors),
    ...(promptDigest.ok ? [] : [`${path}.promptDigest: ${promptDigest.error.message}`]),
    ...(contextDigest.ok ? [] : [`${path}.contextDigest: ${contextDigest.error.message}`]),
  ];
  if (errors.length > 0 || !taskId.ok || !attempt.ok || !authorityDigest.ok || !promptDigest.ok ||
      !contextDigest.ok || (predecessor !== null && !predecessor.ok) || (retry !== null && !retry.ok)) {
    return { ok: false, errors: nonEmptyErrors(errors) };
  }
  const predecessorValue = predecessor === null ? null : predecessor.value;
  const retryValue = retry === null ? null : retry.value;
  if (attempt.value === 1 && (predecessorValue !== null || retryValue !== null)) {
    return { ok: false, errors: [`${path}: semantic attempt 1 cannot carry retry authority`] };
  }
  if (attempt.value === 2 && (predecessorValue === null || retryValue === null ||
      retryValue.predecessorReceiptId !== predecessorValue || retryValue.taskId !== taskId.value)) {
    return { ok: false, errors: [`${path}: semantic attempt 2 requires one matching retry context`] };
  }
  const body = attemptContextBody({
    authority: {
      taskId: taskId.value,
      semanticAttempt: attempt.value,
      authorityDigest: authorityDigest.value,
    },
    promptDigest: promptDigest.value,
    predecessorReceiptId: predecessorValue,
    retryContext: retryValue,
  });
  const expectedDigest = sha256(canonicalJson(body as unknown as JsonValue));
  return expectedDigest === contextDigest.value
    ? { ok: true, value: freeze({ ...body, contextDigest: contextDigest.value }) }
    : { ok: false, errors: [`${path}.contextDigest does not match its canonical context`] };
}

export function implementationAttemptContextMatchesAuthority(
  context: ImplementationAttemptContext,
  authority: ImplementationAttemptAuthority,
): boolean {
  return context.taskId === authority.taskId &&
    context.semanticAttempt === authority.semanticAttempt &&
    context.authorityDigest === authority.authorityDigest;
}
