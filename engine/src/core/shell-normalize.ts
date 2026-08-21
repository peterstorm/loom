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
 * a var is set. Most forms (`$x`, `${x}`, specials, `${x:?w}` error, transforms,
 * substring) yield EMPTY on unset and are DELETED: reveal-monotonic for the
 * guard — `rm .claude/stat${x}e/…` collapses to `.claude/state/…` and the
 * guarded literal reassembles. The default/assign-default forms
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
 * (they can never expand to empty). The ALTERNATE forms (`${x:+w}`/`${x+w}`) are
 * the MIRROR: they yield EMPTY on unset (the primary view deletes them, exactly
 * as before) but the WORD `w` on set (`:+` set-non-null, `+` set), and `w` can
 * carry a guarded literal (`${PWD:+.claude/state/…}` — always-set `PWD` makes
 * bash run the delete). Deleting the span in the unset view is right, but the
 * set-state output must ALSO be tested or the guard fails OPEN (it ALLOWed a real
 * state write before round 24); the guard reveals `w` via the alternateFormsReveal
 * base in referencesPattern. `$'…'`, `$"…"`, and `$(…)` are NOT parameter
 * expansions and are handled separately (`$(…)` stays literal here — the guard
 * models command-substitution-to-empty in its own front gate, NOT here; both
 * callers run on UNFLATTENED text).
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
 *     unset (`${x:?w}`/`${x?}` error, `${#x}` length, `${!x}` indirect,
 *     `${x#p}`/`${x%p}`/`${x/a/b}`/`${x^^}`/`${x,,}` transforms, `${x:off:len}`
 *     substring). Deleted from the view.
 *   - `word`  — a form whose value under SOME variable state is the WORD `w`;
 *     `form`/`colonless` say which state, and thus which view reveals it:
 *       · `form: "default"` (`${x:-w}`/`${x-w}`/`${x:=w}`/`${x=w}`) yields `w`
 *         on unset — revealed in the PRIMARY view. Deleting it would CONCEAL a
 *         `w`-carried guarded literal (`${x:-.claude/state/…}`), the fail-open
 *         direction, so the caller recursively normalizes `[wordStart, end)`.
 *         `colonless` (`${x-w}`/`${x=w}`) marks the forms with a SECOND output:
 *         EMPTY when the var is set-but-empty (the colon forms substitute `w` on
 *         unset AND null, so `w` is their ONLY value). The guard tests the empty
 *         output too — see referencesPattern's colonless-empty base.
 *       · `form: "alternate"` (`${x:+w}`/`${x+w}`) is the MIRROR: EMPTY on unset
 *         (the primary view deletes it) but `w` on set (`:+` set-non-null, `+`
 *         set). `w` can carry a guarded literal (`${PWD:+.claude/state/…}`), so
 *         the guard must reveal it in a SECOND view or fail OPEN — see
 *         referencesPattern's alternate-reveal base. `colonless` is recorded for
 *         completeness but does not change the matching view (both alternate
 *         forms output either empty or `w`).
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
      readonly form: "default" | "alternate";
      readonly colonless: boolean;
      readonly wordStart: number;
      readonly end: number;
    };

/** Operators inside a `${name<op>word}` body that make the span contribute the
 *  literal `word` under SOME variable state — listed longest-first so `:-`/`:=`/
 *  `:+` win over a bare `:` (colon and single-char ops start with different
 *  chars, so order across the two lengths is defensive, not load-bearing). Two
 *  families, by what bash yields:
 *    - "default" (`:-`/`:=`/`-`/`=`): `word` on UNSET — the matching view's
 *      primary reveal. Colon forms yield `word` on null too, so `word` is their
 *      ONLY value; colonless forms yield EMPTY on set-but-empty (their second
 *      output — see ParamExpansion `colonless`).
 *    - "alternate" (`:+`/`+`): the MIRROR — EMPTY on unset (the primary view)
 *      and the literal `word` on set (`:+` set-non-null, `+` set). `word` can
 *      carry a guarded literal (`${PWD:+.claude/state/…}`), so the guard also
 *      tests a view that reveals it — see NormalizeOptions `alternateFormsReveal`.
 *      `:?`/`?` are NOT here: their `word` is a stderr error message, never
 *      substituted into the value. */
const WORD_OPS = [
  { op: ":-", form: "default", colonless: false },
  { op: ":=", form: "default", colonless: false },
  { op: ":+", form: "alternate", colonless: false },
  { op: "-", form: "default", colonless: true },
  { op: "=", form: "default", colonless: true },
  { op: "+", form: "alternate", colonless: true },
] as const;

function classifyBraceBody(text: string, start: number, close: number): ParamExpansion {
  const end = close + 1;
  let bodyStart = start + 2;
  let body = text.slice(bodyStart, close);
  // `#`-prefixed bodies (length) are always operator-free — `${#x:-w}` is a bash
  // syntax error — so a `#` body never carries a substitutable word.
  if (body[0] === "#") return { kind: "empty", end };
  // `!`-prefixed bodies are indirection. Pure indirect (`${!x}`), prefix-match
  // (`${!pre@}`/`${!pre*}`) and array-key (`${!arr[@]}`) forms carry no word, but
  // indirection COMBINES with a word operator (`${!x:-w}`/`${!x:+w}`/`${!x-w}`),
  // which substitutes `w` exactly like the non-indirect twin. Strip the `!` and
  // classify the remainder so that `w` is REVEALED, not concealed — concealing it
  // is the same fail-open bypass this file has fought across rounds (colonless,
  // nested, alternate forms).
  if (body[0] === "!") {
    bodyStart += 1;
    body = body.slice(1);
  }
  // Name: `[A-Za-z_]\w*`, positional digits, or a single special param, plus an
  // optional `[subscript]`. The operator (if any) starts right after.
  const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*?$!#0-])(\[[^\]]*\])?/);
  const nameLen = nameMatch ? nameMatch[0].length : 0;
  for (const { op, form, colonless } of WORD_OPS) {
    if (body.startsWith(op, nameLen)) {
      return {
        kind: "word",
        form,
        colonless,
        wordStart: bodyStart + nameLen + op.length,
        end,
      };
    }
  }
  return { kind: "empty", end }; // `${name}`, `:?`/`?` error, transforms, substring
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
 *
 * `alternateFormsReveal` (matching-view only) is the MIRROR for the alternate
 * forms (`${x:+w}`/`${x+w}`): it REVEALS `w` (recursively normalized) instead of
 * deleting the span — the guard's set-state output for these spans. The default
 * (flag absent/false) deletes them (the unset output), identical to the evidence
 * twin and to the pre-round-24 behavior; the reveal view is an ADDITIONAL guard
 * base, so a guarded literal carried in `w` (`${PWD:+.claude/state/…}`) cannot
 * slip past the front gate.
 */
export type NormalizeOptions =
  | {
      readonly mode: "matching-view";
      readonly colonlessDefaultsEmpty?: boolean;
      readonly alternateFormsReveal?: boolean;
    }
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
/** Reveal the word of a `word`-form expansion (`${x:-w}` / `${x:+w}`) as the
 *  value bash substitutes, recursively normalized. Always matching-view so the
 *  guard and the evidence twin reveal an IDENTICAL word regardless of the
 *  caller's mode — the word is a whole sub-span, not a boundary-terminated
 *  fragment. Both set-state flags are threaded from the enclosing span so a
 *  default/alternate form NESTED inside a revealed word (`${x:-${y-X}}`,
 *  `${x:-${PWD:+Y}}`) follows the same hypothesis at any depth — bash's output
 *  reassembles a fragmented guarded literal beyond one nesting level. */
type WordVariantCursor = { readonly mask: number; index: number };

function nextVariantReveal(cursor: WordVariantCursor): boolean {
  const reveal = (cursor.mask & (1 << cursor.index)) !== 0;
  cursor.index += 1;
  return reveal;
}

function revealWord(
  text: string,
  wordStart: number,
  end: number,
  colonlessEmpty: boolean,
  alternateReveal: boolean,
  variantCursor: WordVariantCursor | undefined,
): string {
  return normalizeShellSpanInternal(text.slice(wordStart, end - 1), 0, {
    mode: "matching-view",
    colonlessDefaultsEmpty: colonlessEmpty,
    alternateFormsReveal: alternateReveal,
  }, variantCursor).value;
}

/**
 * The value a `word`-form expansion contributes to the normalized view, by
 * family and the active set-state flags — the single source of truth for the
 * two normalizeShellSpan call sites (unquoted and double-quoted `$`) so they
 * cannot drift on the reveal rules, the concealment/fail-open bypass this file
 * has fought for rounds:
 *   - default (`${x:-w}`): reveal `w` (its unset output), EXCEPT a colonless
 *     default (`${x-w}`/`${x=w}`) under `colonlessEmpty`, which contributes
 *     nothing (its set-but-empty output).
 *   - alternate (`${x:+w}`): contribute nothing (its unset output), EXCEPT under
 *     `alternateReveal`, which reveals `w` (its set output).
 */
function wordContribution(
  text: string,
  pe: Extract<ParamExpansion, { kind: "word" }>,
  colonlessEmpty: boolean,
  alternateReveal: boolean,
  variantCursor: WordVariantCursor | undefined,
): string {
  let reveal: boolean;
  if (pe.form === "alternate") {
    reveal = variantCursor === undefined ? alternateReveal : nextVariantReveal(variantCursor);
  } else if (pe.colonless) {
    reveal = variantCursor === undefined ? !colonlessEmpty : nextVariantReveal(variantCursor);
  } else {
    reveal = true;
  }
  return reveal
    ? revealWord(text, pe.wordStart, pe.end, colonlessEmpty, alternateReveal, variantCursor)
    : "";
}

function normalizeShellSpanInternal(
  text: string,
  start: number,
  opts: NormalizeOptions,
  variantCursor: WordVariantCursor | undefined,
): NormalizedSpan {
  const { stopAtWordBoundary, backtickQuotes } = resolveMode(opts);
  const colonlessEmpty = opts.mode === "matching-view" && opts.colonlessDefaultsEmpty === true;
  const alternateReveal = opts.mode === "matching-view" && opts.alternateFormsReveal === true;
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
          value += wordContribution(text, pe, colonlessEmpty, alternateReveal, variantCursor);
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
      // `$name`/`${…}`: delete to unset→empty; word forms contribute `w` per
      // family and the active set-state flags (see wordContribution) — default
      // forms reveal `w`, alternate forms `${x:+w}` reveal it only under
      // alternateFormsReveal, colonless defaults collapse under colonlessDefaultsEmpty.
      if (pe.kind === "word") {
        value += wordContribution(text, pe, colonlessEmpty, alternateReveal, variantCursor);
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

export function normalizeShellSpan(
  text: string,
  start: number,
  opts: NormalizeOptions,
): NormalizedSpan {
  return normalizeShellSpanInternal(text, start, opts, undefined);
}

/**
 * Enumerate independent reveal/empty outcomes for every optional word-form
 * expansion encountered by the shared normalizer. Nested forms participate
 * only when their enclosing word is revealed. Treating syntax occurrences as
 * independent deliberately over-approximates bash variables that repeat: extra
 * views can only arm a guard, never conceal a real output. `null` means the
 * requested bound cannot cover the cross-product and callers must fail closed.
 */
export function normalizeShellVariants(
  text: string,
  start: number,
  maxVariants: number,
): readonly string[] | null {
  const allRevealed: WordVariantCursor = { mask: -1, index: 0 };
  normalizeShellSpanInternal(text, start, { mode: "matching-view" }, allRevealed);
  const variantCount = 2 ** allRevealed.index;
  if (!Number.isSafeInteger(variantCount) || variantCount > maxVariants) return null;

  const values = new Set<string>();
  for (let mask = 0; mask < variantCount; mask += 1) {
    const cursor: WordVariantCursor = { mask, index: 0 };
    values.add(normalizeShellSpanInternal(text, start, { mode: "matching-view" }, cursor).value);
  }
  return Object.freeze([...values]);
}
