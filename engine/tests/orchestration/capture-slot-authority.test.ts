/**
 * Round 36 (architecture-tech-lead-1, pr-test-analyzer-1, pr-test-analyzer-2).
 *
 * The run-directory handle offers no arbitrary path API, so its branded
 * `SlotId` advertised "verify then act" over transcripts. It did that on the two
 * WRITE paths (`captureTranscript`, `rejectCapture`) and "trust the caller and
 * read" on the two READ paths, which meant a forged `slotId` could read — and in
 * a panel proof ATTEST — another request's bytes while the type said it could
 * not. These tests pin the read paths to the same reservation equality, and pin
 * the correlator controls that stop one agent's bytes landing in another
 * request's slot (previously untested, so both arms could be deleted without a
 * single test failing).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { createRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const digest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

/** One run directory holding two RESERVED requests of different slots. */
async function stagedRun(): Promise<Readonly<{
  runsRoot: string;
  directory: string;
  first: AgentRequestAuthority;
  second: AgentRequestAuthority;
  handle: RunDirHandle;
}>> {
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-slot-authority-"));
  cleanup.push(runsRoot);
  const directory = join(runsRoot, "run.slot-authority");
  mkdirSync(directory, { recursive: true });
  const opened = createRunDirectory(runsRoot, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  const handle = opened.value;
  const first = agentRequestAuthority("run.slot-authority", {
    requestId: "request:reviewer:1",
    slotId: "slot-1",
    attempt: 1,
    contextDigest: digest("context-one"),
  });
  const second = agentRequestAuthority("run.slot-authority", {
    requestId: "request:reviewer:2",
    slotId: "slot-2",
    attempt: 1,
    role: "silent-failure-hunter",
    contextDigest: digest("context-two"),
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
  });
  for (const request of [first, second]) {
    const reserved = await handle.reserveRequest(request);
    if (!reserved.ok) throw new Error(reserved.error.message);
  }
  const written = await handle.captureTranscript(first, Array.from(new TextEncoder().encode("FIRST EVIDENCE")));
  if (!written.ok) throw new Error(written.error.message);
  return { runsRoot, directory, first, second, handle };
}

describe("transcript reads are verified against the immutable reservation", () => {
  it("returns the exact bytes for the issued authority", async () => {
    const { handle, first } = await stagedRun();

    const bytes = handle.readTranscriptBytes(first);

    expect(bytes.ok).toBe(true);
    if (!bytes.ok) return;
    expect(new TextDecoder().decode(bytes.value)).toBe("FIRST EVIDENCE");
  });

  it("refuses a caller that swaps the slot of a real request instead of reading another slot's bytes", async () => {
    const { handle, first, second } = await stagedRun();

    // Same requestId as the reservation, but addressed at the OTHER request's
    // slot: exactly the forgery the branded SlotId promised was impossible.
    const forged = agentRequestAuthority("run.slot-authority", {
      requestId: first.requestId,
      slotId: second.slotId,
      attempt: first.attempt,
      contextDigest: first.contextDigest,
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    });

    const read = handle.readTranscriptBytes(forged);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("does not match its immutable reservation");
  });

  it("refuses a traversal-shaped slot id instead of reading outside the run directory", async () => {
    const { handle, first } = await stagedRun();

    const escaped = agentRequestAuthority("run.slot-authority", {
      requestId: first.requestId,
      slotId: "../../../../etc/hostname",
      attempt: first.attempt,
      contextDigest: first.contextDigest,
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
    });

    const read = handle.readTranscriptBytes(escaped);

    // Refused BEFORE any path is built: `slotId` is a branded domain value, so a
    // traversal string never even parses as an authority. Either way nothing is
    // read, which is the property this test pins.
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("transcript read authority is malformed");
  });

  it("refuses an authority from a different run", async () => {
    const { handle, first } = await stagedRun();

    const foreign = agentRequestAuthority("run.some-other-run", {
      requestId: first.requestId,
      slotId: first.slotId,
      attempt: first.attempt,
      contextDigest: first.contextDigest,
    });

    const read = handle.readTranscriptBytes(foreign);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("different run");
  });
});

describe("capture-rejection reads", () => {
  it("reports no rejection for a request this run never reserved", async () => {
    const { handle } = await stagedRun();

    const notIssued = agentRequestAuthority("run.slot-authority", {
      requestId: "request:reviewer:9",
      slotId: "slot-9",
      attempt: 2,
      contextDigest: digest("context-nine"),
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-9/attempt-2.raw" },
    });

    const marker = handle.readCaptureRejection(notIssued);

    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(marker.value).toBeNull();
  });

  it("reads back the diagnostic it terminalised, for the reserved authority", async () => {
    const { handle, second } = await stagedRun();

    const rejected = await handle.rejectCapture(second, "no-final-payload: agent said nothing");
    expect(rejected.ok).toBe(true);

    const marker = handle.readCaptureRejection(second);
    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(marker.value).toContain("no-final-payload");
  });

  it("accepts an identical marker replay and refuses a conflicting diagnostic", async () => {
    const { handle, second } = await stagedRun();

    expect((await handle.rejectCapture(second, "no-final-payload: agent said nothing")).ok).toBe(true);
    expect((await handle.rejectCapture(second, "no-final-payload: agent said nothing")).ok).toBe(true);
    const conflict = await handle.rejectCapture(second, "agent-failed: endpoint disconnected");

    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.message).toContain("conflicts with its immutable diagnostic");
    expect(handle.readCaptureRejection(second)).toEqual({
      ok: true,
      value: "no-final-payload: agent said nothing",
    });
  });

  it("refuses a rejection read whose slot addressing does not match the reservation", async () => {
    const { handle, first, second } = await stagedRun();

    const mismatched = agentRequestAuthority("run.slot-authority", {
      requestId: second.requestId,
      slotId: first.slotId,
      attempt: second.attempt,
      contextDigest: second.contextDigest,
    });

    const marker = handle.readCaptureRejection(mismatched);

    expect(marker.ok).toBe(false);
    if (marker.ok) return;
    expect(marker.error.message).toContain("rejection authority does not match its immutable reservation");
  });
});

describe("harness correlator write-once discipline", () => {
  const bindingFor = (nativeId: string, request: AgentRequestAuthority) => ({
    schemaVersion: 1 as const,
    harness: "pi" as const,
    nativeId,
    requestId: request.requestId,
    role: request.role,
    attempt: request.attempt,
  });

  it("accepts a byte-identical replay of the same binding", async () => {
    const { handle, first } = await stagedRun();

    const firstWrite = await handle.recordHarnessCorrelator(bindingFor("pi-native-1", first));
    const replay = await handle.recordHarnessCorrelator(bindingFor("pi-native-1", first));

    expect(firstWrite.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value).toEqual(firstWrite.ok ? firstWrite.value : null);
  });

  it("refuses one native id bound to two different requests", async () => {
    const { handle, first, second } = await stagedRun();

    await handle.recordHarnessCorrelator(bindingFor("pi-native-1", first));
    const conflict = await handle.recordHarnessCorrelator(bindingFor("pi-native-1", second));

    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.message).toContain("already bound to different request authority");
  });

  it("refuses a correlator recorded for the wrong attempt", async () => {
    const { handle, first } = await stagedRun();

    const wrongAttempt = await handle.recordHarnessCorrelator({
      ...bindingFor("pi-native-attempt", first),
      attempt: 2,
    });

    expect(wrongAttempt.ok).toBe(false);
    if (wrongAttempt.ok) return;
    expect(wrongAttempt.error.message).toContain("attempt does not match request");
  });

  it("refuses a correlator recorded for the wrong role", async () => {
    const { handle, first } = await stagedRun();

    const wrongRole = await handle.recordHarnessCorrelator({
      ...bindingFor("pi-native-role", first),
      role: "spec-check-invoker",
    });

    expect(wrongRole.ok).toBe(false);
    if (wrongRole.ok) return;
    expect(wrongRole.error.message).toContain("does not match request");
  });

  it("refuses a stored binding that answers to a different lookup identity", async () => {
    const { handle, directory, first } = await stagedRun();
    await handle.recordHarnessCorrelator(bindingFor("pi-native-lookup", first));

    // Rewrite the file the lookup for `pi-native-lookup` resolves to so it
    // names a DIFFERENT native id while remaining a structurally valid, fully
    // reserved binding. The stored bytes must still be refused against the key
    // that addressed them.
    const correlatorDigest = digest(`pi\0pi-native-lookup`);
    writeFileSync(
      join(directory, "requests", "correlators", `${correlatorDigest}.json`),
      JSON.stringify({ ...bindingFor("pi-native-elsewhere", first), nativeId: "pi-native-elsewhere" }),
    );

    const read = handle.readHarnessCorrelator("pi", "pi-native-lookup");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("lookup identity");
  });

  it("refuses a symlinked correlator whose target is a FULLY VALID binding for another request", async () => {
    const { handle, directory, first, second } = await stagedRun();
    // Bind the SECOND request legitimately, then swap the FIRST request's
    // correlator file for a symlink to it. The target parses and describes a
    // real reserved request, so only O_NOFOLLOW can refuse this swap — a
    // test that planted a malformed target would pass with the flag removed.
    await handle.recordHarnessCorrelator(bindingFor("pi-native-victim", first));
    await handle.recordHarnessCorrelator(bindingFor("pi-native-attacker", second));

    const correlatorDir = join(directory, "requests", "correlators");
    const attackerName = `${digest("pi\0pi-native-attacker")}.json`;
    const victimName = `${digest("pi\0pi-native-victim")}.json`;
    const target = join(correlatorDir, attackerName);
    rmSync(join(correlatorDir, victimName));
    symlinkSync(target, join(correlatorDir, victimName));

    const read = handle.readHarnessCorrelator("pi", "pi-native-victim");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.message).toContain("unreadable");
  });
});
