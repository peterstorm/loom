/**
 * The ONE place bash word-normalization lives: quote stripping, backslash
 * escapes, `\`-newline line continuation, ANSI-C `$'…'` decoding (NUL dropped),
 * locale `$"…"` quoting, and unquoted/double-quoted parameter expansion
 * (`$name` / `${…}`) deletion. Both the guard's matching view
 * (core/guard-state-file `collapseQuotes`) and the evidence scanner's
 * redirect-target reader (machine/extract-evidence `readRedirectTarget`) build
 * on this, so a rule taught to one (ANSI-C in round 17, line-continuation + NUL
 * in round 18, parameter expansion in round 19) can never again be missing from
 * the other — the "twin scanners diverged" bug class that recurred rounds 15–18
 * becomes structurally impossible for the normalization layer. (Structural
 * scanning — segment splitting, fd-dup classification — is already shared via
 * extract-evidence's splitCommandSegmentsWithOps / classifyFdDupWord.)
 *
 * Parameter expansion is modeled as DELETION to the unset→empty value: an
 * unquoted or double-quoted `$x` / `${x}` bash expands to empty when `x` is
 * unset, which is the only bash-accurate view of the span (leaving the literal
 * `$x` is a string bash never produces). Deleting it is reveal-monotonic for
 * the guard — `rm .claude/stat${x}e/…` collapses to `.claude/state/…` and the
 * guarded literal reassembles — and yields the unset-var path for the evidence
 * twin, keeping the two consumers point-wise identical. `$'…'`, `$"…"`, and
 * `$(…)` are NOT parameter expansions and are handled separately (`$(…)` stays
 * literal here — command substitution is flattened upstream of both callers).
 */

import { decodeAnsiC, findAnsiCClose } from "./shell-ansi-c";

/** Unquoted chars that end a word for the redirect-target reader. Includes the
 *  segment separators `|` and `;` and the control operator `&` so a redirect
 *  word stops at a command boundary even if the caller ever passes text that is
 *  NOT pre-split on those operators. (`readRedirectTarget` today receives
 *  per-segment slices from splitCommandSegmentsWithOps, so `|`/`;`/`&` cannot
 *  actually appear unquoted mid-word — this class makes the redirect-word
 *  contract self-contained rather than depending on that upstream precondition.) */
const WORD_BOUNDARY = /[\s><&()|;]/;

/** Single-char special/positional parameters bash expands (`$?`, `$@`, `$1`,
 *  `$$`, `$#`, `$!`, `$-`, `$*`). Each expands to a value, so a bare `$?` etc.
 *  is deleted to its unset/empty representative like a named expansion. */
const SPECIAL_PARAM = /[0-9@*?$!#-]/;

/**
 * If `text[start] === "$"` begins a parameter expansion (`$name`, `${…}`, or a
 * single special param), return the index of its LAST character; otherwise -1
 * (the `$` is literal — `$(`, `$'`, `$"`, `$ `, `$.`, or a lone trailing `$`).
 * `${…}` consumes to its brace-depth-matched close so nested `${a${b}}` and
 * modifier forms (`${x:-y}`) are removed whole; an unbalanced `${` is left
 * literal (-1) so the span is never over-consumed.
 */
function paramExpansionEnd(text: string, start: number): number {
  const next = text[start + 1];
  if (next === undefined) return -1;
  if (next === "{") {
    let depth = 1;
    for (let j = start + 2; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) return j;
    }
    return -1; // unbalanced `${` — leave literal, caller fails closed elsewhere
  }
  if (/[A-Za-z_]/.test(next)) {
    let j = start + 2;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
    return j - 1;
  }
  if (SPECIAL_PARAM.test(next)) return start + 1;
  return -1;
}

export interface NormalizedSpan {
  /** The literal characters bash produces for the consumed span. */
  readonly value: string;
  /** Index one past the last consumed character (never exceeds text.length). */
  readonly end: number;
}

/**
 * The two — and only two — coherent normalization modes, as a discriminated
 * union so the incoherent boolean-product configs the old
 * `{ stopAtWordBoundary; backtickQuotes? }` admitted are unrepresentable:
 *
 *   - `"matching-view"` (guard `collapseQuotes`): consume to the end of `text`
 *     and treat an unquoted backtick as a LITERAL. Backticks stay literal
 *     because guarded patterns contain no backtick, so keeping the char is
 *     reveal-monotonic — it can only ever fail to hide a guarded token, never
 *     conceal one. (The front gate and placeholderFor run on UNFLATTENED text,
 *     so it is NOT that substitutions were already removed.)
 *   - `"redirect-word"` (evidence `readRedirectTarget`): stop (exclusive) at the
 *     first UNQUOTED word boundary (whitespace, `>` `<` `&` `(` `)` `|` `;`) and
 *     treat an unquoted backtick as a QUOTE so a `` >`cmd` `` target does not
 *     split mid-substitution.
 *
 * `stopAtWordBoundary` and `backtickQuotes` are derived from `mode` internally
 * (see `resolveMode`), so the two flags can never disagree.
 */
export type NormalizeOptions =
  | { readonly mode: "matching-view" }
  | { readonly mode: "redirect-word" };

/** Derive the two behavioral flags from the mode — the single place the mode↔
 *  flag mapping lives, so `matching-view`/`redirect-word` stay coherent. */
function resolveMode(opts: NormalizeOptions): {
  readonly stopAtWordBoundary: boolean;
  readonly backtickQuotes: boolean;
} {
  return opts.mode === "redirect-word"
    ? { stopAtWordBoundary: true, backtickQuotes: true }
    : { stopAtWordBoundary: false, backtickQuotes: false };
}

/**
 * Normalize the span of `text` starting at `start` to the literal characters
 * bash produces, applying every quote/escape/ANSI-C rule exactly once. The
 * decisions here are the shared contract; callers differ only by `opts.mode`
 * (see NormalizeOptions), which selects where a span ends and whether backticks
 * quote. Caveat: for double-quoted `\c` where `c` is a non-special char, bash
 * KEEPS the backslash (`"a\c"` → `a\c`) but this normalizer DROPS it (→ `ac`);
 * that over-normalizes — reveal-monotonic for the guard (can only expose a
 * guarded token, never hide one) but over-mints for the evidence twin.
 */
export function normalizeShellSpan(
  text: string,
  start: number,
  opts: NormalizeOptions,
): NormalizedSpan {
  const { stopAtWordBoundary, backtickQuotes } = resolveMode(opts);
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
      // Parameter expansion inside double quotes (`"…$x…"`) still expands; delete
      // it to the unset→empty value. Single quotes suppress it (handled by the
      // `quote === "'"` fallthrough below, since paramExpansionEnd is only
      // reached when quote !== "'").
      if (c === "$" && quote === '"') {
        const pend = paramExpansionEnd(text, i);
        if (pend !== -1) { i = pend; continue; }
      }
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
    if (c === "$") {
      const pend = paramExpansionEnd(text, i);
      if (pend !== -1) { i = pend; continue; } // `$name`/`${…}`: delete to unset→empty
      // else literal `$` (`$(`, `$.`, lone `$`) — fall through
    }
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; } // line continuation: drop both
      value += text[i + 1] ?? ""; // escape: drop backslash, keep char
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (backtickQuotes && c === "`")) {
      quote = c;
      continue;
    }
    if (stopAtWordBoundary && WORD_BOUNDARY.test(c)) break;
    value += c;
  }
  return { value, end: Math.min(i, text.length) };
}
