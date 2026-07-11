/**
 * Core: Guard state files from direct modification via Bash.
 * Harness-agnostic — no stdin parsing. Not pure: guardStateFile reads the
 * filesystem (existsSync); the decision core (guardStateFileDecision) is pure.
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
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { decodeAnsiC, findAnsiCClose } from "./shell-ansi-c";
import {
  TASK_GRAPH_PATH,
  WHITELISTED_HELPERS,
  stateFilePatterns,
  READ_ONLY_STATE_COMMANDS,
  protectedDirPatterns,
  protectedDirSegments,
  guardedDirSegments,
  SUBAGENT_DIR,
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

/**
 * Quote-COLLAPSED view of a piece of command text, for pattern matching
 * only. Reproduces every bash word-normalization that can hide a guarded
 * literal from a raw-text scan. The invariant that makes it fail-closed: it
 * only ever removes or decodes SHELL-SYNTAX and shell-DROPPED characters —
 * quote chars (`'`/`"`), backslashes (`\`), the `$` of an ANSI-C/locale quote,
 * ANSI-C escape bodies, the newline of a `\`-continuation, and a decoded NUL —
 * NONE of which appear in any guarded pattern (paths of `[A-Za-z0-9._/-]`). So
 * any contiguous raw span that matches a guarded pattern still matches after
 * collapse: the view can REVEAL a guarded token but never CONCEAL one.
 *   - unescaped `'`/`"` quote chars are stripped, so adjacent quoted word
 *     parts concatenate as bash concatenates them
 *     (`.cl'aude'/state/active_'task_graph'.json` → the guarded literal);
 *   - an unquoted or double-quoted backslash escape drops the backslash and
 *     keeps the char (`.cl\aude` → `.claude`);
 *   - a backslash before a newline is a line continuation: BOTH are dropped,
 *     rejoining the token (`grap\⏎h` → `graph`);
 *   - `$'…'` ANSI-C bodies are decoded (`$'\x2e\x63…'` → `.c…`), and a decoded
 *     NUL is dropped as bash drops it (`.claude/st$'\x00'ate` → `.claude/state`);
 *   - `$"…"` locale-quoted bodies are treated as `"…"` (same literal content).
 * The collapsed text is NEVER substituted back into anything executed or
 * placeholdered — it exists only so stateFilePatterns()/protectedDirPatterns()
 * cannot be laundered by quoting, escaping, or ANSI-C encoding.
 */
function collapseQuotes(text: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        // Backslash-newline is line continuation: bash removes BOTH chars,
        // rejoining the token (`grap\⏎h` → `graph`). Keeping the newline would
        // split a guarded literal and hide it — so drop both.
        if (text[i + 1] === "\n") { i++; continue; }
        // Double-quoted escape: drop the backslash, keep the char.
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      out += c;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      const end = findAnsiCClose(text, i + 2);
      const bodyEnd = end === -1 ? text.length : end;
      out += decodeAnsiC(text.slice(i + 2, bodyEnd));
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "$" && text[i + 1] === '"') {
      // $"…" is "…" with locale translation — identical literal content.
      quote = '"';
      i++; // consume the `$`; the `"` becomes the active quote next iteration
      continue;
    }
    if (c === "\\") {
      // Backslash-newline is line continuation: bash removes BOTH chars (see
      // the double-quoted branch above).
      if (text[i + 1] === "\n") { i++; continue; }
      // Unquoted escape: bash removes the backslash (`\a` → `a`).
      out += text[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    out += c;
  }
  return out;
}

/** Product of brace-group sizes above which a braced line is deemed
 *  unparseable (fail closed). 8 two-option groups = 256 views. */
const MAX_BRACE_VIEWS = 256;

/** Options of a `{…}` sequence body (`a..c`, `1..3`, `3..1`), or null when the
 *  body is not a sequence. Alpha and signed-integer ranges only (the forms bash
 *  expands); step is inferred from direction. */
function sequenceOptions(content: string): string[] | null {
  const alpha = content.match(/^([A-Za-z])\.\.([A-Za-z])$/);
  if (alpha) {
    const a = alpha[1].charCodeAt(0), b = alpha[2].charCodeAt(0);
    const step = a <= b ? 1 : -1;
    const out: string[] = [];
    for (let c = a; step > 0 ? c <= b : c >= b; c += step) out.push(String.fromCharCode(c));
    return out;
  }
  const num = content.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (num) {
    const a = parseInt(num[1], 10), b = parseInt(num[2], 10);
    const step = a <= b ? 1 : -1;
    const out: string[] = [];
    for (let c = a; step > 0 ? c <= b : c >= b; c += step) {
      out.push(String(c));
      if (out.length > MAX_BRACE_VIEWS) return null;
    }
    return out;
  }
  return null;
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
function expandBraces(text: string): string[] | null {
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

/**
 * Does the text reference a guarded path under EVERY bash word-expansion that
 * can reassemble a guarded literal (quote collapse, brace expansion,
 * single-char class reveal) or reach a guarded directory via a residual glob?
 * Reveal-monotonic and fail-closed: an unbounded brace expansion counts as a
 * reference. This is the front gate and chain/segment scope predicate.
 */
function referencesPattern(
  text: string,
  pattern: () => RegExp,
  dirs: () => readonly (readonly string[])[],
): boolean {
  const views = expandBraces(collapseQuotes(text));
  if (views === null) return true;
  const exemplars = dirs();
  for (const raw of views) {
    const view = collapseSingleCharClass(raw);
    if (pattern().test(view)) return true;
    for (const token of view.split(/\s+/)) {
      if (tokenGlobHitsGuardedDir(token, exemplars)) return true;
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
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === ">") {
      if (segment[i + 1] !== "&") return true;
      const dup = classifyFdDupWord(segment, i + 2);
      if (!dup.isFdDup) return true; // `>&word` writes the FILE `word`
      i = dup.end - 1; // skip the dup word (digits/`-`: nothing special inside)
    }
  }
  return false;
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
 *  splitting inside a substitution cannot launder the class either. The
 *  load-bearing property of the placeholder text is that it cannot form a
 *  redirect or separator: the literal parts contain only [A-Za-z_/],
 *  and the `${SUBAGENT_DIR}` prefix is redirect/separator-free as shipped
 *  (`/tmp/claude-subagents`) — this is contingent on an operator-set
 *  LOOM_SUBAGENT_DIR staying free of shell-special characters. */
function placeholderFor(body: string): string {
  if (referencesProtectedDir(body)) return `${SUBAGENT_DIR}/__subst__`;
  if (referencesGuardedState(body)) return "active_task_graph__subst__";
  return "__subst__";
}

/**
 * Extract `$(…)` / `<(…)` / `>(…)` / backtick substitution bodies (one
 * nesting level — recursion re-enters for nested bodies) and replace each
 * with a placeholder. Single quotes suppress substitution (sh semantics);
 * double quotes do not for `$(…)`/backticks, and treating a double-quoted
 * `<(…)` as live too only errs fail-closed. Returns null when an opener has
 * no closer — unbalanced substitution syntax on a guarded line is judged
 * unparseable, and unparseable fails closed at the caller.
 */
function flattenSubstitutions(command: string): FlattenedCommand | null {
  const bodies: string[] = [];
  let flattened = "";
  let singleQuote = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && !singleQuote) {
      flattened += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'") {
      singleQuote = !singleQuote;
      flattened += c;
      continue;
    }
    if (singleQuote) {
      flattened += c;
      continue;
    }
    const isCmdSub = c === "$" && command[i + 1] === "(";
    const isProcSub = (c === "<" || c === ">") && command[i + 1] === "(";
    if (isCmdSub || isProcSub) {
      const close = findClosingParen(command, i + 2);
      if (close === -1) return null;
      const body = command.slice(i + 2, close);
      bodies.push(body);
      flattened += placeholderFor(body);
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(command, i + 1);
      if (close === -1) return null;
      const body = command.slice(i + 1, close);
      bodies.push(body);
      flattened += placeholderFor(body);
      i = close;
      continue;
    }
    flattened += c;
  }
  return { bodies, flattened };
}

/** Index of the `)` closing a substitution opened before `start` — paren
 *  depth counted quote-aware (parens inside a quoted body don't count).
 *  -1 when unclosed. */
function findClosingParen(command: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = start; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
 * The pure guard decision (no fs) — exported so tests exercise the REAL
 * logic instead of a simulation. guardStateFile wraps it with the
 * task-graph-exists check.
 */
export function guardStateFileDecision(command: string): HookResult {
  return decide(command, 0);
}

function decide(command: string, depth: number): HookResult {
  if (!command) return { kind: "allow" };

  // Lines that never reference a guarded path are not this guard's business.
  // (Checked on the quote-COLLAPSED line: a token hidden inside a
  // substitution body is still present in the raw text, and a token split
  // across adjacent quoted parts — `.cl'aude'/state/…` — reassembles under
  // collapse, so neither escapes this gate. Patterns resolve machinesDir()
  // at decision time — a re-pointed LOOM_MACHINES_DIR is guarded without a
  // module reload.)
  if (!referencesGuardedState(command)) return { kind: "allow" };

  if (depth > MAX_SUBSTITUTION_DEPTH) return BLOCK;

  const flat = flattenSubstitutions(command);
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
          return BLOCK;
        }
        continue;
      }
      if (!hasReadOnlyHead(segment)) return BLOCK;
      if (hasOutputRedirect(segment)) return BLOCK;
    }
  }

  return { kind: "allow" };
}

export function guardStateFile(command: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  return guardStateFileDecision(command);
}
