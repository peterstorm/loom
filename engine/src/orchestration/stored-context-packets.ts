/**
 * Reading stored Context Packets: a packet file names its sections by
 * identity, and their bytes live once in the holding Run Directory's
 * content-addressed blob store (see `storedContextPacket` in the core). This
 * is the one read path — the Run Directory adapter, the reviewer-facing
 * reader script and cross-run predecessor walks all restore section bytes
 * through it, and the packet parsers then re-hash every section. The
 * predecessor archive's port, `openStoredContextPacketFile`, shares the blob
 * read but hands the core exact file BYTES plus the blob lookup, so the core
 * derives the record from the very bytes it verified.
 */

import { dirname, join } from "node:path";
import { withStoredSectionBytes } from "../core/context-packets";
import type { DomainResult } from "../core/orchestration-contract";
import type { PublishedPacketFile } from "../core/predecessor-archive";
import { readRunBytesNoFollow } from "./no-follow-fs";

/** The Run Directory child holding section blobs, one file per section digest. */
export const CONTEXT_SECTION_BLOBS = "blobs";

/** The byte bound for one stored Context Packet file and for each section blob
 *  it names. Publication refuses anything larger, and every reader that bounds
 *  a stored packet (lineage authentication, the predecessor panel view, the
 *  section reader and native capture) uses this one bound, so a packet a review
 *  could publish is always readable again, on Claude Code and Pi alike. */
export const CONTEXT_PACKET_MAX_BYTES = 16_777_216;

/** Byte bounds for one stored packet read: the packet file itself, and each
 *  section blob it names. Both are required, so a read by path is never
 *  unbounded. A reference that pins the packet FILE's exact length bounds only
 *  the file; its sections carry their own bound. */
export type StoredPacketBounds = Readonly<{ file: number; section: number }>;

/** The bounds every publishable packet fits: CONTEXT_PACKET_MAX_BYTES for the
 *  file and for each section. */
export const CONTEXT_PACKET_BOUNDS: StoredPacketBounds = Object.freeze({
  file: CONTEXT_PACKET_MAX_BYTES,
  section: CONTEXT_PACKET_MAX_BYTES,
});

export type StoredContextRecord = Readonly<{
  record: unknown;
  /** Total bytes read from the blob store for this packet's sections. */
  sectionBytes: number;
}>;

/** A stored packet file's record with its section bytes restored from
 *  `runDirectory`'s blob store; each blob is read under `sectionBound`. The
 *  bound is explicit: `undefined` is the Run Directory handle's legacy
 *  unbounded `readContext`, which immutable pre-bound evidence still needs. */
/** One section blob of `runDirectory`'s store under `sectionBound`: `null`
 *  when absent; any other read failure throws for the caller to report. */
function readSectionBlob(runDirectory: string, digest: string, sectionBound: number | undefined): Buffer | null {
  try {
    return readRunBytesNoFollow(join(runDirectory, CONTEXT_SECTION_BLOBS, digest), sectionBound);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const unreadablePacket = (packetPath: string, error: unknown): string =>
  `context packet ${packetPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`;

export function readStoredContextRecord(
  runDirectory: string,
  packetFile: Buffer,
  sectionBound: number | undefined,
):DomainResult<StoredContextRecord, string> {
  let sectionBytes = 0;
  // A blob read fault other than absence throws past the restore, for the
  // caller's own unreadable-packet report.
  const resolved = withStoredSectionBytes(JSON.parse(packetFile.toString("utf8")) as unknown, (digest) => {
    const bytes = readSectionBlob(runDirectory, digest, sectionBound);
    if (bytes !== null) sectionBytes += bytes.length;
    return { ok: true, value: bytes };
  });
  return resolved.ok
    ? { ok: true, value: Object.freeze({ record: resolved.value, sectionBytes }) }
    : { ok: false, error: resolved.error.message };
}

/**
 * Read one stored packet file by path (`<run>/contexts/<digest>.json`) with its
 * section bytes restored. Returns the exact packet-file bytes read, for
 * byte-identity references, beside the record the packet parsers accept;
 * parsing stays with the caller, which knows the schema it expects.
 */
export function readStoredContextPacketFile(
  packetPath: string,
  bounds: StoredPacketBounds,
): DomainResult<Readonly<{ fileBytes: Buffer } & StoredContextRecord>, string> {
  try {
    const fileBytes = readRunBytesNoFollow(packetPath, bounds.file);
    const stored = readStoredContextRecord(dirname(dirname(packetPath)), fileBytes, bounds.section);
    return stored.ok ? { ok: true, value: Object.freeze({ fileBytes, ...stored.value }) } : stored;
  } catch (error) {
    return { ok: false, error: unreadablePacket(packetPath, error) };
  }
}

/**
 * The predecessor archive's published-packet port (`ResolvePublishedPacket`):
 * one stored packet file's exact bytes, read under `bounds.file`, and a lookup
 * of the holding run's section blobs under `bounds.section`. It never decodes
 * the file: `projectArchivedPredecessor` verifies these bytes against the
 * retained reference and derives the record from them, so the bytes and the
 * record it projects cannot disagree. A blob read failure other than absence
 * reports the same message `readStoredContextPacketFile` does.
 */
export function openStoredContextPacketFile(
  packetPath: string,
  bounds: StoredPacketBounds,
): DomainResult<PublishedPacketFile, string> {
  try {
    const fileBytes = readRunBytesNoFollow(packetPath, bounds.file);
    const runDirectory = dirname(dirname(packetPath));
    return { ok: true, value: Object.freeze({
      fileBytes,
      readSectionBlob: (digest: string): DomainResult<Uint8Array | null, string> => {
        try {
          return { ok: true, value: readSectionBlob(runDirectory, digest, bounds.section) };
        } catch (error) {
          return { ok: false, error: unreadablePacket(packetPath, error) };
        }
      },
    }) };
  } catch (error) {
    return { ok: false, error: unreadablePacket(packetPath, error) };
  }
}
