/**
 * The matching-view layer of the shell grammar: every text bash could form
 * from one command line (quote collapse, parameter-expansion states, brace
 * expansion, single-char classes, substitution outputs) and the glob
 * intersection test against a directory. A guard asks "could this text name
 * that path under ANY of these views?" — reveal-monotonic, fail-closed.
 *
 * Pure. Extracted from core/guard-state-file, whose scope predicates are built
 * on referencesPattern.
 */

import { normalizeShellVariants } from "./shell-normalize";
import { scanSubstitutions, type SubstitutionContext } from "./shell-substitution";

/** Maximum per-expansion parameter-state views before the guard fails closed. */
const MAX_PARAMETER_VIEWS = 256;

/**
 * Every bounded reveal/empty cross-product for optional parameter words.
 *
 * Choices are per syntax occurrence, not global axes: separate colonless
 * defaults and alternate forms can occupy different states in one real shell
 * invocation. Repeated references to one variable are deliberately allowed to
 * vary independently here; those extra views over-approximate bash and can only
 * arm the guard. `null` means the cross-product exceeded the bound, which the
 * caller treats as a guarded reference rather than silently truncating it.
 */
export function collapseVariants(text: string): readonly string[] | null {
  return normalizeShellVariants(text, 0, MAX_PARAMETER_VIEWS);
}

/** Product of brace-group sizes above which a braced line is deemed
 *  unparseable (fail closed). 8 two-option groups = 256 views. */
const MAX_BRACE_VIEWS = 256;

/** Options of a `{…}` sequence body (`a..c`, `1..3`, `3..1`, `a..y..4`,
 *  `10..1..-3`), or null when the body is not a sequence. Covers the forms
 *  bash expands: alpha and signed-integer endpoints, optionally stepped
 *  (`{x..y..s}`). Direction is taken from the ENDPOINTS (bash ignores the
 *  step's sign — `{1..5..-1}` ascends, `{10..1..3}` descends); the step's
 *  MAGNITUDE is used, and a zero step means a full step-1 enumeration
 *  (verified against real bash). A body whose endpoints mix alpha and
 *  numeric types, or carry any other shape, is literal in bash and returns
 *  null. Numeric step-1 ranges whose enumeration would exceed
 *  MAX_BRACE_VIEWS return null so the caller's bound (expandBraces → null →
 *  fail closed) still engages instead of materializing unbounded views. */
function sequenceOptions(content: string): string[] | null {
  const seq = content.match(/^([A-Za-z]|[+-]?\d+)\.\.([A-Za-z]|[+-]?\d+)(?:\.\.([+-]?\d+))?$/);
  if (seq === null) return null;
  const first = seq[1], second = seq[2], stepText = seq[3];
  const firstIsAlpha = /^[A-Za-z]$/.test(first);
  const secondIsAlpha = /^[A-Za-z]$/.test(second);
  if (firstIsAlpha !== secondIsAlpha) return null; // `{a..10..2}` stays literal in bash
  const magnitude = Math.max(1, Math.abs(parseInt(stepText ?? "1", 10)));
  const out: string[] = [];
  if (firstIsAlpha) {
    const a = first.charCodeAt(0), b = second.charCodeAt(0);
    const direction = a <= b ? 1 : -1;
    for (let c = a; direction > 0 ? c <= b : c >= b; c += direction * magnitude) {
      out.push(String.fromCharCode(c));
    }
    return out;
  }
  const a = parseInt(first, 10), b = parseInt(second, 10);
  const direction = a <= b ? 1 : -1;
  // Zero-padding fidelity (verified against real bash): when either
  // endpoint's digits start with `0`, every produced integer is rendered
  // left-padded so its TOTAL length (sign included) equals the longer RAW
  // endpoint string, exactly as bash does (`{01..100}` → `001 … 100`;
  // `{-5..-01}` → `-05 … -01`). `{0..0}` stays unpadded: a lone `0`
  // endpoint is not a padded form.
  const digits = (s: string): string => s.replace(/^[+-]/, "");
  const padWidth = Math.max(first.length, second.length);
  // An endpoint is a PADDED form only when its own digit run is longer than one
  // AND starts with `0`. Testing `startsWith("0")` alone made a lone `0`
  // endpoint padded whenever its partner was wider: `{0..10}` rendered
  // `00 01 … 10` where bash renders `0 1 … 10`. (`{0..0}` was right by accident
  // — `padWidth > 1` alone caught it — which is why the existing single
  // padded fixture, asserted as `allow`, could never fail.) Pinned by the
  // differential sweep against real bash in
  // `tests/core/guard-state-file-coverage.test.ts`.
  const padded = [first, second].some((s) => digits(s).length > 1 && digits(s).startsWith("0"));
  const render = (c: number): string => {
    if (!padded) return String(c);
    const negative = c < 0;
    const body = String(Math.abs(c)).padStart(padWidth - (negative ? 1 : 0), "0");
    return (negative ? "-" : "") + body;
  };
  for (let c = a; direction > 0 ? c <= b : c >= b; c += direction * magnitude) {
    out.push(render(c));
    if (out.length > MAX_BRACE_VIEWS) return null;
  }
  return out;
}

interface BraceGroup { readonly start: number; readonly end: number; readonly options: readonly string[]; }

/** First EXPANDABLE `{…}` group in text (has a top-level comma, or is a
 *  sequence), depth-aware so nested braces don't split early. A brace with no
 *  matching close, or a `{…}` with neither comma nor sequence, is literal in
 *  bash and skipped. */
function firstBraceGroup(text: string): BraceGroup | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 1, j = i + 1;
    const commas: number[] = [];
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) break; }
      else if (c === "," && depth === 1) commas.push(j);
    }
    if (depth !== 0) continue; // unbalanced from here: this `{` is literal
    const end = j;
    if (commas.length > 0) {
      const options: string[] = [];
      let prev = i + 1;
      for (const cpos of commas) { options.push(text.slice(prev, cpos)); prev = cpos + 1; }
      options.push(text.slice(prev, end));
      return { start: i, end, options };
    }
    const seq = sequenceOptions(text.slice(i + 1, end));
    if (seq) return { start: i, end, options: seq };
    i = end; // non-expandable group: resume scanning after its close
  }
  return null;
}

/**
 * Bounded bash brace expansion of a matching view — expands comma groups
 * (`st{a,a}te` → [`state`]) and sequences (`{a..c}`) into every alternative so
 * a guarded literal fragmented across brace syntax reassembles in at least one
 * view. Reveal-monotonic: every produced string is one bash could form.
 * Returns null when the view count would exceed MAX_BRACE_VIEWS — an unbounded
 * expansion on a guarded-shaped line is nobody's real command; the caller
 * fails closed.
 */
export function expandBraces(text: string): string[] | null {
  const results: string[] = [];
  const stack: string[] = [text];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    // `cur` has left the stack: it still counts toward the bound.
    if (results.length + stack.length + 1 > MAX_BRACE_VIEWS) return null;
    const group = firstBraceGroup(cur);
    if (group === null) { results.push(cur); continue; }
    for (const opt of group.options) {
      stack.push(cur.slice(0, group.start) + opt + cur.slice(group.end + 1));
    }
  }
  return results;
}

/** `[c]` matches exactly `c`; reveal it in the matching view. Multi-char
 *  (`[ab]`), negated (`[!a]`), and range (`[a-z]`) classes stay for the
 *  glob-intersection test. `/` never appears in a bash glob class operand. */
function collapseSingleCharClass(text: string): string {
  return text.replace(/\[([^!^/\]])\]/g, "$1");
}

/**
 * The matching view's model of a substitution's statically-unknowable OUTPUT
 * (placeholderFor, wildcardSubstitutions). It is deliberately NOT the glob `*`:
 * an unquoted `*` written by the agent obeys bash's leading-dot rule, but
 * `$(printf .lo)om` really can produce `.loom`, so this wildcard must keep
 * matching a leading `.`. A character outside every shell syntax class, so —
 * like the literal placeholder parts — it can never form a redirect,
 * separator, quote, or expansion. Rendered as `∗` (U+2217) in block messages.
 */
export const OPAQUE_OUTPUT = "\u2217";

/** A character that makes a token a glob for the guarded-dir intersection. */
export const GLOB_CHAR = new RegExp(`[*?[${OPAQUE_OUTPUT}]`);

/**
 * May a wildcard (`*`, `?`, `[…]`) match a path segment's LEADING `.`? Bash's
 * default (no `dotglob`) — and zsh's (no `GLOB_DOTS`) — is no: the dot must be
 * written explicitly (`.l*`, `.loo?`, `.[l]oom`, `.*`). A command line that so
 * much as names a switch able to flip that (`shopt -s dotglob`, `GLOBIGNORE=`,
 * `BASHOPTS=…`, zsh `setopt globdots`) is judged with wildcards matching dots
 * — fail closed: the guard cannot tell which segment the switch precedes.
 */
export type LeadingDotPolicy = "explicit-only" | "wildcards-match";

const DOT_GLOB_ENABLERS = /dotglob|glob_?dots|GLOBIGNORE|BASHOPTS/i;

export const leadingDotPolicyOf = (command: string): LeadingDotPolicy =>
  DOT_GLOB_ENABLERS.test(command) ? "wildcards-match" : "explicit-only";

/** Under the default policy, can this glob segment's first character match a
 *  literal leading `.`? Only an explicit `.`, a substitution's opaque output,
 *  or a non-negated bracket expression listing `.` (POSIX leaves that case
 *  unspecified — fail closed). `*`, `?`, ranges, and negated classes cannot. */
function leadingDotReachable(glob: string): boolean {
  const first = glob[0];
  if (first === "." || first === OPAQUE_OUTPUT) return true;
  if (first !== "[") return false;
  const close = glob.indexOf("]", 1);
  if (close === -1) return false; // a lone `[` is the literal `[`, never `.`
  const body = glob.slice(1, close);
  return !body.startsWith("!") && !body.startsWith("^") && body.includes(".");
}

/** fnmatch one path segment: does the glob segment (bash `*`/`?`/`[…]`, none
 *  crossing `/`, plus the substitution wildcard OPAQUE_OUTPUT) match the
 *  literal segment exactly? Bash's leading-dot rule applies unless `policy`
 *  says a dotglob switch may be on. A malformed class fails closed (matches). */
export function segmentGlobMatches(glob: string, literal: string, policy: LeadingDotPolicy): boolean {
  if (policy === "explicit-only" && literal.startsWith(".") && !leadingDotReachable(glob)) return false;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" || c === OPAQUE_OUTPUT) re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) { re += "\\["; continue; }
      const body = glob.slice(i + 1, close);
      re += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body).replace(/\\/g, "\\\\") + "]";
      i = close;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  try { return new RegExp(re).test(literal); } catch { return true; }
}

/** Could this token — an unquoted glob (star/question/`[…]`) — expand to a
 *  path that reaches AT or INTO one of the given guarded dirs? True when the
 *  dir's segments are a leading fnmatch of the token's, so a globbed state-dir
 *  prefix or a `rm /tmp/<star>` both enter scope even though no literal
 *  survives collapse. `.` segments are dropped first — `./.l*` names exactly
 *  what `.l*` names, so a leading `./` cannot shift the alignment past the
 *  guarded dir. */
function tokenGlobHitsGuardedDir(
  token: string,
  dirs: readonly (readonly string[])[],
  policy: LeadingDotPolicy,
): boolean {
  if (!GLOB_CHAR.test(token)) return false;
  const tok = token.split("/").filter((s) => s !== "" && s !== ".");
  return dirs.some(
    (dir) => tok.length >= dir.length && dir.every((seg, k) => segmentGlobMatches(tok[k], seg, policy)),
  );
}

/**
 * A matching view where command/process substitutions and backticks are
 * collapsed to EMPTY — one output a substitution can produce (`$(:)` → "",
 * `` `false` `` → ""). bash reassembles a guarded literal fragmented across
 * such a substitution (`.claude/stat$(:)e` → `.claude/state`), which the
 * substitutions-LITERAL view conceals; testing BOTH views (see
 * referencesPattern) closes that fragmentation channel while the literal view
 * still surfaces a guarded token sitting INSIDE a body, so flattenSubstitutions
 * + recursive judging still engages for a write hidden in a substitution.
 * Reveal-monotonic: emptying a span only JOINS the literal fragments around it,
 * exactly as an empty-output substitution does. Quote-awareness is delegated to
 * scanSubstitutions (single quotes suppress substitution; a `'` inside double
 * quotes stays literal); an unclosed opener blanks to end (maximal reveal —
 * decide() fails such unbalanced lines closed anyway).
 *
 * EXPORTED for the walker-divergence property net. */
export function blankSubstitutions(text: string): string {
  return scanSubstitutions(text, () => "").rebuilt;
}

/**
 * A matching view where command/process substitutions and backticks are
 * replaced by the substitution WILDCARD (OPAQUE_OUTPUT, matched like `*` but
 * exempt from the leading-dot rule) — modeling the THIRD output channel the
 * empty and literal views miss: a substitution whose runtime output is a
 * NONEMPTY fragment that COMPLETES a guarded literal when concatenated with the
 * literal text around it. `rm -rf .claude/stat$(printf e)` reassembles to
 * `.claude/state` bash-side (verified against real bash), but the empty view
 * DROPS the completing `e` (`.claude/stat` → no match) and the literal view
 * keeps `$(printf e)` inline (no `.claude/state`) — neither models output that
 * ADDS characters joining two literal fragments into a guarded token. Since a
 * substitution's output is not statically knowable, `*` is the fail-closed
 * model: referencesPattern's existing per-segment glob / guarded-dir
 * intersection test then fires whenever the surrounding literal plus the
 * wildcard can reach a guarded path (`.claude/stat*` fnmatches the
 * `.claude/state` dir; `.claude/*` reaches it too). Reveal-monotonic and
 * strictly ADDITIVE — this base is tested ALONGSIDE the empty and literal bases
 * (see referencesPattern), never instead of them, so it can only surface MORE
 * references, never hide one. Quote-awareness and the opener set are delegated
 * to the shared scanSubstitutions, so the completion view cannot diverge from
 * the empty view on quoting. Nested forms (`${x:-$(printf e)}` default,
 * `${PWD:+$(printf e)}` alternate) are covered because the wildcard is left in
 * the default/alternate word for collapseVariants to reveal (`${x:-*}` → `*`).
 */
function wildcardSubstitutions(text: string): string {
  return scanSubstitutions(text, (_body, context) => knownWordOutput(context) ?? OPAQUE_OUTPUT).rebuilt;
}

/**
 * The one substitution whose output the guard can know: a `cat` quoted
 * heredoc (`staticHeredocCat`) standing as an entire double-quoted word —
 * `gh pr create --body "$(cat <<'EOF' … EOF)"`. Its output is the literal body,
 * one word that joins no adjacent text, so it cannot COMPLETE a guarded
 * literal the way an opaque output can; it stands as KNOWN_TEXT, a neutral
 * token of letters and `_` that matches no guarded pattern and can form no
 * redirect, separator, quote or glob. Whether the literal itself names
 * guarded state is still judged: the substitutions-LITERAL view keeps the body
 * text inline, and placeholderFor classifies the body before reaching this.
 * Every other substitution — an unquoted delimiter, any other command,
 * unquoted or adjacent placement — keeps the opaque-output wildcard.
 * bash 3.2 (macOS `/bin/bash`) mis-parses this form, closing `$(` by quote-
 * tracked paren scanning; an apostrophe in the body is then a syntax error and
 * nothing runs. Any shorter span it could pick still lies inside the body,
 * whose text is judged for guarded references either way.
 */
const KNOWN_TEXT = "known_heredoc_text";

export function knownWordOutput(context: SubstitutionContext): string | null {
  return context.kind === "known-word" ? KNOWN_TEXT : null;
}

/**
 * Does the text reference a guarded path under EVERY bash word-expansion that
 * can reassemble a guarded literal (quote collapse, substitution-to-empty,
 * brace expansion, single-char class reveal) or reach a guarded directory via a
 * residual glob? Reveal-monotonic and fail-closed: an unbounded brace expansion
 * counts as a reference. This is the front gate and chain/segment scope
 * predicate. THREE substitution base views are tested — substitutions LITERAL
 * (surfaces a guarded token inside a body), substitutions EMPTY (surfaces a
 * literal fragmented across an empty-output `$(…)`/backtick, which joins the
 * fragments bash-side), and substitutions WILDCARD (surfaces a literal
 * COMPLETED by a nonempty substitution output — `.claude/stat$(printf e)` →
 * `.claude/state`, caught as the glob `.claude/stat*` reaching the guarded
 * dir). All three are additive: a reference under any one blocks.
 */
export function referencesPattern(
  text: string,
  pattern: RegExp,
  dirs: readonly (readonly string[])[],
  policy: LeadingDotPolicy,
): boolean {
  const blanked = blankSubstitutions(text);
  const completed = wildcardSubstitutions(text);
  // Reveal-monotonic bases, deduped: substitutions LITERAL vs EMPTY vs WILDCARD,
  // each under every bounded per-expansion parameter-state cross-product. An
  // unbounded parameter view set fails closed, exactly like brace expansion.
  const variantGroups = [
    collapseVariants(text),
    collapseVariants(blanked),
    collapseVariants(completed),
  ];
  if (variantGroups.some((group) => group === null)) return true;
  const bases = [...new Set(variantGroups.flatMap((group) => group ?? []))];
  for (const base of bases) {
    const views = expandBraces(base);
    if (views === null) return true;
    for (const raw of views) {
      // Bash collapses a run of `/` in a path to one (`/tmp//claude-subagents`
      // → `/tmp/claude-subagents`); reveal it so a doubled slash can't hide the
      // guarded dir literal. Reveal-monotonic — only ever joins path parts.
      const view = collapseSingleCharClass(raw).replace(/\/{2,}/g, "/");
      if (pattern.test(view)) return true;
      for (const token of view.split(/\s+/)) {
        if (tokenGlobHitsGuardedDir(token, dirs, policy)) return true;
      }
    }
  }
  return false;
}
