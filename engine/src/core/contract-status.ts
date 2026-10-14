/**
 * Contract Status (CT-1): what each Acceptance Contract has frozen, which
 * Requirement it covers is due in which Wave, and whether a Contract Revision
 * happened — projected from a parsed TaskGraph, then rendered as lines.
 *
 * Two pure steps (AD-1): `contractStatusView` derives the view ADT from the
 * frozen surface in `contract-status-types.ts`; `renderContractStatus`
 * formats it. Both are total over every graph the State File parser admits:
 * no filesystem, no clock, no throw. The due-Wave rule is `dueWaves`, owned by
 * the acceptance-contract module and never re-derived here.
 */

import { match } from "ts-pattern";
import { coveredAnchors, dueWaves, type AcceptanceContract, type ContractTaskView } from "./acceptance-contract";
import {
  NO_ACCEPTANCE_CONTRACTS,
  type AnchorDue,
  type ContractFreezeStatus,
  type ContractStatusView,
  type ContractStatusViewFn,
  type CoveredAnchorStatus,
  type RenderContractStatusFn,
} from "./contract-status-types";

/** The freeze as the operator reads it; a revised freeze carries the revision
 *  count because its roster is cleared until the next Wave Gate. */
function freezeStatus(contract: AcceptanceContract): ContractFreezeStatus {
  return match(contract.freeze)
    .with({ state: "awaiting-red" }, (): ContractFreezeStatus => Object.freeze({ state: "awaiting-red" }))
    .with({ state: "frozen" }, ({ wave, roster }): ContractFreezeStatus => Object.freeze({ state: "frozen", wave, roster }))
    .with({ state: "revised" }, ({ paths }): ContractFreezeStatus =>
      Object.freeze({ state: "revised", revisions: contract.revisions.length, paths }))
    .exhaustive();
}

/** Each covered anchor in `coveredAnchors()` order, with its due Wave, or
 *  unclaimed when no Task other than the contract Task claims it. */
function coveredStatus(contract: AcceptanceContract, tasks: readonly ContractTaskView[]): readonly CoveredAnchorStatus[] {
  const waves = dueWaves(contract, tasks);
  return Object.freeze(coveredAnchors(contract).map((anchor): CoveredAnchorStatus => {
    const wave = Object.hasOwn(waves, anchor) ? waves[anchor] : undefined;
    const due: AnchorDue = wave === undefined ? { kind: "unclaimed" } : { kind: "wave", wave };
    return Object.freeze({ anchor, due: Object.freeze(due) });
  }));
}

export const contractStatusView: ContractStatusViewFn = (graph) =>
  Object.freeze((graph.acceptance_contracts ?? []).map((contract): ContractStatusView => Object.freeze({
    id: contract.id,
    title: contract.title,
    contractTask: contract.contractTask,
    freeze: freezeStatus(contract),
    covered: coveredStatus(contract, graph.tasks),
    revisions: contract.revisions.length,
  })));

const revisionCount = (count: number): string => `${count} ${count === 1 ? "revision" : "revisions"}`;

function freezeLines(freeze: ContractFreezeStatus): readonly string[] {
  return match(freeze)
    .with({ state: "awaiting-red" }, () => ["awaiting RED"])
    .with({ state: "frozen" }, ({ wave, roster }) => [
      `frozen at Wave ${wave}`,
      ...roster.map(({ file, name, anchors }) => `${file} › ${name} — ${anchors.join(", ")}`),
    ])
    .with({ state: "revised" }, ({ revisions, paths }) => [
      `revised (${revisionCount(revisions)}); roster cleared until the next Wave Gate re-records it`,
      ...paths.map(({ path }) => path),
    ])
    .exhaustive();
}

const coveredLine = ({ anchor, due }: CoveredAnchorStatus): string =>
  match(due)
    .with({ kind: "wave" }, ({ wave }) => `${anchor} due Wave ${wave}`)
    .with({ kind: "unclaimed" }, () => `${anchor} unclaimed`)
    .exhaustive();

function contractLines(view: ContractStatusView): readonly string[] {
  return [
    `${view.id}  ${view.title}  (contract Task ${view.contractTask})`,
    ...freezeLines(view.freeze),
    ...view.covered.map(coveredLine),
    ...(view.revisions > 0 ? [`revisions: ${view.revisions}`] : []),
  ];
}

export const renderContractStatus: RenderContractStatusFn = (graph) => {
  const views = contractStatusView(graph);
  return Object.freeze(views.length === 0 ? [NO_ACCEPTANCE_CONTRACTS] : views.flatMap(contractLines));
};
