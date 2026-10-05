import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRequestAuthority, OrchestrationRunId } from "../../src/core/orchestration-contract";
import { storedContextPacket, withStoredSectionBytes } from "../../src/core/context-packets";
import { buildContextPacket, encodeByteSection, type ByteSection, type ContextPacket } from "../../src/orchestration/context-packets";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { CONTEXT_SECTION_BLOBS, readStoredContextPacketFile } from "../../src/orchestration/stored-context-packets";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN_ID = "run.stored-packets" as OrchestrationRunId;

function freshRun(): Readonly<{ directory: string; handle: RunDirHandle }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-stored-packets-")));
  cleanup.push(root);
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { directory, handle: opened.value };
}

function section(label: string, text: string): ByteSection {
  const encoded = encodeByteSection(label, text);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
}

// One frozen source shared by every reviewer of a Task — the duplication the
// stored form removes.
const FROZEN_SOURCE = section("wave-frozen-source", JSON.stringify({ files: [{ path: "src/a.ts", content: "x".repeat(50_000) }] }));

function reviewerPacket(role: string): ContextPacket {
  const built = buildContextPacket({
    requestId: `request:${role}:1` as AgentRequestAuthority["requestId"],
    role,
    requiredSkill: "none",
    outputContract: "machine-summary-v1",
    fixedContext: [section("wave-review-authority", `{"role":"${role}"}`), FROZEN_SOURCE],
    variableContext: [],
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("storedContextPacket", () => {
  it("stores section identity in the packet file and each distinct section's bytes once", () => {
    const packet = reviewerPacket("code-reviewer");
    const stored = storedContextPacket(packet);
    const file = JSON.parse(stored.text) as { digest: string; fixedContext: Record<string, unknown>[] };
    expect(file.digest).toBe(packet.digest);
    expect(file.fixedContext).toEqual(packet.fixedContext.map(({ label, byteLength, digest }) => ({ label, byteLength, digest })));
    expect(stored.blobs.map(({ digest }) => digest)).toEqual(packet.fixedContext.map(({ digest }) => digest));
    for (const { digest, bytes } of stored.blobs) expect(sha256(bytes)).toBe(digest);
  });
});

describe("withStoredSectionBytes", () => {
  const packet = reviewerPacket("code-reviewer");
  const stored = storedContextPacket(packet);
  const blobs = new Map<string, Uint8Array>(stored.blobs.map(({ digest, bytes }) => [digest, bytes]));

  it("restores every section's bytes from the blob store", () => {
    const resolved = withStoredSectionBytes(JSON.parse(stored.text), (digest) => blobs.get(digest) ?? null);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const sections = (resolved.value as { fixedContext: { bytes: Uint8Array }[] }).fixedContext;
    expect(sections.map(({ bytes }) => sha256(bytes))).toEqual(packet.fixedContext.map(({ digest }) => digest));
  });

  it("passes a packet written with inline bytes through unchanged", () => {
    const inline = JSON.parse(JSON.stringify(packet)) as unknown;
    expect(withStoredSectionBytes(inline, () => { throw new Error("no blob read for inline sections"); }))
      .toEqual({ ok: true, value: inline });
  });

  it.each<[string, (raw: Record<string, unknown>) => void, string]>([
    ["a missing blob", () => {}, "is missing from the run's blob store"],
    ["a digest that is not a blob name", (raw) => {
      (raw.fixedContext as Record<string, unknown>[])[0]!.digest = "../../authority.json";
    }, "must name its blob by a sha256 hex digest"],
  ])("refuses %s", (_name, corrupt, message) => {
    const raw = JSON.parse(stored.text) as Record<string, unknown>;
    corrupt(raw);
    const resolved = withStoredSectionBytes(raw, () => null);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toContain(message);
  });
});

describe("Run Directory Context Packet storage", () => {
  it("stores a section shared by several reviewer packets as one blob and reads every packet back exactly", async () => {
    const { directory, handle } = freshRun();
    const packets = ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer"].map(reviewerPacket);
    for (const packet of packets) expect((await handle.publishContext(packet)).ok).toBe(true);

    const blobs = readdirSync(join(directory, CONTEXT_SECTION_BLOBS));
    expect(blobs).toContain(FROZEN_SOURCE.digest);
    expect(blobs).toHaveLength(1 + packets.length); // one shared source + one authority each
    for (const packet of packets) {
      const file = readFileSync(join(directory, "contexts", `${packet.digest}.json`), "utf8");
      expect(file).not.toContain("\"bytes\"");
      expect(statSync(join(directory, "contexts", `${packet.digest}.json`)).size).toBeLessThan(1_000);
      const read = handle.readContext(packet.digest);
      expect(read.ok).toBe(true);
      if (read.ok) expect(JSON.stringify(read.value)).toBe(JSON.stringify(packet));
    }
  });

  it("republishes idempotently and refuses a blob whose bytes were replaced", async () => {
    const { directory, handle } = freshRun();
    const packet = reviewerPacket("code-reviewer");
    expect((await handle.publishContext(packet)).ok).toBe(true);
    expect((await handle.publishContext(packet)).ok).toBe(true);

    // Same length, different bytes: only the section digest can catch it.
    const blobPath = join(directory, CONTEXT_SECTION_BLOBS, FROZEN_SOURCE.digest);
    const tampered = readFileSync(blobPath);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x79 ? 0x7a : 0x79;
    writeFileSync(blobPath, tampered);
    const read = handle.readContext(packet.digest);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.message).toContain("digest must cover its exact bytes");
    expect((await handle.publishContext(packet)).ok).toBe(false);
  });

  it("still reads a packet file written with inline section bytes", () => {
    const { directory, handle } = freshRun();
    const packet = reviewerPacket("code-reviewer");
    writeFileSync(join(directory, "contexts", `${packet.digest}.json`), JSON.stringify(packet));
    const read = handle.readContext(packet.digest);
    expect(read.ok).toBe(true);
    if (read.ok) expect(JSON.stringify(read.value)).toBe(JSON.stringify(packet));
  });

  it("bounds a referenced packet file and its section blobs separately", async () => {
    const { directory, handle } = freshRun();
    const packet = reviewerPacket("code-reviewer");
    expect((await handle.publishContext(packet)).ok).toBe(true);
    const path = join(directory, "contexts", `${packet.digest}.json`);
    const fileLength = statSync(path).size;

    const read = readStoredContextPacketFile(path, { file: fileLength, section: 1_000_000 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.sectionBytes).toBe(packet.fixedContext.reduce((total, { byteLength }) => total + byteLength, 0));
    expect(readStoredContextPacketFile(path, { file: fileLength - 1, section: 1_000_000 }).ok).toBe(false);
    expect(readStoredContextPacketFile(path, { file: fileLength, section: 1_000 }).ok).toBe(false);
  });
});

describe("read-context-section", () => {
  const script = join(__dirname, "..", "..", "..", "scripts", "read-context-section.ts");
  const run = (args: readonly string[]) => spawnSync("bun", [script, ...args], { encoding: "utf8" });

  it("decodes one whole section of a stored packet and refuses a packet that is not the expected digest", async () => {
    const { directory, handle } = freshRun();
    const packet = reviewerPacket("spec-check-invoker");
    expect((await handle.publishContext(packet)).ok).toBe(true);
    const path = join(directory, "contexts", `${packet.digest}.json`);

    const read = run(["--packet", path, "--digest", packet.digest, "--section", "wave-review-authority"]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe("{\"role\":\"spec-check-invoker\"}\n");

    const wrongDigest = run(["--packet", path, "--digest", "0".repeat(64), "--section", "wave-review-authority"]);
    expect(wrongDigest.status).not.toBe(0);
    expect(wrongDigest.stdout).toBe("");
    expect(run(["--packet", path, "--digest", packet.digest, "--section", "absent"]).status).not.toBe(0);
  });
});
