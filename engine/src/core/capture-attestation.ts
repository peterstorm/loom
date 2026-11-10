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
import { SECURITY_VERIFICATION_PROGRAM } from "./orchestration-contract/programs";
import type { AgentRequestAuthority } from "./orchestration-contract/roster";
import type { CaptureReceipt } from "./harness-capture";
import { isWireRecord } from "./security-audit-contract";
import {
  SECURITY_VERIFIER_ROLE,
  type BallotBinding,
  type VerificationVerdict,
} from "./security-adjudication";

export const CAPTURE_ATTESTATION_KIND = "security-capture-attestation" as const;

declare const mintedAttestation: unique symbol;

/** An attestation's fields before the brand: what `mintCaptureAttestation` proves. */
type CaptureAttestationRecord = Readonly<{
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

/** One captured verifier attempt, as the capturing harness attests it.
 *  Branded: every value went through `mintCaptureAttestation` (directly, or via
 *  the store's parser and `captureAttestationOf`), so its ids, run directory,
 *  digest and length are inside their bounds wherever it is read or written. */
export type CaptureAttestation = CaptureAttestationRecord & Readonly<{ [mintedAttestation]: true }>;

/** What an attestation is minted from: the fields a harness supplies. The
 *  schema version, kind, program and role are fixed by the type, never input. */
export type CaptureAttestationFields = Readonly<{
  runId: unknown;
  runDirectory: unknown;
  requestId: unknown;
  slotId: unknown;
  attempt: unknown;
  harness: unknown;
  nativeId: unknown;
  digest: unknown;
  byteLength: unknown;
}>;

const KEYS = [
  "schemaVersion", "kind", "program", "runId", "runDirectory", "requestId", "slotId",
  "attempt", "role", "harness", "nativeId", "digest", "byteLength",
] as const satisfies readonly (keyof CaptureAttestationRecord)[];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const boundedText = (value: string, maximum = 4_096): boolean =>
  value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);

/** The bound on an attestation's identities: each id bounded visible text, the
 *  run directory absolute. */
const idsBounded = (ids: Pick<CaptureAttestationRecord, "runId" | "runDirectory" | "requestId" | "slotId" | "nativeId">): boolean =>
  boundedText(ids.runId, 192) && boundedText(ids.requestId, 512) && boundedText(ids.slotId, 512) &&
  boundedText(ids.nativeId, 1_024) && boundedText(ids.runDirectory) && ids.runDirectory.startsWith("/");

/** The bound on what was captured: a sha256 digest and a non-negative length. */
const measureBounded = (measure: Pick<CaptureAttestationRecord, "digest" | "byteLength">): boolean =>
  SHA256_HEX.test(measure.digest) && Number.isSafeInteger(measure.byteLength) && measure.byteLength >= 0;

/** The brand's one minting step. Only `mintCaptureAttestation` calls it, and
 *  only after every field passed its bound there: the proof is those checks,
 *  stated once, and this step only records it in the type. */
const asMinted = (record: CaptureAttestationRecord): CaptureAttestation => record as CaptureAttestation;

/** The store entry name of the attestation for one (run directory, request):
 *  a record stored under any other name is refused on read, so an entry cannot
 *  be renamed to stand in for another request's. */
export const captureAttestationEntryName = (runDirectory: string, requestId: string): string =>
  `${sha256Hex(JSON.stringify([runDirectory, requestId]))}.json`;

/** The exact bytes a stored attestation holds (key order fixed). */
export const renderCaptureAttestation = (attestation: CaptureAttestation): string =>
  `${JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, attestation[key]])))}\n`;

/**
 * The one constructor of a `CaptureAttestation`: every field is bounded HERE,
 * so the store's parser (a stored record) and `captureAttestationOf` (a fresh
 * capture) cannot disagree about what a well-formed attestation is. The
 * refusal is a predicate phrase; each caller names the record it refused.
 */
export function mintCaptureAttestation(fields: CaptureAttestationFields): DomainResult<CaptureAttestation, string> {
  const { runId, runDirectory, requestId, slotId, attempt, harness, nativeId, digest, byteLength } = fields;
  if ((attempt !== 1 && attempt !== 2) || (harness !== "claude" && harness !== "pi")) {
    return failure("is not a schemaVersion 1 security-verification verifier attestation");
  }
  if (typeof runId !== "string" || typeof requestId !== "string" || typeof slotId !== "string" ||
      typeof nativeId !== "string" || typeof runDirectory !== "string" ||
      !idsBounded({ runId, runDirectory, requestId, slotId, nativeId })) {
    return failure("names a malformed run, request, slot or native id");
  }
  if (typeof digest !== "string" || typeof byteLength !== "number" || !measureBounded({ digest, byteLength })) {
    return failure("carries a malformed digest or length");
  }
  return success(asMinted({
    schemaVersion: 1, kind: CAPTURE_ATTESTATION_KIND, program: SECURITY_VERIFICATION_PROGRAM,
    runId, runDirectory, requestId, slotId, attempt, role: SECURITY_VERIFIER_ROLE, harness, nativeId, digest, byteLength,
  }));
}

/** Parse one stored attestation: exact keys, the fixed schema version, kind,
 *  program and role, every field minted, the canonical rendering
 *  byte-identical to what was read, and the name the one its (run directory,
 *  request) derive. */
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
      raw.role !== SECURITY_VERIFIER_ROLE) {
    return failure(`capture attestation ${name} is not a schemaVersion 1 security-verification verifier attestation`);
  }
  const attestation = mintCaptureAttestation({
    runId: raw.runId, runDirectory: raw.runDirectory, requestId: raw.requestId, slotId: raw.slotId,
    attempt: raw.attempt, harness: raw.harness, nativeId: raw.nativeId, digest: raw.digest, byteLength: raw.byteLength,
  });
  if (!attestation.ok) return failure(`capture attestation ${name} ${attestation.error}`);
  if (renderCaptureAttestation(attestation.value) !== text) return failure(`capture attestation ${name} is not in canonical form`);
  if (captureAttestationEntryName(attestation.value.runDirectory, attestation.value.requestId) !== name) {
    return failure(`capture attestation ${name} does not match the run directory and request it names`);
  }
  return attestation;
}

/**
 * The attestation one native capture owes, or null when the request is not a
 * security verifier request (only those cast ballots). Every field is read
 * from the issued authority and the capture receipt `bindCapture` produced —
 * never from the captured payload — and goes through the same constructor the
 * store's parser uses, so a harness-supplied native id or length outside its
 * bounds is refused here rather than written and then refused on read.
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
  const attestation = mintCaptureAttestation({
    runId: request.runId, runDirectory, requestId: request.requestId, slotId: request.slotId,
    attempt: request.attempt, harness: receipt.harness, nativeId: receipt.nativeId,
    digest: receipt.digest, byteLength: receipt.byteLength,
  });
  return attestation.ok
    ? attestation
    : failure(`capture attestation for ${request.requestId} is malformed: it ${attestation.error}`);
}

/** What the store holds for one request: its attestation, nothing, or a
 *  record it refused (the reason). */
export type AttestationLookup =
  | Readonly<{ kind: "attested"; attestation: CaptureAttestation }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** The first field an attestation and the ballot it is meant to back disagree
 *  on, in a fixed order, or null when they agree on all of them. The request id
 *  and program are compared too: the decision does not rely on `lookup`
 *  answering only with the entry its name binds (the store enforces that, but
 *  this pure check holds against any lookup). */
function attestationMismatch(
  attestation: CaptureAttestation,
  binding: BallotBinding,
  runDirectory: string,
): string | null {
  const comparisons: readonly (readonly [string, boolean])[] = [
    ["run directory", attestation.runDirectory !== runDirectory],
    ["program", attestation.program !== binding.program],
    ["run", attestation.runId !== binding.runId],
    ["request", attestation.requestId !== binding.requestId],
    ["slot", attestation.slotId !== binding.slotId],
    ["attempt", attestation.attempt !== binding.attempt],
    ["role", attestation.role !== binding.role],
    ["capture digest", attestation.digest !== binding.captureDigest],
  ];
  return comparisons.find(([, differs]) => differs)?.[0] ?? null;
}

/**
 * Whether every ballot is backed by the attestation of the request that cast
 * it: present, for the same program, run, request, slot, attempt and role,
 * and with the digest the ballot's binding carries. `lookup` answers per
 * request id; a missing attestation is "not natively captured", a malformed
 * one refuses.
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
    const mismatch = attestationMismatch(found.attestation, binding, runDirectory);
    if (mismatch !== null) {
      return failure(`ballot on ${ballot.fingerprint} (request ${binding.requestId}) does not match its capture attestation (${mismatch})`);
    }
  }
  return success(undefined);
}
