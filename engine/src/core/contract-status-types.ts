/**
 * The frozen surface of `helper contract-status` (Acceptance Contract CT-1):
 * the view a TaskGraph projects into, and the signatures of the pure
 * projection and renderer. Declarations only — its bytes freeze at the
 * contract Wave's gate, so no logic lives here.
 */

import type { AcceptanceTestcase, FrozenPathDigest } from "./acceptance-contract";
import type { TaskGraph } from "../types";

/** When a covered anchor is due: the latest Wave of a Task that claims it, or
 *  unclaimed when no Task other than the contract Task claims it. */
export type AnchorDue =
  | Readonly<{ kind: "wave"; wave: number }>
  | Readonly<{ kind: "unclaimed" }>;

/** One Requirement a contract's acceptance files decide, with its due Wave. */
export type CoveredAnchorStatus = Readonly<{ anchor: string; due: AnchorDue }>;

/**
 * The Acceptance Freeze as the operator reads it. `frozen` names its Wave and
 * the roster observed red; `revised` carries no roster (a Contract Revision
 * clears it until the next Wave Gate re-records it), only the re-stamped
 * paths. The revision count lives once, on the view.
 */
export type ContractFreezeStatus =
  | Readonly<{ state: "awaiting-red" }>
  | Readonly<{ state: "frozen"; wave: number; roster: readonly AcceptanceTestcase[] }>
  | Readonly<{ state: "revised"; paths: readonly FrozenPathDigest[] }>;

/** One Acceptance Contract's status, in TaskGraph order. `revisions` is the
 *  number of recorded Contract Revisions, the one source for every count the
 *  renderer prints. */
export type ContractStatusView = Readonly<{
  id: string;
  title: string;
  contractTask: string;
  freeze: ContractFreezeStatus;
  /** In `coveredAnchors()` order. */
  covered: readonly CoveredAnchorStatus[];
  revisions: number;
}>;

/** Project a TaskGraph into its contract status views. Pure and total. */
export type ContractStatusViewFn = (graph: TaskGraph) => readonly ContractStatusView[];

/** Render a TaskGraph's contract status as output lines. Pure and total. */
export type RenderContractStatusFn = (graph: TaskGraph) => readonly string[];

/** The single line a TaskGraph without Acceptance Contracts renders. */
export const NO_ACCEPTANCE_CONTRACTS = "no Acceptance Contracts";
