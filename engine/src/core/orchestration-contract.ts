import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  lowerModelProfile,
  parseAgentName,
  parseLlmProfileId,
  resolveAgentPolicy,
  resolveModelProfile,
  type ClaudeCodeBinding,
  type LlmProfile,
  type LlmProfileId,
  type LoomAgentName,
  type PiBinding,
} from "./model-profiles";
import { parseReviewPath } from "./review-packet";
import type { RepositoryPath } from "./repository-path";

export type DomainResult<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 4_096;
const DIAGNOSTIC_TRUNCATION_MARKER = "…[truncated]";

function boundDiagnosticMessage(message: string): string {
  return message.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - DIAGNOSTIC_TRUNCATION_MARKER.length)}${DIAGNOSTIC_TRUNCATION_MARKER}`;
}

/**
 * Constructs a frozen canonical data record without an Object.prototype chain.
 * Own enumerable fields and symbols retain their descriptors, so discriminants,
 * Object.keys, spread, and JSON serialization behave like ordinary records.
 * Every own string `message` field is deterministically bounded at construction.
 */
export function canonicalRecord<const T extends object>(fields: T): Readonly<T> {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(fields);
  const message = descriptors["message"];
  if (message !== undefined && "value" in message && typeof message.value === "string") {
    descriptors["message"] = { ...message, value: boundDiagnosticMessage(message.value) };
  }
  return Object.freeze(Object.create(null, descriptors) as T);
}

type StructuralPairs = Map<object, Set<object>>;

function hasNeutralRecordPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Records a left/right pair so cyclic structures terminate instead of recursing forever. */
function pairAlreadyCompared(left: object, right: object, seen: StructuralPairs): boolean {
  const partners = seen.get(left);
  if (partners === undefined) {
    seen.set(left, new Set([right]));
    return false;
  }
  if (partners.has(right)) return true;
  partners.add(right);
  return false;
}

/** Consumes the first structurally matching candidate, so sizes compare as multisets. */
function matchOnce<T>(candidates: T[], matches: (candidate: T) => boolean): boolean {
  const index = candidates.findIndex(matches);
  if (index === -1) return false;
  candidates.splice(index, 1);
  return true;
}

function mapsEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  const unmatched = [...right.entries()];
  for (const [key, value] of left) {
    const matched = matchOnce(unmatched, ([candidateKey, candidateValue]) =>
      structurallyEqual(key, candidateKey, seen) && structurallyEqual(value, candidateValue, seen));
    if (!matched) return false;
  }
  return true;
}

function setsEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
  const unmatched = [...right];
  for (const entry of left) {
    if (!matchOnce(unmatched, (candidate) => structurallyEqual(entry, candidate, seen))) return false;
  }
  return true;
}

function recordsEqual(left: object, right: object, seen: StructuralPairs): boolean {
  const leftNeutral = hasNeutralRecordPrototype(left);
  if (leftNeutral !== hasNeutralRecordPrototype(right)) return false;
  if (!leftNeutral && Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    structurallyEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      seen,
    ));
}

function structurallyEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (pairAlreadyCompared(left, right, seen)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => structurallyEqual(entry, right[index], seen));
  }
  if (left instanceof Map || right instanceof Map) return mapsEqual(left, right, seen);
  if (left instanceof Set || right instanceof Set) return setsEqual(left, right, seen);
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return left instanceof RegExp && right instanceof RegExp &&
      left.source === right.source && left.flags === right.flags;
  }
  return recordsEqual(left, right, seen);
}

/**
 * Structural equality that stays exact on values while ignoring the single
 * prototype distinction `canonicalRecord` introduces: a canonical record (null
 * prototype) equals the plain object a JSON round trip produces. Every other
 * prototype must match exactly, so a Map, Set, Date, or class instance never
 * equals a plain record carrying the same fields, and an own key whose value is
 * `undefined` stays distinct from an absent key — a persisted document can
 * therefore never widen its authority by round-tripping through JSON.
 */
export function canonicalStructuralEquals(left: unknown, right: unknown): boolean {
  return structurallyEqual(left, right, new Map());
}

const success = <T, E = never>(value: T): DomainResult<T, E> => canonicalRecord({ ok: true, value });
const failure = <T = never, E = never>(error: E): DomainResult<T, E> =>
  canonicalRecord({ ok: false, error });

export type NonEmpty<T> = readonly [T, ...T[]];
export type SemanticAttempt = 1 | 2;

declare const RUN_ID: unique symbol;
declare const REQUEST_ID: unique symbol;
declare const SLOT_ID: unique symbol;
declare const CONTEXT_DIGEST: unique symbol;
declare const ARTIFACT_DIGEST: unique symbol;
declare const EFFECT_ID: unique symbol;
declare const ARTIFACT_BYTE_LENGTH: unique symbol;

export type OrchestrationRunId = string & { readonly [RUN_ID]: true };
export type RequestId = string & { readonly [REQUEST_ID]: true };
export type SlotId = string & { readonly [SLOT_ID]: true };
export type ContextDigest = string & { readonly [CONTEXT_DIGEST]: true };
export type ArtifactDigest = string & { readonly [ARTIFACT_DIGEST]: true };
export type EffectId = string & { readonly [EFFECT_ID]: true };
export type ArtifactByteLength = number & { readonly [ARTIFACT_BYTE_LENGTH]: true };

export type AuthorityIdentityKind =
  | "orchestration-run-id"
  | "request-id"
  | "slot-id"
  | "effect-id"
  | "context-digest"
  | "artifact-digest";

export type IdentityParseError = Readonly<{
  kind: "invalid-authority-identity";
  identity: AuthorityIdentityKind;
  received: string;
  message: string;
}>;

const SAFE_AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function describeUnknown(raw: unknown): string {
  if (raw === null) return "null";
  switch (typeof raw) {
    case "string": return boundDiagnosticMessage(`"${raw}"`);
    case "number": return `${raw}`;
    case "bigint": return `${raw}n`;
    case "boolean": return raw ? "true" : "false";
    case "undefined": return "undefined";
    case "symbol": return "[symbol]";
    case "function": return "[function]";
    case "object": return "[object]";
    default: return "[unknown]";
  }
}

function parseAuthorityId<T extends string>(
  raw: unknown,
  identity: AuthorityIdentityKind,
  pattern: RegExp,
  format: string,
): DomainResult<T, IdentityParseError> {
  return typeof raw === "string" && pattern.test(raw)
    ? success(raw as T)
    : failure(canonicalRecord({
        kind: "invalid-authority-identity",
        identity,
        received: describeUnknown(raw),
        message: `${identity} must be ${format}; received ${describeUnknown(raw)}`,
      }));
}

export const parseOrchestrationRunId = (raw: unknown): DomainResult<OrchestrationRunId, IdentityParseError> =>
  parseAuthorityId(raw, "orchestration-run-id", SAFE_AUTHORITY_ID, "a non-empty canonical authority id");
export const parseRequestId = (raw: unknown): DomainResult<RequestId, IdentityParseError> =>
  parseAuthorityId(raw, "request-id", SAFE_AUTHORITY_ID, "a non-empty canonical authority id");
export const parseSlotId = (raw: unknown): DomainResult<SlotId, IdentityParseError> =>
  parseAuthorityId(raw, "slot-id", SAFE_AUTHORITY_ID, "a non-empty canonical authority id");
export const parseEffectId = (raw: unknown): DomainResult<EffectId, IdentityParseError> =>
  parseAuthorityId(raw, "effect-id", SAFE_AUTHORITY_ID, "a non-empty canonical authority id");
export const parseContextDigest = (raw: unknown): DomainResult<ContextDigest, IdentityParseError> =>
  parseAuthorityId(raw, "context-digest", SHA256_HEX, "a lowercase SHA-256 digest");
export const parseArtifactDigest = (raw: unknown): DomainResult<ArtifactDigest, IdentityParseError> =>
  parseAuthorityId(raw, "artifact-digest", SHA256_HEX, "a lowercase SHA-256 digest");

export type ArtifactByteLengthError = Readonly<{
  kind: "invalid-artifact-byte-length";
  message: string;
}>;

export function parseArtifactByteLength(
  raw: unknown,
): DomainResult<ArtifactByteLength, ArtifactByteLengthError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? success(raw as ArtifactByteLength)
    : failure(canonicalRecord({
        kind: "invalid-artifact-byte-length",
        message: `artifact byteLength must be a non-negative safe integer; received ${describeUnknown(raw)}`,
      }));
}

export const MAX_DENSE_DATA_ARRAY_LENGTH = 1_048_576;
export const MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH = 65_536;

export type RawTranscriptBytesError = Readonly<{
  kind: "invalid-raw-transcript-bytes";
  reason: DataBoundaryReason | "invalid-byte-value";
  index: number | null;
  message: string;
}>;

export type DataBoundaryReason =
  | "not-object"
  | "wrong-prototype"
  | "unknown-field"
  | "symbol-field"
  | "accessor-field"
  | "non-enumerable-field"
  | "not-array"
  | "invalid-array-length"
  | "sparse-array"
  | "mutated-during-read"
  | "unsafe-inspection";

type DataBoundaryError = Readonly<{
  field: string | null;
  index: number | null;
  reason: DataBoundaryReason;
  message: string;
}>;

function dataBoundaryFailure<T>(
  reason: DataBoundaryReason,
  message: string,
  field: string | null = null,
  index: number | null = null,
): DomainResult<T, DataBoundaryError> {
  return failure(canonicalRecord({ field, index, reason, message }));
}

function sameDataDescriptor(
  left: PropertyDescriptor,
  right: PropertyDescriptor | undefined,
): boolean {
  return right !== undefined && "value" in left && "value" in right &&
    Object.is(left.value, right.value) && left.enumerable === right.enumerable &&
    left.configurable === right.configurable && left.writable === right.writable;
}

/** A total, deterministically bounded description of an arbitrary thrown value. */
function describeThrownCause(cause: unknown): string {
  const primitiveDescription = (value: unknown): string | null => {
    if (value === null || typeof value !== "object") return describeUnknown(value);
    return null;
  };
  try {
    const primitive = primitiveDescription(cause);
    if (primitive !== null) return primitive;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "message");
      return descriptor !== undefined && "value" in descriptor &&
        typeof descriptor.value === "string" && descriptor.value.length > 0
        ? boundDiagnosticMessage(descriptor.value)
        : describeUnknown(cause);
    } catch (inspectionCause) {
      const inspectionPrimitive = primitiveDescription(inspectionCause);
      if (inspectionPrimitive !== null) {
        return boundDiagnosticMessage(`[uninspectable thrown cause; inspection threw ${inspectionPrimitive}]`);
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(inspectionCause, "message");
        const detail = descriptor !== undefined && "value" in descriptor &&
          typeof descriptor.value === "string" && descriptor.value.length > 0
          ? boundDiagnosticMessage(descriptor.value)
          : describeUnknown(inspectionCause);
        return boundDiagnosticMessage(`[uninspectable thrown cause; inspection threw ${detail}]`);
      } catch {
        return "[uninspectable thrown cause; inspection cause was also uninspectable]";
      }
    }
  } catch {
    return "[uninspectable thrown cause]";
  }
}

const causedMessage = (message: string, cause: unknown): string =>
  boundDiagnosticMessage(`${message}: ${describeThrownCause(cause)}`);

/**
 * Takes a stable snapshot of an exact plain record using own data descriptors only.
 * No caller getter or ordinary property read is performed.
 */
function readExactDataRecord(
  raw: unknown,
  allowed: readonly string[],
  label: string,
): DomainResult<Readonly<Record<string, unknown>>, DataBoundaryError> {
  if (typeof raw !== "object" || raw === null) {
    return dataBoundaryFailure("not-object", `${label} must be an object`);
  }
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return dataBoundaryFailure("wrong-prototype", `${label} must be a plain own-data object`);
    }
    const keys = Reflect.ownKeys(raw);
    const symbol = keys.find((key) => typeof key === "symbol");
    if (symbol !== undefined) {
      return dataBoundaryFailure("symbol-field", `${label} contains unapproved symbol field(s)`, "[symbol]");
    }
    const stringKeys = keys as string[];
    const unknown = stringKeys.filter((key) => !allowed.includes(key)).sort();
    if (unknown.length > 0) {
      return dataBoundaryFailure(
        "unknown-field",
        `${label} contains unknown field(s): ${unknown.join(", ")}`,
        unknown[0]!,
      );
    }

    const descriptors = new Map<string, PropertyDescriptor>();
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return dataBoundaryFailure(
          "accessor-field",
          `${label}.${key} must be an own data field, not an accessor`,
          key,
        );
      }
      if (!descriptor.enumerable) {
        return dataBoundaryFailure(
          "non-enumerable-field",
          `${label}.${key} must be an enumerable own data field`,
          key,
        );
      }
      descriptors.set(key, descriptor);
      Object.defineProperty(values, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }

    const finalKeys = Reflect.ownKeys(raw);
    if (
      Object.getPrototypeOf(raw) !== prototype || finalKeys.length !== keys.length ||
      finalKeys.some((key, index) => key !== keys[index]) ||
      stringKeys.some((key) => !sameDataDescriptor(descriptors.get(key)!, Object.getOwnPropertyDescriptor(raw, key)))
    ) {
      return dataBoundaryFailure("mutated-during-read", `${label} changed while it was being inspected`);
    }
    return success(Object.freeze(values));
  } catch (cause) {
    return dataBoundaryFailure(
      "unsafe-inspection",
      causedMessage(`${label} could not be safely inspected`, cause),
    );
  }
}

/**
 * Takes a stable, dense snapshot without evaluating array element accessors.
 * The finite policy maximum is checked before Reflect.ownKeys or any allocation
 * proportional to caller-controlled length.
 */
function readDenseDataArray(
  raw: unknown,
  label: string,
  maximumLength = MAX_DENSE_DATA_ARRAY_LENGTH,
): DomainResult<readonly unknown[], DataBoundaryError> {
  if (typeof raw !== "object" || raw === null) {
    return dataBoundaryFailure("not-array", `${label} must be an array`);
  }
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
      return dataBoundaryFailure("not-array", `${label} must be a plain array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
    if (
      lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 || lengthDescriptor.enumerable || lengthDescriptor.configurable
    ) {
      return dataBoundaryFailure("invalid-array-length", `${label} has an invalid own data length`, "length");
    }
    const length = lengthDescriptor.value;
    if (length > maximumLength) {
      return dataBoundaryFailure(
        "invalid-array-length",
        `${label} length ${length} exceeds the domain maximum ${maximumLength}`,
        "length",
      );
    }

    const keys = Reflect.ownKeys(raw);
    const symbol = keys.find((key) => typeof key === "symbol");
    if (symbol !== undefined) {
      return dataBoundaryFailure("symbol-field", `${label} contains unapproved symbol field(s)`, "[symbol]");
    }
    for (let index = 0; index < length; index++) {
      const actual = keys[index];
      const expected = String(index);
      if (actual !== expected) {
        return dataBoundaryFailure(
          "sparse-array",
          `${label} has a hole at index ${index}`,
          expected,
          index,
        );
      }
    }
    if (keys[length] !== "length") {
      const unexpected = keys[length];
      const field = typeof unexpected === "string" ? unexpected : null;
      return dataBoundaryFailure(
        "sparse-array",
        field === null
          ? `${label} must contain its own length field`
          : `${label} contains unexpected array field ${field}`,
        field,
      );
    }
    if (keys.length !== length + 1) {
      const unexpected = keys[length + 1];
      const field = typeof unexpected === "string" ? unexpected : null;
      return dataBoundaryFailure(
        "sparse-array",
        field === null
          ? `${label} must be dense and contain no extra fields`
          : `${label} contains unexpected array field ${field}`,
        field,
      );
    }

    const descriptors: PropertyDescriptor[] = [];
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return dataBoundaryFailure(
          "accessor-field",
          `${label}[${index}] must be an own data field, not an accessor`,
          key,
          index,
        );
      }
      if (!descriptor.enumerable) {
        return dataBoundaryFailure(
          "non-enumerable-field",
          `${label}[${index}] must be an enumerable own data field`,
          key,
          index,
        );
      }
      descriptors.push(descriptor);
      values.push(descriptor.value);
    }

    const finalKeys = Reflect.ownKeys(raw);
    const finalLength = Object.getOwnPropertyDescriptor(raw, "length");
    if (
      !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
      finalKeys.length !== keys.length || finalKeys.some((key, index) => key !== keys[index]) ||
      !sameDataDescriptor(lengthDescriptor, finalLength) ||
      descriptors.some((descriptor, index) =>
        !sameDataDescriptor(descriptor, Object.getOwnPropertyDescriptor(raw, String(index)))
      )
    ) {
      return dataBoundaryFailure("mutated-during-read", `${label} changed while it was being inspected`);
    }
    return success(Object.freeze(values));
  } catch (cause) {
    return dataBoundaryFailure(
      "unsafe-inspection",
      causedMessage(`${label} could not be safely inspected`, cause),
    );
  }
}

function parseRawTranscriptBytes(
  raw: unknown,
): DomainResult<readonly number[], RawTranscriptBytesError> {
  const snapshot = readDenseDataArray(raw, "raw transcript bytes");
  if (!snapshot.ok) {
    return failure(canonicalRecord({
      kind: "invalid-raw-transcript-bytes",
      reason: snapshot.error.reason,
      index: snapshot.error.index,
      message: snapshot.error.message,
    }));
  }
  for (let index = 0; index < snapshot.value.length; index++) {
    const value = snapshot.value[index];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      return failure(canonicalRecord({
        kind: "invalid-raw-transcript-bytes",
        reason: "invalid-byte-value",
        index,
        message: `raw transcript byte at index ${index} must be an integer from 0 through 255`,
      }));
    }
  }
  return success(snapshot.value as readonly number[]);
}

function digestCanonicalBytes(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

export function digestRawTranscriptBytes(
  raw: unknown,
): DomainResult<ArtifactDigest, RawTranscriptBytesError> {
  const bytes = parseRawTranscriptBytes(raw);
  return bytes.ok ? success(digestCanonicalBytes(bytes.value)) : bytes;
}

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export type FixedArtifactSlot = Readonly<{
  kind: "fixed-artifact-slot";
  path: string;
}>;

export type FixedArtifactSlotError = Readonly<{
  kind: "invalid-fixed-artifact-slot";
  message: string;
}>;

export function parseFixedArtifactSlot(raw: unknown): DomainResult<FixedArtifactSlot, FixedArtifactSlotError> {
  let path: unknown = raw;
  if (typeof raw !== "string") {
    const record = readExactDataRecord(raw, ["kind", "path"], "fixed artifact slot");
    if (!record.ok) {
      return failure(canonicalRecord({ kind: "invalid-fixed-artifact-slot", message: record.error.message }));
    }
    path = record.value.kind === "fixed-artifact-slot" ? record.value.path : undefined;
  }
  const parsed = parseReviewPath(path, "fixed artifact slot path");
  return parsed.ok
    ? success(canonicalRecord({ kind: "fixed-artifact-slot", path: parsed.value }))
    : failure(canonicalRecord({ kind: "invalid-fixed-artifact-slot", message: parsed.errors.join("; ") }));
}

export const ORCHESTRATION_PROGRAMS = [
  "architecture-panel",
  "refutation-panel",
  "wave-gate",
  "standalone-review",
] as const;
export type OrchestrationProgram = (typeof ORCHESTRATION_PROGRAMS)[number];

export type ExactHarnessBinding = Readonly<{
  pi: PiBinding;
  claude: ClaudeCodeBinding;
}>;

export const AGENT_REQUIRED_SKILLS = canonicalRecord({
  "adr-writer-agent": null,
  "arch-designer-agent": "architecture-tech-lead",
  "arch-interviewer-agent": null,
  "architecture-agent": "architecture-tech-lead",
  "architecture-tech-lead": null,
  "arch-judge-agent": null,
  "brainstorm-agent": "brainstorming",
  "clarify-agent": "clarify",
  "code-implementer-agent": "code-implementer",
  "code-reviewer": null,
  "code-simplifier": null,
  "comment-analyzer": null,
  "decompose-agent": null,
  "deepen-agent": "deepen",
  "frontend-agent": "nextjs-frontend-design",
  "grill-agent": "grill",
  "java-test-agent": "java-test-engineer",
  "plan-alignment-agent": null,
  "pr-test-analyzer": null,
  "review-verifier-agent": null,
  "security-agent": "security-expert",
  "silent-failure-hunter": null,
  "skill-content-reviewer": null,
  "spec-check-invoker": "spec-check",
  "specify-agent": "specify",
  "test-engineer": null,
  "ts-test-agent": "ts-test-engineer",
  "type-design-analyzer": null,
} satisfies Readonly<Record<LoomAgentName, string | null>>);

export type AgentRequestAuthority<Attempt extends SemanticAttempt = SemanticAttempt> = Readonly<{
  runId: OrchestrationRunId;
  requestId: RequestId;
  slotId: SlotId;
  program: OrchestrationProgram;
  role: LoomAgentName;
  attempt: Attempt;
  modelProfile: LlmProfileId;
  harnessBinding: ExactHarnessBinding;
  requiredSkill: string | null;
  contextDigest: ContextDigest;
  outputSlot: FixedArtifactSlot;
}>;

export type AgentRequestAuthorityViolation = Readonly<{
  kind:
    | "invalid-agent-request-field"
    | "unknown-agent-request-field"
    | "model-binding-mismatch"
    | "model-policy-mismatch"
    | "skill-policy-mismatch"
    | "policy-resolution-failed";
  field: string;
  message: string;
}>;

export type AgentRequestAuthorityError = Readonly<{
  kind: "invalid-agent-request-authority";
  violations: NonEmpty<AgentRequestAuthorityViolation>;
}>;

const violation = (
  kind: AgentRequestAuthorityViolation["kind"],
  field: string,
  message: string,
): AgentRequestAuthorityViolation => canonicalRecord({ kind, field, message });

function parseRequiredSkill(raw: unknown): DomainResult<string | null, AgentRequestAuthorityViolation> {
  return raw === null || (typeof raw === "string" && raw.trim() === raw && /^[a-z0-9][a-z0-9-]*$/.test(raw))
    ? success(raw)
    : failure(violation(
        "invalid-agent-request-field",
        "requiredSkill",
        "requiredSkill must be null or a non-empty canonical Skill name",
      ));
}

function parseAttempt(raw: unknown): DomainResult<SemanticAttempt, AgentRequestAuthorityViolation> {
  return raw === 1 || raw === 2
    ? success(raw)
    : failure(violation("invalid-agent-request-field", "attempt", "attempt must be 1 or 2"));
}

const PI_BINDING_KEYS = ["harness", "provider", "model", "thinking"] as const;
const CLAUDE_BINDING_KEYS = ["harness", "model"] as const;

function authorityBoundaryViolation(
  error: DataBoundaryError,
  field: string,
  mismatchKind: AgentRequestAuthorityViolation["kind"] = "invalid-agent-request-field",
): AgentRequestAuthorityViolation {
  const nestedField = error.field === null ? field : `${field}.${error.field}`;
  const kind = error.reason === "unknown-field" || error.reason === "symbol-field"
    ? "unknown-agent-request-field"
    : mismatchKind;
  return violation(kind, nestedField, error.message);
}

function exactBindingViolations(
  raw: unknown,
  field: "harnessBinding.pi" | "harnessBinding.claude",
  expected: PiBinding | ClaudeCodeBinding,
): readonly AgentRequestAuthorityViolation[] {
  const allowed = expected.harness === "pi" ? PI_BINDING_KEYS : CLAUDE_BINDING_KEYS;
  const parsed = readExactDataRecord(raw, allowed, field);
  if (!parsed.ok) {
    return [authorityBoundaryViolation(parsed.error, field, "model-binding-mismatch")];
  }
  const violations: AgentRequestAuthorityViolation[] = [];
  for (const key of allowed) {
    if (parsed.value[key] !== expected[key as keyof typeof expected]) {
      violations.push(violation(
        "model-binding-mismatch",
        `${field}.${key}`,
        `${field}.${key} must exactly match the resolved model profile`,
      ));
    }
  }
  return violations;
}

function samePiBinding(raw: unknown, expected: PiBinding): boolean {
  const parsed = readExactDataRecord(raw, PI_BINDING_KEYS, "Pi binding");
  return parsed.ok && parsed.value.harness === expected.harness &&
    parsed.value.provider === expected.provider && parsed.value.model === expected.model &&
    parsed.value.thinking === expected.thinking;
}

function sameClaudeBinding(raw: unknown, expected: ClaudeCodeBinding): boolean {
  const parsed = readExactDataRecord(raw, CLAUDE_BINDING_KEYS, "Claude binding");
  return parsed.ok && parsed.value.harness === expected.harness && parsed.value.model === expected.model;
}

function sameHarnessBinding(left: ExactHarnessBinding, right: ExactHarnessBinding): boolean {
  return samePiBinding(left.pi, right.pi) && sameClaudeBinding(left.claude, right.claude);
}

function canonicalHarnessBinding(pi: PiBinding, claude: ClaudeCodeBinding): ExactHarnessBinding {
  return canonicalRecord({
    pi: canonicalRecord({
      harness: "pi",
      provider: pi.provider,
      model: pi.model,
      thinking: pi.thinking,
    }),
    claude: canonicalRecord({ harness: "claude-code", model: claude.model }),
  });
}

const AGENT_REQUEST_KEYS = [
  "runId",
  "requestId",
  "slotId",
  "program",
  "role",
  "attempt",
  "modelProfile",
  "harnessBinding",
  "requiredSkill",
  "contextDigest",
  "outputSlot",
] as const;

export function parseAgentRequestAuthority(
  raw: unknown,
): DomainResult<AgentRequestAuthority, AgentRequestAuthorityError> {
  const request = readExactDataRecord(raw, AGENT_REQUEST_KEYS, "agent request authority");
  if (!request.ok) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([
        authorityBoundaryViolation(request.error, "request"),
      ]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  const fields = request.value;
  const violations: AgentRequestAuthorityViolation[] = [];
  const runId = parseOrchestrationRunId(fields.runId);
  const requestId = parseRequestId(fields.requestId);
  const slotId = parseSlotId(fields.slotId);
  const contextDigest = parseContextDigest(fields.contextDigest);
  const outputSlot = parseFixedArtifactSlot(fields.outputSlot);
  const attempt = parseAttempt(fields.attempt);
  const skill = parseRequiredSkill(fields.requiredSkill);
  const role: DomainResult<LoomAgentName, Readonly<{ message: string }>> = typeof fields.role === "string"
    ? parseAgentName(fields.role)
    : failure(canonicalRecord({ message: `agent role must be a string; received ${describeUnknown(fields.role)}` }));
  const profileId: DomainResult<LlmProfileId, Readonly<{ message: string }>> = typeof fields.modelProfile === "string"
    ? parseLlmProfileId(fields.modelProfile)
    : failure(canonicalRecord({ message: `model profile must be a string; received ${describeUnknown(fields.modelProfile)}` }));

  if (!runId.ok) violations.push(violation("invalid-agent-request-field", "runId", runId.error.message));
  if (!requestId.ok) violations.push(violation("invalid-agent-request-field", "requestId", requestId.error.message));
  if (!slotId.ok) violations.push(violation("invalid-agent-request-field", "slotId", slotId.error.message));
  if (!contextDigest.ok) violations.push(violation("invalid-agent-request-field", "contextDigest", contextDigest.error.message));
  if (!outputSlot.ok) violations.push(violation("invalid-agent-request-field", "outputSlot", outputSlot.error.message));
  if (!attempt.ok) violations.push(attempt.error);
  if (!skill.ok) violations.push(skill.error);
  if (!role.ok) violations.push(violation("invalid-agent-request-field", "role", role.error.message));
  if (!profileId.ok) violations.push(violation("invalid-agent-request-field", "modelProfile", profileId.error.message));
  if (!includes(ORCHESTRATION_PROGRAMS, fields.program)) {
    violations.push(violation(
      "invalid-agent-request-field",
      "program",
      `program must be one of: ${ORCHESTRATION_PROGRAMS.join(", ")}`,
    ));
  }

  let policyResolved = false;
  if (role.ok) {
    const policy = resolveAgentPolicy(role.value);
    if (!policy.ok) {
      violations.push(violation(
        "policy-resolution-failed",
        "role",
        `cannot resolve policy for parsed role '${role.value}': ${policy.error.message}`,
      ));
    } else {
      policyResolved = true;
      if (profileId.ok && policy.value.profile !== profileId.value) {
        violations.push(violation(
          "model-policy-mismatch",
          "modelProfile",
          `role '${role.value}' requires profile '${policy.value.profile}', received '${profileId.value}'`,
        ));
      }
      if (skill.ok) {
        const expectedSkill = AGENT_REQUIRED_SKILLS[role.value];
        if (skill.value !== expectedSkill) {
          violations.push(violation(
            "skill-policy-mismatch",
            "requiredSkill",
            `role '${role.value}' requires Skill ${expectedSkill === null ? "<none>" : `'${expectedSkill}'`}, received ${skill.value === null ? "<none>" : `'${skill.value}'`}`,
          ));
        }
      }
    }
  }

  let resolvedProfile: LlmProfile | null = null;
  if (profileId.ok) {
    const profile = resolveModelProfile(profileId.value);
    if (!profile.ok) {
      violations.push(violation(
        "policy-resolution-failed",
        "modelProfile",
        `cannot resolve parsed model profile '${profileId.value}': ${profile.error.message}`,
      ));
    } else {
      resolvedProfile = profile.value;
    }
  }

  const binding = readExactDataRecord(fields.harnessBinding, ["pi", "claude"], "harnessBinding");
  if (!binding.ok) {
    violations.push(authorityBoundaryViolation(binding.error, "harnessBinding", "model-binding-mismatch"));
  }

  let expectedPi: PiBinding | null = null;
  let expectedClaude: ClaudeCodeBinding | null = null;
  if (resolvedProfile !== null) {
    expectedPi = lowerModelProfile(resolvedProfile, "pi");
    expectedClaude = lowerModelProfile(resolvedProfile, "claude-code");
    violations.push(...exactBindingViolations(binding.ok ? binding.value.pi : undefined, "harnessBinding.pi", expectedPi));
    violations.push(...exactBindingViolations(binding.ok ? binding.value.claude : undefined, "harnessBinding.claude", expectedClaude));
  }

  const head = violations[0];
  if (head !== undefined) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([head, ...violations.slice(1)]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  if (
    !runId.ok || !requestId.ok || !slotId.ok || !contextDigest.ok || !outputSlot.ok ||
    !attempt.ok || !skill.ok || !role.ok || !profileId.ok || !policyResolved || resolvedProfile === null ||
    !includes(ORCHESTRATION_PROGRAMS, fields.program) || expectedPi === null || expectedClaude === null
  ) {
    return failure(canonicalRecord({
      kind: "invalid-agent-request-authority",
      violations: Object.freeze([
        violation("policy-resolution-failed", "request", "request policy could not be completely resolved"),
      ]) as NonEmpty<AgentRequestAuthorityViolation>,
    }));
  }

  return success(canonicalRecord({
    runId: runId.value,
    requestId: requestId.value,
    slotId: slotId.value,
    program: fields.program,
    role: role.value,
    attempt: attempt.value,
    modelProfile: profileId.value,
    harnessBinding: canonicalHarnessBinding(expectedPi, expectedClaude),
    requiredSkill: AGENT_REQUIRED_SKILLS[role.value],
    contextDigest: contextDigest.value,
    outputSlot: outputSlot.value,
  }));
}

export function parseAgentRequestAuthorityForAttempt<Attempt extends SemanticAttempt>(
  raw: unknown,
  expectedAttempt: Attempt,
): DomainResult<AgentRequestAuthority<Attempt>, AgentRequestAuthorityError> {
  const parsed = parseAgentRequestAuthority(raw);
  if (!parsed.ok) return parsed;
  return parsed.value.attempt === expectedAttempt
    ? success(parsed.value as AgentRequestAuthority<Attempt>)
    : failure(canonicalRecord({
        kind: "invalid-agent-request-authority",
        violations: Object.freeze([violation(
          "invalid-agent-request-field",
          "attempt",
          `request must authorize semantic attempt ${expectedAttempt}, received ${parsed.value.attempt}`,
        )]) as NonEmpty<AgentRequestAuthorityViolation>,
      }));
}

export type AgentRosterSlot = Readonly<{
  slotId: SlotId;
  attempts: readonly [AgentRequestAuthority<1>, AgentRequestAuthority<2>];
}>;

export type UnissuedResultCause =
  | Readonly<{ kind: "invalid-publication-identity"; message: string }>
  | Readonly<{ kind: "publication-authority-resolution-failed"; message: string }>
  | Readonly<{ kind: "publication-identity-mismatch"; message: string }>
  | Readonly<{ kind: "issued-request-invalid"; message: string }>
  | Readonly<{
      kind: "issued-request-authority-mismatch";
      fields: NonEmpty<string>;
      message: string;
    }>;

export type RosterViolation =
  | Readonly<{ kind: "empty-roster" }>
  | Readonly<{ kind: "untrusted-exact-roster" }>
  | Readonly<{
      kind: "malformed-roster-boundary";
      field: string | null;
      index: number | null;
      reason: DataBoundaryReason;
      message: string;
    }>
  | Readonly<{ kind: "malformed-roster-slot"; index: number }>
  | Readonly<{ kind: "duplicate-slot"; slotId: SlotId }>
  | Readonly<{ kind: "duplicate-request"; requestId: RequestId }>
  | Readonly<{ kind: "duplicate-context"; contextDigest: ContextDigest }>
  | Readonly<{
      kind: "duplicate-output-path";
      path: string;
      first: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: SemanticAttempt }>;
      duplicate: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: SemanticAttempt }>;
    }>
  | Readonly<{ kind: "attempt-pair-mismatch"; slotId: SlotId; field: string }>
  | Readonly<{
      kind: "malformed-attempt-authority";
      attempt: SemanticAttempt;
      authorityViolations: NonEmpty<AgentRequestAuthorityViolation>;
    }>
  | Readonly<{ kind: "roster-run-mismatch"; slotId: SlotId }>
  | Readonly<{ kind: "roster-program-mismatch"; slotId: SlotId }>
  | Readonly<{ kind: "result-count-mismatch"; expected: number; actual: number }>
  | Readonly<{
      kind: "malformed-result-boundary";
      field: string | null;
      index: number | null;
      reason: DataBoundaryReason;
      message: string;
    }>
  | Readonly<{
      kind: "malformed-result";
      index: number;
      authorityViolations?: NonEmpty<AgentRequestAuthorityViolation>;
    }>
  | Readonly<{
      kind: "unissued-result";
      index: number;
      requestId: RequestId | null;
      cause: UnissuedResultCause;
    }>
  | Readonly<{ kind: "missing-result"; slotId: SlotId }>
  | Readonly<{ kind: "duplicate-result"; slotId: SlotId }>
  | Readonly<{ kind: "surplus-result"; index: number; slotId: SlotId | null }>
  | Readonly<{ kind: "result-binding-mismatch"; slotId: SlotId; field: string }>
  | Readonly<{
      kind: "invalid-result-payload";
      index: number;
      message: string;
      diagnostic: SemanticPayloadDiagnostic;
    }>;

export type AgentRosterSlotError = Readonly<{
  kind: "invalid-agent-roster-slot";
  violations: NonEmpty<RosterViolation>;
}>;

function authorityPairMismatches(
  first: AgentRequestAuthority<1>,
  retry: AgentRequestAuthority<2>,
): readonly string[] {
  const mismatches: string[] = [];
  if (first.attempt !== 1 || retry.attempt !== 2) mismatches.push("attempt");
  if (first.runId !== retry.runId) mismatches.push("runId");
  if (first.slotId !== retry.slotId) mismatches.push("slotId");
  if (first.program !== retry.program) mismatches.push("program");
  if (first.role !== retry.role) mismatches.push("role");
  if (first.modelProfile !== retry.modelProfile) mismatches.push("modelProfile");
  if (!sameHarnessBinding(first.harnessBinding, retry.harnessBinding)) mismatches.push("harnessBinding");
  if (first.requiredSkill !== retry.requiredSkill) mismatches.push("requiredSkill");
  if (first.outputSlot.path === retry.outputSlot.path) mismatches.push("outputSlot");
  if (first.requestId === retry.requestId) mismatches.push("requestId");
  if (first.contextDigest === retry.contextDigest) mismatches.push("contextDigest");
  return mismatches;
}

export function parseAgentRosterSlot(
  rawFirst: unknown,
  rawRetry: unknown,
): DomainResult<AgentRosterSlot, AgentRosterSlotError> {
  const first = parseAgentRequestAuthorityForAttempt(rawFirst, 1);
  const retry = parseAgentRequestAuthorityForAttempt(rawRetry, 2);
  const violations: RosterViolation[] = [];
  if (!first.ok) {
    violations.push(canonicalRecord({
      kind: "malformed-attempt-authority",
      attempt: 1,
      authorityViolations: first.error.violations,
    }));
  }
  if (!retry.ok) {
    violations.push(canonicalRecord({
      kind: "malformed-attempt-authority",
      attempt: 2,
      authorityViolations: retry.error.violations,
    }));
  }
  if (!first.ok || !retry.ok) {
    return failure(canonicalRecord({
      kind: "invalid-agent-roster-slot",
      violations: Object.freeze(violations) as NonEmpty<RosterViolation>,
    }));
  }

  for (const field of authorityPairMismatches(first.value, retry.value)) {
    violations.push(canonicalRecord({ kind: "attempt-pair-mismatch", slotId: first.value.slotId, field }));
  }
  if (first.value.outputSlot.path === retry.value.outputSlot.path) {
    violations.push(canonicalRecord({
      kind: "duplicate-output-path",
      path: first.value.outputSlot.path,
      first: canonicalRecord({
        slotId: first.value.slotId,
        requestId: first.value.requestId,
        attempt: 1,
      }),
      duplicate: canonicalRecord({
        slotId: retry.value.slotId,
        requestId: retry.value.requestId,
        attempt: 2,
      }),
    }));
  }
  if (violations.length > 0) {
    return failure(canonicalRecord({
      kind: "invalid-agent-roster-slot",
      violations: Object.freeze(violations) as NonEmpty<RosterViolation>,
    }));
  }
  return success(canonicalRecord({
    slotId: first.value.slotId,
    attempts: Object.freeze([first.value, retry.value]) as readonly [AgentRequestAuthority<1>, AgentRequestAuthority<2>],
  }));
}

declare class ExactRosterMembership {
  private readonly exactRosterMembership: true;
}
declare class CompleteRosterMembership {
  private readonly completeRosterMembership: true;
}
declare class InitialPublicationIssuanceMembership {
  private readonly initialPublicationIssuanceMembership: true;
}
declare class InitialBatchPublicationIntentMembership {
  private readonly initialBatchPublicationIntentMembership: true;
}
declare class InitialPublicationEffectPortMembership {
  private readonly initialPublicationEffectPortMembership: true;
}
declare class AtomicInitialPublicationClaimPortMembership {
  private readonly atomicInitialPublicationClaimPortMembership: true;
}
const REGISTERED_PUBLICATION_PROOF: unique symbol = Symbol("RegisteredBatchPublicationAuthority");
const ISSUED_REQUEST_PROOF: unique symbol = Symbol("IssuedRequest");
const exactRosterCache = new WeakSet<object>();
const completeRosterCache = new WeakSet<object>();
const initialBatchPublicationIntentCache = new WeakMap<object, BatchPublishedReceipt>();
const initialPublicationIssuanceCache = new WeakMap<object, Readonly<{ receipt: BatchPublishedReceipt }>>();
const initialPublicationEffectPortCache = new WeakMap<object, InitialPublicationEffectExecutor>();
const atomicInitialPublicationClaimPortCache = new WeakMap<object, AtomicInitialPublicationClaim>();
const registeredPublicationCache = new WeakSet<object>();
const issuedRequestCache = new WeakMap<object, SpawnRequest>();

export type ExactRoster<S extends AgentRosterSlot = AgentRosterSlot> = ExactRosterMembership & Readonly<{
  runId: OrchestrationRunId;
  program: OrchestrationProgram;
  orderedSlots: NonEmpty<S>;
  byId: ReadonlyMap<SlotId, S>;
}>;

export type ExactRosterError = Readonly<{
  kind: "invalid-exact-roster";
  violations: NonEmpty<RosterViolation>;
}>;

function immutableMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
  const map = new Map<K, V>(entries);
  let readonlyView: ReadonlyMap<K, V>;
  readonlyView = canonicalRecord({
    get size(): number { return map.size; },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, source: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      map.forEach((value, key) => callback.call(thisArg, value, key, readonlyView));
    },
    [Symbol.iterator]: () => map[Symbol.iterator](),
    [Symbol.toStringTag]: "ReadonlyMap",
  });
  return readonlyView;
}

export function parseExactRoster(
  rawSlots: unknown,
): DomainResult<ExactRoster<AgentRosterSlot>, ExactRosterError> {
  const slots = readDenseDataArray(rawSlots, "exact roster slots");
  if (!slots.ok) {
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze([canonicalRecord({
        kind: "malformed-roster-boundary" as const,
        field: slots.error.field,
        index: slots.error.index,
        reason: slots.error.reason,
        message: slots.error.message,
      })]) as NonEmpty<RosterViolation>,
    }));
  }
  if (slots.value.length === 0) {
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze([canonicalRecord({ kind: "empty-roster" as const })]) as NonEmpty<RosterViolation>,
    }));
  }

  const violations: RosterViolation[] = [];
  const canonicalSlots: AgentRosterSlot[] = [];
  const slotIds = new Set<SlotId>();
  const requestIds = new Set<RequestId>();
  const contextDigests = new Set<ContextDigest>();
  const outputPaths = new Map<string, Readonly<{
    slotId: SlotId;
    requestId: RequestId;
    attempt: SemanticAttempt;
  }>>();
  let canonicalRun: OrchestrationRunId | null = null;
  let canonicalProgram: OrchestrationProgram | null = null;

  slots.value.forEach((rawSlot, index) => {
    const slotRecord = readExactDataRecord(rawSlot, ["slotId", "attempts"], `exact roster slot ${index}`);
    if (!slotRecord.ok) {
      violations.push(canonicalRecord({ kind: "malformed-roster-slot", index }));
      return;
    }
    const attempts = readDenseDataArray(slotRecord.value.attempts, `exact roster slot ${index} attempts`);
    if (!attempts.ok || attempts.value.length !== 2) {
      violations.push(canonicalRecord({ kind: "malformed-roster-slot", index }));
      return;
    }
    const parsedSlot = parseAgentRosterSlot(attempts.value[0], attempts.value[1]);
    if (!parsedSlot.ok) {
      violations.push(...parsedSlot.error.violations);
      return;
    }
    const canonicalSlot = parsedSlot.value;
    canonicalSlots.push(canonicalSlot);
    if (slotRecord.value.slotId !== canonicalSlot.slotId) {
      violations.push(canonicalRecord({ kind: "attempt-pair-mismatch", slotId: canonicalSlot.slotId, field: "slotId" }));
    }
    if (canonicalRun === null) canonicalRun = canonicalSlot.attempts[0].runId;
    if (canonicalProgram === null) canonicalProgram = canonicalSlot.attempts[0].program;
    if (canonicalSlot.attempts[0].runId !== canonicalRun) {
      violations.push(canonicalRecord({ kind: "roster-run-mismatch", slotId: canonicalSlot.slotId }));
    }
    if (canonicalSlot.attempts[0].program !== canonicalProgram) {
      violations.push(canonicalRecord({ kind: "roster-program-mismatch", slotId: canonicalSlot.slotId }));
    }
    if (slotIds.has(canonicalSlot.slotId)) violations.push(canonicalRecord({ kind: "duplicate-slot", slotId: canonicalSlot.slotId }));
    slotIds.add(canonicalSlot.slotId);
    for (const request of canonicalSlot.attempts) {
      if (requestIds.has(request.requestId)) violations.push(canonicalRecord({ kind: "duplicate-request", requestId: request.requestId }));
      requestIds.add(request.requestId);
      if (contextDigests.has(request.contextDigest)) violations.push(canonicalRecord({ kind: "duplicate-context", contextDigest: request.contextDigest }));
      contextDigests.add(request.contextDigest);
      const outputAuthority = canonicalRecord({
        slotId: request.slotId,
        requestId: request.requestId,
        attempt: request.attempt,
      });
      const first = outputPaths.get(request.outputSlot.path);
      if (first === undefined) {
        outputPaths.set(request.outputSlot.path, outputAuthority);
      } else {
        violations.push(canonicalRecord({
          kind: "duplicate-output-path",
          path: request.outputSlot.path,
          first,
          duplicate: outputAuthority,
        }));
      }
    }
  });

  const head = violations[0];
  if (head !== undefined || canonicalRun === null || canonicalProgram === null || canonicalSlots.length === 0) {
    const completeViolations = head === undefined
      ? [{ kind: "empty-roster" as const }]
      : [head, ...violations.slice(1)];
    return failure(canonicalRecord({
      kind: "invalid-exact-roster",
      violations: Object.freeze(completeViolations) as NonEmpty<RosterViolation>,
    }));
  }

  const orderedSlots = Object.freeze(canonicalSlots) as NonEmpty<AgentRosterSlot>;
  const exactRoster = canonicalRecord({
    runId: canonicalRun,
    program: canonicalProgram,
    orderedSlots,
    byId: immutableMap(orderedSlots.map((slot) => [slot.slotId, slot] as const)),
  }) as unknown as ExactRoster<AgentRosterSlot>;
  exactRosterCache.add(exactRoster);
  return success(exactRoster);
}

export type ArtifactRef = Readonly<{
  runId: OrchestrationRunId;
  slot: FixedArtifactSlot;
  digest: ArtifactDigest;
  byteLength: ArtifactByteLength;
}>;

export type ArtifactRefError = Readonly<{
  kind: "invalid-artifact-ref";
  field: string;
  message: string;
}>;

export function parseArtifactRef(raw: unknown): DomainResult<ArtifactRef, ArtifactRefError> {
  const artifact = readExactDataRecord(raw, ["runId", "slot", "digest", "byteLength"], "artifact");
  if (!artifact.ok) {
    return failure(canonicalRecord({
      kind: "invalid-artifact-ref",
      field: artifact.error.field ?? "artifact",
      message: artifact.error.message,
    }));
  }
  const runId = parseOrchestrationRunId(artifact.value.runId);
  const slot = parseFixedArtifactSlot(artifact.value.slot);
  const digest = parseArtifactDigest(artifact.value.digest);
  const byteLength = parseArtifactByteLength(artifact.value.byteLength);
  if (!runId.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "runId", message: runId.error.message }));
  if (!slot.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "slot", message: slot.error.message }));
  if (!digest.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "digest", message: digest.error.message }));
  if (!byteLength.ok) return failure(canonicalRecord({ kind: "invalid-artifact-ref", field: "byteLength", message: byteLength.error.message }));
  return success(canonicalRecord({ runId: runId.value, slot: slot.value, digest: digest.value, byteLength: byteLength.value }));
}

export type ContextReference = Readonly<{
  digest: ContextDigest;
  slot: FixedArtifactSlot;
}>;

function parseContextReference(raw: unknown): DomainResult<ContextReference, ExternalActionError> {
  const context = readExactDataRecord(raw, ["digest", "slot"], "context");
  if (!context.ok) return actionFailure(context.error.message, `context${context.error.field === null ? "" : `.${context.error.field}`}`);
  const digest = parseContextDigest(context.value.digest);
  const slot = parseFixedArtifactSlot(context.value.slot);
  if (!digest.ok) return actionFailure(digest.error.message, "context.digest");
  if (!slot.ok) return actionFailure(slot.error.message, "context.slot");
  return success(canonicalRecord({ digest: digest.value, slot: slot.value }));
}

export type InitialSpawnRequestInput = Readonly<{
  authority: unknown;
  context: unknown;
}>;

/** @deprecated Use InitialSpawnRequestInput for publication-time issuance. */
export type SpawnRequestInput = InitialSpawnRequestInput;

export type PublishedSpawnRequestAuthority = Readonly<{
  authority: AgentRequestAuthority;
  context: ContextReference;
}>;

/** Serialized publication data is untrusted until matched to registered authority. */
export type BatchPublishedReceipt = Readonly<{
  schemaVersion: 1;
  kind: "batch-published";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestIds: NonEmpty<RequestId>;
  contextDigests: NonEmpty<ContextDigest>;
  issuedRequests: NonEmpty<PublishedSpawnRequestAuthority>;
  publicationDigest: ArtifactDigest;
}>;

export type BatchPublicationIdentity = Readonly<{
  schemaVersion: 1;
  kind: "batch-publication-identity";
  runId: OrchestrationRunId;
  effectId: EffectId;
  publicationDigest: ArtifactDigest;
}>;

/** Single-use proof minted only from a verified fresh or matching durable publication claim. */
export type InitialPublicationIssuanceAuthority = InitialPublicationIssuanceMembership & Readonly<{
  schemaVersion: 1;
  kind: "initial-publication-issuance-authority";
  identity: BatchPublicationIdentity;
}>;

/** Parser-produced restart proof from an independently loaded immutable registration. */
export type RegisteredBatchPublicationAuthority = Readonly<{
  schemaVersion: 1;
  kind: "registered-batch-publication-authority";
  identity: BatchPublicationIdentity;
  receipt: BatchPublishedReceipt;
  readonly [REGISTERED_PUBLICATION_PROOF]: true;
}>;

export type PublicationAuthorityResolutionError = Readonly<{
  kind: "publication-authority-unavailable";
  field?: string;
  message: string;
}>;

export type BatchPublicationRegistrationLookup = Readonly<{
  schemaVersion: 1;
  kind: "batch-publication-registration-lookup";
  runId: OrchestrationRunId;
  effectId: EffectId;
}>;

/**
 * The sole restart-registration trust seam. Its persistence adapter must load
 * the exact immutable registration bytes for this authoritative run/effect
 * lookup. Serialized requests and receipts are deliberately not loader inputs
 * and confer no registration authority.
 */
export type TrustedPublicationRegistrationLoader = (
  lookup: BatchPublicationRegistrationLookup,
) => DomainResult<readonly number[], PublicationAuthorityResolutionError>;

/** Parser-produced authority lookup used by restart rehydration. */
export type PublicationAuthorityResolver = (
  identity: BatchPublicationIdentity,
) => DomainResult<RegisteredBatchPublicationAuthority, PublicationAuthorityResolutionError>;

export const MAX_PUBLICATION_REGISTRATION_BYTES = 16_777_216;

/** Durable requests serialize only publication identity plus their canonical batch index. */
export type IssuedSpawnRequestProof = Readonly<{
  schemaVersion: 1;
  kind: "issued-spawn-request-proof";
  runId: OrchestrationRunId;
  effectId: EffectId;
  publicationDigest: ArtifactDigest;
  batchIndex: number;
}>;

export type SpawnRequest = Readonly<{
  authority: AgentRequestAuthority;
  context: ContextReference;
  issuance: IssuedSpawnRequestProof;
  readonly [ISSUED_REQUEST_PROOF]: true;
}>;

function parseNonEmptyAuthorityList<T>(
  raw: unknown,
  parse: (value: unknown) => DomainResult<T, { message: string }>,
  field: string,
): DomainResult<NonEmpty<T>, ExternalActionError> {
  const entries = readDenseDataArray(raw, field);
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? `${field} must be a non-empty array` : entries.error.message, field);
  }
  const parsed: T[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const entry = parse(entries.value[index]);
    if (!entry.ok) return actionFailure(entry.error.message, `${field}[${index}]`);
    parsed.push(entry.value);
  }
  return success(Object.freeze(parsed) as NonEmpty<T>);
}

function samePublishedRequest(
  left: PublishedSpawnRequestAuthority,
  right: PublishedSpawnRequestAuthority,
): boolean {
  const actual = left.authority;
  const expected = right.authority;
  return actual.runId === expected.runId && actual.requestId === expected.requestId &&
    actual.slotId === expected.slotId && actual.program === expected.program &&
    actual.role === expected.role && actual.attempt === expected.attempt &&
    actual.modelProfile === expected.modelProfile &&
    sameHarnessBinding(actual.harnessBinding, expected.harnessBinding) &&
    actual.requiredSkill === expected.requiredSkill &&
    actual.contextDigest === expected.contextDigest &&
    actual.outputSlot.path === expected.outputSlot.path &&
    left.context.digest === right.context.digest && left.context.slot.path === right.context.slot.path;
}

function parsePublishedSpawnRequest(
  raw: unknown,
  field: string,
): DomainResult<PublishedSpawnRequestAuthority, ExternalActionError> {
  const request = readExactDataRecord(raw, ["authority", "context"], field);
  if (!request.ok) {
    return actionFailure(
      request.error.message,
      `${field}${request.error.field === null ? "" : `.${request.error.field}`}`,
    );
  }
  const authority = parseAgentRequestAuthority(request.value.authority);
  if (!authority.ok) {
    return actionFailure(
      authority.error.violations.map(({ message }) => message).join("; "),
      `${field}.authority`,
    );
  }
  const context = parseContextReference(request.value.context);
  if (!context.ok) return actionFailure(context.error.message, `${field}.${context.error.field}`);
  if (authority.value.contextDigest !== context.value.digest) {
    return actionFailure("request authority does not match context digest", `${field}.context.digest`);
  }
  if (context.value.slot.path !== `contexts/${context.value.digest}.json`) {
    return actionFailure("context slot must be content-addressed by its digest", `${field}.context.slot`);
  }
  return success(canonicalRecord({ authority: authority.value, context: context.value }));
}

export function parseBatchPublishedReceipt(
  raw: unknown,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  const receipt = readExactDataRecord(
    raw,
    [
      "schemaVersion", "kind", "effectId", "runId", "requestIds", "contextDigests",
      "issuedRequests", "publicationDigest",
    ],
    "batch publication receipt",
  );
  if (!receipt.ok) return actionFailure(receipt.error.message, `receipt${receipt.error.field === null ? "" : `.${receipt.error.field}`}`);
  if (receipt.value.schemaVersion !== 1) return actionFailure("receipt.schemaVersion must be 1", "receipt.schemaVersion");
  if (receipt.value.kind !== "batch-published") return actionFailure("receipt.kind must be 'batch-published'", "receipt.kind");
  const effectId = parseEffectId(receipt.value.effectId);
  const runId = parseOrchestrationRunId(receipt.value.runId);
  const requestIds = parseNonEmptyAuthorityList(receipt.value.requestIds, parseRequestId, "receipt.requestIds");
  const contextDigests = parseNonEmptyAuthorityList(receipt.value.contextDigests, parseContextDigest, "receipt.contextDigests");
  const publicationDigest = parseArtifactDigest(receipt.value.publicationDigest);
  if (!effectId.ok) return actionFailure(effectId.error.message, "receipt.effectId");
  if (!runId.ok) return actionFailure(runId.error.message, "receipt.runId");
  if (!requestIds.ok) return requestIds;
  if (!contextDigests.ok) return contextDigests;
  if (!publicationDigest.ok) return actionFailure(publicationDigest.error.message, "receipt.publicationDigest");

  const rawIssuedRequests = readDenseDataArray(receipt.value.issuedRequests, "receipt.issuedRequests");
  if (!rawIssuedRequests.ok || rawIssuedRequests.value.length === 0) {
    return actionFailure(
      rawIssuedRequests.ok ? "receipt.issuedRequests must be a non-empty array" : rawIssuedRequests.error.message,
      "receipt.issuedRequests",
    );
  }
  const issuedRequests: PublishedSpawnRequestAuthority[] = [];
  const semanticSlots = new Map<SlotId, number>();
  const outputSlots = new Map<string, Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>>();
  for (let index = 0; index < rawIssuedRequests.value.length; index++) {
    const issued = parsePublishedSpawnRequest(rawIssuedRequests.value[index], `receipt.issuedRequests[${index}]`);
    if (!issued.ok) return issued;
    if (issued.value.authority.runId !== runId.value) {
      return actionFailure("issued request run does not match receipt run", `receipt.issuedRequests[${index}].authority.runId`);
    }
    const outputAuthority = canonicalRecord({
      index,
      requestId: issued.value.authority.requestId,
      slotId: issued.value.authority.slotId,
      attempt: issued.value.authority.attempt,
    });
    const firstSemanticIndex = semanticSlots.get(issued.value.authority.slotId);
    if (firstSemanticIndex !== undefined) {
      return actionFailure(
        `semantic slot '${issued.value.authority.slotId}' is authorized by requests ${firstSemanticIndex} and ${index}; retries require a later action`,
        `receipt.issuedRequests[${index}].authority.slotId`,
      );
    }
    semanticSlots.set(issued.value.authority.slotId, index);
    const first = outputSlots.get(issued.value.authority.outputSlot.path);
    if (first !== undefined) {
      return outputSlotCollision(issued.value.authority.outputSlot.path, first, outputAuthority);
    }
    outputSlots.set(issued.value.authority.outputSlot.path, outputAuthority);
    issuedRequests.push(issued.value);
  }

  if (
    requestIds.value.length !== contextDigests.value.length ||
    requestIds.value.length !== issuedRequests.length
  ) {
    return actionFailure(
      "receipt requestIds, contextDigests, and issuedRequests must have equal lengths",
      "receipt.issuedRequests",
    );
  }
  if (new Set(requestIds.value).size !== requestIds.value.length) {
    return actionFailure("receipt requestIds must be unique", "receipt.requestIds");
  }
  if (new Set(contextDigests.value).size !== contextDigests.value.length) {
    return actionFailure("receipt contextDigests must be unique", "receipt.contextDigests");
  }
  for (let index = 0; index < issuedRequests.length; index++) {
    const issued = issuedRequests[index]!;
    if (requestIds.value[index] !== issued.authority.requestId) {
      return actionFailure("receipt request order or identity does not match issued authority", `receipt.requestIds[${index}]`);
    }
    if (contextDigests.value[index] !== issued.context.digest) {
      return actionFailure("receipt context order or identity does not match issued authority", `receipt.contextDigests[${index}]`);
    }
  }

  const canonicalIssuedRequests = Object.freeze(issuedRequests) as NonEmpty<PublishedSpawnRequestAuthority>;
  const derivedPublicationDigest = digestCanonicalBatchPublicationContent({
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effectId.value,
    runId: runId.value,
    requestIds: requestIds.value,
    contextDigests: contextDigests.value,
    issuedRequests: canonicalIssuedRequests,
  });
  if (publicationDigest.value !== derivedPublicationDigest) {
    return actionFailure(
      "receipt.publicationDigest does not match canonical registered receipt/request content",
      "receipt.publicationDigest",
    );
  }

  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effectId.value,
    runId: runId.value,
    requestIds: requestIds.value,
    contextDigests: contextDigests.value,
    issuedRequests: canonicalIssuedRequests,
    publicationDigest: derivedPublicationDigest,
  }));
}

function digestCanonicalBatchPublicationContent(
  content: Omit<BatchPublishedReceipt, "publicationDigest">,
): ArtifactDigest {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: content.schemaVersion,
    kind: content.kind,
    effectId: content.effectId,
    runId: content.runId,
    requestIds: content.requestIds,
    contextDigests: content.contextDigests,
    issuedRequests: content.issuedRequests,
  }));
  return createHash("sha256").update(bytes).digest("hex") as ArtifactDigest;
}

function batchPublicationIdentity(receipt: BatchPublishedReceipt): BatchPublicationIdentity {
  return canonicalRecord({
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: receipt.runId,
    effectId: receipt.effectId,
    publicationDigest: receipt.publicationDigest,
  });
}

function samePublicationIdentity(
  left: BatchPublicationIdentity,
  right: BatchPublicationIdentity,
): boolean {
  return left.schemaVersion === right.schemaVersion && left.kind === right.kind &&
    left.runId === right.runId && left.effectId === right.effectId &&
    left.publicationDigest === right.publicationDigest;
}

function initialPublicationClaimKey(
  identity: BatchPublicationIdentity,
): InitialPublicationClaimKey {
  return canonicalRecord({
    runId: identity.runId,
    effectId: identity.effectId,
  });
}

function sameInitialPublicationClaimKey(
  left: InitialPublicationClaimKey,
  right: InitialPublicationClaimKey,
): boolean {
  return left.runId === right.runId && left.effectId === right.effectId;
}

export type InitialBatchPublicationIntent = InitialBatchPublicationIntentMembership & Readonly<{
  schemaVersion: 1;
  kind: "initial-batch-publication-intent";
  identity: BatchPublicationIdentity;
  requestIds: NonEmpty<RequestId>;
  contextDigests: NonEmpty<ContextDigest>;
  issuedRequests: NonEmpty<PublishedSpawnRequestAuthority>;
}>;

export type InitialPublicationEffectError = Readonly<{
  kind: "initial-publication-effect-failed";
  message: string;
}>;

export type InitialPublicationClaimError = Readonly<{
  kind: "initial-publication-claim-failed";
  message: string;
}>;

export type InitialPublicationClaimKey = Readonly<{
  runId: OrchestrationRunId;
  effectId: EffectId;
}>;

export type InitialPublicationClaimRequest = Readonly<{
  schemaVersion: 1;
  kind: "initial-publication-claim-request";
  key: InitialPublicationClaimKey;
  identity: BatchPublicationIdentity;
}>;

export type InitialPublicationClaimOutcome =
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-claimed";
      key: InitialPublicationClaimKey;
      identity: BatchPublicationIdentity;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-matching-replay";
      key: InitialPublicationClaimKey;
      identity: BatchPublicationIdentity;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "initial-publication-conflict";
      key: InitialPublicationClaimKey;
      requestedIdentity: BatchPublicationIdentity;
      claimedIdentity: BatchPublicationIdentity;
    }>;

export type AcceptedInitialPublicationClaim = Extract<
  InitialPublicationClaimOutcome,
  { kind: "initial-publication-claimed" | "initial-publication-matching-replay" }
>;

/**
 * Shell adapter contract invoked for fresh and matching claims. Only exact
 * independently returned receipt bytes mint authority here; the T7 adapter,
 * not this injected function type, owns idempotent write behavior.
 */
export type InitialPublicationEffectExecutor = (
  intent: InitialBatchPublicationIntent,
) => DomainResult<readonly number[], InitialPublicationEffectError>;

/**
 * Durable compare-and-set seam. Implementations key storage only by request.key
 * (runId, effectId), atomically storing the full canonical publication identity.
 */
export type AtomicInitialPublicationClaim = (
  request: InitialPublicationClaimRequest,
) => DomainResult<InitialPublicationClaimOutcome, InitialPublicationClaimError>;

export type InitialPublicationEffectPort = InitialPublicationEffectPortMembership & Readonly<{
  kind: "initial-publication-effect-port";
}>;

export type AtomicInitialPublicationClaimPort = AtomicInitialPublicationClaimPortMembership & Readonly<{
  kind: "atomic-initial-publication-claim-port";
}>;

export type InitialBatchPublicationReconciler = (
  intent: InitialBatchPublicationIntent,
) => DomainResult<InitialPublicationIssuanceAuthority, ExternalActionError>;

/**
 * Shell-only wiring point. The returned runtime capability is intentionally not
 * structurally interchangeable with the durable restart registration loader.
 */
export function createInitialPublicationEffectPort(
  executor: InitialPublicationEffectExecutor,
): InitialPublicationEffectPort {
  const port = canonicalRecord({ kind: "initial-publication-effect-port" as const }) as InitialPublicationEffectPort;
  if (typeof executor === "function") initialPublicationEffectPortCache.set(port, executor);
  return port;
}

/** Shell-only wiring point for the durable atomic fresh/replay/conflict claim seam. */
export function createAtomicInitialPublicationClaimPort(
  claim: AtomicInitialPublicationClaim,
): AtomicInitialPublicationClaimPort {
  const port = canonicalRecord({ kind: "atomic-initial-publication-claim-port" as const }) as AtomicInitialPublicationClaimPort;
  if (typeof claim === "function") atomicInitialPublicationClaimPortCache.set(port, claim);
  return port;
}

/**
 * Purely prepares the exact expected publication and its canonical identity.
 * This value carries no issuance authority: the full identity must first be
 * durably claimed, then independently returned publication bytes must match it.
 */
export function prepareInitialBatchPublicationIntent(
  rawRunId: unknown,
  rawEffectId: unknown,
  rawRequests: unknown,
): DomainResult<InitialBatchPublicationIntent, ExternalActionError> {
  const runId = parseOrchestrationRunId(rawRunId);
  const effectId = parseEffectId(rawEffectId);
  if (!runId.ok) return actionFailure(runId.error.message, "intent.runId");
  if (!effectId.ok) return actionFailure(effectId.error.message, "intent.effectId");
  const entries = readDenseDataArray(rawRequests, "initial publication intent requests");
  if (!entries.ok || entries.value.length === 0) {
    return actionFailure(entries.ok ? "initial publication intent requires a non-empty request array" : entries.error.message, "intent.requests");
  }
  const issuedRequests: PublishedSpawnRequestAuthority[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const published = parsePublishedSpawnRequest(entries.value[index], `intent.requests[${index}]`);
    if (!published.ok) return published;
    issuedRequests.push(published.value);
  }
  const canonicalIssued = Object.freeze(issuedRequests) as NonEmpty<PublishedSpawnRequestAuthority>;
  const requestIds = Object.freeze(canonicalIssued.map(({ authority }) => authority.requestId)) as NonEmpty<RequestId>;
  const contextDigests = Object.freeze(canonicalIssued.map(({ context }) => context.digest)) as NonEmpty<ContextDigest>;
  const content = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "batch-published" as const,
    effectId: effectId.value,
    runId: runId.value,
    requestIds,
    contextDigests,
    issuedRequests: canonicalIssued,
  });
  const expectedReceipt = parseBatchPublishedReceipt(canonicalRecord({
    ...content,
    publicationDigest: digestCanonicalBatchPublicationContent(content),
  }));
  if (!expectedReceipt.ok) return expectedReceipt;
  const intent = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "initial-batch-publication-intent" as const,
    identity: batchPublicationIdentity(expectedReceipt.value),
    requestIds: expectedReceipt.value.requestIds,
    contextDigests: expectedReceipt.value.contextDigests,
    issuedRequests: expectedReceipt.value.issuedRequests,
  }) as InitialBatchPublicationIntent;
  initialBatchPublicationIntentCache.set(intent, expectedReceipt.value);
  return success(intent);
}

function boundaryField(prefix: string, error: DataBoundaryError): string {
  return error.field === null ? prefix : `${prefix}.${error.field}`;
}

function parseInitialPublicationEffectResult(
  raw: unknown,
): DomainResult<readonly number[], ExternalActionError> {
  const result = readExactDataRecord(raw, ["ok", "value", "error"], "initial publication effect result");
  if (!result.ok) {
    return actionFailure(result.error.message, boundaryField("publicationEffect", result.error));
  }
  if (typeof result.value.ok !== "boolean") {
    return actionFailure("initial publication effect returned an invalid result tag", "publicationEffect.ok");
  }
  const keys = Object.keys(result.value);
  if (result.value.ok === false) {
    if (keys.length !== 2 || !keys.includes("error")) {
      return actionFailure("failed initial publication effect must contain exactly ok and error", "publicationEffect");
    }
    const error = readExactDataRecord(result.value.error, ["kind", "message"], "initial publication effect error");
    if (!error.ok) {
      return actionFailure(error.error.message, boundaryField("publicationEffect.error", error.error));
    }
    if (error.value.kind !== "initial-publication-effect-failed") {
      return actionFailure("initial publication effect error kind is invalid", "publicationEffect.error.kind");
    }
    if (typeof error.value.message !== "string" || error.value.message.trim().length === 0) {
      return actionFailure("initial publication effect error message must be non-empty", "publicationEffect.error.message");
    }
    return actionFailure(error.value.message, "publicationEffect.error.message");
  }
  if (keys.length !== 2 || !keys.includes("value")) {
    return actionFailure("successful initial publication effect must contain exactly ok and value", "publicationEffect");
  }
  const bytes = readDenseDataArray(
    result.value.value,
    "initial publication receipt bytes",
    MAX_PUBLICATION_REGISTRATION_BYTES,
  );
  if (!bytes.ok) return actionFailure(bytes.error.message, "publicationEffect.receiptBytes");
  for (let index = 0; index < bytes.value.length; index++) {
    const byte = bytes.value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return actionFailure(
        `initial publication receipt byte at index ${index} must be an integer from 0 through 255`,
        "publicationEffect.receiptBytes",
      );
    }
  }
  return success(bytes.value as readonly number[]);
}

function parseInitialPublicationReceiptBytes(
  bytes: readonly number[],
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch (cause) {
    return actionFailure(causedMessage("initial publication receipt bytes are not valid UTF-8", cause), "publicationEffect.receiptBytes");
  }
  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(decoded) as unknown;
  } catch (cause) {
    return actionFailure(causedMessage("initial publication receipt bytes are not valid JSON", cause), "publicationEffect.receiptBytes");
  }
  return parseBatchPublishedReceipt(rawReceipt);
}

function verifyInitialPublicationReceipt(
  expected: BatchPublishedReceipt,
  actual: BatchPublishedReceipt,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  if (!samePublicationIdentity(batchPublicationIdentity(expected), batchPublicationIdentity(actual))) {
    return actionFailure("published receipt run/effect/publication identity does not match the expected intent", "publicationEffect.receipt.identity");
  }
  if (actual.issuedRequests.length !== expected.issuedRequests.length) {
    return actionFailure("published receipt request count does not match the expected intent", "publicationEffect.receipt.issuedRequests");
  }
  for (let index = 0; index < expected.issuedRequests.length; index++) {
    if (actual.requestIds[index] !== expected.requestIds[index]) {
      return actionFailure("published receipt request identity or order does not match the expected intent", `publicationEffect.receipt.requestIds[${index}]`);
    }
    if (actual.contextDigests[index] !== expected.contextDigests[index]) {
      return actionFailure("published receipt context identity or order does not match the expected intent", `publicationEffect.receipt.contextDigests[${index}]`);
    }
    if (!samePublishedRequest(actual.issuedRequests[index]!, expected.issuedRequests[index]!)) {
      return actionFailure(
        "published receipt does not match expected run/effect/request/context/order/output/model/Skill bindings",
        `publicationEffect.receipt.issuedRequests[${index}]`,
      );
    }
  }
  return success(actual);
}

function parseInitialPublicationClaimKey(
  raw: unknown,
  field: string,
): DomainResult<InitialPublicationClaimKey, ExternalActionError> {
  const key = readExactDataRecord(raw, ["runId", "effectId"], field);
  if (!key.ok) return actionFailure(key.error.message, field);
  const runId = parseOrchestrationRunId(key.value.runId);
  const effectId = parseEffectId(key.value.effectId);
  if (!runId.ok) return actionFailure(runId.error.message, `${field}.runId`);
  if (!effectId.ok) return actionFailure(effectId.error.message, `${field}.effectId`);
  return success(canonicalRecord({
    runId: runId.value,
    effectId: effectId.value,
  }));
}

function parseInitialPublicationClaimResult(
  raw: unknown,
): DomainResult<InitialPublicationClaimOutcome, ExternalActionError> {
  const result = readExactDataRecord(raw, ["ok", "value", "error"], "initial publication claim result");
  if (!result.ok) {
    return actionFailure(result.error.message, boundaryField("publicationClaim", result.error));
  }
  if (typeof result.value.ok !== "boolean") {
    return actionFailure("initial publication claim returned an invalid result tag", "publicationClaim.ok");
  }
  const keys = Object.keys(result.value);
  if (result.value.ok === false) {
    if (keys.length !== 2 || !keys.includes("error")) {
      return actionFailure("failed initial publication claim must contain exactly ok and error", "publicationClaim");
    }
    const error = readExactDataRecord(result.value.error, ["kind", "message"], "initial publication claim error");
    if (!error.ok) {
      return actionFailure(error.error.message, boundaryField("publicationClaim.error", error.error));
    }
    if (error.value.kind !== "initial-publication-claim-failed") {
      return actionFailure("initial publication claim error kind is invalid", "publicationClaim.error.kind");
    }
    if (typeof error.value.message !== "string" || error.value.message.trim().length === 0) {
      return actionFailure("initial publication claim error message must be non-empty", "publicationClaim.error.message");
    }
    return actionFailure(error.value.message, "publicationClaim.error.message");
  }
  if (keys.length !== 2 || !keys.includes("value")) {
    return actionFailure("successful initial publication claim must contain exactly ok and value", "publicationClaim");
  }
  const envelope = readExactDataRecord(
    result.value.value,
    ["schemaVersion", "kind", "key", "identity", "requestedIdentity", "claimedIdentity"],
    "initial publication claim outcome",
  );
  if (!envelope.ok || envelope.value.schemaVersion !== 1) {
    return actionFailure(
      envelope.ok ? "initial publication claim outcome schemaVersion is invalid" : envelope.error.message,
      "publicationClaim",
    );
  }
  const kind = envelope.value.kind;
  if (kind === "initial-publication-claimed" || kind === "initial-publication-matching-replay") {
    const outcome = readExactDataRecord(
      result.value.value,
      ["schemaVersion", "kind", "key", "identity"],
      "initial publication claim outcome",
    );
    if (!outcome.ok) return actionFailure(outcome.error.message, "publicationClaim");
    const key = parseInitialPublicationClaimKey(outcome.value.key, "publicationClaim.key");
    const identity = parseBatchPublicationIdentity(outcome.value.identity);
    if (!key.ok) return key;
    if (!identity.ok) return actionFailure(identity.error.message, "publicationClaim.identity");
    return success(canonicalRecord({ schemaVersion: 1, kind, key: key.value, identity: identity.value }));
  }
  if (kind === "initial-publication-conflict") {
    const outcome = readExactDataRecord(
      result.value.value,
      ["schemaVersion", "kind", "key", "requestedIdentity", "claimedIdentity"],
      "initial publication claim conflict",
    );
    if (!outcome.ok) return actionFailure(outcome.error.message, "publicationClaim");
    const key = parseInitialPublicationClaimKey(outcome.value.key, "publicationClaim.key");
    const requestedIdentity = parseBatchPublicationIdentity(outcome.value.requestedIdentity);
    const claimedIdentity = parseBatchPublicationIdentity(outcome.value.claimedIdentity);
    if (!key.ok) return key;
    if (!requestedIdentity.ok) return actionFailure(requestedIdentity.error.message, "publicationClaim.requestedIdentity");
    if (!claimedIdentity.ok) return actionFailure(claimedIdentity.error.message, "publicationClaim.claimedIdentity");
    return success(canonicalRecord({
      schemaVersion: 1,
      kind,
      key: key.value,
      requestedIdentity: requestedIdentity.value,
      claimedIdentity: claimedIdentity.value,
    }));
  }
  return actionFailure("initial publication claim outcome tag is invalid", "publicationClaim");
}

/** Pure claim reducer. It returns a decision, never an issuance capability. */
export function reduceInitialPublicationClaim(
  expectedIdentity: BatchPublicationIdentity,
  outcome: InitialPublicationClaimOutcome,
): DomainResult<AcceptedInitialPublicationClaim, ExternalActionError> {
  const expectedKey = initialPublicationClaimKey(expectedIdentity);
  if (!sameInitialPublicationClaimKey(expectedKey, outcome.key)) {
    return actionFailure("atomic initial publication claim returned a foreign claim key", "publicationClaim.key");
  }
  if (outcome.kind === "initial-publication-conflict") {
    if (!samePublicationIdentity(expectedIdentity, outcome.requestedIdentity)) {
      return actionFailure("atomic initial publication claim returned a foreign requested identity", "publicationClaim.requestedIdentity");
    }
    const claimedKey = initialPublicationClaimKey(outcome.claimedIdentity);
    if (!sameInitialPublicationClaimKey(expectedKey, claimedKey)) {
      return actionFailure("atomic initial publication claim returned a foreign claimed identity", "publicationClaim.claimedIdentity");
    }
    if (samePublicationIdentity(expectedIdentity, outcome.claimedIdentity)) {
      return actionFailure("atomic initial publication claim returned an invalid matching conflict", "publicationClaim.claimedIdentity");
    }
    return actionFailure(
      "initial publication claim conflicts with a different digest for the same run/effect",
      "publicationClaim.claimedIdentity.publicationDigest",
    );
  }
  if (!samePublicationIdentity(expectedIdentity, outcome.identity)) {
    return actionFailure("atomic initial publication claim returned a foreign identity", "publicationClaim.identity");
  }
  return success(outcome);
}

function mintInitialPublicationIssuanceAuthority(
  receipt: BatchPublishedReceipt,
): InitialPublicationIssuanceAuthority {
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "initial-publication-issuance-authority" as const,
    identity: batchPublicationIdentity(receipt),
  }) as InitialPublicationIssuanceAuthority;
  initialPublicationIssuanceCache.set(authority, canonicalRecord({ receipt }));
  return authority;
}

/**
 * Thin shell reconciliation adapter. The prepared canonical identity is claimed
 * before invoking the injected effect. Fresh and matching claims invoke that
 * effect, and only its exact returned receipt mints authority.
 */
export function createInitialBatchPublicationReconciler(
  publicationEffectPort: InitialPublicationEffectPort,
  publicationClaimPort: AtomicInitialPublicationClaimPort,
): InitialBatchPublicationReconciler {
  return (intent) => {
    const expectedReceipt = typeof intent === "object" && intent !== null
      ? initialBatchPublicationIntentCache.get(intent)
      : undefined;
    if (expectedReceipt === undefined) {
      return actionFailure("initial publication reconciliation requires a fresh prepared intent", "intent");
    }
    const executor = typeof publicationEffectPort === "object" && publicationEffectPort !== null
      ? initialPublicationEffectPortCache.get(publicationEffectPort)
      : undefined;
    if (executor === undefined) {
      return actionFailure("a trusted initial publication effect port is required", "publicationEffect");
    }
    const claim = typeof publicationClaimPort === "object" && publicationClaimPort !== null
      ? atomicInitialPublicationClaimPortCache.get(publicationClaimPort)
      : undefined;
    if (claim === undefined) {
      return actionFailure("a trusted atomic initial publication claim port is required", "publicationClaim");
    }

    const identity = batchPublicationIdentity(expectedReceipt);
    const claimRequest = canonicalRecord({
      schemaVersion: 1 as const,
      kind: "initial-publication-claim-request" as const,
      key: initialPublicationClaimKey(identity),
      identity,
    });
    let rawClaimResult: unknown;
    try {
      rawClaimResult = claim(claimRequest);
    } catch (cause) {
      return actionFailure(causedMessage("atomic initial publication claim threw", cause), "publicationClaim");
    }
    const claimResult = parseInitialPublicationClaimResult(rawClaimResult);
    if (!claimResult.ok) return claimResult;
    const decision = reduceInitialPublicationClaim(identity, claimResult.value);
    if (!decision.ok) return decision;

    let rawEffectResult: unknown;
    try {
      rawEffectResult = executor(intent);
    } catch (cause) {
      return actionFailure(causedMessage("initial publication effect threw", cause), "publicationEffect");
    }
    const effectResult = parseInitialPublicationEffectResult(rawEffectResult);
    if (!effectResult.ok) return effectResult;
    const parsedReceipt = parseInitialPublicationReceiptBytes(effectResult.value);
    if (!parsedReceipt.ok) return parsedReceipt;
    const verifiedReceipt = verifyInitialPublicationReceipt(expectedReceipt, parsedReceipt.value);
    return verifiedReceipt.ok
      ? success(mintInitialPublicationIssuanceAuthority(verifiedReceipt.value))
      : verifiedReceipt;
  };
}

function registeredBatchPublicationAuthority(
  receipt: BatchPublishedReceipt,
): RegisteredBatchPublicationAuthority {
  const authority = Object.create(null) as {
    schemaVersion: 1;
    kind: "registered-batch-publication-authority";
    identity: BatchPublicationIdentity;
    receipt: BatchPublishedReceipt;
    readonly [REGISTERED_PUBLICATION_PROOF]: true;
  };
  Object.defineProperties(authority, {
    schemaVersion: { value: 1, enumerable: true, writable: false, configurable: false },
    kind: { value: "registered-batch-publication-authority", enumerable: true, writable: false, configurable: false },
    identity: { value: batchPublicationIdentity(receipt), enumerable: true, writable: false, configurable: false },
    receipt: { value: receipt, enumerable: true, writable: false, configurable: false },
    [REGISTERED_PUBLICATION_PROOF]: { value: true, enumerable: false, writable: false, configurable: false },
  });
  const canonical = Object.freeze(authority);
  registeredPublicationCache.add(canonical);
  return canonical;
}

function publicationResolutionFailure(
  message: string,
  field?: string,
): PublicationAuthorityResolutionError {
  return field === undefined
    ? canonicalRecord({ kind: "publication-authority-unavailable", message })
    : canonicalRecord({ kind: "publication-authority-unavailable", field, message });
}

function parseBatchPublicationIdentity(
  raw: unknown,
): DomainResult<BatchPublicationIdentity, PublicationAuthorityResolutionError> {
  const identity = readExactDataRecord(
    raw,
    ["schemaVersion", "kind", "runId", "effectId", "publicationDigest"],
    "batch publication identity",
  );
  if (!identity.ok || identity.value.schemaVersion !== 1 || identity.value.kind !== "batch-publication-identity") {
    return failure(publicationResolutionFailure(
      identity.ok ? "batch publication identity tag or schemaVersion is invalid" : identity.error.message,
    ));
  }
  const runId = parseOrchestrationRunId(identity.value.runId);
  const effectId = parseEffectId(identity.value.effectId);
  const publicationDigest = parseArtifactDigest(identity.value.publicationDigest);
  if (!runId.ok) return failure(publicationResolutionFailure(runId.error.message));
  if (!effectId.ok) return failure(publicationResolutionFailure(effectId.error.message));
  if (!publicationDigest.ok) return failure(publicationResolutionFailure(publicationDigest.error.message));
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: runId.value,
    effectId: effectId.value,
    publicationDigest: publicationDigest.value,
  }));
}

function parseRegistrationLoaderResult(
  raw: unknown,
): DomainResult<readonly number[], PublicationAuthorityResolutionError> {
  const loaded = readExactDataRecord(raw, ["ok", "value", "error"], "publication registration loader result");
  if (!loaded.ok) {
    return failure(publicationResolutionFailure(
      loaded.error.message,
      boundaryField("publicationRegistrationLoader", loaded.error),
    ));
  }
  if (typeof loaded.value.ok !== "boolean") {
    return failure(publicationResolutionFailure(
      "publication registration loader returned an invalid result tag",
      "publicationRegistrationLoader.ok",
    ));
  }
  const keys = Object.keys(loaded.value);
  if (loaded.value.ok === false) {
    if (keys.length !== 2 || !keys.includes("error")) {
      return failure(publicationResolutionFailure(
        "failed publication registration load must contain exactly ok and error",
        "publicationRegistrationLoader",
      ));
    }
    const loaderError = readExactDataRecord(
      loaded.value.error,
      ["kind", "field", "message"],
      "publication registration loader error",
    );
    if (!loaderError.ok) {
      return failure(publicationResolutionFailure(
        loaderError.error.message,
        boundaryField("publicationRegistrationLoader.error", loaderError.error),
      ));
    }
    if (loaderError.value.kind !== "publication-authority-unavailable") {
      return failure(publicationResolutionFailure(
        "publication registration loader error kind is invalid",
        "publicationRegistrationLoader.error.kind",
      ));
    }
    if (typeof loaderError.value.message !== "string" || loaderError.value.message.trim().length === 0) {
      return failure(publicationResolutionFailure(
        "publication registration loader error message must be non-empty",
        "publicationRegistrationLoader.error.message",
      ));
    }
    if (loaderError.value.field !== undefined &&
        (typeof loaderError.value.field !== "string" || loaderError.value.field.trim().length === 0)) {
      return failure(publicationResolutionFailure(
        "publication registration loader error field must be non-empty when present",
        "publicationRegistrationLoader.error.field",
      ));
    }
    return failure(publicationResolutionFailure(
      loaderError.value.message,
      typeof loaderError.value.field === "string"
        ? loaderError.value.field
        : "publicationRegistrationLoader.error.message",
    ));
  }
  if (keys.length !== 2 || !keys.includes("value")) {
    return failure(publicationResolutionFailure(
      "successful publication registration load must contain exactly ok and value",
    ));
  }
  const bytes = readDenseDataArray(
    loaded.value.value,
    "publication registration bytes",
    MAX_PUBLICATION_REGISTRATION_BYTES,
  );
  if (!bytes.ok) return failure(publicationResolutionFailure(bytes.error.message));
  for (let index = 0; index < bytes.value.length; index++) {
    const byte = bytes.value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return failure(publicationResolutionFailure(
        `publication registration byte at index ${index} must be an integer from 0 through 255`,
      ));
    }
  }
  return success(bytes.value as readonly number[]);
}

/**
 * Anti-corruption boundary from shell-owned registration bytes to opaque core
 * authority. The loader is invoked exactly once for each resolver call. The
 * loaded receipt is structurally parsed and its publication digest is
 * recomputed from canonical receipt/request content before authority exists.
 */
export function createPublicationAuthorityResolver(
  loader: TrustedPublicationRegistrationLoader,
): PublicationAuthorityResolver {
  return (rawIdentity) => {
    const identity = parseBatchPublicationIdentity(rawIdentity);
    if (!identity.ok) return identity;
    if (typeof loader !== "function") {
      return failure(publicationResolutionFailure("a trusted publication registration loader is required"));
    }
    const lookup = canonicalRecord({
      schemaVersion: 1 as const,
      kind: "batch-publication-registration-lookup" as const,
      runId: identity.value.runId,
      effectId: identity.value.effectId,
    });
    let rawLoaded: unknown;
    try {
      rawLoaded = loader(lookup);
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration loader threw", cause),
      ));
    }
    const loaded = parseRegistrationLoaderResult(rawLoaded);
    if (!loaded.ok) return loaded;

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(loaded.value));
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration bytes are not valid UTF-8", cause),
      ));
    }
    let rawRegistration: unknown;
    try {
      rawRegistration = JSON.parse(decoded) as unknown;
    } catch (cause) {
      return failure(publicationResolutionFailure(
        causedMessage("publication registration bytes are not valid JSON", cause),
      ));
    }
    const receipt = parseBatchPublishedReceipt(rawRegistration);
    if (!receipt.ok) return failure(publicationResolutionFailure(receipt.error.message));
    const derivedIdentity = batchPublicationIdentity(receipt.value);
    if (!samePublicationIdentity(identity.value, derivedIdentity)) {
      return failure(publicationResolutionFailure(
        "loaded publication registration is stale, foreign, or divergent",
      ));
    }
    return success(registeredBatchPublicationAuthority(receipt.value));
  };
}

function parseIssuedSpawnRequestProof(
  raw: unknown,
): DomainResult<IssuedSpawnRequestProof, AcceptedAgentResultError> {
  const proof = readExactDataRecord(
    raw,
    ["schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex"],
    "issued spawn request proof",
  );
  if (!proof.ok || proof.value.schemaVersion !== 1 || proof.value.kind !== "issued-spawn-request-proof") {
    return failure(canonicalRecord({
      kind: "invalid-accepted-agent-result",
      message: proof.ok ? "issued spawn request proof tag or schemaVersion is invalid" : proof.error.message,
    }));
  }
  const runId = parseOrchestrationRunId(proof.value.runId);
  const effectId = parseEffectId(proof.value.effectId);
  const publicationDigest = parseArtifactDigest(proof.value.publicationDigest);
  const batchIndex = proof.value.batchIndex;
  if (!runId.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: runId.error.message }));
  if (!effectId.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: effectId.error.message }));
  if (!publicationDigest.ok) return failure(canonicalRecord({ kind: "invalid-accepted-agent-result", message: publicationDigest.error.message }));
  if (typeof batchIndex !== "number" || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    return failure(canonicalRecord({
      kind: "invalid-accepted-agent-result",
      message: "issued spawn request proof batchIndex must be a non-negative safe integer",
    }));
  }
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "issued-spawn-request-proof",
    runId: runId.value,
    effectId: effectId.value,
    publicationDigest: publicationDigest.value,
    batchIndex,
  }));
}

function issuancePublicationIdentity(issuance: IssuedSpawnRequestProof): BatchPublicationIdentity {
  return canonicalRecord({
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: issuance.runId,
    effectId: issuance.effectId,
    publicationDigest: issuance.publicationDigest,
  });
}

function authorityResolutionFailure(message: string, field?: string): AcceptedAgentResultError {
  return field === undefined
    ? canonicalRecord({ kind: "invalid-accepted-agent-result", message })
    : canonicalRecord({ kind: "invalid-accepted-agent-result", field, message });
}

function resolveRegisteredPublicationAuthority(
  resolver: PublicationAuthorityResolver,
  identity: BatchPublicationIdentity,
): DomainResult<RegisteredBatchPublicationAuthority, AcceptedAgentResultError> {
  if (typeof resolver !== "function") {
    return failure(authorityResolutionFailure("a publication authority resolver is required"));
  }
  let rawResolution: unknown;
  try {
    rawResolution = resolver(identity);
  } catch (cause) {
    return failure(authorityResolutionFailure(causedMessage("publication authority resolver threw", cause)));
  }
  const resolution = readExactDataRecord(rawResolution, ["ok", "value", "error"], "publication authority resolution");
  if (!resolution.ok) {
    return failure(authorityResolutionFailure(
      resolution.error.message,
      boundaryField("publicationAuthorityResolver", resolution.error),
    ));
  }
  if (typeof resolution.value.ok !== "boolean") {
    return failure(authorityResolutionFailure(
      "publication authority resolver returned an invalid result tag",
      "publicationAuthorityResolver.ok",
    ));
  }
  const keys = Object.keys(resolution.value);
  if (resolution.value.ok === false) {
    if (keys.length !== 2 || !keys.includes("error")) {
      return failure(authorityResolutionFailure(
        "failed publication authority resolution must contain exactly ok and error",
        "publicationAuthorityResolver",
      ));
    }
    const resolverError = readExactDataRecord(
      resolution.value.error,
      ["kind", "field", "message"],
      "publication authority resolution error",
    );
    if (!resolverError.ok) {
      return failure(authorityResolutionFailure(
        resolverError.error.message,
        boundaryField("publicationAuthorityResolver.error", resolverError.error),
      ));
    }
    if (resolverError.value.kind !== "publication-authority-unavailable") {
      return failure(authorityResolutionFailure(
        "publication authority resolution error kind is invalid",
        "publicationAuthorityResolver.error.kind",
      ));
    }
    if (typeof resolverError.value.message !== "string" || resolverError.value.message.trim().length === 0) {
      return failure(authorityResolutionFailure(
        "publication authority resolution error message must be non-empty",
        "publicationAuthorityResolver.error.message",
      ));
    }
    if (resolverError.value.field !== undefined &&
        (typeof resolverError.value.field !== "string" || resolverError.value.field.trim().length === 0)) {
      return failure(authorityResolutionFailure(
        "publication authority resolution error field must be non-empty when present",
        "publicationAuthorityResolver.error.field",
      ));
    }
    return failure(authorityResolutionFailure(
      resolverError.value.message,
      typeof resolverError.value.field === "string"
        ? resolverError.value.field
        : "publicationAuthorityResolver.error.message",
    ));
  }
  if (keys.length !== 2 || !keys.includes("value")) {
    return failure(authorityResolutionFailure("successful publication authority resolution must contain exactly ok and value"));
  }
  const registered = resolution.value.value;
  if (typeof registered !== "object" || registered === null || !registeredPublicationCache.has(registered)) {
    return failure(authorityResolutionFailure("publication authority resolver returned an untrusted or forged registration proof"));
  }
  const authority = registered as RegisteredBatchPublicationAuthority;
  if (!samePublicationIdentity(identity, authority.identity) ||
      !samePublicationIdentity(authority.identity, batchPublicationIdentity(authority.receipt))) {
    return failure(authorityResolutionFailure("resolved publication authority is stale or foreign"));
  }
  return success(authority);
}

function issuedSpawnRequest(
  published: PublishedSpawnRequestAuthority,
  registered: RegisteredBatchPublicationAuthority,
  batchIndex: number,
): SpawnRequest {
  const issuance = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "issued-spawn-request-proof" as const,
    runId: registered.identity.runId,
    effectId: registered.identity.effectId,
    publicationDigest: registered.identity.publicationDigest,
    batchIndex,
  });
  const request = Object.create(null) as {
    authority: AgentRequestAuthority;
    context: ContextReference;
    issuance: IssuedSpawnRequestProof;
    readonly [ISSUED_REQUEST_PROOF]: true;
  };
  Object.defineProperties(request, {
    authority: { value: published.authority, enumerable: true, writable: false, configurable: false },
    context: { value: published.context, enumerable: true, writable: false, configurable: false },
    issuance: { value: issuance, enumerable: true, writable: false, configurable: false },
    [ISSUED_REQUEST_PROOF]: { value: true, enumerable: false, writable: false, configurable: false },
  });
  const canonical = Object.freeze(request);
  issuedRequestCache.set(canonical, canonical);
  return canonical;
}

function parseIssuedSpawnRequestAgainstRegistration(
  registered: RegisteredBatchPublicationAuthority,
  raw: unknown,
): DomainResult<SpawnRequest, AcceptedAgentResultError> {
  const cached = typeof raw === "object" && raw !== null ? issuedRequestCache.get(raw) : undefined;
  const serializedEnvelope = cached === undefined
    ? raw
    : canonicalRecord({ authority: cached.authority, context: cached.context, issuance: cached.issuance });
  const request = readExactDataRecord(serializedEnvelope, ["authority", "context", "issuance"], "issued spawn request");
  if (!request.ok) return failure(authorityResolutionFailure(request.error.message));
  const published = parsePublishedSpawnRequest(
    canonicalRecord({ authority: request.value.authority, context: request.value.context }),
    "issued spawn request",
  );
  if (!published.ok) return failure(authorityResolutionFailure(published.error.message));
  const issuance = parseIssuedSpawnRequestProof(request.value.issuance);
  if (!issuance.ok) return issuance;
  const identity = issuancePublicationIdentity(issuance.value);
  if (!samePublicationIdentity(identity, registered.identity)) {
    return failure(authorityResolutionFailure("issued spawn request carries stale or foreign publication identity"));
  }
  const expected = registered.receipt.issuedRequests[issuance.value.batchIndex];
  if (expected === undefined || !samePublishedRequest(published.value, expected)) {
    return failure(authorityResolutionFailure(
      "issued spawn request does not match registered run/request/context/order/output/model/Skill authority",
    ));
  }
  return success(issuedSpawnRequest(expected, registered, issuance.value.batchIndex));
}

function parseIssuedSpawnRequestIdentity(
  raw: unknown,
): DomainResult<BatchPublicationIdentity, AcceptedAgentResultError> {
  const cached = typeof raw === "object" && raw !== null ? issuedRequestCache.get(raw) : undefined;
  const serializedEnvelope = cached === undefined
    ? raw
    : canonicalRecord({ authority: cached.authority, context: cached.context, issuance: cached.issuance });
  const envelope = readExactDataRecord(serializedEnvelope, ["authority", "context", "issuance"], "issued spawn request");
  if (!envelope.ok) return failure(authorityResolutionFailure(envelope.error.message));
  const issuance = parseIssuedSpawnRequestProof(envelope.value.issuance);
  return issuance.ok ? success(issuancePublicationIdentity(issuance.value)) : issuance;
}

/** Rebuild a runtime proof only after one independent registered-authority lookup. */
export function parseIssuedSpawnRequest(
  resolver: PublicationAuthorityResolver,
  raw: unknown,
): DomainResult<SpawnRequest, AcceptedAgentResultError> {
  const identity = parseIssuedSpawnRequestIdentity(raw);
  if (!identity.ok) return identity;
  const registered = resolveRegisteredPublicationAuthority(resolver, identity.value);
  return registered.ok
    ? parseIssuedSpawnRequestAgainstRegistration(registered.value, raw)
    : registered;
}

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

function unissuedResultCause(
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

function bindingMismatches(
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

function semanticPayloadFailure<T>(
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

function canonicalizeSemanticPayload(
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

function parseAndCanonicalizePayload<T>(
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
    const parsedAuthority = parseAgentRequestAuthority(result.value.authority);
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

type TerminalDiagnosticFields = Readonly<{
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

function diagnosticFailure<T>(
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

function parseDiagnosticMessage(
  raw: unknown,
  field = "message",
): DomainResult<string, DiagnosticConstructionError> {
  return typeof raw === "string" && raw.length > 0 && raw.trim() === raw
    ? success(raw)
    : diagnosticFailure(field, `${field} must be a non-empty trimmed actionable diagnostic message`);
}

function rosterViolationSummary(violations: NonEmpty<RosterViolation>): string {
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

const RUN_TERMINAL_CATEGORIES = ["invalid-authority", "roster-invalid"] as const;
const REQUEST_TERMINAL_CATEGORIES = [
  "duplicate-result",
  "stale-request",
  "surplus-result",
  "context-drift",
  "model-mismatch",
  "skill-mismatch",
] as const;
const EXHAUSTED_RESULT_CATEGORIES = [
  "missing-result",
  "malformed-result",
  "result-binding-mismatch",
] as const;

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

export type ExternalActionError =
  | Readonly<{
      kind: "invalid-external-action";
      field: string;
      message: string;
    }>
  | Readonly<{
      kind: "spawn-output-slot-collision";
      field: "requests.authority.outputSlot.path";
      message: string;
      path: string;
      first: Readonly<{
        index: number;
        requestId: RequestId;
        slotId: SlotId;
        attempt: SemanticAttempt;
      }>;
      duplicate: Readonly<{
        index: number;
        requestId: RequestId;
        slotId: SlotId;
        attempt: SemanticAttempt;
      }>;
    }>;

function actionFailure<T = never>(message: string, field: string): DomainResult<T, ExternalActionError> {
  return failure(canonicalRecord({ kind: "invalid-external-action", field, message }));
}

function outputSlotCollision<T>(
  path: string,
  first: Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>,
  duplicate: Readonly<{
    index: number;
    requestId: RequestId;
    slotId: SlotId;
    attempt: SemanticAttempt;
  }>,
): DomainResult<T, ExternalActionError> {
  return failure(canonicalRecord({
    kind: "spawn-output-slot-collision",
    field: "requests.authority.outputSlot.path",
    message: `spawn output slot '${path}' is authorized by requests ${first.index} and ${duplicate.index}`,
    path,
    first: canonicalRecord(first),
    duplicate: canonicalRecord(duplicate),
  }));
}

function inspectInitialPublicationIssuanceAuthority(
  raw: unknown,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  if (typeof raw !== "object" || raw === null) {
    return actionFailure("initial issuance requires a fresh initial publication capability", "publicationAuthority");
  }
  const state = initialPublicationIssuanceCache.get(raw);
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

function consumeInitialPublicationIssuanceAuthority(
  raw: InitialPublicationIssuanceAuthority,
  expectedReceipt: BatchPublishedReceipt,
): DomainResult<BatchPublishedReceipt, ExternalActionError> {
  const current = inspectInitialPublicationIssuanceAuthority(raw);
  if (!current.ok) return current;
  if (current.value !== expectedReceipt) {
    return actionFailure("initial publication capability changed during request construction", "publicationAuthority");
  }
  initialPublicationIssuanceCache.delete(raw);
  return success(current.value);
}

function issueInitialSpawnRequestsFromReceipt(
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
  if (context.value.slot.path !== `contexts/${context.value.digest}.json`) return actionFailure("decision context slot must be content-addressed", "request.context.slot");
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

function exactDiagnosticConstants(
  raw: unknown,
  expected: Readonly<Record<string, unknown>>,
  field: string,
): DomainResult<Readonly<Record<string, unknown>>, DiagnosticConstructionError> {
  const parsed = readExactDataRecord(raw, Object.keys(expected), field);
  if (!parsed.ok) return diagnosticFailure(field, parsed.error.message);
  for (const [key, value] of Object.entries(expected)) {
    if (parsed.value[key] !== value) return diagnosticFailure(`${field}.${key}`, `${field}.${key} is invalid`);
  }
  return parsed;
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
      runScoped
        ? ["kind", "category", "runId", "message", "retry", "recovery"]
        : exhaustedResult
          ? ["kind", "category", "runId", "requestId", "slotId", "attempt", "message", "retry", "recovery"]
          : ["kind", "category", "runId", "requestId", "slotId", "message", "retry", "recovery"],
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

export type PublishArtifactSet = Readonly<{
  kind: "publish-artifact-set";
  effectId: EffectId;
  runId: OrchestrationRunId;
  artifacts: NonEmpty<ArtifactRef>;
}>;
export type CommitProtectedWaveState = Readonly<{
  kind: "commit-protected-wave-state";
  effectId: EffectId;
  runId: OrchestrationRunId;
  expectedRevision: number;
  stateDigest: ArtifactDigest;
}>;
export type ReserveAgentRequests = Readonly<{
  kind: "reserve-agent-requests";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requests: NonEmpty<AgentRequestAuthority>;
}>;
export type CaptureRawTranscript = Readonly<{
  kind: "capture-raw-transcript";
  effectId: EffectId;
  runId: OrchestrationRunId;
  request: AgentRequestAuthority;
  bytes: readonly number[];
}>;
export type InspectGitRemediation = Readonly<{
  kind: "inspect-git-remediation";
  effectId: EffectId;
  runId: OrchestrationRunId;
  paths: readonly RepositoryPath[];
}>;
export type InstallVerifiedIndex = Readonly<{
  kind: "install-verified-index";
  effectId: EffectId;
  runId: OrchestrationRunId;
  indexDigest: ArtifactDigest;
  witnessDigest: ArtifactDigest;
}>;

export type EffectIntent =
  | PublishArtifactSet
  | CommitProtectedWaveState
  | ReserveAgentRequests
  | CaptureRawTranscript
  | InspectGitRemediation
  | InstallVerifiedIndex;

export type ArtifactSetPublished = Readonly<{
  kind: "artifact-set-published";
  effectId: EffectId;
  runId: OrchestrationRunId;
  artifacts: NonEmpty<ArtifactRef>;
}>;
export type ProtectedWaveStateCommitted = Readonly<{
  kind: "protected-wave-state-committed";
  effectId: EffectId;
  runId: OrchestrationRunId;
  committedRevision: number;
  stateDigest: ArtifactDigest;
}>;
export type AgentRequestsReserved = Readonly<{
  kind: "agent-requests-reserved";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestIds: NonEmpty<RequestId>;
}>;
export type RawTranscriptCaptured = Readonly<{
  kind: "raw-transcript-captured";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestId: RequestId;
  artifact: ArtifactRef;
}>;
export type GitRemediationInspected = Readonly<{
  kind: "git-remediation-inspected";
  effectId: EffectId;
  runId: OrchestrationRunId;
  witnessDigest: ArtifactDigest;
  paths: readonly RepositoryPath[];
}>;
export type VerifiedIndexInstalled = Readonly<{
  kind: "verified-index-installed";
  effectId: EffectId;
  runId: OrchestrationRunId;
  indexDigest: ArtifactDigest;
  witnessDigest: ArtifactDigest;
}>;

export type EffectReceipt =
  | ArtifactSetPublished
  | ProtectedWaveStateCommitted
  | AgentRequestsReserved
  | RawTranscriptCaptured
  | GitRemediationInspected
  | VerifiedIndexInstalled;

export type ArtifactSlotAssignment = Readonly<{
  index: number;
  artifact: ArtifactRef;
}>;

export type ArtifactSlotConflict = Readonly<{
  path: string;
  first: ArtifactSlotAssignment;
  duplicate: ArtifactSlotAssignment;
}>;

export type EffectReceiptError = Readonly<{
  kind: "effect-receipt-mismatch";
  effectId: EffectId | null;
  field: string;
  message: string;
  artifactSlotConflict?: ArtifactSlotConflict;
}>;

type ReconciliationParseError = Readonly<{
  field: string;
  message: string;
  artifactSlotConflict?: ArtifactSlotConflict;
}>;

function reconciliationFailure<T>(
  field: string,
  message: string,
  artifactSlotConflict?: ArtifactSlotConflict,
): DomainResult<T, ReconciliationParseError> {
  return failure(canonicalRecord({
    field,
    message,
    ...(artifactSlotConflict === undefined ? {} : { artifactSlotConflict }),
  }));
}

function reconciliationRecord(
  raw: unknown,
  allowed: readonly string[],
  prefix: string,
): DomainResult<Readonly<Record<string, unknown>>, ReconciliationParseError> {
  const record = readExactDataRecord(raw, allowed, prefix);
  return record.ok
    ? record
    : reconciliationFailure(
        record.error.field === null ? prefix : `${prefix}.${record.error.field}`,
        record.error.message,
      );
}

function parseBaseEffect(
  raw: Readonly<Record<string, unknown>>,
  prefix: string,
): DomainResult<Readonly<{ effectId: EffectId; runId: OrchestrationRunId }>, ReconciliationParseError> {
  const effectId = parseEffectId(raw.effectId);
  const runId = parseOrchestrationRunId(raw.runId);
  if (!effectId.ok) return reconciliationFailure(`${prefix}.effectId`, effectId.error.message);
  if (!runId.ok) return reconciliationFailure(`${prefix}.runId`, runId.error.message);
  return success(canonicalRecord({ effectId: effectId.value, runId: runId.value }));
}

function parseArtifactArray(raw: unknown, prefix: string): DomainResult<NonEmpty<ArtifactRef>, ReconciliationParseError> {
  const entries = readDenseDataArray(raw, prefix);
  if (!entries.ok || entries.value.length === 0) {
    return reconciliationFailure(prefix, entries.ok ? `${prefix} must be a non-empty array` : entries.error.message);
  }
  const artifacts: ArtifactRef[] = [];
  const assignments = new Map<string, ArtifactSlotAssignment>();
  for (let index = 0; index < entries.value.length; index++) {
    const parsed = parseArtifactRef(entries.value[index]);
    if (!parsed.ok) return reconciliationFailure(`${prefix}[${index}].${parsed.error.field}`, parsed.error.message);
    const assignment = canonicalRecord({ index, artifact: parsed.value });
    const first = assignments.get(parsed.value.slot.path);
    if (first !== undefined) {
      const conflict = canonicalRecord({
        path: parsed.value.slot.path,
        first,
        duplicate: assignment,
      });
      return reconciliationFailure(
        `${prefix}[${index}].slot.path`,
        `${prefix} assigns immutable artifact slot '${parsed.value.slot.path}' at both entries ${first.index} and ${index}`,
        conflict,
      );
    }
    assignments.set(parsed.value.slot.path, assignment);
    artifacts.push(parsed.value);
  }
  return success(Object.freeze(artifacts) as NonEmpty<ArtifactRef>);
}

function parseRepositoryPathValue(raw: unknown, prefix: string): DomainResult<RepositoryPath, ReconciliationParseError> {
  const path = reconciliationRecord(raw, ["relative", "absolute"], prefix);
  if (!path.ok) return path;
  const relative = parseReviewPath(path.value.relative, `${prefix}.relative`);
  if (!relative.ok) return reconciliationFailure(`${prefix}.relative`, relative.errors.join("; "));
  const absolute = path.value.absolute;
  if (typeof absolute !== "string" || !posix.isAbsolute(absolute) || posix.normalize(absolute) !== absolute || absolute === "/") {
    return reconciliationFailure(`${prefix}.absolute`, `${prefix}.absolute must be a canonical absolute path`);
  }
  if (!absolute.endsWith(`/${relative.value}`)) {
    return reconciliationFailure(`${prefix}.absolute`, `${prefix}.absolute must identify the same relative path`);
  }
  return success(canonicalRecord({ relative: relative.value, absolute }));
}

function parseRepositoryPathArray(raw: unknown, prefix: string): DomainResult<readonly RepositoryPath[], ReconciliationParseError> {
  const entries = readDenseDataArray(raw, prefix);
  if (!entries.ok) return reconciliationFailure(prefix, entries.error.message);
  const paths: RepositoryPath[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const parsed = parseRepositoryPathValue(entries.value[index], `${prefix}[${index}]`);
    if (!parsed.ok) return parsed;
    paths.push(parsed.value);
  }
  if (new Set(paths.map(({ relative }) => relative)).size !== paths.length) {
    return reconciliationFailure(prefix, `${prefix} must not contain duplicate paths`);
  }
  return success(Object.freeze(paths));
}

const EFFECT_INTENT_FIELDS = [
  "kind", "effectId", "runId", "artifacts", "expectedRevision", "stateDigest", "requests",
  "request", "bytes", "paths", "indexDigest", "witnessDigest",
] as const;
const EFFECT_RECEIPT_FIELDS = [
  "kind", "effectId", "runId", "artifacts", "committedRevision", "stateDigest", "requestIds",
  "requestId", "artifact", "witnessDigest", "paths", "indexDigest",
] as const;

function parseEffectIntent(raw: unknown): DomainResult<EffectIntent, ReconciliationParseError> {
  const envelope = reconciliationRecord(raw, EFFECT_INTENT_FIELDS, "intent");
  if (!envelope.ok) return envelope;
  const base = parseBaseEffect(envelope.value, "intent");
  if (!base.ok) return base;
  switch (envelope.value.kind) {
    case "publish-artifact-set": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "artifacts"], "intent");
      if (!intent.ok) return intent;
      const artifacts = parseArtifactArray(intent.value.artifacts, "intent.artifacts");
      if (!artifacts.ok) return artifacts;
      const foreign = artifacts.value.find((artifact) => artifact.runId !== base.value.runId);
      if (foreign !== undefined) return reconciliationFailure("intent.artifacts.runId", "every artifact must belong to the effect run");
      return success(canonicalRecord({ kind: "publish-artifact-set", ...base.value, artifacts: artifacts.value }));
    }
    case "commit-protected-wave-state": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "expectedRevision", "stateDigest"], "intent");
      if (!intent.ok) return intent;
      const revision = intent.value.expectedRevision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        return reconciliationFailure("intent.expectedRevision", "expectedRevision must be a non-negative safe integer");
      }
      const stateDigest = parseArtifactDigest(intent.value.stateDigest);
      if (!stateDigest.ok) return reconciliationFailure("intent.stateDigest", stateDigest.error.message);
      return success(canonicalRecord({ kind: "commit-protected-wave-state", ...base.value, expectedRevision: revision, stateDigest: stateDigest.value }));
    }
    case "reserve-agent-requests": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requests"], "intent");
      if (!intent.ok) return intent;
      const entries = readDenseDataArray(intent.value.requests, "intent.requests");
      if (!entries.ok || entries.value.length === 0) {
        return reconciliationFailure("intent.requests", entries.ok ? "requests must be non-empty" : entries.error.message);
      }
      const requests: AgentRequestAuthority[] = [];
      for (let index = 0; index < entries.value.length; index++) {
        const parsed = parseAgentRequestAuthority(entries.value[index]);
        if (!parsed.ok) return reconciliationFailure(`intent.requests[${index}]`, parsed.error.violations.map(({ message }) => message).join("; "));
        if (parsed.value.runId !== base.value.runId) return reconciliationFailure(`intent.requests[${index}].runId`, "request belongs to another run");
        requests.push(parsed.value);
      }
      if (new Set(requests.map(({ requestId }) => requestId)).size !== requests.length) return reconciliationFailure("intent.requests.requestId", "request IDs must be unique");
      return success(canonicalRecord({ kind: "reserve-agent-requests", ...base.value, requests: Object.freeze(requests) as NonEmpty<AgentRequestAuthority> }));
    }
    case "capture-raw-transcript": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "request", "bytes"], "intent");
      if (!intent.ok) return intent;
      const request = parseAgentRequestAuthority(intent.value.request);
      if (!request.ok) return reconciliationFailure("intent.request", request.error.violations.map(({ message }) => message).join("; "));
      if (request.value.runId !== base.value.runId) return reconciliationFailure("intent.request.runId", "request belongs to another run");
      const bytes = parseRawTranscriptBytes(intent.value.bytes);
      if (!bytes.ok) return reconciliationFailure("intent.bytes", bytes.error.message);
      return success(canonicalRecord({ kind: "capture-raw-transcript", ...base.value, request: request.value, bytes: bytes.value }));
    }
    case "inspect-git-remediation": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "paths"], "intent");
      if (!intent.ok) return intent;
      const paths = parseRepositoryPathArray(intent.value.paths, "intent.paths");
      if (!paths.ok) return paths;
      return success(canonicalRecord({ kind: "inspect-git-remediation", ...base.value, paths: paths.value }));
    }
    case "install-verified-index": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "indexDigest", "witnessDigest"], "intent");
      if (!intent.ok) return intent;
      const indexDigest = parseArtifactDigest(intent.value.indexDigest);
      const witnessDigest = parseArtifactDigest(intent.value.witnessDigest);
      if (!indexDigest.ok) return reconciliationFailure("intent.indexDigest", indexDigest.error.message);
      if (!witnessDigest.ok) return reconciliationFailure("intent.witnessDigest", witnessDigest.error.message);
      return success(canonicalRecord({ kind: "install-verified-index", ...base.value, indexDigest: indexDigest.value, witnessDigest: witnessDigest.value }));
    }
    default:
      return reconciliationFailure("intent.kind", `unknown effect intent kind ${describeUnknown(envelope.value.kind)}`);
  }
}

function parseEffectReceipt(raw: unknown): DomainResult<EffectReceipt, ReconciliationParseError> {
  const envelope = reconciliationRecord(raw, EFFECT_RECEIPT_FIELDS, "receipt");
  if (!envelope.ok) return envelope;
  const base = parseBaseEffect(envelope.value, "receipt");
  if (!base.ok) return base;
  switch (envelope.value.kind) {
    case "artifact-set-published": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "artifacts"], "receipt");
      if (!receipt.ok) return receipt;
      const artifacts = parseArtifactArray(receipt.value.artifacts, "receipt.artifacts");
      if (!artifacts.ok) return artifacts;
      return success(canonicalRecord({ kind: "artifact-set-published", ...base.value, artifacts: artifacts.value }));
    }
    case "protected-wave-state-committed": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "committedRevision", "stateDigest"], "receipt");
      if (!receipt.ok) return receipt;
      const revision = receipt.value.committedRevision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        return reconciliationFailure("receipt.committedRevision", "committedRevision must be a non-negative safe integer");
      }
      const stateDigest = parseArtifactDigest(receipt.value.stateDigest);
      if (!stateDigest.ok) return reconciliationFailure("receipt.stateDigest", stateDigest.error.message);
      return success(canonicalRecord({ kind: "protected-wave-state-committed", ...base.value, committedRevision: revision, stateDigest: stateDigest.value }));
    }
    case "agent-requests-reserved": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requestIds"], "receipt");
      if (!receipt.ok) return receipt;
      const entries = readDenseDataArray(receipt.value.requestIds, "receipt.requestIds");
      if (!entries.ok || entries.value.length === 0) {
        return reconciliationFailure("receipt.requestIds", entries.ok ? "requestIds must be non-empty" : entries.error.message);
      }
      const requestIds: RequestId[] = [];
      for (let index = 0; index < entries.value.length; index++) {
        const parsed = parseRequestId(entries.value[index]);
        if (!parsed.ok) return reconciliationFailure(`receipt.requestIds[${index}]`, parsed.error.message);
        requestIds.push(parsed.value);
      }
      if (new Set(requestIds).size !== requestIds.length) return reconciliationFailure("receipt.requestIds", "requestIds must be unique");
      return success(canonicalRecord({ kind: "agent-requests-reserved", ...base.value, requestIds: Object.freeze(requestIds) as NonEmpty<RequestId> }));
    }
    case "raw-transcript-captured": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requestId", "artifact"], "receipt");
      if (!receipt.ok) return receipt;
      const requestId = parseRequestId(receipt.value.requestId);
      const artifact = parseArtifactRef(receipt.value.artifact);
      if (!requestId.ok) return reconciliationFailure("receipt.requestId", requestId.error.message);
      if (!artifact.ok) return reconciliationFailure(`receipt.artifact.${artifact.error.field}`, artifact.error.message);
      return success(canonicalRecord({ kind: "raw-transcript-captured", ...base.value, requestId: requestId.value, artifact: artifact.value }));
    }
    case "git-remediation-inspected": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "witnessDigest", "paths"], "receipt");
      if (!receipt.ok) return receipt;
      const witnessDigest = parseArtifactDigest(receipt.value.witnessDigest);
      const paths = parseRepositoryPathArray(receipt.value.paths, "receipt.paths");
      if (!witnessDigest.ok) return reconciliationFailure("receipt.witnessDigest", witnessDigest.error.message);
      if (!paths.ok) return paths;
      return success(canonicalRecord({ kind: "git-remediation-inspected", ...base.value, witnessDigest: witnessDigest.value, paths: paths.value }));
    }
    case "verified-index-installed": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "indexDigest", "witnessDigest"], "receipt");
      if (!receipt.ok) return receipt;
      const indexDigest = parseArtifactDigest(receipt.value.indexDigest);
      const witnessDigest = parseArtifactDigest(receipt.value.witnessDigest);
      if (!indexDigest.ok) return reconciliationFailure("receipt.indexDigest", indexDigest.error.message);
      if (!witnessDigest.ok) return reconciliationFailure("receipt.witnessDigest", witnessDigest.error.message);
      return success(canonicalRecord({ kind: "verified-index-installed", ...base.value, indexDigest: indexDigest.value, witnessDigest: witnessDigest.value }));
    }
    default:
      return reconciliationFailure("receipt.kind", `unknown effect receipt kind ${describeUnknown(envelope.value.kind)}`);
  }
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.runId === right.runId && left.slot.path === right.slot.path &&
    left.digest === right.digest && left.byteLength === right.byteLength;
}

function samePath(left: RepositoryPath, right: RepositoryPath): boolean {
  return left.relative === right.relative && left.absolute === right.absolute;
}

function receiptPayloadMismatch(intent: EffectIntent, receipt: EffectReceipt): ReconciliationParseError | null {
  switch (intent.kind) {
    case "publish-artifact-set":
      if (receipt.kind !== "artifact-set-published") return { field: "receipt.kind", message: `expected artifact-set-published, received ${receipt.kind}` };
      if (intent.artifacts.length !== receipt.artifacts.length) return { field: "receipt.artifacts", message: "artifact count mismatch" };
      for (let index = 0; index < intent.artifacts.length; index++) {
        const expected = intent.artifacts[index]!;
        const actual = receipt.artifacts[index]!;
        if (expected.runId !== actual.runId) return { field: `receipt.artifacts[${index}].runId`, message: "artifact run mismatch" };
        if (expected.slot.path !== actual.slot.path) return { field: `receipt.artifacts[${index}].slot`, message: "artifact slot mismatch" };
        if (expected.digest !== actual.digest) return { field: `receipt.artifacts[${index}].digest`, message: "artifact digest mismatch" };
        if (expected.byteLength !== actual.byteLength) return { field: `receipt.artifacts[${index}].byteLength`, message: "artifact byteLength mismatch" };
      }
      return null;
    case "commit-protected-wave-state":
      if (receipt.kind !== "protected-wave-state-committed") return { field: "receipt.kind", message: `expected protected-wave-state-committed, received ${receipt.kind}` };
      if (receipt.committedRevision !== intent.expectedRevision + 1) return { field: "receipt.committedRevision", message: "committed revision does not advance expected revision" };
      if (receipt.stateDigest !== intent.stateDigest) return { field: "receipt.stateDigest", message: "state digest mismatch" };
      return null;
    case "reserve-agent-requests":
      if (receipt.kind !== "agent-requests-reserved") return { field: "receipt.kind", message: `expected agent-requests-reserved, received ${receipt.kind}` };
      if (receipt.requestIds.length !== intent.requests.length) return { field: "receipt.requestIds", message: "reserved request count mismatch" };
      for (let index = 0; index < intent.requests.length; index++) {
        if (receipt.requestIds[index] !== intent.requests[index]!.requestId) return { field: `receipt.requestIds[${index}]`, message: "reserved request identity or order mismatch" };
      }
      return null;
    case "capture-raw-transcript": {
      if (receipt.kind !== "raw-transcript-captured") return { field: "receipt.kind", message: `expected raw-transcript-captured, received ${receipt.kind}` };
      if (receipt.requestId !== intent.request.requestId) return { field: "receipt.requestId", message: "captured request identity mismatch" };
      if (receipt.artifact.runId !== intent.runId) return { field: "receipt.artifact.runId", message: "captured artifact run mismatch" };
      if (receipt.artifact.slot.path !== intent.request.outputSlot.path) return { field: "receipt.artifact.slot", message: "captured artifact slot mismatch" };
      if (receipt.artifact.byteLength !== intent.bytes.length) return { field: "receipt.artifact.byteLength", message: "captured byteLength mismatch" };
      const contentDigest = digestRawTranscriptBytes(intent.bytes);
      if (!contentDigest.ok || receipt.artifact.digest !== contentDigest.value) return { field: "receipt.artifact.digest", message: "captured digest mismatch" };
      return null;
    }
    case "inspect-git-remediation":
      if (receipt.kind !== "git-remediation-inspected") return { field: "receipt.kind", message: `expected git-remediation-inspected, received ${receipt.kind}` };
      if (receipt.paths.length !== intent.paths.length) return { field: "receipt.paths", message: "inspected path count mismatch" };
      for (let index = 0; index < intent.paths.length; index++) {
        if (!samePath(intent.paths[index]!, receipt.paths[index]!)) return { field: `receipt.paths[${index}]`, message: "inspected path identity or order mismatch" };
      }
      return null;
    case "install-verified-index":
      if (receipt.kind !== "verified-index-installed") return { field: "receipt.kind", message: `expected verified-index-installed, received ${receipt.kind}` };
      if (receipt.indexDigest !== intent.indexDigest) return { field: "receipt.indexDigest", message: "installed index digest mismatch" };
      if (receipt.witnessDigest !== intent.witnessDigest) return { field: "receipt.witnessDigest", message: "installed witness digest mismatch" };
      return null;
  }
}

export function reconcileEffectReceipt(
  rawIntent: unknown,
  rawReceipt: unknown,
): DomainResult<EffectReceipt, EffectReceiptError> {
  const intent = parseEffectIntent(rawIntent);
  if (!intent.ok) {
    return failure(canonicalRecord({
      kind: "effect-receipt-mismatch",
      effectId: null,
      field: intent.error.field,
      message: intent.error.message,
      ...(intent.error.artifactSlotConflict === undefined
        ? {}
        : { artifactSlotConflict: intent.error.artifactSlotConflict }),
    }));
  }
  const receipt = parseEffectReceipt(rawReceipt);
  if (!receipt.ok) {
    return failure(canonicalRecord({
      kind: "effect-receipt-mismatch",
      effectId: intent.value.effectId,
      field: receipt.error.field,
      message: receipt.error.message,
      ...(receipt.error.artifactSlotConflict === undefined
        ? {}
        : { artifactSlotConflict: receipt.error.artifactSlotConflict }),
    }));
  }
  if (intent.value.effectId !== receipt.value.effectId) {
    return failure(canonicalRecord({ kind: "effect-receipt-mismatch", effectId: intent.value.effectId, field: "receipt.effectId", message: "effect identity mismatch" }));
  }
  if (intent.value.runId !== receipt.value.runId) {
    return failure(canonicalRecord({ kind: "effect-receipt-mismatch", effectId: intent.value.effectId, field: "receipt.runId", message: "run identity mismatch" }));
  }
  const mismatch = receiptPayloadMismatch(intent.value, receipt.value);
  return mismatch === null
    ? success(receipt.value)
    : failure(canonicalRecord({
        kind: "effect-receipt-mismatch",
        effectId: intent.value.effectId,
        field: mismatch.field,
        message: mismatch.message,
      }));
}
