/**
 * The Invariant id (`INV-3`), branded so an owed id, an Owner Obligation's
 * Invariant and a verdict's Invariant cannot be mixed up with any other
 * string at compile time. A dependency-free leaf: the plan model
 * (`engine/src/types.ts`), the owner check authority and the
 * owner-verification core all name it without importing each other.
 *
 * The only minting point is `parseInvariantId`, which accepts exactly the plan
 * grammar's `### INV-N:` id. The plan grammar parser and the State File and
 * receipt parsers call it; everything else receives an id one of them minted.
 */

import { failure, success, type DomainResult } from "./orchestration-contract/identity";

declare const INVARIANT_ID: unique symbol;

export type InvariantId = string & { readonly [INVARIANT_ID]: true };

/** The plan grammar's Invariant id: `INV-` and a decimal number. */
export const INVARIANT_ID_PATTERN = /^INV-\d+$/;

/** Why a raw value is not an Invariant id. */
export type InvariantIdError = Readonly<{ kind: "not-an-invariant-id"; raw: string }>;

export const parseInvariantId = (raw: string): DomainResult<InvariantId, InvariantIdError> =>
  INVARIANT_ID_PATTERN.test(raw) ? success(raw as InvariantId) : failure({ kind: "not-an-invariant-id", raw });
