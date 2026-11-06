/**
 * Record an operator Contract Revision: observe the edited frozen bytes of one
 * Acceptance Contract, then re-stamp them and return the current Wave's
 * implemented claimants to revalidation, atomically through StateManager.
 *
 * A revision also settles the contract's engine-written skeletons (AD-10,
 * FR-033). Once the revision is known to be admissible, every binding of the
 * contract is re-resolved against the revised types file, and each skeleton
 * record of the contract is planned by `planSkeletonRevision`:
 * - untouched (`isUntouchedSkeleton`, INV-4) → regenerated from the revised
 *   types through the writer's guarded refresh (INV-3), its record replaced
 *   with origin `revision` and the new digests;
 * - modified → left on disk exactly as the implementer wrote it, its record
 *   flagged `stale: { revision }`, shown in status as
 *   `stale against revised contract`;
 * - deleted → nothing (the next registration regenerates it).
 * Every binding problem the revised types raise (a vanished or retyped alias)
 * is named in the outcome; the next spawn's stage two re-resolves the stamped
 * types and blocks on it (AS-051). Writes precede the locked update: a refused
 * update leaves refreshed bytes that content-addressed recognition adopts.
 */

import { dirname, resolve } from "node:path";
import type { HookHandler, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import { frozenPathsToObserve } from "../../core/acceptance-contract";
import {
  NO_SKELETON_REVISION,
  parseContractRevisionArgs,
  reviseAcceptanceContract,
  type RevisedContract,
  type SkeletonProblem,
  type SkeletonRevision,
} from "../../core/contract-revision";
import type { DomainResult } from "../../core/orchestration-contract";
import { samePlanPath } from "../../core/plan-path-match";
import { isUntouchedSkeleton } from "../../core/skeleton/outcomes";
import type { SkeletonGraph } from "../../core/skeleton/scope";
import type { GeneratedSkeleton, PathObservation, SkeletonRecord } from "../../core/skeleton/types";
import {
  canonicalContractSkeletons,
  frozenSkeletonPaths,
  observeSkeletonPaths,
  renderSkeletonProblem,
  skeletonRecordOf,
  writeFailure,
} from "../../orchestration/contract-stub-materialization";
import { observeFrozenDigests } from "../../orchestration/frozen-path-observation";
import { typedContract } from "../../orchestration/frozen-surface-observation";
import type { SkeletonCandidate } from "../../orchestration/skeleton-materialization";
import { refreshSkeleton } from "../../orchestration/skeleton-writer";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";
import { resolveCanonicalGitRepositoryRoot } from "../../utils/workspace-digest";

// ---------------------------------------------------------------------------
// Pure: what the revision does to each skeleton record
// ---------------------------------------------------------------------------

/** What a revision does to one recorded skeleton of the revised contract. */
export type SkeletonRevisionAction =
  | Readonly<{ kind: "refresh"; record: SkeletonRecord; skeleton: GeneratedSkeleton; expectedSha256: string }>
  | Readonly<{ kind: "re-record"; record: SkeletonRecord; skeleton: GeneratedSkeleton }>
  | Readonly<{ kind: "stale"; record: SkeletonRecord }>;

const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/**
 * The action each record needs, in record order, given what is on disk and
 * the canonical skeletons of the revised types. A deleted file needs nothing.
 * A file `isUntouchedSkeleton` judges modified is stale. An untouched one is
 * re-recorded when its bytes already are the revised canonical bytes, else
 * refreshed from the engine bytes it holds; one whose binding no longer
 * resolves has no revised bytes and is left as it is.
 */
export function planSkeletonRevision(
  records: readonly SkeletonRecord[],
  observations: ReadonlyMap<string, PathObservation>,
  skeletons: readonly GeneratedSkeleton[],
): readonly SkeletonRevisionAction[] {
  return Object.freeze(records.flatMap((record): readonly SkeletonRevisionAction[] => {
    const observation = observations.get(record.path) ?? ABSENT;
    if (observation.kind === "absent") return [];
    const skeleton = skeletons.find(({ path }) => samePlanPath(path, record.path));
    if (!isUntouchedSkeleton(record, observation.sha256, skeleton?.sha256 ?? null)) return [{ kind: "stale", record }];
    if (skeleton === undefined) return [];
    return observation.sha256 === skeleton.sha256
      ? [{ kind: "re-record", record, skeleton }]
      : [{ kind: "refresh", record, skeleton, expectedSha256: observation.sha256 }];
  }));
}

/** The outcome an operator reads: the revision, then one line per refreshed
 *  skeleton, stale skeleton and binding problem. */
export function revisionOutcomeMessage(
  { contract, revision, refreshed, staleSkeletons, bindingProblems }:
    Pick<RevisedContract, "contract" | "revision" | "refreshed" | "staleSkeletons" | "bindingProblems">,
): string {
  const revalidated = revision.revalidatedTaskIds.length === 0
    ? "no implemented claimant needed revalidation"
    : `${revision.revalidatedTaskIds.join(", ")} returned to revalidation`;
  return [
    `${contract} revision ${revision.revision} recorded; ${revalidated}. The next Wave Gate re-records its acceptance roster green.`,
    ...refreshed.map((path) => `skeleton refreshed ${path} from the revised types`),
    ...staleSkeletons.map((path) => `skeleton ${path}: stale against revised contract (modified, left as it is)`),
    ...bindingProblems.map((problem) =>
      `skeleton binding problem: ${renderSkeletonProblem(problem)}; the next spawn's stage two blocks on it`),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Shell: the refresh, before the locked update
// ---------------------------------------------------------------------------

/** Carry out one action: the refreshed record, the stale path, or why the refresh failed. */
type Performed =
  | Readonly<{ kind: "refreshed"; record: SkeletonRecord }>
  | Readonly<{ kind: "modified"; path: string }>
  | Readonly<{ kind: "failed"; problem: SkeletonProblem }>;

function perform(root: string, action: SkeletonRevisionAction, candidate: SkeletonCandidate | undefined, frozen: ReadonlySet<string>): readonly Performed[] {
  if (action.kind === "stale") return [{ kind: "modified", path: action.record.path }];
  if (candidate === undefined) return [];
  if (action.kind === "re-record") return [{ kind: "refreshed", record: skeletonRecordOf(candidate, "revision") }];
  const { path, bytes } = action.skeleton;
  const result = refreshSkeleton(root, path, action.expectedSha256, bytes, frozen);
  return result.kind === "written"
    ? [{ kind: "refreshed", record: skeletonRecordOf(candidate, "revision") }]
    : [{ kind: "failed", problem: writeFailure(path, result) }];
}

/**
 * Regenerate the revised contract's untouched skeletons from its types file as
 * it is on disk now, and name its modified ones and every binding problem.
 * Writes through the writer; commits nothing (the handler's locked update
 * does). Nothing for an unknown contract or one with no types file.
 */
export function refreshRevisedSkeletons(root: string, graph: TaskGraph, contractId: string): DomainResult<SkeletonRevision, string> {
  const view: SkeletonGraph = graph;
  const found = (view.acceptance_contracts ?? []).find(({ id }) => id === contractId);
  const contract = found === undefined ? null : typedContract(found);
  if (contract === null) return { ok: true, value: NO_SKELETON_REVISION };
  const bindings = (view.export_bindings ?? []).filter((binding) => binding.contract === contractId);
  const records = (view.skeletons ?? []).filter((record) => record.contract === contractId);
  if (bindings.length === 0 && records.length === 0) return { ok: true, value: NO_SKELETON_REVISION };
  const canonical = canonicalContractSkeletons(root, contract, bindings);
  if (!canonical.ok) return canonical;
  const { candidates } = canonical.value;
  const candidateAt = (path: string): SkeletonCandidate | undefined =>
    candidates.find((candidate) => samePlanPath(candidate.skeleton.path, path));
  const observed = observeSkeletonPaths(root, records.map(({ path }) => path), (path) => candidateAt(path)?.skeleton.sha256 ?? null);
  if (!observed.ok) return observed;
  const frozen = frozenSkeletonPaths(graph);
  const performed = planSkeletonRevision(records, observed.value.observations, candidates.map(({ skeleton }) => skeleton))
    .flatMap((action) => perform(root, action, candidateAt(action.record.path), frozen));
  return {
    ok: true,
    value: Object.freeze({
      refreshed: Object.freeze(performed.flatMap((done) => (done.kind === "refreshed" ? [done.record] : []))),
      modified: Object.freeze(performed.flatMap((done) => (done.kind === "modified" ? [done.path] : []))),
      bindingProblems: Object.freeze([
        ...canonical.value.problems,
        ...observed.value.problems,
        ...performed.flatMap((done) => (done.kind === "failed" ? [done.problem] : [])),
      ]),
    }),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const OPERATION = "Contract Revision";

export function createReviseContractHandler(subagentActive: SubagentActivity = anyActiveSubagent): HookHandler {
  return async (_stdin, args) => {
    const request = parseContractRevisionArgs(args);
    if (!request.ok) return { kind: "error", message: request.error };

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: refusal };
    const repository = resolveCanonicalGitRepositoryRoot(dirname(resolve(manager.getPath())));
    if (!repository.ok) {
      const reason = "message" in repository.error ? repository.error.message : repository.error.kind;
      return { kind: "error", message: `Contract Revision needs the TaskGraph's Git repository: ${reason}` };
    }

    try {
      // Observed before the lock, like the Wave Gate's stamp: the locked
      // transform reads no mutable bytes, and refuses as stale if the contracts
      // under the lock name a path this observation never read.
      const loaded = manager.load();
      const observations = observeFrozenDigests(repository.value, frozenPathsToObserve(loaded.acceptance_contracts ?? []));
      // A refused revision must not touch a skeleton: decide admissibility
      // first, then write, then commit under the lock (which decides again).
      const admissible = reviseAcceptanceContract(loaded, request.value, observations);
      if (!admissible.ok) return { kind: "error", message: admissible.error.message };
      const skeletons = refreshRevisedSkeletons(repository.value, loaded, request.value.contract);
      if (!skeletons.ok) {
        return { kind: "error", message: `Contract Revision cannot refresh ${request.value.contract}'s skeletons: ${skeletons.error}` };
      }
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const revised = reviseAcceptanceContract(locked, request.value, observations, skeletons.value);
        if (!revised.ok) throw new Error(revised.error.message);
        return { state: revised.value.graph, value: revised.value };
      });
      process.stderr.write(revisionOutcomeMessage(outcome));
      return { kind: "passthrough" };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default createReviseContractHandler();
