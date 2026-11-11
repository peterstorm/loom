/**
 * Generators shared by the skeleton-outcome property suites: the digests a
 * generated record or observation may carry, and what may be on disk at one
 * path.
 */
import fc from "fast-check";
import type { PathObservation } from "../../src/core/skeleton/types";

/** Three distinct well-formed SHA-256 digests. */
export const SHAS = ["a", "b", "c"].map((fill) => fill.repeat(64));

/** An absent path, or a present one whose bytes and canonical bytes each carry one of `SHAS`. */
export const observationArb: fc.Arbitrary<PathObservation> = fc.oneof(
  fc.constant<PathObservation>({ kind: "absent" }),
  fc.record({
    kind: fc.constant("present" as const),
    sha256: fc.constantFrom(...SHAS),
    canonicalSha256: fc.option(fc.constantFrom(...SHAS), { nil: null }),
  }),
);
