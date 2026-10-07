/**
 * The calibration kernel — PURE, generic, domain-free: the one Result and
 * NonEmpty vocabulary every calibration core (the historical corpus core and
 * the AD-11 pilot under `grammar-constrained-decoding/`) returns. Sharing it
 * couples the cores to no domain: neither imports the other.
 */

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export const ok = <T>(value: T): Result<T, never> => Object.freeze({ ok: true as const, value });
export const err = <E>(error: E): Result<never, E> => Object.freeze({ ok: false as const, error });

export type NonEmpty<T> = readonly [T, ...T[]];

/** The one NonEmpty constructor from a list: a length proof, not a claim. */
export function nonEmpty<T>(values: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = values;
  return first === undefined ? null : Object.freeze([first, ...rest] as const);
}

/** A list with one item inserted between two lists: non-empty by construction. */
export function including<T>(before: readonly T[], item: T, after: readonly T[]): NonEmpty<T> {
  const [first, ...rest] = before;
  return Object.freeze(first === undefined ? [item, ...after] as const : [first, ...rest, item, ...after] as const);
}
