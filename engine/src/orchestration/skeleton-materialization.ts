/**
 * Per-Task skeleton materialization at registration (AD-1). The one step
 * `registerTaskExecutionBatch` runs after its ownership and eligibility checks
 * and before any attempt baseline is captured, so the engine's bytes are on
 * disk — and never an implementer's write — when the attempt starts.
 *
 * 1. **Stage two.** Every binding the registering Tasks hold is resolved
 *    against its contract's types file, whose bytes must equal the freeze
 *    stamp (`observeFrozenSurface`, `stamped`). Any missing alias, non-function
 *    or generic alias, drifted or unreadable types file, unfrozen contract or
 *    language mismatch blocks the whole batch, every problem named, before a
 *    byte is written (AS-008, AS-009).
 * 2. **Plan.** Each registering Task's production paths are observed
 *    (`observeSkeletonPaths`: absent, or present with their digest and the
 *    canonical skeleton's), and the pure `planTaskSkeletons` derives the
 *    outcomes (`skeletonOutcomesOf`, INV-4) and the actions: create a missing
 *    bound skeleton (first attempt, a retry whose skeleton was deleted, an
 *    infrastructure respawn — FR-005, FR-032), adopt canonical bytes with no
 *    record (a write whose locked record failed), or refresh an untouched
 *    skeleton generated from an older surface (`presentSkeletonOf`).
 * 3. **Write.** Every byte goes through the no-clobber writer (INV-3); an
 *    existing file is never modified (FR-011).
 * 4. **Return** the new or updated records and each Task's outcomes, which
 *    registration commits in the same locked update as the reservation.
 *
 * A graph populated before G2 (no `export_bindings` stamp) materializes
 * nothing and records nothing. Every expected failure is a value (FR-045):
 * the error lists one diagnostic line per problem. Files already written by a
 * refused registration stay, and the next registration adopts them by content.
 */

import { isNonEmpty, type DomainResult, type NonEmpty } from "../core/orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../core/plan-path-match";
import { productionFiles, type SkeletonGraph } from "../core/skeleton/graph-view";
import { presentSkeletonOf, skeletonOutcomesOf } from "../core/skeleton/outcomes";
import { renderResolutionProblem, renderSkeletonProblem } from "../core/skeleton/problems";
import type { SkeletonCandidate } from "../core/skeleton/records";
import type { AdoptAction, CreateAction, RefreshAction } from "../core/skeleton/refresh-plan";
import { resolveBindings } from "../core/skeleton/resolve";
import type { ExportBinding, PathObservation, PathSkeletonOutcome, SkeletonOrigin, SkeletonRecord } from "../core/skeleton/types";
import type { TaskSkeletonRegistration } from "../core/validate-task-execution";
import type { TaskGraph } from "../types";
import { observeFrozenSurface, observeSpecifierStyle, typedContract } from "./frozen-surface-observation";
import { observeSkeletonPaths } from "./skeleton-observation";
import { frozenSkeletonPaths, generatedSkeleton, writePlanned } from "./skeleton-refresh";
import { renderSkeletonWriteResult } from "./skeleton-writer";

// ---------------------------------------------------------------------------
// Pure core: the plan of one Task
// ---------------------------------------------------------------------------

/** What registration does at one path; a refresh keeps the origin of the record it replaces. */
export type SkeletonAction = CreateAction | AdoptAction | (RefreshAction & Readonly<{ origin: SkeletonOrigin }>);

export type TaskSkeletonPlan = Readonly<{
  taskId: string;
  /** Exactly one outcome per production path, from `skeletonOutcomesOf`. */
  outcomes: readonly PathSkeletonOutcome[];
  actions: readonly SkeletonAction[];
}>;

const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/**
 * The outcomes and actions of one Task, given what was observed and the
 * canonical skeleton of every bound path. `skeletonOutcomesOf` decides each
 * outcome and whether a present file is untouched; this only maps a
 * `skeleton-written` outcome to the write it still needs:
 * - absent → create;
 * - present with no record → adopt (untouched with no record means canonical);
 * - present, recorded, and engine bytes from an older surface
 *   (`presentSkeletonOf`) → refresh from the engine bytes it holds.
 * A `skeleton-written` path with no canonical skeleton cannot be written: it
 * is listed as a problem. A Task the graph does not hold cannot be planned.
 */
export function planTaskSkeletons(
  graph: TaskGraph,
  taskId: string,
  observations: ReadonlyMap<string, PathObservation>,
  candidates: ReadonlyMap<string, SkeletonCandidate>,
): DomainResult<TaskSkeletonPlan, NonEmpty<string>> {
  const view: SkeletonGraph = graph;
  const derived = skeletonOutcomesOf(graph, taskId, observations);
  if (!derived.ok) return { ok: false, error: [`${derived.error.taskId} is not a Task of the TaskGraph; no skeleton can be planned for it`] };
  const outcomes = derived.value;
  const planned = outcomes.map(({ path, outcome }): DomainResult<readonly SkeletonAction[], string> => {
    if (outcome.kind !== "skeleton-written") return { ok: true, value: [] };
    const observation = observations.get(path) ?? ABSENT;
    const candidate = candidates.get(normalizePlanPath(path));
    if (candidate === undefined) {
      return observation.kind === "absent"
        ? { ok: false, error: `${path}: ${taskId} binds it, but no canonical skeleton could be generated for it` }
        : { ok: true, value: [] };
    }
    if (observation.kind === "absent") return { ok: true, value: [{ kind: "create", candidate }] };
    const record = (view.skeletons ?? []).find((recorded) => samePlanPath(recorded.path, path));
    if (record === undefined) return { ok: true, value: [{ kind: "adopt", candidate }] };
    return presentSkeletonOf(record, observation.sha256, candidate.skeleton.sha256) === "engine-bytes"
      ? { ok: true, value: [{ kind: "refresh", candidate, expectedSha256: observation.sha256, origin: record.origin }] }
      : { ok: true, value: [] };
  });
  const problems = planned.flatMap((result) => (result.ok ? [] : [result.error]));
  if (isNonEmpty(problems)) return { ok: false, error: Object.freeze(problems) };
  return {
    ok: true,
    value: Object.freeze({
      taskId,
      outcomes,
      actions: Object.freeze(planned.flatMap((result) => (result.ok ? result.value : []))),
    }),
  };
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

type Problems = NonEmpty<string>;

const NOTHING: TaskSkeletonRegistration = Object.freeze({ records: Object.freeze([]), outcomes: new Map() });

/** The bindings in order, grouped by contract in first-appearance order. */
function byContract(bindings: readonly ExportBinding[]): readonly (readonly [string, readonly ExportBinding[]])[] {
  const contracts = [...new Set(bindings.map(({ contract }) => contract))];
  return contracts.map((id) => [id, bindings.filter(({ contract }) => contract === id)] as const);
}

/** The canonical skeleton of every supported held binding of one contract. */
function contractCandidates(
  root: string,
  graph: SkeletonGraph,
  contractId: string,
  bindings: readonly ExportBinding[],
): DomainResult<readonly SkeletonCandidate[], Problems> {
  const paths = bindings.map(({ path }) => path).join(", ");
  const found = (graph.acceptance_contracts ?? []).find(({ id }) => id === contractId);
  const contract = found === undefined ? null : typedContract(found);
  if (contract === null) return { ok: false, error: [`${paths} bind ${contractId}, which freezes no types file`] };
  if (contract.freeze.state === "awaiting-red") {
    return { ok: false, error: [`${paths} bind ${contractId}, whose types file ${contract.types.path} is not frozen yet`] };
  }
  const surface = observeFrozenSurface(root, contract, "stamped");
  if (!surface.ok) return { ok: false, error: [renderResolutionProblem(surface.error)] };
  const resolved = resolveBindings(surface.value, bindings);
  if (!resolved.ok) {
    const [first, ...rest] = resolved.error;
    return { ok: false, error: [renderResolutionProblem(first), ...rest.map(renderResolutionProblem)] };
  }
  const style = surface.value.language === "typescript" ? observeSpecifierStyle(root, contract) : { ok: true as const, value: null };
  if (!style.ok) return { ok: false, error: [style.error] };
  const generations = resolved.value.map((binding) => generatedSkeleton(surface.value, binding, style.value));
  const mismatches = generations.flatMap((generation) => (generation.ok ? [] : [renderSkeletonProblem(generation.error)]));
  if (isNonEmpty(mismatches)) return { ok: false, error: mismatches };
  return {
    ok: true,
    value: generations.flatMap((generation) => (generation.ok && generation.value !== null
      ? [Object.freeze({ skeleton: generation.value, contract: contractId, typesSha256: surface.value.typesSha256 })]
      : [])),
  };
}

/** The canonical skeleton of every held binding, by normalized path. */
function candidatesFor(
  root: string,
  graph: SkeletonGraph,
  held: readonly ExportBinding[],
): DomainResult<ReadonlyMap<string, SkeletonCandidate>, Problems> {
  const results = byContract(held).map(([contractId, bindings]) => contractCandidates(root, graph, contractId, bindings));
  const problems = results.flatMap((result) => (result.ok ? [] : result.error));
  if (isNonEmpty(problems)) return { ok: false, error: problems };
  return {
    ok: true,
    value: new Map(results.flatMap((result) => (result.ok ? result.value : []))
      .map((candidate) => [normalizePlanPath(candidate.skeleton.path), candidate] as const)),
  };
}

/** What is at each path, or every path that cannot be read without following a link. */
function observePaths(
  root: string,
  paths: readonly string[],
  candidates: ReadonlyMap<string, SkeletonCandidate>,
): DomainResult<ReadonlyMap<string, PathObservation>, Problems> {
  const observed = observeSkeletonPaths(root, paths, (path) => candidates.get(normalizePlanPath(path))?.skeleton.sha256 ?? null);
  if (!observed.ok) return { ok: false, error: [observed.error] };
  const problems = observed.value.problems.map(renderSkeletonProblem);
  if (isNonEmpty(problems)) return { ok: false, error: problems };
  return { ok: true, value: observed.value.observations };
}

/** Carry out one action through the writer; the record it leaves, or why none. */
function perform(root: string, action: SkeletonAction, frozen: ReadonlySet<string>): DomainResult<SkeletonRecord, string> {
  const written = writePlanned(root, action, action.kind === "refresh" ? action.origin : "spawn", frozen);
  return written.kind === "recorded"
    ? { ok: true, value: written.record }
    : { ok: false, error: renderSkeletonWriteResult(action.candidate.skeleton.path, written.result) };
}

/**
 * Resolve, plan and write the skeletons of the registering Tasks. Returns the
 * records written, adopted or refreshed, and every registering Task's
 * outcomes; or every problem that blocks the registration.
 */
export function materializeTaskSkeletons(
  root: string,
  graph: TaskGraph,
  taskIds: readonly string[],
): DomainResult<TaskSkeletonRegistration, Problems> {
  const view: SkeletonGraph = graph;
  if (view.export_bindings === undefined) return { ok: true, value: NOTHING };
  const tasks = view.tasks.filter(({ id }) => taskIds.includes(id));
  const paths = tasks.flatMap((task) => productionFiles(view, task));
  const held = view.export_bindings.filter((binding) => paths.some((path) => samePlanPath(path, binding.path)));
  const candidates = candidatesFor(root, view, held);
  if (!candidates.ok) return candidates;
  const observations = observePaths(root, paths, candidates.value);
  if (!observations.ok) return observations;
  const plans = tasks.map(({ id }) => planTaskSkeletons(view, id, observations.value, candidates.value));
  const planProblems = plans.flatMap((plan) => (plan.ok ? [] : plan.error));
  if (isNonEmpty(planProblems)) return { ok: false, error: planProblems };
  const settled = plans.flatMap((plan) => (plan.ok ? [plan.value] : []));
  const frozen = frozenSkeletonPaths(view);
  const performed = settled.flatMap(({ actions }) => actions.map((action) => perform(root, action, frozen)));
  const writeProblems = performed.flatMap((result) => (result.ok ? [] : [result.error]));
  if (isNonEmpty(writeProblems)) return { ok: false, error: writeProblems };
  return {
    ok: true,
    value: Object.freeze({
      records: Object.freeze(performed.flatMap((result) => (result.ok ? [result.value] : []))),
      outcomes: new Map(settled.map(({ taskId, outcomes }) => [taskId, outcomes] as const)),
    }),
  };
}
