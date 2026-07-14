/**
 * The ONE place bash word-normalization lives: quote stripping, backslash
 * escapes, `\`-newline line continuation, ANSI-C `$'…'` decoding (NUL truncates
 * the ANSI-C body), locale `$"…"` quoting, and unquoted/double-quoted parameter
 * expansion (`$name` / `${…}`). Both the guard's matching view
 * (core/guard-state-file `collapseQuotes`) and the evidence scanner's
 * redirect-target reader (machine/extract-evidence `readRedirectTarget`) build
 * on this, so a rule taught to one (ANSI-C in round 17, line-continuation + NUL
 * in round 18, parameter expansion in round 19) can never again be missing from
 * the other — the "twin scanners diverged" bug class that recurred rounds 15–18
 * becomes structurally impossible for the normalization layer. (Structural
 * scanning — segment splitting, fd-dup classification — is already shared via
 * extract-evidence's splitCommandSegmentsWithOps / classifyFdDupWord.)
 *
 * Parameter expansion is modeled as the value bash yields when the variable is
 * UNSET — the conservative reveal for a matching layer that cannot know whether
 * a var is set. Most forms (`$x`, `${x}`, specials, `${x:+w}` alternate,
 * transforms, substring) yield EMPTY on unset and are DELETED: reveal-monotonic
 * for the guard — `rm .claude/stat${x}e/…` collapses to `.claude/state/…` and
 * the guarded literal reassembles. The default/assign-default forms
 * (`${x:-w}`/`${x-w}`/`${x:=w}`/`${x=w}`) instead yield the WORD `w`, which can
 * itself carry a guarded literal (`${x:-.claude/state/…}`); deleting the span
 * would CONCEAL it (reveal-less — the fail-open direction that ALLOWed a real
 * state deletion before round 20), so the word is recursively normalized and
 * revealed. Both consumers stay point-wise identical (the word is revealed in
 * matching-view for guard and evidence twin alike). The COLONLESS forms
 * (`${x-w}`/`${x=w}`) have a SECOND bash output the colon forms don't: when the
 * var is set-but-empty they expand to EMPTY, and `.claude/stat${x-X}e` then
 * reassembles to `.claude/state` — a guarded literal the word-reveal view
 * conceals (the round-20 regression). The guard tests BOTH via the
 * colonlessDefaultsEmpty base in referencesPattern; colon forms stay reveal-only
 * (they can never expand to empty). `$'…'`, `$"…"`, and `$(…)`
 * are NOT parameter expansions and are handled separately (`$(…)` stays literal
 * here — the guard models command-substitution-to-empty in its own front gate,
 * NOT here; both callers run on UNFLATTENED text).
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
 * The parse of a `$…` span, discriminating the value bash produces when the
 * variable is UNSET — the only bash-accurate view for the guard's matching
 * layer (a rule cannot know whether a var is set, so unset is the conservative
 * reveal):
 *
 *   - `none`  — the `$` is literal (`$(`, `$'`, `$"`, `$ `, `$.`, lone `$`).
 *   - `empty` — the span expands to the empty string on unset: `$name`,
 *     `${name}`, special params, and the modifier forms that yield empty when
 *     unset (`${x:+w}`/`${x+w}` alternate, `${x:?w}`/`${x?}` error, `${#x}`
 *     length, `${!x}` indirect, `${x#p}`/`${x%p}`/`${x/a/b}`/`${x^^}`/`${x,,}`
 *     transforms, `${x:off:len}` substring). Deleted from the view.
 *   - `word`  — a default/assign-default form (`${x:-w}`/`${x-w}`/`${x:=w}`/
 *     `${x=w}`) whose value on unset is the WORD `w`, not empty. `w` can carry a
 *     guarded literal (`${x:-.claude/state/…}`), so deleting the whole span
 *     would CONCEAL it — reveal-less, the fail-open direction. The caller
 *     recursively normalizes `[wordStart, end)` and reveals its value instead.
 *     `colonless` distinguishes `${x-w}`/`${x=w}` from `${x:-w}`/`${x:=w}`:
 *     the colon forms substitute `w` on unset AND null, so `w` is their ONLY
 *     value; the colonless forms substitute `w` only on unset and expand to
 *     EMPTY when the var is set-but-empty. So a colonless span has two bash
 *     outputs (`w` and empty) and the guard must test both — see
 *     referencesPattern's colonless-empty base.
 *
 * `end` is the index one PAST the span's last char (the char after `}` / after
 * the name). `${…}` consumes to its brace-depth-matched close so nested
 * `${a${b}}` is handled; an unbalanced `${` is `none` (left literal) so the span
 * is never over-consumed.
 */
type ParamExpansion =
  | { readonly kind: "none" }
  | { readonly kind: "empty"; readonly end: number }
  | {
      readonly kind: "word";
      readonly colonless: boolean;
      readonly wordStart: number;
      readonly end: number;
    };

/** Word-emitting default/assign-default operators keyed by their form inside a
 *  `${name<op>word}` body, longest-first so `:-`/`:=` win over a bare `:`. On
 *  UNSET each yields the literal `word`; every other operator yields empty. The
 *  colon forms also yield `word` on NULL; the colonless forms yield EMPTY on
 *  null (see ParamExpansion `colonless`). */
const DEFAULT_WORD_OPS = [":-", ":=", "-", "="] as const;

function classifyBraceBody(text: string, start: number, close: number): ParamExpansion {
  const end = close + 1;
  const bodyStart = start + 2;
  const body = text.slice(bodyStart, close);
  // `#`/`!`-prefixed bodies (length, indirection, prefix-match) expand empty on
  // unset — never a default word.
  if (body[0] === "#" || body[0] === "!") return { kind: "empty", end };
  // Name: `[A-Za-z_]\w*`, positional digits, or a single special param, plus an
  // optional `[subscript]`. The operator (if any) starts right after.
  const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*?$!#0-])(\[[^\]]*\])?/);
  const nameLen = nameMatch ? nameMatch[0].length : 0;
  for (const op of DEFAULT_WORD_OPS) {
    if (body.startsWith(op, nameLen)) {
      return {
        kind: "word",
        colonless: op === "-" || op === "=",
        wordStart: bodyStart + nameLen + op.length,
        end,
      };
    }
  }
  return { kind: "empty", end }; // `${name}`, `:+`/`+`, `:?`/`?`, transforms, substring
}

/**
 * Parse a `$…` parameter expansion at `text[start] === "$"`. See ParamExpansion.
 */
function paramExpansionEnd(text: string, start: number): ParamExpansion {
  const next = text[start + 1];
  if (next === undefined) return { kind: "none" };
  if (next === "{") {
    let depth = 1;
    for (let j = start + 2; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) return classifyBraceBody(text, start, j);
    }
    return { kind: "none" }; // unbalanced `${` — leave literal, caller fails closed elsewhere
  }
  if (/[A-Za-z_]/.test(next)) {
    let j = start + 2;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
    return { kind: "empty", end: j };
  }
  if (SPECIAL_PARAM.test(next)) return { kind: "empty", end: start + 2 };
  return { kind: "none" };
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
 *
 * `colonlessDefaultsEmpty` (matching-view only) makes a colonless default form
 * (`${x-w}`/`${x=w}`) expand to EMPTY instead of revealing `w` — the guard's
 * SECOND bash output for these spans (the var is set-but-empty). The default
 * (flag absent/false) reveals `w`, keeping the guard and the evidence twin
 * point-wise identical for the primary view; the empty view is an ADDITIONAL
 * guard base (referencesPattern), not a redirect-word behavior.
 */
export type NormalizeOptions =
  | { readonly mode: "matching-view"; readonly colonlessDefaultsEmpty?: boolean }
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
/** Reveal the default word of a `word`-form expansion (`${x:-w}`) as the value
 *  bash yields on unset. Always matching-view so the guard and the evidence
 *  twin reveal an IDENTICAL word regardless of the caller's mode — the word is
 *  a whole sub-span, not a boundary-terminated fragment. */
function revealDefaultWord(text: string, wordStart: number, end: number): string {
  return normalizeShellSpan(text.slice(wordStart, end - 1), 0, { mode: "matching-view" }).value;
}

export function normalizeShellSpan(
  text: string,
  start: number,
  opts: NormalizeOptions,
): NormalizedSpan {
  const { stopAtWordBoundary, backtickQuotes } = resolveMode(opts);
  const colonlessEmpty = opts.mode === "matching-view" && opts.colonlessDefaultsEmpty === true;
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
        const pe = paramExpansionEnd(text, i);
        if (pe.kind === "word") {
          if (!(colonlessEmpty && pe.colonless)) value += revealDefaultWord(text, pe.wordStart, pe.end);
          i = pe.end - 1; continue;
        }
        if (pe.kind === "empty") { i = pe.end - 1; continue; }
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
      const pe = paramExpansionEnd(text, i);
      // `$name`/`${…}`: delete to unset→empty; default forms (`${x:-w}`) reveal `w`,
      // except colonless forms under colonlessDefaultsEmpty (their set-empty output).
      if (pe.kind === "word") {
        if (!(colonlessEmpty && pe.colonless)) value += revealDefaultWord(text, pe.wordStart, pe.end);
        i = pe.end - 1; continue;
      }
      if (pe.kind === "empty") { i = pe.end - 1; continue; }
      // else `none`: literal `$` (`$(`, `$.`, lone `$`) — fall through
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
