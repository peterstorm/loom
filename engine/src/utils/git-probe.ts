export type GitProbeStep<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export type GitProbeObservation<T, E> =
  | Readonly<{ kind: "observed"; value: T; attempts: 1 | 2 | 3 }>
  | Readonly<{ kind: "confirmed-empty"; first: T; second: T; third: T }>
  | Readonly<{ kind: "failed"; error: E; attempt: 1 | 2 | 3 }>;

/**
 * Execute one Git observation and retry twice only for a successful empty
 * value. Process adapters supply typed success/failure and define what empty
 * means; callers retain policy for whether confirmed emptiness is legal.
 *
 * Canonical rationale — every empty-retry call site points here: the listed
 * output-producing probes require non-empty stdout, but the darwin verification
 * campaign observed transient empty success for `rev-parse --show-toplevel`
 * (twice), `rev-parse HEAD^{tree}` (once), and `--verify HEAD` (once inside a
 * review-packet CLI child, where it surfaced as `git returned an invalid HEAD:
 * ""`). The bounded retries discharge that observed transient; they
 * cannot corrupt a legitimate result, because an operation that legitimately
 * produces no output re-runs and returns empty again. A confirmed-empty is
 * handed back to the caller, whose own emptiness guards refuse loudly with
 * attribution — an empty output that reached a digesting site would silently
 * become sha256(""): a plausible witness that later reads as "repository
 * changed since verification".
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
  if (!isEmpty(second.value)) return Object.freeze({ kind: "observed", value: second.value, attempts: 2 });
  const third = run();
  if (!third.ok) return Object.freeze({ kind: "failed", error: third.error, attempt: 3 as const });
  return isEmpty(third.value)
    ? Object.freeze({ kind: "confirmed-empty", first: first.value, second: second.value, third: third.value })
    : Object.freeze({ kind: "observed", value: third.value, attempts: 3 });
}

/**
 * Pass a confirmed-empty observation straight through as a step result: the
 * raw (third) empty output is returned, and the consuming site's own
 * emptiness guard refuses loudly with attribution. `GitProbeStep` is
 * structurally `DomainResult`, so both call-site families consume it directly.
 */
export function confirmedEmptyPassthrough<T, E>(
  observed: GitProbeObservation<T, E>,
): GitProbeStep<T, E> {
  if (observed.kind === "failed") return Object.freeze({ ok: false as const, error: observed.error });
  return Object.freeze({
    ok: true as const,
    value: observed.kind === "confirmed-empty" ? observed.third : observed.value,
  });
}
