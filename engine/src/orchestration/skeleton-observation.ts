/**
 * What is on disk at skeleton paths (G2 AD-13), read one way for every
 * consumer: registration (`skeleton-materialization.ts`), the contract stub
 * step, the Contract Revision's refresh, the implementation brief's Frozen
 * Signatures section and `helper orchestration status`. A path is absent, or
 * present with the digest of its bytes read without following any link, and
 * the canonical skeleton's digest where it has one; the outcome derivation
 * (`core/skeleton/outcomes.ts`, INV-4) judges what that means.
 */

import { match } from "ts-pattern";
import { contractRole } from "../core/acceptance-contract";
import { sha256Bytes } from "../core/digest";
import { isNonEmpty, type DomainResult } from "../core/orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../core/plan-path-match";
import { productionFiles } from "../core/skeleton/graph-view";
import { ABSENT } from "../core/skeleton/outcomes";
import { renderResolutionProblem, renderSkeletonProblem, type SkeletonProblem } from "../core/skeleton/problems";
import type { UnresolvedSkeletonBinding } from "../core/skeleton/status";
import type { ExportBinding, FrozenSurface, PathObservation } from "../core/skeleton/types";
import type { Task, TaskGraph } from "../types";
import { observeFrozenSurface, typedContract, type TypedContract } from "./frozen-surface-observation";
import { resolveBaseDirectory } from "./no-follow-fs";
import { readRepositoryLeafNoFollow } from "./repository-leaf";
import { canonicalContractSkeletons } from "./skeleton-refresh";
import { describeCause } from "../utils/describe-cause";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The observed paths, and a problem for each one that cannot be read without following a link. */
export type ObservedSkeletonPaths = Readonly<{
  observations: ReadonlyMap<string, PathObservation>;
  problems: readonly SkeletonProblem[];
}>;

/** What is at one path under the resolved repository root, or why it cannot be read. */
function observePath(realRoot: string, path: string, canonicalSha256: string | null): DomainResult<PathObservation, SkeletonProblem> {
  const leaf = readRepositoryLeafNoFollow(realRoot, path);
  if (!leaf.ok) return { ok: false, error: Object.freeze({ kind: "write-failed", path, detail: leaf.error }) };
  const present = (sha256: string): DomainResult<PathObservation, SkeletonProblem> =>
    ({ ok: true, value: Object.freeze({ kind: "present", sha256, canonicalSha256 }) });
  return match(leaf.value)
    .with({ kind: "absent" }, (): DomainResult<PathObservation, SkeletonProblem> => ({ ok: true, value: ABSENT }))
    .with({ kind: "not-a-regular-file" }, () => present(""))
    .with({ kind: "file" }, ({ bytes }) => present(sha256Bytes(bytes)))
    .exhaustive();
}

/**
 * What is at each distinct path now. A missing path is absent. A link or
 * directory is present with no content digest (the empty string, which
 * equals no digest), so it is never judged untouched and never written over.
 * A regular file is present with the digest of its bytes, read without
 * following any link; one that cannot be read so is a problem, and is left
 * out of the observations. `canonicalSha256` is each path's canonical
 * digest, when it has one. A repository root that cannot be resolved is the
 * error.
 */
export function observeSkeletonPaths(
  root: string,
  paths: readonly string[],
  canonicalSha256: (path: string) => string | null,
): DomainResult<ObservedSkeletonPaths, string> {
  let realRoot: string;
  try {
    realRoot = resolveBaseDirectory(root);
  } catch (error) {
    return { ok: false, error: `cannot resolve the repository root ${root}: ${describeCause(error)}` };
  }
  const observed = [...new Set(paths)].map((path) => [path, observePath(realRoot, path, canonicalSha256(path))] as const);
  return {
    ok: true,
    value: Object.freeze({
      observations: new Map(observed.flatMap(([path, result]) => (result.ok ? [[path, result.value] as const] : []))),
      problems: Object.freeze(observed.flatMap(([, result]) => (result.ok ? [] : [result.error]))),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tasks: the brief's and status's observation
// ---------------------------------------------------------------------------

/**
 * What is on disk for some Tasks' skeletons: each production path, absent or
 * present with its digest and its canonical skeleton's; each relevant
 * contract's frozen surface as its freeze stamps it, or the line naming why
 * it could not be read; and every stage-two problem of the resolving Tasks'
 * bindings, exactly as registration would meet them.
 */
export type SkeletonObservation = Readonly<{
  observations: ReadonlyMap<string, PathObservation>;
  surfaces: ReadonlyMap<string, DomainResult<FrozenSurface, string>>;
  unresolved: readonly UnresolvedSkeletonBinding[];
}>;

const NOTHING_OBSERVED: SkeletonObservation = Object.freeze({
  observations: new Map(),
  surfaces: new Map(),
  unresolved: Object.freeze([]),
});

/** The contracts whose frozen surface matters: those the resolving Tasks bind, then those any observed Task claims. */
function relevantContractIds(graph: TaskGraph, observed: readonly Task[], heldContracts: readonly string[]): readonly string[] {
  const claimed = (graph.acceptance_contracts ?? []).filter((contract) =>
    observed.some((task) => contractRole(contract, task, graph.tasks).kind === "claimant")).map(({ id }) => id);
  return [...new Set([...heldContracts, ...claimed])];
}

/** What one contract contributes: its surface, its bound paths' canonical digests, and its stage-two problems. */
type ContractObservation = Readonly<{
  id: string;
  surface: DomainResult<FrozenSurface, string>;
  canonical: readonly (readonly [string, string])[];
  unresolved: readonly UnresolvedSkeletonBinding[];
}>;

const unresolvedOf = (problem: SkeletonProblem): UnresolvedSkeletonBinding =>
  Object.freeze({ problem, message: renderSkeletonProblem(problem) });

/**
 * One contract's frozen surface in `stamped` mode, and — when a resolving Task
 * binds it — the canonical skeletons and problems of those `bindings`. A
 * surface that cannot be read is that contract's one problem; failing to read
 * its acceptance files for the specifier style is the error.
 */
function observeContract(root: string, contract: TypedContract, bindings: readonly ExportBinding[]): DomainResult<ContractObservation, string> {
  const stamped = observeFrozenSurface(root, contract, "stamped");
  if (!stamped.ok) {
    const unreadable: ContractObservation = {
      id: contract.id,
      surface: { ok: false, error: renderResolutionProblem(stamped.error) },
      canonical: [],
      unresolved: bindings.length === 0 ? [] : [unresolvedOf(stamped.error)],
    };
    return { ok: true, value: Object.freeze(unreadable) };
  }
  if (bindings.length === 0) return { ok: true, value: Object.freeze({ id: contract.id, surface: stamped, canonical: [], unresolved: [] }) };
  const generated = canonicalContractSkeletons(root, contract, bindings);
  if (!generated.ok) return generated;
  return {
    ok: true,
    value: Object.freeze({
      id: contract.id,
      surface: stamped,
      canonical: generated.value.candidates.map(({ skeleton }) => [normalizePlanPath(skeleton.path), skeleton.sha256] as const),
      unresolved: generated.value.problems.map(unresolvedOf),
    }),
  };
}

/**
 * Observe the skeletons of `observed`, resolving the bindings of `resolving`
 * (the Tasks a spawn would register). Each contract a resolving Task binds is
 * read in `stamped` mode, as registration reads it, so a drifted or
 * unparseable types file is the problem registration would refuse with; a
 * contract that resolves gets canonical skeletons (`canonicalContractSkeletons`)
 * and every per-binding problem. A contract still `awaiting-red` has no frozen
 * surface yet and is skipped. A TaskGraph populated before export bindings
 * were stamped writes no skeletons, so nothing is read. An unreadable path or
 * repository root is the error.
 */
export function observeSkeletons(
  root: string,
  graph: TaskGraph,
  observed: readonly Task[],
  resolving: readonly Task[],
): DomainResult<SkeletonObservation, string> {
  if (graph.export_bindings === undefined) return { ok: true, value: NOTHING_OBSERVED };
  const resolvingPaths = resolving.flatMap((task) => productionFiles(graph, task));
  const held = graph.export_bindings.filter((binding) => resolvingPaths.some((path) => samePlanPath(path, binding.path)));
  const contracts = relevantContractIds(graph, observed, held.map(({ contract }) => contract)).flatMap((id) => {
    const found = (graph.acceptance_contracts ?? []).find((contract) => contract.id === id);
    const typed = found === undefined ? null : typedContract(found);
    return typed === null || typed.freeze.state === "awaiting-red" ? [] : [typed];
  });
  const read = contracts.map((contract) =>
    observeContract(root, contract, held.filter((binding) => binding.contract === contract.id)));
  const failed = read.flatMap((result) => (result.ok ? [] : [result.error]));
  if (isNonEmpty(failed)) return { ok: false, error: failed.join("; ") };
  const observedContracts = read.flatMap((result) => (result.ok ? [result.value] : []));
  const canonical = new Map(observedContracts.flatMap(({ canonical: digests }) => digests));
  const paths = observed.flatMap((task) => productionFiles(graph, task));
  const present = observeSkeletonPaths(root, paths, (path) => canonical.get(normalizePlanPath(path)) ?? null);
  if (!present.ok) return present;
  if (isNonEmpty(present.value.problems)) return { ok: false, error: present.value.problems.map(renderSkeletonProblem).join("; ") };
  return {
    ok: true,
    value: Object.freeze({
      observations: present.value.observations,
      surfaces: new Map(observedContracts.map(({ id, surface }) => [id, surface] as const)),
      unresolved: Object.freeze(observedContracts.flatMap(({ unresolved }) => unresolved)),
    }),
  };
}
