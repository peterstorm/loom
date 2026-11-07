/**
 * The Contract Revision's skeleton refresh (AD-10, FR-033), run by the
 * `revise-contract` handler once the revision is known to be admissible and
 * before its locked update. Every binding of the revised contract is
 * re-resolved against its types file as it is on disk now, and each skeleton
 * record of the contract is planned `record-driven` by `planSkeletonRefresh`
 * (INV-4, through `presentSkeletonOf`):
 * - untouched → regenerated from the revised types through the writer's
 *   guarded refresh (INV-3), or adopted when its bytes already are the
 *   revised canonical bytes; settled `refreshed`, so its record takes origin
 *   `revision` and the new digests;
 * - modified → left on disk exactly as the implementer wrote it, settled
 *   `stale`, so its record is flagged `stale: { revision }`. A refresh the
 *   writer refuses as `modified` (the file changed after it was observed) is
 *   settled the same way (ADR-0057);
 * - deleted → nothing (the next registration regenerates it).
 * Every binding problem the revised types raise, and every other write the
 * writer refuses or fails, is a binding problem of the outcome. Writes precede
 * the locked update: a refused update leaves refreshed bytes that
 * content-addressed recognition adopts.
 */

import { NO_SKELETON_REVISION, skeletonRevisionOf, type SkeletonRevision, type SkeletonSettlement } from "../core/contract-revision";
import type { DomainResult } from "../core/orchestration-contract";
import { samePlanPath } from "../core/plan-path-match";
import type { SkeletonProblem } from "../core/skeleton/problems";
import { planSkeletonRefresh, type RecordRefreshAction } from "../core/skeleton/refresh-plan";
import type { TaskGraph } from "../types";
import { typedContract } from "./frozen-surface-observation";
import { observeSkeletonPaths } from "./skeleton-observation";
import { canonicalContractSkeletons, frozenSkeletonPaths, writeFailure, writePlanned } from "./skeleton-refresh";

/** What carrying out one action settled: one path's settlement, or the problem that settled nothing. */
type Settled =
  | Readonly<{ kind: "settled"; path: string; settlement: SkeletonSettlement }>
  | Readonly<{ kind: "failed"; problem: SkeletonProblem }>;

const STALE: SkeletonSettlement = Object.freeze({ kind: "stale" });

/** Carry out one action through the writer, and settle its path. */
function settle(root: string, action: RecordRefreshAction, frozen: ReadonlySet<string>): Settled {
  if (action.kind === "stale") return { kind: "settled", path: action.record.path, settlement: STALE };
  const { path } = action.candidate.skeleton;
  const written = writePlanned(root, action, "revision", frozen);
  if (written.kind === "recorded") {
    const { contract, language, engineSha256, typesSha256 } = written.record;
    return { kind: "settled", path, settlement: Object.freeze({ kind: "refreshed", skeleton: Object.freeze({ contract, language, engineSha256, typesSha256 }) }) };
  }
  const { result } = written;
  return result.kind === "refused" && result.reason === "modified"
    ? { kind: "settled", path, settlement: STALE }
    : { kind: "failed", problem: writeFailure(path, result) };
}

/**
 * Regenerate the revised contract's untouched skeletons from its types file as
 * it is on disk now, and settle its modified ones and name every binding
 * problem. Writes through the writer; commits nothing (the handler's locked
 * update does). Nothing for an unknown contract or one with no types file.
 */
export function refreshRevisedSkeletons(root: string, graph: TaskGraph, contractId: string): DomainResult<SkeletonRevision, string> {
  const found = (graph.acceptance_contracts ?? []).find(({ id }) => id === contractId);
  const contract = found === undefined ? null : typedContract(found);
  if (contract === null) return { ok: true, value: NO_SKELETON_REVISION };
  const bindings = (graph.export_bindings ?? []).filter((binding) => binding.contract === contractId);
  const records = (graph.skeletons ?? []).filter((record) => record.contract === contractId);
  if (bindings.length === 0 && records.length === 0) return { ok: true, value: NO_SKELETON_REVISION };
  const canonical = canonicalContractSkeletons(root, contract, bindings);
  if (!canonical.ok) return canonical;
  const { candidates } = canonical.value;
  const canonicalSha256 = (path: string): string | null =>
    candidates.find(({ skeleton }) => samePlanPath(skeleton.path, path))?.skeleton.sha256 ?? null;
  const observed = observeSkeletonPaths(root, records.map(({ path }) => path), canonicalSha256);
  if (!observed.ok) return observed;
  const frozen = frozenSkeletonPaths(graph);
  const settled = planSkeletonRefresh("record-driven", records, observed.value.observations, candidates)
    .map((action) => settle(root, action, frozen));
  return {
    ok: true,
    value: skeletonRevisionOf(
      settled.flatMap((done) => (done.kind === "settled" ? [[done.path, done.settlement] as const] : [])),
      [
        ...canonical.value.problems,
        ...observed.value.problems,
        ...settled.flatMap((done) => (done.kind === "failed" ? [done.problem] : [])),
      ],
    ),
  };
}
