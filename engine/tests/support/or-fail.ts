/**
 * A suite's one way out of a `Result`: the success value, or a thrown failure
 * carrying `describe`'s sentence for the refusal, so the assertion that failed
 * names what was missing and where.
 */

type Result<T, E> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>;

/** The success value, or a thrown failure carrying `describe`'s sentence for the refusal. */
export function orFail<T, E>(result: Result<T, E>, describe: (error: E) => string): T {
  if (!result.ok) throw new Error(describe(result.error));
  return result.value;
}
