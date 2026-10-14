/**
 * Advisories that touch a contract's frozen paths before the Acceptance Freeze
 * stamps them.
 *
 * A contract freezes when its contract Wave's gate completes, after the
 * advisory decision. Until then a reviewer's advisory on a types or acceptance
 * file can still be fixed by re-dispatching the contract Task; once the gate
 * is approved it needs a Contract Revision. In the G1 live pilot the Wave 1
 * advisories on the contract's files were approved without anyone noticing
 * that approval froze them. This projection names exactly those advisories so
 * the operator sees the choice before making it.
 */

import type { FindingSeverity } from "../findings-shape";
import type { NonEmpty } from "../orchestration-contract";
import { samePlanPath } from "../plan-path-match";
import { freeze } from "./kernel";
import type { AcceptanceContract, ContractTaskView } from "./model";
import { contractWave, frozenPaths } from "./tasks";

/** The Finding fields this projection reads. */
export type FreezeNoticeFinding = Readonly<{ id: string; severity: FindingSeverity; file: string | null }>;

/** A Task as this projection reads it: its Wave and its current Findings. */
export type FreezeNoticeTask = ContractTaskView & Readonly<{ findings?: readonly FreezeNoticeFinding[] }>;

/** One advisory on a path the current Wave's gate will freeze. */
export type PendingFreezeAdvisory = Readonly<{
  contractId: string;
  taskId: string;
  findingId: string;
  path: string;
}>;

/**
 * Every advisory Finding of a current-Wave Task whose file is a frozen path of
 * a contract still `awaiting-red` whose contract Task runs in `wave`, in
 * contract then Task then Finding order. Pure and total.
 */
export function pendingFreezeAdvisories(
  contracts: readonly AcceptanceContract[],
  tasks: readonly FreezeNoticeTask[],
  wave: number,
): readonly PendingFreezeAdvisory[] {
  const waveTasks = tasks.filter((task) => task.wave === wave);
  return freeze(contracts
    .filter((contract) => contract.freeze.state === "awaiting-red" && contractWave(contract, tasks) === wave)
    .flatMap((contract) => {
      const paths = frozenPaths(contract);
      return waveTasks.flatMap((task) => (task.findings ?? []).flatMap(({ id, severity, file }): PendingFreezeAdvisory[] => {
        if (severity !== "advisory" || file === null) return [];
        const path = paths.find((frozen) => samePlanPath(frozen, file));
        return path === undefined ? [] : [freeze({ contractId: contract.id, taskId: task.id, findingId: id, path })];
      }));
    }));
}

/** The operator notice for a non-empty set: what approval does, and how to fix first. */
export function renderPendingFreezeAdvisories(advisories: NonEmpty<PendingFreezeAdvisory>): string {
  const listed = advisories.map(({ contractId, taskId, findingId, path }) => `${findingId} (${taskId}, ${contractId}: ${path})`);
  return `${advisories.length} advisory finding(s) touch files the Acceptance Freeze stamps when this Wave Gate completes: ` +
    `${listed.join("; ")}. Approving freezes them as they are, and changing them later needs a Contract Revision. ` +
    "To fix one first, abandon this run, re-dispatch the contract Task, and start a fresh Wave Gate.";
}
