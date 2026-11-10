/**
 * The capture pipeline's attestation write-ahead step
 * (`attestSecurityVerifierCapture`, ADR-0067 amended), at its own seam over a
 * real temp `LOOM_SUBAGENT_DIR` and a real run directory: proceed is an
 * explicit value, a permanent attestation conflict is a NAMED terminal
 * rejection (a retry of the same bytes can never clear it), and only transient
 * store I/O is retriable. The end-to-end capture paths are
 * `tests/handlers/security-verification.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { PERSISTENT_SUBAGENT_STORES } from "../../src/config";
import { mintAgentRosterSlot, parseArtifactDigest, type AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { parseSecurityFindings } from "../../src/core/security-findings";
import {
  deriveVerificationBriefs,
  parseAuditReference,
  verificationStartOf,
  verifierSlotIdentities,
} from "../../src/core/security-verification";
import { CAPTURE_SCHEMA_VERSION, type CaptureReceipt } from "../../src/core/harness-capture";
import { captureAttestationLookup } from "../../src/orchestration/capture-attestation-store";
import { attestSecurityVerifierCapture } from "../../src/orchestration/harness-capture-runtime";
import { aConfirmedFinding, ok } from "../security/fixtures";

let root: string;
let saved: string | undefined;
let runDirectory: string;

beforeEach(() => {
  root = canonicalTempDir("loom-attestation-step-");
  saved = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  runDirectory = join(root, "runs", "run.verify-w1-000000000000");
  mkdirSync(runDirectory, { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

const storeDir = (): string => PERSISTENT_SUBAGENT_STORES.captureAttestations.dir();

/** A verifier request minted by the catalog exactly as the program mints it. */
const verifierRequest = (): AgentRequestAuthority => {
  const audit = ok(parseAuditReference({ locator: "/audits/run-1", runId: "run-1", ledgerDigest: "1".repeat(64), findingsDigest: "2".repeat(64) }));
  const findings = ok(parseSecurityFindings([aConfirmedFinding({ fingerprint: "a/b:one", root_cause: "root cause 0" })]));
  const brief = deriveVerificationBriefs({ issue: ok(verificationStartOf(audit, 1, 1)), findings, verdicts: [] })[0];
  if (brief === undefined) throw new Error("the fixture derives one brief");
  const [first, retry] = verifierSlotIdentities("run.verify-w1-000000000000", brief, ["c".repeat(64), "d".repeat(64)]);
  return ok(mintAgentRosterSlot(first, retry)).attempts[0];
};

const receiptOf = (request: AgentRequestAuthority, digest: string, byteLength = 12): CaptureReceipt => ({
  schemaVersion: CAPTURE_SCHEMA_VERSION, kind: "capture-receipt", harness: "claude", requestId: request.requestId,
  slotId: request.slotId, attempt: request.attempt, nativeId: "agent-1", byteLength,
  digest: ok(parseArtifactDigest(digest)),
});

describe("attestSecurityVerifierCapture", () => {
  it("records the attestation and proceeds, and proceeds again for the identical capture", () => {
    const request = verifierRequest();
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64)))).toEqual({ ok: true, value: undefined });
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64)))).toEqual({ ok: true, value: undefined });
    expect(captureAttestationLookup(runDirectory)(request.requestId)).toMatchObject({ kind: "attested", attestation: { digest: "a".repeat(64) } });
  });

  it("names a capture of DIFFERENT bytes as a terminal attestation conflict, keeping the first attestation", () => {
    const request = verifierRequest();
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64))).ok).toBe(true);
    const conflict = attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "b".repeat(64), 13));
    if (conflict.ok) throw new Error("expected the different capture to stop");
    expect(conflict.error).toMatchObject({ kind: "terminal-rejection", reason: "capture-attestation-conflict" });
    if (conflict.error.kind !== "terminal-rejection") throw new Error("narrowed above");
    expect(conflict.error.message).toContain(`attested ${"a".repeat(64)}, 12 bytes`);
    expect(conflict.error.message).toContain(`this capture ${"b".repeat(64)}, 13 bytes`);
    expect(conflict.error.message).toContain("retrying these bytes cannot succeed");
    // Every retry of the same bytes meets the same terminal answer.
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "b".repeat(64), 13))).toEqual(conflict);
    expect(captureAttestationLookup(runDirectory)(request.requestId)).toMatchObject({ kind: "attested", attestation: { digest: "a".repeat(64) } });
  });

  it("keeps transient store I/O retriable, and the same capture succeeds once the store is repaired", () => {
    const request = verifierRequest();
    mkdirSync(join(root, "subagents"), { recursive: true });
    writeFileSync(storeDir(), "not a directory");
    const blocked = attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64)));
    if (blocked.ok) throw new Error("expected the unwritable store to stop the capture");
    expect(blocked.error).toMatchObject({ kind: "retriable-failure", reason: "capture-attestation" });
    rmSync(storeDir());
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64)))).toEqual({ ok: true, value: undefined });
  });

  it("is retriable, not a conflict, when the run directory cannot be resolved", () => {
    const request = verifierRequest();
    const missing = attestSecurityVerifierCapture(join(root, "no-such-run"), request, receiptOf(request, "a".repeat(64)));
    if (missing.ok) throw new Error("expected an unresolvable run directory to stop the capture");
    expect(missing.error).toMatchObject({ kind: "retriable-failure", reason: "capture-attestation" });
  });

  it("attests nothing for a request of another program", () => {
    const request: AgentRequestAuthority = { ...verifierRequest(), program: "refutation-panel" };
    expect(attestSecurityVerifierCapture(runDirectory, request, receiptOf(request, "a".repeat(64)))).toEqual({ ok: true, value: undefined });
    expect(() => readdirSync(storeDir())).toThrow();
  });
});
