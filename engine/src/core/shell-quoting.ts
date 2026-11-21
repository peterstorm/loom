/**
 * The ONE quote-aware shell lexer (`lexShellQuotes`) and its unquoted
 * projection (`scanUnquoted`).
 *
 * Hand-rolled copies of this loop existed — `hasOutputRedirect` and
 * `findClosingParen` in `core/guard-state-file`, and the command parser now in
 * `core/shell-command` — and they had already diverged. Two counted a
 * backtick as a quote opener; `findClosingParen` did not. So in `` $(`a)b`) ``
 * the `)` inside the backtick body was read as the outer substitution's close,
 * and the command guard analysed a truncated body: not fail-closed, because
 * `openerLineGroups` and the heredoc opener scan resume at `close + 1` — inside
 * a still-live substitution — rather than treating the span as unparseable.
 *
 * Later copies — the segment splitter and the env-prefix strip
 * (`core/shell-command`), `splitFusedRedirect` (`core/shell-command-head`),
 * and the redirect and word scans of `core/shell-write-targets` — were folded
 * in the same way. The quote alphabet and the escape rule live here, once:
 * most callers supply only what they do at an unquoted character
 * (`scanUnquoted`); a caller that rebuilds a word's value sees every token
 * (`lexShellQuotes`).
 *
 * Not on this lexer, by design: the substitution-aware walkers
 * (`core/shell-substitution`, `core/shell-heredoc`), whose quote alphabet is
 * `"` and `'` because a backtick there opens a live substitution span, and
 * the normalizer (`core/shell-normalize`), which also decodes ANSI-C and
 * parameter forms.
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
 * One lexical unit of shell text as the quote lexer reads it. `quote` is the
 * region the unit sits in (null outside every quote):
 *
 *  - `text` — one ordinary character;
 *  - `escape` — a backslash and the character it escapes (`escaped`, empty
 *    when the backslash ends the text), at the backslash's index;
 *  - `open` / `close` — the quote character that opens or closes the region
 *    `quote`.
 */
export type ShellQuoteToken =
  | Readonly<{ kind: "text"; char: string; index: number; quote: ShellQuoteChar | null }>
  | Readonly<{ kind: "escape"; escaped: string; index: number; quote: ShellQuoteChar | null }>
  | Readonly<{ kind: "open" | "close"; index: number; quote: ShellQuoteChar }>;

/**
 * THE quote lexer: walk `text` from `start`, handing `visit` every lexical
 * unit (`ShellQuoteToken`), and report the first `halt` value and the quote
 * still open when the walk stops (end of text or halt).
 *
 * Quoting follows sh closely enough for the guards that use it: `"`, `'` and
 * `` ` `` open a region that the same character closes, and a backslash escapes
 * the next character everywhere EXCEPT inside single quotes, where sh gives it
 * no special meaning. A `skip` resumes at its index in the CURRENT quote state.
 */
export function lexShellQuotes<T>(
  text: string,
  start: number,
  visit: (token: ShellQuoteToken) => UnquotedStep<T>,
): Readonly<{ halted: T | null; openQuote: ShellQuoteChar | null }> {
  let quote: ShellQuoteChar | null = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    let token: ShellQuoteToken;
    if (char === "\\" && quote !== "'") {
      token = { kind: "escape", escaped: text[i + 1] ?? "", index: i, quote };
      i++;
    } else if (quote !== null && char === quote) {
      token = { kind: "close", index: i, quote };
      quote = null;
    } else if (quote === null && isShellQuoteChar(char)) {
      token = { kind: "open", index: i, quote: char };
      quote = char;
    } else {
      token = { kind: "text", char, index: i, quote };
    }
    const step = visit(token);
    if (step.kind === "halt") return Object.freeze({ halted: step.value, openQuote: quote });
    if (step.kind === "skip") i = step.resumeAt - 1;
  }
  return Object.freeze({ halted: null, openQuote: quote });
}

/**
 * Walk `text` from `start`, calling `visit` for every character OUTSIDE a
 * quoted region (never a quote character or an escape pair), and return the
 * first `halt` value — or `null` if the scan reaches the end without one.
 * The unquoted projection of `lexShellQuotes`.
 */
export function scanUnquoted<T>(
  text: string,
  start: number,
  visit: (char: string, index: number) => UnquotedStep<T>,
): T | null {
  return lexShellQuotes<T>(text, start, (token) =>
    token.kind === "text" && token.quote === null ? visit(token.char, token.index) : CONTINUE).halted;
}

/**
 * The quote character still open after walking `text` from `start` — `null`
 * when every opened region was closed. This is the balance check raw
 * per-character parity cannot express: an escaped quote (`\"`) or a quote
 * nested inside another region (`'a " b'`) does not open, while an even raw
 * count can still leave a region open (`\" a"`).
 */
export function openQuoteAfter(text: string, start: number): ShellQuoteChar | null {
  return lexShellQuotes(text, start, () => CONTINUE).openQuote;
}

/**
 * Render `value` as exactly one sh word that reads back as `value`: the
 * inverse of the scan above. Single quotes disable every expansion, so the
 * only character to handle is `'` itself, which closes the quote, emits an
 * escaped `'`, and reopens it.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
