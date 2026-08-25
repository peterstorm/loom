/**
 * Pure Task-local implementation completion aggregate.
 *
 * Baseline arrays are SETS keyed by canonical artifact path: parsers sort them
 * before hashing, so input permutation does not change authority. Settlement
 * history is ordered audit data and therefore preserves input order.
 *
 * This module performs no filesystem, process, clock, random, or network I/O.
 */

import {
  parseCompletionCheckId,
  parseWaveNumber,
  type CompletionCheckId,
  type WaveNumber,
} from "./completion-suite";
import {
  evaluateProofObligations,
  parseObservedProofEvidence,
  parseProofEvaluationPolicy,
  parseTaskProof,
  type FailedTaskProof,
  type ObservedProofEvidence,
  type ProofEvaluationPolicy,
  type ProofFailure,
  type SatisfiedTaskProof,
  type TaskProof,
} from "./proof-obligations";
import { compareStrings } from "./ordering";
import {
  canonicalJson,
  parseReviewPath,
  sha256Hex,
  type JsonValue,
  type ReviewPath,
} from "./review-packet";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";

const TASK_ID_PATTERN = /^T\d+$/;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_REASON_LENGTH = 4_096;
export const TASK_BYTE_SCOPE_CHECK_ID_TEXT = "loom:task-byte-scope" as const;

// Brands prevent adjacent authority fields with identical runtime primitives
// from being transposed after parsing.
declare const TASK_ID: unique symbol;
declare const SEMANTIC_ATTEMPT: unique symbol;
declare const RESERVATION_ID: unique symbol;
declare const GIT_SHA: unique symbol;
declare const ISO_INSTANT: unique symbol;
declare const BASELINE_DIGEST: unique symbol;
declare const AUTHORITY_DIGEST: unique symbol;
declare const TASK_SUITE_DIGEST: unique symbol;
declare const SETTLEMENT_RECEIPT_ID: unique symbol;

export type TaskId = string & { readonly [TASK_ID]: true };
export type Wave = WaveNumber;
export type SemanticAttempt = (1 | 2) & { readonly [SEMANTIC_ATTEMPT]: true };
export type ReservationId = string & { readonly [RESERVATION_ID]: true };
export type GitSha = string & { readonly [GIT_SHA]: true };
export type IsoInstant = string & { readonly [ISO_INSTANT]: true };
export type ArtifactBaselineDigest = string & { readonly [BASELINE_DIGEST]: true };
export type ImplementationAuthorityDigest = string & { readonly [AUTHORITY_DIGEST]: true };
export type TaskCompletionSuiteDigest = string & { readonly [TASK_SUITE_DIGEST]: true };
export type ImplementationSettlementReceiptId = string & { readonly [SETTLEMENT_RECEIPT_ID]: true };

export type ImplementationCompletionParseError = Readonly<{
  kind: "invalid-implementation-completion";
  errors: readonly [string, ...string[]];
}>;

export type ImplementationCompletionParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ImplementationCompletionParseError }>;

type UnknownRecord = Record<string, unknown>;
type Parsed<T> = ImplementationCompletionParseResult<T>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
const success = <T>(value: T): Parsed<T> => freeze({ ok: true, value });

function failure<T>(errors: readonly string[]): Parsed<T> {
  const normalized = errors.length === 0 ? ["implementation completion input is invalid"] : errors;
  const [head, ...tail] = normalized;
  return freeze({
    ok: false,
    error: freeze({
      kind: "invalid-implementation-completion",
      errors: Object.freeze([head ?? "implementation completion input is invalid", ...tail]),
    }),
  });
}

function total<T>(parse: () => Parsed<T>): Parsed<T> {
  try {
    return parse();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown parser failure";
    return failure([`implementation completion input could not be inspected: ${message.slice(0, 256)}`]);
  }
}

function isRecord(raw: unknown): raw is UnknownRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const prototype: unknown = Object.getPrototypeOf(raw);
  return prototype === null || prototype === Object.prototype;
}

function exactRecord(raw: unknown, fields: readonly string[], path: string): Parsed<UnknownRecord> {
  if (!isRecord(raw)) return failure([`${path} must be a plain object`]);
  const expected = new Set(fields);
  const keys = Reflect.ownKeys(raw);
  const surplus = keys.flatMap((key) =>
    typeof key === "string" && expected.has(key) ? [] : [`${path}.${String(key)} is not allowed`]);
  const missing = fields
    .filter((field) => !Object.prototype.hasOwnProperty.call(raw, field))
    .map((field) => `${path}.${field} is required`);
  return surplus.length === 0 && missing.length === 0 ? success(raw) : failure([...missing, ...surplus]);
}

function parseDenseArray(raw: unknown, path: string): Parsed<readonly unknown[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const values: unknown[] = [];
  const errors: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) errors.push(`${path}[${index}] must be present`);
    else values.push(raw[index]);
  }
  return errors.length === 0 ? success(freezeArray(values)) : failure(errors);
}

function collect<T>(raw: readonly unknown[], path: string, parser: (value: unknown, path: string) => Parsed<T>): Parsed<readonly T[]> {
  const values: T[] = [];
  const errors: string[] = [];
  raw.forEach((value, index) => {
    const parsed = parser(value, `${path}[${index}]`);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.error.errors);
  });
  return errors.length === 0 ? success(freezeArray(values)) : failure(errors);
}

function parseBoundedReason(raw: unknown, path: string): Parsed<string> {
  return typeof raw === "string" && raw.trim().length > 0 && raw.length <= MAX_REASON_LENGTH
    ? success(raw)
    : failure([`${path} must be non-empty and at most ${MAX_REASON_LENGTH} characters`]);
}

/** Exact Task identity smart constructor. */
export function parseTaskId(raw: unknown, path = "taskId"): Parsed<TaskId> {
  return total(() => typeof raw === "string" && TASK_ID_PATTERN.test(raw)
    ? success(raw as TaskId)
    : failure([`${path} must match T\\d+`]));
}

/** Reuses the existing positive Wave schema; Task authority cannot weaken it. */
export function parseWave(raw: unknown, path = "wave"): Parsed<Wave> {
  return total(() => {
    const parsed = parseWaveNumber(raw, path);
    return parsed.ok ? success(parsed.value) : failure(parsed.error.errors);
  });
}

export function parseSemanticAttempt(raw: unknown, path = "semanticAttempt"): Parsed<SemanticAttempt> {
  return total(() => raw === 1 || raw === 2
    ? success(raw as SemanticAttempt)
    : failure([`${path} must be 1 or 2`]));
}

export function parseReservationId(raw: unknown, path = "reservationId"): Parsed<ReservationId> {
  return total(() => typeof raw === "string" && RESERVATION_ID_PATTERN.test(raw)
    ? success(raw as ReservationId)
    : failure([`${path} must be a canonical non-empty reservation id`]));
}

export function parseGitSha(raw: unknown, path = "headSha"): Parsed<GitSha> {
  return total(() => typeof raw === "string" && GIT_SHA_PATTERN.test(raw)
    ? success(raw as GitSha)
    : failure([`${path} must be a lowercase 40- or 64-character Git SHA`]));
}

export function parseIsoInstant(raw: unknown, path = "instant"): Parsed<IsoInstant> {
  return total(() => {
    if (typeof raw !== "string" || !ISO_INSTANT_PATTERN.test(raw)) {
      return failure([`${path} must be an exact UTC ISO instant with millisecond precision`]);
    }
    const epoch = Date.parse(raw);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === raw
      ? success(raw as IsoInstant)
      : failure([`${path} must be a real UTC ISO instant`]);
  });
}

export function parseArtifactBaselineDigest(raw: unknown, path = "baselineDigest"): Parsed<ArtifactBaselineDigest> {
  return total(() => typeof raw === "string" && SHA256_PATTERN.test(raw)
    ? success(raw as ArtifactBaselineDigest)
    : failure([`${path} must be a lowercase SHA-256 digest`]));
}

export function parseImplementationAuthorityDigest(
  raw: unknown,
  path = "authorityDigest",
): Parsed<ImplementationAuthorityDigest> {
  return total(() => typeof raw === "string" && SHA256_PATTERN.test(raw)
    ? success(raw as ImplementationAuthorityDigest)
    : failure([`${path} must be a lowercase SHA-256 digest`]));
}

function parseTaskSuiteDigest(raw: unknown, path: string): Parsed<TaskCompletionSuiteDigest> {
  return typeof raw === "string" && SHA256_PATTERN.test(raw)
    ? success(raw as TaskCompletionSuiteDigest)
    : failure([`${path} must be a lowercase SHA-256 digest`]);
}

function parseReceiptId(raw: unknown, path: string): Parsed<ImplementationSettlementReceiptId> {
  return typeof raw === "string" && SHA256_PATTERN.test(raw)
    ? success(raw as ImplementationSettlementReceiptId)
    : failure([`${path} must be a lowercase SHA-256 digest`]);
}

function parseSnapshot(raw: unknown, path: string): Parsed<DeclaredArtifactBaseline["snapshot"]> {
  if (!isRecord(raw)) return failure([`${path} must be a plain object`]);
  if (raw.kind === "missing") {
    const record = exactRecord(raw, ["kind"], path);
    return record.ok ? success(freeze({ kind: "missing" })) : record;
  }
  const record = exactRecord(raw, ["kind", "digest"], path);
  if (!record.ok) return record;
  if (record.value.kind !== "sha256" || typeof record.value.digest !== "string" ||
      !SHA256_PATTERN.test(record.value.digest)) {
    return failure([`${path} must be {kind:"missing"} or exact {kind:"sha256",digest}`]);
  }
  return success(freeze({ kind: "sha256", digest: record.value.digest }));
}

/**
 * Parse an exact baseline as an unordered path-keyed set and return canonical
 * path order. Duplicate paths and all surplus fields fail closed.
 */
export function parseCanonicalArtifactBaseline(
  raw: unknown,
  path = "baseline",
): Parsed<readonly DeclaredArtifactBaseline[]> {
  return total(() => {
    const array = parseDenseArray(raw, path);
    if (!array.ok) return array;
    const entries = collect<DeclaredArtifactBaseline>(array.value, path, (value, entryPath) => {
      const record = exactRecord(value, ["artifact", "snapshot"], entryPath);
      if (!record.ok) return record;
      const artifact = parseReviewPath(record.value.artifact, `${entryPath}.artifact`);
      const snapshot = parseSnapshot(record.value.snapshot, `${entryPath}.snapshot`);
      const errors = [
        ...(artifact.ok ? [] : artifact.errors),
        ...(snapshot.ok ? [] : snapshot.error.errors),
      ];
      return errors.length === 0 && artifact.ok && snapshot.ok
        ? success(freeze({ artifact: artifact.value, snapshot: snapshot.value }))
        : failure(errors);
    });
    if (!entries.ok) return entries;
    const sorted = [...entries.value].sort((left, right) => compareStrings(left.artifact, right.artifact));
    const duplicate = sorted.find((entry, index) => index > 0 && sorted[index - 1]?.artifact === entry.artifact);
    return duplicate === undefined
      ? success(freezeArray(sorted))
      : failure([`${path} repeats artifact ${JSON.stringify(duplicate.artifact)}`]);
  });
}

function baselineDigest(value: JsonValue): ArtifactBaselineDigest {
  // Parser proof site: sha256Hex is guaranteed to emit this exact grammar.
  return sha256Hex(canonicalJson(value)) as ArtifactBaselineDigest;
}

/** Stable SHA-256 over a canonical, permutation-invariant baseline set. */
export function canonicalArtifactBaselineDigest(raw: unknown): Parsed<ArtifactBaselineDigest> {
  return total(() => {
    const baseline = parseCanonicalArtifactBaseline(raw);
    return baseline.ok
      ? success(baselineDigest({ kind: "implementation-artifact-baseline", entries: baseline.value }))
      : baseline;
  });
}

export type ImplementationAttemptAuthority = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attempt-authority";
  taskId: TaskId;
  wave: Wave;
  semanticAttempt: SemanticAttempt;
  reservationId: ReservationId;
  headSha: GitSha;
  reservedAt: IsoInstant;
  taskScopeBaselineDigest: ArtifactBaselineDigest;
  dirtySetBaselineDigest: ArtifactBaselineDigest;
  authorityDigest: ImplementationAuthorityDigest;
}>;

type AuthorityBody = Omit<ImplementationAttemptAuthority, "authorityDigest">;

function authorityDigest(body: AuthorityBody): ImplementationAuthorityDigest {
  // Parser proof site: sha256Hex is guaranteed to emit this exact grammar.
  return sha256Hex(canonicalJson(body)) as ImplementationAuthorityDigest;
}

function parseAuthorityBody(raw: UnknownRecord, path: string): Parsed<AuthorityBody> {
  const taskId = parseTaskId(raw.taskId, `${path}.taskId`);
  const wave = parseWave(raw.wave, `${path}.wave`);
  const semanticAttempt = parseSemanticAttempt(raw.semanticAttempt, `${path}.semanticAttempt`);
  const reservationId = parseReservationId(raw.reservationId, `${path}.reservationId`);
  const headSha = parseGitSha(raw.headSha, `${path}.headSha`);
  const reservedAt = parseIsoInstant(raw.reservedAt, `${path}.reservedAt`);
  const taskScopeBaselineDigest = parseArtifactBaselineDigest(
    raw.taskScopeBaselineDigest,
    `${path}.taskScopeBaselineDigest`,
  );
  const dirtySetBaselineDigest = parseArtifactBaselineDigest(
    raw.dirtySetBaselineDigest,
    `${path}.dirtySetBaselineDigest`,
  );
  const parsed = [taskId, wave, semanticAttempt, reservationId, headSha, reservedAt,
    taskScopeBaselineDigest, dirtySetBaselineDigest];
  const errors = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  if (errors.length > 0 || !taskId.ok || !wave.ok || !semanticAttempt.ok || !reservationId.ok ||
      !headSha.ok || !reservedAt.ok || !taskScopeBaselineDigest.ok || !dirtySetBaselineDigest.ok) {
    return failure(errors);
  }
  return success(freeze({
    schemaVersion: 1,
    kind: "implementation-attempt-authority",
    taskId: taskId.value,
    wave: wave.value,
    semanticAttempt: semanticAttempt.value,
    reservationId: reservationId.value,
    headSha: headSha.value,
    reservedAt: reservedAt.value,
    taskScopeBaselineDigest: taskScopeBaselineDigest.value,
    dirtySetBaselineDigest: dirtySetBaselineDigest.value,
  }));
}

/** Mint authority from exact identity fields plus the two captured baselines. */
export function createImplementationAttemptAuthority(raw: unknown): Parsed<ImplementationAttemptAuthority> {
  return total(() => {
    const record = exactRecord(raw, [
      "taskId", "wave", "semanticAttempt", "reservationId", "headSha", "reservedAt",
      "taskScopeBaseline", "dirtySetBaseline",
    ], "implementationAttemptInput");
    if (!record.ok) return record;
    const taskDigest = canonicalArtifactBaselineDigest(record.value.taskScopeBaseline);
    const dirtyDigest = canonicalArtifactBaselineDigest(record.value.dirtySetBaseline);
    const digestErrors = [taskDigest, dirtyDigest].flatMap((result) => result.ok ? [] : result.error.errors);
    if (digestErrors.length > 0 || !taskDigest.ok || !dirtyDigest.ok) return failure(digestErrors);
    const bodyRecord: UnknownRecord = {
      schemaVersion: 1,
      kind: "implementation-attempt-authority",
      taskId: record.value.taskId,
      wave: record.value.wave,
      semanticAttempt: record.value.semanticAttempt,
      reservationId: record.value.reservationId,
      headSha: record.value.headSha,
      reservedAt: record.value.reservedAt,
      taskScopeBaselineDigest: taskDigest.value,
      dirtySetBaselineDigest: dirtyDigest.value,
    };
    const body = parseAuthorityBody(bodyRecord, "implementationAttemptInput");
    if (!body.ok) return body;
    return success(freeze({ ...body.value, authorityDigest: authorityDigest(body.value) }));
  });
}

/** Rehydrate exact persisted authority and recompute its self-digest. */
export function parseImplementationAttemptAuthority(raw: unknown): Parsed<ImplementationAttemptAuthority> {
  return total(() => {
    const record = exactRecord(raw, [
      "schemaVersion", "kind", "taskId", "wave", "semanticAttempt", "reservationId", "headSha",
      "reservedAt", "taskScopeBaselineDigest", "dirtySetBaselineDigest", "authorityDigest",
    ], "implementationAuthority");
    if (!record.ok) return record;
    if (record.value.schemaVersion !== 1 || record.value.kind !== "implementation-attempt-authority") {
      return failure(["implementationAuthority must have schemaVersion 1 and kind implementation-attempt-authority"]);
    }
    const body = parseAuthorityBody(record.value, "implementationAuthority");
    const declared = parseImplementationAuthorityDigest(
      record.value.authorityDigest,
      "implementationAuthority.authorityDigest",
    );
    const errors = [...(body.ok ? [] : body.error.errors), ...(declared.ok ? [] : declared.error.errors)];
    if (errors.length > 0 || !body.ok || !declared.ok) return failure(errors);
    const expected = authorityDigest(body.value);
    return declared.value === expected
      ? success(freeze({ ...body.value, authorityDigest: expected }))
      : failure(["implementationAuthority.authorityDigest does not match its canonical authority"]);
  });
}

export type AuthorizedTaskCompletionCheck = Readonly<{
  kind: "engine-task-byte-scope";
  checkId: CompletionCheckId;
  scope: "task";
}>;

export type TaskCompletionSuiteAuthority = Readonly<{
  schemaVersion: 1;
  kind: "task-completion-suite-authority";
  implementationAuthorityDigest: ImplementationAuthorityDigest;
  checks: readonly [AuthorizedTaskCompletionCheck, ...AuthorizedTaskCompletionCheck[]];
  suiteDigest: TaskCompletionSuiteDigest;
}>;

function taskByteScopeCheck(): AuthorizedTaskCompletionCheck {
  // Parser proof site: this engine-owned literal is pinned to the shared check-id grammar.
  const checkId = TASK_BYTE_SCOPE_CHECK_ID_TEXT as CompletionCheckId;
  return freeze({ kind: "engine-task-byte-scope", checkId, scope: "task" });
}

function taskSuiteDigest(checks: readonly AuthorizedTaskCompletionCheck[]): TaskCompletionSuiteDigest {
  // Parser proof site: sha256Hex is guaranteed to emit this exact grammar.
  return sha256Hex(canonicalJson({ kind: "task-completion-suite-roster", checks })) as TaskCompletionSuiteDigest;
}

function parseAuthorizedTaskCheck(raw: unknown, path: string): Parsed<AuthorizedTaskCompletionCheck> {
  const record = exactRecord(raw, ["kind", "checkId", "scope"], path);
  if (!record.ok) return record;
  const checkId = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const errors = checkId.ok ? [] : [...checkId.error.errors];
  if (record.value.kind !== "engine-task-byte-scope") errors.push(`${path}.kind must equal engine-task-byte-scope`);
  if (record.value.checkId !== TASK_BYTE_SCOPE_CHECK_ID_TEXT) {
    errors.push(`${path}.checkId must equal ${TASK_BYTE_SCOPE_CHECK_ID_TEXT}`);
  }
  if (record.value.scope !== "task") errors.push(`${path}.scope must equal task`);
  return errors.length === 0 && checkId.ok
    ? success(freeze({ kind: "engine-task-byte-scope", checkId: checkId.value, scope: "task" }))
    : failure(errors);
}

function parseTaskRoster(raw: unknown, path: string): Parsed<readonly [AuthorizedTaskCompletionCheck, ...AuthorizedTaskCompletionCheck[]]> {
  const array = parseDenseArray(raw, path);
  if (!array.ok) return array;
  if (array.value.length === 0) return failure([`${path} must be non-empty`]);
  const checks = collect(array.value, path, parseAuthorizedTaskCheck);
  if (!checks.ok) return checks;
  const counts = new Map<string, number>();
  checks.value.forEach((check) => counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1));
  if (counts.get(TASK_BYTE_SCOPE_CHECK_ID_TEXT) !== 1 || counts.size !== 1) {
    return failure([`${path} must contain exactly one engine-owned ${TASK_BYTE_SCOPE_CHECK_ID_TEXT} check`]);
  }
  const first = checks.value[0];
  return first === undefined
    ? failure([`${path} must be non-empty`])
    : success(Object.freeze([first]));
}

/** Initial Phase-1 Task suite: one non-empty engine-owned byte-scope roster. */
export function createTaskCompletionSuiteAuthority(
  rawAuthority: unknown,
): Parsed<TaskCompletionSuiteAuthority> {
  return total(() => {
    const authority = parseImplementationAttemptAuthority(rawAuthority);
    if (!authority.ok) return authority;
    const check = taskByteScopeCheck();
    const checks: readonly [AuthorizedTaskCompletionCheck, ...AuthorizedTaskCompletionCheck[]] = Object.freeze([check]);
    return success(freeze({
      schemaVersion: 1,
      kind: "task-completion-suite-authority",
      implementationAuthorityDigest: authority.value.authorityDigest,
      checks,
      suiteDigest: taskSuiteDigest(checks),
    }));
  });
}

export function parseTaskCompletionSuiteAuthority(raw: unknown): Parsed<TaskCompletionSuiteAuthority> {
  return total(() => {
    const record = exactRecord(raw, [
      "schemaVersion", "kind", "implementationAuthorityDigest", "checks", "suiteDigest",
    ], "taskSuiteAuthority");
    if (!record.ok) return record;
    const authorityDigestValue = parseImplementationAuthorityDigest(
      record.value.implementationAuthorityDigest,
      "taskSuiteAuthority.implementationAuthorityDigest",
    );
    const checks = parseTaskRoster(record.value.checks, "taskSuiteAuthority.checks");
    const suiteDigestValue = parseTaskSuiteDigest(record.value.suiteDigest, "taskSuiteAuthority.suiteDigest");
    const errors = [authorityDigestValue, checks, suiteDigestValue]
      .flatMap((result) => result.ok ? [] : result.error.errors);
    if (record.value.schemaVersion !== 1 || record.value.kind !== "task-completion-suite-authority") {
      errors.push("taskSuiteAuthority must have schemaVersion 1 and kind task-completion-suite-authority");
    }
    if (errors.length > 0 || !authorityDigestValue.ok || !checks.ok || !suiteDigestValue.ok) return failure(errors);
    const expected = taskSuiteDigest(checks.value);
    return expected === suiteDigestValue.value
      ? success(freeze({
          schemaVersion: 1,
          kind: "task-completion-suite-authority",
          implementationAuthorityDigest: authorityDigestValue.value,
          checks: checks.value,
          suiteDigest: expected,
        }))
      : failure(["taskSuiteAuthority.suiteDigest does not match its canonical roster"]);
  });
}

export type TaskByteScopeOutcome =
  | Readonly<{ kind: "accepted"; changedPaths: readonly ReviewPath[] }>
  | Readonly<{ kind: "out-of-scope-writes"; paths: readonly [ReviewPath, ...ReviewPath[]] }>
  | Readonly<{ kind: "observation-unavailable"; reason: string }>;

export type TaskCompletionCheckResult = Readonly<{
  checkId: CompletionCheckId;
  scope: "task" | "wave";
  outcome: TaskByteScopeOutcome;
}>;

export type TaskCompletionSuiteResult = Readonly<{
  schemaVersion: 1;
  kind: "task-completion-suite-result";
  implementationAuthorityDigest: ImplementationAuthorityDigest;
  suiteDigest: TaskCompletionSuiteDigest;
  checks: readonly TaskCompletionCheckResult[];
}>;

function parseCanonicalPaths(raw: unknown, path: string, nonEmpty: boolean): Parsed<readonly ReviewPath[]> {
  const array = parseDenseArray(raw, path);
  if (!array.ok) return array;
  if (nonEmpty && array.value.length === 0) return failure([`${path} must be non-empty`]);
  const paths = collect<ReviewPath>(array.value, path, (value, valuePath) => {
    const parsed = parseReviewPath(value, valuePath);
    return parsed.ok ? success(parsed.value) : failure(parsed.errors);
  });
  if (!paths.ok) return paths;
  const sorted = [...paths.value].sort(compareStrings);
  if (new Set(sorted).size !== sorted.length) return failure([`${path} must contain unique paths`]);
  return success(freezeArray(sorted));
}

function parseTaskCheckOutcome(raw: unknown, path: string): Parsed<TaskByteScopeOutcome> {
  if (!isRecord(raw)) return failure([`${path} must be a plain object`]);
  if (raw.kind === "accepted") {
    const record = exactRecord(raw, ["kind", "changedPaths"], path);
    if (!record.ok) return record;
    const paths = parseCanonicalPaths(record.value.changedPaths, `${path}.changedPaths`, false);
    return paths.ok ? success(freeze({ kind: "accepted", changedPaths: paths.value })) : paths;
  }
  if (raw.kind === "out-of-scope-writes") {
    const record = exactRecord(raw, ["kind", "paths"], path);
    if (!record.ok) return record;
    const paths = parseCanonicalPaths(record.value.paths, `${path}.paths`, true);
    if (!paths.ok) return paths;
    const first = paths.value[0];
    const nonEmptyPaths: readonly [ReviewPath, ...ReviewPath[]] | null = first === undefined
      ? null
      : Object.freeze([first, ...paths.value.slice(1)]);
    return nonEmptyPaths === null
      ? failure([`${path}.paths must be non-empty`])
      : success(freeze({ kind: "out-of-scope-writes", paths: nonEmptyPaths }));
  }
  if (raw.kind === "observation-unavailable") {
    const record = exactRecord(raw, ["kind", "reason"], path);
    if (!record.ok) return record;
    const reason = parseBoundedReason(record.value.reason, `${path}.reason`);
    return reason.ok ? success(freeze({ kind: "observation-unavailable", reason: reason.value })) : reason;
  }
  return failure([`${path}.kind must be accepted, out-of-scope-writes, or observation-unavailable`]);
}

function parseTaskCheckResult(raw: unknown, path: string): Parsed<TaskCompletionCheckResult> {
  const record = exactRecord(raw, ["checkId", "scope", "outcome"], path);
  if (!record.ok) return record;
  const checkId = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const outcome = parseTaskCheckOutcome(record.value.outcome, `${path}.outcome`);
  const errors = [checkId, outcome].flatMap((result) => result.ok ? [] : result.error.errors);
  if (record.value.scope !== "task" && record.value.scope !== "wave") {
    errors.push(`${path}.scope must be task or wave`);
  }
  return errors.length === 0 && checkId.ok && outcome.ok
    ? success(freeze({
        checkId: checkId.value,
        scope: record.value.scope as "task" | "wave",
        outcome: outcome.value,
      }))
    : failure(errors);
}

/** Mint one exact Task-suite result from engine-owned authority and outcome. */
export function createTaskCompletionSuiteResult(
  rawAuthority: unknown,
  rawOutcome: unknown,
): Parsed<TaskCompletionSuiteResult> {
  return total(() => {
    const authority = createTaskCompletionSuiteAuthority(rawAuthority);
    if (!authority.ok) return authority;
    const outcome = parseTaskCheckOutcome(rawOutcome, "taskSuiteOutcome");
    if (!outcome.ok) return outcome;
    return success(freeze({
      schemaVersion: 1,
      kind: "task-completion-suite-result",
      implementationAuthorityDigest: authority.value.implementationAuthorityDigest,
      suiteDigest: authority.value.suiteDigest,
      checks: Object.freeze([freeze({
        checkId: authority.value.checks[0].checkId,
        scope: "task",
        outcome: outcome.value,
      })]),
    }));
  });
}

export function parseTaskCompletionSuiteResult(raw: unknown): Parsed<TaskCompletionSuiteResult> {
  return total(() => {
    const record = exactRecord(raw, [
      "schemaVersion", "kind", "implementationAuthorityDigest", "suiteDigest", "checks",
    ], "taskSuiteResult");
    if (!record.ok) return record;
    const authorityDigestValue = parseImplementationAuthorityDigest(
      record.value.implementationAuthorityDigest,
      "taskSuiteResult.implementationAuthorityDigest",
    );
    const suiteDigestValue = parseTaskSuiteDigest(record.value.suiteDigest, "taskSuiteResult.suiteDigest");
    const rawChecks = parseDenseArray(record.value.checks, "taskSuiteResult.checks");
    const checks = rawChecks.ok
      ? collect(rawChecks.value, "taskSuiteResult.checks", parseTaskCheckResult)
      : rawChecks;
    const errors = [authorityDigestValue, suiteDigestValue, checks]
      .flatMap((result) => result.ok ? [] : result.error.errors);
    if (record.value.schemaVersion !== 1 || record.value.kind !== "task-completion-suite-result") {
      errors.push("taskSuiteResult must have schemaVersion 1 and kind task-completion-suite-result");
    }
    return errors.length === 0 && authorityDigestValue.ok && suiteDigestValue.ok && checks.ok
      ? success(freeze({
          schemaVersion: 1,
          kind: "task-completion-suite-result",
          implementationAuthorityDigest: authorityDigestValue.value,
          suiteDigest: suiteDigestValue.value,
          checks: freezeArray([...checks.value].sort((left, right) => compareStrings(left.checkId, right.checkId))),
        }))
      : failure(errors);
  });
}

export type TaskSuiteAuthorityFailure =
  | Readonly<{ kind: "invalid-task-suite-result"; errors: readonly [string, ...string[]] }>
  | Readonly<{ kind: "stale-task-suite-result"; fields: readonly ["implementationAuthorityDigest" | "suiteDigest", ...( "implementationAuthorityDigest" | "suiteDigest")[]] }>
  | Readonly<{ kind: "missing-task-check-results"; checkIds: readonly [CompletionCheckId, ...CompletionCheckId[]] }>
  | Readonly<{ kind: "surplus-task-check-results"; checkIds: readonly [CompletionCheckId, ...CompletionCheckId[]] }>
  | Readonly<{ kind: "duplicate-task-check-results"; checkIds: readonly [CompletionCheckId, ...CompletionCheckId[]] }>
  | Readonly<{ kind: "wrong-task-check-scope"; checkId: CompletionCheckId; actualScope: "task" | "wave" }>;

export type TaskSuiteSemanticFailure = Readonly<{
  kind: "task-byte-scope-violation";
  checkId: CompletionCheckId;
  paths: readonly [ReviewPath, ...ReviewPath[]];
}>;

export type TaskSuiteInfrastructureFailure = Readonly<{
  kind: "task-byte-scope-unavailable";
  checkId: CompletionCheckId;
  reason: string;
}>;

export type TaskCompletionSuiteEvaluation =
  | Readonly<{ kind: "accepted"; result: TaskCompletionSuiteResult }>
  | Readonly<{
      kind: "rejected";
      authorityFailures: readonly TaskSuiteAuthorityFailure[];
      semanticFailures: readonly TaskSuiteSemanticFailure[];
      infrastructureFailures: readonly TaskSuiteInfrastructureFailure[];
    }>;

function nonEmptyValues<T>(values: readonly T[]): readonly [T, ...T[]] | null {
  const first = values[0];
  return first === undefined ? null : Object.freeze([first, ...values.slice(1)]);
}

/** Evaluate exact Task result coverage without running or authorizing commands. */
export function evaluateTaskCompletionSuite(
  rawAuthority: unknown,
  rawResult: unknown,
): TaskCompletionSuiteEvaluation {
  const authority = parseTaskCompletionSuiteAuthority(rawAuthority);
  const result = parseTaskCompletionSuiteResult(rawResult);
  if (!authority.ok || !result.ok) {
    const errors = [
      ...(authority.ok ? [] : authority.error.errors),
      ...(result.ok ? [] : result.error.errors),
    ];
    const nonEmptyErrors = nonEmptyValues(errors) ?? ["Task suite input is invalid"];
    return freeze({
      kind: "rejected",
      authorityFailures: Object.freeze([freeze({ kind: "invalid-task-suite-result", errors: nonEmptyErrors })]),
      semanticFailures: Object.freeze([]),
      infrastructureFailures: Object.freeze([]),
    });
  }
  const staleFields = (["implementationAuthorityDigest", "suiteDigest"] as const)
    .filter((field) => authority.value[field] !== result.value[field]);
  const stale = nonEmptyValues(staleFields);
  if (stale !== null) {
    return freeze({
      kind: "rejected",
      authorityFailures: Object.freeze([freeze({ kind: "stale-task-suite-result", fields: stale })]),
      semanticFailures: Object.freeze([]),
      infrastructureFailures: Object.freeze([]),
    });
  }

  const expectedIds = new Set(authority.value.checks.map((check) => check.checkId));
  const counts = new Map<CompletionCheckId, number>();
  result.value.checks.forEach((check) => counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1));
  const missing = authority.value.checks.filter((check) => !counts.has(check.checkId)).map((check) => check.checkId);
  const surplus = [...counts.keys()].filter((id) => !expectedIds.has(id)).sort(compareStrings);
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(compareStrings);
  const authorityFailures: TaskSuiteAuthorityFailure[] = [];
  const missingValues = nonEmptyValues(missing);
  const surplusValues = nonEmptyValues(surplus);
  const duplicateValues = nonEmptyValues(duplicate);
  if (missingValues !== null) authorityFailures.push(freeze({ kind: "missing-task-check-results", checkIds: missingValues }));
  if (surplusValues !== null) authorityFailures.push(freeze({ kind: "surplus-task-check-results", checkIds: surplusValues }));
  if (duplicateValues !== null) authorityFailures.push(freeze({ kind: "duplicate-task-check-results", checkIds: duplicateValues }));
  result.value.checks.forEach((check) => {
    if (expectedIds.has(check.checkId) && check.scope !== "task") {
      authorityFailures.push(freeze({ kind: "wrong-task-check-scope", checkId: check.checkId, actualScope: check.scope }));
    }
  });

  const semanticFailures: TaskSuiteSemanticFailure[] = [];
  const infrastructureFailures: TaskSuiteInfrastructureFailure[] = [];
  if (authorityFailures.length === 0) {
    result.value.checks.forEach((check) => {
      if (check.outcome.kind === "out-of-scope-writes") {
        semanticFailures.push(freeze({ kind: "task-byte-scope-violation", checkId: check.checkId, paths: check.outcome.paths }));
      } else if (check.outcome.kind === "observation-unavailable") {
        infrastructureFailures.push(freeze({
          kind: "task-byte-scope-unavailable",
          checkId: check.checkId,
          reason: check.outcome.reason,
        }));
      }
    });
  }
  return authorityFailures.length === 0 && semanticFailures.length === 0 && infrastructureFailures.length === 0
    ? freeze({ kind: "accepted", result: result.value })
    : freeze({
        kind: "rejected",
        authorityFailures: freezeArray(authorityFailures),
        semanticFailures: freezeArray(semanticFailures),
        infrastructureFailures: freezeArray(infrastructureFailures),
      });
}

export type ImplementationObservation =
  | Readonly<{
      schemaVersion: 1;
      kind: "implementation-observed";
      observedAt: IsoInstant;
      evidence: ObservedProofEvidence;
      proofEvaluationPolicy: ProofEvaluationPolicy;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "implementation-observation-unavailable";
      observedAt: IsoInstant;
      failure: Readonly<{ kind: "observation-unavailable"; message: string }>;
    }>;

function parseObservedImplementation(raw: UnknownRecord): Parsed<ImplementationObservation> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "observedAt", "evidence", "proofEvaluationPolicy",
  ], "implementationObservation");
  if (!record.ok) return record;
  const observedAt = parseIsoInstant(record.value.observedAt, "implementationObservation.observedAt");
  const evidence = parseObservedProofEvidence(record.value.evidence);
  const policy = parseProofEvaluationPolicy(record.value.proofEvaluationPolicy);
  const errors = [
    ...(observedAt.ok ? [] : observedAt.error.errors),
    ...(evidence.ok ? [] : evidence.errors),
    ...(policy.ok ? [] : policy.errors),
  ];
  if (record.value.schemaVersion !== 1) errors.push("implementationObservation.schemaVersion must equal 1");
  return errors.length === 0 && observedAt.ok && evidence.ok && policy.ok
    ? success(freeze({
        schemaVersion: 1,
        kind: "implementation-observed",
        observedAt: observedAt.value,
        evidence: evidence.value,
        proofEvaluationPolicy: policy.value,
      }))
    : failure(errors);
}

function parseUnavailableImplementation(raw: UnknownRecord): Parsed<ImplementationObservation> {
  const record = exactRecord(raw, ["schemaVersion", "kind", "observedAt", "failure"], "implementationObservation");
  if (!record.ok) return record;
  const observedAt = parseIsoInstant(record.value.observedAt, "implementationObservation.observedAt");
  const failureRecord = exactRecord(record.value.failure, ["kind", "message"], "implementationObservation.failure");
  const reason = failureRecord.ok
    ? parseBoundedReason(failureRecord.value.message, "implementationObservation.failure.message")
    : failureRecord;
  const errors = [
    ...(observedAt.ok ? [] : observedAt.error.errors),
    ...(failureRecord.ok ? [] : failureRecord.error.errors),
    ...(reason.ok ? [] : reason.error.errors),
  ];
  if (record.value.schemaVersion !== 1 || record.value.kind !== "implementation-observation-unavailable") {
    errors.push("implementationObservation must have schemaVersion 1 and a recognized kind");
  }
  if (failureRecord.ok && failureRecord.value.kind !== "observation-unavailable") {
    errors.push("implementationObservation.failure.kind must equal observation-unavailable");
  }
  return errors.length === 0 && observedAt.ok && failureRecord.ok && reason.ok
    ? success(freeze({
        schemaVersion: 1,
        kind: "implementation-observation-unavailable",
        observedAt: observedAt.value,
        failure: freeze({ kind: "observation-unavailable", message: reason.value }),
      }))
    : failure(errors);
}

/** Exact parser/smart constructor for normalized Claude/Pi observations. */
export function parseImplementationObservation(raw: unknown): Parsed<ImplementationObservation> {
  return total(() => {
    if (!isRecord(raw)) return failure(["implementationObservation must be a plain object"]);
    return raw.kind === "implementation-observed"
      ? parseObservedImplementation(raw)
      : parseUnavailableImplementation(raw);
  });
}

export type ImplementationSettlementKind =
  | "implemented"
  | "retry-required"
  | "escalation-required"
  | "infrastructure-blocked";

export type ImplementationAttemptSettlementReceipt = Readonly<{
  schemaVersion: 1;
  kind: "implementation-attempt-settlement";
  receiptId: ImplementationSettlementReceiptId;
  taskId: TaskId;
  reservationId: ReservationId;
  authorityDigest: ImplementationAuthorityDigest;
  semanticAttempt: SemanticAttempt;
  observedAt: IsoInstant;
  transition: ImplementationSettlementKind;
  consumesSemanticAttempt: boolean;
  failureKinds: readonly string[];
}>;

type ReceiptBody = Omit<ImplementationAttemptSettlementReceipt, "receiptId">;

function receiptId(body: ReceiptBody): ImplementationSettlementReceiptId {
  // Parser proof site: sha256Hex is guaranteed to emit this exact grammar.
  return sha256Hex(canonicalJson(body)) as ImplementationSettlementReceiptId;
}

function parseFailureKinds(raw: unknown, path: string): Parsed<readonly string[]> {
  const array = parseDenseArray(raw, path);
  if (!array.ok) return array;
  const values: string[] = [];
  const errors: string[] = [];
  array.value.forEach((value, index) => {
    const parsed = parseBoundedReason(value, `${path}[${index}]`);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.error.errors);
  });
  if (errors.length > 0) return failure(errors);
  if (new Set(values).size !== values.length || values.some((value, index) => value !== [...values].sort(compareStrings)[index])) {
    return failure([`${path} must be sorted and unique`]);
  }
  return success(freezeArray(values));
}

function receiptRelationError(body: ReceiptBody): string | null {
  if (body.transition === "implemented") {
    return body.consumesSemanticAttempt || body.failureKinds.length !== 0
      ? "implemented receipt must not consume a semantic attempt or carry failures"
      : null;
  }
  if (body.transition === "infrastructure-blocked") {
    return body.consumesSemanticAttempt || body.failureKinds.length === 0
      ? "infrastructure-blocked receipt must carry failures without consuming a semantic attempt"
      : null;
  }
  if (!body.consumesSemanticAttempt || body.failureKinds.length === 0) {
    return `${body.transition} receipt must carry failures and consume a semantic attempt`;
  }
  if (body.transition === "retry-required" && body.semanticAttempt !== 1) {
    return "retry-required receipt requires semantic attempt 1";
  }
  return body.transition === "escalation-required" && body.semanticAttempt !== 2
    ? "escalation-required receipt requires semantic attempt 2"
    : null;
}

export function parseImplementationAttemptSettlementReceipt(
  raw: unknown,
  path = "settlementReceipt",
): Parsed<ImplementationAttemptSettlementReceipt> {
  return total(() => {
    const record = exactRecord(raw, [
      "schemaVersion", "kind", "receiptId", "taskId", "reservationId", "authorityDigest",
      "semanticAttempt", "observedAt", "transition", "consumesSemanticAttempt", "failureKinds",
    ], path);
    if (!record.ok) return record;
    const parsedReceiptId = parseReceiptId(record.value.receiptId, `${path}.receiptId`);
    const taskId = parseTaskId(record.value.taskId, `${path}.taskId`);
    const reservationId = parseReservationId(record.value.reservationId, `${path}.reservationId`);
    const digestValue = parseImplementationAuthorityDigest(record.value.authorityDigest, `${path}.authorityDigest`);
    const attempt = parseSemanticAttempt(record.value.semanticAttempt, `${path}.semanticAttempt`);
    const observedAt = parseIsoInstant(record.value.observedAt, `${path}.observedAt`);
    const failureKinds = parseFailureKinds(record.value.failureKinds, `${path}.failureKinds`);
    const transitions: readonly ImplementationSettlementKind[] = [
      "implemented", "retry-required", "escalation-required", "infrastructure-blocked",
    ];
    const errors = [parsedReceiptId, taskId, reservationId, digestValue, attempt, observedAt, failureKinds]
      .flatMap((result) => result.ok ? [] : result.error.errors);
    if (record.value.schemaVersion !== 1 || record.value.kind !== "implementation-attempt-settlement") {
      errors.push(`${path} must have schemaVersion 1 and kind implementation-attempt-settlement`);
    }
    if (!transitions.includes(record.value.transition as ImplementationSettlementKind)) {
      errors.push(`${path}.transition is not recognized`);
    }
    if (typeof record.value.consumesSemanticAttempt !== "boolean") {
      errors.push(`${path}.consumesSemanticAttempt must be a boolean`);
    }
    if (errors.length > 0 || !parsedReceiptId.ok || !taskId.ok || !reservationId.ok || !digestValue.ok ||
        !attempt.ok || !observedAt.ok || !failureKinds.ok) return failure(errors);
    const body: ReceiptBody = freeze({
      schemaVersion: 1,
      kind: "implementation-attempt-settlement",
      taskId: taskId.value,
      reservationId: reservationId.value,
      authorityDigest: digestValue.value,
      semanticAttempt: attempt.value,
      observedAt: observedAt.value,
      transition: record.value.transition as ImplementationSettlementKind,
      consumesSemanticAttempt: record.value.consumesSemanticAttempt as boolean,
      failureKinds: failureKinds.value,
    });
    const relationError = receiptRelationError(body);
    if (relationError !== null) return failure([`${path}: ${relationError}`]);
    const expected = receiptId(body);
    return parsedReceiptId.value === expected
      ? success(freeze({ ...body, receiptId: expected }))
      : failure([`${path}.receiptId does not match its canonical receipt`]);
  });
}

/** Exact ordered history parser; receipt identities and reservations are unique. */
export function parseImplementationAttemptHistory(
  raw: unknown,
  path = "implementation_attempt_history",
): Parsed<readonly ImplementationAttemptSettlementReceipt[]> {
  return total(() => {
    const array = parseDenseArray(raw, path);
    if (!array.ok) return array;
    const receipts = collect(array.value, path, parseImplementationAttemptSettlementReceipt);
    if (!receipts.ok) return receipts;
    const receiptIds = receipts.value.map((receipt) => receipt.receiptId);
    if (new Set(receiptIds).size !== receiptIds.length) return failure([`${path} contains duplicate receipt IDs`]);
    const reservations = receipts.value.map((receipt) => receipt.reservationId);
    if (new Set(reservations).size !== reservations.length) return failure([`${path} contains duplicate reservation IDs`]);
    return success(freezeArray(receipts.value));
  });
}

export type SettleableImplementationTask = Readonly<{
  id: string;
  status: "pending" | "implemented" | "completed" | "failed";
  proof?: TaskProof;
  revalidation_required?: true;
  legacy_missing_proof?: true;
  active_implementation_attempt?: ImplementationAttemptAuthority;
  implementation_attempt_history?: readonly ImplementationAttemptSettlementReceipt[];
}>;

export type ImplementationCompletionFailure =
  | Readonly<{ kind: "proof-obligation-failure"; failure: ProofFailure }>
  | TaskSuiteSemanticFailure;

export type ImplementationInfrastructureFailure =
  | TaskSuiteInfrastructureFailure
  | Readonly<{ kind: "implementation-observation-unavailable"; message: string }>;

export type ImplementationCompletionTransition =
  | Readonly<{
      kind: "implemented";
      proof: SatisfiedTaskProof;
      suite: TaskCompletionSuiteResult;
      receipt: ImplementationAttemptSettlementReceipt;
    }>
  | Readonly<{
      kind: "retry-required";
      attempt: 2;
      proof: FailedTaskProof | SatisfiedTaskProof;
      failures: readonly [ImplementationCompletionFailure, ...ImplementationCompletionFailure[]];
      receipt: ImplementationAttemptSettlementReceipt;
    }>
  | Readonly<{
      kind: "escalation-required";
      proof: FailedTaskProof | SatisfiedTaskProof;
      failures: readonly [ImplementationCompletionFailure, ...ImplementationCompletionFailure[]];
      receipt: ImplementationAttemptSettlementReceipt;
    }>
  | Readonly<{
      kind: "infrastructure-blocked";
      failures: readonly [ImplementationInfrastructureFailure, ...ImplementationInfrastructureFailure[]];
      receipt: ImplementationAttemptSettlementReceipt;
    }>
  | Readonly<{ kind: "ignored"; reason: "stale" | "duplicate" | "already-completed" }>;

export type ImplementationCompletionError =
  | Readonly<{ kind: "invalid-task"; errors: readonly [string, ...string[]] }>
  | Readonly<{ kind: "current-authority-mismatch"; message: string }>
  | Readonly<{ kind: "task-suite-authority-failure"; failures: readonly [TaskSuiteAuthorityFailure, ...TaskSuiteAuthorityFailure[]] }>;

export type ImplementationCompletionResult =
  | Readonly<{ ok: true; value: ImplementationCompletionTransition }>
  | Readonly<{ ok: false; error: ImplementationCompletionError }>;

function completionOk(value: ImplementationCompletionTransition): ImplementationCompletionResult {
  return freeze({ ok: true, value });
}

function completionError(error: ImplementationCompletionError): ImplementationCompletionResult {
  return freeze({ ok: false, error });
}

function sameAuthority(left: ImplementationAttemptAuthority, right: ImplementationAttemptAuthority): boolean {
  return left.authorityDigest === right.authorityDigest;
}

function taskErrors(task: SettleableImplementationTask, supplied: ImplementationAttemptAuthority): readonly string[] {
  const errors: string[] = [];
  const id = parseTaskId(task.id);
  if (!id.ok) errors.push(...id.error.errors);
  else if (id.value !== supplied.taskId) errors.push("Task id does not match supplied implementation authority");
  if (task.legacy_missing_proof === true) errors.push("legacy-missing-proof Task cannot receive modern positive authority");
  if (task.status === "pending" && task.proof === undefined) errors.push("pending Task must carry parser-derived Proof");
  if (task.status === "failed" && task.proof?.state !== "failed") errors.push("failed Task must carry failed Proof");
  if ((task.status === "implemented" || task.status === "completed") && task.proof?.state !== "satisfied" &&
      task.legacy_missing_proof !== true) {
    errors.push("implementation-bearing modern Task must carry satisfied Proof");
  }
  if (task.proof !== undefined) {
    const proof = parseTaskProof(task.proof);
    if (!proof.ok) errors.push(...proof.errors);
  }
  return errors;
}

function makeReceipt(
  authority: ImplementationAttemptAuthority,
  observedAt: IsoInstant,
  transition: ImplementationSettlementKind,
  consumesSemanticAttempt: boolean,
  failureKinds: readonly string[],
): ImplementationAttemptSettlementReceipt {
  const body: ReceiptBody = freeze({
    schemaVersion: 1,
    kind: "implementation-attempt-settlement",
    taskId: authority.taskId,
    reservationId: authority.reservationId,
    authorityDigest: authority.authorityDigest,
    semanticAttempt: authority.semanticAttempt,
    observedAt,
    transition,
    consumesSemanticAttempt,
    failureKinds: freezeArray([...new Set(failureKinds)].sort(compareStrings)),
  });
  return freeze({ ...body, receiptId: receiptId(body) });
}

/**
 * Archive a reservation the shell proved abandoned. Reclamation is an
 * infrastructure settlement: it releases no semantic retry budget and carries
 * the exact authority it retired, so a late result cannot collide with its
 * replacement by Task id alone.
 */
export function createReclaimedImplementationAttemptReceipt(
  rawAuthority: unknown,
  rawReclaimedAt: unknown,
): Parsed<ImplementationAttemptSettlementReceipt> {
  return total(() => {
    const authority = parseImplementationAttemptAuthority(rawAuthority);
    const reclaimedAt = parseIsoInstant(rawReclaimedAt, "reclaimedAt");
    const errors = [authority, reclaimedAt].flatMap((result) => result.ok ? [] : result.error.errors);
    return errors.length === 0 && authority.ok && reclaimedAt.ok
      ? success(makeReceipt(
          authority.value,
          reclaimedAt.value,
          "infrastructure-blocked",
          false,
          ["reservation-reclaimed"],
        ))
      : failure(errors);
  });
}

function proofFailureKind(failure: ProofFailure): string {
  return `proof:${failure.kind}`;
}

function semanticTransition(
  authority: ImplementationAttemptAuthority,
  observedAt: IsoInstant,
  proof: FailedTaskProof | SatisfiedTaskProof,
  failures: readonly [ImplementationCompletionFailure, ...ImplementationCompletionFailure[]],
): ImplementationCompletionTransition {
  const failureKinds = failures.map((failure) =>
    failure.kind === "proof-obligation-failure" ? proofFailureKind(failure.failure) : failure.kind);
  if (authority.semanticAttempt === 1) {
    return freeze({
      kind: "retry-required",
      attempt: 2,
      proof,
      failures,
      receipt: makeReceipt(authority, observedAt, "retry-required", true, failureKinds),
    });
  }
  return freeze({
    kind: "escalation-required",
    proof,
    failures,
    receipt: makeReceipt(authority, observedAt, "escalation-required", true, failureKinds),
  });
}

/**
 * Pure Implementation Completion Oracle. The current authority comes from the
 * locked shell; the supplied authority is the harness correlation capability.
 */
export function settleImplementationAttempt(
  task: SettleableImplementationTask,
  rawCurrentAuthority: unknown,
  rawSuppliedAuthority: unknown,
  rawObservation: unknown,
  rawSuite: unknown,
): ImplementationCompletionResult {
  const current = parseImplementationAttemptAuthority(rawCurrentAuthority);
  const supplied = parseImplementationAttemptAuthority(rawSuppliedAuthority);
  const observation = parseImplementationObservation(rawObservation);
  const history = parseImplementationAttemptHistory(task.implementation_attempt_history ?? []);
  const parseErrors = [current, supplied, observation, history].flatMap((result) =>
    result.ok ? [] : result.error.errors);
  if (parseErrors.length > 0 || !current.ok || !supplied.ok || !observation.ok || !history.ok) {
    return completionError({ kind: "invalid-task", errors: nonEmptyValues(parseErrors) ?? ["settlement input is invalid"] });
  }

  const errors = taskErrors(task, supplied.value);
  const nonEmptyErrors = nonEmptyValues(errors);
  if (nonEmptyErrors !== null) return completionError({ kind: "invalid-task", errors: nonEmptyErrors });
  if (history.value.some((receipt) => receipt.authorityDigest === supplied.value.authorityDigest)) {
    return completionOk(freeze({ kind: "ignored", reason: "duplicate" }));
  }
  if (task.status === "completed") {
    return completionOk(freeze({ kind: "ignored", reason: "already-completed" }));
  }
  if (task.active_implementation_attempt === undefined) {
    return completionOk(freeze({ kind: "ignored", reason: "stale" }));
  }
  const active = parseImplementationAttemptAuthority(task.active_implementation_attempt);
  if (!active.ok) return completionError({ kind: "invalid-task", errors: active.error.errors });
  if (!sameAuthority(active.value, current.value)) {
    return completionError({
      kind: "current-authority-mismatch",
      message: "locked Task active authority does not equal the shell-supplied current authority",
    });
  }
  if (!sameAuthority(current.value, supplied.value)) {
    return completionOk(freeze({ kind: "ignored", reason: "stale" }));
  }

  const suiteAuthority = createTaskCompletionSuiteAuthority(current.value);
  if (!suiteAuthority.ok) return completionError({ kind: "invalid-task", errors: suiteAuthority.error.errors });
  const suite = evaluateTaskCompletionSuite(suiteAuthority.value, rawSuite);
  if (suite.kind === "rejected") {
    const authorityFailures = nonEmptyValues(suite.authorityFailures);
    if (authorityFailures !== null) {
      return completionError({ kind: "task-suite-authority-failure", failures: authorityFailures });
    }
  }

  const infrastructureFailures: ImplementationInfrastructureFailure[] = [
    ...(observation.value.kind === "implementation-observation-unavailable"
      ? [freeze({
          kind: "implementation-observation-unavailable" as const,
          message: observation.value.failure.message,
        })]
      : []),
    ...(suite.kind === "rejected" ? suite.infrastructureFailures : []),
  ];
  const nonEmptyInfrastructure = nonEmptyValues(infrastructureFailures);
  if (nonEmptyInfrastructure !== null) {
    const failureKinds = nonEmptyInfrastructure.map((failure) => failure.kind);
    return completionOk(freeze({
      kind: "infrastructure-blocked",
      failures: nonEmptyInfrastructure,
      receipt: makeReceipt(current.value, observation.value.observedAt, "infrastructure-blocked", false, failureKinds),
    }));
  }

  if (observation.value.kind !== "implementation-observed") {
    return completionError({ kind: "invalid-task", errors: ["observed evidence is unavailable without an infrastructure failure"] });
  }
  const authoredProof = task.proof;
  if (authoredProof === undefined) {
    return completionError({ kind: "invalid-task", errors: ["settleable Task has no authored Proof"] });
  }
  const proof = evaluateProofObligations(
    authoredProof.obligations,
    observation.value.evidence,
    observation.value.proofEvaluationPolicy,
  );
  const semanticFailures: ImplementationCompletionFailure[] = [
    ...(proof.state === "failed"
      ? proof.failures.map((proofFailure) => freeze({ kind: "proof-obligation-failure" as const, failure: proofFailure }))
      : []),
    ...(suite.kind === "rejected" ? suite.semanticFailures : []),
  ];
  const nonEmptySemantic = nonEmptyValues(semanticFailures);
  if (nonEmptySemantic !== null) {
    return completionOk(semanticTransition(current.value, observation.value.observedAt, proof, nonEmptySemantic));
  }
  if (proof.state !== "satisfied" || suite.kind !== "accepted") {
    return completionError({ kind: "invalid-task", errors: ["implementation success lacked satisfied Proof or accepted Task suite"] });
  }
  return completionOk(freeze({
    kind: "implemented",
    proof,
    suite: suite.result,
    receipt: makeReceipt(current.value, observation.value.observedAt, "implemented", false, []),
  }));
}
