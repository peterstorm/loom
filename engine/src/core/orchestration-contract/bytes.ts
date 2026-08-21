/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { createHash } from 'node:crypto';
import { boundDiagnosticMessage, canonicalRecord, describeUnknown, failure, success, type ArtifactDigest, type DomainResult } from './identity';

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

export type DataBoundaryError = Readonly<{
  field: string | null;
  index: number | null;
  reason: DataBoundaryReason;
  message: string;
}>;

export function dataBoundaryFailure<T>(
  reason: DataBoundaryReason,
  message: string,
  field: string | null = null,
  index: number | null = null,
): DomainResult<T, DataBoundaryError> {
  return failure(canonicalRecord({ field, index, reason, message }));
}

export function sameDataDescriptor(
  left: PropertyDescriptor,
  right: PropertyDescriptor | undefined,
): boolean {
  return right !== undefined && "value" in left && "value" in right &&
    Object.is(left.value, right.value) && left.enumerable === right.enumerable &&
    left.configurable === right.configurable && left.writable === right.writable;
}

/** A total, deterministically bounded description of an arbitrary thrown value. */
export function describeThrownCause(cause: unknown): string {
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

export const causedMessage = (message: string, cause: unknown): string =>
  boundDiagnosticMessage(`${message}: ${describeThrownCause(cause)}`);

/**
 * Takes a stable snapshot of an exact plain record using own data descriptors only.
 * No caller getter or ordinary property read is performed.
 */
export function readExactDataRecord(
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
export function readDenseDataArray(
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

export function parseRawTranscriptBytes(
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

export function digestCanonicalBytes(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

export function digestRawTranscriptBytes(
  raw: unknown,
): DomainResult<ArtifactDigest, RawTranscriptBytesError> {
  const bytes = parseRawTranscriptBytes(raw);
  return bytes.ok ? success(digestCanonicalBytes(bytes.value)) : bytes;
}

export const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
