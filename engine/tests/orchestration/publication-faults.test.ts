import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRequestAuthority,
  EffectIntent,
  EffectReceipt,
  OrchestrationRunId,
} from "../../src/core/orchestration-contract";
import {
  buildContextPacket,
  contextPacketByteLength,
  encodeByteSection,
  parseContextPacket,
  type ByteSection,
  type ContextPacket,
} from "../../src/orchestration/context-packets";
import { createEffectRunner, type EffectPorts } from "../../src/orchestration/effect-runner";
import {
  openRunDirectory,
  parseRunDirectoryIdentity,
  type RunDirHandle,
} from "../../src/orchestration/run-directory-handle";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN_ID = "run.publication-1" as OrchestrationRunId;

function runsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-publication-"));
  cleanup.push(root);
  return root;
}

function freshRun(): Readonly<{ root: string; directory: string; handle: RunDirHandle }> {
  const root = runsRoot();
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { root, directory, handle: opened.value };
}

function section(label: string, text: string): ByteSection {
  const encoded = encodeByteSection(label, text);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value;
}

function packet(requestId: string, body = "task context"): ContextPacket {
  const built = buildContextPacket({
    requestId: requestId as AgentRequestAuthority["requestId"],
    role: "code-reviewer",
    requiredSkill: "none",
    outputContract: "machine-summary-v1",
    fixedContext: [section("rules", "always parse, never validate")],
    variableContext: [section("task", body)],
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

function authority(overrides: Partial<AgentRequestAuthority> = {}): AgentRequestAuthority {
  return {
    runId: RUN_ID,
    requestId: "request:reviewer:1",
    slotId: "slot-1",
    program: "wave-gate",
    role: "code-reviewer",
    attempt: 1,
    modelProfile: "general-review",
    harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    },
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
    ...overrides,
  } as AgentRequestAuthority;
}

const ports = (overrides: Partial<EffectPorts> = {}): EffectPorts => ({
  commitProtectedWaveState: async () => { throw new Error("not wired"); },
  inspectGitRemediation: async () => { throw new Error("not wired"); },
  installVerifiedIndex: async () => { throw new Error("not wired"); },
  ...overrides,
});

// --- Identity ---------------------------------------------------------------

describe("run directory identity", () => {
  it("refuses a run directory that is not a direct child of its runs root", () => {
    const root = runsRoot();
    const nested = join(root, "deep", "run.x");
    mkdirSync(nested, { recursive: true });

    const parsed = parseRunDirectoryIdentity(root, nested);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("direct child");
  });

  it("refuses a run directory that does not exist", () => {
    const root = runsRoot();
    const parsed = parseRunDirectoryIdentity(root, join(root, "absent"));
    expect(parsed.ok).toBe(false);
  });

  it("refuses to open a run directory reached through a symlinked hop", () => {
    const root = runsRoot();
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "run.link");
    symlinkSync(real, link);

    // Identity accepts the shape; the anchored open is what refuses to follow,
    // and it does so as a typed failure before anything is created inside.
    const opened = openRunDirectory(root, link);

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.message).toContain("not safely reachable");
    expect(readdirSync(real)).toHaveLength(0);
  });

  it("claims immutable authority once and reads it back on re-open", () => {
    const { root, directory, handle } = freshRun();

    const first = handle.readAuthority();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.runId).toBe(RUN_ID);

    const reopened = openRunDirectory(root, directory);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const second = reopened.value.readAuthority();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual(first.value);
  });
});

// --- Context packets --------------------------------------------------------

describe("context packets", () => {
  it("seals a packet with a digest over its exact identity and sections", () => {
    const built = packet("request:reviewer:1");
    expect(built.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parseContextPacket(JSON.parse(JSON.stringify(built))).ok).toBe(true);
  });

  it("refuses a packet whose section bytes were edited after publication", () => {
    const tampered = JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>;
    const variable = (tampered["variableContext"] as Record<string, unknown>[])[0];
    // Swap a byte rather than appending one, so the length still matches and
    // only the digest can catch the edit.
    const bytes = [...(variable["bytes"] as number[])];
    bytes[0] = bytes[0] === 33 ? 34 : 33;
    variable["bytes"] = bytes;

    const parsed = parseContextPacket(tampered);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("digest must cover its exact bytes");
  });

  it("refuses a packet whose section length was edited to match a shorter body", () => {
    const tampered = JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>;
    const variable = (tampered["variableContext"] as Record<string, unknown>[])[0];
    variable["bytes"] = [...(variable["bytes"] as number[]), 33];

    const parsed = parseContextPacket(tampered);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("length must equal its byte count");
  });

  it("refuses a packet whose digest was swapped for another packet's", () => {
    const tampered = JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>;
    tampered["digest"] = packet("request:reviewer:2").digest;

    const parsed = parseContextPacket(tampered);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("digest must cover its exact identity");
  });

  it("gives two requests sharing fixed context the same fixed section digest", () => {
    const first = packet("request:reviewer:1", "task one");
    const second = packet("request:reviewer:2", "task two");

    expect(first.fixedContext[0]?.digest).toBe(second.fixedContext[0]?.digest);
    expect(first.digest).not.toBe(second.digest);
    expect(contextPacketByteLength(first)).toBeGreaterThan(0);
  });

  it("publishes a packet content-addressed and idempotently", async () => {
    const { handle } = freshRun();
    const built = packet("request:reviewer:1");

    const published = await handle.publishContext(built);
    const republished = await handle.publishContext(built);

    expect(published.ok).toBe(true);
    expect(republished.ok).toBe(true);
    const read = handle.readContext(built.digest);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.digest).toBe(built.digest);
  });

  it("refuses a stored packet whose bytes were edited underneath its digest", async () => {
    const { directory, handle } = freshRun();
    const built = packet("request:reviewer:1");
    await handle.publishContext(built);

    const stored = join(directory, "contexts", `${built.digest}.json`);
    const edited = JSON.parse(readFileSync(stored, "utf-8")) as Record<string, unknown>;
    (edited["variableContext"] as Record<string, unknown>[])[0]["bytes"] = [1, 2, 3];
    writeFileSync(stored, JSON.stringify(edited));

    expect(handle.readContext(built.digest).ok).toBe(false);
  });
});

// --- Requests and transcripts ----------------------------------------------

describe("request reservation and transcript capture", () => {
  it("refuses to capture a transcript for a request that was never reserved", async () => {
    const { handle } = freshRun();

    const captured = await handle.captureTranscript(authority(), [1, 2, 3]);

    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.error.message).toContain("never reserved");
  });

  it("captures exact bytes and reads them back byte-for-byte", async () => {
    const { handle } = freshRun();
    const request = authority();
    await handle.reserveRequest(request);
    // Deliberately not valid UTF-8: raw harness bytes must survive verbatim.
    const bytes = [0x00, 0xff, 0xfe, 0x41, 0x0a, 0x80];

    const captured = await handle.captureTranscript(request, bytes);

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.byteLength).toBe(bytes.length);
    const readBack = handle.readTranscriptBytes(request);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) return;
    expect([...readBack.value]).toEqual(bytes);
  });

  it("refuses a second capture for an attempt that already landed", async () => {
    const { handle } = freshRun();
    const request = authority();
    await handle.reserveRequest(request);
    await handle.captureTranscript(request, [1]);

    const late = await handle.captureTranscript(request, [2]);

    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.message).toContain("already captured");
    expect([...(handle.readTranscriptBytes(request) as { value: Uint8Array }).value]).toEqual([1]);
  });

  it("keeps attempt 2 in a slot of its own", async () => {
    const { handle } = freshRun();
    const first = authority();
    const second = authority({ attempt: 2, requestId: "request:reviewer:2" as AgentRequestAuthority["requestId"] });
    await handle.reserveRequest(first);
    await handle.reserveRequest(second);

    await handle.captureTranscript(first, [1]);
    const retry = await handle.captureTranscript(second, [2]);

    expect(retry.ok).toBe(true);
    expect([...(handle.readTranscriptBytes(first) as { value: Uint8Array }).value]).toEqual([1]);
    expect([...(handle.readTranscriptBytes(second) as { value: Uint8Array }).value]).toEqual([2]);
  });

  it("refuses to re-reserve a request id under different authority", async () => {
    const { handle } = freshRun();
    await handle.reserveRequest(authority());

    const conflicting = await handle.reserveRequest(authority({ contextDigest: "b".repeat(64) as AgentRequestAuthority["contextDigest"] }));

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.error.message).toContain("already reserved under different authority");
  });
});

// --- Artifact-set atomicity -------------------------------------------------

describe("artifact set publication", () => {
  it("publishes a whole set", async () => {
    const { directory, handle } = freshRun();

    const published = await handle.publishArtifactSet([
      { relativePath: "result.json", bytes: [...Buffer.from("{}", "utf-8")] },
      { relativePath: "nested/report.md", bytes: [...Buffer.from("# report", "utf-8")] },
    ]);

    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value).toHaveLength(2);
    expect(readFileSync(join(directory, "artifacts", "result.json"), "utf-8")).toBe("{}");
    expect(readFileSync(join(directory, "artifacts", "nested", "report.md"), "utf-8")).toBe("# report");
  });

  it("refuses an empty artifact set rather than reporting a vacuous success", async () => {
    const { handle } = freshRun();
    const published = await handle.publishArtifactSet([]);
    expect(published.ok).toBe(false);
  });

  it("publishes nothing when a member of the set cannot be staged", async () => {
    const { directory, handle } = freshRun();
    // A directory where the second member's file must go makes its write fail.
    mkdirSync(join(directory, "artifacts", "blocked.json"), { recursive: true });

    const published = await handle.publishArtifactSet([
      { relativePath: "first.json", bytes: [...Buffer.from("first", "utf-8")] },
      { relativePath: "blocked.json", bytes: [...Buffer.from("second", "utf-8")] },
    ]);

    expect(published.ok).toBe(false);
    const artifacts = readdirSync(join(directory, "artifacts"));
    // The first member never got promoted, and its staged file was cleaned up.
    expect(artifacts).not.toContain("first.json");
    expect(artifacts.some((name) => name.endsWith(".staged"))).toBe(false);
  });
});

// --- Receipts and effect reconciliation ------------------------------------

describe("effect receipts", () => {
  const captureIntent = (bytes: readonly number[]): EffectIntent => ({
    kind: "capture-raw-transcript",
    effectId: "effect:capture-1",
    runId: RUN_ID,
    request: authority(),
    bytes,
  } as EffectIntent);

  it("runs an effect once and replays its receipt on resume", async () => {
    const { handle } = freshRun();
    await handle.reserveRequest(authority());
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });
    const intent = captureIntent([7, 8, 9]);

    const first = await runner(intent);
    expect(first.ok).toBe(true);

    // Second run must NOT attempt the capture again — the slot is exclusive, so
    // a re-run would fail rather than return the original receipt.
    const second = await runner(intent);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
  });

  it("records the receipt under the effect's own id", async () => {
    const { handle } = freshRun();
    await handle.reserveRequest(authority());
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });

    await runner(captureIntent([1]));

    const stored = handle.readReceipt("effect:capture-1" as EffectReceipt["effectId"]);
    expect(stored).not.toBeNull();
    expect(stored?.kind).toBe("raw-transcript-captured");
  });

  it("reports a failing external port as retriable without recording a receipt", async () => {
    const { handle } = freshRun();
    const runner = createEffectRunner({
      handle,
      ports: ports({ commitProtectedWaveState: async () => { throw new Error("locked by another writer"); } }),
      resolveArtifacts: () => [],
    });
    const intent = {
      kind: "commit-protected-wave-state",
      effectId: "effect:commit-1",
      runId: RUN_ID,
      expectedRevision: 0,
      stateDigest: "b".repeat(64),
    } as EffectIntent;

    const result = await runner(intent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retriable).toBe(true);
    expect(handle.readReceipt("effect:commit-1" as EffectReceipt["effectId"])).toBeNull();
  });

  it("refuses a receipt that answers a different effect", async () => {
    const { handle } = freshRun();
    const runner = createEffectRunner({
      handle,
      ports: ports({
        commitProtectedWaveState: async () => ({
          kind: "protected-wave-state-committed",
          effectId: "effect:someone-else",
          runId: RUN_ID,
          committedRevision: 1,
          stateDigest: "b".repeat(64),
        }),
      }),
      resolveArtifacts: () => [],
    });

    const result = await runner({
      kind: "commit-protected-wave-state",
      effectId: "effect:commit-1",
      runId: RUN_ID,
      expectedRevision: 0,
      stateDigest: "b".repeat(64),
    } as EffectIntent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retriable).toBe(false);
    expect(handle.readReceipt("effect:commit-1" as EffectReceipt["effectId"])).toBeNull();
  });

  it("refuses a publish whose staged bytes do not cover the intent's set", async () => {
    const { handle } = freshRun();
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });

    const result = await runner({
      kind: "publish-artifact-set",
      effectId: "effect:publish-1",
      runId: RUN_ID,
      artifacts: [{
        runId: RUN_ID,
        slot: { kind: "fixed-artifact-slot", path: "artifacts/result.json" },
        digest: "c".repeat(64),
        byteLength: 2,
      }],
    } as unknown as EffectIntent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not match the intent's artifact set");
  });
});

// --- Journal ----------------------------------------------------------------

describe("run directory as a program journal", () => {
  it("appends events immutably and dedups a replayed transition", async () => {
    const { directory, handle } = freshRun();
    const record = { schemaVersion: 1 as const, sequence: 0, dedupKey: "dk-1", recordedAtMs: 1, event: { kind: "published" } };

    await handle.appendEvent(record);
    await handle.appendEvent(record);
    await handle.appendEvent({ ...record, dedupKey: "dk-2" });

    expect(readdirSync(join(directory, "events")).sort()).toEqual(["000000-dk-1.json", "000001-dk-2.json"]);
    expect(await handle.readEvents()).toHaveLength(2);
  });

  it("replaces the checkpoint atomically and leaves no staged file", async () => {
    const { directory, handle } = freshRun();

    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, data: { state: "a" } }));
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, data: { state: "b" } }));

    const stored = await handle.readCheckpoint();
    expect(stored).toContain("\"state\":\"b\"");
    expect(readdirSync(directory).some((name) => name.endsWith(".staged"))).toBe(false);
  });

  it("reports a missing checkpoint as absent rather than throwing", async () => {
    const { handle } = freshRun();
    expect(await handle.readCheckpoint()).toBeNull();
  });
});
