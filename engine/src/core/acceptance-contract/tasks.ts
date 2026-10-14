/**
 * What a contract derives from the TaskGraph's Tasks: its frozen paths, the
 * one Task that writes them, the claimants that complete its Requirements,
 * each Requirement's completion Wave, the red window, and the persisted form
 * population stamps.
 */

import { match } from "ts-pattern";
import type { DomainResult, NonEmpty } from "../orchestration-contract";
import { samePlanPath } from "../plan-path-match";
import { err, freeze, nonEmpty, ok } from "./kernel";
import type { AcceptanceContract, ContractTaskView, PlanContract } from "./model";

/** Every path the freeze covers: the types file (if any), then each acceptance file. */
export function frozenPaths(contract: Pick<AcceptanceContract, "types" | "acceptance">): NonEmpty<string> {
  const acceptance = contract.acceptance.map(({ path }) => path);
  return contract.types.kind === "file"
    ? Object.freeze([contract.types.path, ...acceptance])
    : Object.freeze([acceptance[0]!, ...acceptance.slice(1)]);
}

/** The Requirements the contract's acceptance files decide, in declaration order. */
export function coveredAnchors(contract: Pick<AcceptanceContract, "acceptance">): readonly string[] {
  return Object.freeze([...new Set(contract.acceptance.flatMap(({ anchors }) => anchors))]);
}

/** Why a contract's frozen paths do not have exactly one writer. */
export type ContractWriterProblem =
  | Readonly<{ kind: "unwritten"; path: string }>
  | Readonly<{ kind: "shared"; path: string; taskIds: NonEmpty<string> }>
  | Readonly<{ kind: "split"; taskIds: NonEmpty<string> }>;

/**
 * The contract Task: the one Task whose file_list holds every frozen path,
 * with no other Task listing any of them. The one owner of that rule — plan
 * validation renders its problems, population refuses on them.
 */
export function contractWriter(
  paths: NonEmpty<string>,
  tasks: readonly Pick<ContractTaskView, "id" | "file_list">[],
): DomainResult<string, NonEmpty<ContractWriterProblem>> {
  const writers = paths.map((path) => ({
    path,
    // Exact, not suffix-tolerant: the freeze hashes `root/path`, so the
    // writer must list that very path, not a deeper one that merely ends in it.
    ids: tasks.filter((task) => (task.file_list ?? []).some((file) => samePlanPath(file, path))).map(({ id }) => id),
  }));
  const problems: ContractWriterProblem[] = writers.flatMap(({ path, ids }): ContractWriterProblem[] => {
    const shared = nonEmpty(ids);
    if (shared === null) return [freeze({ kind: "unwritten", path })];
    return shared.length > 1 ? [freeze({ kind: "shared", path, taskIds: shared })] : [];
  });
  if (problems.length === 0) {
    const writerIds = nonEmpty([...new Set(writers.map(({ ids }) => ids[0]!))])!;
    if (writerIds.length === 1) return ok(writerIds[0]);
    problems.push(freeze({ kind: "split", taskIds: writerIds }));
  }
  return err(nonEmpty(problems)!);
}

/** One writer problem as the operator message plan validation and population
 *  both report. */
export function renderContractWriterProblem(problem: ContractWriterProblem): string {
  return match(problem)
    .with({ kind: "unwritten" }, ({ path }) => `'${path}' is in no task's file_list — decompose must emit the contract task that writes it`)
    .with({ kind: "shared" }, ({ path, taskIds }) =>
      `'${path}' is in the file_list of ${taskIds.join(" and ")} — a frozen path has exactly one writer, the contract task`)
    .with({ kind: "split" }, ({ taskIds }) =>
      `frozen paths are written by ${taskIds.join(" and ")} — one contract task writes the types file and every acceptance file`)
    .exhaustive();
}

/** Which of these anchors a Task claims, in its spec_anchors order; none for
 *  the contract Task, whose tests are red by design — the one claimant rule
 *  derivation, the contract role and plan-binding validation share. */
function claimedAnchors(
  contract: Pick<AcceptanceContract, "contractTask">,
  task: Pick<ContractTaskView, "id" | "spec_anchors">,
  anchors: readonly string[],
): readonly string[] {
  return task.id === contract.contractTask ? [] : (task.spec_anchors ?? []).filter((anchor) => anchors.includes(anchor));
}

/** Whether a Task other than the contract Task claims any of these anchors. */
export const claims = (
  contract: Pick<AcceptanceContract, "contractTask">,
  task: Pick<ContractTaskView, "id" | "spec_anchors">,
  anchors: readonly string[],
): boolean => claimedAnchors(contract, task, anchors).length > 0;

/** The Wave of a contract's contract Task; undefined when the Task is not in the roster. */
export function contractWave(
  contract: Pick<AcceptanceContract, "contractTask">,
  tasks: readonly ContractTaskView[],
): number | undefined {
  return tasks.find(({ id }) => id === contract.contractTask)?.wave;
}

/** The Tasks that claim any Requirement the contract covers, other than its contract Task. */
export function contractClaimants<T extends ContractTaskView>(
  contract: Pick<AcceptanceContract, "contractTask" | "acceptance">,
  tasks: readonly T[],
): readonly T[] {
  const covered = coveredAnchors(contract);
  return tasks.filter((task) => claims(contract, task, covered));
}

/** Each covered anchor's completion Wave; an anchor nobody claims is absent. */
export function dueWaves(contract: AcceptanceContract, tasks: readonly ContractTaskView[]): Readonly<Record<string, number>> {
  return freeze(Object.fromEntries(coveredAnchors(contract).flatMap((anchor) => {
    const waves = tasks.filter((task) => claims(contract, task, [anchor])).map(({ wave }) => wave);
    return waves.length === 0 ? [] : [[anchor, Math.max(...waves)] as const];
  })));
}

/**
 * Build each plan contract's persisted form. Plan-binding validation has
 * already refused every case this rejects; it stays total so population can
 * never persist a contract without its one contract Task.
 */
export function acceptanceContractsFromPlan(
  contracts: readonly PlanContract[],
  tasks: readonly ContractTaskView[],
): DomainResult<readonly AcceptanceContract[], readonly string[]> {
  const errors: string[] = [];
  const built = contracts.flatMap((planContract): AcceptanceContract[] => {
    const declaration = planContract.declaration;
    if (declaration.kind === "malformed") {
      errors.push(`${planContract.id}: the declaration is malformed`);
      return [];
    }
    const writer = contractWriter(frozenPaths(declaration), tasks);
    if (!writer.ok) {
      errors.push(...writer.error.map((problem) => `${planContract.id}: ${renderContractWriterProblem(problem)}`));
      return [];
    }
    return [freeze({
      schemaVersion: 1,
      id: planContract.id,
      title: planContract.title,
      statement: declaration.statement,
      contractTask: writer.value,
      types: declaration.types,
      acceptance: declaration.acceptance,
      supportedDomain: declaration.supportedDomain,
      freeze: freeze({ state: "awaiting-red" }),
      revisions: Object.freeze([]),
    })];
  });
  return errors.length > 0 ? err(Object.freeze(errors)) : ok(Object.freeze(built));
}

/**
 * Contracts are observed only through a Wave Gate test report, so a plan that
 * declares one needs a project check that writes a report; without one, RED
 * and GREEN would go unobserved and the contracts would be prose.
 */
export function acceptanceObservationProblem(
  contracts: readonly PlanContract[],
  projectChecks: readonly Readonly<{ reportPolicy: Readonly<{ kind: string }> }>[],
): string | null {
  if (contracts.length === 0 || projectChecks.some(({ reportPolicy }) => reportPolicy.kind === "required-file")) return null;
  return `The plan declares Contracts (${contracts.map(({ id }) => id).join(", ")}), whose RED and GREEN only a Wave Gate ` +
    "test report can observe. Install .loom/verification-manifest.json with a project check that writes a JUnit report " +
    "(\"report\": { \"kind\": \"required-file\", ... }) before populating the task graph.";
}

/** The Waves in which a contract's pending testcases fail a full-suite run:
 *  from its contract Wave through the last Wave completing one of its anchors.
 *  Null when its contract Task is not in the roster. */
function redWindow(contract: AcceptanceContract, tasks: readonly ContractTaskView[]): Readonly<{ start: number; end: number }> | null {
  const start = contractWave(contract, tasks);
  return start === undefined ? null : freeze({ start, end: Math.max(start, ...Object.values(dueWaves(contract, tasks))) });
}

const inWindow = (window: Readonly<{ start: number; end: number }> | null, task: ContractTaskView): boolean =>
  window !== null && task.wave >= window.start && task.wave <= window.end;

/** The Tasks whose full-suite run would see some contract's pending testcases fail. */
export function redWindowTaskIds(
  contracts: readonly AcceptanceContract[],
  tasks: readonly ContractTaskView[],
): ReadonlySet<string> {
  const windows = contracts.map((contract) => redWindow(contract, tasks));
  return new Set(tasks.filter((task) => windows.some((window) => inWindow(window, task))).map(({ id }) => id));
}

/** A Task's role in one Acceptance Contract — the one rule the implementation
 *  brief reads; redWindowTaskIds is its set-valued sibling for population. */
export type ContractRole =
  | Readonly<{ kind: "contract-task" }>
  | Readonly<{ kind: "claimant"; anchors: NonEmpty<string> }>
  | Readonly<{ kind: "red-window" }>
  | Readonly<{ kind: "none" }>;

/**
 * Which role a Task plays in a contract: the one Task writing its frozen
 * surface; a claimant completing some of its Requirements; a Task running
 * inside its red window, whose full-suite run sees pending testcases fail;
 * or none.
 */
export function contractRole(
  contract: AcceptanceContract,
  task: ContractTaskView,
  tasks: readonly ContractTaskView[],
): ContractRole {
  if (task.id === contract.contractTask) return freeze({ kind: "contract-task" });
  const anchors = nonEmpty(claimedAnchors(contract, task, coveredAnchors(contract)));
  if (anchors !== null) return freeze({ kind: "claimant", anchors });
  return inWindow(redWindow(contract, tasks), task) ? freeze({ kind: "red-window" }) : freeze({ kind: "none" });
}
