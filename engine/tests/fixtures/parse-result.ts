/**
 * The one success/refusal unwrap the suites and fixtures share for every
 * result union the engine returns: `ParseResult` (`errors`/`error`),
 * `DomainResult` (`error`) and the panel results (`error` with a `kind`). A
 * wrong arm throws with the arm's own content, so the failing test names what
 * actually came back. Fixture builders that mint protected values through a
 * production parser use the labelled variant, so a refused fixture names the
 * fixture it was building.
 */

// Plain readonly object types, not `Readonly<...>`: inference through the
// mapped type collapses `T` to `unknown` for a function whose returns form
// a union of several arms.
type Success<T> = { readonly ok: true; readonly value: T };
type Refused = { readonly ok: false };

function render(result: object): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** The success value, or a thrown failure naming the refusal that came back. */
export function value<T>(result: Success<T> | Refused): T {
  if (!result.ok) throw new Error(`expected success, got ${render(result)}`);
  return result.value;
}

/** The success value of a fixture's own construction, or a thrown fixture bug
 *  naming what `label` was being built and the refusal that came back. */
export function labelledValue<T>(label: string, result: Success<T> | Refused): T {
  if (!result.ok) throw new Error(`${label} fixture refused: ${render(result)}`);
  return result.value;
}

/** The refusal of a result that must fail, or a thrown failure naming the success that came back. */
export function refusal<E>(result: { readonly ok: true } | { readonly ok: false; readonly error: E }): E {
  if (result.ok) throw new Error(`expected a refusal, got ${render(result)}`);
  return result.error;
}
