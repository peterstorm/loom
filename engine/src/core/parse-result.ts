/**
 * The single-diagnostic parse result (parse, don't validate): a value, or one
 * non-empty line saying why not. The machine parsers, the state-file wire and
 * the architecture panel journal speak it; `machine/types` re-exports it so
 * the machine's public surface keeps it.
 *
 * It is named `LineParseResult`, not `ParseResult`: `panel-kernel`'s
 * `ParseResult` carries a list of diagnostics (`errors`), and one name for two
 * incompatible shapes let a wrong import compile until a field was read.
 *
 * The engine's other parsers keep richer failures: a list of diagnostics
 * (`errors`), or a domain error record carrying a `message` or its own
 * `errors`. `toParseResult` is the one adapter from those to this.
 *
 * Pure module: no I/O.
 */

export type LineParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const parseOk = <T>(value: T): LineParseResult<T> => ({ ok: true, value });
export const parseErr = <T>(error: string): LineParseResult<T> => ({ ok: false, error });

/** A failure record's diagnostics: exactly one of a message or a list, so the rendering is never ambiguous. */
type FailureDiagnostics =
  | Readonly<{ message: string; errors?: never }>
  | Readonly<{ errors: readonly string[]; message?: never }>;

/** Every result shape the engine's richer parsers return. */
export type ForeignParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>
  | Readonly<{ ok: false; error: FailureDiagnostics }>;

/** What a failure says when the foreign failure carried no diagnostic text at all. */
export const NO_DIAGNOSTIC = "the parser refused the value without a diagnostic";

/**
 * A richer parser's result as a `LineParseResult`: its value, or every
 * diagnostic joined by "; " on one line, as `<label>: <diagnostics>` when a
 * label names the field that failed. A failure whose diagnostics join to
 * nothing (`errors: []`, an empty message) says `NO_DIAGNOSTIC` instead, so
 * a failure always says something.
 */
export function toParseResult<T>(result: ForeignParseResult<T>, label?: string): LineParseResult<T> {
  if (result.ok) return parseOk(result.value);
  const diagnostics = "errors" in result ? result.errors : result.error.errors ?? [result.error.message];
  const joined = diagnostics.join("; ");
  const detail = joined === "" ? NO_DIAGNOSTIC : joined;
  return parseErr(label === undefined ? detail : `${label}: ${detail}`);
}
