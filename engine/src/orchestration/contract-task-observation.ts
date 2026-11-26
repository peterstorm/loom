/**
 * The one settlement observation of a Task against the Acceptance Contracts,
 * called once by every proof-evaluating settlement path:
 * `settleExactImplementation` (both harnesses' stops) and
 * `reconcile-implementation-proof`. It resolves the repository root once and
 * reads each repository leaf once, and yields both halves the pure core
 * judges, or one infrastructure failure.
 *
 * - Conformance (AD-5): `conformanceScope` decides which files owe it
 *   (INV-5); an owed scope is judged by `judgeOwedConformance`.
 * - Freeze holds (ADR-0104): the frozen paths of the contracts the Task
 *   writes (`writerFrozenPaths`). A regular file is held; an absent path, or
 *   one holding a link, directory or other kind, is not held, so the
 *   obligation fails as not changed and the freeze refuses the path at the
 *   gate.
 *
 * A Task that owes no conformance and writes no contract reads nothing and
 * yields `NO_CONTRACT_TASK_OBSERVATION`. Any failure to read is returned as a
 * message: settlement turns it into `implementation-observation-unavailable`,
 * and reconcile refuses without changing state.
 */

import { writerFrozenPaths } from "../core/acceptance-contract";
import type { DomainResult } from "../core/orchestration-contract";
import {
  NO_CONTRACT_TASK_OBSERVATION,
  type ContractTaskObservation,
  type FreezeHeldArtifact,
} from "../core/proof-obligations";
import { CONFORMANCE_NOT_OWED } from "../core/skeleton/conformance-verdict";
import { conformanceScope } from "../core/skeleton/scope";
import type { Task, TaskGraph } from "../types";
import {
  judgeOwedConformance,
  resolveRepositoryRoot,
  type RepositoryLeafReader,
} from "./contract-conformance-observation";
import { readRepositoryLeafNoFollow, type RepositoryLeaf } from "./repository-leaf";

/** A reader that reads each path under `realRoot` at most once. */
function readingOnce(realRoot: string): RepositoryLeafReader {
  const read = new Map<string, DomainResult<RepositoryLeaf, string>>();
  return (path) => {
    const known = read.get(path);
    if (known !== undefined) return known;
    const leaf = readRepositoryLeafNoFollow(realRoot, path);
    read.set(path, leaf);
    return leaf;
  };
}

export function observeContractTask(
  root: string,
  graph: TaskGraph,
  task: Task,
): DomainResult<ContractTaskObservation, string> {
  const scope = conformanceScope(graph, task);
  const owned = writerFrozenPaths(graph.acceptance_contracts ?? [], task.id);
  if (scope.kind === "not-owed" && owned.length === 0) return { ok: true, value: NO_CONTRACT_TASK_OBSERVATION };
  const realRoot = resolveRepositoryRoot(root);
  if (!realRoot.ok) return realRoot;
  const readLeaf = readingOnce(realRoot.value);
  const conformance = scope.kind === "not-owed"
    ? { ok: true as const, value: CONFORMANCE_NOT_OWED }
    : judgeOwedConformance(realRoot.value, scope, readLeaf);
  if (!conformance.ok) return conformance;
  const held: FreezeHeldArtifact[] = [];
  for (const { path, contract } of owned) {
    const leaf = readLeaf(path);
    if (!leaf.ok) return { ok: false, error: `${path}: ${leaf.error}` };
    if (leaf.value.kind === "file") held.push(Object.freeze({ artifact: path, contract }));
  }
  return { ok: true, value: Object.freeze({ conformance: conformance.value, heldForFreeze: Object.freeze(held) }) };
}
