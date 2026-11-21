/**
 * The single-diagnostic parse result (parse, don't validate): a value, or one
 * line saying why not. The machine parsers and the state-file wire speak it;
 * `machine/types` re-exports it so the machine's public surface keeps it.
 *
 * The engine's other parsers keep richer failures: a list of diagnostics
 * (`errors`), or a domain error record carrying a `message` or its own
 * `errors`. `toParseResult` is the one adapter from those to this.
 *
 * Pure module: no I/O.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const parseOk = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const parseErr = <T>(error: string): ParseResult<T> => ({ ok: false, error });

/** A failure record's diagnostics: exactly one of a message or a list, so the rendering is never ambiguous. */
type FailureDiagnostics =
  | Readonly<{ message: string; errors?: never }>
  | Readonly<{ errors: readonly string[]; message?: never }>;

/** Every result shape the engine's richer parsers return. */
export type ForeignParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>
  | Readonly<{ ok: false; error: FailureDiagnostics }>;

/**
 * A richer parser's result as a `ParseResult`: its value, or every diagnostic
 * joined by "; " on one line, as `<label>: <diagnostics>` when a label names
 * the field that failed.
 */
export function toParseResult<T>(result: ForeignParseResult<T>, label?: string): ParseResult<T> {
  if (result.ok) return parseOk(result.value);
  const diagnostics = "errors" in result ? result.errors : result.error.errors ?? [result.error.message];
  const detail = diagnostics.join("; ");
  return parseErr(label === undefined ? detail : `${label}: ${detail}`);
}
