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
 * 2. **Plan.** Each registering Task's production paths are observed (absent,
 *    or present with their digest and the canonical skeleton's), and the pure
 *    `planTaskSkeletons` derives the outcomes (`skeletonOutcomes`, INV-4) and
 *    the actions: create a missing bound skeleton (first attempt, a retry whose
 *    skeleton was deleted, an infrastructure respawn — FR-005, FR-032), adopt
 *    canonical bytes with no record (a write whose locked record failed), or
 *    refresh an untouched skeleton generated from an older surface.
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

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { frozenPaths } from "../core/acceptance-contract";
import { sha256Bytes } from "../core/digest";
import { isNonEmpty, type DomainResult, type NonEmpty } from "../core/orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../core/plan-path-match";
import { generateSkeleton } from "../core/skeleton/generate";
import { skeletonLanguageOf } from "../core/skeleton/language";
import { skeletonOutcomes } from "../core/skeleton/outcomes";
import { resolveBindings } from "../core/skeleton/resolve";
import { productionFiles, type SkeletonGraph } from "../core/skeleton/scope";
import type {
  ExportBinding,
  GeneratedSkeleton,
  GenerateSkeletonInput,
  PathObservation,
  PathSkeletonOutcome,
  ResolutionProblem,
  ResolvedBinding,
  SkeletonOrigin,
  SkeletonRecord,
  SpecifierStyle,
} from "../core/skeleton/types";
import type { TaskSkeletonRegistration } from "../core/validate-task-execution";
import type { TaskGraph } from "../types";
import {
  observeFrozenSurface,
  observeSpecifierStyle,
  typedContract,
  type ObservedFrozenSurface,
} from "./frozen-surface-observation";
import { readRunBytesNoFollow, resolveBaseDirectory } from "./no-follow-fs";
import { createSkeleton, refreshSkeleton, renderSkeletonWriteResult, type SkeletonWriteResult } from "./skeleton-writer";

// ---------------------------------------------------------------------------
// Pure core: the plan of one Task
// ---------------------------------------------------------------------------

/** The canonical skeleton of one bound path, with the contract and types-file
 *  digest its record names. */
export type SkeletonCandidate = Readonly<{ skeleton: GeneratedSkeleton; contract: string; typesSha256: string }>;

/** What registration does at one path. */
export type SkeletonAction =
  | Readonly<{ kind: "create"; candidate: SkeletonCandidate }>
  | Readonly<{ kind: "adopt"; candidate: SkeletonCandidate }>
  | Readonly<{ kind: "refresh"; candidate: SkeletonCandidate; expectedSha256: string; origin: SkeletonOrigin }>;

export type TaskSkeletonPlan = Readonly<{
  taskId: string;
  /** Exactly one outcome per production path, from `skeletonOutcomes`. */
  outcomes: readonly PathSkeletonOutcome[];
  actions: readonly SkeletonAction[];
}>;

const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/**
 * The outcomes and actions of one Task, given what was observed and the
 * canonical skeleton of every bound path. `skeletonOutcomes` decides each
 * outcome and whether a present file is untouched; this only maps a
 * `skeleton-written` outcome to the write it still needs:
 * - absent → create;
 * - present with no record → adopt (untouched with no record means canonical);
 * - present, recorded, but not the current canonical bytes → refresh from
 *   the engine bytes it holds.
 * A `skeleton-written` path with no canonical skeleton cannot be written: it
 * is listed as a problem.
 */
export function planTaskSkeletons(
  graph: TaskGraph,
  taskId: string,
  observations: ReadonlyMap<string, PathObservation>,
  candidates: ReadonlyMap<string, SkeletonCandidate>,
): DomainResult<TaskSkeletonPlan, NonEmpty<string>> {
  const view: SkeletonGraph = graph;
  const outcomes = skeletonOutcomes(graph, taskId, observations);
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
    return observation.sha256 === candidate.skeleton.sha256
      ? { ok: true, value: [] }
      : { ok: true, value: [{ kind: "refresh", candidate, expectedSha256: observation.sha256, origin: record.origin }] };
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

/** One diagnostic line per stage-two problem, naming the alias, the binding
 *  file and the types file where the problem has them. */
export function renderResolutionProblem(problem: ResolutionProblem): string {
  switch (problem.kind) {
    case "missing-alias":
      return `${problem.path} binds ${problem.alias}, but the frozen types file ${problem.typesFile} declares no ${problem.alias}`;
    case "not-a-function":
      return `${problem.path} binds ${problem.alias}, but ${problem.alias} in the frozen types file ${problem.typesFile} is not a function type`;
    case "generic-alias":
      return `${problem.path} binds ${problem.alias}, but ${problem.alias} in the frozen types file ${problem.typesFile} is a generic function type, which no skeleton can bind`;
    case "unsupported-holder-shape":
      return `the frozen types file ${problem.typesFile} has an unsupported holder shape (${problem.detail})`;
    case "types-unparseable":
      return `the frozen types file ${problem.typesFile} cannot be read as a types surface (${problem.detail})`;
    case "types-drifted":
      return `the frozen types file ${problem.typesFile} no longer matches its Acceptance Freeze stamp`;
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

type Problems = NonEmpty<string>;

const NOTHING: TaskSkeletonRegistration = Object.freeze({ records: Object.freeze([]), outcomes: new Map() });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The bindings in order, grouped by contract in first-appearance order. */
function byContract(bindings: readonly ExportBinding[]): readonly (readonly [string, readonly ExportBinding[]])[] {
  const contracts = [...new Set(bindings.map(({ contract }) => contract))];
  return contracts.map((id) => [id, bindings.filter(({ contract }) => contract === id)] as const);
}

/** The generator input of one resolved binding, or why none exists. */
function generatorInput(
  binding: ResolvedBinding,
  surface: ObservedFrozenSurface,
  specifierStyle: SpecifierStyle | null,
): GenerateSkeletonInput | string | null {
  const target = skeletonLanguageOf(binding.path);
  if (target.kind === "unsupported") return null;
  const { contract, exports } = binding;
  if (target.language === "typescript" && surface.language === "typescript") {
    return { language: "typescript", target, surface, contract, exports, specifierStyle };
  }
  if (target.language === "java" && surface.language === "java") return { language: "java", target, surface, contract, exports };
  return `${binding.path} is ${target.language}, but it binds ${contract}, whose types file ${surface.path} is ${surface.language}`;
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
  const inputs = resolved.value.map((binding) => generatorInput(binding, surface.value, style.value));
  const mismatches = inputs.filter((input): input is string => typeof input === "string");
  if (isNonEmpty(mismatches)) return { ok: false, error: mismatches };
  return {
    ok: true,
    value: inputs.flatMap((input) => (input === null || typeof input === "string"
      ? []
      : [Object.freeze({ skeleton: generateSkeleton(input), contract: contractId, typesSha256: surface.value.typesSha256 })])),
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

/**
 * What is at one repository path now. A regular file is present with its
 * digest; a link or directory is present with no content digest (the empty
 * string, which equals no digest), so it is never judged an untouched
 * skeleton and never written over.
 */
function observePath(realRoot: string, path: string, canonicalSha256: string | null): DomainResult<PathObservation, string> {
  const absolute = join(realRoot, path);
  try {
    if (!lstatSync(absolute).isFile()) return { ok: true, value: Object.freeze({ kind: "present", sha256: "", canonicalSha256 }) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, value: ABSENT };
    return { ok: false, error: `cannot observe ${path}: ${errorMessage(error)}` };
  }
  try {
    return { ok: true, value: Object.freeze({ kind: "present", sha256: sha256Bytes(readRunBytesNoFollow(absolute)), canonicalSha256 }) };
  } catch (error) {
    return { ok: false, error: `cannot read ${path} without following a link: ${errorMessage(error)}` };
  }
}

function observePaths(
  root: string,
  paths: readonly string[],
  candidates: ReadonlyMap<string, SkeletonCandidate>,
): DomainResult<ReadonlyMap<string, PathObservation>, Problems> {
  let realRoot: string;
  try {
    realRoot = resolveBaseDirectory(root);
  } catch (error) {
    return { ok: false, error: [`cannot resolve the repository root ${root}: ${errorMessage(error)}`] };
  }
  const observed = [...new Set(paths)].map((path) =>
    [path, observePath(realRoot, path, candidates.get(normalizePlanPath(path))?.skeleton.sha256 ?? null)] as const);
  const problems = observed.flatMap(([, result]) => (result.ok ? [] : [result.error]));
  if (isNonEmpty(problems)) return { ok: false, error: problems };
  return { ok: true, value: new Map(observed.flatMap(([path, result]) => (result.ok ? [[path, result.value] as const] : []))) };
}

const recordOf = (candidate: SkeletonCandidate, origin: SkeletonOrigin, engineSha256: string): SkeletonRecord =>
  Object.freeze({
    path: candidate.skeleton.path,
    contract: candidate.contract,
    language: candidate.skeleton.language,
    origin,
    engineSha256,
    typesSha256: candidate.typesSha256,
    stale: null,
  });

/** Carry out one action through the writer; the record it leaves, or why none. */
function perform(root: string, action: SkeletonAction, frozen: ReadonlySet<string>): DomainResult<SkeletonRecord, string> {
  const { candidate } = action;
  const { path, bytes, sha256 } = candidate.skeleton;
  if (action.kind === "adopt") return { ok: true, value: recordOf(candidate, "spawn", sha256) };
  const result: SkeletonWriteResult = action.kind === "create"
    ? createSkeleton(root, path, bytes, frozen)
    : refreshSkeleton(root, path, action.expectedSha256, bytes, frozen);
  if (result.kind !== "written") return { ok: false, error: renderSkeletonWriteResult(path, result) };
  return { ok: true, value: recordOf(candidate, action.kind === "create" ? "spawn" : action.origin, result.sha256) };
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
  const frozen = new Set((view.acceptance_contracts ?? []).flatMap((contract) => frozenPaths(contract)).map(normalizePlanPath));
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
