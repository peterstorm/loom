/**
 * Answers computed on first use and kept — the laziness of the doc-reference
 * index and its snapshot, so a lint run that asks nothing reads nothing.
 *
 * Pure: the cell is private to the function each helper returns.
 */

/** Compute once, on first use. */
export function once<T>(compute: () => T): () => T {
  let value: { readonly current: T } | undefined;
  return () => (value ??= { current: compute() }).current;
}

/** Remember a function's answer per argument. */
export function remembered<T>(compute: (key: string) => T): (key: string) => T {
  const known = new Map<string, Readonly<{ value: T }>>();
  return (key) => {
    const hit = known.get(key);
    if (hit !== undefined) return hit.value;
    const value = compute(key);
    known.set(key, { value });
    return value;
  };
}
