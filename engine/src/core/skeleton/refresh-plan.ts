/**
 * The one plan of what the engine writes over a contract's existing skeletons
 * (AD-9, AD-10; an INV-4 sibling): which canonical skeleton is created,
 * adopted as it is, or refreshed from the engine bytes it replaces, and which
 * recorded skeleton was modified and is left stale. Every judgment of a
 * present file is `presentSkeletonOf`'s (INV-4 owner); this module only maps
 * it to an action. Pure.
 *
 * Two callers iterate differently over the same decision:
 * - `candidate-driven` (the contract Task's stop): one action per canonical
 *   skeleton, in candidate order. A missing file is created; a file anyone
 *   else wrote is left alone, unrecorded.
 * - `record-driven` (the Contract Revision): one action per skeleton record,
 *   in record order. A deleted file needs nothing (the next registration
 *   regenerates it); a modified one is flagged stale; an untouched one whose
 *   binding no longer resolves has no canonical bytes and is left as it is.
 *
 * Paths are matched by `samePlanPath` everywhere, the observations included:
 * an observation keyed `./src/a.ts` is the observation of `src/a.ts`.
 */

import { normalizePlanPath, samePlanPath } from "../plan-path-match";
import { presentSkeletonOf } from "./outcomes";
import type { SkeletonCandidate } from "./records";
import type { PathObservation, SkeletonRecord } from "./types";

/** Write `candidate`'s bytes where nothing is. */
export type CreateAction = Readonly<{ kind: "create"; candidate: SkeletonCandidate }>;
/** The file already holds `candidate`'s canonical bytes: record it, write nothing. */
export type AdoptAction = Readonly<{ kind: "adopt"; candidate: SkeletonCandidate }>;
/** Replace the engine bytes digesting to `expectedSha256` with `candidate`'s. */
export type RefreshAction = Readonly<{ kind: "refresh"; candidate: SkeletonCandidate; expectedSha256: string }>;
/** The recorded skeleton was modified: keep its bytes, flag its record stale. */
export type StaleAction = Readonly<{ kind: "stale"; record: SkeletonRecord }>;

/** What the contract stop does at one canonical skeleton. */
export type CandidateRefreshAction = CreateAction | AdoptAction | RefreshAction;
/** What a Contract Revision does to one recorded skeleton. */
export type RecordRefreshAction = AdoptAction | RefreshAction | StaleAction;

type SkeletonRefreshIteration = "candidate-driven" | "record-driven";

const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/** What was observed at a path, looked up by normalized path; absent when nothing was. */
type ObservationAt = (path: string) => PathObservation;

/** The lookup over `observations` that agrees with `samePlanPath`. */
function observationAt(observations: ReadonlyMap<string, PathObservation>): ObservationAt {
  const byPath = new Map([...observations].map(([path, observation]) => [normalizePlanPath(path), observation] as const));
  return (path) => byPath.get(normalizePlanPath(path)) ?? ABSENT;
}

/** The write an untouched present file needs, or `null` for one anyone else wrote. */
function untouchedAction(
  record: SkeletonRecord | undefined,
  sha256: string,
  candidate: SkeletonCandidate,
): AdoptAction | RefreshAction | null {
  const present = presentSkeletonOf(record, sha256, candidate.skeleton.sha256);
  if (present === "touched") return null;
  return present === "canonical" ? { kind: "adopt", candidate } : { kind: "refresh", candidate, expectedSha256: sha256 };
}

function candidateDriven(
  records: readonly SkeletonRecord[],
  observed: ObservationAt,
  candidates: readonly SkeletonCandidate[],
): readonly CandidateRefreshAction[] {
  return candidates.flatMap((candidate): readonly CandidateRefreshAction[] => {
    const observation = observed(candidate.skeleton.path);
    if (observation.kind === "absent") return [{ kind: "create", candidate }];
    const record = records.find((recorded) => samePlanPath(recorded.path, candidate.skeleton.path));
    const action = untouchedAction(record, observation.sha256, candidate);
    return action === null ? [] : [action];
  });
}

function recordDriven(
  records: readonly SkeletonRecord[],
  observed: ObservationAt,
  candidates: readonly SkeletonCandidate[],
): readonly RecordRefreshAction[] {
  return records.flatMap((record): readonly RecordRefreshAction[] => {
    const observation = observed(record.path);
    if (observation.kind === "absent") return [];
    const candidate = candidates.find(({ skeleton }) => samePlanPath(skeleton.path, record.path));
    if (candidate === undefined) {
      return presentSkeletonOf(record, observation.sha256, null) === "touched" ? [{ kind: "stale", record }] : [];
    }
    const action = untouchedAction(record, observation.sha256, candidate);
    return [action ?? { kind: "stale", record }];
  });
}

/**
 * The action each canonical skeleton (`candidate-driven`) or each record
 * (`record-driven`) needs, given what is on disk and the canonical skeletons
 * of the contract's current types.
 */
export function planSkeletonRefresh(
  iteration: "candidate-driven",
  records: readonly SkeletonRecord[],
  observations: ReadonlyMap<string, PathObservation>,
  candidates: readonly SkeletonCandidate[],
): readonly CandidateRefreshAction[];
export function planSkeletonRefresh(
  iteration: "record-driven",
  records: readonly SkeletonRecord[],
  observations: ReadonlyMap<string, PathObservation>,
  candidates: readonly SkeletonCandidate[],
): readonly RecordRefreshAction[];
export function planSkeletonRefresh(
  iteration: SkeletonRefreshIteration,
  records: readonly SkeletonRecord[],
  observations: ReadonlyMap<string, PathObservation>,
  candidates: readonly SkeletonCandidate[],
): readonly (CandidateRefreshAction | RecordRefreshAction)[] {
  const observed = observationAt(observations);
  return Object.freeze(iteration === "candidate-driven"
    ? candidateDriven(records, observed, candidates)
    : recordDriven(records, observed, candidates));
}
