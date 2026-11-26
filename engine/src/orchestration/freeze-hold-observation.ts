/**
 * The settlement observation of frozen paths a contract writer holds
 * (ADR-0104). The sibling of `contract-conformance-observation.ts`, called
 * beside it by every proof-evaluating settlement path:
 * `settleExactImplementation` (both harnesses' stops) and
 * `reconcile-implementation-proof`.
 *
 * Which paths a Task may hold is `writerFrozenPaths`' answer: the frozen
 * paths of the contracts whose contract Task it is. A Task writing none reads
 * nothing. Otherwise each path is read without following any link:
 *
 * - a regular file is held, so its `declared-artifact-changed` obligation is
 *   satisfied even with its bytes unchanged; the contract's own freeze judges
 *   those bytes at the gate;
 * - an absent path, or one holding a link, directory or other kind, is not
 *   held: the obligation fails as not changed, and the freeze refuses it;
 * - any other failure to read is an infrastructure failure, returned as a
 *   message: settlement turns it into `implementation-observation-unavailable`
 *   and reconcile refuses without changing state.
 */

import { writerFrozenPaths } from "../core/acceptance-contract";
import type { DomainResult } from "../core/orchestration-contract";
import { NO_FREEZE_HOLDS, type FreezeHeldArtifact } from "../core/proof-obligations";
import type { Task, TaskGraph } from "../types";
import { describeCause } from "../utils/describe-cause";
import { resolveBaseDirectory } from "../utils/no-follow-fs";
import { readRepositoryLeafNoFollow } from "./repository-leaf";

export function observeHeldForFreeze(
  root: string,
  graph: TaskGraph,
  task: Task,
): DomainResult<readonly FreezeHeldArtifact[], string> {
  const owned = writerFrozenPaths(graph.acceptance_contracts ?? [], task.id);
  if (owned.length === 0) return { ok: true, value: NO_FREEZE_HOLDS };
  let realRoot: string;
  try {
    realRoot = resolveBaseDirectory(root);
  } catch (error) {
    return { ok: false, error: `cannot resolve the repository root ${root}: ${describeCause(error)}` };
  }
  const held: FreezeHeldArtifact[] = [];
  for (const { path, contract } of owned) {
    const leaf = readRepositoryLeafNoFollow(realRoot, path);
    if (!leaf.ok) return { ok: false, error: `${path}: ${leaf.error}` };
    if (leaf.value.kind === "file") held.push(Object.freeze({ artifact: path, contract }));
  }
  return { ok: true, value: Object.freeze(held) };
}
