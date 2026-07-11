/**
 * The ONE place bash word-normalization lives: quote stripping, backslash
 * escapes, `\`-newline line continuation, ANSI-C `$'…'` decoding (NUL dropped),
 * and locale `$"…"` quoting. Both the guard's matching view
 * (core/guard-state-file `collapseQuotes`) and the evidence scanner's
 * redirect-target reader (machine/extract-evidence `readRedirectTarget`) build
 * on this, so a rule taught to one (ANSI-C in round 17, line-continuation + NUL
 * in round 18) can never again be missing from the other — the "twin scanners
 * diverged" bug class that recurred rounds 15–18 becomes structurally
 * impossible for the normalization layer. (Structural scanning — segment
 * splitting, fd-dup classification — is already shared via
 * extract-evidence's splitCommandSegmentsWithOps / classifyFdDupWord.)
 */

import { decodeAnsiC, findAnsiCClose } from "./shell-ansi-c";

/** Unquoted chars that end a word for the redirect-target reader. */
const WORD_BOUNDARY = /[\s><&()]/;

export interface NormalizedSpan {
  /** The literal characters bash produces for the consumed span. */
  readonly value: string;
  /** Index one past the last consumed character (never exceeds text.length). */
  readonly end: number;
}

export interface NormalizeOptions {
  /**
   * When true, stop (exclusive) at the first UNQUOTED whitespace or redirect
   * metacharacter (`>` `<` `&` `(` `)`) — single-word extraction for the
   * redirect-target reader. When false, consume to the end of `text` — the
   * whole-segment matching view (guard).
   */
  readonly stopAtWordBoundary: boolean;
  /**
   * Treat an unquoted backtick as a quote. The evidence redirect reader sets
   * this so a `` >`cmd` `` target does not split mid-substitution; the guard
   * leaves it false because backtick substitutions are flattened out before
   * the matching view is built.
   */
  readonly backtickQuotes?: boolean;
}

/**
 * Normalize the span of `text` starting at `start` to the literal characters
 * bash produces, applying every quote/escape/ANSI-C rule exactly once. The
 * decisions here are the shared contract; callers differ only in where a span
 * ends (opts.stopAtWordBoundary) and whether backticks quote (opts.backtickQuotes).
 */
export function normalizeShellSpan(
  text: string,
  start: number,
  opts: NormalizeOptions,
): NormalizedSpan {
  let value = "";
  let quote: '"' | "'" | "`" | null = null;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        if (text[i + 1] === "\n") { i++; continue; } // line continuation: drop both
        value += text[i + 1] ?? ""; // escape: drop backslash, keep char
        i++;
        continue;
      }
      if (c === quote) { quote = null; continue; }
      value += c;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      const close = findAnsiCClose(text, i + 2);
      const bodyEnd = close === -1 ? text.length : close;
      value += decodeAnsiC(text.slice(i + 2, bodyEnd));
      i = close === -1 ? text.length : close; // for-loop i++ steps past the close / ends
      continue;
    }
    if (c === "$" && text[i + 1] === '"') {
      quote = '"'; // locale-quoted `$"…"` is `"…"`
      i++; // consume `$`; for-loop i++ steps past the `"`
      continue;
    }
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; } // line continuation: drop both
      value += text[i + 1] ?? ""; // escape: drop backslash, keep char
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (opts.backtickQuotes === true && c === "`")) {
      quote = c;
      continue;
    }
    if (opts.stopAtWordBoundary && WORD_BOUNDARY.test(c)) break;
    value += c;
  }
  return { value, end: Math.min(i, text.length) };
}
