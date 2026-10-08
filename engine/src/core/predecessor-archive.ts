/**
 * The retained predecessor-archive record: the one owner of its shape.
 *
 * A standalone successor packet retains each issued predecessor Context Packet
 * as a `predecessor-context:<role>[:attempt-2]` section whose bytes are one
 * JSON record in exactly one of two encodings:
 *
 * - `published-packet-reference` — current issuance: the exact predecessor
 *   packet FILE is named by absolute path, length, SHA-256 and decode purpose;
 *   the original file stays mandatory.
 * - `gzip-base64` — earlier issuance: the exact packet bytes travel inline,
 *   gzip-compressed and canonically base64-encoded. Never written anew; an
 *   originally issued gzip record stays bounded-readable.
 *
 * The writer (successor source authentication) and the reader
 * (`scripts/read-context-packet.ts --archive`) both cross this seam: the record
 * is parsed into the ADT below, expanded under an explicit bound and checked
 * against its own length and digest here — never re-decoded inline elsewhere.
 * The reader's whole archive path is `projectArchivedPredecessor`, so the
 * predecessor trust rules (retained identity is data, decode purpose is
 * explicit) live here too; the published-packet file read is its one injected
 * port — bytes and a blob lookup only, so the record is derived here from the
 * verified bytes — and the script only parses arguments, reads the outer
 * packet and prints.
 * Pure: no filesystem access. Bounds are the caller's policy and are passed in.
 */
import { gunzipSync } from "node:zlib";
import { match } from "ts-pattern";
import { projectContextPacket, type ContextProjectionInput } from "./context-packet-projection";
import { parseStandaloneReviewerContextPacketV3, withStoredSectionBytes, type SectionBlobLookup } from "./context-packets";
import { sha256Bytes } from "./digest";
import { parseArtifactDigest, type ArtifactDigest, type DomainResult } from "./orchestration-contract";
import { hasExactPlainKeys, isRecord } from "./plain-record";

/** How the reader must decode the retained predecessor packet — explicit, never guessed. */
export type PredecessorArchivePurpose = "v1-v2" | "standalone-successor";
const isPurpose = (raw: unknown): raw is PredecessorArchivePurpose => raw === "v1-v2" || raw === "standalone-successor";

export type PublishedPacketReference = Readonly<{
  encoding: "published-packet-reference";
  byteLength: number;
  digest: ArtifactDigest;
  /** Absolute path of the predecessor's exact packet file. */
  path: string;
  purpose: PredecessorArchivePurpose;
}>;

export type GzipPredecessorArchive = Readonly<{
  encoding: "gzip-base64";
  byteLength: number;
  digest: ArtifactDigest;
  /** The canonically base64-decoded gzip stream. */
  compressed: Uint8Array;
}>;

export type PredecessorArchiveRecord = PublishedPacketReference | GzipPredecessorArchive;

/** Caller-owned ceilings: `expandedBytes` bounds `byteLength`, `encodedBytes` bounds `contentBase64`. */
export type PredecessorArchiveBounds = Readonly<{ expandedBytes: number; encodedBytes: number }>;

/**
 * Why a retained record is refused. `cause` carries a decoder's own thrown
 * error when one exists, so a shell that surfaces only the error class keeps
 * reporting the decoder's class rather than a generic one.
 */
export type PredecessorArchiveRefusal = Readonly<
  | { kind: "malformed-record"; message: string }
  | { kind: "unsupported-encoding"; message: string }
  | { kind: "invalid-reference"; message: string }
  | { kind: "invalid-gzip-record"; message: string }
  | { kind: "noncanonical-base64"; message: string }
  | { kind: "expansion-failed"; message: string; cause: unknown }
  | { kind: "bytes-differ"; message: string }
>;

type Refused<T> = DomainResult<T, PredecessorArchiveRefusal>;
const refuse = <T>(kind: Exclude<PredecessorArchiveRefusal["kind"], "expansion-failed">, message: string): Refused<T> =>
  ({ ok: false, error: { kind, message } });

// Record admission is the shared kernel's: `isRecord` asks only the shape
// question, and each encoding's exact key set is the STRICT predicate
// `hasExactPlainKeys` (own string keys only, symbol keys refused, a null or
// Object.prototype prototype required) — never the lax `hasExactKeys`. The
// refusal kinds here are fixed, so no kernel diagnostics are surfaced.
const boundedLength = (raw: unknown, maximum: number): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= maximum;

/** Parse one decoded retained record into the ADT; exact keys per encoding, every field typed. */
export function parsePredecessorArchiveRecord(raw: unknown, bounds: PredecessorArchiveBounds): Refused<PredecessorArchiveRecord> {
  if (!isRecord(raw)) return refuse("malformed-record", "retained predecessor archive is not a JSON object");
  const digest = parseArtifactDigest(raw["digest"]);
  if (raw["encoding"] === "published-packet-reference") {
    const path = raw["path"], purpose = raw["purpose"];
    if (!hasExactPlainKeys(raw, ["encoding", "byteLength", "digest", "path", "purpose"]) ||
        !boundedLength(raw["byteLength"], bounds.expandedBytes) || !digest.ok ||
        typeof path !== "string" || !path.startsWith("/") ||
        !isPurpose(purpose)) {
      return refuse("invalid-reference", "invalid explicit predecessor reference");
    }
    return { ok: true, value: Object.freeze({ encoding: "published-packet-reference", byteLength: raw["byteLength"],
      digest: digest.value, path, purpose }) };
  }
  if (raw["encoding"] === "gzip-base64") {
    const content = raw["contentBase64"];
    if (!hasExactPlainKeys(raw, ["encoding", "contentBase64", "byteLength", "digest"]) ||
        !boundedLength(raw["byteLength"], bounds.expandedBytes) || !digest.ok ||
        typeof content !== "string" || content.length > bounds.encodedBytes) {
      return refuse("invalid-gzip-record", "archive exceeds bounded expansion or compressed bound");
    }
    const compressed = Buffer.from(content, "base64");
    if (compressed.toString("base64") !== content) return refuse("noncanonical-base64", "invalid archive encoding");
    return { ok: true, value: Object.freeze({ encoding: "gzip-base64", byteLength: raw["byteLength"],
      digest: digest.value, compressed: new Uint8Array(compressed) }) };
  }
  return refuse("unsupported-encoding", "unsupported predecessor encoding");
}

/** Inflate an inline archive, refusing any output beyond its declared length. */
export function expandGzipPredecessorArchive(record: GzipPredecessorArchive): Refused<Buffer> {
  try {
    return { ok: true, value: gunzipSync(record.compressed, { maxOutputLength: record.byteLength }) };
  } catch (cause) {
    return { ok: false, error: { kind: "expansion-failed", message: "archive does not expand within its declared length", cause } };
  }
}

/** Exact retained bytes: the record's length and SHA-256 must both match. */
export function verifyPredecessorArchiveBytes(record: PredecessorArchiveRecord, bytes: Uint8Array): Refused<Uint8Array> {
  return bytes.byteLength === record.byteLength && sha256Bytes(bytes) === record.digest
    ? { ok: true, value: bytes }
    : refuse("bytes-differ", "archive bytes differ");
}

/** The reference a fresh successor issues for one exact published predecessor packet file. */
export function publishedPacketReference(packetBytes: Uint8Array, path: string,
  purpose: PredecessorArchivePurpose): PublishedPacketReference {
  // The one mint: SHA-256 hex over exact bytes is an artifact digest by construction.
  return Object.freeze({ encoding: "published-packet-reference", byteLength: packetBytes.byteLength,
    digest: sha256Bytes(packetBytes) as ArtifactDigest, path, purpose });
}

/** Wire bytes of a reference record. Key order is part of the issued packet bytes. */
export function serializePublishedPacketReference(reference: PublishedPacketReference): string {
  const { encoding, byteLength, digest, path, purpose } = reference;
  return JSON.stringify({ encoding, byteLength, digest, path, purpose });
}

/**
 * Writer-side resume check: a frozen retained record must still describe the
 * independently authenticated packet bytes. A reference must name exactly the
 * same file identity and purpose; an inline gzip record must expand to exactly
 * those bytes. Each refusal message is the one successor authentication reports.
 */
export function admitFrozenPredecessorArchive(frozen: unknown, packetBytes: Uint8Array,
  expected: PublishedPacketReference, encodedBytes: number): DomainResult<PredecessorArchiveRecord, string> {
  const referenceDiffers = "predecessor reference differs from independently authenticated exact packet";
  const identityDiffers = "predecessor archive identity differs from authenticated bytes";
  const notRetained = "predecessor archive does not retain exact authenticated Context Packet bytes";
  const parsed = parsePredecessorArchiveRecord(frozen, { expandedBytes: packetBytes.byteLength, encodedBytes });
  if (!parsed.ok) {
    return { ok: false, error: match(parsed.error.kind)
      .with("malformed-record", () => "invalid frozen predecessor archive")
      .with("invalid-reference", () => referenceDiffers)
      .with("noncanonical-base64", "expansion-failed", "bytes-differ", () => notRetained)
      .with("unsupported-encoding", "invalid-gzip-record", () => identityDiffers)
      .exhaustive() };
  }
  const record = parsed.value;
  if (record.encoding === "published-packet-reference") {
    return record.byteLength === expected.byteLength && record.digest === expected.digest &&
      record.path === expected.path && record.purpose === expected.purpose
      ? { ok: true, value: record } : { ok: false, error: referenceDiffers };
  }
  if (record.byteLength !== expected.byteLength || record.digest !== expected.digest) return { ok: false, error: identityDiffers };
  const expanded = expandGzipPredecessorArchive(record);
  return expanded.ok && Buffer.compare(expanded.value, packetBytes) === 0
    ? { ok: true, value: record } : { ok: false, error: notRetained };
}

/** One explicit archive read: an exact retained label plus its decode purpose. */
export type PredecessorArchiveRead = Readonly<{ kind: "archive"; label: string; purpose: PredecessorArchivePurpose }>;

/** The reader's explicit archive selection: one archive read, or none. */
export type PredecessorArchiveSelection = Readonly<{ kind: "none" }> | PredecessorArchiveRead;

/**
 * Split reader arguments into the projection's own arguments and the archive
 * selection. `--archive` and `--archive-purpose` come together exactly once
 * each, or not at all.
 */
export function parsePredecessorArchiveArguments(args: readonly string[]):
  DomainResult<Readonly<{ regular: readonly string[]; selection: PredecessorArchiveSelection }>, string> {
  const regular: string[] = [];
  const archive = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (value === undefined) return { ok: false, error: "missing reader argument" };
    if (key === "--archive" || key === "--archive-purpose") {
      if (archive.has(key)) return { ok: false, error: "duplicate archive selection" };
      archive.set(key, value);
    } else regular.push(key, value);
  }
  if (archive.size === 0) return { ok: true, value: { regular, selection: { kind: "none" } } };
  const label = archive.get("--archive"), purpose = archive.get("--archive-purpose");
  if (label === undefined || !isPurpose(purpose)) {
    return { ok: false, error: "archive requires exact label and explicit --archive-purpose v1-v2 or standalone-successor" };
  }
  return { ok: true, value: { regular, selection: { kind: "archive", label, purpose } } };
}

/**
 * One published predecessor packet as the port reads it: the exact packet FILE
 * bytes and the predecessor run's section-blob lookup — BYTES only, never a
 * decoded record. The record the predecessor projection reads is derived here
 * from the very bytes verified against the reference, so the port cannot hand
 * over a record that disagrees with them; a blob it serves under the wrong
 * digest is refused by the packet parser's per-section re-hash. A lookup
 * answers `null` for an absent blob and refuses an unreadable one.
 */
export type PublishedPacketFile = Readonly<{
  fileBytes: Uint8Array;
  readSectionBlob: SectionBlobLookup;
}>;

/**
 * The archive projection's single port: the exact predecessor packet FILE a
 * reference names, its file bound at the reference's own `byteLength`. The
 * production adapter is `openStoredContextPacketFile`; tests pass a plain
 * in-memory lookup.
 */
export type ResolvePublishedPacket = (reference: PublishedPacketReference) => DomainResult<PublishedPacketFile, string>;

/**
 * Why an archive read is refused. `decoder-failed` carries a decoder's own
 * thrown error (fatal UTF-8, JSON, gunzip), so a shell that surfaces only the
 * error class keeps reporting the decoder's class; every other refusal is
 * `refused`. Neither grants authority.
 */
export type ArchivedPredecessorRefusal = Readonly<
  | { kind: "refused"; message: string }
  | { kind: "decoder-failed"; message: string; cause: unknown }
>;

type ArchiveRead<T> = DomainResult<T, ArchivedPredecessorRefusal>;
const archiveRefused = <T>(message: string): ArchiveRead<T> => ({ ok: false, error: { kind: "refused", message } });
const fromRecordRefusal = <T>(refusal: PredecessorArchiveRefusal): ArchiveRead<T> => ({ ok: false,
  error: refusal.kind === "expansion-failed"
    ? { kind: "decoder-failed", message: refusal.message, cause: refusal.cause }
    : { kind: "refused", message: refusal.message } });

/** Exact bytes as fatal UTF-8 JSON; a decoder's own throw is retained as the cause. */
function decodeJsonBytes(bytes: Uint8Array, subject: string): ArchiveRead<unknown> {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch (cause) {
    return { ok: false, error: { kind: "decoder-failed", message: `${subject} is not UTF-8 JSON`, cause } };
  }
}

/**
 * One retained encoding's expanded bytes, still unverified: a reference's
 * exact packet file with its run's blob lookup, or an inline archive's
 * inflated bytes. Neither carries a decoded record — that is derived only
 * from bytes `verifyPredecessorArchiveBytes` accepted.
 */
type ExpandedPredecessor =
  | Readonly<{ encoding: "published-packet-reference"; bytes: Uint8Array; readSectionBlob: PublishedPacketFile["readSectionBlob"] }>
  | Readonly<{ encoding: "gzip-base64"; bytes: Uint8Array }>;

function expandRetainedEncoding(retained: PredecessorArchiveRecord, purpose: PredecessorArchivePurpose,
  resolveReference: ResolvePublishedPacket): ArchiveRead<ExpandedPredecessor> {
  if (retained.encoding === "published-packet-reference") {
    // Decode purpose is explicit on both sides and must agree, never guessed.
    if (retained.purpose !== purpose) return archiveRefused("invalid explicit predecessor reference");
    // The reference pins the predecessor's packet FILE bytes; its sections
    // resolve from the predecessor run's own blob store.
    const predecessor = resolveReference(retained);
    if (!predecessor.ok) return archiveRefused(predecessor.error);
    return { ok: true, value: Object.freeze({ encoding: "published-packet-reference",
      bytes: predecessor.value.fileBytes, readSectionBlob: predecessor.value.readSectionBlob }) };
  }
  const expanded = expandGzipPredecessorArchive(retained);
  return expanded.ok ? { ok: true, value: Object.freeze({ encoding: "gzip-base64", bytes: expanded.value }) } : fromRecordRefusal(expanded.error);
}

/**
 * The predecessor packet record carried by VERIFIED bytes: decoded from those
 * bytes alone, a reference's stored sections then restored through its run's
 * blob lookup (each restored section is re-hashed by the packet parser). An
 * inline archive's bytes are decoded as they are, exactly as issued.
 */
function predecessorRecord(expanded: ExpandedPredecessor, verified: Uint8Array): ArchiveRead<unknown> {
  if (expanded.encoding === "gzip-base64") return decodeJsonBytes(verified, "expanded predecessor archive");
  const decoded = decodeJsonBytes(verified, "published predecessor packet");
  if (!decoded.ok) return decoded;
  // The restore seam carries the lookup's own refusal: an unreadable blob is
  // refused with the lookup's message, an absent one with the restore's.
  const restored = withStoredSectionBytes(decoded.value, expanded.readSectionBlob);
  return restored.ok ? { ok: true, value: restored.value } : archiveRefused(restored.error.message);
}

const ARCHIVED_IDENTITY = ["requestId", "digest", "role", "requiredSkill"] as const;
type ArchivedIdentity = Readonly<Record<(typeof ARCHIVED_IDENTITY)[number], string>>;

/** The identity fields of an archived predecessor packet, as the strings the projection binds. */
function archivedIdentity(prior: unknown): ArchiveRead<ArchivedIdentity> {
  const field = (key: string): unknown => typeof prior === "object" && prior !== null ? (prior as Record<string, unknown>)[key] : undefined;
  const missing = ARCHIVED_IDENTITY.find((key) => typeof field(key) !== "string");
  if (missing !== undefined) return archiveRefused(`archived predecessor packet lacks a string ${missing}`);
  return { ok: true, value: Object.freeze(Object.fromEntries(ARCHIVED_IDENTITY.map((key) => [key, field(key)]))) as ArchivedIdentity };
}

/**
 * Project one retained predecessor Context Packet out of a standalone
 * successor packet — the reader's `--archive` path, whole.
 *
 * The outer successor packet is admitted first by its own exact issued
 * identity (`input`, which must carry the successor purpose); the selected
 * label must be a `predecessor-context:` section of it. The retained record is
 * parsed, expanded through its one encoding (a reference through
 * `resolveReference`, an inline gzip record under its declared length), and
 * its bytes verified against the record's own length and digest. The
 * predecessor record is then DERIVED from those verified bytes (a reference's
 * stored sections restored through its blob lookup), never taken from the
 * port. Only then is the predecessor projected, under the identity it
 * retains: that identity is DATA inside the independently selected outer
 * section, never authority for issuance or capture, and the predecessor's
 * decode purpose is the explicit selection's. Refusal order is fixed: outer
 * purpose, outer identity (naming the outer projection's own refusal), outer
 * contract, label, record decode, record shape, expansion, byte identity,
 * predecessor record decode and section restore, retained identity,
 * predecessor projection.
 */
export function projectArchivedPredecessor(outer: unknown, input: ContextProjectionInput,
  selection: PredecessorArchiveRead,
  archive: Readonly<{ bounds: PredecessorArchiveBounds; resolveReference: ResolvePublishedPacket }>): ArchiveRead<unknown> {
  const notSuccessor = "archive requires exact successor packet identity";
  if (input.purpose !== "standalone-successor") return archiveRefused(notSuccessor);
  const outerIndex = projectContextPacket(outer, { ...input, selection: { kind: "index", offset: 0, limit: 32 } });
  // The outer projection's own refusal (integrity, digest or identity
  // mismatch) is named, so an operator can tell which check failed.
  if (!outerIndex.ok) return archiveRefused(`${notSuccessor}: ${outerIndex.error}`);
  const packet = parseStandaloneReviewerContextPacketV3(outer);
  if (!packet.ok) return archiveRefused(packet.error.message);
  const section = packet.value.variableContext.find((row) => row.label === selection.label && row.label.startsWith("predecessor-context:"));
  if (section === undefined) return archiveRefused("archive label is absent");
  const decoded = decodeJsonBytes(Uint8Array.from(section.bytes), "retained predecessor archive");
  if (!decoded.ok) return decoded;
  const retained = parsePredecessorArchiveRecord(decoded.value, archive.bounds);
  if (!retained.ok) return fromRecordRefusal(retained.error);
  const expansion = expandRetainedEncoding(retained.value, selection.purpose, archive.resolveReference);
  if (!expansion.ok) return expansion;
  const verified = verifyPredecessorArchiveBytes(retained.value, expansion.value.bytes);
  if (!verified.ok) return fromRecordRefusal(verified.error);
  const prior = predecessorRecord(expansion.value, verified.value);
  if (!prior.ok) return prior;
  const identity = archivedIdentity(prior.value);
  if (!identity.ok) return identity;
  const projected = projectContextPacket(prior.value, { ...input, ...identity.value,
    purpose: selection.purpose === "standalone-successor" ? "standalone-successor" : undefined });
  return projected.ok ? projected : archiveRefused(projected.error);
}
