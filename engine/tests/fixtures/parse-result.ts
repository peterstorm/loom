/**
 * The one success/refusal unwrap the suites and fixtures share for every
 * result union the engine returns: `ParseResult` (`errors`/`error`),
 * `DomainResult` (`error`) and the panel results (`error` with a `kind`). A
 * wrong arm throws with the arm's own content, so the failing test names what
 * actually came back. Fixture builders that mint protected values through a
 * production parser use the labelled variant, so a refused fixture names the
 * fixture it was building.
 */

type Success<T> = Readonly<{ ok: true; value: T }>;
type Refused = Readonly<{ ok: false }>;

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

/** The refusal of a result that must fail, or a thrown failure when it succeeded. */
export function refusal<E>(result: Readonly<{ ok: true }> | Readonly<{ ok: false; error: E }>): E {
  if (result.ok) throw new Error("expected a refusal, got success");
  return result.error;
}
