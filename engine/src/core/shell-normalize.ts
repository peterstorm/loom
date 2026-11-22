/**
 * The ONE place bash word-normalization lives: quote stripping, backslash
 * escapes, `\`-newline line continuation, ANSI-C `$'…'` decoding (NUL truncates
 * the ANSI-C body), locale `$"…"` quoting, and unquoted/double-quoted parameter
 * expansion (`$name` / `${…}`). Both the guard's matching view
 * (core/guard-state-file `collapseVariants`) and the evidence scanner's
 * redirect-target reader (core/shell-redirects `redirectTargetsOf`) build
 * on this, so a rule taught to one (ANSI-C in round 17, line-continuation + NUL
 * in round 18, parameter expansion in round 19) can never again be missing from
 * the other — the "twin scanners diverged" bug class that recurred rounds 15–18
 * becomes structurally impossible for the normalization layer. Structural
 * scanning — segment splitting and fd-dup classification — is owned beside it
 * by `core/shell-command.ts`.
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
 * conceals (the round-20 regression). The guard tests BOTH: `collapseVariants`
 * reads `normalizeShellVariants`, whose cross-product holds the colonless
 * empty output as one enumerated view; colon forms stay reveal-only (they can
 * never expand to empty). The ALTERNATE forms (`${x:+w}`/`${x+w}`) are
 * the MIRROR: they yield EMPTY on unset (the primary view deletes them, exactly
 * as before) but the WORD `w` on set (`:+` set-non-null, `+` set), and `w` can
 * carry a guarded literal (`${PWD:+.claude/state/…}` — always-set `PWD` makes
 * bash run the delete). Deleting the span in the unset view is right, but the
 * set-state output must ALSO be tested or the guard fails OPEN (it ALLOWed a real
 * state write before round 24); the guard reveals `w` through the same
 * `collapseVariants` cross-product (the alternate form's set-state output is an
 * enumerated view). `$'…'`, `$"…"`, and `$(…)` are NOT parameter
 * expansions and are handled separately (`$(…)` stays literal here — the guard
 * models command-substitution-to-empty in its own front gate, NOT here; both
 * callers run on UNFLATTENED text).
 */

import { decodeAnsiC, findAnsiCClose } from "./shell-ansi-c";

/** Unquoted chars that end a word for the redirect-target reader. Includes the
 *  segment separators `|` and `;` and the control operator `&` so a redirect
 *  word stops at a command boundary even if the caller ever passes text that is
 *  NOT pre-split on those operators. (`redirectTargetsOf` today receives
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
 *         output too — see normalizeShellVariants.
 *       · `form: "alternate"` (`${x:+w}`/`${x+w}`) is the MIRROR: EMPTY on unset
 *         (the primary view deletes it) but `w` on set (`:+` set-non-null, `+`
 *         set). `w` can carry a guarded literal (`${PWD:+.claude/state/…}`), so
 *         the guard must reveal it in a SECOND view or fail OPEN — see
 *         normalizeShellVariants. `colonless` is recorded for
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
 *      tests a view that reveals it — see RevealChoice.
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
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
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
 * The two — and only two — coherent normalization modes:
 *
 *   - `"matching-view"` (guard `collapseVariants`, through
 *     `normalizeShellVariants`): consume to the end of `text` and treat an
 *     unquoted backtick as a LITERAL. Backticks stay literal because guarded
 *     patterns contain no backtick, so keeping the char is reveal-monotonic —
 *     it can only ever fail to hide a guarded token, never conceal one. (The
 *     front gate and placeholderFor run on UNFLATTENED text, so it is NOT that
 *     substitutions were already removed.)
 *   - `"redirect-word"` (evidence `redirectTargetsOf`, through
 *     `normalizeShellSpan`): stop (exclusive) at the first UNQUOTED word
 *     boundary (whitespace, `>` `<` `&` `(` `)` `|` `;`) and treat an unquoted
 *     backtick as a QUOTE so a `` >`cmd` `` target does not split
 *     mid-substitution.
 */
type NormalizeMode = "matching-view" | "redirect-word";

/**
 * One optional word form: a form with two outputs — a colonless default
 * (`${x-w}`/`${x=w}`: `w` on unset, EMPTY on set-but-empty) or an alternate
 * form (`${x:+w}`/`${x+w}`: EMPTY on unset, `w` on set). `at` is its identity:
 * the index its word `w` starts at in the text the walk began on, at any
 * nesting depth. A colon default's `w` is its only output and is never a choice.
 */
type OptionalForm = Readonly<{ kind: "colonless-default" | "alternate"; at: number }>;

/**
 * Which output each optional form contributes to a view: true reveals its word
 * `w`, false makes it EMPTY. A pure function of the form, so a view never
 * depends on the order or the number of times the walk asks; a form nested in
 * an emptied word is simply never asked.
 */
type RevealChoice = (form: OptionalForm) => boolean;

/** Every variable unset: a colonless default yields its word, an alternate
 *  form nothing. The evidence reader's one view. */
const UNSET_VIEW: RevealChoice = ({ kind }) => kind === "colonless-default";

/**
 * The value a `word`-form expansion contributes to the normalized view: its
 * word, recursively normalized, unless `reveal` empties it. Always
 * matching-view, so the guard and the evidence reader reveal an IDENTICAL word
 * regardless of the caller's mode — the word is a whole sub-span, not a
 * boundary-terminated fragment — and the same `reveal` threads into the word,
 * so a form NESTED inside a revealed word (`${x:-${y-X}}`, `${x:-${PWD:+Y}}`)
 * follows its own choice at any depth: bash's output reassembles a fragmented
 * guarded literal beyond one nesting level. The single source of truth for
 * the unquoted and double-quoted `$` call sites, so they cannot drift on the
 * reveal rules (the concealment/fail-open bypass this file has fought for
 * rounds). `base` is where `text` starts in the text the walk began on.
 */
function wordContribution(
  text: string,
  pe: Extract<ParamExpansion, { kind: "word" }>,
  reveal: RevealChoice,
  base: number,
): string {
  const at = base + pe.wordStart;
  let shown = true;
  if (pe.form === "alternate") shown = reveal({ kind: "alternate", at });
  else if (pe.colonless) shown = reveal({ kind: "colonless-default", at });
  return shown
    ? normalizeShellSpanInternal(text.slice(pe.wordStart, pe.end - 1), 0, "matching-view", reveal, at).value
    : "";
}

/**
 * Normalize the span of `text` starting at `start` to the literal characters
 * bash produces, applying every quote/escape/ANSI-C rule exactly once. The
 * decisions here are the shared contract; callers differ only by `mode` (see
 * NormalizeMode), which selects where a span ends and whether backticks quote,
 * and by `reveal`, which selects the variable state. `base` is where `text`
 * starts in the text the walk began on (non-zero only inside a revealed word),
 * so every optional form is named by one index at any depth. Caveat: for
 * double-quoted `\c` where `c` is a non-special char, bash KEEPS the backslash
 * (`"a\c"` → `a\c`) but this normalizer DROPS it (→ `ac`); that
 * over-normalizes — reveal-monotonic for the guard (can only expose a guarded
 * token, never hide one) but over-mints for the evidence reader.
 */
function normalizeShellSpanInternal(
  text: string,
  start: number,
  mode: NormalizeMode,
  reveal: RevealChoice,
  base: number,
): NormalizedSpan {
  const redirectWord = mode === "redirect-word";
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
          value += wordContribution(text, pe, reveal, base);
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
      // family and `reveal` (see wordContribution).
      if (pe.kind === "word") {
        value += wordContribution(text, pe, reveal, base);
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
    if (c === '"' || c === "'" || (redirectWord && c === "`")) {
      quote = c;
      continue;
    }
    if (redirectWord && WORD_BOUNDARY.test(c)) break;
    value += c;
  }
  return { value, end: Math.min(i, text.length) };
}

/**
 * The redirect target word starting at `start`, normalized the way bash
 * reads it with every variable unset (the evidence reader's one view): it
 * ends (exclusive) at the first unquoted word boundary, and an unquoted
 * backtick quotes.
 */
export function normalizeShellSpan(text: string, start: number): NormalizedSpan {
  return normalizeShellSpanInternal(text, start, "redirect-word", UNSET_VIEW, 0);
}

/** Every optional form the matching view of `text` from `start` can ask about:
 *  the walk with every word revealed, so each nested form is reached. */
function optionalForms(text: string, start: number): readonly number[] {
  const forms = new Set<number>();
  normalizeShellSpanInternal(text, start, "matching-view", ({ at }) => {
    forms.add(at);
    return true;
  }, 0);
  return [...forms];
}

/**
 * Every text bash may produce for `text` from `start` (matching-view): each
 * optional word form (see OptionalForm) is an independent reveal/empty
 * outcome, and the result holds every combination. View `k` reveals the forms
 * whose bit is set in `k`, addressed by each form's identity, so a nested form
 * inside an emptied word only repeats a view. Treating syntax occurrences as
 * independent deliberately over-approximates bash variables that repeat:
 * extra views can only arm a guard, never conceal a real output. `null` means
 * the requested bound cannot cover the cross-product and callers must fail
 * closed.
 */
export function normalizeShellVariants(
  text: string,
  start: number,
  maxVariants: number,
): readonly string[] | null {
  const forms = optionalForms(text, start);
  const variantCount = 2 ** forms.length;
  if (!Number.isSafeInteger(variantCount) || variantCount > maxVariants) return null;

  const values = new Set<string>();
  for (let view = 0; view < variantCount; view += 1) {
    const revealed = new Set(forms.filter((_, bit) => Math.floor(view / 2 ** bit) % 2 === 1));
    values.add(normalizeShellSpanInternal(text, start, "matching-view", ({ at }) => revealed.has(at), 0).value);
  }
  return Object.freeze([...values]);
}
