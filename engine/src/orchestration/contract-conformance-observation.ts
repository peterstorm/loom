/**
 * The settlement observation of contract conformance (AD-5, AD-11; INV-5
 * sibling). Every proof-evaluating settlement path reaches it through the
 * bundled `observeContractTask` (`contract-task-observation.ts`):
 * `settleExactImplementation` (both harnesses' stops) and
 * `reconcile-implementation-proof`.
 *
 * Which files of which Task owe the signature or ADT check, against which
 * contracts, is `conformanceScope`'s answer (INV-5 owner) — never decided
 * here. A `not-owed` scope reads nothing. An owed scope reads each in-scope
 * contract's frozen types file as it is now and each in-scope file without
 * following any link, then hands the texts to the pure judge.
 *
 * - A missing in-scope file, or a path holding no regular file, is read as
 *   absent (`text: null`): the judge refuses its bound exports as `deleted`.
 * - Any other failure to read — the repository root, a types file that no
 *   longer reads as a surface, an unreadable file — is an infrastructure
 *   failure, returned as a message. Settlement turns it into
 *   `implementation-observation-unavailable`: it never consumes a semantic
 *   attempt and never passes.
 * - A contract whose types file no skeleton language reads has no surface to
 *   check against, so it contributes none (FR-019, FR-020: this is no waiver;
 *   the scope still judges the Task's files against every other contract).
 */

import type { AcceptanceContract } from "../core/acceptance-contract";
import type { DomainResult } from "../core/orchestration-contract";
import { judgeConformance } from "../core/skeleton/conformance";
import { skeletonLanguageOf } from "../core/skeleton/language";
import { conformanceScope, type ConformanceScope } from "../core/skeleton/scope";
import { CONFORMANCE_NOT_OWED } from "../core/skeleton/conformance-verdict";
import type { ConformanceFile, ContractConformance, ContractSurface, SkeletonTarget } from "../core/skeleton/types";
import type { Task, TaskGraph } from "../types";
import { observeFrozenSurface, typedContract } from "./frozen-surface-observation";
import { resolveBaseDirectory } from "../utils/no-follow-fs";
import { readRepositoryLeafNoFollow, type RepositoryLeaf } from "./repository-leaf";
import { renderResolutionProblem } from "../core/skeleton/problems";
import { describeCause } from "../utils/describe-cause";

/** Every value, or the first failure. */
function allOf<T>(results: readonly DomainResult<T, string>[]): DomainResult<readonly T[], string> {
  const failed = results.find((result): result is Extract<DomainResult<T, string>, { ok: false }> => !result.ok);
  return failed ?? { ok: true, value: Object.freeze(results.flatMap((result) => (result.ok ? [result.value] : []))) };
}

/** The surface of one in-scope contract, or null when no skeleton language reads its types file. */
function observeSurface(root: string, contract: AcceptanceContract): DomainResult<ContractSurface | null, string> {
  const typed = typedContract(contract);
  if (typed === null || skeletonLanguageOf(typed.types.path).kind === "unsupported") return { ok: true, value: null };
  const surface = observeFrozenSurface(root, typed, "current");
  return surface.ok
    ? { ok: true, value: Object.freeze({ contract: contract.id, surface: surface.value }) }
    : { ok: false, error: renderResolutionProblem(surface.error) };
}

/** What one repository path holds, read without following a link; the error is phrased to follow the path. */
export type RepositoryLeafReader = (path: string) => DomainResult<RepositoryLeaf, string>;

/** One in-scope file as the judge reads it: its text, or null when no regular file is there. */
function observeFile(readLeaf: RepositoryLeafReader, target: SkeletonTarget): DomainResult<ConformanceFile, string> {
  const leaf = readLeaf(target.path);
  if (!leaf.ok) return { ok: false, error: `${target.path}: ${leaf.error}` };
  const text = leaf.value.kind === "file" ? leaf.value.bytes.toString("utf-8") : null;
  return { ok: true, value: Object.freeze({ target, text }) };
}

/** The repository root as the no-follow readers take it, or why it cannot be resolved. */
export function resolveRepositoryRoot(root: string): DomainResult<string, string> {
  try {
    return { ok: true, value: resolveBaseDirectory(root) };
  } catch (error) {
    return { ok: false, error: `cannot resolve the repository root ${root}: ${describeCause(error)}` };
  }
}

export function observeContractConformance(
  root: string,
  graph: TaskGraph,
  task: Task,
): DomainResult<ContractConformance, string> {
  const scope = conformanceScope(graph, task);
  if (scope.kind === "not-owed") return { ok: true, value: CONFORMANCE_NOT_OWED };
  const realRoot = resolveRepositoryRoot(root);
  if (!realRoot.ok) return realRoot;
  return judgeOwedConformance(realRoot.value, scope, (path) => readRepositoryLeafNoFollow(realRoot.value, path));
}

/**
 * An owed scope judged under the resolved root, reading each in-scope file
 * through `readLeaf`: the one judgment `observeContractConformance` and the
 * bundled `observeContractTask` share.
 */
export function judgeOwedConformance(
  realRoot: string,
  scope: Extract<ConformanceScope, { kind: "owed" }>,
  readLeaf: RepositoryLeafReader,
): DomainResult<ContractConformance, string> {
  const surfaces = allOf(scope.contracts.map((contract) => observeSurface(realRoot, contract)));
  if (!surfaces.ok) return surfaces;
  const files = allOf(scope.files.map((target) => observeFile(readLeaf, target)));
  if (!files.ok) return files;
  return {
    ok: true,
    value: judgeConformance({
      surfaces: surfaces.value.flatMap((surface) => (surface === null ? [] : [surface])),
      bindings: scope.bindings,
      files: files.value,
    }),
  };
}
