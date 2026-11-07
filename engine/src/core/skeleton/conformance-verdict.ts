/**
 * The completion conformance verdict (AD-5, FR-021): why a production file
 * breaks its contract, one violation, and the verdict a settlement shell
 * decides for a Task (`not-owed`, or every violation by artifact).
 *
 * A leaf: it imports nothing from `engine/src/types.ts` or
 * `core/proof-obligations.ts` (and nothing that does). The TaskGraph imports
 * the proof channel, and `./types.ts` imports the TaskGraph, so this is the
 * one owner both can import without a cycle. `./types.ts` re-exports every
 * name here, so skeleton consumers keep importing from it.
 */

import type { NonEmpty } from "../orchestration-contract/identity";

/** Every reason a production file breaks its contract, in one list: the
 *  union is derived from it, so the type and the parser cannot drift. */
export const VIOLATION_REASONS = Object.freeze([
  "deleted",
  "renamed",
  "retyped",
  "still-unimplemented",
  "shadows-frozen-adt",
  "re-lists-frozen-variants",
] as const);

/** Why a production file breaks its contract (FR-021). Tags only: the
 *  diagnostic's wording is rendered from them, never stored in them. */
export type ViolationReason = (typeof VIOLATION_REASONS)[number];

export const isViolationReason = (raw: unknown): raw is ViolationReason =>
  typeof raw === "string" && (VIOLATION_REASONS as readonly string[]).includes(raw);

/** `subject` is the bound export or frozen ADT the violation concerns;
 *  `remedy` names the fix where one is fixed (re-listing), else null. */
export type ConformanceViolation = Readonly<{ subject: string; reason: ViolationReason; remedy: string | null }>;

/** The verdict every settlement path decides before a Proof is evaluated:
 *  there is no "undecided" arm. */
export type ContractConformance =
  | Readonly<{ kind: "not-owed" }>
  | Readonly<{ kind: "judged"; violations: ReadonlyMap<string, NonEmpty<ConformanceViolation>> }>;

/** The `not-owed` verdict, for a path that owes no conformance. */
export const CONFORMANCE_NOT_OWED: ContractConformance = Object.freeze({ kind: "not-owed" });
