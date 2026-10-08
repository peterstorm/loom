/**
 * Subprocess cases for `scripts/read-context-packet.ts --archive`: the issued
 * LOOM_CONTEXT_READ_COMMAND's predecessor-expansion path. The pure decode and
 * expansion rules (`projectArchivedPredecessor`, with a plain in-memory
 * published-packet port) are unit-tested in tests/core/predecessor-archive.test.ts;
 * these pin the shell's wiring — the real stored-packet adapter, every refusal
 * exits 1 with no stdout naming exactly its cause class, and the success
 * projection is the retained predecessor packet's own index.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildReviewerContextPacket, buildStandaloneReviewerContextPacketV3, encodeByteSection, type ByteSection } from "../../src/core/context-packets";
import { sha256Bytes } from "../../src/core/digest";
import { parseRequestId, type RequestId } from "../../src/core/orchestration-contract";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { value } from "../fixtures/parse-result";

const SCRIPT = resolve(__dirname, "../../../scripts/read-context-packet.ts");
const ROLE = "code-reviewer";
const LABEL = `predecessor-context:${ROLE}`;
const root = canonicalTempDir("loom-archive-reader-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const requestId = (name: string): RequestId => value(parseRequestId(`request:${name}`));
const section = (label: string, text: string): ByteSection => value(encodeByteSection(label, text));

// The predecessor: an issued v2 reviewer packet, stored as its exact file bytes.
const predecessor = value(buildReviewerContextPacket({ requestId: requestId("prior"), role: ROLE, requiredSkill: "review",
  fixedContext: [], variableContext: [section("prior-notes", "the predecessor's retained notes")] }));
const predecessorBytes = Buffer.from(JSON.stringify(predecessor));
const predecessorPath = join(root, "predecessor.json");
writeFileSync(predecessorPath, predecessorBytes);

const reference = (overrides: Record<string, unknown> = {}) => JSON.stringify({ encoding: "published-packet-reference",
  byteLength: predecessorBytes.length, digest: sha256Bytes(predecessorBytes), path: predecessorPath, purpose: "v1-v2", ...overrides });
const gzipArchive = (overrides: Record<string, unknown> = {}) => JSON.stringify({ encoding: "gzip-base64",
  contentBase64: gzipSync(predecessorBytes).toString("base64"), byteLength: predecessorBytes.length,
  digest: sha256Bytes(predecessorBytes), ...overrides });

let packets = 0;
/** One successor v3 packet retaining `retained` under LABEL; returns the reader's issued identity flags. */
function successorRetaining(retained: string): string[] {
  const packet = value(buildStandaloneReviewerContextPacketV3({ requestId: requestId(`successor-${packets}`), role: ROLE,
    requiredSkill: "review", fixedContext: [], variableContext: [section(LABEL, retained)] }));
  const path = join(root, `successor-${packets++}.json`);
  writeFileSync(path, JSON.stringify(packet));
  return ["--packet", path, "--request", packet.requestId, "--digest", packet.digest, "--role", ROLE, "--skill", "review",
    "--purpose", "standalone-successor"];
}

const read = (args: readonly string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
const archive = (purpose = "v1-v2", label = LABEL) => ["--archive", label, "--archive-purpose", purpose];
/** Exit 1, no stdout, and the bounded stderr naming exactly the refusal's cause class. */
const refused = (args: readonly string[], causeClass = "Error") => {
  const result = read(args);
  expect(result.status, result.stdout).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(new RegExp(`^Context Packet read failed \\(${causeClass}\\): .* No authority granted\\.\\n$`));
  return result.stderr;
};

describe("read-context-packet --archive", { timeout: 60_000 }, () => {
  it.each([["a published packet reference", reference()], ["an earlier inline gzip archive", gzipArchive()]])(
    "expands %s to the predecessor packet's own projection", (_name, retained) => {
      const result = read([...successorRetaining(retained), ...archive()]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 2, requestId: predecessor.requestId });
    });

  it("projects the outer successor packet when no archive is selected", () => {
    const result = read(successorRetaining(reference()));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 3 });
  });

  it.each([
    ["a duplicate --archive", [...archive(), "--archive", LABEL]],
    ["a duplicate --archive-purpose", [...archive(), "--archive-purpose", "v1-v2"]],
    ["an --archive without purpose", ["--archive", LABEL]],
    ["a purpose without --archive", ["--archive-purpose", "v1-v2"]],
    ["an unsupported purpose", archive("v3")],
    ["a dangling --archive", ["--archive"]],
    ["an absent label", archive("v1-v2", `${LABEL}:attempt-2`)],
    ["a label outside the predecessor namespace", archive("v1-v2", "notes")],
  ])("refuses %s", (_name, extra) => {
    refused([...successorRetaining(reference()), ...extra]);
  });

  // The record-level refusal rules are pinned at their seam
  // (projectArchivedPredecessor in tests/core/predecessor-archive.test.ts).
  // Here: one refusal per surfaced cause class, plus the production
  // published-packet adapter's own file bound (a reference shorter than its
  // file is refused by the bounded read itself).
  it.each([
    ["an unsupported encoding", reference({ encoding: "zstd" }), "Error"],
    ["a reference whose length differs", reference({ byteLength: predecessorBytes.length - 1 }), "Error"],
    ["a gzip archive declaring fewer bytes than it expands to", gzipArchive({ byteLength: predecessorBytes.length - 1 }), "RangeError"],
    ["a retained record that is not JSON", "not json", "SyntaxError"],
  ])("refuses %s", (_name, retained, causeClass) => {
    refused([...successorRetaining(retained), ...archive()], causeClass);
  });

  it("refuses an archive selected against a packet read without the successor purpose", () => {
    const flags = successorRetaining(reference());
    refused([...flags.slice(0, -2), ...archive()]);
  });

  it("refuses retained bytes changed after issuance", () => {
    const flags = successorRetaining(reference());
    writeFileSync(predecessorPath, Buffer.concat([predecessorBytes.subarray(0, -1), Buffer.from(" ")]));
    try {
      refused([...flags, ...archive()]);
    } finally {
      writeFileSync(predecessorPath, predecessorBytes);
    }
  });
});
