/**
 * Deterministic ordering primitives for the functional core.
 *
 * `localeCompare` is locale-dependent: the same inputs sort differently on two
 * machines, and a ranking, a digest input, or a canonical key list that depends
 * on the host's locale is not canonical at all. Every comparison that must
 * reproduce anywhere goes through here instead.
 */

/** Byte-order string comparison — the same answer on every machine. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
