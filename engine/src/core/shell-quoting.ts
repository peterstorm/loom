/**
 * The ONE quote-aware shell scan.
 *
 * Three hand-rolled copies of this loop existed — `hasOutputRedirect` and
 * `findClosingParen` in `core/guard-state-file`, and the command parser now in
 * `core/shell-command` — and they had already diverged. Two counted a
 * backtick as a quote opener; `findClosingParen` did not. So in `` $(`a)b`) ``
 * the `)` inside the backtick body was read as the outer substitution's close,
 * and the command guard analysed a truncated body: not fail-closed, because
 * `openerLineGroups` and the heredoc opener scan resume at `close + 1` — inside
 * a still-live substitution — rather than treating the span as unparseable.
 *
 * The quote alphabet and the escape rule live here now, once, and each caller
 * supplies only what it does at an unquoted character.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

/** The characters that open a quoted region in sh. */
export const SHELL_QUOTE_CHARS = Object.freeze(['"', "'", "`"] as const);
export type ShellQuoteChar = (typeof SHELL_QUOTE_CHARS)[number];

export function isShellQuoteChar(char: string | undefined): char is ShellQuoteChar {
  return char !== undefined && (SHELL_QUOTE_CHARS as readonly string[]).includes(char);
}

/**
 * What a visitor decides at one unquoted character.
 *
 * `skip` exists for the one caller that consumes a span it has already
 * classified (`>&2` and friends): the alternative was letting it mutate the
 * loop index, which is exactly the coupling that let the three copies drift.
 */
export type UnquotedStep<T> =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "skip"; resumeAt: number }>
  | Readonly<{ kind: "halt"; value: T }>;

export const CONTINUE: UnquotedStep<never> = Object.freeze({ kind: "continue" as const });
export const skip = (resumeAt: number): UnquotedStep<never> => Object.freeze({ kind: "skip" as const, resumeAt });
export const halt = <T>(value: T): UnquotedStep<T> => Object.freeze({ kind: "halt" as const, value });

/**
 * Walk `text` from `start`, calling `visit` for every character OUTSIDE a
 * quoted region, and return the first `halt` value — or `null` if the scan
 * reaches the end without one.
 *
 * Quoting follows sh closely enough for the guards that use it: `"`, `'` and
 * `` ` `` open a region that the same character closes, and a backslash escapes
 * the next character everywhere EXCEPT inside single quotes, where sh gives it
 * no special meaning.
 */
export function scanUnquoted<T>(
  text: string,
  start: number,
  visit: (char: string, index: number) => UnquotedStep<T>,
): T | null {
  let quote: ShellQuoteChar | null = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== null) {
      if (quote !== "'" && char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (isShellQuoteChar(char)) {
      quote = char;
      continue;
    }
    const step = visit(char, i);
    if (step.kind === "halt") return step.value;
    if (step.kind === "skip") i = step.resumeAt - 1;
  }
  return null;
}
