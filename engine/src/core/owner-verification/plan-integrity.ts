/**
 * Whether the plan the gate re-reads still proves the TaskGraph's
 * `owner_obligations` stamp (FR-002, ADR-0032). Pure: the shell reads the
 * plan file and parses it with `parsePlanModels`; this module decides.
 *
 * Strays and malformed ownership block (a typo is never an opt-out); any
 * difference between the obligations the plan re-derives and the stamp, an
 * absent stamp included, is drift.
 */

import { match } from "ts-pattern";

import type { PlanModels } from "../../types";
import { renderStray } from "../parse-plan-models";
import { renderObligationsError, stampAgreement, type OwnerScope } from "./obligations";
import type { OwnerInfrastructureFailure } from "./types";

/** Why the plan's models do not prove the stamp, or null when they re-derive it exactly. */
export function planModelsIntegrityFailure(
  planPath: string,
  models: PlanModels,
  scope: OwnerScope,
): OwnerInfrastructureFailure | null {
  const problems = [
    ...models.strays.map(renderStray),
    ...models.invariants.flatMap(({ id, ownership }) => ownership.kind === "malformed"
      ? [`${id}: ${ownership.problems.map((problem) => problem.kind).join(", ")}`]
      : []),
  ];
  if (problems.length > 0) {
    return { kind: "plan-malformed", detail: `plan ${planPath} declares malformed models: ${problems.join("; ")}` };
  }
  const drift: OwnerInfrastructureFailure = {
    kind: "plan-drift",
    detail: `plan ${planPath} no longer derives the owner_obligations stamped at population; ` +
      "restore the plan's owned Invariants, or re-populate the TaskGraph from the plan",
  };
  return match(stampAgreement(scope, models))
    .with({ kind: "agrees" }, () => null)
    .with({ kind: "drifted" }, { kind: "unstamped" }, () => drift)
    .with({ kind: "underivable" }, ({ error }): OwnerInfrastructureFailure => ({
      kind: "plan-malformed",
      detail: `plan ${planPath} declares owned Invariants that derive no Owner Obligation: ${renderObligationsError(error)}`,
    }))
    .exhaustive();
}
