/**
 * Reading stored Context Packets: a packet file names its sections by
 * identity, and their bytes live once in the holding Run Directory's
 * content-addressed blob store (see `storedContextPacket` in the core). This
 * is the one read path — the Run Directory adapter, the reviewer-facing
 * reader script and cross-run predecessor walks all restore section bytes
 * through it, and the packet parsers then re-hash every section.
 */

import { dirname, join } from "node:path";
import { withStoredSectionBytes } from "../core/context-packets";
import type { DomainResult } from "../core/orchestration-contract";
import { readRunBytesNoFollow } from "./no-follow-fs";

/** The Run Directory child holding section blobs, one file per section digest. */
export const CONTEXT_SECTION_BLOBS = "blobs";

/** Byte bounds for one stored packet read: the packet file itself, and each
 *  section blob it names. A reference that pins the packet FILE's exact length
 *  bounds only the file; its sections carry their own bound. */
export type StoredPacketBounds = Readonly<{ file?: number; section?: number }>;

export type StoredContextRecord = Readonly<{
  record: unknown;
  /** Total bytes read from the blob store for this packet's sections. */
  sectionBytes: number;
}>;

/** A stored packet file's record with its section bytes restored from
 *  `runDirectory`'s blob store; each blob is read under `sectionBound`. */
export function readStoredContextRecord(
  runDirectory: string,
  packetFile: Buffer,
  sectionBound?: number,
): DomainResult<StoredContextRecord, string> {
  let sectionBytes = 0;
  const resolved = withStoredSectionBytes(JSON.parse(packetFile.toString("utf8")) as unknown, (digest) => {
    try {
      const bytes = readRunBytesNoFollow(join(runDirectory, CONTEXT_SECTION_BLOBS, digest), sectionBound);
      sectionBytes += bytes.length;
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
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
  bounds: StoredPacketBounds = {},
): DomainResult<Readonly<{ fileBytes: Buffer } & StoredContextRecord>, string> {
  try {
    const fileBytes = readRunBytesNoFollow(packetPath, bounds.file);
    const stored = readStoredContextRecord(dirname(dirname(packetPath)), fileBytes, bounds.section);
    return stored.ok ? { ok: true, value: Object.freeze({ fileBytes, ...stored.value }) } : stored;
  } catch (error) {
    return { ok: false, error: `context packet ${packetPath} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
