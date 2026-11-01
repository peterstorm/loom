/**
 * Owner Obligations for tests, built only through the engine's own minting
 * points: `parseInvariantId` for the id and `ownerObligationOf` for the
 * obligation. A fixture that names a path in two roles throws, so no test can
 * hold an obligation the plan grammar or the State File parser would refuse.
 */

import { parseInvariantId, type InvariantId } from "../../src/core/invariant-id";
import { parseMutantCap } from "../../src/core/owner-verification/mutation-plan";
import type { InvariantOwnershipSource } from "../../src/core/implementation-brief";
import { ownerObligationOf, taskOwnerDuty } from "../../src/core/owner-verification/obligations";
import type { MutantCap, OwnerObligation, OwnerObligationFields } from "../../src/core/owner-verification/types";
import type { PlanInvariant } from "../../src/types";

/** An Invariant id the test spells out; throws on anything but `INV-N`. */
export function invariantId(raw: string): InvariantId {
  const parsed = parseInvariantId(raw);
  if (!parsed.ok) throw new Error(`fixture: ${raw} is not an Invariant id`);
  return parsed.value;
}

/** An obligation's fields with the id still spelled as text. */
export type OwnerObligationSpec = Omit<OwnerObligationFields, "invariant"> & Readonly<{ invariant: string }>;

/** An Owner Obligation through its one constructor; throws when the fixture's paths play two roles. */
export function ownerObligation(spec: OwnerObligationSpec): OwnerObligation {
  const built = ownerObligationOf({ ...spec, invariant: invariantId(spec.invariant) });
  if (!built.ok) throw new Error(`fixture: ${built.error.kind} (${built.error.path})`);
  return built.value;
}

/** A mutant cap through its one parser; throws on anything but a positive integer. */
export function capOf(raw: number): MutantCap {
  const parsed = parseMutantCap(raw);
  if (!parsed.ok) throw new Error(`fixture: ${raw} is not a mutant cap`);
  return parsed.value;
}

/** A brief's ownership for a graph populated before owner verification: the plan's Invariants (none by default), no duty. */
export const planOwnership = (invariants: readonly PlanInvariant[] = []): InvariantOwnershipSource => ({ kind: "plan", invariants });

/**
 * A brief's ownership as the shell chooses it: the stamped obligations
 * `taskOwnerDuty` touches when `stamp` is present, the plan's Invariants when
 * it is absent.
 */
export function briefOwnership(
  stamp: readonly OwnerObligation[] | undefined,
  invariants: readonly PlanInvariant[],
  fileList: readonly string[],
): InvariantOwnershipSource {
  const duty = taskOwnerDuty(stamp === undefined ? {} : { owner_obligations: stamp }, fileList);
  return duty.kind === "stamped" ? duty : planOwnership(invariants);
}
