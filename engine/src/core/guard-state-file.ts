/**
 * Core: Guard state files from direct modification via Bash.
 * Harness-agnostic — no stdin parsing — and pure: the guarded directories
 * arrive as a `GuardedLocations` value the shell resolves from configuration
 * at decision time, and the task-graph existence gate lives in the shells
 * (the `pre-tool-use/guard-state-file` hook, the Pi extension).
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
 *     that cannot write a file under any flag), or a read-only git, gh, sort,
 *     uniq or find invocation, behind any reserved words (`do`, `then`, `!`,
 *     `{`, …), whose output redirects each name a file with one static
 *     spelling that, lexically normalized, names no guarded state (loom#216).
 *     The exact stderr discard `2>/dev/null` and fd-dups (`2>&1`, `>&2`,
 *     `>&-`) write no file; a runtime, glob, brace or `~` target, `<>`,
 *     `>&file`, and a relative target on a line that changes directory are
 *     unknown and block;
 *   - a binding: only `NAME=value` words, `for NAME in …` or `read NAME…`, of
 *     a name the shell does not read itself (SHELL_STATE_NAMES). A line that
 *     binds puts EVERY chain in scope, so `$NAME` cannot carry a guarded path
 *     into a chain that never names it.
 *
 * A guarded line that may rebind a command name (`commandNamesRebound`: in
 * any command position, a function definition, alias, hash, enable, source,
 * trap, mapfile, or an eval that may do one; PATH, BASH_CMDS, BASH_ALIASES or
 * a loader variable in any spelling) is blocked outright: no head on it is
 * trusted by its name.
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
 * and shells/interpreters executing piped content.
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
 * The shell grammar this guard judges through lives in pure modules shared
 * with every other Bash guard (the subagent authority guard included):
 * core/shell-command-head (simple commands, wrappers, read-only heads,
 * pipe-chains), core/shell-redirects (output redirects), core/shell-heredoc
 * (heredoc bodies) and core/shell-match-views (matching views and glob
 * intersection). This module
 * keeps only the state-file POLICY: what is guarded, which helpers vouch, and
 * the decision. The names below are those modules' walkers.
 *
 * The grammar is a de-facto POSIX grammar, implemented as a few \"walkers\".
 * Their history is a series of divergence bugs (rounds 15–18 twin-scanner
 * drift; the round-20 double-quoted-apostrophe regression; the heredoc
 * inline-program gap), so each walker's purpose and its DIVERGENT semantics
 * are named here, and tests/core/guard-state-file-walkers.test.ts pins the
 * contracts an independent reference walker would catch if any of them drift:
 *
 *  - lexShellQuotes / scanUnquoted (core/shell-quoting) — THE quote lexer
 *    (`"` `'` `` ` `` regions, `\` escapes except in single quotes). Every
 *    command-level scan walks it: the segment splitter, stripComment,
 *    stripEnvPrefix, shellWords / commandWords, splitFusedRedirect,
 *    redirectsOf, segmentInvokesHelper (through shellWords) and the evidence
 *    scanner's word reader. A new command-level scan supplies a visitor; it
 *    never writes a quote loop.
 *  - redirectsOf (core/shell-redirects) — THE output-redirect scan, a typed
 *    union per redirect. hasOutputRedirect, outputRedirectTargets and the
 *    evidence scanner's redirect targets are projections of it, so the guard
 *    and the ledger cannot disagree on which redirects a segment has.
 *  - scanSubstitutions (core/shell-substitution) — the ONE shared substitution
 *    traversal (quote state `'"' | "'" | null`; a `'` inside `"…"` is literal;
 *    `$(…)`/backticks stay LIVE inside double quotes; `<(…)`/`>(…)` is live
 *    only unquoted). Shared by blankSubstitutions + flattenSubstitutions so the
 *    two views cannot diverge, and by test-evidence classification so the
 *    guard and the evidence ledger agree on substitution spans.
 *  - findClosingParen / findClosingBacktick (core/shell-substitution) and
 *    findClosingBrace — span closers, quote-aware; used by every scanner that
 *    must skip a whole span. findClosingParen first tries staticHeredocCat:
 *    `$(cat <<'D' … D)` closes at its exact span (the body is data, so its
 *    quotes and parens never count), and scanSubstitutions reports such a
 *    span standing as a whole double-quoted word as a `known-word` context —
 *    the only case whose output the guard treats as known (KNOWN_TEXT).
 *  - commandWords / splitFusedRedirect / unquote / commandArgs — the simple-
 *    command tokenizer feeding analyzeCommandHead; treats `( ) { }` as
 *    standalone tokens so compound syntax never hides a head.
 *  - openerLineGroups — heredoc opener-line group cut at depth 0 on
 *    `; && || &` with compound tracking ({ }, ( ), if/fi, while…done,
 *    case…esac, [[ ]]); pipe members stay in ONE group.
 *  - scanPastHeredocSpans / parseHeredocDelimiter / scanHeredocBodySubstitutions
 *    — the heredoc pre-pass; bodies are data unless the owning group EXECUTES
 *    stdin (commandsExecuteStdin, which recurses into
 *    inline `-c` programs because they inherit the command's stdin).
 *  - unquoted-heredoc bodies are scanned quote-INSENSITIVELY (only `\`
 *    escapes), because quote chars are literal data there.
 *
 * When adding a walker, prefer extending these rather than writing a new
 * quote loop; when changing quote semantics, run the walker net + every pin
 * in the heredoc and edge-case describes below.
 */

import type { HookResult } from "../types";
import { scanSubstitutions, type SubstitutionContext } from "./shell-substitution";
import { guardedDirsOf, protectedDirsOf, type GuardedLocations } from "./guarded-locations";
import { stripComment, stripEnvPrefix } from "./shell-command";
import {
  bindingNames,
  commandNamesRebound,
  hasReadOnlyHead,
  isRedirectsOnly,
  pipeChains,
  SHELL_STATE_NAMES,
  shellWords,
  unquote,
  withoutReservedWords,
} from "./shell-command-head";
import { MAX_SUBSTITUTION_DEPTH, splitHeredocs } from "./shell-heredoc";
import { hasOutputRedirect, outputRedirectTargets } from "./shell-redirects";
import {
  knownWordOutput,
  leadingDotPolicyOf,
  OPAQUE_OUTPUT,
  referencesPattern,
  staticSpelling,
  SUBSTITUTION_PLACEHOLDER_MARK,
  type LeadingDotPolicy,
} from "./shell-match-views";

/** The helpers whose own segment may write guarded state (never a protected
 *  directory) — matched by `segmentInvokesHelper` below. */
export const WHITELISTED_HELPERS: readonly string[] = [
  "mark-tests-passed",
  "store-review-findings",
  "store-spec-check",
  "populate-task-graph",
  "write-verification-manifest",
  "upgrade-spec-trace",
  "amend-spec-trace",
  "amend-spec",
  "revise-contract",
  "repair-task-graph",
  "review-packet",
  "store-test-evidence",
  "reconcile-implementation-proof",
  "set-phase",
  "cleanup-state",
  "record-retro",
];

const ALLOWED_LINE = "Allowed: read-only commands (jq, cat, grep, head, ls, diff, …), read-only git, gh, sort, uniq and find invocations, loops and variable bindings over reads, output redirected to a named file outside guarded state, or whitelisted helpers.";

const BLOCK: HookResult = {
  kind: "block",
  message: [
    "BLOCKED: Command referencing loom-guarded state must be read-only.",
    "State is managed by hooks and helper scripts only.",
    ALLOWED_LINE,
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
  lines.push("State is managed by hooks and helper scripts only.", ALLOWED_LINE);
  return { kind: "block", message: lines.join("\n") };
}

/**
 * Does this simple-command segment ACTUALLY invoke a whitelisted helper?
 * The only documented invocation shape is `bun <path>/cli.ts helper <name>`
 * — matched word-by-word at the segment HEAD (after comment/env-prefix
 * stripping), so a helper name appearing anywhere else in the segment
 * (echo argument, comment, path component) never matches. The words are the
 * shell's (`shellWords`), and a word holding whitespace (`"/a b/cli.ts"`,
 * `${X:-a b}`) never matches: an allowlist admits only what every reading of
 * the line agrees on.
 */
function segmentInvokesHelper(segment: string): boolean {
  const tokens = shellWords(stripEnvPrefix(stripComment(segment).trim())).slice(0, 4).map(unquote);
  if (tokens.some((token) => /\s/.test(token))) return false;
  const head = tokens[0] ?? "";
  const headBase = head.slice(head.lastIndexOf("/") + 1);
  if (headBase !== "bun") return false;
  const cli = tokens[1] ?? "";
  if (cli !== "cli.ts" && !cli.endsWith("/cli.ts")) return false;
  if (tokens[2] !== "helper") return false;
  return WHITELISTED_HELPERS.includes(tokens[3] ?? "");
}

/** The scope of ONE decision: its two predicates, fixed to the guarded
 *  locations and to the whole command line's leading-dot policy (a segment
 *  judged alone must not lose a `shopt -s dotglob` that an earlier segment of
 *  the same line ran), and the placeholder a protected-dir substitution body
 *  flattens to. */
export interface GuardScope {
  readonly guardedState: (text: string) => boolean;
  readonly protectedDir: (text: string) => boolean;
  /** A path inside the subagent dir — itself a protected-dir reference. */
  readonly protectedPlaceholder: string;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A directory as `/`-split segments (empty segments dropped) for the glob-
 *  intersection scope test: a glob path reaching AT or INTO a guarded dir
 *  could name a guarded file even when no literal survives quote-collapse. */
const toSegments = (dir: string): readonly string[] => dir.split("/").filter((s) => s !== "");

/**
 * The scope one decision judges with. Guarded state is the task-graph and
 * review-invocations names plus every guarded directory: an agent writing the
 * evidence ledger or binding files in the subagent dir would forge trusted
 * test evidence or fake attribution, `rm` of a machine definition makes the
 * gate see "no machine" for a bound agent, and a glob (`active_task*.json`,
 * `.claude/state/*.json`) or brace (`active_task_{graph,x}.json`) write names
 * a state directory but never the file literal — so only a dir match catches
 * it. The protected dirs (subagent, machine definitions) are additionally
 * never helper-writable. `policy` defaults to the fail-closed leading-dot
 * policy for callers judging a fragment without its line.
 */
export function guardScope(
  locations: GuardedLocations,
  policy: LeadingDotPolicy = "wildcards-match",
): GuardScope {
  const guardedDirs = guardedDirsOf(locations);
  const protectedDirs = protectedDirsOf(locations);
  const statePattern = new RegExp(
    ["active_task_graph", "review-invocations", ...guardedDirs].map(escapeRegex).join("|"),
  );
  const protectedPattern = new RegExp(protectedDirs.map(escapeRegex).join("|"));
  const guardedSegments = guardedDirs.map(toSegments);
  const protectedSegments = protectedDirs.map(toSegments);
  return {
    guardedState: (text) => referencesPattern(text, statePattern, guardedSegments, policy),
    protectedDir: (text) => referencesPattern(text, protectedPattern, protectedSegments, policy),
    protectedPlaceholder: `${locations.subagentDir}/${SUBSTITUTION_PLACEHOLDER_MARK}`,
  };
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
 *  with NO guarded token flattens to the substitution WILDCARD OPAQUE_OUTPUT —
 *  the fail-closed model of a substitution's statically-unknowable output
 *  (matched like `*`, except that it may produce a leading `.`). This subsumes
 *  BOTH output channels the flattened text must reflect: an EMPTY output
 *  (`$(:)` → "") where a guarded literal fragmented across the substitution
 *  rejoins bash-side (`.claude/stat$(:)e` → `.claude/state`, matched here as
 *  the wildcard form of `.claude/stat*e` fnmatching the `.claude/state` dir),
 *  AND a NONEMPTY output that COMPLETES a guarded literal
 *  (`.claude/stat$(printf e)` → `.claude/state`, the round-26 fail-open — an
 *  empty placeholder yielded `.claude/stat`, which the chain-scope check then
 *  skipped as out-of-scope). The wildcard is special to the matching layer
 *  (segmentGlobMatches / tokenGlobHitsGuardedDir expand it), so unlike a
 *  LITERAL filler — the round-20 concealment, which re-split the literal and
 *  hid the rejoin — it can never itself break a guarded match; it can only
 *  surface more references. The load-bearing property of the non-empty
 *  placeholder texts is that they cannot form a redirect or separator:
 *  OPAQUE_OUTPUT and the literal parts contain only [A-Za-z_/] plus U+2217,
 *  and the subagent-dir prefix of `protectedPlaceholder` is redirect/
 *  separator-free as shipped (`/tmp/claude-subagents`) — this is contingent on
 *  an operator-set LOOM_SUBAGENT_DIR staying free of shell-special characters. */
function placeholderFor(body: string, scope: GuardScope, context: SubstitutionContext): string {
  if (scope.protectedDir(body)) return scope.protectedPlaceholder;
  if (scope.guardedState(body)) return `active_task_graph${SUBSTITUTION_PLACEHOLDER_MARK}`;
  return knownWordOutput(context) ?? OPAQUE_OUTPUT;
}

/**
 * Extract `$(…)` / `<(…)` / `>(…)` / backtick substitution bodies (one
 * nesting level — recursion re-enters for nested bodies) and replace each
 * with a placeholder. Quote-awareness is delegated to scanSubstitutions: single
 * quotes suppress substitution (sh semantics), a `'` inside double quotes stays
 * literal, and `$(…)`/backticks stay live in double quotes while `<(…)`/`>(…)`
 * do not. Returns null when an opener has no closer — unbalanced substitution
 * syntax on a guarded line is judged unparseable, and unparseable fails closed
 * at the caller. `scope` classifies each body for its placeholder (a caller
 * judging text out of context passes `guardScope(locations)`, whose default
 * leading-dot policy is the fail-closed one).
 */
export function flattenSubstitutions(
  command: string,
  scope: GuardScope,
): FlattenedCommand | null {
  const scan = scanSubstitutions(command, (body, context) => placeholderFor(body, scope, context));
  if (scan.unclosed) return null;
  return { bodies: scan.bodies, flattened: scan.rebuilt };
}

/**
 * The pure guard decision over the guarded locations the shell resolved for
 * this call. The shells (the `pre-tool-use/guard-state-file` hook, the Pi
 * extension) gate it on the task graph existing.
 */
export function guardStateFileDecision(command: string, locations: GuardedLocations): HookResult {
  return decide(command, 0, guardScope(locations, leadingDotPolicyOf(command)));
}

function decide(command: string, depth: number, scope: GuardScope): HookResult {
  if (!command) return { kind: "allow" };

  // Heredoc bodies are data, not command text: strip them BEFORE the front
  // gate so inert prose inside a heredoc (backticked package names, mentions
  // of the state dirs, the review-invocations literal) can never block a
  // command whose only writes are unguarded. Live parts of unquoted bodies
  // come back through `bodies` below.
  const hd = splitHeredocs(command);
  if (hd.unparseable && scope.guardedState(hd.stripped)) return BLOCK;

  // Unquoted-heredoc bodies: substitutions execute, the rest is data. These
  // are judged BEFORE the stripped-text front gate so a body substitution
  // (`$(rm .claude/state/…)` inside `cat << EOF … EOF`) cannot hide behind a
  // stripped text that otherwise references nothing guarded. Quoted bodies
  // contribute nothing (opaque data).
  if (depth > MAX_SUBSTITUTION_DEPTH) return BLOCK;
  for (const body of hd.bodies) {
    if (decide(body, depth + 1, scope).kind === "block") return BLOCK;
  }

  // Lines that never reference a guarded path are not this guard's business.
  // (Checked on the quote-COLLAPSED line: a token hidden inside a
  // substitution body is still present in the raw text, and a token split
  // across adjacent quoted parts — `.cl'aude'/state/…` — reassembles under
  // collapse, so neither escapes this gate. Patterns resolve machinesDir()
  // at decision time — a re-pointed LOOM_MACHINES_DIR is guarded without a
  // module reload.)
  if (!scope.guardedState(hd.stripped)) return { kind: "allow" };

  const flat = flattenSubstitutions(hd.stripped, scope);
  if (flat === null) return BLOCK;
  for (const body of flat.bodies) {
    if (decide(body, depth + 1, scope).kind === "block") return BLOCK;
  }

  return judgePipeChains(flat.flattened, scope);
}

/** The block for a guarded line on which a command name may run another program. */
const REBOUND_BLOCK: HookResult = {
  kind: "block",
  message: [
    "BLOCKED: Command referencing loom-guarded state must be read-only.",
    "This line may rebind a command name (a function, alias, hash, enable, source, trap, mapfile, eval, PATH, BASH_CMDS, BASH_ALIASES or a loader variable), so no command on it is trusted as a read.",
    "State is managed by hooks and helper scripts only.",
    ALLOWED_LINE,
  ].join("\n"),
};

/** A directory change on the line: every relative path after it may resolve somewhere else. */
const CHANGES_DIRECTORY = /(?:^|[\s;&|(`{!])(?:cd|pushd|popd)(?=[\s;&|)]|$)/;

/**
 * The line-wide facts a segment is judged with: whether a command name may be
 * rebound, whether any segment binds a variable (then every chain is in scope,
 * since `$NAME` can carry a guarded path into any of them), and whether a
 * relative redirect target can still be judged by its text.
 */
interface LineFacts {
  readonly binds: boolean;
  readonly relativeTargetsKnown: boolean;
}

/**
 * Judge every pipe-chain of a flattened guarded line (loom#216: by what each
 * segment can write, not by what it mentions). A line that may rebind a command
 * name trusts no head. Otherwise every segment of an in-scope chain must be a
 * whitelisted helper, a binding, or a read whose output redirects all name
 * known, unguarded files.
 */
function judgePipeChains(flattened: string, scope: GuardScope): HookResult {
  if (commandNamesRebound(flattened)) return REBOUND_BLOCK;
  const chains = pipeChains(flattened);
  const facts: LineFacts = {
    binds: chains.some((chain) => chain.some((segment) => bindingNames(segment) !== null)),
    relativeTargetsKnown: !CHANGES_DIRECTORY.test(flattened),
  };
  for (const chain of chains) {
    // A chain none of whose segments touch a guarded path is out of scope —
    // `npm install && jq . <state>` must not block on the npm segment —
    // unless the line binds a variable, which may carry a guarded path there.
    // (Tested quote-collapsed, like every pattern site.)
    if (!facts.binds && !chain.some(scope.guardedState)) continue;
    const refused = chain.find((segment) => !segmentAdmitted(segment, scope, facts));
    if (refused !== undefined) return blockFor(chain, refused);
  }
  return { kind: "allow" };
}

/** May this segment of an in-scope chain run? */
function segmentAdmitted(segment: string, scope: GuardScope, facts: LineFacts): boolean {
  if (segmentInvokesHelper(segment)) {
    // The helper vouches for its own segment (including a redirect of its
    // output into a state file) — but NEVER for a protected-dir write:
    // ledger and machine-definition forgery stay blocked even here, including
    // through a target a binding on the line could have aimed there.
    if (!hasOutputRedirect(segment)) return true;
    if (scope.protectedDir(segment)) return false;
    return !facts.binds || redirectsKnownAndUnguarded(segment, facts, scope.protectedDir);
  }
  const names = bindingNames(segment);
  if (names !== null) return names.every((name) => !SHELL_STATE_NAMES.has(name)) && !hasOutputRedirect(segment);
  const command = withoutReservedWords(segment);
  const runs = command === "" || isRedirectsOnly(command) || hasReadOnlyHead(command);
  return runs && (!hasOutputRedirect(command) || redirectsKnownAndUnguarded(command, facts, scope.guardedState));
}

/**
 * Does every output redirect of the segment write a file whose one static
 * spelling, lexically normalized, `guarded` does not match? A runtime, glob,
 * brace or `~` target, a read-write open and a `>&file` are unknown; a
 * relative target is unknown on a line that changes directory.
 */
function redirectsKnownAndUnguarded(
  segment: string,
  facts: LineFacts,
  guarded: (text: string) => boolean,
): boolean {
  const targets = outputRedirectTargets(segment);
  if (targets === null) return false;
  return targets.every((word) => {
    const spelled = staticSpelling(word);
    if (spelled === null || spelled === "" || spelled.startsWith("~")) return false;
    if (!facts.relativeTargetsKnown && !spelled.startsWith("/")) return false;
    return !guarded(spelled) && !guarded(lexicalPath(spelled));
  });
}

/**
 * A path with its empty and `.` segments dropped and each `..` folded into the
 * segment before it, as text: a/b, a//b, a/./b and a/x/../b all read a/b, so
 * a guarded directory cannot hide behind a spelling. A `..` with nothing before it
 * stays, so a target climbing out of the working directory keeps its climb.
 */
function lexicalPath(path: string): string {
  const kept: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(part);
  }
  return `${path.startsWith("/") ? "/" : ""}${kept.join("/")}`;
}
