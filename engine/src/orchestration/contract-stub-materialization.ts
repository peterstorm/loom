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
 *    and every binding of the contract is resolved against it, one binding at
 *    a time, so one vanished alias never keeps the others' stubs from being
 *    written (`canonicalContractSkeletons`).
 * 2. **Generate.** Each resolved binding whose path `skeletonLanguageOf`
 *    (INV-6) parses to a target of the types file's language gets its
 *    canonical skeleton bytes, the same bytes registration writes (US3, US4).
 * 3. **Plan.** `planSkeletonRefresh` (`candidate-driven`) decides, through
 *    `presentSkeletonOf` (INV-4), what each path needs: create a missing
 *    stub, adopt canonical bytes already there, or refresh an untouched stub
 *    whose canonical bytes changed after a stop-check block and further
 *    edits. A file anyone else wrote is never touched.
 * 4. **Write** through the no-clobber writer (INV-3), then record each stub
 *    as an origin `contract-stub` skeleton under the State File lock.
 *
 * A binding that does not resolve writes no stub: its problem is returned for
 * the stop's output, and the contract gate then sees an uncollected
 * acceptance file, a non-behavioral RED. Freeze semantics are unchanged: the
 * stubs are no frozen path, and at their owning Wave they are skeletons like
 * any other (AS-044). Expected failures are values; an infrastructure failure
 * is the error string.
 */

import { observeTaskGraphProjectBoundary } from "../config";
import { contractRole } from "../core/acceptance-contract";
import { canonicalStructuralEquals, type DomainResult } from "../core/orchestration-contract";
import type { SkeletonGraph } from "../core/skeleton/graph-view";
import { renderSkeletonProblem, type SkeletonProblem } from "../core/skeleton/problems";
import { installSkeletonRecords } from "../core/skeleton/records";
import { planSkeletonRefresh } from "../core/skeleton/refresh-plan";
import type { SkeletonRecord } from "../core/skeleton/types";
import type { TaskGraph } from "../types";
import { typedContract, type TypedContract } from "./frozen-surface-observation";
import { observeSkeletonPaths } from "./skeleton-observation";
import { canonicalContractSkeletons, frozenSkeletonPaths, writeFailure, writePlanned } from "./skeleton-refresh";

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
// Shell: the contract stop
// ---------------------------------------------------------------------------

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
  // A path that could not be read is already a problem: nothing is planned for it.
  const observable = candidates.filter(({ skeleton }) => observed.value.observations.has(skeleton.path));
  const performed = planSkeletonRefresh("candidate-driven", graph.skeletons ?? [], observed.value.observations, observable)
    .map((action): DomainResult<SkeletonRecord, SkeletonProblem> => {
      const written = writePlanned(root, action, "contract-stub", frozen);
      return written.kind === "recorded"
        ? { ok: true, value: written.record }
        : { ok: false, error: writeFailure(action.candidate.skeleton.path, written.result) };
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
