/**
 * The Acceptance Freeze: stamping what an accepted gate observed, the shell's
 * observations of the frozen paths, and drift between them.
 */

import { canonicalStructuralEquals, type ArtifactDigest, type DomainResult, type NonEmpty } from "../orchestration-contract";
import { err, freeze, nonEmpty, ok } from "./kernel";
import type { AcceptanceContract, AcceptanceFreeze, FrozenPathDigest } from "./model";
import { frozenPaths } from "./tasks";
import { observedRoster, recordsRoster, type AcceptanceExpectation, type AcceptanceReportFacts } from "./gate";

/**
 * Stamp what an ACCEPTED gate observed: the contract Wave freezes its bytes
 * and red roster; the first gate after a Contract Revision re-records the
 * roster green. Re-stamping an identical freeze is a no-op; a different one
 * is refused — only a Contract Revision changes a frozen contract.
 */
export function stampAcceptanceFreezes(
  contracts: readonly AcceptanceContract[],
  expectation: AcceptanceExpectation,
  facts: readonly AcceptanceReportFacts[],
  observations: FrozenPathObservations,
): DomainResult<readonly AcceptanceContract[], string> {
  const errors: string[] = [];
  const stamped = contracts.map((contract): AcceptanceContract => {
    const expected = expectation.contracts.find(({ contract: id }) => id === contract.id);
    if (expected === undefined || !recordsRoster(expected)) return contract;
    const observed = facts.flatMap((fact) => fact.kind === "projected" ? fact.testcases : []);
    const roster = nonEmpty(observedRoster(expected, observed));
    if (roster === null) {
      errors.push(`${contract.id}: no anchored acceptance testcase was observed to freeze`);
      return contract;
    }
    if (expected.phase === "green") {
      return contract.freeze.state === "revised"
        ? freeze({ ...contract, freeze: freeze({ state: "frozen", wave: expectation.wave, paths: contract.freeze.paths, roster }) })
        : contract;
    }
    const paths = frozenPathDigests(contract, observations);
    if (!paths.ok) {
      errors.push(`${contract.id}: frozen paths could not be read to stamp the freeze: ${renderFrozenPathProblems(paths.error)}`);
      return contract;
    }
    const next: AcceptanceFreeze = freeze({ state: "frozen", wave: expectation.wave, paths: paths.value, roster });
    if (contract.freeze.state === "awaiting-red") return freeze({ ...contract, freeze: next });
    if (canonicalStructuralEquals(contract.freeze, next)) return contract;
    errors.push(`${contract.id} is already frozen with different bytes or roster; only a Contract Revision changes a frozen contract`);
    return contract;
  });
  return errors.length > 0 ? err(errors.join("; ")) : ok(Object.freeze(stamped));
}

/** What the shell saw at one frozen path: its digest, or why it could not be
 *  read without following a link. */
export type FrozenPathObservation =
  | Readonly<{ kind: "digest"; sha256: ArtifactDigest }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** The shell's observations, by frozen path. A path with no entry was never
 *  observed — the contracts changed after the shell chose what to read. */
export type FrozenPathObservations = ReadonlyMap<string, FrozenPathObservation>;

/** A frozen path the core could not digest. */
export type FrozenPathProblem =
  | Readonly<{ kind: "unreadable"; path: string; reason: string }>
  | Readonly<{ kind: "not-observed"; path: string }>;

export function renderFrozenPathProblems(problems: readonly FrozenPathProblem[]): string {
  return problems.map((problem) => problem.kind === "unreadable"
    ? `'${problem.path}' (${problem.reason})`
    : `'${problem.path}' (not observed)`).join(", ");
}

/** Each frozen path with its observed digest, in freeze order, or every path
 *  that could not be digested and why. */
export function frozenPathDigests(
  contract: Pick<AcceptanceContract, "types" | "acceptance">,
  observations: FrozenPathObservations,
): DomainResult<NonEmpty<FrozenPathDigest>, NonEmpty<FrozenPathProblem>> {
  const paths = frozenPaths(contract);
  const digests: FrozenPathDigest[] = [];
  const problems: FrozenPathProblem[] = [];
  for (const path of paths) {
    const observation = observations.get(path);
    if (observation === undefined) problems.push(freeze({ kind: "not-observed", path }));
    else if (observation.kind === "unreadable") problems.push(freeze({ kind: "unreadable", path, reason: observation.reason }));
    else digests.push(freeze({ path, sha256: observation.sha256 }));
  }
  const failed = nonEmpty(problems);
  return failed === null ? ok(nonEmpty(digests)!) : err(failed);
}

/** One operator message naming every drifted frozen path. */
export function renderFrozenPathDrift(drift: readonly FrozenPathDrift[]): string {
  const what = ({ actual }: FrozenPathDrift): string => actual === null
    ? "was not observed"
    : actual.kind === "unreadable" ? `is missing or unreadable (${actual.reason})` : "changed";
  return "frozen acceptance drifted: " + drift.map((entry) => `${entry.contract} '${entry.path}' ${what(entry)}`).join("; ") +
    " — restore the frozen bytes, or record an operator Contract Revision (helper revise-contract)";
}

export type FrozenPathDrift = Readonly<{
  contract: string;
  path: string;
  expected: ArtifactDigest;
  /** What the shell saw instead; null when it never observed the path. */
  actual: FrozenPathObservation | null;
}>;

/** Every frozen path whose current bytes differ from the freeze, or could not be read. */
export function frozenPathDrift(
  contracts: readonly AcceptanceContract[],
  observations: FrozenPathObservations,
): readonly FrozenPathDrift[] {
  return Object.freeze(contracts.flatMap((contract) => {
    if (contract.freeze.state === "awaiting-red") return [];
    return contract.freeze.paths.flatMap(({ path, sha256 }) => {
      const actual = observations.get(path) ?? null;
      return actual?.kind === "digest" && actual.sha256 === sha256
        ? []
        : [freeze({ contract: contract.id, path, expected: sha256, actual })];
    });
  }));
}

/** Every frozen path of every contract, for the shell to digest: the gate
 *  stamps an awaiting-red contract's bytes and drift-checks the rest. */
export function frozenPathsToObserve(contracts: readonly AcceptanceContract[]): readonly string[] {
  return Object.freeze([...new Set(contracts.flatMap((contract) => frozenPaths(contract)))]);
}
