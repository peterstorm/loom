#!/usr/bin/env bun
/**
 * Decode one whole section of an issued Context Packet as UTF-8 text.
 *
 * Usage: bun read-context-section.ts --packet <absolute contexts/<digest>.json> --digest <digest> --section <label>
 *
 * Read-only, for agents (spec-check) that consume small authority sections
 * whole rather than paging through the reviewer reader. Section bytes resolve
 * from the run's blob store and every section is re-hashed by the packet
 * parser; a packet that does not prove the expected digest is refused. The
 * argument grammar is `parseContextSectionArguments`, owned with the
 * projection reader's in `core/context-packet-projection`.
 */
import { parseContextSectionArguments } from "../engine/src/core/context-packet-projection";
import { parseContextPacket } from "../engine/src/orchestration/context-packets";
import { safeIoCause } from "../engine/src/core/safe-io-cause";
import { CONTEXT_PACKET_BOUNDS, readStoredContextPacketFile } from "../engine/src/orchestration/stored-context-packets";

const SECTION_OUTPUT_BOUND = 4 * 1024 * 1024;

try {
  const args = parseContextSectionArguments(process.argv.slice(2));
  if (!args.ok) throw Error(args.error);
  const { path, digest, label } = args.value;
  const stored = readStoredContextPacketFile(path, CONTEXT_PACKET_BOUNDS);
  if (!stored.ok) throw Error(stored.error);
  const packet = parseContextPacket(stored.value.record);
  if (!packet.ok) throw Error(packet.error.message);
  if (packet.value.digest !== digest) throw Error("packet differs from the expected digest");
  const section = [...packet.value.fixedContext, ...packet.value.variableContext].find((entry) => entry.label === label);
  if (section === undefined) throw Error(`packet has no section ${label}`);
  if (section.byteLength > SECTION_OUTPUT_BOUND) throw Error(`section ${label} exceeds the whole-section output bound`);
  process.stdout.write(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(section.bytes)) + "\n");
} catch (cause) {
  process.stderr.write(`Context Packet section read failed (${safeIoCause(cause)}). No authority granted.\n`);
  process.exitCode = 1;
}
