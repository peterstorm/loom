/**
 * Plan-binding validation for contracts: does the decomposed Task graph bind
 * every declared contract the way the engine will hold it? One contract Task
 * writes every frozen path and nothing else writes any; the contract Task
 * claims none of the Requirements its red tests decide; every covered
 * Requirement is claimed, and every claimant waits for the contract Task; no
 * path is frozen by two contracts; and the contract new-test waiver is
 * admitted only on a claimant of a contract it depends on.
 */

import { match } from "ts-pattern";
import { normalizePlanPath } from "../plan-path-match";
import { dependsOnAny } from "../task-dependencies";
import { COVERED_BY_ACCEPTANCE_CONTRACT, type NewTestWaiverReason } from "../verification-policy";
import type { ContractProblem, PlanContract } from "./model";
import { claims, contractWriter, coveredAnchors, frozenPaths, renderContractWriterProblem } from "./tasks";

/** The Task fields contract binding reads, already narrowed from raw input. */
export type ContractBindingTask = Readonly<{
  id: string;
  file_list: readonly string[];
  spec_anchors: readonly string[];
  depends_on: readonly string[];
  /** The Task's authored new-test waiver reason, or null. */
  newTestWaiver: NewTestWaiverReason | null;
}>;

export function renderContractProblem(problem: ContractProblem): string {
  return match(problem)
    .with({ kind: "missing-types" }, () =>
      "no '**Types file:**' declared — name the new declarations-only file consumers import, or 'none' with a '**No types reason:**'")
    .with({ kind: "none-without-reason" }, () => "'**Types file:** none' needs a '**No types reason:**'")
    .with({ kind: "reason-with-types-file" }, () => "declares both a types file and a '**No types reason:**' — keep one")
    .with({ kind: "missing-acceptance" }, () =>
      "no '**Acceptance tests:**' listed — a contract freezes at least one '- path — AS-n' acceptance file")
    .with({ kind: "malformed-acceptance" }, ({ line }) => `acceptance line '${line}' is not '- path — FR-n, AS-n'`)
    .with({ kind: "invalid-anchor" }, ({ path, anchor }) =>
      `'${path}' names '${anchor}', which a test cannot decide — list only FR-n and AS-n Requirements`)
    .with({ kind: "duplicate-acceptance" }, ({ path }) => `'${path}' is listed twice under '**Acceptance tests:**'`)
    .with({ kind: "duplicate-anchor" }, ({ path, anchor }) => `'${path}' names '${anchor}' twice — list each Requirement once per file`)
    .with({ kind: "supported-domain-not-acceptance" }, ({ path }) =>
      `'**Supported domain:** ${path}' is not one of the acceptance files`)
    .with({ kind: "unsafe-path" }, ({ path }) =>
      `'${path}' is not a repository-relative path — a frozen path may not be absolute or contain '..'`)
    .with({ kind: "missing-statement" }, () => "no '**Statement:**' — say what consumers rely on and what is refused")
    .exhaustive();
}

/** Every way the Tasks fail to bind the plan's contracts, as operator messages. */
export function contractBindingErrors(
  contracts: readonly PlanContract[],
  tasks: readonly ContractBindingTask[],
): readonly string[] {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const waitsFor = (task: ContractBindingTask, contractTask: string): boolean =>
    dependsOnAny(task.depends_on, new Set([contractTask]), (id) => byId.get(id)?.depends_on ?? []);
  const errors: string[] = [];
  const frozenBy = new Map<string, string>();
  const resolved: Readonly<{ contractTask: string; covered: readonly string[] }>[] = [];
  for (const contract of contracts) {
    const label = `${contract.id} ("${contract.title}")`;
    const declaration = contract.declaration;
    if (declaration.kind === "malformed") {
      errors.push(...declaration.problems.map((problem) => `${label}: ${renderContractProblem(problem)}`));
      continue;
    }
    const paths = frozenPaths(declaration);
    for (const path of paths) {
      const key = normalizePlanPath(path);
      const earlier = frozenBy.get(key);
      if (earlier === undefined) frozenBy.set(key, contract.id);
      else errors.push(`${label}: '${key}' is frozen by ${earlier} and ${contract.id} — a frozen path belongs to one contract`);
    }
    const writer = contractWriter(paths, tasks);
    if (!writer.ok) {
      errors.push(...writer.error.map((problem) => `${label}: ${renderContractWriterProblem(problem)}`));
      continue;
    }
    const contractTask = writer.value;
    const covered = coveredAnchors(declaration);
    resolved.push({ contractTask, covered });
    const writes = byId.get(contractTask)!;
    for (const anchor of covered) {
      if (writes.spec_anchors.includes(anchor)) {
        errors.push(`${label}: ${contractTask} is ${contract.id}'s contract task but claims ${anchor} in spec_anchors — its tests ` +
          "are red by design; list it in spec_contributions and let the task that turns it green claim it");
      }
      const claimants = tasks.filter((task) => claims({ contractTask }, task, [anchor]));
      if (claimants.length === 0) {
        errors.push(`${label}: ${anchor} is decided by ${contract.id}'s acceptance tests but no task claims it in spec_anchors — nothing would turn it green`);
      }
      for (const claimant of claimants) {
        if (!waitsFor(claimant, contractTask)) {
          errors.push(`${label}: ${claimant.id} claims ${anchor}, which ${contract.id} covers, but does not depend on its ` +
            `contract task ${contractTask}, directly or transitively`);
        }
      }
    }
  }
  for (const task of tasks.filter(({ newTestWaiver }) => newTestWaiver === COVERED_BY_ACCEPTANCE_CONTRACT)) {
    const covering = resolved.some(({ contractTask, covered }) =>
      task.spec_anchors.some((anchor) => covered.includes(anchor)) && waitsFor(task, contractTask));
    if (!covering) {
      errors.push(`${task.id} waives new tests as ${COVERED_BY_ACCEPTANCE_CONTRACT} but claims no Requirement a contract it depends on covers`);
    }
  }
  return Object.freeze(errors);
}
