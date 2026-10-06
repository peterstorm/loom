#!/usr/bin/env bun
/** Read-only projection. No Run handle, publication, mutable source or execution authority. */
import { parseContextProjectionArguments, projectContextPacket } from "../engine/src/core/context-packet-projection";
import { parseStandaloneReviewerContextPacketV3 } from "../engine/src/core/context-packets";
import type { DomainResult } from "../engine/src/core/orchestration-contract";
import { expandGzipPredecessorArchive, parsePredecessorArchiveArguments, parsePredecessorArchiveRecord, verifyPredecessorArchiveBytes,
  type PredecessorArchivePurpose, type PredecessorArchiveRecord, type PredecessorArchiveRefusal } from "../engine/src/core/predecessor-archive";
import { safeIoCause } from "../engine/src/core/safe-io-cause";
import { CONTEXT_PACKET_MAX_BYTES, readStoredContextPacketFile } from "../engine/src/orchestration/stored-context-packets";

// A retained archive expands to at most one stored Context Packet, whichever encoding retained it.
const ARCHIVE_BOUNDS = { expandedBytes: CONTEXT_PACKET_MAX_BYTES, encodedBytes: CONTEXT_PACKET_MAX_BYTES };

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Shell boundary: a codec refusal becomes the thrown cause (a decoder's own error keeps its class). */
function orThrow<T>(result: DomainResult<T, PredecessorArchiveRefusal>): T {
  if (result.ok) return result.value;
  throw result.error.kind === "expansion-failed" ? result.error.cause : Error(result.error.message);
}

/** One identity field of an archived predecessor packet, as the string the projection binds. */
function archivedIdentity(packet: unknown, key: "requestId" | "digest" | "role" | "requiredSkill"): string {
  const value = typeof packet === "object" && packet !== null ? (packet as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string") throw Error(`archived predecessor packet lacks a string ${key}`);
  return value;
}

/** One retained encoding's expanded bytes and the predecessor packet record they carry, still unverified. */
function expandRetainedEncoding(retained: PredecessorArchiveRecord, purpose: PredecessorArchivePurpose):
    Readonly<{ expanded: Uint8Array; prior: unknown }> {
  if (retained.encoding === "published-packet-reference") {
    if (retained.purpose !== purpose) throw Error("invalid explicit predecessor reference");
    // The reference pins the predecessor's packet FILE bytes; its sections
    // resolve from the predecessor run's own blob store.
    const predecessor = readStoredContextPacketFile(retained.path, { file: retained.byteLength, section: CONTEXT_PACKET_MAX_BYTES });
    if (!predecessor.ok) throw Error(predecessor.error);
    return { expanded: predecessor.value.fileBytes, prior: predecessor.value.record };
  }
  const expanded = orThrow(expandGzipPredecessorArchive(retained));
  return { expanded, prior: JSON.parse(decodeUtf8(expanded)) };
}

/** Expand one retained archive section to its verified predecessor packet record. */
function expandRetainedPredecessor(sectionBytes: Uint8Array, purpose: PredecessorArchivePurpose): unknown {
  const retained = orThrow(parsePredecessorArchiveRecord(JSON.parse(decodeUtf8(sectionBytes)), ARCHIVE_BOUNDS));
  const { expanded, prior } = expandRetainedEncoding(retained, purpose);
  orThrow(verifyPredecessorArchiveBytes(retained, expanded));
  return prior;
}

try {
  const args = parsePredecessorArchiveArguments(process.argv.slice(2));
  if (!args.ok) throw Error(args.error);
  const { regular, selection } = args.value;
  const input = parseContextProjectionArguments(regular);
  if (!input.ok) throw Error(input.error);
  // Existing reader ceiling is not a reviewer response or whole-Run budget.
  const ceiling = input.value.purpose === "standalone-successor" ? CONTEXT_PACKET_MAX_BYTES : 128 * 1024 * 1024;
  const stored = readStoredContextPacketFile(input.value.path, { file: ceiling, section: ceiling });
  if (!stored.ok) throw Error(stored.error);
  const raw = stored.value.record;
  let projected;
  if (selection.kind === "none") projected = projectContextPacket(raw, input.value);
  else {
    const outer = projectContextPacket(raw, { ...input.value, selection: { kind: "index", offset: 0, limit: 32 } });
    if (!outer.ok || input.value.purpose !== "standalone-successor") throw Error("archive requires exact successor packet identity");
    const packet = parseStandaloneReviewerContextPacketV3(raw);
    if (!packet.ok) throw Error(packet.error.message);
    const section = packet.value.variableContext.find(row => row.label === selection.label && row.label.startsWith("predecessor-context:"));
    if (section === undefined) throw Error("archive label is absent");
    const prior = expandRetainedPredecessor(Uint8Array.from(section.bytes), selection.purpose);
    // Inner identity is retained DATA within the independently selected outer section,
    // not authority for issuance or capture. Decode purpose is explicit, never guessed.
    projected = projectContextPacket(prior, { ...input.value, requestId: archivedIdentity(prior, "requestId"),
      digest: archivedIdentity(prior, "digest"), role: archivedIdentity(prior, "role"),
      requiredSkill: archivedIdentity(prior, "requiredSkill"),
      purpose: selection.purpose === "standalone-successor" ? "standalone-successor" : undefined });
  }
  if (!projected.ok) throw Error(projected.error);
  const output = JSON.stringify(projected.value);
  if (Buffer.byteLength(output) > 48 * 1024) throw Error("projection exceeds output bound");
  process.stdout.write(output + "\n");
} catch (cause) {
  process.stderr.write(`Context Packet read failed (${safeIoCause(cause)}): unavailable/unsafe file, invalid packet or expected identity, or invalid selection/page. No authority granted.\n`);
  process.exitCode = 1;
}
