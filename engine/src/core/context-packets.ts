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

import { match } from "ts-pattern";
import { STANDALONE_REVIEWER_PROTOCOL_V3, STANDALONE_REVIEWER_FIXED_SECTIONS_V3, parseStandaloneReviewerProtocolV3 } from "./standalone-lineage-contract";
import { sha256Bytes, sha256Hex } from "./review-packet";
import { isStandaloneReviewAgent } from "./model-profiles";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import {
  CURRENT_REVIEWER_PROTOCOL, REVIEWER_FIXED_SECTIONS, REVIEWER_OUTPUT_CONTRACT,
  parseReviewerProtocolDescriptor, type ReviewerProtocolDescriptor,
} from "./reviewer-contract";
import {
  boundedThrownCause,
  canonicalRecord,
  parseArtifactByteLength,
  parseRequestId,
  IMMUTABLE_BYTE_SEQUENCE_TAG,
  type ArtifactByteLength,
  type ArtifactDigest,
  type ContextDigest,
  type DomainResult,
  type RequestId,
} from "./orchestration-contract";

export const CONTEXT_PACKET_SCHEMA_VERSION = 1;
export const REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION = 2;

const CONTEXT_PACKET_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "digest",
  "requestId",
  "role",
  "requiredSkill",
  "outputContract",
  "fixedContext",
  "variableContext",
]);
const CONTEXT_SECTION_FIELDS: ReadonlySet<string> = new Set([
  "label",
  "byteLength",
  "digest",
  "bytes",
]);

/** Immutable byte sequence. Deliberately not Array-shaped: reflection and
 * cloning semantics are not part of the Context Packet contract. */
export type ImmutableByteSequence = Readonly<{
  readonly [index: number]: number | undefined;
  length: number;
  byteLength: number;
  at(index: number): number | undefined;
  slice(start?: number, end?: number): readonly number[];
  some(predicate: (byte: number, index: number) => boolean): boolean;
  valueOf(): Uint8Array;
  toJSON(): readonly number[];
  [Symbol.iterator](): IterableIterator<number>;
}>;

/** One labelled, digested run of exact bytes inside a packet. */
export type ByteSection = Readonly<{
  label: string;
  byteLength: ArtifactByteLength;
  digest: ArtifactDigest;
  bytes: ImmutableByteSequence;
}>;

export type LegacyContextPacket = Readonly<{
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

export type ReviewerContextPacketV2 = Readonly<Omit<LegacyContextPacket, "schemaVersion"> & {
  schemaVersion: typeof REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION;
  reviewerProtocol: ReviewerProtocolDescriptor;
}>;
export type StandaloneReviewerContextPacketV3 = Readonly<Omit<LegacyContextPacket, "schemaVersion"> & {
  schemaVersion: 3;
  reviewerProtocol: typeof STANDALONE_REVIEWER_PROTOCOL_V3;
}>;
export type ContextPacket = LegacyContextPacket | ReviewerContextPacketV2;
type ContextPacketIdentity = Omit<LegacyContextPacket, "digest"> | Omit<ReviewerContextPacketV2, "digest"> | Omit<StandaloneReviewerContextPacketV3, "digest">;

export type ContextPacketError = Readonly<{
  kind: "invalid-context-packet";
  field: string;
  message: string;
}>;

const failure = <T>(field: string, message: string): DomainResult<T, ContextPacketError> =>
  ({ ok: false, error: canonicalRecord({ kind: "invalid-context-packet" as const, field, message }) });

const success = <T>(value: T): DomainResult<T, ContextPacketError> => ({ ok: true, value });

const encoder = new TextEncoder();
// Membership covers only deeply immutable constructor/parser outputs, never caller-frozen objects.
const sealedSections = new WeakSet<object>();
const sealedSuccessorPackets = new WeakSet<object>();
const sealedSectionJson = new WeakMap<ByteSection, string>();

const isByte = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;

/** The ONE owner of the Context Packet byte grammar: a dense iterable of
 *  integers 0–255 whose count stays within `maximum`.
 *
 *  `Array.from` materializes sparse holes as `undefined`, which fails the byte
 *  test — density is enforced by the same check, not by a separate pass. Every
 *  byte-section consumer (packet build, packet parse, and the successor
 *  registration parser) accepts bytes ONLY through this validator, so the
 *  successor path cannot drift from the packet parser on what a legal section
 *  is. The violation is typed so each caller can keep its own exact refusal
 *  prose while sharing the grammar itself. */
export type ByteGrammarViolation =
  | Readonly<{ rule: "iterable" }>
  | Readonly<{ rule: "bound"; count: number; maximum: number }>
  | Readonly<{ rule: "byte" }>;

const grammarFailure = (violation: ByteGrammarViolation): DomainResult<Uint8Array, ByteGrammarViolation> =>
  ({ ok: false, error: canonicalRecord(violation) });
const grammarSuccess = (bytes: Uint8Array): DomainResult<Uint8Array, ByteGrammarViolation> =>
  ({ ok: true, value: bytes });

const MAX_SAFE_BYTE_BOUND: number = Number.MAX_SAFE_INTEGER;

export function boundedByteIterable(
  raw: unknown,
  maximum: number,
): DomainResult<Uint8Array, ByteGrammarViolation> {
  if (!Array.isArray(raw) &&
      !(typeof raw === "object" && raw !== null &&
        typeof (raw as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function")) {
    return grammarFailure({ rule: "iterable" });
  }
  const bytes = Array.from(raw as Iterable<unknown>);
  if (bytes.length > maximum) {
    return grammarFailure({ rule: "bound", count: bytes.length, maximum });
  }
  if (!bytes.every(isByte)) {
    return grammarFailure({ rule: "byte" });
  }
  return grammarSuccess(Uint8Array.from(bytes));
}

/** The packet parser's exact prose for each shared-grammar violation. The
 *  switch is exhaustive over `ByteGrammarViolation`: adding a rule without a
 *  labelled refusal arm is a noImplicitReturns compile error. */
const byteGrammarRefusal = (violation: ByteGrammarViolation): string => {
  switch (violation.rule) {
    case "iterable": return "a context section must carry iterable bytes";
    case "byte": return "a context section byte must be an integer from 0 through 255";
    case "bound": return `a context section must not exceed ${violation.maximum} bytes`;
  }
};

const immutableByteStorage = new WeakMap<object, Uint8Array>();

function storedBytes(sequence: ImmutableByteSequence): Uint8Array {
  const stored = immutableByteStorage.get(sequence);
  if (stored === undefined) throw new TypeError("unrecognized immutable byte sequence");
  return stored;
}

const immutableByteSequencePrototype: ImmutableByteSequence = Object.freeze({
  get length(): number { return storedBytes(this).byteLength; },
  get byteLength(): number { return storedBytes(this).byteLength; },
  at(index: number): number | undefined { return storedBytes(this).at(index); },
  slice(start?: number, end?: number): readonly number[] {
    return Object.freeze(Array.from(storedBytes(this).slice(start, end)));
  },
  some(predicate: (byte: number, index: number) => boolean): boolean {
    return storedBytes(this).some(predicate);
  },
  valueOf(): Uint8Array { return Uint8Array.from(storedBytes(this)); },
  toJSON(): readonly number[] { return Array.from(storedBytes(this)); },
  [Symbol.iterator](): IterableIterator<number> { return storedBytes(this).values(); },
  // The equality kernel's recognition tag (orchestration-contract/identity.ts).
  // Enumerable symbol keys stay invisible to Object.keys, spread-free JSON, and
  // the wire form, so this does not widen the sequence contract.
  [IMMUTABLE_BYTE_SEQUENCE_TAG]: true,
} as ImmutableByteSequence);

/** Private compact storage with no reflective Array promises. */
function immutableBytes(owned: Uint8Array): ImmutableByteSequence {
  const target = Object.create(immutableByteSequencePrototype) as ImmutableByteSequence;
  const sequence = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property)) {
        return owned.at(Number(property));
      }
      return Reflect.get(object, property, receiver);
    },
  });
  immutableByteStorage.set(sequence, owned);
  return Object.freeze(sequence);
}

function digestBytes(bytes: ImmutableByteSequence | readonly number[] | Uint8Array): string {
  return sha256Bytes(immutableByteStorage.get(bytes) ?? Uint8Array.from(bytes));
}

/**
 * Encode one section. The label is metadata; only `text` contributes bytes,
 * and it is encoded verbatim.
 */
export function encodeByteSection(label: string, text: string): DomainResult<ByteSection, ContextPacketError> {
  if (label.length === 0) return failure("label", "a context section label must not be empty");
  const bytes = immutableBytes(encoder.encode(text));
  const byteLength = parseArtifactByteLength(bytes.byteLength);
  if (!byteLength.ok) return failure("byteLength", byteLength.error.message);
  const section = canonicalRecord({ label, byteLength: byteLength.value,
    digest: digestBytes(bytes) as ArtifactDigest, bytes });
  sealedSections.add(section);
  return success(section);
}

/**
 * The digest identity of a packet: every field except the digest itself, in a
 * fixed order. Sections contribute their digests and lengths rather than their
 * bytes, so identity is stable and cheap while still covering the content.
 */
function packetIdentity(packet: ContextPacketIdentity): string {
  const section = (entry: ByteSection): unknown =>
    ({ label: entry.label, digest: entry.digest, byteLength: entry.byteLength });
  return JSON.stringify({
    schemaVersion: packet.schemaVersion,
    requestId: packet.requestId,
    role: packet.role,
    requiredSkill: packet.requiredSkill,
    outputContract: packet.outputContract,
    ...match(packet)
      .with({ schemaVersion: 1 }, () => ({}))
      .with({ schemaVersion: 2 }, { schemaVersion: 3 }, ({ reviewerProtocol }) => ({ reviewerProtocol }))
      .exhaustive(),
    fixedContext: packet.fixedContext.map(section),
    variableContext: packet.variableContext.map(section),
  });
}

export function contextPacketDigest(packet: ContextPacketIdentity): ContextDigest {
  return sha256Hex(packetIdentity(packet)) as ContextDigest;
}

export type ByteSectionInput = Readonly<Omit<ByteSection, "bytes"> & { bytes: Iterable<number> }>;

export type ContextPacketInput = Readonly<{
  requestId: RequestId;
  role: string;
  requiredSkill: string;
  outputContract: string;
  fixedContext: readonly ByteSectionInput[];
  variableContext: readonly ByteSectionInput[];
}>;

/** Build a packet and seal it with its own digest. */
export function buildContextPacket(input: ContextPacketInput): DomainResult<LegacyContextPacket, ContextPacketError> {
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
    if (sealedSections.has(section)) { canonicalSections.push(section as ByteSection); continue; }
    // The byte grammar lives in `boundedByteIterable`: iterability, the 0–255
    // integer test, and the bound (the section's own declared byteLength —
    // over-length bytes fail here exactly as the length equality below would).
    const materialized = boundedByteIterable(section.bytes, section.byteLength);
    if (!materialized.ok) {
      return failure(field, "a context section must contain only bytes whose digest and length cover the exact content");
    }
    const bytes = materialized.value;
    // boundedByteIterable already bounds bytes.length ≤ the declared section
    // byteLength (an ArtifactByteLength), so the length arm needs no second
    // range parse (cs-6): the exactness predicate is the equality plus digest.
    const verified = bytes.length === section.byteLength && digestBytes(bytes) === section.digest;
    if (!verified) {
      return failure(field, "a context section must contain only bytes whose digest and length cover the exact content");
    }
    canonicalSections.push(canonicalRecord({
      label: section.label,
      byteLength: section.byteLength,
      digest: section.digest,
      bytes: immutableBytes(bytes),
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

const reservedLabel = (label: string): boolean => REVIEWER_FIXED_SECTIONS.some((section) => section.label === label);

type ReviewerContractProblem = Readonly<{ field: string; message: string }> | null;
function validateReviewerContract(base: LegacyContextPacket,
  expectedSections: readonly Readonly<{ label: string; text: string }>[], identityProblem: ReviewerContractProblem,
  sectionKind: string): DomainResult<LegacyContextPacket, ContextPacketError> {
  if (identityProblem !== null) return failure(identityProblem.field, identityProblem.message);
  if (base.variableContext.some((section) => reservedLabel(section.label))) {
    return failure("variableContext", "reviewer contract sections must be fixed");
  }
  for (const expected of expectedSections) {
    const actual = base.fixedContext.find((section) => section.label === expected.label);
    const bytes = encoder.encode(expected.text);
    if (actual === undefined || actual.bytes.byteLength !== bytes.length || actual.bytes.some((byte, index) => byte !== bytes[index])) {
      return failure("fixedContext", `${sectionKind} ${expected.label} must contain the exact supported bytes`);
    }
  }
  return success(base);
}

function reviewerPacket(base: LegacyContextPacket): DomainResult<ReviewerContextPacketV2, ContextPacketError> {
  let identityProblem: ReviewerContractProblem = null;
  if (!isStandaloneReviewAgent(base.role)) {
    identityProblem = { field: "role", message: "only reviewer roles may receive a reviewer v2 packet" };
  } else if (base.outputContract !== REVIEWER_OUTPUT_CONTRACT) {
    identityProblem = { field: "outputContract", message: "reviewer output contract must match the supported contract exactly" };
  }
  const validated = validateReviewerContract(base, REVIEWER_FIXED_SECTIONS, identityProblem, "reviewer section");
  if (!validated.ok) return validated;
  const identity = {
    schemaVersion: REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION,
    requestId: base.requestId, role: base.role, requiredSkill: base.requiredSkill,
    outputContract: base.outputContract, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
    fixedContext: base.fixedContext, variableContext: base.variableContext,
  } as const;
  return success(canonicalRecord({ ...identity, digest: contextPacketDigest(identity) }));
}

/** Reserved sections are always engine-owned, whichever explicit grammar is issued. */
function buildReviewerContractBase(input: Omit<ContextPacketInput, "outputContract">,
  sections: readonly Readonly<{ label: string; text: string }>[],
): DomainResult<LegacyContextPacket, ContextPacketError> {
  if ([...input.fixedContext, ...input.variableContext].some((section) => reservedLabel(section.label))) {
    return failure("sections", "caller sections must not collide with reserved reviewer contract labels");
  }
  const fixed: ByteSectionInput[] = [...input.fixedContext];
  for (const section of sections) {
    const encoded = encodeByteSection(section.label, section.text);
    if (!encoded.ok) return encoded;
    fixed.push(encoded.value);
  }
  return buildContextPacket({ ...input, outputContract: REVIEWER_OUTPUT_CONTRACT, fixedContext: fixed });
}

/** Independent standalone and Wave issuance remain v2. */
export function buildReviewerContextPacket(input: Omit<ContextPacketInput, "outputContract">): DomainResult<ReviewerContextPacketV2, ContextPacketError> {
  const base = buildReviewerContractBase(input, REVIEWER_FIXED_SECTIONS);
  return base.ok ? reviewerPacket(base.value) : base;
}

function standaloneSuccessorPacket(base: LegacyContextPacket): DomainResult<StandaloneReviewerContextPacketV3, ContextPacketError> {
  const identityProblem = !isStandaloneReviewAgent(base.role) || base.outputContract !== REVIEWER_OUTPUT_CONTRACT
    ? { field: "role", message: "standalone v3 requires a reviewer and the exact output contract" }
    : null;
  const validated = validateReviewerContract(
    base, STANDALONE_REVIEWER_FIXED_SECTIONS_V3, identityProblem, "standalone v3 section",
  );
  if (!validated.ok) return validated;
  const identity = { schemaVersion: 3 as const, requestId: base.requestId, role: base.role, requiredSkill: base.requiredSkill,
    outputContract: base.outputContract, reviewerProtocol: STANDALONE_REVIEWER_PROTOCOL_V3,
    fixedContext: base.fixedContext, variableContext: base.variableContext };
  const packet = canonicalRecord({ ...identity, digest: contextPacketDigest(identity) });
  sealedSuccessorPackets.add(packet);
  return success(packet);
}

/** Explicit standalone successor v3 issuance; independent standalone and Wave builders remain v2. */
export function buildStandaloneReviewerContextPacketV3(input: Omit<ContextPacketInput, "outputContract">): DomainResult<StandaloneReviewerContextPacketV3, ContextPacketError> {
  const base = buildReviewerContractBase(input, STANDALONE_REVIEWER_FIXED_SECTIONS_V3);
  return base.ok ? standaloneSuccessorPacket(base.value) : base;
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
  if (sealedSections.has(raw)) return success(raw as ByteSection);
  const record = raw as Record<string, unknown>;
  const undeclaredField = Object.keys(record).find((key) => !CONTEXT_SECTION_FIELDS.has(key));
  if (undeclaredField !== undefined) {
    return failure(`${field}.${undeclaredField}`, `a context section must not contain undeclared field ${undeclaredField}`);
  }
  if (typeof record["label"] !== "string" || record["label"].length === 0) {
    return failure(`${field}.label`, "a context section label must be a non-empty string");
  }
  const materialisedBytes = boundedByteIterable(record["bytes"], MAX_SAFE_BYTE_BOUND);
  if (!materialisedBytes.ok) {
    return failure(`${field}.bytes`, byteGrammarRefusal(materialisedBytes.error));
  }
  const materialised = immutableBytes(materialisedBytes.value);
  const byteLength = parseArtifactByteLength(materialised.byteLength);
  if (!byteLength.ok) return failure(`${field}.byteLength`, byteLength.error.message);
  if (record["byteLength"] !== materialised.byteLength) {
    return failure(`${field}.byteLength`, "a context section length must equal its byte count");
  }
  const digest = digestBytes(materialised);
  if (record["digest"] !== digest) {
    return failure(`${field}.digest`, "a context section digest must cover its exact bytes");
  }
  const section = canonicalRecord({ label: record["label"], byteLength: byteLength.value,
    digest: digest as ArtifactDigest, bytes: materialised });
  sealedSections.add(section);
  return success(section);
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
 *
 * Thrown-cause capture is the kernel's ONE boundedThrownCause
 * (orchestration-contract): the parsers below call it directly with the packet
 * subjects, so the 256-char budget and truncation shape cannot drift between
 * the layers.
 */
export function parseContextPacket(raw: unknown): DomainResult<ContextPacket, ContextPacketError> {
  try {
    const parsed = parseContextPacketRecord(raw);
    if (!parsed.ok) return parsed;
    return parsed.value.schemaVersion === 3
      ? failure("schemaVersion", "standalone v3 requires explicit successor Context Packet parsing") : success(parsed.value);
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "context packet");
    return failure("packet", `context packet could not be inspected safely (${cause.name}: ${cause.message})`);
  }
}

export function parseStandaloneReviewerContextPacketV3(raw: unknown): DomainResult<StandaloneReviewerContextPacketV3, ContextPacketError> {
  try {
    if (typeof raw === "object" && raw !== null && sealedSuccessorPackets.has(raw)) return success(raw as StandaloneReviewerContextPacketV3);
    const parsed = parseContextPacketRecord(raw);
    if (!parsed.ok) return parsed;
    return parsed.value.schemaVersion === 3 ? success(parsed.value)
      : failure("schemaVersion", "standalone successor Context Packet must declare schema version 3");
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "standalone successor context packet");
    return failure("packet", `standalone successor context packet could not be inspected safely (${cause.name}: ${cause.message})`);
  }
}

/** Exact JSON.stringify bytes; reuse only constructor/parser-owned immutable sections across the roster. */
export function serializeStandaloneReviewerContextPacketV3(raw: unknown): DomainResult<string, ContextPacketError> {
  const parsed = parseStandaloneReviewerContextPacketV3(raw);
  if (!parsed.ok) return parsed;
  const sectionJson = (section: ByteSection): string => {
    const retained = sealedSectionJson.get(section);
    if (retained !== undefined) return retained;
    const text = JSON.stringify(section);
    sealedSectionJson.set(section, text);
    return text;
  };
  const packet = parsed.value;
  return success("{" + Object.entries(packet).map(([key, value]) => {
    const prefix = JSON.stringify(key) + ":";
    if (key === "fixedContext") return prefix + "[" + packet.fixedContext.map(sectionJson).join(",") + "]";
    if (key === "variableContext") return prefix + "[" + packet.variableContext.map(sectionJson).join(",") + "]";
    return prefix + JSON.stringify(value);
  }).join(",") + "}");
}

function parseContextPacketHeader(raw: unknown): DomainResult<Record<string, unknown>, ContextPacketError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("packet", "a context packet must be an object");
  }
  let record = raw as Record<string, unknown>;
  const successor = record["schemaVersion"] === 3;
  const current = record["schemaVersion"] === REVIEWER_CONTEXT_PACKET_SCHEMA_VERSION || successor;
  if (current) {
    const inspected = readExactDataRecord(raw, [...CONTEXT_PACKET_FIELDS, "reviewerProtocol"], "reviewer context packet");
    if (!inspected.ok) return failure("packet", "reviewer context packet must contain only own data fields");
    record = inspected.value;
  }
  const undeclaredField = Object.keys(record).find((field) => !CONTEXT_PACKET_FIELDS.has(field) && !(current && field === "reviewerProtocol"));
  if (undeclaredField !== undefined) {
    return failure(`packet.${undeclaredField}`, `a context packet must not contain undeclared field ${undeclaredField}`);
  }
  if (!current && record["schemaVersion"] !== CONTEXT_PACKET_SCHEMA_VERSION) {
    return failure("schemaVersion", "a context packet must declare supported schema version 1 or 2");
  }
  if (current) {
    const descriptor = successor ? parseStandaloneReviewerProtocolV3(record["reviewerProtocol"]) : parseReviewerProtocolDescriptor(record["reviewerProtocol"]);
    if (!descriptor.ok) return failure("reviewerProtocol", descriptor.error.message);
  }
  return success(record);
}

function parseContextPacketRecord(raw: unknown): DomainResult<ContextPacket | StandaloneReviewerContextPacketV3, ContextPacketError> {
  const header = parseContextPacketHeader(raw);
  if (!header.ok) return header;
  const record = header.value;
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
  const packet = match(record["schemaVersion"])
    .with(3, () => standaloneSuccessorPacket(built.value))
    .with(2, () => reviewerPacket(built.value))
    .otherwise(() => built);
  if (!packet.ok) return packet;
  if (record["digest"] !== packet.value.digest) {
    return failure("digest", "a context packet digest must cover its exact identity and sections");
  }
  return packet;
}

/** Section payload bytes only; excludes packet metadata and JSON serialization overhead. */
export function contextPacketByteLength(packet: ContextPacket): number {
  return [...packet.fixedContext, ...packet.variableContext]
    .reduce((total, section) => total + section.byteLength, 0);
}
