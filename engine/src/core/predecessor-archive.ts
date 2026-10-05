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
 * Pure: no filesystem access. Bounds are the caller's policy and are passed in.
 */
import { gunzipSync } from "node:zlib";
import { match } from "ts-pattern";
import { sha256Bytes } from "./digest";
import { parseArtifactDigest, type ArtifactDigest, type DomainResult } from "./orchestration-contract";

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

const isPlainRecord = (raw: unknown): raw is Readonly<Record<string, unknown>> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);
const hasExactKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(record, key));
};
const boundedLength = (raw: unknown, maximum: number): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= maximum;

/** Parse one decoded retained record into the ADT; exact keys per encoding, every field typed. */
export function parsePredecessorArchiveRecord(raw: unknown, bounds: PredecessorArchiveBounds): Refused<PredecessorArchiveRecord> {
  if (!isPlainRecord(raw)) return refuse("malformed-record", "retained predecessor archive is not a JSON object");
  const digest = parseArtifactDigest(raw["digest"]);
  if (raw["encoding"] === "published-packet-reference") {
    const path = raw["path"], purpose = raw["purpose"];
    if (!hasExactKeys(raw, ["encoding", "byteLength", "digest", "path", "purpose"]) ||
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
    if (!hasExactKeys(raw, ["encoding", "contentBase64", "byteLength", "digest"]) ||
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

/** The reader's explicit archive selection: an exact retained label plus its decode purpose, or none. */
export type PredecessorArchiveSelection =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "archive"; label: string; purpose: PredecessorArchivePurpose }>;

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
