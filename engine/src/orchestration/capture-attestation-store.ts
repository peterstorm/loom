/**
 * The capture attestation store (ADR-0065, amended): one immutable entry per
 * natively captured security verifier attempt, under the protected
 * `subagentDir()` (`config.captureAttestationDir()`), written by the harness
 * process that captured the transcript and read by `verify --from` and by the
 * audit's adjudication before a ballot is counted.
 *
 * Protections, the same as the run registry's
 * (`security-audit-run-registry.ts`): the directory lives inside
 * `protectedDirs()`, so guard-state-file refuses every helper and Bash write
 * into it and the subagent write guard refuses a subagent's; the SessionStart
 * stale sweep never removes it (`PERSISTENT_SUBAGENT_DIR_ENTRIES`); the base is
 * resolved once and every component below it is held no-follow; an entry is
 * published exclusively (hard-link of a fully written prepared file), so a
 * reader never sees a partial record and a record is never replaced.
 *
 * Reading fails CLOSED: an entry that exists but is not a canonical
 * attestation bound to its own name is `refused`, never `absent`.
 */

import { realpathSync } from "node:fs";
import { captureAttestationDir, subagentDir, CAPTURE_ATTESTATION_ENTRY } from "../config";
import {
  captureAttestationEntryName,
  parseCaptureAttestation,
  renderCaptureAttestation,
  type AttestationLookup,
  type CaptureAttestation,
} from "../core/capture-attestation";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import { observePathPresence } from "../utils/path-presence";
import {
  closeAnchoredDirectory,
  ensureDirectoryNoFollow,
  ensureResolvedBaseDirectory,
  listDirectoryNamesNoFollow,
  openChildDirectoryNoFollow,
  openDirectoryNoFollow,
  publishDirectoryFileExclusiveNoFollow,
  readDirectoryFileNoFollow,
  resolveBaseDirectory,
} from "./no-follow-fs";

/** An attestation is one short record. */
const MAXIMUM_ENTRY_BYTES = 16 * 1024;
/** Past this many entries the read fails closed (refuses every lookup). */
const MAXIMUM_ENTRIES = 65_536;
/** What an interrupted exclusive publish leaves behind: never an entry. */
const CLAIM_LEFTOVER = /\.json\.claim-[A-Za-z0-9.-]+$/;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The realpath of a run directory, the one spelling attestations carry. */
export function canonicalAttestedRunDirectory(runDirectory: string): DomainResult<string, string> {
  try {
    return success(realpathSync.native(runDirectory));
  } catch (error) {
    return failure(`cannot resolve verification run directory ${runDirectory}: ${describe(error)}`);
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
    const base = ensureResolvedBaseDirectory(subagentDir());
    const storePath = `${base}/${CAPTURE_ATTESTATION_ENTRY}`;
    ensureDirectoryNoFollow(storePath);
    const store = openDirectoryNoFollow(storePath);
    try {
      try {
        publishDirectoryFileExclusiveNoFollow(store, name, bytes);
        return success(undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = readDirectoryFileNoFollow(store, name, MAXIMUM_ENTRY_BYTES).toString("utf-8");
      return existing === bytes
        ? success(undefined)
        : failure(`request ${attestation.requestId} of ${attestation.runDirectory} already holds a different capture attestation`);
    } finally {
      closeAnchoredDirectory(store);
    }
  } catch (error) {
    return failure(`cannot record the capture attestation of ${attestation.requestId} in ${captureAttestationDir()}: ${describe(error)}`);
  }
}

/**
 * The attestation lookup for one verification run directory (realpath).
 * Opening the store is fail-closed: an unobservable store refuses every
 * lookup; an absent one answers `absent` for every request.
 */
export function captureAttestationLookup(runDirectory: string): (requestId: string) => AttestationLookup {
  const refused = (reason: string) => (): AttestationLookup => ({ kind: "refused", reason });
  const presence = observePathPresence(subagentDir());
  if (presence.kind === "absent") return () => ({ kind: "absent" });
  if (presence.kind === "unknown") return refused(`the capture attestation store is unobservable: ${presence.cause}`);
  // Every entry is read once, eagerly: the lookup holds no descriptor past
  // this call, and a later question is answered from the same snapshot.
  const entries = new Map<string, string>();
  try {
    const parent = openDirectoryNoFollow(resolveBaseDirectory(subagentDir()));
    try {
      if (!listDirectoryNamesNoFollow(parent).includes(CAPTURE_ATTESTATION_ENTRY)) return () => ({ kind: "absent" });
      const store = openChildDirectoryNoFollow(parent, CAPTURE_ATTESTATION_ENTRY);
      try {
        for (const name of listDirectoryNamesNoFollow(store, MAXIMUM_ENTRIES)) {
          if (CLAIM_LEFTOVER.test(name)) continue;
          entries.set(name, readDirectoryFileNoFollow(store, name, MAXIMUM_ENTRY_BYTES).toString("utf-8"));
        }
      } finally {
        closeAnchoredDirectory(store);
      }
    } finally {
      closeAnchoredDirectory(parent);
    }
  } catch (error) {
    return refused(`the capture attestation store cannot be read: ${describe(error)}`);
  }
  return (requestId) => {
    const name = captureAttestationEntryName(runDirectory, requestId);
    const text = entries.get(name);
    if (text === undefined) return { kind: "absent" };
    const parsed = parseCaptureAttestation(name, text);
    return parsed.ok ? { kind: "attested", attestation: parsed.value } : { kind: "refused", reason: parsed.error };
  };
}
