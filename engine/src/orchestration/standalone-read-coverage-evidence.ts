/**
 * The Run Directory half of standalone read coverage (ADR-0022).
 *
 * `core/standalone-read-coverage` owns the rules: what the obligation is,
 * which tool output proves a page was delivered, and when coverage is
 * complete. This module owns the evidence those rules read and write: the
 * registered policy, the frozen diff inside a request's Context Packet, and
 * the one write-ahead observation per attempt at
 * `artifacts/read-coverage/<requestId>.json`.
 *
 * The observation is recorded by whatever delivered the attempt — native
 * capture (both harnesses) or an explicit `submit --tool-outputs` — BEFORE the
 * transcript is written, so a captured transcript of a read-coverage run
 * always has its observation beside it. Artifact publication is immutable:
 * the first observation of an attempt is kept, and a later delivery of the
 * same attempt never rewrites it.
 */
import { boundedThrownCause, type AgentRequestAuthority, type DomainResult } from "../core/orchestration-contract";
import { isRecord } from "../core/plain-record";
import {
  STANDALONE_FROZEN_DIFF_SECTION,
  admitReadCoverage,
  observeReadCoverage,
  parseFrozenDiff,
  parseReadCoverageObservation,
  parseStandaloneReadCoverage,
  type FrozenDiff,
  type ReadCoverageObservation,
  type StandaloneReadCoveragePolicy,
} from "../core/standalone-read-coverage";
import type { RunDirHandle } from "./run-directory-handle";

const OBSERVATION_MAX_BYTES = 1_048_576;

export const readCoverageObservationPath = (requestId: string): string => `read-coverage/${requestId}.json`;

/**
 * The read-coverage policy a stored registration carries, or null when it
 * carries none. Only a schema-2 standalone-review registration can carry one;
 * its value must be the exact supported policy, so a malformed policy refuses
 * instead of silently disabling coverage.
 */
export function registeredReadCoverage(raw: unknown): DomainResult<StandaloneReadCoveragePolicy | null, string> {
  if (!isRecord(raw) || raw["kind"] !== "standalone-review" || !Object.hasOwn(raw, "readCoverage")) return { ok: true, value: null };
  if (raw["schemaVersion"] !== 2) return { ok: false, error: "only a schema-2 standalone-review registration may carry read coverage" };
  return parseStandaloneReadCoverage(raw["readCoverage"]);
}

/** The read-coverage policy of this Run's own registration. */
export function runReadCoverage(handle: RunDirHandle): DomainResult<StandaloneReadCoveragePolicy | null, string> {
  const stored = handle.readProgramRegistration(16_777_216);
  return stored.ok ? registeredReadCoverage(stored.value) : { ok: false, error: stored.error.message };
}

/** The frozen diff inside the request's own Context Packet. */
export function requestFrozenDiff(handle: RunDirHandle, request: AgentRequestAuthority): DomainResult<FrozenDiff, string> {
  const packet = handle.readContext(request.contextDigest);
  if (!packet.ok) return { ok: false, error: packet.error.message };
  const sections = packet.value.fixedContext.filter(({ label }) => label === STANDALONE_FROZEN_DIFF_SECTION);
  if (sections.length !== 1) return { ok: false, error: `context ${request.contextDigest} has no single ${STANDALONE_FROZEN_DIFF_SECTION} section` };
  try {
    return parseFrozenDiff(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(sections[0]!.bytes))));
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "frozen diff section");
    return { ok: false, error: `frozen diff section is unreadable (${cause.name}: ${cause.message})` };
  }
}

/** The recorded observation of one attempt, or null when none was recorded. */
export function readRecordedObservation(handle: RunDirHandle, request: AgentRequestAuthority): DomainResult<ReadCoverageObservation | null, string> {
  const bytes = handle.readArtifactBytes(readCoverageObservationPath(request.requestId), OBSERVATION_MAX_BYTES);
  if (!bytes.ok) return { ok: false, error: bytes.error.message };
  if (bytes.value === null) return { ok: true, value: null };
  try {
    return parseReadCoverageObservation(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value)));
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "read coverage observation");
    return { ok: false, error: `read coverage observation is unreadable (${cause.name}: ${cause.message})` };
  }
}

/**
 * Record what the delivered tool outputs prove was read, unless this attempt
 * already has an observation (the first one is kept). `null` outputs record
 * an explicitly unobservable attempt rather than nothing, so admission names
 * the real cause.
 */
export async function recordReadCoverageObservation(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  toolOutputs: readonly string[] | null,
): Promise<DomainResult<ReadCoverageObservation, string>> {
  const existing = readRecordedObservation(handle, request);
  if (!existing.ok) return existing;
  if (existing.value !== null) return { ok: true, value: existing.value };
  const diff = requestFrozenDiff(handle, request);
  if (!diff.ok) return diff;
  const observation = observeReadCoverage(diff.value, request, toolOutputs);
  const bytes = Buffer.from(`${JSON.stringify(observation)}\n`, "utf-8");
  if (bytes.length > OBSERVATION_MAX_BYTES) return { ok: false, error: "read coverage observation exceeds its byte bound" };
  const published = await handle.publishArtifactSet([{ relativePath: readCoverageObservationPath(request.requestId), bytes: [...bytes] }]);
  return published.ok ? { ok: true, value: observation } : { ok: false, error: published.error.message };
}

export type ReadCoverageAdmission =
  | Readonly<{ kind: "not-required" }>
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "refused"; problem: string }>;

/**
 * Admission of one captured attempt against its Run's read obligation.
 * Unreadable evidence throws (infrastructure, never a consumed attempt);
 * a missing or incomplete observation is a refusal the bounded retry carries.
 */
export function admitRecordedReadCoverage(handle: RunDirHandle, request: AgentRequestAuthority): ReadCoverageAdmission {
  if (request.program !== "standalone-review") return { kind: "not-required" };
  const policy = runReadCoverage(handle);
  if (!policy.ok) throw new Error(policy.error);
  if (policy.value === null) return { kind: "not-required" };
  const diff = requestFrozenDiff(handle, request);
  if (!diff.ok) throw new Error(diff.error);
  const observation = readRecordedObservation(handle, request);
  if (!observation.ok) throw new Error(observation.error);
  const admitted = admitReadCoverage(diff.value, request, observation.value);
  return admitted.ok ? { kind: "admitted" } : { kind: "refused", problem: admitted.error };
}
