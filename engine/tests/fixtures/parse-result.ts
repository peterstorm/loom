/**
 * The one success/refusal unwrap the core suites share for every result union
 * the engine returns: `ParseResult` (`errors`), `DomainResult` (`error`) and
 * the panel results (`error` with a `kind`). A wrong arm throws with the arm's
 * own content, so the failing test names what actually came back.
 */

type Success<T> = Readonly<{ ok: true; value: T }>;

function render(result: object): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** The success value, or a thrown failure naming the refusal that came back. */
export function value<T>(result: Success<T> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(`expected success, got ${render(result)}`);
  return result.value;
}

/** The refusal of a result that must fail, or a thrown failure when it succeeded. */
export function refusal<E>(result: Readonly<{ ok: true }> | Readonly<{ ok: false; error: E }>): E {
  if (result.ok) throw new Error("expected a refusal, got success");
  return result.error;
}
