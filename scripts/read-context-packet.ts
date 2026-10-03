#!/usr/bin/env bun
/** Read-only projection. No Run handle, publication, mutable source or execution authority. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseContextProjectionArguments, projectContextPacket } from "../engine/src/core/context-packet-projection";
import { parseStandaloneReviewerContextPacketV3 } from "../engine/src/core/context-packets";
import { safeIoCause } from "../engine/src/core/safe-io-cause";
import { readRunBytesNoFollow } from "../engine/src/orchestration/no-follow-fs";

function argumentsAndArchive(args: readonly string[]) {
  const regular: string[] = [];
  const archive = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (value === undefined) throw Error("missing reader argument");
    if (key === "--archive" || key === "--archive-purpose") {
      if (archive.has(key)) throw Error("duplicate archive selection");
      archive.set(key, value);
    } else regular.push(key, value);
  }
  if (archive.size !== 0 && (archive.size !== 2 || !["v1-v2", "standalone-successor"].includes(archive.get("--archive-purpose")!))) {
    throw Error("archive requires exact label and explicit --archive-purpose v1-v2 or standalone-successor");
  }
  return { regular, archive };
}

try {
  const { regular, archive } = argumentsAndArchive(process.argv.slice(2));
  const input = parseContextProjectionArguments(regular);
  if (!input.ok) throw Error(input.error);
  // Existing reader ceiling is not a reviewer response or whole-Run budget.
  const bytes = readRunBytesNoFollow(input.value.path, input.value.purpose === "standalone-successor" ? 16_777_216 : 128 * 1024 * 1024);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  let projected;
  if (archive.size === 0) projected = projectContextPacket(raw, input.value);
  else {
    const outer = projectContextPacket(raw, { ...input.value, selection: { kind: "index", offset: 0, limit: 32 } });
    if (!outer.ok || input.value.purpose !== "standalone-successor") throw Error("archive requires exact successor packet identity");
    const packet = parseStandaloneReviewerContextPacketV3(raw);
    if (!packet.ok) throw Error(packet.error.message);
    const section = packet.value.variableContext.find(row => row.label === archive.get("--archive") && row.label.startsWith("predecessor-context:"));
    if (section === undefined) throw Error("archive label is absent");
    const retained = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(section.bytes)));
    if (!Number.isSafeInteger(retained.byteLength) || retained.byteLength < 1 || retained.byteLength > 16_777_216) throw Error("archive exceeds bounded expansion");
    let expanded: Buffer;
    if (retained.encoding === "published-packet-reference") {
      if (typeof retained.path !== "string" || !retained.path.startsWith("/") || retained.purpose !== archive.get("--archive-purpose")) throw Error("invalid explicit predecessor reference");
      expanded = readRunBytesNoFollow(retained.path, retained.byteLength);
    } else if (retained.encoding === "gzip-base64") {
      if (typeof retained.contentBase64 !== "string" || retained.contentBase64.length > 16_777_216) throw Error("archive exceeds compressed bound");
      const compressed = Buffer.from(retained.contentBase64, "base64");
      if (compressed.toString("base64") !== retained.contentBase64) throw Error("invalid archive encoding");
      expanded = gunzipSync(compressed, { maxOutputLength: retained.byteLength });
    } else throw Error("unsupported predecessor encoding");
    if (expanded.length !== retained.byteLength || createHash("sha256").update(expanded).digest("hex") !== retained.digest) throw Error("archive bytes differ");
    const prior = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(expanded));
    // Inner identity is retained DATA within the independently selected outer section,
    // not authority for issuance or capture. Decode purpose is explicit, never guessed.
    projected = projectContextPacket(prior, { ...input.value, requestId: prior.requestId, digest: prior.digest,
      role: prior.role, requiredSkill: prior.requiredSkill,
      purpose: archive.get("--archive-purpose") === "standalone-successor" ? "standalone-successor" : undefined });
  }
  if (!projected.ok) throw Error(projected.error);
  const output = JSON.stringify(projected.value);
  if (Buffer.byteLength(output) > 48 * 1024) throw Error("projection exceeds output bound");
  process.stdout.write(output + "\n");
} catch (cause) {
  process.stderr.write(`Context Packet read failed (${safeIoCause(cause)}): unavailable/unsafe file, invalid packet or expected identity, or invalid selection/page. No authority granted.\n`);
  process.exitCode = 1;
}
