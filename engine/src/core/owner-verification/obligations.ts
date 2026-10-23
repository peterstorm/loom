/**
 * INV-3 owner: which owned Invariants a Wave or Task owes is decided here, and
 * only here (AD-2, AD-4). Pure: every function is a function of the plan's
 * parsed models or the TaskGraph's `owner_obligations` stamp and Task file
 * lists.
 *
 * - `obligationsFromPlan` derives the stamp population writes: one Owner
 *   Obligation per owned Invariant, in plan order, `[]` when none is owned.
 * - `obligationsDigest` / `obligationsAgree` are the stamp's identity: the
 *   gate re-derives the obligations from the plan and blocks on any drift.
 * - `waveChangedObligations` is the gate's scope: an obligation whose family
 *   (owner or a sibling, G5a's `changesFamily`) some Wave Task changes. A
 *   change to the matrix test alone does not trigger the checks.
 * - `obligationsTouchedBy` is the review-packet and brief scope: an
 *   obligation in which a file list plays any role, matrix test included.
 * - `ownerVerificationOwed` / `ownerCheckAuthority` read the stamp: an absent
 *   stamp (a graph populated before owner verification) owes nothing and has
 *   no owner check; a present one, `[]` included, always has the check.
 *
 * Roles are classified through `plan-paths.ts`, the one path rule plan
 * validation and the brief already share.
 */

import { match } from "ts-pattern";

import type { PlanModels, Task, TaskGraph } from "../../types";
import { canonicalDigest } from "../digest";
import { canonicalStructuralEquals, type ArtifactDigest } from "../orchestration-contract/identity";
import { changesFamily, invariantRoles, type InvariantRoles, type OwnedInvariant } from "../plan-paths";
import type { MutationPolicy, OwnerObligation } from "./types";

import type { OwnerCheckAuthority } from "../owner-check-authority";
export type { OwnerCheckAuthority } from "../owner-check-authority";

/** The Tasks a selection reads: only their file lists matter. */
type FileListed = Pick<Task, "file_list">;

/** The graph a stamp selection reads: its Tasks and the stamp. */
type StampedGraph = Pick<TaskGraph, "tasks" | "owner_obligations">;

const canonicalPolicy = (policy: MutationPolicy): MutationPolicy =>
  match(policy)
    .with({ kind: "verify" }, (): MutationPolicy => ({ kind: "verify" }))
    .with({ kind: "exempt" }, ({ reason }): MutationPolicy => ({ kind: "exempt", reason }))
    .exhaustive();

/** A fresh record in the one canonical key order, whatever order a stamp was read back in. */
const canonicalObligation = (obligation: OwnerObligation): OwnerObligation => ({
  invariant: obligation.invariant,
  title: obligation.title,
  statement: obligation.statement,
  owner: obligation.owner,
  siblings: obligation.siblings.map(({ path, note }) => ({ path, note })),
  matrixTest: obligation.matrixTest,
  mutation: canonicalPolicy(obligation.mutation),
});

/** One Owner Obligation per owned Invariant, in plan order; unowned and malformed ones owe nothing. */
export function obligationsFromPlan(models: PlanModels): readonly OwnerObligation[] {
  return models.invariants.flatMap(({ id, title, statement, ownership }) =>
    ownership.kind === "owned"
      ? [canonicalObligation({
          invariant: id,
          title,
          statement,
          owner: ownership.owner,
          siblings: ownership.siblings,
          matrixTest: ownership.matrixTest,
          mutation: ownership.mutation,
        })]
      : []);
}

/** The stamp's content identity: sha256 over its canonical JSON. */
export function obligationsDigest(obligations: readonly OwnerObligation[]): ArtifactDigest {
  return canonicalDigest(obligations.map(canonicalObligation));
}

/** Whether a stamp and the obligations re-derived from the plan are the same, in the same order. */
export function obligationsAgree(stamped: readonly OwnerObligation[], fromPlan: readonly OwnerObligation[]): boolean {
  return canonicalStructuralEquals(stamped.map(canonicalObligation), fromPlan.map(canonicalObligation));
}

const familyOf = (obligation: OwnerObligation): OwnedInvariant => ({
  kind: "owned",
  owner: obligation.owner,
  siblings: obligation.siblings,
  matrixTest: obligation.matrixTest,
  mutation: obligation.mutation,
});

const rolesIn = (fileList: readonly string[], obligation: OwnerObligation): InvariantRoles =>
  invariantRoles(fileList, familyOf(obligation));

/** The Wave scope: obligations whose owner or a sibling some Wave Task changes, in stamp order. */
export function waveChangedObligations(
  waveTasks: readonly FileListed[],
  obligations: readonly OwnerObligation[],
): readonly OwnerObligation[] {
  return obligations.filter((obligation) =>
    waveTasks.some(({ file_list }) => changesFamily(rolesIn(file_list ?? [], obligation))));
}

/** The touch scope: obligations in which the file list plays any role, matrix test included, in stamp order. */
export function obligationsTouchedBy(
  fileList: readonly string[],
  obligations: readonly OwnerObligation[],
): readonly OwnerObligation[] {
  return obligations.filter((obligation) => {
    const roles = rolesIn(fileList, obligation);
    return changesFamily(roles) || roles.matrixTest;
  });
}

/** The obligations the Wave owes coverage and mutation for; `[]` without a stamp. */
export function ownerVerificationOwed(graph: StampedGraph, wave: number): readonly OwnerObligation[] {
  const stamp = graph.owner_obligations;
  return stamp === undefined ? [] : waveChangedObligations(graph.tasks.filter((task) => task.wave === wave), stamp);
}

/**
 * The owner check the Wave's suite carries: `null` exactly when the graph has
 * no stamp; otherwise the stamp's digest and the owed ids, possibly none.
 */
export function ownerCheckAuthority(graph: StampedGraph, wave: number): OwnerCheckAuthority | null {
  const stamp = graph.owner_obligations;
  if (stamp === undefined) return null;
  return {
    obligationsDigest: obligationsDigest(stamp),
    owed: ownerVerificationOwed(graph, wave).map(({ invariant }) => invariant),
  };
}
