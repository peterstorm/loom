/**
 * The capture attestation store (ADR-0067, amended): one immutable entry per
 * natively captured security verifier attempt, in the protected entry store
 * `PERSISTENT_SUBAGENT_STORES.captureAttestations` (under the protected
 * `subagentDir()`), written by the harness process that captured the
 * transcript and read by `verify --from` and by the audit's adjudication
 * before a ballot is counted.
 *
 * Protections, shared with the run registry through `protected-entry-store.ts`:
 * the directory lives inside `protectedDirs()`, so guard-state-file refuses
 * every helper and Bash write into it and the subagent write guard refuses a
 * subagent's; the SessionStart stale sweep never removes it (it is a
 * `PERSISTENT_SUBAGENT_STORES` member); the base is resolved once and every
 * component below it is held no-follow; an entry is published exclusively, so
 * a reader never sees a partial record and a record is never replaced. This
 * module owns only the attestation grammar (`core/capture-attestation`).
 *
 * Reading fails CLOSED: an entry that exists but is not a canonical
 * attestation bound to its own name is `refused`, never `absent`.
 */

import { realpathSync } from "node:fs";
import { PERSISTENT_SUBAGENT_STORES } from "../config";
import {
  captureAttestationEntryName,
  parseCaptureAttestation,
  renderCaptureAttestation,
  type AttestationLookup,
  type CaptureAttestation,
} from "../core/capture-attestation";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import {
  describeStoreError,
  publishEntryOnce,
  readEntryIfPresent,
  withExistingEntryStore,
  withWritableEntryStore,
} from "./protected-entry-store";

const STORE = PERSISTENT_SUBAGENT_STORES.captureAttestations;

/** The realpath of a run directory, the one spelling attestations carry. */
export function canonicalAttestedRunDirectory(runDirectory: string): DomainResult<string, string> {
  try {
    return success(realpathSync.native(runDirectory));
  } catch (error) {
    return failure(`cannot resolve verification run directory ${runDirectory}: ${describeStoreError(error)}`);
  }
}

/**
 * Record one capture. Idempotent: an entry already holding exactly these bytes
 * is success (a re-delivered stop of the same capture); an entry holding
 * anything else is a refusal — an attestation is never replaced.
 */
export function recordCaptureAttestation(attestation: CaptureAttestation): DomainResult<void, string> {
  const name = captureAttestationEntryName(attestation.runDirectory, attestation.requestId);
  const bytes = renderCaptureAttestation(attestation);
  try {
    const published = withWritableEntryStore(STORE, (store) => publishEntryOnce(store, name, bytes));
    return published.kind === "published" || published.text === bytes
      ? success(undefined)
      : failure(`request ${attestation.requestId} of ${attestation.runDirectory} already holds a different capture attestation`);
  } catch (error) {
    return failure(`cannot record the capture attestation of ${attestation.requestId} in ${STORE.dir()}: ${describeStoreError(error)}`);
  }
}

/**
 * The attestation lookup for one verification run directory (realpath). Each
 * question reads the ONE entry its (run directory, request) names — the cost
 * is the run's own requests, never every run ever attested, and an unrelated
 * damaged entry refuses nothing it does not name. Fail-closed: an unobservable
 * or unreadable store refuses; an absent store answers `absent`; an entry that
 * exists but is not a canonical attestation bound to its name refuses.
 */
export function captureAttestationLookup(runDirectory: string): (requestId: string) => AttestationLookup {
  return (requestId) => {
    const name = captureAttestationEntryName(runDirectory, requestId);
    let text: string | null;
    try {
      text = withExistingEntryStore(STORE, (store) => readEntryIfPresent(store, name), () => null);
    } catch (error) {
      return { kind: "refused", reason: `the capture attestation store cannot be read: ${describeStoreError(error)}` };
    }
    if (text === null) return { kind: "absent" };
    const parsed = parseCaptureAttestation(name, text);
    return parsed.ok ? { kind: "attested", attestation: parsed.value } : { kind: "refused", reason: parsed.error };
  };
}
