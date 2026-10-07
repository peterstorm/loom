import { spawnSync } from "node:child_process";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRequestAuthority, OrchestrationRunId } from "../../src/core/orchestration-contract";
import { boundedStandaloneReadHandle } from "../../src/handlers/helpers/programs/standalone-successor-source";
import {
  buildContextPacket,
  buildStandaloneReviewerContextPacketV3,
  encodeByteSection,
  type ByteSection,
  type ContextPacket,
  type StandaloneReviewerContextPacketV3,
} from "../../src/orchestration/context-packets";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { publishStandalonePanelView, verifyStandalonePanelView } from "../../src/orchestration/standalone-panel-context";
import {
  CONTEXT_PACKET_BOUNDS,
  CONTEXT_PACKET_MAX_BYTES,
  CONTEXT_SECTION_BLOBS,
  readStoredContextPacketFile,
} from "../../src/orchestration/stored-context-packets";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN_ID = "run.packet-bound" as OrchestrationRunId;

function freshRun(): Readonly<{ directory: string; handle: RunDirHandle; root: string }> {
  const root = canonicalTempDir("loom-packet-bound-");
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { directory, handle: opened.value, root };
}

const section = (label: string, text: string): ByteSection => {
  const encoded = encodeByteSection(label, text);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
};

const AUTHORITY = section("standalone-review-authority", "{\"role\":\"code-reviewer\"}");

function legacyPacket(requestId: string, fixedContext: readonly ByteSection[], variableContext: readonly ByteSection[] = []): ContextPacket {
  const built = buildContextPacket({
    requestId: requestId as AgentRequestAuthority["requestId"],
    role: "code-reviewer",
    requiredSkill: "none",
    outputContract: "machine-summary-v1",
    fixedContext: [...fixedContext],
    variableContext: [...variableContext],
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

/** A reviewer packet whose frozen-source section is exactly `sourceBytes` long. */
const packetWithSource = (sourceBytes: number): ContextPacket =>
  legacyPacket("request:code-reviewer:1", [AUTHORITY, section("standalone-frozen-source", "x".repeat(sourceBytes))]);

const entries = (path: string): readonly string[] => (existsSync(path) ? readdirSync(path) : []);

describe("Context Packet byte bound: publication", () => {
  it("refuses a section no bounded reader could read back, before writing anything", async () => {
    const { directory, handle, root } = freshRun();
    cleanup.push(root);
    const packet = packetWithSource(CONTEXT_PACKET_MAX_BYTES + 1);

    const published = await handle.publishContext(packet);

    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.message).toContain(
      `section standalone-frozen-source is ${CONTEXT_PACKET_MAX_BYTES + 1} bytes, over the ${CONTEXT_PACKET_MAX_BYTES}-byte Context Packet bound`,
    );
    expect(published.error.message).toContain("--files");
    expect(entries(join(directory, "contexts"))).toEqual([]);
    expect(entries(join(directory, CONTEXT_SECTION_BLOBS))).toEqual([]);
  });

  it("refuses a packet FILE over the bound even when every section fits", async () => {
    const { directory, handle, root } = freshRun();
    cleanup.push(root);
    // Section labels live in the packet file, not in blobs.
    const packet = legacyPacket("request:code-reviewer:label", [AUTHORITY, section("l".repeat(CONTEXT_PACKET_MAX_BYTES), "{}")]);

    const published = await handle.publishContext(packet);

    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.message).toMatch(new RegExp(
      `^context packet ${packet.digest} is \\d+ bytes, over the ${CONTEXT_PACKET_MAX_BYTES}-byte Context Packet bound; narrow the review scope`,
    ));
    expect(entries(join(directory, "contexts"))).toEqual([]);
    expect(entries(join(directory, CONTEXT_SECTION_BLOBS))).toEqual([]);
  });
});

/**
 * Every reader moved onto CONTEXT_PACKET_MAX_BYTES reads a packet holding a
 * section of exactly the bound. A reader that drifts back to a smaller literal
 * fails here.
 */
describe("Context Packet byte bound: every reader accepts what publication admits", () => {
  let run: ReturnType<typeof freshRun>;
  let atBound: ContextPacket;
  let successor: StandaloneReviewerContextPacketV3;

  beforeAll(async () => {
    run = freshRun();
    atBound = legacyPacket("request:code-reviewer:bound", [AUTHORITY, section("bulk", "x".repeat(CONTEXT_PACKET_MAX_BYTES))],
      [section("standalone-frozen-source", "{\"files\":[]}")]);
    const built = buildStandaloneReviewerContextPacketV3({
      requestId: "request:code-reviewer:successor" as AgentRequestAuthority["requestId"],
      role: "code-reviewer",
      requiredSkill: "none",
      fixedContext: [],
      variableContext: [section("bulk", "y".repeat(CONTEXT_PACKET_MAX_BYTES))],
    });
    if (!built.ok) throw new Error(built.error.message);
    successor = built.value;
    expect((await run.handle.publishContext(atBound)).ok).toBe(true);
    expect((await run.handle.publishContext(successor)).ok).toBe(true);
  }, 120_000);
  afterAll(() => rmSync(run.root, { recursive: true, force: true }));

  const digestOf = (result: { ok: true; value: { digest: string } } | { ok: false }) => (result.ok ? result.value.digest : null);

  it.each([
    ["the Run Directory read under the bound (panel bootstrap, helpers)", () => digestOf(run.handle.readContext(atBound.digest, CONTEXT_PACKET_MAX_BYTES))],
    ["lineage authentication", () => digestOf(boundedStandaloneReadHandle(run.handle).readContext(atBound.digest))],
    ["a stored packet read by path under CONTEXT_PACKET_BOUNDS", () => {
      const stored = readStoredContextPacketFile(join(run.directory, "contexts", `${atBound.digest}.json`), CONTEXT_PACKET_BOUNDS);
      return stored.ok ? atBound.digest : null;
    }],
  ])("%s", (_reader, read) => {
    expect(read()).toBe(atBound.digest);
  }, 60_000);

  it.each([
    ["native capture (explicit bound)", () => digestOf(run.handle.readStandaloneSuccessorContext(successor.digest, CONTEXT_PACKET_MAX_BYTES))],
    ["successor delivery (default bound)", () => digestOf(run.handle.readStandaloneSuccessorContext(successor.digest))],
    ["lineage authentication", () => digestOf(boundedStandaloneReadHandle(run.handle).readStandaloneSuccessorContext(successor.digest))],
  ])("successor packet: %s", (_reader, read) => {
    expect(read()).toBe(successor.digest);
  }, 60_000);

  it("scripts/read-context-section.ts", () => {
    const script = join(__dirname, "..", "..", "..", "scripts", "read-context-section.ts");
    const read = spawnSync("bun", [script, "--packet", join(run.directory, "contexts", `${atBound.digest}.json`),
      "--digest", atBound.digest, "--section", "standalone-review-authority"], { encoding: "utf8" });
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe("{\"role\":\"code-reviewer\"}\n");
  }, 60_000);

  it("the standalone panel's predecessor reference", async () => {
    const path = join(run.directory, "contexts", `${atBound.digest}.json`);
    const file = readFileSync(path);
    const reference = JSON.stringify({
      encoding: "published-packet-reference", purpose: "v1-v2", path,
      byteLength: file.length, digest: createHash("sha256").update(file).digest("hex"),
    });
    const current = legacyPacket("request:review-verifier-agent:panel", [AUTHORITY], [
      section("standalone-frozen-source", "{\"files\":[]}"),
      section(`predecessor-context:${atBound.digest}`, reference),
    ]);
    await publishStandalonePanelView(run.handle, current);
    const view = verifyStandalonePanelView(run.handle, current);
    expect(view.ok, view.ok ? "" : view.error).toBe(true);
    expect(readFileSync(view.ok ? view.value : "").toString()).toContain("# Predecessor frozen source");
  }, 60_000);
});
