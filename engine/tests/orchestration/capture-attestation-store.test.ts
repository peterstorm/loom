/**
 * The capture attestation store (ADR-0067, amended) at its own seam: the
 * never-replace publication and the fail-closed, read-by-name lookup, over a
 * real temp `LOOM_SUBAGENT_DIR`. The end-to-end paths (a tampered or deleted
 * store refusing a ballot) are `tests/handlers/security-verification.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { PERSISTENT_SUBAGENT_STORES, subagentDir } from "../../src/config";
import {
  captureAttestationEntryName,
  mintCaptureAttestation,
  renderCaptureAttestation,
  type CaptureAttestation,
  type CaptureAttestationFields,
} from "../../src/core/capture-attestation";
import { captureAttestationLookup, recordCaptureAttestation } from "../../src/orchestration/capture-attestation-store";

let root: string;
let saved: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-attestation-store-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

const storeDir = (): string => PERSISTENT_SUBAGENT_STORES.captureAttestations.dir();

const RUN = "/runs/run.verify-w1-g1-000000000000";

/** A minted attestation (the type has one constructor), with fields overridden. */
const anAttestation = (overrides: Partial<CaptureAttestationFields> = {}): CaptureAttestation => {
  const minted = mintCaptureAttestation({ runId: "run.verify-w1-g1-000000000000", runDirectory: RUN, requestId: "request:1",
    slotId: "slot:1", attempt: 1, harness: "claude", nativeId: "agent-1", digest: "a".repeat(64), byteLength: 42, ...overrides });
  if (!minted.ok) throw new Error(minted.error);
  return minted.value;
};

/** Write raw bytes under the entry name of one (run, request), as an arranged state. */
const seedEntry = (requestId: string, text: string): string => {
  mkdirSync(storeDir(), { recursive: true });
  const name = captureAttestationEntryName(RUN, requestId);
  writeFileSync(join(storeDir(), name), text);
  return name;
};

describe("CaptureAttestation: one constructor", () => {
  it("is built only by minting — a record literal of the same shape is not an attestation", () => {
    const literal = {
      schemaVersion: 1, kind: "security-capture-attestation", program: "security-verification",
      runId: "run.verify-w1-g1-000000000000", runDirectory: RUN, requestId: "request:1", slotId: "slot:1", attempt: 1,
      role: "security-verifier-agent", harness: "claude", nativeId: "agent-1", digest: "a".repeat(64), byteLength: 42,
    } as const;
    // @ts-expect-error a CaptureAttestation carries the brand only mintCaptureAttestation gives it
    const unminted: CaptureAttestation = literal;
    // The minted value is field-for-field the literal: the brand is a type, not a byte.
    expect(anAttestation()).toEqual(unminted);
    expect(renderCaptureAttestation(anAttestation())).toBe(`${JSON.stringify(literal)}\n`);
  });

  it("refuses to mint outside the bounds, ids before the measure", () => {
    expect(mintCaptureAttestation({ runId: "", runDirectory: RUN, requestId: "request:1", slotId: "slot:1", attempt: 1,
      harness: "claude", nativeId: "agent-1", digest: 7, byteLength: 42 })).toEqual({ ok: false, error: "names a malformed run, request, slot or native id" });
    expect(mintCaptureAttestation({ runId: "run", runDirectory: RUN, requestId: "request:1", slotId: "slot:1", attempt: 1,
      harness: "claude", nativeId: "agent-1", digest: "a".repeat(64), byteLength: -1 })).toEqual({ ok: false, error: "carries a malformed digest or length" });
  });
});

describe("recordCaptureAttestation: an attestation is never replaced", () => {
  it("records once, and the lookup reads it back", () => {
    const attestation = anAttestation();
    expect(recordCaptureAttestation(attestation)).toEqual({ ok: true, value: undefined });
    expect(captureAttestationLookup(RUN)("request:1")).toEqual({ kind: "attested", attestation });
  });

  it("is idempotent for the identical bytes (a re-delivered stop of the same capture)", () => {
    expect(recordCaptureAttestation(anAttestation()).ok).toBe(true);
    expect(recordCaptureAttestation(anAttestation())).toEqual({ ok: true, value: undefined });
    expect(readdirSync(storeDir())).toHaveLength(1);
  });

  it("refuses different bytes under the same (run, request), keeping the first", () => {
    const first = anAttestation();
    expect(recordCaptureAttestation(first).ok).toBe(true);
    const second = recordCaptureAttestation(anAttestation({ digest: "b".repeat(64) }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already holds a different capture attestation");
    expect(captureAttestationLookup(RUN)("request:1")).toEqual({ kind: "attested", attestation: first });
  });

  it("refuses to record into a store that is a symlink, writing nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(subagentDir(), { recursive: true });
    symlinkSync(elsewhere, storeDir());
    const recorded = recordCaptureAttestation(anAttestation());
    expect(recorded.ok).toBe(false);
    if (!recorded.ok) expect(recorded.error).toContain("cannot record the capture attestation of request:1");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("captureAttestationLookup: reads the one entry a request names, fail-closed", () => {
  it("answers absent when the subagent dir, the store, or the entry does not exist", () => {
    expect(captureAttestationLookup(RUN)("request:1")).toEqual({ kind: "absent" });
    mkdirSync(subagentDir(), { recursive: true });
    expect(captureAttestationLookup(RUN)("request:1")).toEqual({ kind: "absent" });
    expect(recordCaptureAttestation(anAttestation({ requestId: "request:2" })).ok).toBe(true);
    expect(captureAttestationLookup(RUN)("request:1")).toEqual({ kind: "absent" });
  });

  it("does not let an unrelated damaged entry, or an interrupted publish's leftover, refuse another request", () => {
    expect(recordCaptureAttestation(anAttestation()).ok).toBe(true);
    seedEntry("request:other", "{ damaged");
    writeFileSync(join(storeDir(), `${captureAttestationEntryName(RUN, "request:1")}.claim-1-2-abc`), "partial");
    expect(captureAttestationLookup(RUN)("request:1").kind).toBe("attested");
    // The damaged entry itself still refuses the request it names.
    expect(captureAttestationLookup(RUN)("request:other")).toMatchObject({ kind: "refused", reason: expect.stringContaining("is not JSON") });
  });

  it.each([
    ["is not JSON", "{ not an attestation", "is not JSON"],
    ["is not in canonical form", `${JSON.stringify(JSON.parse(renderCaptureAttestation(anAttestation())))} \n`, "canonical form"],
    ["names another request", renderCaptureAttestation(anAttestation({ requestId: "request:2" })), "does not match the run directory and request"],
  ])("refuses an entry that %s, never answering absent", (_case, text, reason) => {
    seedEntry("request:1", text);
    expect(captureAttestationLookup(RUN)("request:1")).toMatchObject({ kind: "refused", reason: expect.stringContaining(reason) });
  });

  it("refuses an entry that is a symlink, even to a genuine attestation", () => {
    const genuine = join(root, "genuine.json");
    writeFileSync(genuine, renderCaptureAttestation(anAttestation()));
    mkdirSync(storeDir(), { recursive: true });
    symlinkSync(genuine, join(storeDir(), captureAttestationEntryName(RUN, "request:1")));
    expect(captureAttestationLookup(RUN)("request:1")).toMatchObject({ kind: "refused", reason: expect.stringContaining("cannot be read") });
  });

  it.each([
    ["a symlinked store", () => { mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), storeDir()); }],
    ["a dangling symlink in the store's place", () => symlinkSync(join(root, "missing-target"), storeDir())],
    ["a plain file in the store's place", () => writeFileSync(storeDir(), "not a directory")],
  ])("refuses every lookup on %s (an unobservable store is never 'absent')", (_case, arrange) => {
    mkdirSync(subagentDir(), { recursive: true });
    arrange();
    expect(captureAttestationLookup(RUN)("request:1")).toMatchObject({ kind: "refused", reason: expect.stringContaining("cannot be read") });
  });

  it("reads the store at each question, not once: a later record is visible to an earlier lookup", () => {
    const lookup = captureAttestationLookup(RUN);
    expect(lookup("request:1")).toEqual({ kind: "absent" });
    expect(recordCaptureAttestation(anAttestation()).ok).toBe(true);
    expect(lookup("request:1").kind).toBe("attested");
  });
});
