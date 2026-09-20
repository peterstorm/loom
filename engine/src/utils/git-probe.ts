export type GitProbeStep<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export type GitProbeObservation<T, E> =
  | Readonly<{ kind: "observed"; value: T; attempts: 1 | 2 }>
  | Readonly<{ kind: "confirmed-empty"; first: T; second: T }>
  | Readonly<{ kind: "failed"; error: E; attempt: 1 | 2 }>;

/**
 * Execute one Git observation and retry exactly once only for a successful
 * empty value. Process adapters supply typed success/failure and define what
 * empty means; callers retain policy for whether confirmed emptiness is legal.
 */
export function observeGitProbe<T, E>(
  run: () => GitProbeStep<T, E>,
  isEmpty: (value: T) => boolean,
): GitProbeObservation<T, E> {
  const first = run();
  if (!first.ok) return Object.freeze({ kind: "failed", error: first.error, attempt: 1 as const });
  if (!isEmpty(first.value)) return Object.freeze({ kind: "observed", value: first.value, attempts: 1 });
  const second = run();
  if (!second.ok) return Object.freeze({ kind: "failed", error: second.error, attempt: 2 as const });
  return isEmpty(second.value)
    ? Object.freeze({ kind: "confirmed-empty", first: first.value, second: second.value })
    : Object.freeze({ kind: "observed", value: second.value, attempts: 2 });
}
