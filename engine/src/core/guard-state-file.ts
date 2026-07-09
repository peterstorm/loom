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
 *     (quote-aware: any unquoted `>` except an fd-dup `>&`, so `>`, `>>`,
 *     `&>`, and `3>` all count; `2>&1` does not).
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
import {
  TASK_GRAPH_PATH,
  WHITELISTED_HELPERS,
  STATE_FILE_PATTERNS,
  READ_ONLY_STATE_COMMANDS,
  PROTECTED_DIR_PATTERNS,
  SUBAGENT_DIR,
} from "../config";
import {
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
  return (WHITELISTED_HELPERS as readonly string[]).includes(tokens[3] ?? "");
}

/** Quote-aware: does ANY segment of the command line invoke a whitelisted helper? */
export function commandInvokesWhitelistedHelper(command: string): boolean {
  return splitCommandSegmentsWithOps(command).some((s) => segmentInvokesHelper(s.text));
}

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
 * write channel UNLESS it is immediately followed by `&` (an fd dup like
 * `2>&1` / `>&2`). This catches `>`, `>>`, `&>`, and fd-numbered forms
 * (`3>file`) that whitespace-anchored patterns miss, while leaving a `>`
 * inside a quoted argument (`jq 'select(.x > 1)' <state>`) alone.
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
    if (c === ">" && segment[i + 1] !== "&") return true;
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
 *  token away). Alphanumeric/slash only — cannot form a redirect/separator. */
function placeholderFor(body: string): string {
  if (PROTECTED_DIR_PATTERNS.test(body)) return `${SUBAGENT_DIR}/__subst__`;
  if (STATE_FILE_PATTERNS.test(body)) return "active_task_graph__subst__";
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
  // (Checked on the RAW line: a token hidden inside a substitution body is
  // still present in the raw text, so nothing escapes this gate.)
  if (!STATE_FILE_PATTERNS.test(command)) return { kind: "allow" };

  if (depth > MAX_SUBSTITUTION_DEPTH) return BLOCK;

  const flat = flattenSubstitutions(command);
  if (flat === null) return BLOCK;
  for (const body of flat.bodies) {
    if (decide(body, depth + 1).kind === "block") return BLOCK;
  }

  for (const chain of pipeChains(flat.flattened)) {
    // A chain none of whose segments touch a guarded path is out of scope —
    // `npm install && jq . <state>` must not block on the npm segment.
    if (!chain.some((segment) => STATE_FILE_PATTERNS.test(segment))) continue;

    for (const segment of chain) {
      if (segmentInvokesHelper(segment)) {
        // The helper vouches for its own segment (including a redirect of its
        // output into a state file) — but NEVER for a protected-dir write:
        // ledger and machine-definition forgery stay blocked even here.
        if (PROTECTED_DIR_PATTERNS.test(segment) && hasOutputRedirect(segment)) return BLOCK;
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
