import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRequestAuthority, OrchestrationRunId } from "../../src/core/orchestration-contract";
import { boundedStandaloneReadHandle } from "../../src/handlers/helpers/programs/standalone-successor-source";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../src/orchestration/context-packets";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { CONTEXT_PACKET_MAX_BYTES, CONTEXT_SECTION_BLOBS } from "../../src/orchestration/stored-context-packets";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN_ID = "run.packet-bound" as OrchestrationRunId;

function freshRun(): Readonly<{ directory: string; handle: RunDirHandle }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-packet-bound-")));
  cleanup.push(root);
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { directory, handle: opened.value };
}

/** A reviewer packet whose frozen-source section is exactly `sourceBytes` long. */
function packetWithSource(sourceBytes: number): ContextPacket {
  const source = encodeByteSection("standalone-frozen-source", "x".repeat(sourceBytes));
  const authority = encodeByteSection("standalone-review-authority", "{\"role\":\"code-reviewer\"}");
  if (!source.ok || !authority.ok) throw new Error("section encoding failed");
  const built = buildContextPacket({
    requestId: "request:code-reviewer:1" as AgentRequestAuthority["requestId"],
    role: "code-reviewer",
    requiredSkill: "none",
    outputContract: "machine-summary-v1",
    fixedContext: [authority.value, source.value],
    variableContext: [],
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

const entries = (path: string): readonly string[] => (existsSync(path) ? readdirSync(path) : []);

describe("Context Packet byte bound", () => {
  it("refuses a section no bounded reader could read back, before writing anything", async () => {
    const { directory, handle } = freshRun();
    const packet = packetWithSource(CONTEXT_PACKET_MAX_BYTES + 1);

    const published = await handle.publishContext(packet);

    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.message).toContain("standalone-frozen-source");
    expect(published.error.message).toContain(`${CONTEXT_PACKET_MAX_BYTES}-byte Context Packet bound`);
    expect(published.error.message).toContain("--files");
    expect(entries(join(directory, "contexts"))).toEqual([]);
    expect(entries(join(directory, CONTEXT_SECTION_BLOBS))).toEqual([]);
  });

  it("reads a section at the bound back through the run handle and lineage authentication", async () => {
    const { handle } = freshRun();
    const packet = packetWithSource(CONTEXT_PACKET_MAX_BYTES);

    const published = await handle.publishContext(packet);
    expect(published.ok).toBe(true);

    const direct = handle.readContext(packet.digest);
    const lineage = boundedStandaloneReadHandle(handle).readContext(packet.digest);
    expect(direct.ok && direct.value.digest).toBe(packet.digest);
    expect(lineage.ok && lineage.value.digest).toBe(packet.digest);
  });
});
