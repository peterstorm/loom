import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import {
  parseContextDigest,
  type AgentRequestAuthority,
  type EffectIntent,
  type EffectReceipt,
  type OrchestrationRunId,
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
  createRunDirectory,
  createStagedArtifact,
  openRunDirectory,
  parseRunDirectoryIdentity,
  parseRunDirectoryReference,
  parseStagedArtifactPromotion,
  promoteArtifactSet,
  type RunDirHandle,
  type StagedArtifactPromotion,
} from "../../src/orchestration/run-directory-handle";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN_ID = "run.publication-1" as OrchestrationRunId;

function runsRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-publication-")));
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

function promotion(root: string, directory: string, staged: string, final: string): StagedArtifactPromotion {
  const parsed = parseStagedArtifactPromotion(root, directory, { staged, final });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
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

const authority = (overrides: Record<string, unknown> = {}): AgentRequestAuthority =>
  agentRequestAuthority(RUN_ID, overrides);

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

  it("returns a typed failure when fixed-layout creation encounters a symlink", () => {
    const root = runsRoot();
    const directory = join(root, RUN_ID);
    const outside = join(root, "outside-layout");
    mkdirSync(directory);
    mkdirSync(outside);
    symlinkSync(outside, join(directory, "events"));

    const opened = openRunDirectory(root, directory);

    expect(opened).toMatchObject({
      ok: false,
      error: { field: "runDirectory", message: expect.stringContaining("layout is not safely reachable") },
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("returns a typed failure when an existing idempotent claim cannot be read", async () => {
    const { directory, handle } = freshRun();
    const programPath = join(directory, "program.json");
    symlinkSync(programPath, programPath);

    const registered = await handle.registerProgram({ kind: "test-program" });

    expect(registered.ok).toBe(false);
    if (!registered.ok) {
      expect(registered.error.field).toBe("program");
      expect(registered.error.message).toContain("cannot register orchestration program");
    }
  });

  it("registers semantic JSON idempotently regardless of caller key order", async () => {
    const { handle } = freshRun();

    const first = await handle.registerProgram({ kind: "test", input: { alpha: 1, beta: 2 } });
    const reordered = await handle.registerProgram({ input: { beta: 2, alpha: 1 }, kind: "test" });

    expect(first.ok).toBe(true);
    expect(reordered).toEqual(first);
  });

  it("refuses non-JSON program authority without claiming the slot", async () => {
    const { directory, handle } = freshRun();

    const rejected = await handle.registerProgram({ kind: "test", callback: () => undefined });

    expect(rejected).toMatchObject({
      ok: false,
      error: { field: "program", message: expect.stringContaining("not JSON data") },
    });
    expect(existsSync(join(directory, "program.json"))).toBe(false);
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

  it("refuses to reopen a run whose stored root or directory authority drifted", () => {
    const { root, directory } = freshRun();
    const path = join(directory, "authority.json");
    const forged = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    forged["runsRoot"] = join(root, "elsewhere");
    writeFileSync(path, JSON.stringify(forged));

    const reopened = openRunDirectory(root, directory);

    expect(reopened.ok).toBe(false);
    if (reopened.ok) return;
    expect(reopened.error.message).toContain("does not match");
  });

  it("reads a canonical run id as the child of the root it was given", () => {
    const root = runsRoot();

    const bare = parseRunDirectoryReference(root, RUN_ID);
    const full = parseRunDirectoryReference(root, join(root, RUN_ID));

    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.runDirectory).toBe(join(root, RUN_ID));
    expect(full.ok && full.value).toEqual(bare.value);
  });

  it("never reads a traversal or a nested path as a bare run name", () => {
    const root = runsRoot();

    // Neither is a canonical run id, so both keep exact path semantics and stay
    // subject to the direct-child relation.
    for (const reference of ["..", ".", "nested/run.x", "../run.x"]) {
      const parsed = parseRunDirectoryReference(root, reference);
      expect(parsed.ok, `${reference} must not resolve to a child of the root`).toBe(false);
    }
  });
});

describe("creating a run directory", () => {
  it("creates one missing direct child and claims its authority", () => {
    const root = runsRoot();

    const created = createRunDirectory(root, RUN_ID);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.runId).toBe(RUN_ID);
    expect(created.value.runDirectory).toBe(join(root, RUN_ID));
    expect(created.value.readAuthority().ok).toBe(true);
  });

  it("is idempotent over an existing run, preserving its claimed authority", () => {
    const root = runsRoot();
    const first = createRunDirectory(root, RUN_ID);
    if (!first.ok) throw new Error(first.error.message);
    const authority = first.value.readAuthority();

    const second = createRunDirectory(root, RUN_ID);

    expect(second.ok).toBe(true);
    if (!second.ok || !authority.ok) return;
    const reread = second.value.readAuthority();
    expect(reread.ok && reread.value).toEqual(authority.value);
  });

  it("refuses an entry already occupied by a symlink rather than following it", () => {
    const root = runsRoot();
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-publication-outside-")));
    cleanup.push(outside);
    symlinkSync(outside, join(root, RUN_ID));

    const created = createRunDirectory(root, RUN_ID);

    expect(created.ok).toBe(false);
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it("refuses a missing runs-root instead of growing one", () => {
    const root = join(runsRoot(), "absent-root");

    const created = createRunDirectory(root, RUN_ID);

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("runs root");
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a run that is not a direct child, creating nothing", () => {
    const root = runsRoot();
    const nested = join(root, "nested", "run.deep");

    const created = createRunDirectory(root, nested);

    expect(created.ok).toBe(false);
    expect(existsSync(join(root, "nested"))).toBe(false);
  });
});

// --- Context packets --------------------------------------------------------

describe("context packets", () => {
  it("seals a packet with a digest over its exact identity and sections", () => {
    const built = packet("request:reviewer:1");
    expect(built.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parseContextPacket(JSON.parse(JSON.stringify(built))).ok).toBe(true);
  });

  it("refuses an undeclared top-level field even when the declared digest remains valid", () => {
    const tampered = {
      ...JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>,
      injectedAuthority: true,
    };

    const parsed = parseContextPacket(tampered);

    expect(parsed).toMatchObject({
      ok: false,
      error: { field: "packet.injectedAuthority", message: expect.stringContaining("undeclared field") },
    });
  });

  it("refuses undeclared section fields omitted from section identity", () => {
    const tampered = JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>;
    const fixed = tampered["fixedContext"] as Record<string, unknown>[];
    fixed[0]!["injectedAuthority"] = true;

    expect(parseContextPacket(tampered)).toMatchObject({
      ok: false,
      error: { field: "fixedContext[0].injectedAuthority", message: expect.stringContaining("undeclared field") },
    });
  });

  it("property: every injected undeclared top-level key is rejected", () => {
    const declared = new Set([
      "schemaVersion", "digest", "requestId", "role", "requiredSkill",
      "outputContract", "fixedContext", "variableContext",
    ]);
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,24}$/).filter((key) => !declared.has(key)),
      fc.jsonValue(),
      (key, value) => {
        const tampered = {
          ...JSON.parse(JSON.stringify(packet("request:reviewer:1"))) as Record<string, unknown>,
          [key]: value,
        };
        expect(parseContextPacket(tampered).ok).toBe(false);
      },
    ));
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

  it("refuses a packet whose requestId is not a canonical authority id", () => {
    // A structurally valid packet (digest recomputed over its exact identity)
    // carrying a requestId that no request authority could hold: request
    // identity is a branded authority, so this must not parse as a valid
    // ContextPacket even though its digest is self-consistent.
    const invalid = buildContextPacket({
      requestId: "request:reviewer/1" as AgentRequestAuthority["requestId"],
      role: "code-reviewer",
      requiredSkill: "none",
      outputContract: "machine-summary-v1",
      fixedContext: packet("request:reviewer:1").fixedContext,
      variableContext: packet("request:reviewer:1").variableContext,
    });
    if (!invalid.ok) throw new Error(invalid.error.message);

    const parsed = parseContextPacket(JSON.parse(JSON.stringify(invalid.value)));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("requestId");
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

  it("publishes valid decision JSON byte-identically and idempotently", async () => {
    const { directory, handle } = freshRun();
    const bytes = [...Buffer.from('{"kind":"wave-advisory-decision-context"}', "utf8")];
    const digest = parseContextDigest(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
    if (!digest.ok) throw new Error(digest.error.message);

    const first = await handle.publishDecisionContext(digest.value, bytes);
    const replay = await handle.publishDecisionContext(digest.value, bytes);

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect([...readFileSync(join(directory, "contexts", `${digest.value}.json`))]).toEqual(bytes);
  });

  it("refuses decision bytes that do not match their digest or byte contract", async () => {
    const { handle } = freshRun();
    const digest = parseContextDigest("a".repeat(64));
    if (!digest.ok) throw new Error(digest.error.message);

    const mismatch = await handle.publishDecisionContext(digest.value, [...Buffer.from("{}")]);
    const nonBytes = await handle.publishDecisionContext(digest.value, [0, 1.5, 256]);

    expect(mismatch).toMatchObject({ ok: false, error: { message: expect.stringContaining("digest does not match") } });
    expect(nonBytes).toMatchObject({ ok: false, error: { message: expect.stringContaining("integers from 0 through 255") } });
  });

  it("refuses sparse staged and decision-context byte arrays", async () => {
    const sparse = new Array<number>(2);
    sparse[1] = 1;
    expect(createStagedArtifact("result.json", sparse)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("integers from 0 through 255") },
    });

    const { handle } = freshRun();
    const coercedDigest = parseContextDigest(
      createHash("sha256").update(Uint8Array.from(sparse)).digest("hex"),
    );
    if (!coercedDigest.ok) throw new Error(coercedDigest.error.message);
    await expect(handle.publishDecisionContext(coercedDigest.value, sparse)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("integers from 0 through 255") },
    });
  });

  it.each([
    ["invalid UTF-8", [0xff], "valid UTF-8 JSON"],
    ["invalid JSON", [...Buffer.from("{truncated", "utf8")], "valid UTF-8 JSON"],
  ] as const)("refuses decision context with %s", async (_label, bytes, expected) => {
    const { handle } = freshRun();
    const digest = parseContextDigest(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
    if (!digest.ok) throw new Error(digest.error.message);

    const result = await handle.publishDecisionContext(digest.value, bytes);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(expected) } });
  });

  it("refuses different bytes already occupying the decision digest slot", async () => {
    const { directory, handle } = freshRun();
    const bytes = [...Buffer.from("{}", "utf8")];
    const digest = parseContextDigest(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
    if (!digest.ok) throw new Error(digest.error.message);
    writeFileSync(join(directory, "contexts", `${digest.value}.json`), '{"forged":true}');

    const result = await handle.publishDecisionContext(digest.value, bytes);

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("different decision context bytes already occupy this digest") },
    });
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

  it("reports a staged transcript cleanup failure with its exact path", async () => {
    const { directory, handle } = freshRun();
    const request = authority();
    await handle.reserveRequest(request);
    const bytes = [1, 2, 3];
    const stagedName = `attempt-1.raw.staged-${process.pid}-${createHash("sha256")
      .update(Uint8Array.from(bytes)).digest("hex").slice(0, 16)}`;
    const stagedPath = join(directory, "transcripts", request.slotId, stagedName);
    mkdirSync(stagedPath);

    const captured = await handle.captureTranscript(request, bytes);

    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.error.message).toContain("cannot capture transcript");
    expect(captured.error.message).toContain("staged cleanup failed");
    expect(captured.error.message).toContain(stagedName);
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

  it("refuses capture authority that reuses a reserved request id for another slot", async () => {
    const { handle } = freshRun();
    await handle.reserveRequest(authority());

    const captured = await handle.captureTranscript(authority({
      slotId: "slot-2" as AgentRequestAuthority["slotId"],
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    }), [1, 2, 3]);

    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.error.message).toContain("does not match its immutable reservation");
  });

  it("fails issued-request enumeration on malformed authority instead of omitting it", () => {
    const { directory, handle } = freshRun();
    writeFileSync(join(directory, "requests", "request-broken.json"), "{broken");

    const issued = handle.readIssuedRequests();

    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.error.message).toContain("request-broken.json");
  });

  it("refuses a harness correlator whose observed role differs from the request", async () => {
    const { handle } = freshRun();
    const request = authority();
    await handle.reserveRequest(request);

    const recorded = await handle.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId: "native-wrong-role",
      requestId: request.requestId,
      role: "silent-failure-hunter",
      attempt: request.attempt,
    });

    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.message).toContain("does not match");
  });

  it("refuses a malformed or foreign capture-rejection marker on read", async () => {
    const { handle, directory } = freshRun();
    const request = authority();
    await handle.reserveRequest(request);
    const markerPath = join(directory, "transcripts", request.slotId, `attempt-${request.attempt}.rejected`);

    let read = handle.readCaptureRejection(request);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toBeNull();

    // A marker that does not belong to the reserved request authority must be
    // refused, never reported as a diagnostic for this slot.
    writeFileSync(markerPath, JSON.stringify({ requestId: "request:other-agent", diagnostic: "foreign rejection" }));
    read = handle.readCaptureRejection(request);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.message).toContain("malformed or belongs to different authority");

    // A marker with a non-string diagnostic is equally refused: the diagnostic
    // is operator-facing prose and must not pass untyped.
    writeFileSync(markerPath, JSON.stringify({ requestId: request.requestId, diagnostic: 42 }));
    expect(handle.readCaptureRejection(request).ok).toBe(false);

    // The canonical marker round-trips.
    writeFileSync(markerPath, JSON.stringify({ requestId: request.requestId, diagnostic: "scope violation" }));
    read = handle.readCaptureRejection(request);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toBe("scope violation");
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

  it("refuses every staged suffix outside the generator's 24-character lowercase hex grammar", () => {
    const { root, directory } = freshRun();
    const final = join(directory, "artifacts", "suffix.json");
    const noncanonical = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/)
      .filter((suffix) => !/^[0-9a-f]{24}$/.test(suffix));

    fc.assert(fc.property(noncanonical, (suffix) => {
      expect(parseStagedArtifactPromotion(root, directory, {
        final,
        staged: `${final}.staged-${suffix}`,
      }).ok).toBe(false);
    }));
  });

  it("reports every parser-minted staged artifact it could not clean up", () => {
    const { root, directory } = freshRun();
    const final = join(directory, "artifacts", "occupied");
    const staged = `${final}.staged-${"1".repeat(24)}`;
    mkdirSync(staged);
    mkdirSync(final);

    const promoted = promoteArtifactSet([promotion(root, directory, staged, final)]);

    expect(promoted.ok).toBe(false);
    if (promoted.ok) return;
    expect(promoted.error.message).toContain("artifact slot is occupied by a directory");
    expect(promoted.error.message).toContain("staged cleanup failed");
    expect(promoted.error.message).toContain(staged);
  });

  it("rejects a structurally forged promotion that carries no parser mint", () => {
    const { directory } = freshRun();
    const final = join(directory, "artifacts", "forged.json");
    const staged = `${final}.staged-forged`;
    writeFileSync(staged, "forged");
    const forged = [{ staged, final }] as unknown as readonly StagedArtifactPromotion[];

    const promoted = promoteArtifactSet(forged);

    expect(promoted.ok).toBe(false);
    if (promoted.ok) return;
    expect(promoted.error.message).toContain("parser-minted staged authority");
    expect(readFileSync(staged, "utf-8")).toBe("forged");
  });

  it("refuses to mint promotion authority for paths outside the exact Run Directory", () => {
    const { root, directory } = freshRun();
    const final = join(root, "outside.json");

    const parsed = parseStagedArtifactPromotion(root, directory, {
      final,
      staged: `${final}.staged-outside`,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("beneath the Run Directory artifacts root");
  });

  it("refuses an empty artifact set rather than reporting a vacuous success", async () => {
    const { handle } = freshRun();
    const published = await handle.publishArtifactSet([]);
    expect(published.ok).toBe(false);
  });

  it("serializes concurrent publishers and returns references for the promoted bytes", async () => {
    const { directory, handle } = freshRun();
    const attempts = await Promise.all([
      handle.publishArtifactSet([{ relativePath: "race.bin", bytes: [1, 2, 3] }]),
      handle.publishArtifactSet([{ relativePath: "race.bin", bytes: [4, 5, 6] }]),
    ]);
    const successes = attempts.filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    const bytes = readFileSync(join(directory, "artifacts", "race.bin"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (successes[0]?.ok) expect(successes[0].value[0]?.digest).toBe(digest);
    expect(readdirSync(join(directory, "artifacts")).some((name) => name.includes(".staged-"))).toBe(false);
  });

  it("rejects traversal before it can overwrite a protected run artifact", async () => {
    const { directory, handle } = freshRun();
    const authorityBefore = readFileSync(join(directory, "authority.json"), "utf-8");

    const published = await handle.publishArtifactSet([
      { relativePath: "../authority.json", bytes: [...Buffer.from("forged", "utf-8")] },
    ]);

    expect(published.ok).toBe(false);
    expect(readFileSync(join(directory, "authority.json"), "utf-8")).toBe(authorityBefore);
    expect(readdirSync(join(directory, "artifacts"))).toEqual([]);
  });

  it("rejects duplicate normalized destinations before staging bytes", async () => {
    const { directory, handle } = freshRun();
    const published = await handle.publishArtifactSet([
      { relativePath: "report.json", bytes: [1] },
      { relativePath: "./report.json", bytes: [1] },
    ]);

    expect(published.ok).toBe(false);
    expect(readdirSync(join(directory, "artifacts"))).toEqual([]);
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

  /**
   * `renameSync` replaces an existing regular file, so the module's own O_EXCL
   * immutability promise ("republishing a slot fails loudly instead of silently
   * rewriting history") has to be enforced here explicitly. It matters because
   * the standalone result publishes to the FIXED slot `result.json` under a
   * CONTENT-ADDRESSED effect id: different bytes mean a different effect id, so
   * the runner's receipt short-circuit never fires and the second publish
   * reaches the same path.
   */
  describe("an occupied slot is never silently overwritten", () => {
    it("refuses a second publish of the same path with different bytes", async () => {
      const { directory, handle } = freshRun();
      const first = await handle.publishArtifactSet([
        { relativePath: "result.json", bytes: [...Buffer.from("{\"surviving\":3}", "utf-8")] },
      ]);
      expect(first.ok).toBe(true);

      const second = await handle.publishArtifactSet([
        { relativePath: "result.json", bytes: [...Buffer.from("{\"surviving\":0}", "utf-8")] },
      ]);

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.message).toContain("a different artifact already occupies this slot");
      // The originally published, audit-relevant bytes are still there.
      expect(readFileSync(join(directory, "artifacts", "result.json"), "utf-8")).toBe("{\"surviving\":3}");
      expect(readdirSync(join(directory, "artifacts")).some((name) => name.endsWith(".staged"))).toBe(false);
    });

    it("reports a parser-minted staged-file race cause instead of claiming the bytes differ", () => {
      const { root, directory } = freshRun();
      const final = join(directory, "artifacts", "result.json");
      const staged = `${final}.staged-${"2".repeat(24)}`;
      writeFileSync(final, "original");

      const promoted = promoteArtifactSet([promotion(root, directory, staged, final)]);

      expect(promoted.ok).toBe(false);
      if (promoted.ok) return;
      expect(promoted.error.message).toContain("cannot compare staged artifact bytes");
      expect(promoted.error.message).toContain(staged);
      expect(promoted.error.message).toContain("ENOENT");
      expect(promoted.error.message).not.toContain("a different artifact already occupies");
      expect(readFileSync(final, "utf-8")).toBe("original");
    });

    it("accepts a byte-identical republish as the idempotent replay it is", async () => {
      const { directory, handle } = freshRun();
      const bytes = [...Buffer.from("{\"surviving\":3}", "utf-8")];
      expect((await handle.publishArtifactSet([{ relativePath: "result.json", bytes }])).ok).toBe(true);

      const replay = await handle.publishArtifactSet([{ relativePath: "result.json", bytes }]);

      expect(replay.ok).toBe(true);
      expect(readFileSync(join(directory, "artifacts", "result.json"), "utf-8")).toBe("{\"surviving\":3}");
    });

    it("publishes no member of a set when one member's slot is already occupied differently", async () => {
      const { directory, handle } = freshRun();
      expect((await handle.publishArtifactSet([
        { relativePath: "taken.json", bytes: [...Buffer.from("original", "utf-8")] },
      ])).ok).toBe(true);

      const second = await handle.publishArtifactSet([
        { relativePath: "fresh.json", bytes: [...Buffer.from("fresh", "utf-8")] },
        { relativePath: "taken.json", bytes: [...Buffer.from("replacement", "utf-8")] },
      ]);

      expect(second.ok).toBe(false);
      const artifacts = readdirSync(join(directory, "artifacts"));
      expect(artifacts).not.toContain("fresh.json");
      expect(artifacts.some((name) => name.endsWith(".staged"))).toBe(false);
      expect(readFileSync(join(directory, "artifacts", "taken.json"), "utf-8")).toBe("original");
    });

    it("carries the read cause when an occupied slot is unreadable, so an ELOOP symlink race is not a generic refusal", async () => {
      const { directory, handle } = freshRun();
      const final = join(directory, "artifacts", "loop.json");
      // A self-symlink is an occupied slot the no-follow read can never read:
      // the refusal preserves ELOOP instead of collapsing permission,
      // symlink-race, and corruption into one generic result.
      symlinkSync(final, final);

      const promoted = await handle.publishArtifactSet([
        { relativePath: "loop.json", bytes: [...Buffer.from("new", "utf-8")] },
      ]);

      expect(promoted.ok).toBe(false);
      if (promoted.ok) return;
      expect(promoted.error.message).toContain("cannot inspect artifact slot");
      expect(promoted.error.message).toContain(final);
      expect(promoted.error.message).toContain("ELOOP");
      expect(readdirSync(join(directory, "artifacts")).some((name) => name.includes(".staged-"))).toBe(false);
    });
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
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.kind).toBe("raw-transcript-captured");
  });

  /**
   * A receipt is written with a plain O_EXCL open, so a crash mid-write leaves
   * a truncated file. Returning `null` for it would make "recorded but
   * unreadable" indistinguishable from "never ran", and the runner would
   * re-execute an effect it had already performed — the exact double-effect the
   * receipt exists to prevent.
   */
  describe("a corrupt receipt is not an absent one", () => {
    const corruptReceipt = (directory: string, effectId: string) => {
      writeFileSync(join(directory, "receipts", `${effectId}.json`), "{ this is not json", "utf-8");
    };

    it("reports an unreadable receipt as a failure rather than as absent", async () => {
      const { directory, handle } = freshRun();
      corruptReceipt(directory, "effect:capture-1");

      const stored = handle.readReceipt("effect:capture-1" as EffectReceipt["effectId"]);

      expect(stored.ok).toBe(false);
      if (stored.ok) return;
      expect(stored.error.message).toContain("unreadable");
    });

    it("still reports a receipt that was never written as absent", () => {
      const { handle } = freshRun();
      expect(handle.readReceipt("effect:never-ran" as EffectReceipt["effectId"]))
        .toEqual({ ok: true, value: null });
    });

    it("stops the effect runner instead of re-executing the effect", async () => {
      const { directory, handle } = freshRun();
      await handle.reserveRequest(authority());
      const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });
      const intent = captureIntent([7, 8, 9]);
      expect((await runner(intent)).ok).toBe(true);
      corruptReceipt(directory, "effect:capture-1");

      const resumed = await runner(intent);

      expect(resumed.ok).toBe(false);
      if (resumed.ok) return;
      expect(resumed.error.message).toContain("unreadable");
      // Retriable: the effect may well have happened, so the operator has to
      // resolve the receipt rather than the runner guessing it did not.
      expect(resumed.error.retriable).toBe(true);
    });
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
    expect(handle.readReceipt("effect:commit-1" as EffectReceipt["effectId"])).toEqual({ ok: true, value: null });
  });

  it("preserves an external port error name and cause", async () => {
    const { handle } = freshRun();
    const portError = new Error("commit failed", { cause: new Error("socket reset") });
    portError.name = "DatabaseUnavailable";
    const runner = createEffectRunner({
      handle,
      ports: ports({ commitProtectedWaveState: async () => { throw portError; } }),
      resolveArtifacts: () => [],
    });

    const result = await runner({
      kind: "commit-protected-wave-state",
      effectId: "effect:commit-diagnostic",
      runId: RUN_ID,
      expectedRevision: 0,
      stateDigest: "b".repeat(64),
    } as EffectIntent);

    expect(result).toMatchObject({
      ok: false,
      error: {
        retriable: true,
        message: "DatabaseUnavailable: commit failed (caused by Error: socket reset)",
      },
    });
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
    expect(handle.readReceipt("effect:commit-1" as EffectReceipt["effectId"])).toEqual({ ok: true, value: null });
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

  it("reconciles staged digest and slot before publishing any bytes", async () => {
    const { directory, handle } = freshRun();
    const staged = createStagedArtifact("result.json", [...Buffer.from("{}", "utf-8")]);
    if (!staged.ok) throw new Error(staged.error.message);
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [staged.value] });

    const result = await runner({
      kind: "publish-artifact-set",
      effectId: "effect:publish-preflight",
      runId: RUN_ID,
      artifacts: [{
        runId: RUN_ID,
        slot: { kind: "fixed-artifact-slot", path: "artifacts/result.json" },
        digest: "0".repeat(64),
        byteLength: 2,
      }],
    } as unknown as EffectIntent);

    expect(result.ok).toBe(false);
    expect(readdirSync(join(directory, "artifacts"))).toEqual([]);
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

  it("rejects schema-invalid event JSON instead of casting it into replay", async () => {
    const { directory, handle } = freshRun();
    writeFileSync(join(directory, "events", "000000-bad.json"), JSON.stringify({}));

    await expect(handle.readEvents()).rejects.toThrow(/Corrupt program event/);
  });

  it("rejects event filename and record identity disagreement", async () => {
    const { directory, handle } = freshRun();
    writeFileSync(join(directory, "events", "000000-key-a.json"), JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      dedupKey: "key-b",
      recordedAtMs: 1,
      event: { kind: "x" },
    }));

    await expect(handle.readEvents()).rejects.toThrow(/filename does not match|sequence prefix/);
  });
});

// --- Anchoring, ordering and recovery under fault -------------------------

describe("run-directory anchoring holds for directory creation, not just writes", () => {
  // The module opens every hop under O_NOFOLLOW so a planted symlink is refused
  // rather than followed. `mkdirSync(path, { recursive: true })` resolves the
  // whole path through the kernel instead, which would create directories at a
  // symlinked component's TARGET — a side effect that lands before the anchored
  // write that would have refused it.
  it("never creates a transcript slot through a symlinked transcripts directory", async () => {
    const { root, directory, handle } = freshRun();
    const escape = join(root, "escape");
    mkdirSync(escape, { recursive: true });
    rmSync(join(directory, "transcripts"), { recursive: true, force: true });
    symlinkSync(escape, join(directory, "transcripts"));

    const reserved = await handle.reserveRequest(authority());

    expect(reserved.ok).toBe(false);
    expect(readdirSync(escape)).toEqual([]);
  });

  it("never creates a nested artifact directory through a symlinked artifacts directory", async () => {
    const { root, directory, handle } = freshRun();
    const escape = join(root, "escape-artifacts");
    mkdirSync(escape, { recursive: true });
    rmSync(join(directory, "artifacts"), { recursive: true, force: true });
    symlinkSync(escape, join(directory, "artifacts"));

    const published = await handle.publishArtifactSet([
      { relativePath: "nested/report.md", bytes: [...Buffer.from("# report", "utf-8")] },
    ]);

    expect(published.ok).toBe(false);
    expect(readdirSync(escape)).toEqual([]);
  });

  it("never creates an append lock through a swapped events symlink", async () => {
    const { root, directory, handle } = freshRun();
    const escape = join(root, "escape-events");
    mkdirSync(escape, { recursive: true });
    rmSync(join(directory, "events"), { recursive: true, force: true });
    symlinkSync(escape, join(directory, "events"));

    await expect(handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: "safe-key",
      recordedAtMs: 1,
      event: { kind: "x" },
    })).rejects.toThrow();
    expect(readdirSync(escape)).toEqual([]);
  });
});

describe("event journal ordering", () => {
  const event = (dedupKey: string) => ({
    schemaVersion: 1 as const,
    sequence: 0,
    dedupKey,
    recordedAtMs: 1,
    event: { kind: dedupKey },
  });

  // `sequence` is the append ORDER and it is derived from a directory listing,
  // so it cannot be arbitrated by O_EXCL on the filename: two appenders with
  // DIFFERENT dedup keys write differently-named files and nothing refuses the
  // second. `readEvents` then sorts by filename, so a collision would rank
  // records by dedup-key text rather than by happens-before.
  it("assigns distinct, gap-free sequences across concurrent appends", async () => {
    const { directory, handle } = freshRun();

    await Promise.all(
      ["dk-a", "dk-b", "dk-c", "dk-d", "dk-e"].map((key) => handle.appendEvent(event(key))),
    );

    const records = await handle.readEvents();
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(readdirSync(join(directory, "events"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, 6))).size).toBe(5);
  });

  it("stays idempotent on dedup key under concurrency", async () => {
    const { handle } = freshRun();

    await Promise.all([0, 1, 2, 3].map(() => handle.appendEvent(event("dk-same"))));

    expect(await handle.readEvents()).toHaveLength(1);
  });

  // `resumeProgram` short-circuits on a null checkpoint and skips the
  // checkpoint-vs-replay corruption check, so "absent" and "unreadable" must
  // stay distinguishable — exactly as `readReceipt` keeps them.
  it("fails closed on an unreadable checkpoint instead of reporting none", async () => {
    const { directory, handle } = freshRun();
    symlinkSync(join(directory, "authority.json"), join(directory, "checkpoint.json"));

    await expect(handle.readCheckpoint()).rejects.toThrow();
  });
});

describe("promoteArtifactSet partial-promotion recovery", () => {
  // Every failure reachable through publishArtifactSet is turned into an
  // all-staged refusal by the pre-checks, so this arm — a member that fails to
  // rename AFTER an earlier member already promoted — uses parser-minted test
  // authority for exact in-run paths rather than an exported structural pair.
  it("discards the unpromoted remainder and reports failure", () => {
    const { root, directory } = freshRun();
    const artifacts = join(directory, "artifacts");
    const firstFinal = join(artifacts, "first.json");
    const firstStaged = `${firstFinal}.staged-${"3".repeat(24)}`;
    writeFileSync(firstStaged, "first");
    const missing = join(artifacts, "vanished");
    const secondFinal = join(missing, "second.json");
    const secondStaged = `${secondFinal}.staged-${"3".repeat(24)}`;

    const promoted = promoteArtifactSet([
      promotion(root, directory, firstStaged, firstFinal),
      promotion(root, directory, secondStaged, secondFinal),
    ]);

    expect(promoted.ok).toBe(false);
    if (promoted.ok) return;
    expect(promoted.error.message).toContain("cannot publish artifact set");
    expect(readFileSync(firstFinal, "utf-8")).toBe("first");
    expect(readdirSync(artifacts).some((name) => name.includes(".staged-"))).toBe(false);
  });
});

// --- reserve-agent-requests: partial failure --------------------------------

/**
 * `runReserveAgentRequests` reserves each request in turn and returns on the
 * FIRST failure — with every earlier reservation already written to disk. That
 * partial-success semantic (no rollback, by design: reservations are the
 * durable identity later attempts are proven against) was never driven
 * end-to-end. Only `reconcileEffectReceipt` and the machine reducers mentioned
 * the intent; nothing put a failing member behind a succeeding one and looked
 * at what survived.
 *
 * The behaviour worth pinning is precisely that the failure is REPORTED (so no
 * receipt is recorded and the effect stays unfinished) while the earlier
 * reservation REMAINS (so a retry reconciles against the same identity rather
 * than minting a second one).
 */
describe("reserving a batch of agent requests", () => {
  const reserveIntent = (requests: readonly AgentRequestAuthority[]): EffectIntent => ({
    kind: "reserve-agent-requests",
    effectId: "effect:reserve-1",
    runId: RUN_ID,
    requests,
  } as EffectIntent);

  it("reserves every member of a well-formed batch", async () => {
    const { directory, handle } = freshRun();
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });

    const result = await runner(reserveIntent([
      authority({ requestId: "request:reviewer:1", slotId: "slot-1" }),
      authority({
        requestId: "request:reviewer:2",
        slotId: "slot-2",
        outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
      } as Partial<AgentRequestAuthority>),
    ]));

    expect(result.ok).toBe(true);
    expect(readdirSync(join(directory, "requests")).filter((name) => name.endsWith(".json")))
      .toHaveLength(2);
  });

  it("reports the failure and KEEPS the reservations that already landed", async () => {
    const { directory, handle } = freshRun();
    const first = authority({ requestId: "request:reviewer:1", slotId: "slot-1" });
    // The second member re-uses the first member's request id with different
    // authority, so its reservation is refused AFTER the first has been written.
    const conflicting = authority({
      requestId: "request:reviewer:1",
      slotId: "slot-2",
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    });
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });

    const result = await runner(reserveIntent([first, conflicting]));

    expect(result.ok).toBe(false);
    // No receipt: the effect is unfinished, so a resume re-runs it rather than
    // replaying a success that never happened.
    const receipt = handle.readReceipt("effect:reserve-1" as EffectIntent["effectId"]);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.value).toBeNull();
    // The first reservation stands — deliberately not rolled back.
    const reserved = readdirSync(join(directory, "requests")).filter((name) => name.endsWith(".json"));
    expect(reserved).toHaveLength(1);
  });

  it("re-running after a partial failure reconciles the surviving reservation instead of duplicating it", async () => {
    const { directory, handle } = freshRun();
    const first = authority({ requestId: "request:reviewer:1", slotId: "slot-1" });
    const conflicting = authority({
      requestId: "request:reviewer:1",
      slotId: "slot-2",
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    });
    const runner = createEffectRunner({ handle, ports: ports(), resolveArtifacts: () => [] });
    expect((await runner(reserveIntent([first, conflicting]))).ok).toBe(false);

    // The retry that a real resume performs: same batch, corrected second
    // member. The already-reserved first member must be accepted as itself.
    const corrected = authority({
      requestId: "request:reviewer:2",
      slotId: "slot-2",
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    });

    const retried = await runner(reserveIntent([first, corrected]));

    expect(retried.ok).toBe(true);
    expect(readdirSync(join(directory, "requests")).filter((name) => name.endsWith(".json")))
      .toHaveLength(2);
  });
});
