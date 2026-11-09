/**
 * Capture attestations (ADR-0067, amended): the persisted proof that a
 * security verifier's transcript was captured by a HARNESS, not written by
 * whoever can reach the run directory.
 *
 * The capturing harness process (Claude Code's SubagentStop hook, the Pi
 * extension) writes one attestation per captured verifier attempt into a
 * store under the protected subagent directory, beside the bytes it wrote
 * into the run. The attestation names the request it answers — program, run,
 * run directory, request, slot, attempt, role — the harness's own native id,
 * and the digest and length of the exact bytes captured. A ballot is
 * authoritative only when its binding's `captureDigest` equals the attested
 * digest of its request, and the transcript in the run still hashes to it.
 *
 * This module is the pure half: the record, its canonical bytes, its parser
 * (the store fails closed on anything it does not parse), the entry name that
 * binds a record to the (run directory, request) it attests, and the decision
 * whether a set of ballots is attested. The store is
 * `orchestration/capture-attestation-store.ts`.
 */

import { sha256Hex } from "./digest";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import type { AgentRequestAuthority } from "./orchestration-contract/roster";
import type { CaptureReceipt } from "./harness-capture";
import { isWireRecord } from "./security-audit-contract";
import {
  SECURITY_VERIFICATION_PROGRAM,
  SECURITY_VERIFIER_ROLE,
  type VerificationVerdict,
} from "./security-adjudication";

export const CAPTURE_ATTESTATION_KIND = "security-capture-attestation" as const;

/** One captured verifier attempt, as the capturing harness attests it. */
export type CaptureAttestation = Readonly<{
  schemaVersion: 1;
  kind: typeof CAPTURE_ATTESTATION_KIND;
  program: typeof SECURITY_VERIFICATION_PROGRAM;
  runId: string;
  /** The verification run directory, realpath-canonical. */
  runDirectory: string;
  requestId: string;
  slotId: string;
  attempt: 1 | 2;
  role: typeof SECURITY_VERIFIER_ROLE;
  harness: "claude" | "pi";
  /** The harness's own id for the spawn whose output was captured. */
  nativeId: string;
  /** SHA-256 of the exact captured transcript bytes. */
  digest: string;
  byteLength: number;
}>;

const KEYS: readonly string[] = [
  "schemaVersion", "kind", "program", "runId", "runDirectory", "requestId", "slotId",
  "attempt", "role", "harness", "nativeId", "digest", "byteLength",
];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const boundedText = (value: unknown, maximum = 4_096): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);

/** The store entry name of the attestation for one (run directory, request):
 *  a record stored under any other name is refused on read, so an entry cannot
 *  be renamed to stand in for another request's. */
export const captureAttestationEntryName = (runDirectory: string, requestId: string): string =>
  `${sha256Hex(JSON.stringify([runDirectory, requestId]))}.json`;

/** The exact bytes a stored attestation holds (key order fixed). */
export const renderCaptureAttestation = (attestation: CaptureAttestation): string =>
  `${JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, attestation[key as keyof CaptureAttestation]])))}\n`;

/** Parse one stored attestation: exact keys, every field well formed, the
 *  canonical rendering byte-identical to what was read, and the name the one
 *  its (run directory, request) derive. */
export function parseCaptureAttestation(name: string, text: string): DomainResult<CaptureAttestation, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure(`capture attestation ${name} is not JSON`);
  }
  if (!isWireRecord(raw) || Object.keys(raw).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(raw, key))) {
    return failure(`capture attestation ${name} must hold exactly ${KEYS.join(", ")}`);
  }
  if (raw.schemaVersion !== 1 || raw.kind !== CAPTURE_ATTESTATION_KIND || raw.program !== SECURITY_VERIFICATION_PROGRAM ||
      raw.role !== SECURITY_VERIFIER_ROLE || (raw.attempt !== 1 && raw.attempt !== 2) ||
      (raw.harness !== "claude" && raw.harness !== "pi")) {
    return failure(`capture attestation ${name} is not a schemaVersion 1 security-verification verifier attestation`);
  }
  if (!boundedText(raw.runId, 192) || !boundedText(raw.requestId, 512) || !boundedText(raw.slotId, 512) ||
      !boundedText(raw.nativeId, 1_024) || !boundedText(raw.runDirectory) || !raw.runDirectory.startsWith("/")) {
    return failure(`capture attestation ${name} names a malformed run, request, slot or native id`);
  }
  if (typeof raw.digest !== "string" || !SHA256_HEX.test(raw.digest) ||
      typeof raw.byteLength !== "number" || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0) {
    return failure(`capture attestation ${name} carries a malformed digest or length`);
  }
  const attestation: CaptureAttestation = {
    schemaVersion: 1, kind: CAPTURE_ATTESTATION_KIND, program: SECURITY_VERIFICATION_PROGRAM,
    runId: raw.runId, runDirectory: raw.runDirectory, requestId: raw.requestId, slotId: raw.slotId,
    attempt: raw.attempt, role: SECURITY_VERIFIER_ROLE, harness: raw.harness, nativeId: raw.nativeId,
    digest: raw.digest, byteLength: raw.byteLength,
  };
  if (renderCaptureAttestation(attestation) !== text) return failure(`capture attestation ${name} is not in canonical form`);
  if (captureAttestationEntryName(attestation.runDirectory, attestation.requestId) !== name) {
    return failure(`capture attestation ${name} does not match the run directory and request it names`);
  }
  return success(attestation);
}

/**
 * The attestation one native capture owes, or null when the request is not a
 * security verifier request (only those cast ballots). Every field is read
 * from the issued authority and the capture receipt `bindCapture` produced —
 * never from the captured payload.
 */
export function captureAttestationOf(
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  runDirectory: string,
): DomainResult<CaptureAttestation, string> | null {
  if (request.program !== SECURITY_VERIFICATION_PROGRAM) return null;
  if (request.role !== SECURITY_VERIFIER_ROLE) {
    return failure(`security-verification request ${request.requestId} is a ${request.role} request; only verifier captures are attested`);
  }
  if (receipt.requestId !== request.requestId || receipt.slotId !== request.slotId || receipt.attempt !== request.attempt) {
    return failure(`capture receipt ${receipt.requestId} does not answer request ${request.requestId}`);
  }
  const attestation: CaptureAttestation = {
    schemaVersion: 1, kind: CAPTURE_ATTESTATION_KIND, program: SECURITY_VERIFICATION_PROGRAM,
    runId: request.runId, runDirectory, requestId: request.requestId, slotId: request.slotId,
    attempt: request.attempt, role: SECURITY_VERIFIER_ROLE, harness: receipt.harness, nativeId: receipt.nativeId,
    digest: receipt.digest, byteLength: receipt.byteLength,
  };
  const name = captureAttestationEntryName(runDirectory, request.requestId);
  const parsed = parseCaptureAttestation(name, renderCaptureAttestation(attestation));
  return parsed.ok ? parsed : failure(`capture attestation for ${request.requestId} is malformed: ${parsed.error}`);
}

/** What the store holds for one request: its attestation, nothing, or a
 *  record it refused (the reason). */
export type AttestationLookup =
  | Readonly<{ kind: "attested"; attestation: CaptureAttestation }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * Whether every ballot is backed by the attestation of the request that cast
 * it: present, for the same run, request, slot, attempt and role, and with
 * the digest the ballot's binding carries. `lookup` answers per request id;
 * a missing attestation is "not natively captured", a malformed one refuses.
 */
export function ballotsAttested(
  ballots: readonly VerificationVerdict[],
  runDirectory: string,
  lookup: (requestId: string) => AttestationLookup,
): DomainResult<void, string> {
  for (const ballot of ballots) {
    const { binding } = ballot;
    const found = lookup(binding.requestId);
    if (found.kind === "absent") {
      return failure(`ballot on ${ballot.fingerprint} (request ${binding.requestId}) was not natively captured: no capture attestation`);
    }
    if (found.kind === "refused") return failure(`ballot on ${ballot.fingerprint}: ${found.reason}`);
    const { attestation } = found;
    const mismatch =
      attestation.runDirectory !== runDirectory ? "run directory"
        : attestation.runId !== binding.runId ? "run"
          : attestation.slotId !== binding.slotId ? "slot"
            : attestation.attempt !== binding.attempt ? "attempt"
              : attestation.role !== binding.role ? "role"
                : attestation.digest !== binding.captureDigest ? "capture digest"
                  : null;
    if (mismatch !== null) {
      return failure(`ballot on ${ballot.fingerprint} (request ${binding.requestId}) does not match its capture attestation (${mismatch})`);
    }
  }
  return success(undefined);
}
