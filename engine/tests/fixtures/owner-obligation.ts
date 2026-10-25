/**
 * Owner Obligations for tests, built only through the engine's own minting
 * points: `parseInvariantId` for the id and `ownerObligationOf` for the
 * obligation. A fixture that names a path in two roles throws, so no test can
 * hold an obligation the plan grammar or the State File parser would refuse.
 */

import { parseInvariantId, type InvariantId } from "../../src/core/invariant-id";
import { ownerObligationOf, ownerScopeOf, type OwnerScope } from "../../src/core/owner-verification/obligations";
import type { OwnerObligation, OwnerObligationFields } from "../../src/core/owner-verification/types";

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

/** The scope of a graph populated before owner verification: no stamp, so nothing is owed. */
export const UNSTAMPED_SCOPE: OwnerScope = ownerScopeOf({ tasks: [] });
