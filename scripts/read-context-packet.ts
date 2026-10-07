#!/usr/bin/env bun
/**
 * Read-only projection. No Run handle, publication, mutable source or execution authority.
 *
 * The shell only parses arguments, reads the outer packet file and prints the
 * bounded projection: the projection is `core/context-packet-projection`, and
 * the whole `--archive` path (predecessor expansion and its trust rules) is
 * `projectArchivedPredecessor` in `core/predecessor-archive`, with the stored
 * packet reader injected as its one published-packet port.
 */
import { parseContextProjectionArguments, projectContextPacket } from "../engine/src/core/context-packet-projection";
import { parsePredecessorArchiveArguments, projectArchivedPredecessor, type ArchivedPredecessorRefusal,
  type ResolvePublishedPacket } from "../engine/src/core/predecessor-archive";
import type { DomainResult } from "../engine/src/core/orchestration-contract";
import { safeIoCause } from "../engine/src/core/safe-io-cause";
import { CONTEXT_PACKET_MAX_BYTES, readStoredContextPacketFile } from "../engine/src/orchestration/stored-context-packets";

// A retained archive expands to at most one stored Context Packet, whichever encoding retained it.
const ARCHIVE_BOUNDS = { expandedBytes: CONTEXT_PACKET_MAX_BYTES, encodedBytes: CONTEXT_PACKET_MAX_BYTES };

/** The production published-packet port: the exact file, bounded by the reference's own length. */
const resolveReference: ResolvePublishedPacket = (reference) =>
  readStoredContextPacketFile(reference.path, { file: reference.byteLength, section: CONTEXT_PACKET_MAX_BYTES });

/** Shell boundary: a refusal becomes the thrown cause (a decoder's own error keeps its class). */
function orThrow<T>(result: DomainResult<T, string | ArchivedPredecessorRefusal>): T {
  if (result.ok) return result.value;
  const refusal = result.error;
  if (typeof refusal === "string") throw Error(refusal);
  throw refusal.kind === "decoder-failed" ? refusal.cause : Error(refusal.message);
}

try {
  const { regular, selection } = orThrow(parsePredecessorArchiveArguments(process.argv.slice(2)));
  const input = orThrow(parseContextProjectionArguments(regular));
  // Existing reader ceiling is not a reviewer response or whole-Run budget.
  const ceiling = input.purpose === "standalone-successor" ? CONTEXT_PACKET_MAX_BYTES : 128 * 1024 * 1024;
  const { record } = orThrow(readStoredContextPacketFile(input.path, { file: ceiling, section: ceiling }));
  const projected = orThrow(selection.kind === "none"
    ? projectContextPacket(record, input)
    : projectArchivedPredecessor(record, input, selection, { bounds: ARCHIVE_BOUNDS, resolveReference }));
  const output = JSON.stringify(projected);
  if (Buffer.byteLength(output) > 48 * 1024) throw Error("projection exceeds output bound");
  process.stdout.write(output + "\n");
} catch (cause) {
  process.stderr.write(`Context Packet read failed (${safeIoCause(cause)}): unavailable/unsafe file, invalid packet or expected identity, or invalid selection/page. No authority granted.\n`);
  process.exitCode = 1;
}
