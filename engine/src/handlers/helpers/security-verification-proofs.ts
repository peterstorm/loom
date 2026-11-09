/**
 * The shell half of "a ballot is authoritative only while its run proves it"
 * (ADR-0065, amended). The audit CLI (`verify --from`, `findings`, `publish`,
 * `status`) reads verification runs through this one module:
 *
 *  - `openVerificationRun` places a run under the audit's own
 *    `verification-runs/` and reads its registration;
 *  - `verificationRunAttestations` reads the capture attestations of a run;
 *  - `proveCachedBallots` re-proves every run `verdicts.json` caches ballots
 *    from — registration, evidence replay (identity-bound: later waves may
 *    move the ledger), and attestations — and lets the pure core
 *    (`admitCachedBallots`) decide what adjudication may count;
 *  - `observeVerificationGenerations` reports what each existing run of the
 *    runs root is, so `planVerificationStart` can name the next generation
 *    when the current one is blocked or unimportable.
 *
 * Every I/O step fails closed into data: an unreadable run is `unprovable` or
 * `dead`, never trusted.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { failure, success, type DomainResult } from "../../core/orchestration-contract/identity";
import { ballotsAttested, type AttestationLookup } from "../../core/capture-attestation";
import {
  admitCachedBallots,
  parseVerificationResult,
  type SecurityVerificationResult,
  type CachedBallotAdmission,
  type GenerationState,
  type RegisteredSecurityVerificationProgram,
  type VerificationRunProof,
} from "../../core/security-verification";
import type { VerificationVerdict } from "../../core/security-adjudication";
import { canonicalAttestedRunDirectory, captureAttestationLookup } from "../../orchestration/capture-attestation-store";
import { openRegisteredRunDirectory, parseRunDirectoryReference, type RunDirHandle } from "../../orchestration/run-directory-handle";
import { closeAnchoredDirectory, listDirectoryNamesNoFollow, openDirectoryNoFollow, readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { parseRegisteredFacadeProgram, replayVerificationOutcome, replayVerificationResult } from "./programs";
import { verificationRunsRoot, type AuditSnapshot } from "./security-audit-run";

/** The file a finished verification run publishes. */
const VERIFICATION_RESULT_FILE = "result.json";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type OpenedVerificationRun = Readonly<{
  handle: RunDirHandle;
  registration: RegisteredSecurityVerificationProgram;
}>;

/** A run under THIS audit's `verification-runs/`, registered as a
 *  security-verification program. */
export function openVerificationRun(locator: string, from: string): DomainResult<OpenedVerificationRun, string> {
  const reference = parseRunDirectoryReference(verificationRunsRoot(locator), from);
  if (!reference.ok) return failure(`--from must name a run under ${verificationRunsRoot(locator)}: ${reference.error.message}`);
  const opened = openRegisteredRunDirectory(reference.value.runsRoot, reference.value.runDirectory);
  if (!opened.ok) return failure(`cannot open verification run ${reference.value.runDirectory}: ${opened.error.message}`);
  const stored = opened.value.readProgramRegistration();
  if (!stored.ok) return failure(stored.error.message);
  const program = parseRegisteredFacadeProgram(stored.value);
  if (program.kind !== "registered" || program.program.kind !== "security-verification") {
    return failure(`${reference.value.runDirectory} is not a registered security-verification run`);
  }
  return success({ handle: opened.value, registration: program.program });
}

export type RunAttestations = Readonly<{ runDirectory: string; lookup: (requestId: string) => AttestationLookup }>;

/** The capture attestations of one run, keyed the way the capturing harness
 *  recorded them (by the run directory's realpath). */
export function verificationRunAttestations(handle: RunDirHandle): DomainResult<RunAttestations, string> {
  const directory = canonicalAttestedRunDirectory(handle.runDirectory);
  return directory.ok ? success({ runDirectory: directory.value, lookup: captureAttestationLookup(directory.value) }) : directory;
}

/** Whether every ballot of a replayed result is attested by its capture. */
export function requireAttestedBallots(handle: RunDirHandle, ballots: readonly VerificationVerdict[]): DomainResult<void, string> {
  const attestations = verificationRunAttestations(handle);
  if (!attestations.ok) return attestations;
  return ballotsAttested(ballots, attestations.value.runDirectory, attestations.value.lookup);
}

/** Re-prove one run a cached ballot names. */
async function proveRun(locator: string, runId: string): Promise<VerificationRunProof> {
  const opened = openVerificationRun(locator, runId);
  if (!opened.ok) return { kind: "unprovable", reason: opened.error };
  const replayed = await replayVerificationOutcome(opened.value.handle, opened.value.registration, "issued");
  if (!replayed.ok) return { kind: "unprovable", reason: `its evidence cannot be replayed: ${replayed.message}` };
  if (replayed.value.kind !== "complete") return { kind: "unprovable", reason: `it is not complete (${replayed.value.kind}: ${replayed.value.message})` };
  const attestations = verificationRunAttestations(opened.value.handle);
  if (!attestations.ok) return { kind: "unprovable", reason: attestations.error };
  return {
    kind: "proven",
    registration: opened.value.registration,
    replayed: replayed.value.result,
    runDirectory: attestations.value.runDirectory,
    attestations: attestations.value.lookup,
  };
}

/**
 * `verdicts.json` is a cache: before adjudication counts a ballot, every run
 * it names is re-proven. The pure core decides; this reads.
 */
export async function proveCachedBallots(snapshot: AuditSnapshot): Promise<CachedBallotAdmission> {
  const runIds = [...new Set(snapshot.verdicts.map((ballot) => ballot.binding.runId))];
  const proofs = new Map<string, VerificationRunProof>();
  for (const runId of runIds) proofs.set(runId, await proveRun(snapshot.reference.locator, runId));
  return admitCachedBallots({ audit: snapshot.reference, verdicts: snapshot.verdicts, proofs });
}

/** What one existing run directory is, as a generation of its claim set. */
async function generationState(locator: string, run: string): Promise<GenerationState> {
  const opened = openVerificationRun(locator, run);
  if (!opened.ok) return "dead";
  const replayed = await replayVerificationOutcome(opened.value.handle, opened.value.registration);
  if (!replayed.ok) return "dead";
  if (replayed.value.kind === "in-flight") return "live";
  if (replayed.value.kind === "blocked") return "dead";
  return requireAttestedBallots(opened.value.handle, replayed.value.result.ballots).ok ? "live" : "dead";
}

/**
 * The state of every run directory under the audit's `verification-runs/`
 * that `planVerificationStart` may name; a name absent from the map is
 * absent from disk. An unreadable runs root fails closed: every name it
 * could hold is reported unknown by the caller's refusal.
 */
export async function observeVerificationGenerations(locator: string): Promise<DomainResult<ReadonlyMap<string, GenerationState>, string>> {
  const root = verificationRunsRoot(locator);
  if (!existsSync(root)) return success(new Map());
  let names: readonly string[];
  try {
    const anchored = openDirectoryNoFollow(root);
    try {
      names = listDirectoryNamesNoFollow(anchored, 4_096);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  } catch (error) {
    return failure(`cannot list ${root}: ${describe(error)}`);
  }
  const states = new Map<string, GenerationState>();
  for (const name of names.filter((entry) => entry.startsWith("run.verify-"))) {
    states.set(name, await generationState(locator, name));
  }
  return success(states);
}

/** A verification run under this audit: its handle, registration, and the
 *  exact `result.json` bytes it published, parsed. */
export type VerificationSource = OpenedVerificationRun & Readonly<{ bytes: Buffer; result: SecurityVerificationResult }>;

export function readVerificationSource(locator: string, from: string): DomainResult<VerificationSource, string> {
  const opened = openVerificationRun(locator, from);
  if (!opened.ok) return opened;
  const { handle } = opened.value;
  let bytes: Buffer;
  try {
    bytes = readRunBytesNoFollow(join(handle.runDirectory, VERIFICATION_RESULT_FILE));
  } catch (error) {
    return failure(`verification run ${handle.runId} has published no result.json (${describe(error)}); resume it until it is done`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return failure(`result.json is not valid JSON: ${describe(error)}`);
  }
  const result = parseVerificationResult(raw);
  return result.ok ? success({ ...opened.value, bytes, result: result.value }) : failure(`result.json is malformed — ${result.error}`);
}

/**
 * The proof an import needs beyond the pure import rule: `result.json` is
 * byte-identical to the result the run's captured evidence replays (a result
 * edited after publication is refused), and every ballot it holds is backed
 * by its capturing harness's attestation (a transcript written into the run by
 * anything else is refused as not natively captured). Shared by `verify
 * --from` and the Pi parent's import gate, so the two cannot disagree.
 */
export async function proveVerificationSource(source: VerificationSource): Promise<DomainResult<void, string>> {
  const runId = source.registration.runId;
  const replayed = await replayVerificationResult(source.handle, source.registration);
  if (!replayed.ok) return failure(`verification run ${runId} cannot be replayed: ${replayed.message}`);
  if (!source.bytes.equals(Buffer.from(replayed.value, "utf8"))) {
    return failure(`verification run ${runId}: result.json does not match the result its captured evidence replays — it was altered after publication`);
  }
  return requireAttestedBallots(source.handle, source.result.ballots);
}
