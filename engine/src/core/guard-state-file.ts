/**
 * Core: Guard state files from direct modification via Bash.
 * Harness-agnostic — no stdin parsing. Not pure: guardStateFile reads the
 * filesystem (a fail-closed existence probe); the decision core
 * (guardStateFileDecision) is pure.
 *
 * DENY-BY-DEFAULT (round 14, replacing the WRITE_PATTERNS denylist): a line
 * that never references a guarded path (state files, state dir, subagent dir,
 * machine definitions) is allowed untouched. A line that does is judged by
 * PIPE-CHAIN: segments are split quote-aware on `&&`/`||`/`;`/`&`/newline,
 * with `|`-linked segments grouped into one chain (a pipe carries data — a
 * guarded path echoed into `xargs`/`sh` becomes a write argument two segments
 * later, so the whole chain is one trust unit). Every segment of a chain that
 * references a guarded path must be one of:
 *
 *   - a whitelisted helper invocation (`bun <path>/cli.ts helper <name>`,
 *     matched token-by-token at the segment head — a helper name in an echo
 *     argument, comment, or file path never matches). The helper vouches only
 *     for its OWN segment, and never for a protected-dir (ledger / machine
 *     definitions) write;
 *   - a read-only command: head token ∈ READ_ONLY_STATE_COMMANDS (commands
 *     that cannot write a file under any flag) with no output redirect
 *     (quote-aware: any unquoted `>` except an fd-dup — `>&` followed by a
 *     WHOLE word of digits or exactly `-` — so `>`, `>>`, `&>`, `3>`,
 *     `>&file`, and `>&2/../file` all count; `2>&1` / `>&2` / `>&-` do not).
 *
 * Pattern tests (the front gate, chain scoping, protected-dir checks, and
 * placeholder classification) run against a QUOTE-COLLAPSED view of the
 * text: bash concatenates adjacent quoted word parts, so
 * `.cl'aude'/state/active_'task_graph'.json` names the guarded file even
 * though the raw text never contains the literal contiguously. Collapsing
 * only errs fail-closed — a quoted argument that MENTIONS a guarded name is
 * judged, never skipped — and the collapsed view is used for matching only,
 * never for placeholder substitution output.
 *
 * Everything else blocks — including writers nobody enumerated (`patch`,
 * `rsync`, `shred`, `git checkout --`), wrappers (`xargs`, `env`, `timeout`),
 * shells/interpreters executing piped content, and bare `VAR=<state-path>`
 * bindings (the indirection seed of the round-13 bypass).
 *
 * Substitutions (`$(…)`, backticks, `<(…)`, `>(…)`) execute independently and
 * are opaque to segment scoping, so on a guarded line each body is extracted
 * and recursively judged by the same rules (depth-capped), then replaced by a
 * placeholder that PRESERVES the body's guarded-token status — a write
 * command consuming `$(printf 'active_task_graph').json` is therefore still
 * seen as touching guarded state. Unbalanced substitution syntax on a guarded
 * line fails closed.
 *
 * ── Walker map ──────────────────────────────────────────────────────────────
 * This module is a de-facto POSIX grammar, implemented as several \"walkers\"
 * that each reimplement quote/escape state with slightly different semantics.
 * Their history is a series of divergence bugs (rounds 15–18 twin-scanner
 * drift; the round-20 double-quoted-apostrophe regression; the heredoc
 * inline-program gap), so each walker's purpose and its DIVERGENT semantics
 * are named here, and tests/core/guard-state-file-walkers.test.ts pins the
 * contracts an independent reference walker would catch if any of them drift:
 *
 *  - scanSubstitutions — the ONE shared substitution traversal (quote state
 *    `'"' | "'" | null`; a `'` inside `"…"` is literal; `$(…)`/backticks stay
 *    LIVE inside double quotes; `<(…)`/`>(…)` is live only unquoted). Shared
 *    by blankSubstitutions + flattenSubstitutions so the two views cannot
 *    diverge.
 *  - findClosingParen / findClosingBacktick / findClosingBrace — span
 *    closers, quote-aware; used by every scanner that must skip a whole span.
 *  - commandWords / splitFusedRedirect / unquote / commandArgs — the simple-
 *    command tokenizer feeding analyzeCommandHead; treats `( ) { }` as
 *    standalone tokens so compound syntax never hides a head.
 *  - openerLineGroups — heredoc opener-line group cut at depth 0 on
 *    `; && || &` with compound tracking ({ }, ( ), if/fi, while…done,
 *    case…esac, [[ ]]); pipe members stay in ONE group.
 *  - scanPastHeredocSpans / parseHeredocDelimiter / scanHeredocBodySubstitutions
 *    — the heredoc pre-pass; bodies are data unless the owning group EXECUTES
 *    stdin (groupExecutesStdin/commandsExecuteStdin, which recurses into
 *    inline `-c` programs because they inherit the command's stdin).
 *  - unquoted-heredoc bodies are scanned quote-INSENSITIVELY (only `\`
 *    escapes), because quote chars are literal data there.
 *
 * When adding a walker, prefer extending these rather than writing a new
 * quote loop; when changing quote semantics, run the walker net + every pin
 * in the heredoc and edge-case describes below.
 */

import type { HookResult } from "../types";
import { normalizeShellVariants } from "./shell-normalize";
import { CONTINUE, halt, scanUnquoted, skip } from "./shell-quoting";
import {
  TASK_GRAPH_PATH,
  WHITELISTED_HELPERS,
  stateFilePatterns,
  READ_ONLY_STATE_COMMANDS,
  protectedDirPatterns,
  protectedDirSegments,
  guardedDirSegments,
  SUBAGENT_DIR,
  pathExistsFailClosed,
} from "../config";
import {
  classifyFdDupWord,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
} from "../machine/extract-evidence";

const BLOCK: HookResult = {
  kind: "block",
  message: [
    "BLOCKED: Command referencing loom-guarded state must be read-only.",
    "State is managed by hooks and helper scripts only.",
    "Allowed: read-only commands (jq, cat, grep, head, ls, diff, …) or whitelisted helpers.",
  ].join("\n"),
};

/** Block message that NAMES the offending segment (and its pipe-chain when
 *  the chain has more than one link) so operators stop bisecting command
 *  text to find the tripwire. First line is byte-identical to BLOCK for
 *  anything that pattern-matches the message. */
function blockFor(chain: readonly string[], segment: string): HookResult {
  const lines = [
    "BLOCKED: Command referencing loom-guarded state must be read-only.",
    `Offending segment: ${JSON.stringify(segment)}`,
  ];
  if (chain.length > 1) {
    lines.push(`In chain: ${chain.map((s) => JSON.stringify(s)).join(" | ")}`);
  }
  lines.push(
    "State is managed by hooks and helper scripts only.",
    "Allowed: read-only commands (jq, cat, grep, head, ls, diff, …) or whitelisted helpers.",
  );
  return { kind: "block", message: lines.join("\n") };
}

/** Substitution nesting deeper than this on a guarded line is nobody's
 *  legitimate command — fail closed rather than recurse further. */
const MAX_SUBSTITUTION_DEPTH = 5;

/** Strip one layer of surrounding quotes from a token (`"…"` / `'…'`). */
function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.endsWith(first) && token.length >= 2) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Does this simple-command segment ACTUALLY invoke a whitelisted helper?
 * The only documented invocation shape is `bun <path>/cli.ts helper <name>`
 * — matched token-by-token at the segment HEAD (after comment/env-prefix
 * stripping), so a helper name appearing anywhere else in the segment
 * (echo argument, comment, path component) never matches.
 */
function segmentInvokesHelper(segment: string): boolean {
  const tokens = stripEnvPrefix(stripComment(segment).trim())
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(unquote);
  const head = tokens[0] ?? "";
  const headBase = head.slice(head.lastIndexOf("/") + 1);
  if (headBase !== "bun") return false;
  const cli = tokens[1] ?? "";
  if (cli !== "cli.ts" && !cli.endsWith("/cli.ts")) return false;
  if (tokens[2] !== "helper") return false;
  return WHITELISTED_HELPERS.includes(tokens[3] ?? "");
}

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
function collapseVariants(text: string): readonly string[] | null {
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
  const first = seq[1]!, second = seq[2]!, stepText = seq[3];
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
  while (stack.length > 0) {
    if (results.length + stack.length > MAX_BRACE_VIEWS) return null;
    const cur = stack.pop()!;
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

/** fnmatch one path segment: does the glob segment (bash `*`/`?`/`[…]`, none
 *  crossing `/`) match the literal segment exactly? A malformed class fails
 *  closed (matches). */
function segmentGlobMatches(glob: string, literal: string): boolean {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += "[^/]*";
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
 *  survives collapse. */
function tokenGlobHitsGuardedDir(token: string, dirs: readonly (readonly string[])[]): boolean {
  if (!/[*?[]/.test(token)) return false;
  const tok = token.split("/").filter((s) => s !== "");
  return dirs.some(
    (dir) => tok.length >= dir.length && dir.every((seg, k) => segmentGlobMatches(tok[k], seg)),
  );
}

interface SubstitutionScan {
  /** Substitution bodies, outermost-first (one nesting level). */
  readonly bodies: readonly string[];
  /** Text with each substitution replaced by `onBody(body)`. When `unclosed`,
   *  this holds everything BEFORE the offending opener — the opener onward is
   *  dropped (blank-to-end), which is maximal reveal for the matching view. */
  readonly rebuilt: string;
  /** An opener (`$(`, `<(`/`>(`, backtick) had no matching closer. */
  readonly unclosed: boolean;
}

/**
 * The ONE quote-aware traversal of top-level command/process substitutions,
 * shared by `blankSubstitutions` (matching view) and `flattenSubstitutions`
 * (recursive judging) so the two can never diverge on quoting or opener set —
 * the "twin scanners diverged" class that recurred rounds 15–18. Quote state is
 * tracked as `'"' | "'" | null`, NOT a lone single-quote flag: a `'` inside
 * double quotes (`"it's"`) is a literal apostrophe that must NOT open a
 * single-quoted region (the round-20 regression that disabled the whole
 * substitution defense after any double-quoted apostrophe). Command
 * substitution `$(…)` and backticks stay LIVE inside double quotes (bash still
 * performs them); process substitution `<(…)`/`>(…)` is a substitution only when
 * UNQUOTED (bash does not perform it inside double quotes), so it is treated
 * literally there. `onBody` maps each body to its replacement; the caller
 * decides the unclosed policy from `scan.unclosed`.
 *
 * EXPORTED for the walker-divergence property net (tests/core/guard-state-file-walkers.test.ts):
 * a regression in THIS quote state machine silently disables the substitution
 * defense, and the property tests pin its span decisions against an
 * independent reference walker.
 */
export function scanSubstitutions(text: string, onBody: (body: string) => string): SubstitutionScan {
  const bodies: string[] = [];
  let rebuilt = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      rebuilt += c;
      if (c === "'") quote = null; // inside '…': everything literal until the close
      continue;
    }
    if (c === "\\") { rebuilt += c + (text[i + 1] ?? ""); i++; continue; }
    // A `'` opens a single-quoted region ONLY when unquoted; inside `"…"` it is a
    // literal apostrophe (`"it's"`) and MUST NOT flip to single-quote mode — doing
    // so disabled every substitution after it (the round-20 regression). It falls
    // through to be appended literally while `$(…)`/backticks below stay live.
    if (c === "'" && quote === null) { quote = "'"; rebuilt += c; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; rebuilt += c; continue; }
    const isCmdSub = c === "$" && text[i + 1] === "(";
    const isProcSub = quote === null && (c === "<" || c === ">") && text[i + 1] === "(";
    if (isCmdSub || isProcSub) {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return { bodies, rebuilt, unclosed: true };
      const body = text.slice(i + 2, close);
      bodies.push(body);
      rebuilt += onBody(body);
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return { bodies, rebuilt, unclosed: true };
      const body = text.slice(i + 1, close);
      bodies.push(body);
      rebuilt += onBody(body);
      i = close;
      continue;
    }
    rebuilt += c;
  }
  return { bodies, rebuilt, unclosed: false };
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
 * replaced by a glob WILDCARD (`*`) — modeling the THIRD output channel the
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
  return scanSubstitutions(text, () => "*").rebuilt;
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
function referencesPattern(
  text: string,
  pattern: () => RegExp,
  dirs: () => readonly (readonly string[])[],
): boolean {
  const exemplars = dirs();
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
      if (pattern().test(view)) return true;
      for (const token of view.split(/\s+/)) {
        if (tokenGlobHitsGuardedDir(token, exemplars)) return true;
      }
    }
  }
  return false;
}

const referencesGuardedState = (text: string): boolean =>
  referencesPattern(text, stateFilePatterns, guardedDirSegments);
const referencesProtectedDir = (text: string): boolean =>
  referencesPattern(text, protectedDirPatterns, protectedDirSegments);

/**
 * Is the segment's head token a command that cannot write a file? Exact-token
 * membership (no basename resolution — `./cat` must not inherit `cat`'s
 * trust), after env-prefix stripping so `CI=1 jq …` matches. A pure
 * assignment (`F=active_task_graph.json`) strips to an empty head and
 * therefore fails the check: binding a guarded path to a variable is the
 * seed of every cross-segment indirection, and a read never needs it.
 */
function hasReadOnlyHead(segment: string): boolean {
  const tokens = stripEnvPrefix(segment)
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(unquote);
  return READ_ONLY_STATE_COMMANDS.has(tokens[0] ?? "");
}

/**
 * Quote-aware output-redirect detection: every unquoted `>` counts as a
 * write channel UNLESS it is an fd dup — `>&` followed by a word that is
 * ENTIRELY digits or exactly `-` (`2>&1`, `>&2`, `>&-`), classified by the
 * shared classifyFdDupWord. A `>&` whose word merely starts with a digit
 * but continues into a path (`>&2/../file` — the round-16 bypass) or is any
 * other word (`>&file`, the round-15 bypass) is bash's `>&word` form, which
 * redirects stdout+stderr TO THE FILE `word`, so it counts as a write. This
 * catches `>`, `>>`, `&>`, fd-numbered forms (`3>file`), and the `>&word`
 * family that whitespace-anchored patterns miss, while leaving a `>` inside
 * a quoted argument (`jq 'select(.x > 1)' <state>`) alone.
 */
function hasOutputRedirect(segment: string): boolean {
  return scanUnquoted<true>(segment, 0, (c, i) => {
    if (c !== ">") return CONTINUE;
    if (segment[i + 1] !== "&") return halt(true);
    const dup = classifyFdDupWord(segment, i + 2);
    return dup.isFdDup
      ? skip(dup.end) // digits/`-`: nothing special inside the dup word
      : halt(true); // `>&word` writes the FILE `word`
  }) ?? false;
}

interface FlattenedCommand {
  /** Substitution bodies, outermost-first — each is judged as its own line. */
  readonly bodies: readonly string[];
  /** The line with each substitution replaced by a token-preserving placeholder. */
  readonly flattened: string;
}

/** Placeholder for an extracted substitution: preserves the body's guarded-
 *  token class so the ENCLOSING segment is still judged as touching guarded
 *  state (`sed -i … $(printf 'active_task_graph').json` must not launder the
 *  token away). The body is classified on its quote-collapsed view so quote
 *  splitting inside a substitution cannot launder the class either. A body
 *  with NO guarded token flattens to the glob WILDCARD `*` — the fail-closed
 *  model of a substitution's statically-unknowable output. This subsumes BOTH
 *  output channels the flattened text must reflect: an EMPTY output (`$(:)` →
 *  "") where a guarded literal fragmented across the substitution rejoins bash-
 *  side (`.claude/stat$(:)e` → `.claude/state`, matched here as the glob
 *  `.claude/stat*e` fnmatches the `.claude/state` dir), AND a NONEMPTY output
 *  that COMPLETES a guarded literal (`.claude/stat$(printf e)` → `.claude/state`,
 *  the round-26 fail-open — an empty placeholder yielded `.claude/stat`, which
 *  the chain-scope check then skipped as out-of-scope). `*` is special to the
 *  matching layer (segmentGlobMatches / tokenGlobHitsGuardedDir expand it), so
 *  unlike a LITERAL filler — the round-20 concealment, which re-split the
 *  literal and hid the rejoin — it can never itself break a guarded match; it
 *  can only surface more references. The load-bearing property of the
 *  non-empty placeholder texts is that they cannot form a redirect or
 *  separator: `*` and the literal parts contain only [A-Za-z_/*], and the
 *  `${SUBAGENT_DIR}` prefix is redirect/separator-free as shipped
 *  (`/tmp/claude-subagents`) — this is contingent on an operator-set
 *  LOOM_SUBAGENT_DIR staying free of shell-special characters. */
function placeholderFor(body: string): string {
  if (referencesProtectedDir(body)) return `${SUBAGENT_DIR}/__subst__`;
  if (referencesGuardedState(body)) return "active_task_graph__subst__";
  return "*";
}

/**
 * Extract `$(…)` / `<(…)` / `>(…)` / backtick substitution bodies (one
 * nesting level — recursion re-enters for nested bodies) and replace each
 * with a placeholder. Quote-awareness is delegated to scanSubstitutions: single
 * quotes suppress substitution (sh semantics), a `'` inside double quotes stays
 * literal, and `$(…)`/backticks stay live in double quotes while `<(…)`/`>(…)`
 * do not. Returns null when an opener has no closer — unbalanced substitution
 * syntax on a guarded line is judged unparseable, and unparseable fails closed
 * at the caller.
 */
export function flattenSubstitutions(command: string): FlattenedCommand | null {
  const scan = scanSubstitutions(command, placeholderFor);
  if (scan.unclosed) return null;
  return { bodies: scan.bodies, flattened: scan.rebuilt };
}

/** Index of the `)` closing a substitution opened before `start` — paren
 *  depth counted quote-aware (parens inside a quoted body don't count, and
 *  "quoted" includes a BACKTICK body: this scanner tracked only `"` and `'`
 *  where both its twins tracked all three, so `` $(`a)b`) `` closed here at the
 *  `)` inside the backtick). -1 when unclosed. */
function findClosingParen(command: string, start: number): number {
  let depth = 1;
  return scanUnquoted<number>(command, start, (c, i) => {
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return halt(i);
    }
    return CONTINUE;
  }) ?? -1;
}

/** Index of the backtick closing a body opened before `start` (backslash-
 *  escape aware). -1 when unclosed. */
function findClosingBacktick(command: string, start: number): number {
  for (let i = start; i < command.length; i++) {
    if (command[i] === "\\") {
      i++;
      continue;
    }
    if (command[i] === "`") return i;
  }
  return -1;
}

/** Segments grouped into pipe-chains: `|` links segments into one chain
 *  (data flows through it), every other separator starts a new chain. */
function pipeChains(command: string): string[][] {
  const chains: string[][] = [];
  for (const seg of splitCommandSegmentsWithOps(command)) {
    const text = stripComment(seg.text).trim();
    if (seg.opBefore === "|" && chains.length > 0) {
      chains[chains.length - 1].push(text);
    } else {
      chains.push([text]);
    }
  }
  return chains.map((chain) => chain.filter((t) => t !== "")).filter((c) => c.length > 0);
}

/**
 * One here-document construct found in a command: the `<<`/`<<-` operator
 * through the end of its delimiter word (the body lives on later lines).
 */
interface HeredocOpener {
  /** Position of the first `<` of the `<<` operator. */
  readonly start: number;
  /** Position just past the delimiter word. */
  readonly end: number;
  /** The delimiter word, quote-stripped (`'EOF'`, `"EOF"`, `\EOF` → `EOF`). */
  readonly delimiter: string;
  /** True when any character of the delimiter word was quoted: the body is
   *  opaque literal data — no substitutions, no quoting, no chains. */
  readonly quoted: boolean;
  /** `<<-`: leading tabs are stripped from body and terminator lines. */
  readonly minus: boolean;
  /** True when the body is fed to a code interpreter (see
   *  HEREDOC_SCRIPT_HEADS): the body is then a SCRIPT, not data, and must be
   *  judged as full command text — including inside a QUOTED delimiter. */
  readonly script: boolean;
}

/** Command heads whose heredoc stdin CAN be EXECUTED as a script (shell
 *  interpreters and language runtimes that read their program from stdin
 *  when no file/program argument is given). For these, a quoted delimiter
 *  does NOT make the body inert — the inner interpreter still runs it — so
 *  the body must be judged as command text, exactly like the
 *  pre-heredoc-aware guard did. Whether a particular invocation actually
 *  reads stdin as its PROGRAM is decided by interpreterExecutesStdin (a
 *  file argument or `-c`/`-e` program makes stdin DATA: `bash script.sh <<
 *  'EOF'` feeds the script's stdin, not bash's program source). `awk`/
 *  `sed`/`jq` are intentionally absent: their stdin is DATA (scripts come
 *  from `-f`/`-e`).
 */
const HEREDOC_SCRIPT_HEADS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh",
  "python", "python3", "node", "bun", "deno", "perl", "ruby", "php",
  "lua", "luajit", "pwsh", "powershell", "tclsh", "groovy", "R",
  "Rscript", "octave", "busybox",
]);

/** Shell-family interpreters share the same program-source flags. */
const SH_FAMILY_HEADS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);

const headBase = (token: string): string => {
  const base = token.slice(token.lastIndexOf("/") + 1);
  return base.length > 0 && base !== "." && base !== ".." ? base : token;
};

/** Prefix wrappers that merely adjust the environment/priority of the command
 *  they launch. Unwrapped so `sudo bash << EOF`, `timeout 5 bash << EOF`, and
 *  `env -u FOO bash << EOF` are judged by the interpreter they actually run
 *  — a quoted body fed to any of those is still a script. The set is CLOSED
 *  and modest; an unknown wrapper is treated as not-an-interpreter
 *  (documented residual, same class as the multi-hop `cd` residual in
 *  config). `xargs` is deliberately NOT here: xargs turns stdin lines into
 *  command ARGUMENTS (an executed side of the body), and the group scan
 *  treats it as a script feed directly. */
const WRAPPER_HEADS = new Set([
  "sudo", "command", "builtin", "exec", "timeout", "nice", "nohup",
  "setsid", "stdbuf", "taskset", "ionice", "chrt", "watch", "env",
]);

/** Wrapper options that CONSUME the next token, so it must not be mistaken
 *  for the wrapped command (`sudo -u root bash`, `timeout -s KILL 5 bash`). */
const WRAPPER_FLAG_ARGS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-C", "-p", "-T", "-R", "-r", "-D", "-S"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n"],
  stdbuf: ["-i", "-o", "-e"],
  taskset: ["-c", "-p"],
  ionice: ["-c", "-n", "-p"],
  chrt: ["-p"],
  watch: ["-n", "-d"],
  exec: ["-a", "-c"],
  env: ["-u", "--unset", "-C", "--chdir", "--argv0", "-S", "--split-string", "-0", "-v"],
  command: [],
  builtin: [],
  setsid: [],
  nohup: [],
};

/** Interpreter flags that take the PROGRAM INLINE (`bash -c '…'`) — stdin
 *  is then DATA, not the program source. */
const INLINE_PROGRAM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"], python3: ["-c"],
  node: ["-e", "--eval"], bun: ["-e", "--eval"],
  perl: ["-e"], ruby: ["-e"], php: ["-r"],
  lua: ["-e"], luajit: ["-e"],
  R: ["-e"], Rscript: ["-e"],
  octave: ["--eval", "-e", "--exec"],
  groovy: ["-e"],
  pwsh: ["-Command", "-c", "-EncodedCommand", "-e"], powershell: ["-Command", "-c", "-EncodedCommand", "-e"],
};

/** Interpreter flags that take the PROGRAM FROM A FILE (`php -f`, `pwsh
 *  -File`) — stdin is then DATA. */
const FILE_PROGRAM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  php: ["-f"], R: ["-f"], Rscript: ["-f"],
  pwsh: ["-File", "-f"], powershell: ["-File", "-f"],
};

/** Interpreter flags that consume the next token as a MODULE/preload, then
 *  still read the program from stdin (`perl -Mstrict`, `node -r ./pre.js`). */
const MODULE_CONTINUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  perl: ["-M", "-m"],
  lua: ["-l"], luajit: ["-l"],
  node: ["-r", "--require", "--import"], bun: ["-r", "--preload"],
  tclsh: ["-encoding"],
};

/** Interpreter flags that consume the next token as the ENTIRE program
 *  (`python -m json.tool`) — stdin is then DATA for that program. */
const MODULE_PROGRAM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-m"], python3: ["-m"], ruby: ["-S"],
};

/** Paths that resolve to an inherited file descriptor. A heredoc (like any
 *  redirect) binds a descriptor, so an interpreter reading its PROGRAM from
 *  one of these — or `source`/`.` reading commands from one — executes the
 *  redirected body even though the argument LOOKS like a named file.
 *  `/dev/stdin` and fd 0 are the default heredoc channel; `/dev/fd/N` and
 *  `/proc/{self,thread-self,<pid>}/fd/N` cover an explicitly numbered heredoc
 *  (`bash 3<<'EOF' … ` then `source /dev/fd/3`). Matching any descriptor path
 *  (not only fd 0) only ever errs fail-closed: a rare legitimate
 *  `python3 /dev/fd/5` reading real data is judged a script and blocked, which
 *  is the safe direction for a read-only guard. */
const FD_DEVICE_PATH =
  /^\/dev\/stdin$|^\/dev\/fd\/\d+$|^\/proc\/(?:self|thread-self|\d+)\/fd\/\d+$/;

const isFdDevicePath = (word: string): boolean => FD_DEVICE_PATH.test(unquote(word));

/** Shell-family program-source scan: `-c` takes the program inline (stdin
 *  = data), `-s` forces stdin as the program, a bare word is a script FILE
 *  (stdin = data) UNLESS that word is a bound descriptor (`bash /dev/stdin`),
 *  in which case the descriptor's content — the heredoc body — is the program.
 *  With no program source the shell reads its commands from stdin — the
 *  heredoc body is the script. */
function shFamilyExecutesStdin(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]!);
    if (a === "-s") return true;
    if (a === "-c") return false;
    if (a === "--") {
      // `bash -- file` = file; `bash -- /dev/stdin` = the bound body; `bash --` = stdin.
      if (i === args.length - 1) return true;
      return isFdDevicePath(args[i + 1]!);
    }
    if (a === "-") return true;
    if (a.startsWith("-")) continue;
    return isFdDevicePath(a); // script-file word — unless it is a bound descriptor
  }
  return true;
}

/** busybox applets: only the sh-family applets read stdin as a program;
 *  `busybox` alone is an interactive shell reading stdin; every other
 *  applet (`busybox cat`, `busybox awk`) treats stdin as data. */
function busyboxExecutesStdin(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]!);
    if (a === "--") break;
    if (a.startsWith("-")) continue;
    const applet = headBase(a);
    if (SH_FAMILY_HEADS.has(applet)) return shFamilyExecutesStdin(args.slice(i + 1));
    return false;
  }
  return true;
}

/** Does this interpreter read its PROGRAM from stdin (so a heredoc body is
 *  a script), or from an inline/file/module argument (so the body is input
 *  DATA)? Argless invocations default to stdin: that is the interpreter
 *  contract that makes `bash << 'EOF'` a script. */
function interpreterExecutesStdin(head: string, args: readonly string[]): boolean {
  if (head === "busybox") return busyboxExecutesStdin(args);
  if (SH_FAMILY_HEADS.has(head)) return shFamilyExecutesStdin(args);
  const inline = INLINE_PROGRAM_FLAGS[head] ?? [];
  const file = FILE_PROGRAM_FLAGS[head] ?? [];
  const continueFlags = MODULE_CONTINUE_FLAGS[head] ?? [];
  const programFlags = MODULE_PROGRAM_FLAGS[head] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]!);
    if (a === "-") return true;
    if (inline.includes(a)) return false;
    // A file program supplied via a bound descriptor — `php -f /dev/stdin`,
    // `pwsh -File /dev/stdin` — reads the heredoc body as its program. Only the
    // heads in FILE_PROGRAM_FLAGS reach this branch; anything else takes the
    // generic fallback below.
    if (file.includes(a)) return isFdDevicePath(args[i + 1] ?? "");
    if (programFlags.includes(a)) {
      if (isFdDevicePath(args[i + 1] ?? "")) return true;
      i++; return false;
    }
    if (continueFlags.includes(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return isFdDevicePath(a); // bare script-file word — unless a bound descriptor
  }
  return true;
}

/** Unwrap one leading wrapper: skip its options (and option arguments) and
 *  return the wrapped command's tokens, or null when `tokens` does not
 *  START with a recognized wrapper. `env -S 'cmd…'` re-splits the option
 *  value as a command line. */
function unwrapWrapper(tokens: readonly string[]): readonly string[] | null {
  const head = headBase(unquote(tokens[0] ?? ""));
  if (!WRAPPER_HEADS.has(head)) return null;
  const consume = WRAPPER_FLAG_ARGS[head] ?? [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === "--") { i++; break; }
    if (t === "-S" || t === "--split-string") {
      // `env -S 'bash -c …'`: the option VALUE is the whole command line.
      return tokens.slice(i + 1).join(" ").split(/\s+/).filter((w) => w !== "");
    }
    if (t.startsWith("-") && consume.includes(t)) { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // `sudo VAR=1 bash`
    // Positional (non-option) arguments of specific wrappers: `timeout 5
    // cmd` and `nice 5 cmd` take the value BEFORE the wrapped command.
    if (head === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(t)) { i++; continue; }
    if (head === "nice" && /^-?\d+$/.test(t)) { i++; continue; }
    break;
  }
  return tokens.slice(i);
}

/** Does this simple command's head turn stdin into executed content?
 *  "script": stdin is a program/commands (an interpreter without its own
 *  program source, or xargs, which turns stdin lines into command
 *  arguments); "data": stdin is input data; null: not an interpreter. */
type StdinVerdict = "script" | "data" | null;

/** Resolve a simple command's head through the wrapper chain to the
 *  interpreter it actually runs, or null when the chain does not land on a
 *  recognized head. Same unwrap used by headExecutesStdinVerdict — exposed
 *  so the inline-program checks (`inlineProgramArg`, variable detection,
 *  stdin-inheritance recursion) apply to the RESOLVED interpreter rather
 *  than the wrapper that merely fronted it (`sudo bash -c 'sh'`,
 *  `env -S 'bash -c "sh"'`). */
function resolvedInterpreter(
  head: string,
  args: readonly string[],
): { head: string; args: readonly string[] } | null {
  let tokens: readonly string[] = [head, ...args];
  for (let guard = 0; guard < 8 && tokens.length > 0; guard++) {
    const unwrapped = unwrapWrapper(tokens);
    if (unwrapped === null || unwrapped.length === 0) break;
    tokens = unwrapped;
  }
  if (tokens.length === 0) return null;
  // The head may carry a fused redirect when it reached the wrapper chain as
  // an ARG (the analyzeCommandHead head position splits its own word):
  // `sudo bash<<'EOF'` unwraps to head `bash<<EOF`. Split it so the
  // interpreter resolves. (This runs on the unquoted token; a word QUOTED
  // around its operator — a command literally named `bash<<x` — mis-splits
  // to `bash`, which only errs fail-closed: the body is judged as a script.)
  const rawHead = unquote(tokens[0]!);
  const split = splitFusedRedirect(rawHead);
  return { head: headBase(split?.head ?? rawHead), args: tokens.slice(1) };
}

function headExecutesStdinVerdict(head: string, args: readonly string[]): StdinVerdict {
  const resolved = resolvedInterpreter(head, args);
  if (resolved === null) return null;
  if (resolved.head === "xargs") return "script";
  if (!HEREDOC_SCRIPT_HEADS.has(resolved.head)) return null;
  return interpreterExecutesStdin(resolved.head, resolved.args) ? "script" : "data";
}

/** The token right after an interpreter's inline-program flag (`-c`, `-e`,
 *  `-r`, …), or null when the invocation has none. */
function inlineProgramArg(head: string, args: readonly string[]): string | null {
  const inline = SH_FAMILY_HEADS.has(head) ? ["-c"] : INLINE_PROGRAM_FLAGS[head] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = unquote(args[i]!);
    if (inline.includes(a)) return i + 1 < args.length ? unquote(args[i + 1]!) : null;
    if (!a.startsWith("-") && a !== "-") return null;
  }
  return null;
}

/** Is the inline program a VARIABLE reference (`bash -c "$l"`)? In a
 *  reader+executor compound, a variable-fed inline program executes the very
 *  lines a preceding `read` pulled from the heredoc body — the inner
 *  interpreter runs the body even though its own stdin is not the program.
 *
 *  A variable-fed program is only ONE way an inline program can execute the
 *  body. A LITERAL inline program inherits the command's stdin and may read
 *  it as ITS OWN program source (`bash -c 'sh'`, `bash -c 'python3'`) or
 *  read+exec it (`bash -c 'eval "$(cat)"'`) — commandsExecuteStdin recurses
 *  into the inline program text for those cases, so `bash -c 'echo hi'`
 *  stays data while `bash -c 'sh'` is a script. */
const inlineProgramIsVariable = (head: string, args: readonly string[]): boolean =>
  inlineProgramArg(head, args)?.startsWith("$") ?? false;

/** Command heads that pull stdin into a variable (the body lines become
 *  data a LATER command can execute). */
const READER_HEADS = new Set(["read", "mapfile", "readarray"]);

/** Command heads whose stdin, when read inside a $() substitution, becomes
 *  the substitution's OUTPUT — which an executor (`eval "$(cat)"`) then
 *  runs. The same class as READER_HEADS, but reached through a command
 *  substitution instead of a variable. */
const SUBSTITUTION_READER_HEADS = new Set([
  "cat", "head", "tail", "sed", "awk", "tee", "tr", "read", "mapfile", "readarray",
]);

/** Command heads that execute their ARGUMENT as shell code (the body lines,
 *  once read). `sh -c "$l"` is caught by the inlineProgramIsVariable rule and
 *  `bash -c 'eval "$(cat)"'` by the inline-program recursion in
 *  commandsExecuteStdin. */
const EXECUTOR_HEADS = new Set(["eval", "source", "."]);

/** Leading words that are compound syntax, never a command head. */
const HEAD_KEYWORDS = new Set([
  "if", "then", "else", "elif", "while", "until", "for", "do", "done",
  "case", "esac", "in", "{", "}", "(", ")", "!", "[[", "((", "function",
]);

/** Quote-aware word split of one simple-command slice; `(`/`)`/`{`/`}` are
 *  standalone tokens so compound syntax never hides a head. */
function commandWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (quote !== "'" && c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "\\") { current += c + (text[i + 1] ?? ""); i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; current += c; continue; }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      if (current !== "") { words.push(current); current = ""; }
      words.push(c);
      continue;
    }
    if (/\s/.test(c)) {
      if (current !== "") { words.push(current); current = ""; }
      continue;
    }
    current += c;
  }
  if (current !== "") words.push(current);
  return words;
}

/** Redirect operators, longest-first, for fused-redirect splitting. The
 *  `&>`-on-`&` form is checked separately (it can only start at the `&`). */
const REDIRECT_OPS = ["<<<", "<<-", "<<", ">>", "<>", ">&", ">", "<"] as const;

/** First UNQUOTED redirect operator inside a raw word, split off from its
 *  prefix: `bash<<'EOF'` → head `bash` + rest `<<'EOF'`; `2>/dev/null` →
 *  head `2` + rest `>/dev/null`; `2>&1` → head `2` + rest `>&1`. A quoted
 *  operator (`'a<<b'`) is literal word text and never splits. Returns null
 *  when the word contains no unquoted redirect. */
function splitFusedRedirect(word: string): { readonly head: string; readonly rest: string } | null {
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (quote !== null) {
      if (quote !== "'" && c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "&" && word[i + 1] === ">") {
      return { head: word.slice(0, i), rest: word.slice(i) }; // `&>`, `&>>`
    }
    for (const op of REDIRECT_OPS) {
      if (word.startsWith(op, i)) {
        return { head: word.slice(0, i), rest: word.slice(i) };
      }
    }
  }
  return null;
}

/** The head token (and remaining argument tokens) of a simple-command
 *  slice, after comments, env assignments, compound keywords, `case`
 *  words/patterns, and `name()` function-definition prefixes are stripped.
 *  Redirect operators (and their targets/delimiters) are removed from the
 *  args so `<< 'EOF'` never reads as a script-file argument; fused
 *  redirects (`3>file`, `2>&1`, `<<'EOF'`) are dropped whole. A redirect
 *  FUSED INTO the head word (`bash<<'EOF'`) or standing before it
 *  (`2>/dev/null bash<<'EOF'`) is split off so the interpreter resolves
 *  (review finding F1); compound-closing `)`/`}` words are syntax, never
 *  interpreter arguments, and are dropped (F2); `case` patterns — a word
 *  immediately followed by a standalone `)` that has a real word after it —
 *  are skipped with their `)` (F3), while a `)` followed only by redirects
 *  stays a subshell close and does NOT consume its word as a pattern.
 *  `(( … ))` arithmetic is not a command and yields null. Null when
 *  nothing but syntax remains. */
const PURE_REDIRECT = /^(?:[0-9]*[<>]{1,2}|<<<|&>+|<<-|<>)$/;
const FUSED_REDIRECT = /^(?:[0-9]+[<>]|[<>]|&>)[^\s]*$/;

/** Argument words after the head: redirect operators and their
 *  targets/delimiters are consumed (`<< 'EOF'`, `3>file`, `2>&1`),
 *  compound-closing `)`/`}` words are syntax junk (never script-file
 *  arguments). */
function commandArgs(words: readonly string[], from: number): readonly string[] {
  const args: string[] = [];
  for (let k = from; k < words.length; k++) {
    const w = words[k]!;
    if (w === ")" || w === "}") continue; // compound closes are syntax, never args
    if (PURE_REDIRECT.test(w)) { k++; continue; } // operator + target/delimiter
    if (FUSED_REDIRECT.test(w)) continue; // `3>file`, `2>&1`, `<<'EOF'`
    args.push(unquote(w));
  }
  return args;
}

export function analyzeCommandHead(segment: string): { head: string; args: readonly string[] } | null {
  const stripped = stripEnvPrefix(stripComment(segment).trim());
  if (stripped === "") return null;
  // `(( … ))` is arithmetic/`((`-test syntax, never a command; its internals
  // must not read as a head (`(( bash )) << 'EOF'` stdin is unused).
  if (stripped.replace(/^!\s*/, "").startsWith("((")) return null;
  const words = commandWords(stripped);
  let i = 0;
  let inCase = false;
  for (let guard = 0; guard < 8 && i < words.length; guard++) {
    const raw = words[i]!;
    const w = unquote(raw);
    if (w === "case") { inCase = true; i++; continue; }
    if (inCase) {
      if (w === "in") inCase = false; // `case … in` — patterns follow
      i++;
      continue;
    }
    // `case` PATTERN: a word immediately followed by a standalone `)` with
    // a real word after it. A `)` followed only by redirects is a subshell
    // close (`( x ) << 'EOF'`), not a pattern terminator.
    if (words[i + 1] === ")" && i + 2 < words.length && words[i + 2] !== ")" &&
        !PURE_REDIRECT.test(words[i + 2]!) && !FUSED_REDIRECT.test(words[i + 2]!)) {
      i += 2;
      continue;
    }
    if (HEAD_KEYWORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(w)) { i++; continue; }
    // A fused redirect on the head word: `bash<<'EOF'` → head `bash`, the
    // remainder is redirect syntax and is discarded. A leading pure-`N>` word
    // (`2>/dev/null`, `>log`, `&>x`) is also redirect syntax — skip it.
    const split = splitFusedRedirect(raw);
    if (split !== null) {
      if (split.head === "" || /^[0-9]+$/.test(split.head)) { i++; continue; }
      return { head: unquote(split.head), args: commandArgs(words, i + 1) };
    }
    break;
  }
  if (i >= words.length) return null;
  return { head: unquote(words[i]!), args: commandArgs(words, i + 1) };
}

/** Index of the `}` closing a `${` opened before `start`; -1 when unclosed.
 *  Skips quoted spans, `$(…)`/backticks, `$((…))` arithmetic, and nested
 *  `${…}`. */
function findClosingBrace(text: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (quote !== "'" && c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One pipe-chain of an opener line: text between depth-0 separators
 *  (`;` `&&` `||` `&` newline). `|` links members WITHIN one group — the
 *  shell evaluates the group as one trust unit. */
interface OpenerGroup { readonly start: number; readonly end: number; }

/** Quote/substitution/compound-aware walk of an opener line, yielding the
 *  pipe-chain groups that own heredoc positions. Compound internals
 *  (`{ …; }`, `( …; )`, `if …; then …; fi`, `while …; do …; done`,
 *  `case …;; esac`) never cut a group: their `;`/`&&` bind inside the
 *  compound, so a heredoc inside one can still feed a LATER pipeline member
 *  (`{ cat << 'EOF'; } | bash` executes the body). Unparseable spans
 *  (unclosed `$(…)`, backticks, `${…}`) fail closed: the opener line is
 *  judged as one group (conservative — script bodies block on guarded
 *  mentions, data bodies are still judged by the normal machinery). */
function openerLineGroups(line: string): readonly OpenerGroup[] {
  const groups: OpenerGroup[] = [];
  let groupStart = 0;
  const compound: string[] = [];
  let quote: '"' | "'" | null = null;
  let i = 0;
  const n = line.length;
  const boundaryChar = (pos: number): boolean =>
    pos < 0 || pos >= n || /\s/.test(line[pos]!) || ";&|(){}".includes(line[pos]!);
  const popUntil = (kind: string): void => {
    for (let k = compound.length - 1; k >= 0; k--) {
      if (compound[k] === kind) { compound.length = k; return; }
    }
  };
  while (i < n) {
    const c = line[i]!;
    if (quote === "'") { if (c === "'") quote = null; i++; continue; }
    if (quote === '"') {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') quote = null;
      i++;
      continue;
    }
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === "$" && line[i + 1] === "{") {
      const close = findClosingBrace(line, i + 2);
      if (close === -1) return [{ start: groupStart, end: n }]; // fail closed: one group
      i = close + 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const close = findClosingParen(line, i + 2);
      if (close === -1) return [{ start: groupStart, end: n }];
      i = close + 1;
      continue;
    }
    if ((c === "<" || c === ">") && line[i + 1] === "(") {
      const close = findClosingParen(line, i + 2);
      if (close === -1) return [{ start: groupStart, end: n }];
      i = close + 1;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(line, i + 1);
      if (close === -1) return [{ start: groupStart, end: n }];
      i = close + 1;
      continue;
    }
    if (c === "{") { compound.push("{"); i++; continue; }
    if (c === "}") { if (compound.length > 0 && compound[compound.length - 1] === "{") compound.pop(); i++; continue; }
    if (c === "(") { compound.push("("); i++; continue; }
    // A `)` closes a subshell ONLY when a `(` is open; in `case x in a)` it
    // terminates a PATTERN and must not uncut the case compound.
    if (c === ")") { if (compound.length > 0 && compound[compound.length - 1] === "(") compound.pop(); i++; continue; }
    // `[[ … ]]` test brackets: `&&` inside is a test operator, not a chain cut.
    if (c === "[" && line[i + 1] === "[") { compound.push("[["); i += 2; continue; }
    if (c === "]" && line[i + 1] === "]") {
      for (let k = compound.length - 1; k >= 0; k--) {
        if (compound[k] === "[[") { compound.length = k; break; }
      }
      i += 2;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = line.slice(i).match(/^[A-Za-z][A-Za-z0-9_-]*/);
      if (m !== null && boundaryChar(i - 1) && boundaryChar(i + m[0].length)) {
        const word = m[0];
        if (word === "if") compound.push("if");
        else if (word === "while" || word === "until" || word === "for") compound.push("loop");
        else if (word === "case") compound.push("case");
        else if (word === "fi") popUntil("if");
        else if (word === "done") popUntil("loop");
        else if (word === "esac") popUntil("case");
      }
      i += m?.[0].length ?? 1;
      continue;
    }
    if (c === ";" || c === "&" || c === "\n") {
      // `&>`/`&>>` redirects and `2>&1`-style fd dups are NOT separators
      // (mirroring splitCommandSegmentsWithOps): the `&` binds to the
      // redirect/dup syntax around it.
      if (c === "&") {
        if (line[i + 1] === ">") { i += 2; continue; }
        if (line[i - 1] === ">") { i++; continue; }
      }
      const skip = c === "&" && line[i + 1] === "&" ? 2 : c === ";" && line[i + 1] === ";" ? 2 : 1;
      if (compound.length === 0) {
        groups.push({ start: groupStart, end: i });
        groupStart = i + skip;
      }
      i += skip;
      continue;
    }
    if (c === "|") {
      if (line[i + 1] === "|") {
        if (compound.length === 0) {
          groups.push({ start: groupStart, end: i });
          groupStart = i + 2;
        }
        i += 2;
      } else {
        i += line[i + 1] === "&" ? 2 : 1; // `|&` = one pipe operator
      }
      continue;
    }
    i++;
  }
  groups.push({ start: groupStart, end: n });
  return groups;
}

/** Does any `$(…)`/backtick substitution in `text` start with a command
 *  that READS stdin? `eval "$(cat)" << 'EOF'` executes the body through the
 *  substitution's stdin channel, so the executor pair must see it as a
 *  reader. One nesting level — recursion re-enters for deeper spans. */
function textReadsStdinViaSubstitution(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return false;
      const body = text.slice(i + 2, close);
      const analyzed = analyzeCommandHead(body);
      if (analyzed !== null && SUBSTITUTION_READER_HEADS.has(analyzed.head)) return true;
      if (textReadsStdinViaSubstitution(body)) return true;
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return false;
      const body = text.slice(i + 1, close);
      const analyzed = analyzeCommandHead(body);
      if (analyzed !== null && SUBSTITUTION_READER_HEADS.has(analyzed.head)) return true;
      if (textReadsStdinViaSubstitution(body)) return true;
      i = close;
      continue;
    }
  }
  return false;
}

/** Does the pipe-chain group that owns a heredoc opener execute the body?
 *  Any of: an interpreter head consuming stdin as its program; xargs (body
 *  lines become command arguments); or a compound that reads stdin into a
 *  variable — or through a substitution — and then executes it
 *  (`while read l; do eval "$l"; done`, `read x; sh -c "$x"`,
 *  `eval "$(cat)"`). Every simple command in the group is examined —
 *  including INSIDE braces/parens/loops, because a `;` there is a compound
 *  internal, not a group cut.
 *
 *  Documented residual: a reader on the OPENER line whose executor appears
 *  AFTER the terminator on a later line (`read x << 'EOF' … EOF` then
 *  `eval "$x"`) — the executor is not on the opener line the group scan
 *  sees, and tracking variable flow across the body is out of scope.
 */
function commandsExecuteStdin(text: string, depth: number): boolean {
  if (depth > MAX_SUBSTITUTION_DEPTH) return true; // recursion bound: fail closed
  const commands = splitCommandSegmentsWithOps(text)
    .map((s) => s.text)
    .filter((t) => t.trim() !== "");
  let readsStdin = false;
  let executesVar = false;
  for (const raw of commands) {
    if (textReadsStdinViaSubstitution(raw)) readsStdin = true;
    const analyzed = analyzeCommandHead(raw);
    if (analyzed === null) continue;
    const { head, args } = analyzed;
    if (READER_HEADS.has(head)) { readsStdin = true; continue; }
    if (EXECUTOR_HEADS.has(head)) {
      // `source`/`.` reading commands from a bound descriptor (`source
      // /dev/stdin` under a heredoc) read AND execute the body in one command,
      // so the pair's readsStdin/executesVar handshake never applies — it is a
      // script feed on its own. (`eval` takes a string argument, not a file,
      // and reaches stdin only through the substitution path handled above.)
      if ((head === "source" || head === ".") && args.some((a) => isFdDevicePath(a))) {
        return true;
      }
      executesVar = true; continue;
    }
    const verdict = headExecutesStdinVerdict(head, args);
    if (verdict === "script") return true;
    if (verdict === "data") {
      // The INLINE program checks bind to the RESOLVED interpreter — a
      // wrapper front (`sudo bash -c 'sh'`, `env -S 'bash -c "sh"'`) must
      // not hide the interpreter the stdin actually reaches.
      const resolved = resolvedInterpreter(head, args);
      if (resolved === null) continue;
      // A variable-fed inline program participates in the reader+executor
      // compound (`while read l; do sh -c "$l"; done`).
      if (inlineProgramIsVariable(resolved.head, resolved.args)) { executesVar = true; continue; }
      // A LITERAL inline program inherits this command's stdin. Recurse into
      // it: if the program is itself a stdin-reading interpreter
      // (`bash -c 'sh'`, `bash -c 'python3'`) or a reader+executor pair
      // (`bash -c 'eval "$(cat)"'`), the heredoc body is a script even
      // though the OUTER interpreter's own stdin is data (`bash -c 'sh
      // file.sh'` feeds the script's stdin and stays data). Verified against
      // real bash: each recurrence below executes the body.
      const program = inlineProgramArg(resolved.head, resolved.args);
      if (program !== null && commandsExecuteStdin(program, depth + 1)) return true;
    }
  }
  return readsStdin && executesVar;
}

/** Does the pipe-chain group that owns a heredoc opener execute the body?
 *  Any of: an interpreter head consuming stdin as its program; xargs (body
 *  lines become command arguments); or a compound that reads stdin into a
 *  variable — or through a substitution — and then executes it
 *  (`while read l; do eval "$l"; done`, `read x; sh -c "$x"`,
 *  `eval "$(cat)"`). Every simple command in the group is examined —
 *  including INSIDE braces/parens/loops, because a `;` there is a compound
 *  internal, not a group cut. Inline programs of interpreter heads are
 *  recursed into (see commandsExecuteStdin), so `bash -c 'sh'` is a script
 *  feed while `bash -c 'echo hi'` is data. */
function groupExecutesStdin(group: string): boolean {
  return commandsExecuteStdin(group, 0);
}

/** Is the heredoc opener at `openerPos` inside a pipe-chain group that
 *  executes the body as a script? Pipe-linked members share the body's fate
 *  (`cat << 'X' | bash` really runs the body under bash); `&&`/`;`/`&` at
 *  depth 0 cut the group (`cat << 'A' && bash << 'B'` — A is data, B is a
 *  script), but compound internals never do (`{ cat << 'X'; } | bash` and
 *  `while read l; do eval \"$l\"; done << 'X'` still execute).
 *  Quote/substitution-aware so `echo "a|bash"` never classifies. */
function heredocBodyIsScript(line: string, openerPos: number): boolean {
  for (const group of openerLineGroups(line)) {
    if (openerPos < group.start || openerPos > group.end) continue;
    return groupExecutesStdin(line.slice(group.start, group.end));
  }
  return false;
}

/**
 * Heredoc-aware pre-pass: strips every here-document BODY (and the `<<`
 * constructs themselves) out of the command text before any other parsing,
 * so inert prose inside a heredoc can never look like live command text.
 *
 * Why this is sound: a heredoc body is STDIN DATA. For a quoted delimiter
 * (`<< 'EOF'`) bash performs NO expansion in the body at all, so the body is
 * opaque and contributes nothing to the judgment. For an unquoted delimiter
 * (`<< EOF`) substitutions (`$(…)`, backticks) DO execute — judged via
 * `bodies` — but quote characters are literal data (verified against bash:
 * `'$(x)'` still expands, `\$(x)` does not) and no line inside the body is a
 * command. The only file-write a heredoc performs is its own stdin redirect,
 * which lives on the OPENER line (`cat > /tmp/x << 'EOF'`) and stays in
 * `stripped` for normal judging.
 *
 * The returned `stripped` text keeps the opener line (minus the heredoc
 * constructs) and every newline outside bodies, so later chain/segment
 * splitting sees the command as bash would after consuming the heredocs.
 * `unparseable` marks spans the scanner could not parse (unclosed
 * `$(…)`/backtick, or an unclosed substitution inside an unquoted body) —
 * the caller fails closed on those exactly as flattenSubstitutions does.
 */
export function splitHeredocs(text: string): {
  readonly stripped: string;
  readonly bodies: readonly string[];
  readonly unparseable: boolean;
} {
  const n = text.length;
  const bodies: string[] = [];
  let stripped = "";
  let unparseable = false;
  let pos = 0;

  outer: while (pos < n) {
    const scan = scanPastHeredocSpans(text, pos, n);
    if (scan.unparseable) {
      unparseable = true;
      stripped += text.slice(pos);
      break;
    }
    if (scan.next >= n) {
      stripped += text.slice(pos);
      break;
    }
    const openerPos = scan.next;
    const lineStart = text.lastIndexOf("\n", openerPos - 1) + 1;
    const lineEnd = text.indexOf("\n", openerPos);
    const lineEndAt = lineEnd === -1 ? n : lineEnd;
    const openerLine = text.slice(lineStart, lineEndAt);

    // Collect EVERY heredoc opener on this line: bodies attach in order to
    // the lines that follow, so they must all be known before consumption.
    const openers: HeredocOpener[] = [];
    let cur = openerPos;
    let dangling = false;
    while (cur < lineEndAt) {
      const word = parseHeredocDelimiter(text, cur, lineEndAt);
      if (word === null) { dangling = true; break; }
      openers.push({
        start: cur,
        end: word.end,
        delimiter: word.delimiter,
        quoted: word.quoted,
        minus: word.minus,
        script: heredocBodyIsScript(openerLine, cur - lineStart),
      });
      const more = scanPastHeredocSpans(text, word.end, lineEndAt);
      if (more.unparseable) {
        unparseable = true;
        stripped += text.slice(pos, lineEndAt) + (lineEndAt < n ? "\n" : "");
        stripped += text.slice(lineEndAt < n ? lineEndAt + 1 : n);
        break outer;
      }
      if (more.next >= lineEndAt) break;
      cur = more.next;
    }

    // The opener line stays in the judged text, minus the heredoc constructs.
    stripped += text.slice(pos, openerPos);
    let last = openerPos;
    for (const g of openers) {
      stripped += text.slice(last, g.start);
      last = g.end;
    }
    stripped += text.slice(last, lineEndAt);
    if (lineEndAt < n) stripped += "\n";

    if (dangling) {
      // `<<` with no delimiter word on its line: bash would read the
      // delimiter from the next line; we cannot know it, so fail closed —
      // judge the remainder as one body (full command text when the line
      // feeds an interpreter, substitutions only otherwise).
      const rest = text.slice(lineEndAt < n ? lineEndAt + 1 : n);
      if (rest !== "") {
        if (heredocBodyIsScript(openerLine, cur - lineStart)) {
          bodies.push(rest);
        } else {
          const bodyScan = scanHeredocBodySubstitutions(rest);
          if (bodyScan.unclosed) unparseable = true;
          bodies.push(...bodyScan.bodies);
        }
      }
      break;
    }

    // Consume bodies in opener order, one terminator line each.
    let bodyPos = lineEndAt < n ? lineEndAt + 1 : n;
    for (const g of openers) {
      if (bodyPos >= n) break;
      let search = bodyPos;
      let terminatorAt = -1;
      let nextBodyPos = n;
      while (search < n) {
        const nl = text.indexOf("\n", search);
        const end = nl === -1 ? n : nl;
        let line = text.slice(search, end);
        if (g.minus) line = line.replace(/^\t+/, "");
        if (line === g.delimiter) {
          terminatorAt = search;
          nextBodyPos = nl === -1 ? n : nl + 1;
          break;
        }
        search = nl === -1 ? n : nl + 1;
      }
      // The body is data — BUT a SCRIPT body (heredoc fed to an
      // interpreter) is full command text and gets judged wholesale, and an
      // UNQUOTED data body still runs its substitutions (live commands).
      // Quoted data bodies are opaque. Unterminated heredocs consume to end
      // of input.
      const body = text.slice(bodyPos, terminatorAt === -1 ? n : terminatorAt);
      if (body !== "") {
        if (g.script) {
          bodies.push(body);
        } else if (!g.quoted) {
          const bodyScan = scanHeredocBodySubstitutions(body);
          if (bodyScan.unclosed) unparseable = true;
          bodies.push(...bodyScan.bodies);
        }
      }
      bodyPos = terminatorAt === -1 ? n : nextBodyPos;
      if (terminatorAt === -1) break;
    }
    pos = bodyPos;
  }

  return Object.freeze({ stripped, bodies: Object.freeze(bodies), unparseable });
}

/** Parse the delimiter word after a `<<`/`<<-` at `pos` (text[pos] is the
 *  first `<`). Returns null when no delimiter word exists before `limit` —
 *  bash would continue the line (or error); the caller treats that as an
 *  unparseable opener. Any quoted character marks the body quoted. */
function parseHeredocDelimiter(
  text: string,
  pos: number,
  limit: number,
): { delimiter: string; quoted: boolean; minus: boolean; end: number } | null {
  let i = pos + 2; // past `<<`
  let minus = false;
  if (i < limit && text[i] === "-") { minus = true; i++; }
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  if (i >= limit) return null;
  let delimiter = "";
  let quoted = false;
  while (i < limit) {
    const c = text[i];
    if (c === "\\") {
      if (i + 1 >= limit || text[i + 1] === "\n") return null; // continuation / EOL
      quoted = true; // `\EOF` quotes E
      delimiter += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "'" || c === "\"") {
      const q = c;
      quoted = true;
      i++;
      let closed = false;
      while (i < limit) {
        if (text[i] === q) { i++; closed = true; break; }
        if (q === "\"" && text[i] === "\\" && i + 1 < limit && text[i + 1] !== "\n") {
          delimiter += text[i + 1]; // `\"` inside a double-quoted word
          i += 2;
          continue;
        }
        delimiter += text[i]; // quoted word content is part of the delimiter
        i++;
      }
      if (!closed) return null; // unclosed quote: no delimiter on this line
      continue;
    }
    if (c === " " || c === "\t") break;
    delimiter += c;
    i++;
  }
  if (delimiter === "") return null;
  return { delimiter, quoted, minus, end: i };
}

/** Scan from `from` to `limit`, skipping quoted spans, `$(…)`/backticks, and
 *  process substitutions (their contents are judged by recursion), and stop
 *  at the FIRST unquoted `<<`/`<<-` that is not a `<<<` here-string. Returns
 *  the opener position, or `limit` when none exists before the bound.
 *  `unparseable` marks an unclosed span — the caller fails closed. */
function scanPastHeredocSpans(
  text: string,
  from: number,
  limit: number,
): { next: number; unparseable: boolean } {
  let i = from;
  let quote: '"' | "'" | null = null;
  while (i < limit) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") { i += Math.min(2, limit - i); continue; }
      if (c === '"') { quote = null; i++; continue; }
      if (c === "$" && text[i + 1] === "{") {
        const close = findClosingBrace(text, i + 2);
        if (close === -1) return { next: limit, unparseable: true };
        i = close + 1;
        continue;
      }
      if (c === "$" && text[i + 1] === "(") {
        const close = findClosingParen(text, i + 2);
        if (close === -1) return { next: limit, unparseable: true };
        i = close + 1;
        continue;
      }
      if (c === "`") {
        const close = findClosingBacktick(text, i + 1);
        if (close === -1) return { next: limit, unparseable: true };
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === "\\") { i += Math.min(2, limit - i); continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === "$" && text[i + 1] === "{") {
      // A `<<` inside ${…} is parameter-expansion WORD text, never a
      // heredoc opener (${x:-<<'EOF'}); skipping the whole span stops it
      // from swallowing the real command text that follows as a fake body.
      const close = findClosingBrace(text, i + 2);
      if (close === -1) return { next: limit, unparseable: true };
      i = close + 1;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return { next: limit, unparseable: true };
      i = close + 1;
      continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") {
      const close = findClosingParen(text, i + 2);
      if (close === -1) return { next: limit, unparseable: true };
      i = close + 1;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close === -1) return { next: limit, unparseable: true };
      i = close + 1;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      if (text[i + 2] === "<") { i += 3; continue; } // `<<<` here-string: no body
      return { next: i, unparseable: false };
    }
    i++;
  }
  return { next: limit, unparseable: false };
}

/** Substitution bodies inside an UNQUOTED heredoc body. Quote characters are
 *  literal data there, so openers are found quote-INSENSITIVELY (only `\`
 *  escapes `$` and `` ` `` — verified against bash); the closing `)`/backtick
 *  is still found with the quote-aware closers because the inside of a
 *  substitution is a real command context again. */
function scanHeredocBodySubstitutions(body: string): {
  readonly bodies: readonly string[];
  readonly unclosed: boolean;
} {
  const found: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && body[i + 1] === "(") {
      const close = findClosingParen(body, i + 2);
      if (close === -1) return { bodies: found, unclosed: true };
      found.push(body.slice(i + 2, close));
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(body, i + 1);
      if (close === -1) return { bodies: found, unclosed: true };
      found.push(body.slice(i + 1, close));
      i = close;
      continue;
    }
  }
  return { bodies: found, unclosed: false };
}

/**
 * The pure guard decision (no fs) — exported so tests exercise the REAL
 * logic instead of a simulation. guardStateFile wraps it with the
 * task-graph-exists check.
 */
export function guardStateFileDecision(command: string): HookResult {
  return decide(command, 0);
}

function decide(command: string, depth: number): HookResult {
  if (!command) return { kind: "allow" };

  // Heredoc bodies are data, not command text: strip them BEFORE the front
  // gate so inert prose inside a heredoc (backticked package names, mentions
  // of the state dirs, the review-invocations literal) can never block a
  // command whose only writes are unguarded. Live parts of unquoted bodies
  // come back through `bodies` below.
  const hd = splitHeredocs(command);
  if (hd.unparseable && referencesGuardedState(hd.stripped)) return BLOCK;

  // Unquoted-heredoc bodies: substitutions execute, the rest is data. These
  // are judged BEFORE the stripped-text front gate so a body substitution
  // (`$(rm .claude/state/…)` inside `cat << EOF … EOF`) cannot hide behind a
  // stripped text that otherwise references nothing guarded. Quoted bodies
  // contribute nothing (opaque data).
  if (depth > MAX_SUBSTITUTION_DEPTH) return BLOCK;
  for (const body of hd.bodies) {
    if (decide(body, depth + 1).kind === "block") return BLOCK;
  }

  // Lines that never reference a guarded path are not this guard's business.
  // (Checked on the quote-COLLAPSED line: a token hidden inside a
  // substitution body is still present in the raw text, and a token split
  // across adjacent quoted parts — `.cl'aude'/state/…` — reassembles under
  // collapse, so neither escapes this gate. Patterns resolve machinesDir()
  // at decision time — a re-pointed LOOM_MACHINES_DIR is guarded without a
  // module reload.)
  if (!referencesGuardedState(hd.stripped)) return { kind: "allow" };

  const flat = flattenSubstitutions(hd.stripped);
  if (flat === null) return BLOCK;
  for (const body of flat.bodies) {
    if (decide(body, depth + 1).kind === "block") return BLOCK;
  }

  for (const chain of pipeChains(flat.flattened)) {
    // A chain none of whose segments touch a guarded path is out of scope —
    // `npm install && jq . <state>` must not block on the npm segment.
    // (Tested quote-collapsed, like every pattern site.)
    if (!chain.some(referencesGuardedState)) continue;

    for (const segment of chain) {
      if (segmentInvokesHelper(segment)) {
        // The helper vouches for its own segment (including a redirect of its
        // output into a state file) — but NEVER for a protected-dir write:
        // ledger and machine-definition forgery stay blocked even here.
        if (referencesProtectedDir(segment) && hasOutputRedirect(segment)) {
          return blockFor(chain, segment);
        }
        continue;
      }
      if (!hasReadOnlyHead(segment)) return blockFor(chain, segment);
      if (hasOutputRedirect(segment)) return blockFor(chain, segment);
    }
  }

  return { kind: "allow" };
}

/**
 * Default task-graph existence probe, FAIL-CLOSED. The historical default was
 * bare `existsSync(TASK_GRAPH_PATH)`, which returns `false` for ANY error —
 * EACCES, ELOOP, ENOTDIR, EIO all read as "no graph" — so one unreadable path
 * silently disarmed the whole state-file forgery guard while the operator
 * believed Bash writes were blocked. ENOENT is the only absent answer; anything
 * unreadable stays armed. Identical semantics to `block-direct-edits.ts`, which
 * fixed this same probe first.
 */
const defaultTaskGraphExists = (): boolean => pathExistsFailClosed(TASK_GRAPH_PATH);

export function guardStateFile(
  command: string,
  taskGraphExists: () => boolean = defaultTaskGraphExists,
): HookResult {
  if (!taskGraphExists()) return { kind: "allow" };
  return guardStateFileDecision(command);
}
