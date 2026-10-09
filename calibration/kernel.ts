/**
 * The calibration kernel — PURE, generic, domain-free: the Result vocabulary
 * both calibration cores (the historical corpus core and the AD-11 pilot
 * under `grammar-constrained-decoding/`) return, plus the NonEmpty helper the
 * AD-11 pilot uses, and the one rendering of a caught error. Sharing it
 * couples the cores to no domain: neither imports the other.
 */

/**
 * A caught value's message: an Error's own message, anything else as text.
 * Total: a value that cannot be rendered — a null-prototype object, a
 * throwing `toString`, a hostile Proxy, an Error whose `message` getter
 * throws — is named by its type, so a fail-closed handler that renders what
 * it caught can never itself throw.
 */
export function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return `an unprintable thrown ${typeof error}`;
  }
}

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
