/**
 * Contract stubs at the contract Task's stop (AD-9, FR-023). Both stop shells
 * — Claude Code's SubagentStop dispatcher and Pi's `pi/subagent-stop.ts` —
 * call this before their stop checks and before settlement, so the stubs the
 * contract's acceptance tests import exist when those tests first run, and
 * the contract Task's agent never writes them.
 *
 * For each Acceptance Contract whose contract Task is the stopping Task
 * (`contractRole` `contract-task`) and that freezes a types file with bindings:
 *
 * 1. **Read.** The contract's current, not-yet-frozen types file is observed
 *    (`observeFrozenSurface`, `current`) and every binding of the contract is
 *    resolved against it, one binding at a time, so one vanished alias never
 *    keeps the others' stubs from being written.
 * 2. **Generate.** Each resolved binding whose path `skeletonLanguageOf`
 *    (INV-6) parses to a target of the types file's language gets its
 *    canonical skeleton bytes, the same bytes registration writes (US3, US4).
 * 3. **Plan.** `planContractStubs` decides, through `isUntouchedSkeleton`
 *    (INV-4), what each path needs: create a missing stub, adopt canonical
 *    bytes already there, or refresh an untouched stub whose canonical bytes
 *    changed after a stop-check block and further edits. A file anyone else
 *    wrote is never touched.
 * 4. **Write** through the no-clobber writer (INV-3), then record each stub
 *    as an origin `contract-stub` skeleton under the State File lock.
 *
 * A binding that does not resolve writes no stub: its problem is returned for
 * the stop's output, and the contract gate then sees an uncollected
 * acceptance file, a non-behavioral RED. Freeze semantics are unchanged: the
 * stubs are no frozen path, and at their owning Wave they are skeletons like
 * any other (AS-044). Expected failures are values; an infrastructure failure
 * is the error string.
 *
 * The generation and observation steps are shared with the Contract
 * Revision's refresh (AD-10, `handlers/helpers/revise-contract.ts`).
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { observeTaskGraphProjectBoundary } from "../config";
import { contractRole, frozenPaths } from "../core/acceptance-contract";
import { installSkeletonRecords, type SkeletonProblem } from "../core/contract-revision";
import { sha256Bytes } from "../core/digest";
import { canonicalStructuralEquals, type DomainResult } from "../core/orchestration-contract";
import { normalizePlanPath, samePlanPath } from "../core/plan-path-match";
import { generateSkeleton } from "../core/skeleton/generate";
import { skeletonLanguageOf } from "../core/skeleton/language";
import { isUntouchedSkeleton } from "../core/skeleton/outcomes";
import { resolveBindings } from "../core/skeleton/resolve";
import type { SkeletonGraph } from "../core/skeleton/scope";
import type {
  ExportBinding,
  FrozenSurface,
  GeneratedSkeleton,
  PathObservation,
  ResolvedBinding,
  SkeletonOrigin,
  SkeletonRecord,
  SpecifierStyle,
} from "../core/skeleton/types";
import type { TaskGraph } from "../types";
import { observeFrozenSurface, observeSpecifierStyle, typedContract, type TypedContract } from "./frozen-surface-observation";
import { readRunBytesNoFollow, resolveBaseDirectory } from "./no-follow-fs";
import { renderResolutionProblem, type SkeletonCandidate } from "./skeleton-materialization";
import { createSkeleton, refreshSkeleton, type SkeletonWriteResult } from "./skeleton-writer";

// ---------------------------------------------------------------------------
// Ports and results
// ---------------------------------------------------------------------------

/** The State File as the stub step uses it: load, and one locked update. */
export type SkeletonRecordStore = Readonly<{
  load(): TaskGraph;
  updateAndReturn<T>(fn: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>): Promise<T>;
}>;

/** The stop shells' store: the record store, and the State File path that names the repository. */
export type ContractStubStore = SkeletonRecordStore & Readonly<{ getPath(): string }>;

/** What one stop did: the records it wrote or changed, and every binding it could not stub. */
export type ContractStubs = Readonly<{ written: readonly SkeletonRecord[]; problems: readonly SkeletonProblem[] }>;

const NOTHING: ContractStubs = Object.freeze({ written: Object.freeze([]), problems: Object.freeze([]) });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** The typed contracts with bindings whose contract Task is `taskId`: the ones its stop stubs. */
export function stubbedContracts(graph: TaskGraph, taskId: string): readonly TypedContract[] {
  const view: SkeletonGraph = graph;
  const task = view.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return Object.freeze([]);
  const bindings = view.export_bindings ?? [];
  return Object.freeze((view.acceptance_contracts ?? []).flatMap((contract) => {
    const typed = typedContract(contract);
    return typed !== null &&
      contractRole(contract, task, view.tasks).kind === "contract-task" &&
      bindings.some((binding) => binding.contract === contract.id)
      ? [typed]
      : [];
  }));
}

/** Every path an Acceptance Freeze covers or will cover: the writer never writes one. */
export const frozenSkeletonPaths = (graph: TaskGraph): ReadonlySet<string> =>
  new Set((graph.acceptance_contracts ?? []).flatMap((contract) => frozenPaths(contract)).map(normalizePlanPath));

/** What the stop does at one stub path. */
export type ContractStubAction =
  | Readonly<{ kind: "create"; skeleton: GeneratedSkeleton }>
  | Readonly<{ kind: "adopt"; skeleton: GeneratedSkeleton }>
  | Readonly<{ kind: "refresh"; skeleton: GeneratedSkeleton; expectedSha256: string }>;

const ABSENT: PathObservation = Object.freeze({ kind: "absent" });

/**
 * The action each canonical stub needs, in the order given. An absent path is
 * created. A present file is acted on only when `isUntouchedSkeleton` says the
 * bytes are the engine's: adopted when they already are the canonical bytes,
 * else refreshed from the engine bytes it holds. Anything else is left alone.
 */
export function planContractStubs(
  records: readonly SkeletonRecord[],
  observations: ReadonlyMap<string, PathObservation>,
  skeletons: readonly GeneratedSkeleton[],
): readonly ContractStubAction[] {
  return Object.freeze(skeletons.flatMap((skeleton): readonly ContractStubAction[] => {
    const observation = observations.get(skeleton.path) ?? ABSENT;
    if (observation.kind === "absent") return [{ kind: "create", skeleton }];
    const record = records.find((recorded) => samePlanPath(recorded.path, skeleton.path));
    if (!isUntouchedSkeleton(record, observation.sha256, skeleton.sha256)) return [];
    return observation.sha256 === skeleton.sha256
      ? [{ kind: "adopt", skeleton }]
      : [{ kind: "refresh", skeleton, expectedSha256: observation.sha256 }];
  }));
}

/** The record of one canonical skeleton the engine wrote, adopted or refreshed. */
export const skeletonRecordOf = (candidate: SkeletonCandidate, origin: SkeletonOrigin): SkeletonRecord =>
  Object.freeze({
    path: candidate.skeleton.path,
    contract: candidate.contract,
    language: candidate.skeleton.language,
    origin,
    engineSha256: candidate.skeleton.sha256,
    typesSha256: candidate.typesSha256,
    stale: null,
  });

/** The canonical skeleton of one resolved binding, nothing for an unsupported
 *  path, or the language mismatch that keeps it from being generated. */
function generated(
  surface: FrozenSurface,
  binding: ResolvedBinding,
  specifierStyle: SpecifierStyle | null,
): DomainResult<GeneratedSkeleton | null, SkeletonProblem> {
  const target = skeletonLanguageOf(binding.path);
  if (target.kind === "unsupported") return { ok: true, value: null };
  const { contract, exports } = binding;
  if (target.language === "typescript" && surface.language === "typescript") {
    return { ok: true, value: generateSkeleton({ language: "typescript", target, surface, contract, exports, specifierStyle }) };
  }
  if (target.language === "java" && surface.language === "java") {
    return { ok: true, value: generateSkeleton({ language: "java", target, surface, contract, exports }) };
  }
  return { ok: false, error: Object.freeze({ kind: "language-mismatch", path: binding.path, contract, typesFile: surface.path }) };
}

/** One line naming why the engine could not (re)write a skeleton. */
export const renderSkeletonProblem = (problem: SkeletonProblem): string =>
  match(problem)
    .with({ kind: "language-mismatch" }, ({ path, contract, typesFile }) =>
      `${path} binds ${contract}, whose types file ${typesFile} is in another language`)
    .with({ kind: "write-failed" }, ({ path, detail }) => `${path}: ${detail}`)
    .otherwise(renderResolutionProblem);

/** What the stop says: nothing when every stub resolved, else one line per problem. */
export function renderContractStubs(taskId: string, result: DomainResult<ContractStubs, string>): string | null {
  if (!result.ok) return `contract stubs of ${taskId}: the engine could not write them (${result.error})`;
  if (result.value.problems.length === 0) return null;
  return [
    `contract stubs of ${taskId}: not every stub could be written; its acceptance tests cannot import what is missing`,
    ...result.value.problems.map((problem) => `- ${renderSkeletonProblem(problem)}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Shell steps shared with the Contract Revision refresh
// ---------------------------------------------------------------------------

/** A contract's canonical skeletons from its current types file, and every
 *  binding that has none. */
export type ContractCanonicalSkeletons = Readonly<{
  candidates: readonly SkeletonCandidate[];
  problems: readonly SkeletonProblem[];
}>;

/**
 * Read the contract's types file as it is now and generate the canonical
 * skeleton of each of `bindings`. Each binding is resolved on its own, so the
 * problems of one never hide another's skeleton. An unreadable or
 * unparseable types file is the one problem, with no skeleton; failing to
 * read the acceptance files for the specifier style is an infrastructure error.
 */
export function canonicalContractSkeletons(
  root: string,
  contract: TypedContract,
  bindings: readonly ExportBinding[],
): DomainResult<ContractCanonicalSkeletons, string> {
  const surface = observeFrozenSurface(root, contract, "current");
  if (!surface.ok) return { ok: true, value: Object.freeze({ candidates: Object.freeze([]), problems: Object.freeze([surface.error]) }) };
  const style = surface.value.language === "typescript" ? observeSpecifierStyle(root, contract) : { ok: true as const, value: null };
  if (!style.ok) return style;
  const resolutions = bindings.map((binding) => resolveBindings(surface.value, [binding]));
  const generations = resolutions.flatMap((resolution) => (resolution.ok ? resolution.value : []))
    .map((binding) => generated(surface.value, binding, style.value));
  const { typesSha256 } = surface.value;
  return {
    ok: true,
    value: Object.freeze({
      candidates: Object.freeze(generations.flatMap((generation) => (generation.ok && generation.value !== null
        ? [Object.freeze({ skeleton: generation.value, contract: contract.id, typesSha256 })]
        : []))),
      problems: Object.freeze([
        ...resolutions.flatMap((resolution) => (resolution.ok ? [] : resolution.error)),
        ...generations.flatMap((generation) => (generation.ok ? [] : [generation.error])),
      ]),
    }),
  };
}

/** The observed paths, and a problem for each one that cannot be read without following a link. */
export type ObservedSkeletonPaths = Readonly<{
  observations: ReadonlyMap<string, PathObservation>;
  problems: readonly SkeletonProblem[];
}>;

/**
 * What is at each path now. A missing path is absent. A link or directory is
 * present with no content digest (the empty string, which equals no digest),
 * so it is never judged untouched and never written over. A regular file is
 * present with the digest of its bytes, read without following any link; one
 * that cannot be read so is a problem, and is left out of the observations.
 * `canonicalSha256` is each path's canonical digest, when it has one.
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
    return { ok: false, error: `cannot resolve the repository root ${root}: ${errorMessage(error)}` };
  }
  const observed = paths.map((path): readonly [string, DomainResult<PathObservation, SkeletonProblem>] => {
    const absolute = join(realRoot, path);
    const unreadable = (error: unknown): DomainResult<PathObservation, SkeletonProblem> =>
      ({ ok: false, error: Object.freeze({ kind: "write-failed", path, detail: `cannot read it without following a link (${errorMessage(error)})` }) });
    const present = (sha256: string): DomainResult<PathObservation, SkeletonProblem> =>
      ({ ok: true, value: Object.freeze({ kind: "present", sha256, canonicalSha256: canonicalSha256(path) }) });
    try {
      if (!lstatSync(absolute).isFile()) return [path, present("")];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return [path, code === "ENOENT" || code === "ENOTDIR" ? { ok: true, value: ABSENT } : unreadable(error)];
    }
    try {
      return [path, present(sha256Bytes(readRunBytesNoFollow(absolute)))];
    } catch (error) {
      return [path, unreadable(error)];
    }
  });
  return {
    ok: true,
    value: Object.freeze({
      observations: new Map(observed.flatMap(([path, result]) => (result.ok ? [[path, result.value] as const] : []))),
      problems: Object.freeze(observed.flatMap(([, result]) => (result.ok ? [] : [result.error]))),
    }),
  };
}

/** Why a write did not land, as the detail of a `write-failed` problem. */
export function writeFailure(path: string, result: Exclude<SkeletonWriteResult, { kind: "written" }>): SkeletonProblem {
  const detail = match(result)
    .with({ kind: "exists" }, () => "a file appeared there meanwhile; it was left untouched")
    .with({ kind: "refused" }, ({ reason }) => `refused (${reason})`)
    .with({ kind: "io-failed" }, ({ message }) => `write failed (${message})`)
    .exhaustive();
  return Object.freeze({ kind: "write-failed", path, detail });
}

// ---------------------------------------------------------------------------
// Shell: the contract stop
// ---------------------------------------------------------------------------

/** Carry out one stub action through the writer: the record it leaves, or why none. */
function perform(root: string, action: ContractStubAction, candidate: SkeletonCandidate, frozen: ReadonlySet<string>): DomainResult<SkeletonRecord, SkeletonProblem> {
  const { path, bytes } = action.skeleton;
  if (action.kind === "adopt") return { ok: true, value: skeletonRecordOf(candidate, "contract-stub") };
  const result = action.kind === "create"
    ? createSkeleton(root, path, bytes, frozen)
    : refreshSkeleton(root, path, action.expectedSha256, bytes, frozen);
  return result.kind === "written"
    ? { ok: true, value: skeletonRecordOf(candidate, "contract-stub") }
    : { ok: false, error: writeFailure(path, result) };
}

/** Read, generate, plan and write one contract's stubs. */
function stubContract(
  root: string,
  graph: SkeletonGraph,
  contract: TypedContract,
  frozen: ReadonlySet<string>,
): DomainResult<ContractStubs, string> {
  const bindings = (graph.export_bindings ?? []).filter((binding) => binding.contract === contract.id);
  const canonical = canonicalContractSkeletons(root, contract, bindings);
  if (!canonical.ok) return canonical;
  const { candidates } = canonical.value;
  const byPath = new Map(candidates.map((candidate) => [candidate.skeleton.path, candidate] as const));
  const observed = observeSkeletonPaths(root, [...byPath.keys()], (path) => byPath.get(path)?.skeleton.sha256 ?? null);
  if (!observed.ok) return observed;
  const observable = candidates.map(({ skeleton }) => skeleton).filter(({ path }) => observed.value.observations.has(path));
  const performed = planContractStubs(graph.skeletons ?? [], observed.value.observations, observable).flatMap((action) => {
    const candidate = byPath.get(action.skeleton.path);
    return candidate === undefined ? [] : [perform(root, action, candidate, frozen)];
  });
  return {
    ok: true,
    value: Object.freeze({
      written: Object.freeze(performed.flatMap((result) => (result.ok ? [result.value] : []))),
      problems: Object.freeze([
        ...canonical.value.problems,
        ...observed.value.problems,
        ...performed.flatMap((result) => (result.ok ? [] : [result.error])),
      ]),
    }),
  };
}

/**
 * Write and record the stubs of every contract `taskId` is the contract Task
 * of. `written` lists only records that changed: a second stop over the same
 * bytes writes and records nothing.
 */
export async function materializeContractStubs(
  root: string,
  store: SkeletonRecordStore,
  taskId: string,
): Promise<DomainResult<ContractStubs, string>> {
  let graph: SkeletonGraph;
  try {
    graph = store.load();
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  const contracts = stubbedContracts(graph, taskId);
  if (contracts.length === 0) return { ok: true, value: NOTHING };
  const frozen = frozenSkeletonPaths(graph);
  const stubbed = contracts.map((contract) => stubContract(root, graph, contract, frozen));
  const failed = stubbed.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) return failed;
  const recorded = graph.skeletons ?? [];
  const written = stubbed.flatMap((result) => (result.ok ? result.value.written : []))
    .filter((record) => !recorded.some((existing) => canonicalStructuralEquals(existing, record)));
  const problems = stubbed.flatMap((result) => (result.ok ? result.value.problems : []));
  if (written.length > 0) {
    try {
      await store.updateAndReturn((current) => {
        const view: SkeletonGraph = current;
        const next: SkeletonGraph = { ...current, skeletons: installSkeletonRecords(view.skeletons ?? [], written) };
        return { state: next, value: null };
      });
    } catch (error) {
      return { ok: false, error: `the stubs were written, but their records were not: ${errorMessage(error)}` };
    }
  }
  return { ok: true, value: Object.freeze({ written: Object.freeze(written), problems: Object.freeze(problems) }) };
}

/**
 * The contract stop step as both stop shells run it: total, it never throws.
 * Nothing (and no repository probe) for a Task that stubs no contract; else
 * the stubs are written and recorded, and what the stop must say about them
 * is returned, or null when there is nothing to say.
 */
export async function contractStubStopNote(store: ContractStubStore, taskId: string): Promise<string | null> {
  try {
    if (stubbedContracts(store.load(), taskId).length === 0) return null;
    const { root } = observeTaskGraphProjectBoundary(store.getPath());
    return renderContractStubs(taskId, await materializeContractStubs(root, store, taskId));
  } catch (error) {
    return renderContractStubs(taskId, { ok: false, error: errorMessage(error) });
  }
}
