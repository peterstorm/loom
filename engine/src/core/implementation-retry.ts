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
import { canonicalJson, sha256Hex, type JsonValue } from "./review-packet";
import { parseTaskId, type TaskId } from "./task-id";

const MAX_FAILURE_KINDS = 64;
const MAX_FAILURE_KIND_LENGTH = 4_096;
export const IMPLEMENTATION_RETRY_CONTEXT_LABEL = "LOOM_IMPLEMENTATION_RETRY_CONTEXT";

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
      semanticAttempt: SemanticAttempt & 1;
      retryContext: null;
      predecessorReceiptId: null;
    }>
  | Readonly<{
      ok: true;
      kind: "retry";
      semanticAttempt: SemanticAttempt & 2;
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
  const array = readDenseDataArray(raw, path, MAX_FAILURE_KINDS);
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
  const sorted = [...values].sort();
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

function contextLines(prompt: string): readonly string[] {
  return prompt.split(/\r?\n/u).filter((line) => line.startsWith(`${IMPLEMENTATION_RETRY_CONTEXT_LABEL}:`));
}

function parsePromptRetryContext(prompt: string):
  | Readonly<{ ok: true; value: ImplementationRetryContext | null }>
  | Readonly<{ ok: false; error: string }> {
  const lines = contextLines(prompt);
  if (lines.length === 0) return { ok: true, value: null };
  if (lines.length !== 1) return { ok: false, error: "implementation prompt must contain at most one retry context" };
  const prefix = `${IMPLEMENTATION_RETRY_CONTEXT_LABEL}: `;
  const line = lines[0]!;
  if (!line.startsWith(prefix)) return { ok: false, error: "implementation retry context must use the canonical label separator" };
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(prefix.length));
  } catch (cause) {
    return {
      ok: false,
      error: `implementation retry context is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const parsed = parseImplementationRetryContext(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: parsed.errors.join("; ") };
}

type ImplementationRetryLineage =
  | Readonly<{ kind: "initial" }>
  | Readonly<{ kind: "retry"; predecessor: RetryRequiredSettlementReceipt }>
  | Readonly<{
      kind: "escalated";
      receiptId: ImplementationSettlementReceiptId;
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

/** Derive the only legal next semantic attempt from immutable settlement history. */
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

  let lineage: ImplementationRetryLineage = freeze({ kind: "initial" });
  for (const [index, receipt] of parsedHistory.value.entries()) {
    if (receipt.taskId !== parsedTaskId.value) {
      return invalidLineage(index, receipt, `receipt task ${receipt.taskId} does not match ${parsedTaskId.value}`);
    }
    if (lineage.kind === "escalated") {
      return invalidLineage(index, receipt, `receipt appears after terminal escalation ${lineage.receiptId}`);
    }
    const expectedAttempt = lineage.kind === "initial" ? 1 : 2;
    if (receipt.semanticAttempt !== expectedAttempt) {
      return invalidLineage(
        index,
        receipt,
        `semantic attempt ${receipt.semanticAttempt} is not the current attempt ${expectedAttempt}`,
      );
    }
    if (receipt.transition === "infrastructure-blocked") continue;
    if (receipt.transition === "implemented") {
      lineage = freeze({ kind: "initial" });
      continue;
    }
    if (receipt.transition === "retry-required") {
      if (lineage.kind !== "initial") {
        return invalidLineage(index, receipt, "retry authorization requires semantic attempt 1");
      }
      lineage = freeze({ kind: "retry", predecessor: receipt });
      continue;
    }
    if (lineage.kind !== "retry") {
      return invalidLineage(index, receipt, "escalation requires a preceding retry authorization");
    }
    lineage = freeze({
      kind: "escalated",
      receiptId: receipt.receiptId,
      failureKinds: receipt.failureKinds,
    });
  }

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
        error: `Task ${task.id} exhausted semantic attempt 2 and requires escalation (${disposition.failureKinds.join(", ")})`,
      };
    case "initial":
    case "retry":
      break;
  }
  const supplied = parsePromptRetryContext(prompt);
  if (!supplied.ok) return supplied;
  if (disposition.kind === "initial") {
    return supplied.value === null
      ? {
          ok: true,
          kind: "initial",
          semanticAttempt: 1 as SemanticAttempt & 1,
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
  if (contextLines(prompt)[0] !== disposition.promptAppendix) {
    return {
      ok: false,
      error: `Task ${task.id} retry context bytes do not match current receipt ${disposition.predecessor.receiptId}`,
    };
  }
  return {
    ok: true,
    kind: "retry",
    semanticAttempt: 2 as SemanticAttempt & 2,
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
  if (args.authority.semanticAttempt !== args.admission.semanticAttempt) {
    throw new Error(
      `implementation attempt authority ${args.authority.authorityDigest} uses semantic attempt ` +
      `${args.authority.semanticAttempt}, but spawn admission authorizes ${args.admission.semanticAttempt}`,
    );
  }
  const body = attemptContextBody({
    authority: args.authority,
    promptDigest: sha256(args.prompt),
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
