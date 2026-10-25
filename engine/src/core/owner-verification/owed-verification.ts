/**
 * What one owner check runs, decided purely before anything runs (AD-1, AD-8;
 * FR-002, FR-008, AS-004, AS-005). The gate shell reads the plan and hands
 * this leaf the facts; the runner shell executes what it returns:
 *
 * - `ownerObservationDecision` is the gate's decision from the plan
 *   integrity check, the obligations the Wave owes and the owner check the
 *   suite authorized: the check is `unavailable` (the plan no longer derives
 *   the stamp, or the owed obligations are not the ones the check owes),
 *   `verified-empty` (nothing is owed: `verified []`, bound 0), or
 *   `must-run` over an `OwedVerification`.
 * - `OwedVerification` pairs the owed obligations with the digest the
 *   observation is bound to. Branded, and built only by the decision, so the
 *   owed ids the check authorizes and the obligations the runner iterates
 *   cannot disagree.
 * - `verificationRuns` is the runner's per-obligation plan, computed once:
 *   each obligation's coverage always runs, and its mutation runs through the
 *   frozen runner exactly when `verifyOwed` selects it. A Wave owing
 *   mutation without a frozen runner is the `runner-missing` failure, so a
 *   `mutate` run always carries its runner.
 */

import type { OwnerCheckAuthority } from "../owner-check-authority";
import {
  canonicalStructuralEquals,
  failure,
  isNonEmpty,
  success,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
} from "../orchestration-contract/identity";
import type { AffectedRunner } from "../verification-manifest";
import { mutantTimeoutMs } from "./mutation-plan";
import { verifyOwed } from "./obligations";
import type { MutationOwed, OwnerInfrastructureFailure, OwnerObligation, OwnerVerificationObservation } from "./types";

declare const OWED_VERIFICATION: unique symbol;

/**
 * The obligations one owner run verifies, in stamp order, and the stamp's
 * digest its observation is bound to. Their ids are exactly the authorized
 * check's owed ids: only `ownerObservationDecision` builds one.
 */
export type OwedVerification = Readonly<{
  obligationsDigest: ArtifactDigest;
  obligations: NonEmpty<OwnerObligation>;
}> & { readonly [OWED_VERIFICATION]: true };

export type OwnerObservationDecision =
  | Readonly<{ kind: "unavailable"; failure: OwnerInfrastructureFailure }>
  | Readonly<{ kind: "verified-empty"; observation: OwnerVerificationObservation }>
  | Readonly<{ kind: "must-run"; owed: OwedVerification }>;

export type OwnerObservationFacts = Readonly<{
  /** The plan integrity check's failure (`planModelsIntegrityFailure`), or null when the plan still derives the stamp. */
  integrity: OwnerInfrastructureFailure | null;
  /** The obligations the Wave owes (`ownerVerificationOwed`), in stamp order. */
  owed: readonly OwnerObligation[];
  /** The owner check the suite authorized. */
  authority: OwnerCheckAuthority;
}>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

/** What the gate's owner check does: refuse, record `verified []`, or run over the owed obligations. */
export function ownerObservationDecision({ integrity, owed, authority }: OwnerObservationFacts): OwnerObservationDecision {
  if (integrity !== null) return freeze({ kind: "unavailable", failure: integrity });
  const ids = owed.map(({ invariant }) => invariant);
  if (!canonicalStructuralEquals(ids, authority.owed)) {
    return freeze({
      kind: "unavailable",
      failure: freeze({
        kind: "plan-drift",
        detail: `the owner check owes [${authority.owed.join(", ")}], but the Wave's stamped obligations are [${ids.join(", ")}]`,
      }),
    });
  }
  if (!isNonEmpty(owed)) {
    return freeze({
      kind: "verified-empty",
      observation: freeze({ kind: "verified", obligationsDigest: authority.obligationsDigest, boundMs: 0, verdicts: Object.freeze([]) }),
    });
  }
  // The brand's one minting point: the owed ids were just checked to equal the authorized ones.
  const verification = freeze({ obligationsDigest: authority.obligationsDigest, obligations: owed }) as OwedVerification;
  return freeze({ kind: "must-run", owed: verification });
}

/** One owed obligation's run: coverage always, and mutation through the frozen runner unless exempt. */
export type ObligationRun =
  | Readonly<{ kind: "mutate"; obligation: OwnerObligation; runner: AffectedRunner }>
  | Readonly<{ kind: "exempt"; obligation: OwnerObligation }>;

export type VerificationRuns = Readonly<{
  /** One run per owed obligation, in stamp order. */
  runs: NonEmpty<ObligationRun>;
  /** The obligations that owe mutation, for the reported time bound. */
  verifying: MutationOwed;
  /** The clamped per-run limit (`mutantTimeoutMs`); 0 when there is no runner. */
  perRunMs: number;
}>;

/**
 * The per-obligation plan of one owner run, decided once. `verifyOwed` is
 * asked per obligation, so the owes-mutation rule stays in its one home and
 * no run is joined back to it by identity.
 */
export function verificationRuns(owed: OwedVerification, runner: AffectedRunner | undefined): DomainResult<VerificationRuns, OwnerInfrastructureFailure> {
  const verifying = verifyOwed(owed.obligations);
  if (verifying.length > 0 && runner === undefined) {
    return failure(freeze({
      kind: "runner-missing",
      detail: `${verifying.map((obligation) => obligation.invariant).join(", ")} owe mutation verification, but the frozen verification manifest declares no affectedRunner`,
    }));
  }
  const runOf = (obligation: OwnerObligation): ObligationRun =>
    runner !== undefined && verifyOwed([obligation]).length > 0
      ? freeze({ kind: "mutate", obligation, runner })
      : freeze({ kind: "exempt", obligation });
  const [first, ...rest] = owed.obligations;
  const runs: NonEmpty<ObligationRun> = [runOf(first), ...rest.map(runOf)];
  return success(freeze({
    runs: Object.freeze(runs),
    verifying,
    perRunMs: runner === undefined ? 0 : mutantTimeoutMs(runner.timeoutMs),
  }));
}
