/**
 * Genuinely immutable collection singletons for the functional core.
 *
 * `Object.freeze` is not enough for a `Set` or a `Map`: freezing locks own
 * PROPERTIES, while `add`/`delete`/`clear` write internal slots through the
 * prototype and go on working. A shared vocabulary that gates security
 * decisions — which tools modify files, which tool names spawn a subagent,
 * which directory names hold run evidence — must not be mutable by a caller
 * that reaches it through a cast, and `ReadonlySet<T>` is only a compile-time
 * claim.
 *
 * `frozenSet` removes the mutators instead of hiding them: each is replaced by
 * an own property that throws, and the object is then frozen so the
 * replacements cannot be swapped back out.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

function denyMutation(operation: string): () => never {
  return () => {
    throw new TypeError(`${operation} is not available on a frozen set`);
  };
}

/** A `ReadonlySet` that stays readonly at RUNTIME, not only in the type. */
export function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  return Object.freeze(Object.assign(set, {
    add: denyMutation("add"),
    delete: denyMutation("delete"),
    clear: denyMutation("clear"),
  })) as unknown as ReadonlySet<T>;
}
