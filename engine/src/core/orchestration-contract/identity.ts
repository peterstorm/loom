/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */


export type DomainResult<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 4_096;
export const DIAGNOSTIC_TRUNCATION_MARKER = "…[truncated]";

export function boundDiagnosticMessage(message: string): string {
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

export type StructuralPairs = Map<object, Set<object>>;

export function hasNeutralRecordPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/**
 * Records a left/right pair for the duration of ITS OWN comparison, so cyclic
 * structures terminate instead of recursing forever.
 *
 * The entry is scoped to the active recursion path and released when that
 * comparison returns — it records "this pair is currently being compared", not
 * "this pair compared equal". Leaving it behind would make the memo answer for
 * a comparison that never concluded: `matchOnce` deliberately tolerates FAILED
 * speculative sub-comparisons while trying Map/Set candidates, so a pair
 * registered by a rejected candidate would later short-circuit to `true`
 * somewhere else in the structure and report two different values as equal.
 * This function gates checkpoint/state agreement, where a false "equal" admits
 * exactly the mismatched checkpoint the check exists to reject.
 */
export function withPairInProgress(
  left: object,
  right: object,
  seen: StructuralPairs,
  compare: () => boolean,
): boolean {
  const open = seen.get(left);
  // Already on the current path: the structures are cyclic and every finite
  // difference has been examined by the frame that opened this pair.
  if (open?.has(right) === true) return true;

  // The stored Set is held directly rather than re-read on the way out: this
  // runs once per object pair in every comparison, and the map is never
  // replaced for a key while a frame below it is still open.
  const partners = open ?? new Set<object>();
  if (open === undefined) seen.set(left, partners);
  partners.add(right);
  try {
    return compare();
  } finally {
    partners.delete(right);
    if (partners.size === 0) seen.delete(left);
  }
}

/** Consumes the first structurally matching candidate, so sizes compare as multisets. */
export function matchOnce<T>(candidates: T[], matches: (candidate: T) => boolean): boolean {
  const index = candidates.findIndex(matches);
  if (index === -1) return false;
  candidates.splice(index, 1);
  return true;
}

export function mapsEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  const unmatched = [...right.entries()];
  for (const [key, value] of left) {
    const matched = matchOnce(unmatched, ([candidateKey, candidateValue]) =>
      structurallyEqual(key, candidateKey, seen) && structurallyEqual(value, candidateValue, seen));
    if (!matched) return false;
  }
  return true;
}

export function setsEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
  const unmatched = [...right];
  for (const entry of left) {
    if (!matchOnce(unmatched, (candidate) => structurallyEqual(entry, candidate, seen))) return false;
  }
  return true;
}

export function recordsEqual(left: object, right: object, seen: StructuralPairs): boolean {
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

export function structurallyEqual(left: unknown, right: unknown, seen: StructuralPairs): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  return withPairInProgress(left, right, seen, () => {
    const leftSequence = hasImmutableByteSequenceTag(left);
    const rightSequence = hasImmutableByteSequenceTag(right);
    if (leftSequence || rightSequence) {
      // A Context Packet's ImmutableByteSequence and its parsed wire form (the
      // plain number array JSON makes of it) are two spellings of the same
      // bytes — the packet contract binds them with one digest. Compare the
      // bytes, never by reflection: a sequence deliberately has no own
      // enumerable keys (Object.keys of a sequence is empty), so record
      // equality would vacuously accept ANY two sequences, and the Array arm
      // would reject the mixed pair the packet round trip produces.
      const leftEntries = byteSequenceEntries(left, leftSequence);
      const rightEntries = byteSequenceEntries(right, rightSequence);
      return leftEntries !== null && rightEntries !== null &&
        leftEntries.length === rightEntries.length &&
        leftEntries.every((entry, index) => structurallyEqual(entry, rightEntries[index], seen));
    }
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
  });
}

/** Materialize one side of a byte-sequence comparison. A tagged sequence
 *  iterates its bytes; the untagged side must be the plain number array the
 *  wire form is. Anything else (a record, a Map, a hostile tagged non-iterable)
 *  refuses instead of throwing. */
function byteSequenceEntries(value: unknown, tagged: boolean): readonly unknown[] | null {
  if (!tagged) return Array.isArray(value) ? (value as readonly unknown[]) : null;
  try {
    return Array.from(value as Iterable<unknown>);
  } catch {
    return null;
  }
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

/** Well-known registry tag shared with core/context-packets' ImmutableByteSequence
 *  prototype. The equality kernel must recognize byte sequences WITHOUT importing
 *  the packet module — the packet module imports this kernel — so the tag travels
 *  through the global symbol registry instead of an import edge.
 *
 *  The tag is set only on the packet module's frozen sequence prototype. A plain
 *  number array (the parsed wire form) never carries it, which is exactly the
 *  distinction the byte-sequence comparison arm needs: one tagged side means
 *  "compare as byte sequences"; neither tagged means every other rule applies. */
export const IMMUTABLE_BYTE_SEQUENCE_TAG: unique symbol = Symbol.for("@peterstorm/loom/immutable-byte-sequence");

const hasImmutableByteSequenceTag = (value: unknown): boolean =>
  typeof value === "object" && value !== null &&
  (value as Record<symbol, unknown>)[IMMUTABLE_BYTE_SEQUENCE_TAG] === true;

export const success = <T, E = never>(value: T): DomainResult<T, E> => canonicalRecord({ ok: true, value });
export const failure = <T = never, E = never>(error: E): DomainResult<T, E> =>
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

export const SAFE_AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function describeUnknown(raw: unknown): string {
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

export function parseAuthorityId<T extends string>(
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
