/**
 * A positive integer as a type: a count or a threshold that is at least one.
 *
 * `isPositiveInt` is the one place the invariant is checked. A value typed
 * `PositiveInt` has been through it — at the config parse, or at a smart
 * constructor built on it — so the code that receives one never re-checks or
 * clamps.
 */

export type PositiveInt = number & { readonly __brand: "PositiveInt" };

/** Is `raw` a whole number of at least one? Refuses every non-number, `NaN`, the infinities and fractions. */
export const isPositiveInt = (raw: unknown): raw is PositiveInt =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= 1;
