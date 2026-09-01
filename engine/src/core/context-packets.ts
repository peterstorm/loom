/**
 * Immutable, byte-aware context packets.
 *
 * A packet is the complete context one semantic Agent request receives,
 * addressed by content digest. Parent actions carry only a digest reference;
 * this module constructs immutable values and proves that a digest names exact
 * packet bytes. Write-once publication is enforced separately by the Run
 * Directory adapter; a packet whose identity/section bytes change gets a
 * different digest.
 *
 * What this module does NOT claim: it does not attest that a child actually
 * read the bytes, and it does not by itself bind a packet to an external
 * request authority — request/role binding to an issued AgentRequestAuthority
 * is enforced at the capture boundary (see harness-capture-runtime.ts).
 */

import { sha256Bytes, sha256Hex } from "./review-packet";
import {
  canonicalRecord,
  parseArtifactByteLength,
  parseRequestId,
  type ArtifactByteLength,
  type ArtifactDigest,
  type ContextDigest,
  type DomainResult,
  type RequestId,
} from "./orchestration-contract";

export const CONTEXT_PACKET_SCHEMA_VERSION = 1;

/** One labelled, digested run of exact bytes inside a packet. */
export type ByteSection = Readonly<{
  label: string;
  byteLength: ArtifactByteLength;
  digest: ArtifactDigest;
  bytes: readonly number[];
}>;

export type ContextPacket = Readonly<{
  schemaVersion: typeof CONTEXT_PACKET_SCHEMA_VERSION;
  digest: ContextDigest;
  requestId: RequestId;
  role: string;
  requiredSkill: string;
  outputContract: string;
  /** Authority and rules fixed across every retry of this request lineage. */
  fixedContext: readonly ByteSection[];
  /** Task/plan/spec/manifest data variable within the request lineage. */
  variableContext: readonly ByteSection[];
}>;

export type ContextPacketError = Readonly<{
  kind: "invalid-context-packet";
  field: string;
  message: string;
}>;

const failure = <T>(field: string, message: string): DomainResult<T, ContextPacketError> =>
  ({ ok: false, error: canonicalRecord({ kind: "invalid-context-packet" as const, field, message }) });

const success = <T>(value: T): DomainResult<T, ContextPacketError> => ({ ok: true, value });

const encoder = new TextEncoder();

const isByte = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;

function digestBytes(bytes: readonly number[]): string {
  return sha256Bytes(Uint8Array.from(bytes));
}

/**
 * Encode one section. The label is metadata; only `text` contributes bytes,
 * and it is encoded verbatim.
 */
export function encodeByteSection(label: string, text: string): DomainResult<ByteSection, ContextPacketError> {
  if (label.length === 0) return failure("label", "a context section label must not be empty");
  const bytes = Array.from(encoder.encode(text));
  const byteLength = parseArtifactByteLength(bytes.length);
  if (!byteLength.ok) return failure("byteLength", byteLength.error.message);
  return success(canonicalRecord({
    label,
    byteLength: byteLength.value,
    digest: digestBytes(bytes) as ArtifactDigest,
    bytes: Object.freeze([...bytes]),
  }));
}

/**
 * The digest identity of a packet: every field except the digest itself, in a
 * fixed order. Sections contribute their digests and lengths rather than their
 * bytes, so identity is stable and cheap while still covering the content.
 */
function packetIdentity(packet: Omit<ContextPacket, "digest">): string {
  const section = (entry: ByteSection): unknown =>
    ({ label: entry.label, digest: entry.digest, byteLength: entry.byteLength });
  return JSON.stringify({
    schemaVersion: packet.schemaVersion,
    requestId: packet.requestId,
    role: packet.role,
    requiredSkill: packet.requiredSkill,
    outputContract: packet.outputContract,
    fixedContext: packet.fixedContext.map(section),
    variableContext: packet.variableContext.map(section),
  });
}

export function contextPacketDigest(packet: Omit<ContextPacket, "digest">): ContextDigest {
  return sha256Hex(packetIdentity(packet)) as ContextDigest;
}

export type ContextPacketInput = Readonly<{
  requestId: RequestId;
  role: string;
  requiredSkill: string;
  outputContract: string;
  fixedContext: readonly ByteSection[];
  variableContext: readonly ByteSection[];
}>;

/** Build a packet and seal it with its own digest. */
export function buildContextPacket(input: ContextPacketInput): DomainResult<ContextPacket, ContextPacketError> {
  const invalid = requiredFieldProblem(input);
  if (invalid !== null) return failure(invalid.field, invalid.message);

  // Section identity must cover the exact bytes: a caller-supplied ByteSection
  // whose digest/byteLength do not match its bytes would otherwise let a
  // packet's content-addressed identity disagree with its content.
  const canonicalSections: ByteSection[] = [];
  const labels = new Set<string>();
  for (const [index, section] of [...input.fixedContext, ...input.variableContext].entries()) {
    const field = index < input.fixedContext.length
      ? `fixedContext[${index}]`
      : `variableContext[${index - input.fixedContext.length}]`;
    if (typeof section.label !== "string" || section.label.length === 0) {
      return failure(`${field}.label`, "a context section label must be a non-empty string");
    }
    if (labels.has(section.label)) {
      return failure(`${field}.label`, `a context section label must be unique: ${section.label}`);
    }
    labels.add(section.label);
    // Array.from materializes sparse holes as `undefined`; Array#every on the
    // caller's array would skip them and incorrectly accept a non-byte value.
    const bytes = Array.from(section.bytes);
    const parsedLength = parseArtifactByteLength(bytes.length);
    const verified = bytes.every(isByte) && parsedLength.ok && parsedLength.value === section.byteLength &&
      digestBytes(bytes) === section.digest;
    if (!verified) {
      return failure(field, "a context section must contain only bytes whose digest and length cover the exact content");
    }
    canonicalSections.push(canonicalRecord({
      label: section.label,
      byteLength: section.byteLength,
      digest: section.digest,
      bytes: Object.freeze([...bytes]),
    }));
  }
  const fixedContext = canonicalSections.slice(0, input.fixedContext.length);
  const variableContext = canonicalSections.slice(input.fixedContext.length);

  const withoutDigest = {
    schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
    requestId: input.requestId,
    role: input.role,
    requiredSkill: input.requiredSkill,
    outputContract: input.outputContract,
    fixedContext: Object.freeze(fixedContext),
    variableContext: Object.freeze(variableContext),
  } as const;

  return success(canonicalRecord({ ...withoutDigest, digest: contextPacketDigest(withoutDigest) }));
}

function requiredFieldProblem(input: ContextPacketInput): Readonly<{ field: string; message: string }> | null {
  const required: readonly (readonly [string, string])[] = [
    ["requestId", input.requestId],
    ["role", input.role],
    ["requiredSkill", input.requiredSkill],
    ["outputContract", input.outputContract],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.length === 0) {
      return { field, message: `a context packet requires a non-empty ${field}` };
    }
  }
  if (input.fixedContext.length === 0 && input.variableContext.length === 0) {
    return { field: "sections", message: "a context packet must carry at least one section" };
  }
  return null;
}

function parseSection(raw: unknown, field: string): DomainResult<ByteSection, ContextPacketError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure(field, "a context section must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["label"] !== "string" || record["label"].length === 0) {
    return failure(`${field}.label`, "a context section label must be a non-empty string");
  }
  if (!Array.isArray(record["bytes"])) return failure(`${field}.bytes`, "a context section must carry its bytes");
  const bytes = Array.from(record["bytes"] as readonly unknown[]);
  if (!bytes.every(isByte)) {
    return failure(`${field}.bytes`, "a context section byte must be an integer from 0 through 255");
  }
  const materialised = bytes as readonly number[];
  const byteLength = parseArtifactByteLength(materialised.length);
  if (!byteLength.ok) return failure(`${field}.byteLength`, byteLength.error.message);
  if (record["byteLength"] !== materialised.length) {
    return failure(`${field}.byteLength`, "a context section length must equal its byte count");
  }
  const digest = digestBytes(materialised);
  if (record["digest"] !== digest) {
    return failure(`${field}.digest`, "a context section digest must cover its exact bytes");
  }
  return success(canonicalRecord({
    label: record["label"],
    byteLength: byteLength.value,
    digest: digest as ArtifactDigest,
    bytes: Object.freeze([...materialised]),
  }));
}

function parseSections(raw: unknown, field: string): DomainResult<readonly ByteSection[], ContextPacketError> {
  if (!Array.isArray(raw)) return failure(field, `${field} must be an array`);
  const sections: ByteSection[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseSection(entry, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    sections.push(parsed.value);
  }
  return success(Object.freeze(sections));
}

/**
 * Parse an untrusted packet. Section digests are recomputed from the bytes and
 * the packet digest is recomputed from the parsed identity, so a packet whose
 * bytes were edited after publication cannot present its original digest.
 */
export function parseContextPacket(raw: unknown): DomainResult<ContextPacket, ContextPacketError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("packet", "a context packet must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== CONTEXT_PACKET_SCHEMA_VERSION) {
    return failure("schemaVersion", `a context packet must declare schema version ${CONTEXT_PACKET_SCHEMA_VERSION}`);
  }
  const fixedContext = parseSections(record["fixedContext"], "fixedContext");
  if (!fixedContext.ok) return fixedContext;
  const variableContext = parseSections(record["variableContext"], "variableContext");
  if (!variableContext.ok) return variableContext;

  // Request identity is a branded authority, not a free string: parse it
  // through the same parser every request authority uses, so a packet carrying
  // a malformed request id cannot cross this untrusted boundary as a
  // plausible RequestId (a later digest match would otherwise accept it).
  const requestId = parseRequestId(record["requestId"]);
  if (!requestId.ok) {
    return failure("requestId", `a context packet requestId must be a canonical authority id: ${requestId.error.message}`);
  }

  const built = buildContextPacket({
    requestId: requestId.value,
    role: record["role"] as string,
    requiredSkill: record["requiredSkill"] as string,
    outputContract: record["outputContract"] as string,
    fixedContext: fixedContext.value,
    variableContext: variableContext.value,
  });
  if (!built.ok) return built;
  if (record["digest"] !== built.value.digest) {
    return failure("digest", "a context packet digest must cover its exact identity and sections");
  }
  return success(built.value);
}

/** Total bytes a packet delivers — used to prove packets removed repeated bytes. */
export function contextPacketByteLength(packet: ContextPacket): number {
  return [...packet.fixedContext, ...packet.variableContext]
    .reduce((total, section) => total + section.byteLength, 0);
}
