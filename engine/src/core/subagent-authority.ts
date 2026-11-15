/**
 * Subagent authority (ADR-0067 D6, amended): which Bash commands a SUBAGENT may
 * not run because they mutate audit or orchestration authority. The harness
 * adapters (Claude Code `guard-subagent-authority`, Pi's `tool_call` twin) call
 * this only for calls the harness itself attributes to a subagent; parent
 * calls never reach it.
 *
 * This is DEFENCE IN DEPTH. A ballot's authority rests on the data path — the
 * capture attestation the capturing harness writes into the protected store
 * and `verify --from` / adjudication re-check — not on this fence. The fence
 * keeps the obvious doors shut:
 *
 *  1. AUTHORITY HELPER OPERATIONS. `helper security-audit <op>` and
 *     `helper orchestration <op>` are refused unless the operation is a
 *     read-only projection. The split is DERIVED from each helper's operation
 *     table (`security-audit-operations.ts`, `orchestration-operations.ts`): an
 *     operation whose `subagent` trait is `read-only` writes nothing and is
 *     allowed; every `parent-only` operation writes run state and is refused. An
 *     operation that is not statically one known name is refused too.
 *  2. HARNESS ENTRYPOINTS. A Loom CLI hook route (`subagent-stop`,
 *     `post-tool-use`, … — the harness's job, never an agent's) and a nested
 *     harness (`claude`, `pi`, `npx|bunx|pnpm dlx` of either) are refused.
 *  3. AUTHORITY PATH WRITES. A write onto a registered audit run's authority
 *     entries (`audit-run-authority.ts`), onto the run directory itself or an
 *     ancestor of it (`rm -rf <run>`, `cp x <run>/`, `tar -C <parent>`), or into
 *     a protected Loom directory (the subagent dir that holds the run registry
 *     and the capture attestation store, the machine definitions).
 *     `agents/<owner>/{scratch,artifacts}/**` stay writable. A pipe-chain that
 *     REFERENCES an authority path may contain only read-only segments, and no
 *     segment anywhere may REDIRECT output onto one. A segment that runs one of
 *     the Loom package's read-only scripts (`read-context-packet.ts`, …) by its
 *     plain path is a read-only segment, whatever paths it names, and so is
 *     a `git` invocation that writes nothing outside the repository's own
 *     `.git` (`read-only-git.ts`: `git -C <checkout> fetch`). On a typed
 *     line that may rebind a command name (`hash`, `alias`, `enable`, a
 *     function) no segment is read-only by its head. A bare
 *     assignment of an inert name (`inertNamesOf`: `T=$CLAUDE_JOB_DIR/tmp`,
 *     whose every read the guard splices) names a path without writing above
 *     it; every other assignment is judged as a write over what it names.
 *
 * Normalisations (every form reaches the same three rules): a head's backslash
 * escapes are dropped (`\loom`, `l\oom`); wrappers are unwrapped (`env`,
 * `sudo`, `time`, `command`, `builtin`, `nice`, `nohup`, `timeout`, `stdbuf`,
 * `setsid`, …), `coproc` and `!` are syntax; `bash -c`, `eval`, `xargs`,
 * `find -exec`, substitutions and executed heredoc bodies run as programs of
 * their own; a shell FED a program — through a pipe, a here-string (`<<<`), an
 * input redirect, a script file argument, `source`/`.`, or an executed `./x.sh`
 * — has that program judged (a script file is read at decision time through the
 * filesystem port, bounded and regular-file-only; an unreadable one refuses
 * only a line that concerns authority; a script FILE is judged on the paths it
 * names literally); an interpreter's literal code (`python -c`, `node -e/-p`,
 * `bun -e`, `perl -e`, `ruby -e`, awk programs, and code fed through a pipe or
 * here-string) is refused when it invokes a writing helper operation or a hook
 * route, or loads an engine authority module.
 *
 * Paths are judged against the canonical run directories the registry holds
 * (each in every spelling: as registered and its realpath), and each literal
 * path also in its canonical spelling (the realpath of its deepest existing
 * ancestor), so a symlinked alias of a run reaches it. Relative words resolve
 * against every directory the SEGMENT may run in (`lineDirectories`): a
 * line's `cd`/`pushd`/`popd` moves are followed through its separators — after
 * `&&` only where the move succeeded, after `||` only where it failed, after
 * `;` either way, a move in a pipeline or behind `&` staying in its subshell,
 * a bare relative target searched along `CDPATH` — and a line with compound
 * syntax, or a move the guard cannot place, falls back to every directory the
 * line may reach — as does a line that may turn on lastpipe or physical `cd`;
 * a line that may set `CDPATH` or `HOME` makes the moves they steer unknown.
 * `~` resolves against home; a variable the line binds to a spliceable value
 * (`lineVariables`) is judged with that value in place as well as as written
 * (past 16 spellings, or on a line that may set `IFS`, such a word fails
 * closed); globs and brace/quote/parameter views go through the shared match
 * views. When the registry is UNREADABLE every path whose segments name
 * an authority entry is treated as authority (fail closed); the same suffix
 * rule covers words the shell completes at runtime on a typed line.
 *
 * Known gaps (pinned as allowed in tests/core/subagent-authority.test.ts): a
 * command or helper NAME the shell constructs from pieces (`eval "$a $b"`, a
 * command held in a variable), a variable set outside the line, or to a
 * substitution's output (`T=$(cat f)`), holding an authority path, a `cd`
 * through such a variable (its target is unknown, and an unknown directory is
 * judged by authority entry names alone), `HOME`/`CDPATH`/`IFS` set in an earlier
 * command, a command name rebound in an earlier command (`hash`, `alias`),
 * physical `cd` through a symlink after an earlier `cd` on the line,
 * interpreter code built at runtime (base64, string concatenation), names
 * spelled in `printf` escapes, a script whose text is runtime-built and then
 * run, a symlink to a run created on the same line with a runtime-built target,
 * and an interpreter's own script FILE (only literal code is scanned). None of
 * them can produce an attested capture: the attestation store is protected
 * and written only by the capturing harness process.
 *
 * Pure: strings in, a decision out; the filesystem is a port.
 */

import { isAbsolute, normalize } from "node:path";
import { match } from "ts-pattern";
import { SECURITY_AUDIT_AUTHORITY_ENTRIES } from "./audit-run-authority";
import { READ_ONLY_SCRIPTS } from "./loom-cli-command";
import { isReadOnlyGitInvocation } from "./read-only-git";
import { scanSubstitutions } from "./shell-substitution";
import { stripComment, type SegmentOp } from "./shell-command";
import {
  analyzeCommandHead,
  commandWords,
  hasReadOnlyHead,
  headBase,
  pipeChains,
  placedPipeChains,
  resolvedInterpreter,
  shellWords,
  splitFusedRedirect,
  unquote,
} from "./shell-command-head";
import { inlineProgramArg, MAX_SUBSTITUTION_DEPTH, readsProgramFromStdin, SH_FAMILY_HEADS, splitHeredocs } from "./shell-heredoc";
import {
  collapseVariants,
  expandBraces,
  GLOB_CHAR,
  leadingDotPolicyOf,
  OPAQUE_OUTPUT,
  segmentGlobMatches,
  type LeadingDotPolicy,
} from "./shell-match-views";

// ── Inputs and decision ──────────────────────────────────────────────────────

/** What the registry said about audit runs: their canonical directories, or
 *  that it could not be read (the guard then fails closed on authority-shaped
 *  paths everywhere). */
export type RegisteredRuns =
  | Readonly<{ kind: "known"; directories: readonly string[] }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

export type SubagentAuthorityContext = Readonly<{
  /** The calling agent's working directory (absolute), or null when the
   *  harness did not say — relative paths are then judged by the suffix rule. */
  cwd: string | null;
  /** The home directory `~` expands to, or null when unknown. */
  home: string | null;
  runs: RegisteredRuns;
  /** Absolute directories no subagent may write into at all (the subagent dir,
   *  the machine definitions), each in every spelling the shell might use. */
  protectedDirectories: readonly string[];
  /** Each authority helper's operations, split by the trait its table declares. */
  helperOperations: AuthorityHelperOperations;
  /** The Loom CLI's harness-hook route families (`pre-tool-use`,
   *  `subagent-stop`, …): a subagent never invokes a hook entrypoint — the
   *  harness does — so a CLI call naming one is refused. */
  hookRoutes: ReadonlySet<string>;
  /** The running Loom package's read-only scripts (`scripts/read-context-packet.ts`,
   *  …), by absolute path in every spelling: a segment that runs one plainly
   *  reads, whatever paths it names (`loomCommands().readOnlyScripts`). */
  readOnlyScripts: readonly string[];
  /** The directories a bare relative `cd` target is searched in (`CDPATH`,
   *  parsed by `parseCdSearchPath`); empty when the variable is unset. */
  cdSearchPath: readonly string[];
  /** What the guard may observe of the filesystem at decision time. */
  filesystem: SubagentFilesystemView;
}>;

/**
 * `CDPATH` as the directories a bare relative `cd` target is searched in, in
 * order. An empty entry is the current directory, as bash reads it; an unset or
 * empty variable searches nothing (the target resolves against the current
 * directory alone).
 */
export const parseCdSearchPath = (value: string | undefined): readonly string[] =>
  value === undefined || value === "" ? [] : value.split(":").map((entry) => (entry === "" ? "." : entry));

/** One script the guard read at decision time, or why it could not. */
export type ScriptRead =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/**
 * The filesystem port of the decision (the shell implements it; tests use
 * `LEXICAL_FILESYSTEM` or their own fake):
 * - `canonicalize` maps an absolute path to its canonical spelling — the
 *   realpath of its deepest existing ancestor plus the rest — so a symlinked
 *   alias of a run directory (`/tmp` ↔ `/private/tmp`, a planted link) is
 *   judged as the run it reaches;
 * - `readScript` reads a script a command would execute (bounded, no-follow).
 */
export type SubagentFilesystemView = Readonly<{
  canonicalize: (absolutePath: string) => string;
  readScript: (absolutePath: string) => ScriptRead;
}>;

/** The view with no filesystem behind it: paths are judged lexically and no
 *  script can be read (an unreadable script refuses only an authority-relevant line). */
export const LEXICAL_FILESYSTEM: SubagentFilesystemView = Object.freeze({
  canonicalize: (absolutePath: string) => absolutePath,
  readScript: () => ({ kind: "unreadable" as const, reason: "no filesystem view" }),
});

/** The helpers whose write operations are subagent-forbidden. */
const AUTHORITY_HELPERS = ["security-audit", "orchestration"] as const;
export type AuthorityHelper = (typeof AUTHORITY_HELPERS)[number];

/**
 * One helper's operation names, split by its table's `subagent` trait:
 * `readOnly` holds the `read-only` projections (they write nothing),
 * `known` every operation the dispatcher accepts. The split is derived from
 * the tables by the shell (`handlers/pre-tool-use/subagent-authority-operations`)
 * — core may not import the handler tables, and must not keep a copy of them.
 */
export type HelperOperationSplit = Readonly<{ known: ReadonlySet<string>; readOnly: ReadonlySet<string> }>;
export type AuthorityHelperOperations = Readonly<Record<AuthorityHelper, HelperOperationSplit>>;

export type SubagentAuthorityRefusal =
  | Readonly<{ rule: "authority-helper-operation"; segment: string; helper: AuthorityHelper | "unresolved"; operation: string | null }>
  | Readonly<{ rule: "authority-path-write"; segment: string; path: string }>
  | Readonly<{ rule: "unparseable-authority-command"; segment: string }>
  | Readonly<{ rule: "harness-hook-entrypoint"; segment: string; route: string }>
  | Readonly<{ rule: "nested-harness"; segment: string; harness: string }>
  | Readonly<{ rule: "interpreter-authority-code"; segment: string; reason: string }>
  | Readonly<{ rule: "unreadable-script"; segment: string; path: string; reason: string }>;

export type SubagentAuthorityDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "refuse"; refusal: SubagentAuthorityRefusal }>;

const ALLOW: SubagentAuthorityDecision = Object.freeze({ kind: "allow" });

// ── Helper operations, derived from the operation tables ─────────────────────

type OperationVerdict = "read-only" | "writes" | "unknown";

/** One operation name against one helper's split: read-only projections are
 *  allowed; every other known operation writes. */
const verdictOf = (split: HelperOperationSplit, operation: string): OperationVerdict => {
  if (split.readOnly.has(operation)) return "read-only";
  return split.known.has(operation) ? "writes" : "unknown";
};

/** Every spelling bash could give one word (quote collapse, parameter
 *  states, brace expansion). Null when the view set is unbounded. */
function wordViews(word: string): readonly string[] | null {
  const variants = collapseVariants(word);
  if (variants === null) return null;
  const views = new Set<string>();
  for (const variant of variants) {
    const expanded = expandBraces(variant);
    if (expanded === null) return null;
    for (const view of expanded) views.add(view);
  }
  return [...views];
}

/** Text the shell completes at runtime: an expansion, a substitution's opaque
 *  output, or a backtick. */
const hasRuntimePart = (word: string): boolean => /[$`]/.test(word) || word.includes(OPAQUE_OUTPUT);

/** Does this word name `literal`, as far as static analysis can tell? A word
 *  with a runtime part may become anything, so it may name it. */
function wordMayBe(word: string, literal: string): boolean {
  if (hasRuntimePart(word)) return true;
  return wordViews(word)?.includes(literal) ?? true;
}

/**
 * How a text is read — the file's central distinction, as one type:
 * - `typed`: the command line the agent wrote. Every over-approximation
 *   applies: a word the shell completes at runtime may name anything.
 * - `script`: the text of a script FILE the line runs — a whole program full
 *   of runtime-completed words (`"$@"`, `"$cmd"`), judged on what it names
 *   literally.
 */
type ScopeMode = "typed" | "script";

/** Does `word` name `literal` under `mode`: on a typed line whenever it MAY
 *  (`wordMayBe`); in a script only when it literally does — no runtime part,
 *  and one of its spellings is the literal. */
const namesLiteral = (word: string, literal: string, mode: ScopeMode): boolean =>
  mode === "typed" ? wordMayBe(word, literal) : !hasRuntimePart(word) && (wordViews(word)?.includes(literal) ?? false);

/** The governed helper a word may name: one, any (runtime-built), or none. */
function helperNamed(word: string): AuthorityHelper | "unresolved" | null {
  if (hasRuntimePart(word)) return "unresolved";
  const views = wordViews(word);
  if (views === null) return "unresolved";
  return AUTHORITY_HELPERS.find((helper) => views.includes(helper)) ?? null;
}

/** The operation verdict across every view of the operation word: read-only
 *  only when EVERY spelling is a read-only operation of the helper (or, for an
 *  unresolved helper, of every helper). */
function operationVerdict(
  operations: AuthorityHelperOperations,
  helper: AuthorityHelper | "unresolved",
  word: string | undefined,
): OperationVerdict {
  if (word === undefined || hasRuntimePart(word)) return "unknown";
  const views = wordViews(word);
  if (views === null || views.length === 0) return "unknown";
  const helpers = helper === "unresolved" ? AUTHORITY_HELPERS : [helper];
  const verdicts = views.flatMap((view) => helpers.map((h) => verdictOf(operations[h], view)));
  if (verdicts.includes("writes")) return "writes";
  if (verdicts.includes("unknown")) return "unknown";
  return "read-only";
}

const JS_RUNTIMES: ReadonlySet<string> = new Set(["bun", "bunx", "node", "npx", "tsx", "deno", "pnpm", "yarn"]);
const CLI_ENTRY = /^cli\.(?:ts|js|mjs)$/;

/** The words after the CLI entry point of a Loom CLI invocation, or null when
 *  the command is not one. */
function loomCliArguments(head: string, args: readonly string[], mode: ScopeMode): readonly string[] | null {
  if (head === "loom" || CLI_ENTRY.test(headBase(head))) return args;
  // `$(which loom) helper …`: judge the arguments — on a typed line. In a
  // script FILE a runtime head (`"$@"`, `"$cmd"`) is ordinary plumbing.
  if (hasRuntimePart(head)) return mode === "script" ? null : args;
  if (!JS_RUNTIMES.has(head)) return null;
  const entry = args.findIndex((arg) => CLI_ENTRY.test(headBase(unquote(arg))) || (mode === "typed" && hasRuntimePart(arg)));
  return entry === -1 ? null : args.slice(entry + 1);
}

type HelperInvocation = Readonly<{
  helper: AuthorityHelper | "unresolved";
  operation: string | null;
  verdict: OperationVerdict;
  /** The raw words after the operation: its flags, as the shell wrote them. */
  rest: readonly string[];
}>;

/** The governed helper invocation a simple command makes, or null. */
function helperInvocation(
  operations: AuthorityHelperOperations,
  head: string,
  args: readonly string[],
  mode: ScopeMode,
): HelperInvocation | null {
  const cliArgs = loomCliArguments(head, args, mode);
  if (cliArgs === null) return null;
  for (let index = 0; index + 1 < cliArgs.length; index++) {
    if (!namesLiteral(cliArgs[index], "helper", mode)) continue;
    const helper = helperNamed(cliArgs[index + 1]);
    if (helper === null || (mode === "script" && helper === "unresolved")) continue;
    const operation = cliArgs[index + 2];
    return {
      helper,
      operation: operation ?? null,
      verdict: operationVerdict(operations, helper, operation),
      rest: cliArgs.slice(index + 3),
    };
  }
  return null;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** One authority root: a run directory (only its authority entries) or a
 *  protected directory (everything beneath it). */
type AuthorityRoot = Readonly<{ path: string; entries: readonly string[] | "all" }>;

type PathScope = Readonly<{
  roots: readonly AuthorityRoot[];
  /** Registry unreadable: every authority-shaped path counts. */
  unknownRuns: boolean;
  /** Every directory the judged segment may run in; `unresolved` when a `cd`
   *  target on its line is runtime-built (relative words then take the suffix
   *  rule). */
  cwds: readonly string[];
  cwdUnresolved: boolean;
  home: string | null;
  /** `CDPATH`, as the context observed it. */
  cdSearchPath: readonly string[];
  /** What the judged line, and the lines it is nested in, do to the shell (`withLineShell`). */
  shell: LineShell;
  policy: LeadingDotPolicy;
  /** The filesystem port's canonical spelling of an absolute path. */
  canonicalize: (absolutePath: string) => string;
  /**
   * `typed`: every over-approximation applies (a word the shell completes at
   * runtime, a relative word after an unresolvable `cd`, or a glob counts as
   * authority when its segments may name an authority entry). `script`: a
   * whole program full of runtime-completed words and `case` patterns,
   * judged on the paths it names literally (and still on every helper, hook,
   * harness and interpreter rule). An unreadable registry keeps the suffix
   * rule in both modes.
   */
  mode: ScopeMode;
}>;

const segmentsOf = (path: string): readonly string[] => path.split("/").filter((s) => s !== "" && s !== ".");

const trimSlash = (path: string): string => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

/** Absolute normalized path under `base` (absolute). Never consults the
 *  process cwd. */
const absoluteUnder = (base: string, path: string): string =>
  trimSlash(normalize(isAbsolute(path) ? path : `${base}/${path}`));

/** Does an authority entry name appear among a path's segments? The rule for
 *  paths whose root the guard cannot place. A segment with no literal text
 *  (`*`, a substitution's output) names nothing: counting it would refuse
 *  every command that takes `$(…)` as an argument. */
const authorityShaped = (path: string, policy: LeadingDotPolicy): boolean =>
  segmentsOf(path).some((segment) =>
    segment.replace(/[*?∗]/g, "") !== "" &&
    SECURITY_AUDIT_AUTHORITY_ENTRIES.some((entry) =>
      GLOB_CHAR.test(segment) ? segmentGlobMatches(segment, entry, policy) : segment === entry));

/** Literal absolute path vs one root: at/above the root (it reaches it), or
 *  inside one of its authority entries. `reach: false` skips the above-root
 *  case (an assignment names a path; it does not write above it). */
function literalTouches(path: string, root: AuthorityRoot, reach: boolean): boolean {
  if (path === root.path) return true;
  if (reach && (path === "/" || root.path.startsWith(`${path}/`))) return true;
  if (!path.startsWith(`${root.path}/`)) return false;
  if (root.entries === "all") return true;
  const first = path.slice(root.path.length + 1).split("/")[0];
  return root.entries.includes(first);
}

/** Glob absolute path vs one root, segment by segment (a glob never crosses
 *  `/`): a glob no deeper than the root may name it or an ancestor; a deeper
 *  one must match the root and then an authority entry. */
function globTouches(path: string, root: AuthorityRoot, reach: boolean, policy: LeadingDotPolicy): boolean {
  const glob = segmentsOf(path);
  const target = segmentsOf(root.path);
  const prefix = Math.min(glob.length, target.length);
  for (let k = 0; k < prefix; k++) if (!segmentGlobMatches(glob[k], target[k], policy)) return false;
  if (glob.length < target.length) return reach;
  if (glob.length === target.length) return true;
  if (root.entries === "all") return true;
  const next = glob[target.length];
  return root.entries.some((entry) => segmentGlobMatches(next, entry, policy));
}

/** The authority path one candidate word piece may reach, or null. */
function candidateTouches(piece: string, scope: PathScope, runtime: boolean, reach: boolean): string | null {
  if (piece === "") return null;
  let path = piece;
  if (path === "~" || path.startsWith("~/")) {
    if (scope.home === null) return authorityShaped(path, scope.policy) ? piece : null;
    path = `${scope.home}${path.slice(1)}`;
  } else if (path.startsWith("~")) {
    return authorityShaped(path, scope.policy) ? piece : null;
  }
  const relative = !isAbsolute(path);
  const placeable = !runtime && !(relative && (scope.cwdUnresolved || scope.cwds.length === 0));
  if ((scope.mode === "typed" && !placeable) || scope.unknownRuns) {
    if (authorityShaped(path, scope.policy)) return piece;
  }
  const glob = GLOB_CHAR.test(path);
  if (scope.mode === "script" && (glob || !placeable)) return null;
  // A script names `/` and system ancestors for its own reasons (a sandbox's
  // `mount -o remount,ro /`): in a script only a path AT or INSIDE an
  // authority root counts, never one that merely contains it.
  const reaches = reach && scope.mode === "typed";
  for (const base of relative ? scope.cwds : ["/"]) {
    const absolute = absoluteUnder(base, path);
    // A literal path is judged in its spelling AND its canonical spelling, so
    // a symlinked alias of a run (an ancestor link, `/tmp` ↔ `/private/tmp`)
    // reaches the run it names. A glob is never resolved: it names no file.
    const spellings = glob ? [absolute] : [...new Set([absolute, scope.canonicalize(absolute)])];
    for (const spelling of spellings) {
      for (const root of scope.roots) {
        const touches = glob ? globTouches(spelling, root, reaches, scope.policy) : literalTouches(spelling, root, reaches);
        if (touches) return piece;
      }
    }
  }
  return null;
}

/** Where a path may hide inside one word view: the view itself, a
 *  `--flag=`/`VAR=`/`of=` value, a fused short option (`-o<path>`), a fused
 *  redirect target, and the pieces an inline program or quoted argument
 *  separates with quotes, parens, commas or `=`. */
function pathPieces(view: string): readonly string[] {
  const pieces = new Set<string>([view]);
  const equals = view.indexOf("=");
  if (equals !== -1) pieces.add(view.slice(equals + 1));
  if (/^-[A-Za-z]./.test(view) && !view.startsWith("--")) pieces.add(view.slice(2));
  const fused = splitFusedRedirect(view);
  if (fused !== null) pieces.add(fused.rest.replace(/^(?:&>>?|[0-9]*(?:>>|>\||<>|>&|>|<))/, ""));
  // A bare `/` left between two separators (`sed 's/a/"&"/'`) is punctuation,
  // not the root: only a WHOLE view of `/` names it.
  for (const piece of view.split(/[\s'"`(),;=<>|&]+/)) if (!/^\/+$/.test(piece)) pieces.add(piece);
  return [...pieces].filter((piece) => piece !== "");
}

/** The authority path a raw word may reach (any view, any piece, as written
 *  or with a bound variable's value in place of its expansion), or null. */
function wordTouches(word: string, scope: PathScope, reach: boolean): string | null {
  const bound = boundSpellings(word, scope.shell.variables);
  // More spellings than the guard builds, or a bound value the line's `IFS`
  // may split anywhere (`IFS=:; T=x:/tmp; rm -rf $T`): a typed word fails
  // closed; a script FILE, judged on what it names literally, is judged on
  // the word as written.
  const untrusted = bound === null || (scope.shell.splittingRebound && bound.length > 1);
  if (untrusted && scope.mode === "typed") return word;
  for (const spelled of untrusted ? [word] : bound) {
    const runtime = hasRuntimePart(spelled);
    const views = wordViews(spelled);
    if (views === null) return spelled; // unbounded expansion: fail closed
    for (const view of views) {
      for (const piece of pathPieces(view)) {
        const touched = candidateTouches(piece, scope, runtime, reach);
        if (touched !== null) return touched;
      }
    }
  }
  return null;
}

/** Every value each variable a line binds may hold, by name (`spliceable`). */
type BoundVariables = ReadonlyMap<string, readonly string[]>;

/**
 * What a line does to the shell state the guard resolves its words and moves
 * with, read from the whole line text — nested bodies included — so a binding
 * reaches every segment that may see it (`withLineShell`).
 */
type LineShell = Readonly<{
  /** The values the line, or a line it is nested in, binds (`lineVariables`). */
  variables: BoundVariables;
  /** The names whose bare assignments on THIS line write nothing above their value (`inertNamesOf`). */
  inertNames: ReadonlySet<string>;
  /** `CDPATH` may be set on the line: every searched `cd` target is unknown. */
  searchPathRebound: boolean;
  /** `IFS` may be set for the rest of the line (`splittingRebound`): a bound value may split anywhere. */
  splittingRebound: boolean;
  /** lastpipe or physical `cd` may be on: where a segment runs no longer follows from the separators. */
  separatorsUnreliable: boolean;
  /** A command name may be rebound (`hash`, `alias`, `enable`, a function): no script is trusted by its path. */
  commandsRebound: boolean;
}>;

const NO_SHELL: LineShell = Object.freeze({
  variables: new Map(),
  inertNames: new Set<string>(),
  searchPathRebound: false,
  splittingRebound: false,
  separatorsUnreliable: false,
  commandsRebound: false,
});

/** Literal path characters and plain `$NAME`/`${NAME}` references: text that
 *  reads the same wherever it is spliced in place of a plain reference. */
const SPLICEABLE_VALUE = /^(?:[A-Za-z0-9_.\/~:@%+,=-]|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})*$/;

/** An assignment value as the text the guard splices for a plain reference to
 *  it — unwrapped from one pair of double quotes (or of single quotes holding
 *  no `$`) — or null when it does not splice faithfully (word splitting, a
 *  glob, a substitution, an ANSI-C string, any other expansion). */
function spliceable(value: string): string | null {
  const inner = /^"[^"]*"$/.test(value) || /^'[^'$]*'$/.test(value) ? value.slice(1, -1) : value;
  return SPLICEABLE_VALUE.test(inner) ? inner : null;
}

/** A word's spellings beyond 16 are not built: the word is then judged as
 *  touching authority (`wordTouches`). */
const MAX_BOUND_SPELLINGS = 16;

/** `word` as written, then with each bound value spliced in place of each
 *  `$NAME`/`${NAME}` that names a bound variable; null past
 *  `MAX_BOUND_SPELLINGS`. */
function boundSpellings(word: string, variables: BoundVariables): readonly string[] | null {
  if (variables.size === 0 || !word.includes("$")) return [word];
  let spellings: readonly string[] = [word];
  for (const [name, values] of variables) {
    const reference = new RegExp(plainReference(name), "g");
    if (!reference.test(word)) continue;
    spellings = [...new Set(spellings.flatMap((spelling) => [spelling, ...values.map((value) => spelling.replace(reference, () => value))]))];
    if (spellings.length > MAX_BOUND_SPELLINGS) return null;
  }
  return spellings;
}

/** The pattern of a plain read of `name`: `$name` or `${name}`. */
const plainReference = (name: string): string => `\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`;

/** One `NAME=value` word of a simple command, and how the shell takes it:
 *  `bare` (the whole command is assignments: they bind for the rest of the
 *  line), `prefix` (an environment prefix: it binds for its command alone) or
 *  `declaration` (an argument of `export`, `declare`, …: it binds and may
 *  export). */
type Assignment = Readonly<{ name: string; value: string; form: "bare" | "prefix" | "declaration" }>;

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Builtins whose `NAME=value` arguments are assignments, like a leading one. */
const DECLARATION_HEADS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "local", "readonly"]);

/** The leading `NAME=value` words of a simple command. */
function leadingAssignments(words: readonly string[]): number {
  let leading = 0;
  while (leading < words.length && ASSIGNMENT_WORD.test(words[leading])) leading++;
  return leading;
}

/** Every assignment one simple command makes. */
function assignmentsOf(words: readonly string[]): readonly Assignment[] {
  const parse = (word: string, form: Assignment["form"]): Assignment => {
    const equals = word.indexOf("=");
    return { name: word.slice(0, equals), value: word.slice(equals + 1), form };
  };
  const leading = leadingAssignments(words);
  if (leading === words.length) return words.map((word) => parse(word, "bare"));
  const prefix = words.slice(0, leading).map((word) => parse(word, "prefix"));
  if (!DECLARATION_HEADS.has(unquote(words[leading]))) return prefix;
  return [...prefix, ...words.slice(leading + 1).filter((word) => ASSIGNMENT_WORD.test(word)).map((word) => parse(word, "declaration"))];
}

const assignmentsAt = (sites: readonly SegmentSite[]): readonly Assignment[] =>
  sites.flatMap(({ segment }) => assignmentsOf(shellWords(stripComment(segment).trim())));

/**
 * The values a line binds — bare and declaration assignments whose value
 * splices (`spliceable`) — with every value each name takes anywhere on the
 * line (a loop may run a later binding first). A word that expands one is
 * judged with the value in its place as well as as written, so binding an
 * ancestor and writing beneath it (`T=/tmp; rm -rf $T/claude-subagents`) is
 * the write it spells. An environment prefix binds nothing for the rest of the
 * line.
 */
function lineVariables(sites: readonly SegmentSite[], inherited: BoundVariables): BoundVariables {
  const bound = new Map<string, readonly string[]>(inherited);
  for (const { name, value, form } of assignmentsAt(sites)) {
    const spliced = form === "prefix" ? null : spliceable(value);
    if (spliced !== null) bound.set(name, [...new Set([...(bound.get(name) ?? []), spliced])]);
  }
  return bound;
}

/** Names the shell itself reads: assigning one changes where `~`, `cd`, a
 *  command or a word resolves, so its assignment is never inert. */
const SHELL_STATE_NAMES: ReadonlySet<string> = new Set([
  "HOME", "CDPATH", "PWD", "OLDPWD", "PATH", "ENV", "BASH_ENV", "IFS", "SHELLOPTS", "BASHOPTS",
  "GLOBIGNORE", "DIRSTACK", "BASH_XTRACEFD", "PROMPT_COMMAND", "PS4",
]);

/** Line text that may read a variable where the guard does not see it read:
 *  `source`/`.` (a file run in this shell), `set -a`/`allexport` (every
 *  assignment exported), a nameref, an indirect expansion. */
const UNSEEN_VARIABLE_READS = /(?:^|[;&|(`\n]|\$\()\s*(?:source|\.)\s|\bset\s+[-+][A-Za-z]*a|allexport|\b(?:declare|typeset|local)\s+-[A-Za-z]*n|\$\{!/;

/**
 * Does `text` read `name` only where the guard splices its bound value — a
 * plain `$name`/`${name}` that is neither a `cd`/`pushd` operand nor part of
 * another assignment's value? Any other mention (`${name%x}`, `export name`,
 * `U=name` for an indirection, interpreter code naming it) may read it unseen.
 */
function readsOnlyPlainly(text: string, name: string): boolean {
  const plain = plainReference(name);
  if (new RegExp(`(?:^|[\\s;&|(\`])(?:cd|pushd)\\s[^;&|\\n]*${plain}`).test(text)) return false;
  if (new RegExp(`(?:^|[\\s;&|(\`])[A-Za-z_][A-Za-z0-9_]*=\\S*${plain}`).test(text)) return false;
  const rest = text.replace(new RegExp(plain, "g"), "").replace(new RegExp(`(?<=^|[\\s;&|(\`])${name}=`, "g"), "");
  return !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(rest);
}

/**
 * The names whose bare assignments on this line write nothing above the path
 * they name — `T=$CLAUDE_JOB_DIR/tmp` binds a path, it does not write `/tmp`.
 * A name is inert when the shell does not read it itself, it is assigned only
 * by bare assignments whose values splice, and the line reads it only where
 * the guard splices that value (`readsOnlyPlainly`): every write through it is
 * then judged with the value in place. Every other assignment reaches, so
 * binding `/tmp` is judged as a write over what `/tmp` holds — the only way
 * the guard can judge a variable it cannot follow.
 */
function inertNamesOf(text: string, sites: readonly SegmentSite[]): ReadonlySet<string> {
  if (UNSEEN_VARIABLE_READS.test(text)) return NO_SHELL.inertNames;
  const assignments = assignmentsAt(sites);
  const candidates = new Set(assignments.filter((assignment) => assignment.form === "bare").map((assignment) => assignment.name));
  return new Set([...candidates].filter((name) =>
    !SHELL_STATE_NAMES.has(name) &&
    assignments.every((assignment) => assignment.name !== name || (assignment.form === "bare" && spliceable(assignment.value) !== null)) &&
    readsOnlyPlainly(text, name)));
}

/** Does `text` mention `name` other than by a plain read — an assignment, a
 *  `printf -v`/`read` target, an indirection naming it? */
const mayRebind = (text: string, name: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_])`).test(text.replace(new RegExp(`\\$\\{${name}\\}`, "g"), ""));

/** The variable whose characters split an unquoted expansion's value into words. */
const SPLITTING_VARIABLE = "IFS";

/**
 * Does the line set `IFS` for the segments after it — a bare or declaration
 * assignment, a `read`/`printf -v` target, any mention but a plain read? An
 * environment prefix (`IFS=, read -r a b`) splits only its own command's
 * input, after its words are expanded, so it is not one.
 */
function splittingRebound(text: string, sites: readonly SegmentSite[]): boolean {
  const assignments = assignmentsAt(sites).filter((assignment) => assignment.name === SPLITTING_VARIABLE);
  if (assignments.some((assignment) => assignment.form !== "prefix")) return true;
  const withoutPrefixes = assignments.reduce((rest, { value }) => rest.split(`${SPLITTING_VARIABLE}=${value}`).join(""), text);
  return mayRebind(withoutPrefixes, SPLITTING_VARIABLE);
}

/** Bash's lastpipe option runs a pipeline's last command in this shell; physical `cd`
 *  resolves `..` after symlinks. Either breaks the separator walk. */
const SEPARATORS_UNRELIABLE = /\blastpipe\b|\bset\s+[-+][A-Za-z]*P|\bphysical\b/;

/** A command name rebound on the line: `hash -p`, an alias, `enable`, a function. */
const COMMANDS_REBOUND = /(?:^|[;&|(`\n]|\$\()\s*(?:hash|alias|enable)\b|\bfunction\s|\(\)\s*[{(]/;

/** `scope` with what the line `command` (parsed into `sites`) does to the shell. */
function withLineShell(command: string, sites: readonly SegmentSite[], scope: PathScope): PathScope {
  const { shell } = scope;
  return {
    ...scope,
    home: mayRebind(command, "HOME") ? null : scope.home,
    shell: {
      variables: lineVariables(sites, shell.variables),
      inertNames: inertNamesOf(command, sites),
      searchPathRebound: shell.searchPathRebound || mayRebind(command, CD_SEARCH_VARIABLE),
      splittingRebound: shell.splittingRebound || splittingRebound(command, sites),
      separatorsUnreliable: shell.separatorsUnreliable || SEPARATORS_UNRELIABLE.test(command),
      commandsRebound: shell.commandsRebound || COMMANDS_REBOUND.test(command),
    },
  };
}

/** A run directory or protected directory written verbatim inside a longer
 *  word or across whitespace (`"/runs/my run/ledger.json"`). */
function textNamesRoot(text: string, scope: PathScope): string | null {
  for (const root of scope.roots) {
    let at = text.indexOf(root.path);
    while (at !== -1) {
      const after = text.slice(at + root.path.length);
      if (after === "" || /^[\s'"]/.test(after)) return root.path;
      if (after.startsWith("/")) {
        const entry = after.slice(1).split(/[/\s'"]/)[0] ?? "";
        if (root.entries === "all" || root.entries.includes(entry)) return `${root.path}/${entry}`;
      }
      at = text.indexOf(root.path, at + 1);
    }
  }
  return null;
}

/**
 * Which words of a simple command reach above the path they name. An
 * environment prefix (`TMPDIR=/tmp npm test`) names a path for its command,
 * and a bare assignment of an inert name (`inertNamesOf`) binds one: neither
 * writes over what the path holds. Every other word — a declaration's
 * `NAME=value`, an assignment the line may read unseen, an argument — reaches.
 */
function wordReaches(words: readonly string[], inertNames: ReadonlySet<string>): readonly boolean[] {
  const leading = leadingAssignments(words);
  const bare = leading === words.length;
  return words.map((word, index) => index >= leading || (bare && !inertNames.has(word.slice(0, word.indexOf("=")))));
}

/** The authority path a segment's words may reach, or null. `judged` names
 *  the words already judged as programs of their own (`bash -c '…'`), which
 *  are not this segment's path arguments. */
function segmentTouches(segment: string, scope: PathScope, judged: ReadonlySet<string> = new Set()): string | null {
  const words = shellWords(stripComment(segment).trim()).filter((word) => !judged.has(unquote(word)));
  const reaches = wordReaches(words, scope.shell.inertNames);
  for (const [index, word] of words.entries()) {
    const touched = wordTouches(word, scope, reaches[index]);
    if (touched !== null) return touched;
  }
  const text = words.join(" ");
  return textNamesRoot(collapseVariants(text)?.join("\n") ?? text, scope);
}

/** One redirect of a segment: the text fused before its operator (an fd
 *  number, empty, or a word the redirect is glued to), the operator, and its
 *  operand — the rest of the word, or else the next word (consumed). */
type RedirectOperand = Readonly<{ fd: string; operator: string; operand: string | undefined }>;

/** Every redirect operator, longest first. */
const REDIRECT_OPERATOR = /^(?:<<<|<<-|<<|&>>|&>|>>|>\||<>|>&|<&|>|<)/;

/**
 * Every redirect of one segment, in order, each with its operand. The ONE
 * walk over a segment's redirect words: output targets, here-strings and
 * input files are filters over it. An operator with no inline operand takes
 * the next word whatever the operator is — after a redirect operator bash
 * reads a word, so a following operator word is a syntax error, never a
 * redirect of its own.
 */
function redirectOperands(segment: string): readonly RedirectOperand[] {
  const words = shellWords(stripComment(segment).trim());
  const redirects: RedirectOperand[] = [];
  for (let index = 0; index < words.length; index++) {
    const fused = splitFusedRedirect(words[index]);
    const operator = fused === null ? undefined : REDIRECT_OPERATOR.exec(fused.rest)?.[0];
    if (fused === null || operator === undefined) continue;
    const inline = fused.rest.slice(operator.length);
    redirects.push({ fd: fused.head, operator, operand: inline !== "" ? inline : words[++index] });
  }
  return redirects;
}

/** Operators that write the file their operand names (`>&` only when the
 *  operand is not an fd). */
const OUTPUT_OPERATORS: ReadonlySet<string> = new Set(["&>>", "&>", ">>", ">|", "<>", ">&", ">"]);

/** Output-redirect target words of one segment (`>`, `>>`, `>|`, `&>`, `<>`,
 *  `n>`, `>&file`), fused or separate. fd duplications write no file. */
const redirectTargets = (segment: string): readonly string[] =>
  redirectOperands(segment).flatMap(({ fd, operator, operand }) =>
    /^(?:[0-9]*|&)$/.test(fd) && OUTPUT_OPERATORS.has(operator) && operand !== undefined &&
    !(operator === ">&" && /^(?:[0-9]+|-)$/.test(operand)) // fd dup
      ? [operand]
      : []);

// ── The judgment ─────────────────────────────────────────────────────────────

const CD_HEADS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** Builtins that run the builtin they name in the current shell (`builtin cd`). */
const BUILTIN_RUNNERS: ReadonlySet<string> = new Set(["builtin", "command"]);

/** The variable bash searches a bare relative `cd` target in. */
export const CD_SEARCH_VARIABLE = "CDPATH";

/** Where one segment moves the shell, as far as the guard can tell. */
type DirectoryMove =
  | Readonly<{ kind: "stays" }>
  /** `pushd -n <target>`: the shell stays, but a later `popd` may land on
   *  the target, so it is a directory the line may reach. */
  | Readonly<{ kind: "stacks"; target: string; searched: boolean }>
  /** A `cd`/`pushd` to a target the guard can place. `searched`: a bare
   *  relative target (`cd engine`), which the search path may resolve
   *  elsewhere than the current directory. */
  | Readonly<{ kind: "moves"; target: string; searched: boolean }>
  /** `popd`, `cd -`, a stack rotation, a runtime-built target, `~user`, `~`
   *  with no known home. */
  | Readonly<{ kind: "unknown" }>;

/** A move whose target the guard can place (`moves`, `stacks`). */
type PlacedMove = Extract<DirectoryMove, { target: string }>;
const placed = (move: DirectoryMove): move is PlacedMove => move.kind === "moves" || move.kind === "stacks";

const STAYS: DirectoryMove = Object.freeze({ kind: "stays" });
const UNKNOWN_MOVE: DirectoryMove = Object.freeze({ kind: "unknown" });

/** Where one `cd`/`pushd` operand goes (none: home), or null when the guard
 *  cannot know. */
function cdDestination(head: string, operand: string | undefined, home: string | null): string | null {
  // `pushd` alone swaps the stack's top two; `pushd +N`/`-N` rotates it.
  if (head === "pushd" && (operand === undefined || /^[+-]\d+$/.test(operand))) return null;
  const target = operand ?? "~";
  if (target === "-" || hasRuntimePart(target)) return null;
  if (target === "~" || target.startsWith("~/")) return home === null ? null : `${home}${target.slice(1)}`;
  return target.startsWith("~") ? null : target;
}

/**
 * The directory move one segment's command makes (`cd`, `pushd`, `popd`,
 * also behind `builtin`/`command`). `pushd -n` only edits the stack (`stacks`:
 * a later `popd` may land there); every other option but `-L` (`-P` resolves
 * `..` physically, `-e`, `-@`) and `popd` move where the guard cannot follow.
 */
function directoryMove(segment: string, home: string | null): DirectoryMove {
  const analyzed = analyzeCommandHead(segment);
  if (analyzed === null) return STAYS;
  let words: readonly string[] = [analyzed.head, ...analyzed.args];
  while (words.length > 1 && BUILTIN_RUNNERS.has(words[0])) words = words.slice(1);
  const [head, ...args] = words;
  if (!CD_HEADS.has(head)) return STAYS;
  if (head === "popd") return UNKNOWN_MOVE;
  let index = 0;
  const options: string[] = [];
  for (; index < args.length && /^-./.test(args[index]) && !/^-\d+$/.test(args[index]); index++) {
    if (args[index] === "--") { index++; break; }
    options.push(args[index]);
  }
  const stacks = head === "pushd" && options.some((option) => /^-[A-Za-z]*n/.test(option));
  if (!stacks && options.some((option) => option !== "-L")) return UNKNOWN_MOVE;
  const target = cdDestination(head, args[index], home);
  if (target === null) return UNKNOWN_MOVE;
  const searched = !isAbsolute(target) && !/^\.\.?(?:\/|$)/.test(target);
  return { kind: stacks ? "stacks" : "moves", target, searched };
}

/** Every directory a placeable move from `from` may land in: a bare relative
 *  target under each search-path entry, then under `from` itself (bash falls
 *  back to it when no entry holds the target). */
const destinationsOf = (from: string, move: PlacedMove, cdSearchPath: readonly string[]): readonly string[] =>
  move.searched
    ? [...cdSearchPath.map((entry) => absoluteUnder(absoluteUnder(from, entry), move.target)), absoluteUnder(from, move.target)]
    : [absoluteUnder(from, move.target)];

/** Words that make a segment compound syntax: a group, a subshell, a loop, a
 *  conditional, a negation or a function body. */
const COMPOUND_WORDS: ReadonlySet<string> = new Set([
  "(", ")", "{", "}", "!", "if", "then", "else", "elif", "fi", "case", "esac",
  "for", "select", "while", "until", "do", "done", "function", "coproc",
]);

/** Grouping words, compound wherever they stand in a segment. */
const GROUPING_WORDS: ReadonlySet<string> = new Set(["(", ")", "{", "}"]);

/** Does the segment carry compound syntax? Inside it a `cd` may be undone
 *  (`(cd x)`), repeated (a loop) or have its status inverted (`! cd x`), so
 *  where a later segment runs no longer follows from the separators. */
function holdsCompoundSyntax(segment: string): boolean {
  const words = commandWords(segment);
  const head = words.find((word) => !ASSIGNMENT_WORD.test(word));
  return words.some((word) => GROUPING_WORDS.has(word)) || (head !== undefined && COMPOUND_WORDS.has(unquote(head)));
}

/** A directory the shell may be in once a segment has run (or been skipped),
 *  and whether the last segment that ran succeeded. */
type DirectoryState = Readonly<{ dir: string; succeeded: boolean }>;

const uniqueStates = (states: readonly DirectoryState[]): readonly DirectoryState[] =>
  [...new Map(states.map((state) => [`${state.succeeded}:${state.dir}`, state])).values()];

/** Where a parsed line's segments run: every directory the line may reach
 *  (`everywhere`), and for each segment, in line order, the directories it
 *  may run in. */
type LineDirectories = Readonly<{ everywhere: readonly string[]; cwdUnresolved: boolean; perSegment: readonly (readonly string[])[] }>;

/**
 * Where each segment of a line runs. `everywhere` is the starting set plus
 * every `cd`/`pushd` destination resolved against every directory known so far
 * — sound for any line. A line without compound syntax is then walked in
 * order over (directory, last status) states: a segment after `&&` runs only
 * where the one before succeeded, after `||` only where it failed, after `;`,
 * `&` or `|` everywhere the line may be; a `cd` that succeeds moves the state,
 * one that fails leaves it. So `cd X && tsc -p .` checks `.` in X alone, while
 * `cd X; rm -rf .` and `cd X || rm -rf .` still check the starting directory.
 * A `cd` in a pipeline or behind `&` runs in a subshell and moves nothing; a
 * move the guard cannot place sends the next segment everywhere. A line that
 * may turn on lastpipe or physical `cd` is not walked (`LineShell`), and a
 * line that may set `CDPATH` makes every searched move unknown.
 */
function lineDirectories(sites: readonly SegmentSite[], scope: PathScope): LineDirectories {
  const moveOf = (site: SegmentSite): DirectoryMove => {
    const move = directoryMove(site.segment, scope.home);
    return placed(move) && move.searched && scope.shell.searchPathRebound ? UNKNOWN_MOVE : move;
  };
  const known = new Set(scope.cwds);
  let cwdUnresolved = scope.cwdUnresolved;
  for (const site of sites) {
    const move = moveOf(site);
    if (move.kind === "unknown") cwdUnresolved = true;
    if (!placed(move)) continue;
    for (const base of [...known]) for (const destination of destinationsOf(base, move, scope.cdSearchPath)) known.add(destination);
    if (isAbsolute(move.target)) known.add(absoluteUnder("/", move.target));
  }
  const everywhere = [...known];
  if (scope.shell.separatorsUnreliable || sites.some((site) => holdsCompoundSyntax(site.segment))) {
    return { everywhere, cwdUnresolved, perSegment: sites.map(() => everywhere) };
  }

  let states: readonly DirectoryState[] = scope.cwds.map((dir) => ({ dir, succeeded: true }));
  const perSegment = sites.map((site): readonly string[] => {
    // Only `&&` and `||` choose by status; after `;`, `&` or `|` it runs wherever the line may be.
    const runsAfter = (state: DirectoryState): boolean =>
      site.opBefore === "&&" ? state.succeeded : site.opBefore === "||" ? !state.succeeded : true;
    const runs = states.filter(runsAfter);
    const skipped = states.filter((state) => !runsAfter(state));
    const subshell = site.opBefore === "|" || site.opAfter === "|" || site.opAfter === "&";
    const move = subshell ? STAYS : moveOf(site);
    const ranFrom = (state: DirectoryState): readonly DirectoryState[] => {
      const landed = match(move)
        .returnType<readonly string[]>()
        .with({ kind: "stays" }, { kind: "stacks" }, () => [state.dir])
        .with({ kind: "moves" }, (moves) => destinationsOf(state.dir, moves, scope.cdSearchPath))
        .with({ kind: "unknown" }, () => everywhere)
        .exhaustive();
      return [...landed.map((dir) => ({ dir, succeeded: true })), { dir: state.dir, succeeded: false }];
    };
    states = uniqueStates([...skipped, ...runs.flatMap(ranFrom)]);
    const directories = [...new Set(runs.map((state) => state.dir))];
    return directories.length === 0 ? everywhere : directories;
  });
  return { everywhere, cwdUnresolved, perSegment };
}

/** The scopes a parsed line's own segments are judged in: `everywhere`, the
 *  scope widened by every directory a `cd`/`pushd` on the line may lead to,
 *  and each segment's own scope (`lineDirectories`). The ONE directory rule
 *  both judgments apply — the refusal walk and the verify-invocation collector
 *  read a fed script (`cd /b && bash run.sh`) in the same places. */
type LineScopes = Readonly<{ everywhere: PathScope; of: (site: SegmentSite) => PathScope }>;

function lineScopesOf(command: string, line: Extract<ParsedLine, { kind: "parsed" }>, inherited: PathScope): LineScopes {
  const sites = line.chains.flat();
  const scope = withLineShell(command, sites, inherited);
  const { everywhere: cwds, cwdUnresolved, perSegment } = lineDirectories(sites, scope);
  const everywhere: PathScope = { ...scope, cwds, cwdUnresolved };
  const scopes = new Map(sites.map((site, index) => [site, { ...everywhere, cwds: perSegment[index] }]));
  return { everywhere, of: (site) => scopes.get(site) ?? everywhere };
}

type Judged = SubagentAuthorityRefusal | null;

const refuseUnparseable = (segment: string): SubagentAuthorityRefusal =>
  ({ rule: "unparseable-authority-command", segment });

const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set(["-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a"]);

/** `find` actions that run the words after them as a command, up to `;`/`+`. */
const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Shell text a segment executes as a program of its own — `bash -c '…'`,
 *  `eval …`, `xargs <command…>`, `find … -exec <command…> ;` — and the
 *  argument words that text is made of. Those words are judged as the
 *  program, not as the segment's paths; any other argument
 *  (`bash -c '…' _ <path>`) stays a path argument. */
type ExecutedPrograms = Readonly<{ programs: readonly string[]; words: ReadonlySet<string> }>;

function executedPrograms(head: string, args: readonly string[]): ExecutedPrograms {
  const none = { programs: [], words: new Set<string>() };
  if (SH_FAMILY_HEADS.has(head)) {
    const program = inlineProgramArg(head, args);
    return program === null ? none : { programs: [program], words: new Set([program]) };
  }
  if (head === "eval") return { programs: [args.join(" ")], words: new Set(args) };
  if (head === "xargs") {
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) index += XARGS_VALUE_FLAGS.has(args[index]) ? 2 : 1;
    const command = args.slice(index);
    return command.length === 0 ? none : { programs: [command.join(" ")], words: new Set(command) };
  }
  if (head === "find") {
    const programs: string[] = [];
    const words = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      if (!FIND_EXEC_ACTIONS.has(args[index])) continue;
      const command: string[] = [];
      for (index++; index < args.length && !/^(?:\\?;|\+)$/.test(args[index]); index++) command.push(args[index]);
      if (command.length > 0) programs.push(command.join(" "));
      for (const word of command) words.add(word);
    }
    return { programs, words };
  }
  return none;
}

// ── Programs a segment is FED (scripts, pipes, here-strings, interpreters) ───

/** Interpreters whose literal program text is scanned for authority code. */
const CODE_INTERPRETERS: ReadonlySet<string> = new Set([
  "python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua", "luajit", "Rscript", "R",
]);
const AWK_HEADS: ReadonlySet<string> = new Set(["awk", "gawk", "mawk", "nawk", "busybox-awk"]);
/** Pipe producers whose OUTPUT is their file arguments' content. */
const FILE_READERS: ReadonlySet<string> = new Set(["cat", "tac", "head", "tail", "less", "more"]);
/** Shell-family flags that take a value before the script word. */
const SH_VALUE_FLAGS: ReadonlySet<string> = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const MAX_PIPE_PRODUCER_FILES = 8;

/** What one segment is fed as a program: shell text (judged as lines), code
 *  of another interpreter (scanned), or a script the guard could not read. */
type FedProgram =
  | Readonly<{ kind: "shell"; text: string; source: string; from: "file" | "literal" }>
  | Readonly<{ kind: "code"; text: string; source: string; from: "file" | "literal" }>
  | Readonly<{ kind: "unreadable"; path: string; reason: string }>;

/** Where the shell will look for a script word: each directory the line may
 *  run in for a relative word, `~` against home; null when it cannot know. */
function scriptLocations(word: string, scope: PathScope): readonly string[] | null {
  if (hasRuntimePart(word) || word === "") return null;
  if (word === "~" || word.startsWith("~/")) return scope.home === null ? null : [absoluteUnder("/", `${scope.home}${word.slice(1)}`)];
  if (word.startsWith("~")) return null;
  if (isAbsolute(word)) return [absoluteUnder("/", word)];
  return scope.cwdUnresolved || scope.cwds.length === 0 ? null : scope.cwds.map((cwd) => absoluteUnder(cwd, word));
}

/** Read the script a word names, through the port, in every location it may be. */
function readScriptWord(word: string, scope: PathScope, filesystem: SubagentFilesystemView, kind: "shell" | "code"): readonly FedProgram[] {
  const locations = scriptLocations(word, scope);
  if (locations === null) return [{ kind: "unreadable", path: word, reason: "the path is completed by the shell at runtime" }];
  return locations.map((location): FedProgram => {
    const read = filesystem.readScript(location);
    return read.kind === "text" ? { kind, text: read.text, source: location, from: "file" } : { kind: "unreadable", path: location, reason: read.reason };
  });
}

/** The interpreter a script's shebang names, or null. */
function shebangInterpreter(text: string): string | null {
  const line = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  if (line === null) return null;
  const interpreter = headBase(line[1]);
  return interpreter === "env" ? (line[2] === undefined ? null : headBase(line[2])) : interpreter;
}

/** A path executed as a command (`./x.sh`, `/opt/hook.sh`): its content is a
 *  shell program when its shebang (or, without one, its `.sh`/`.bash`
 *  extension) names a shell. A binary, another interpreter's script (only
 *  literal code is scanned), the Loom CLI itself (judged by its arguments) or
 *  a file the guard cannot read is not judged here — the head's name is. */
function executedFilePrograms(literalHead: string, scope: PathScope, filesystem: SubagentFilesystemView): readonly FedProgram[] {
  if (!literalHead.includes("/") || CLI_ENTRY.test(headBase(literalHead)) || headBase(literalHead) === "loom") return [];
  return readScriptWord(literalHead, scope, filesystem, "shell").flatMap((read): readonly FedProgram[] => {
    if (read.kind !== "shell") return [];
    const interpreter = shebangInterpreter(read.text);
    if (interpreter !== null) return SH_FAMILY_HEADS.has(interpreter) ? [read] : [];
    return /\.(?:sh|bash)$/.test(literalHead) ? [read] : [];
  });
}

/** The script word a shell-family invocation runs, or null (`-c`, `-s`,
 *  stdin, or no word). */
function shellScriptWord(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-c" || arg === "-s" || arg === "-") return null;
    if (arg === "--") return args[index + 1] ?? null;
    if (SH_VALUE_FLAGS.has(arg)) { index++; continue; }
    if (arg.startsWith("-") || arg.startsWith("+")) continue;
    return arg;
  }
  return null;
}

/** The text of every here-string (`<<< word`) of a segment. */
const hereStrings = (segment: string): readonly string[] =>
  redirectOperands(segment).flatMap(({ operator, operand }) =>
    operator === "<<<" && operand !== undefined ? [unquote(operand)] : []);

/** The files a segment's `<` input redirects read (`< f`, `0<f`). */
const inputRedirectFiles = (segment: string): readonly string[] =>
  redirectOperands(segment).flatMap(({ fd, operator, operand }) =>
    /^0?$/.test(fd) && operator === "<" && operand !== undefined ? [unquote(operand)] : []);

/** What a pipe-chain's earlier segments write into the segment they feed: a
 *  file reader's files, or every other producer's literal argument text
 *  (`echo`/`printf` and anything else — an over-approximation that only
 *  ever judges MORE text). */
function pipedText(producers: readonly string[], scope: PathScope, filesystem: SubagentFilesystemView, kind: "shell" | "code"): readonly FedProgram[] {
  return producers.flatMap((producer): readonly FedProgram[] => {
    const { head, args } = segmentCommand(producer);
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (FILE_READERS.has(head) && operands.length > 0) {
      return operands.slice(0, MAX_PIPE_PRODUCER_FILES).flatMap((file) => readScriptWord(file, scope, filesystem, kind));
    }
    const text = args.join(" ").replace(/\\n/g, "\n");
    return text.trim() === "" ? [] : [{ kind, text, source: `the output of ${JSON.stringify(producer)}`, from: "literal" }];
  });
}

/** The first program operand of an awk invocation (after its options). */
function awkProgram(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-f") return null; // a program FILE: not literal code
    if (["-F", "-v", "-i", "-l"].includes(arg)) { index++; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Every program a segment is FED, beyond its own words: a shell's script file
 * (`bash x.sh`, `source x`, `. x`, an executed `./x.sh`), what a shell or an
 * interpreter that reads its program from stdin receives through a pipe, a
 * here-string or an input redirect, and an interpreter's literal code (`-c`,
 * `-e`, an awk program).
 */
function fedPrograms(
  chain: readonly string[],
  index: number,
  scope: PathScope,
  filesystem: SubagentFilesystemView,
): readonly FedProgram[] {
  const segment = chain[index];
  const { literalHead, head, args: words } = segmentCommand(segment);
  // A redirect fused with quoted text (`<<<'a b'`) survives the head
  // tokenizer as an argument word: it is stdin syntax, never a program word.
  const args = words.filter((word) => !/^\d*[<>]/.test(word) && !word.startsWith("&>"));
  const fed: FedProgram[] = [...executedFilePrograms(literalHead, scope, filesystem)];
  const shell = SH_FAMILY_HEADS.has(head);
  if (head === "source" || head === ".") {
    const word = args[0];
    if (word !== undefined) fed.push(...readScriptWord(word, scope, filesystem, "shell"));
  }
  if (shell && inlineProgramArg(head, args) === null) {
    const script = shellScriptWord(args);
    if (script !== null && !script.startsWith("/dev/")) fed.push(...readScriptWord(script, scope, filesystem, "shell"));
  }
  const interpreter = CODE_INTERPRETERS.has(head);
  if (interpreter) {
    const inline = inlineProgramArg(head, args);
    if (inline !== null) fed.push({ kind: "code", text: inline, source: `${head}'s inline program`, from: "literal" });
  }
  if (AWK_HEADS.has(head)) {
    const program = awkProgram(args);
    if (program !== null) fed.push({ kind: "code", text: program, source: "the awk program", from: "literal" });
  }
  if ((shell || interpreter) && readsProgramFromStdin(head, args)) {
    const kind = shell ? "shell" as const : "code" as const;
    for (const text of hereStrings(segment)) fed.push({ kind, text, source: "a here-string", from: "literal" });
    for (const file of inputRedirectFiles(segment)) fed.push(...readScriptWord(file, scope, filesystem, kind));
    if (index > 0) fed.push(...pipedText(chain.slice(0, index), scope, filesystem, kind));
  }
  return fed;
}

/** Engine modules whose import would let code write audit or orchestration
 *  authority without the CLI. */
const ENGINE_AUTHORITY_MODULE =
  /handlers\/helpers\/(?:security-audit|orchestration|programs)|handlers\/subagent-stop|handlers\/post-tool-use|handler-routes|orchestration\/(?:capture-attestation-store|security-audit-run-registry|run-directory-handle|harness-capture-runtime|session-run-bindings)/;

/** Why interpreter code may write authority, or null: a literal `helper
 *  security-audit|orchestration <op>` invocation of a write (or unknown)
 *  operation, a CLI entry point followed by a hook route, or an import of an
 *  engine authority module. */
function codeAuthorityReason(code: string, context: SubagentAuthorityContext): string | null {
  const tokens = code.split(/[^A-Za-z0-9_./@:-]+/).filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const helper = AUTHORITY_HELPERS.find((name) => name === tokens[index + 1]);
    if (token === "helper" && helper !== undefined) {
      const operation = tokens[index + 2];
      if (operation === undefined || verdictOf(context.helperOperations[helper], operation) !== "read-only") {
        return `the code invokes \`helper ${helper}${operation === undefined ? "" : ` ${operation}`}\``;
      }
    }
    if (CLI_ENTRY.test(headBase(token)) && context.hookRoutes.has(tokens[index + 1] ?? "")) {
      return `the code invokes the Loom hook entrypoint \`${tokens[index + 1]}\``;
    }
  }
  const module = ENGINE_AUTHORITY_MODULE.exec(code);
  return module === null ? null : `the code loads the engine authority module ${module[0]}`;
}

/** Literal text that may concern audit or orchestration authority: what an
 *  unreadable script on the same line could be doing. */
const AUTHORITY_TEXT = /security-audit|orchestration|\bhelper\b|cli\.(?:ts|js|mjs)\b|hooks\/scripts|subagent-stop|pre-tool-use|post-tool-use|LOOM_/;

function lineMayConcernAuthority(line: string, scope: PathScope): boolean {
  if (AUTHORITY_TEXT.test(line)) return true;
  return pipeChains(line).flat().some((segment) => segmentTouches(segment, scope) !== null);
}

/** Harness CLIs a subagent may not launch: a nested harness session is a
 *  parent of its own, outside every subagent fence. */
const HARNESS_HEADS: ReadonlySet<string> = new Set(["claude", "pi"]);
const HARNESS_PACKAGES = /^(?:@anthropic-ai\/claude-code|@earendil-works\/pi-coding-agent)(?:@.*)?$/;
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

/** The nested harness a command launches, or null. */
function nestedHarness(head: string, args: readonly string[]): string | null {
  if (HARNESS_HEADS.has(head)) return head;
  const target = packageRunnerTarget(head, args);
  if (target === null) return null;
  return HARNESS_HEADS.has(headBase(target)) || HARNESS_PACKAGES.test(target) ? target : null;
}

/** The package a package runner launches (`npx X`, `pnpm dlx X`, `bun x X`), or null. */
function packageRunnerTarget(head: string, args: readonly string[]): string | null {
  if (PACKAGE_RUNNERS.has(head)) return args.find((arg) => !arg.startsWith("-")) ?? null;
  const subcommandRunner = (head === "pnpm" || head === "yarn" || head === "bun") && ["dlx", "x", "exec"].includes(args[0] ?? "");
  return subcommandRunner ? args.slice(1).find((arg) => !arg.startsWith("-")) ?? null : null;
}

/** The hook route a Loom CLI invocation names, or null. */
function hookRouteOf(context: SubagentAuthorityContext, head: string, args: readonly string[], mode: ScopeMode): string | null {
  const cliArgs = loomCliArguments(head, args, mode);
  const route = cliArgs?.[0];
  if (route === undefined || hasRuntimePart(route)) return null;
  return wordViews(route)?.find((view) => context.hookRoutes.has(view)) ?? null;
}

// ── The line walk both authority judgments fold ────────────────────────────

/** One simple command of a parsed line, with what the shell will make of it. */
type SegmentSite = Readonly<{
  segment: string;
  /** The separators around the segment (`PlacedSegment`): whether it runs
   *  after the one before, and whether it runs in a subshell. */
  opBefore: SegmentOp | null;
  opAfter: SegmentOp | null;
  /** The segment's pipe-chain, as texts, and its position there — what a
   *  pipe-fed program is read from. */
  chain: readonly string[];
  index: number;
  command: SegmentCommand;
  /** The programs the segment executes as shell text of their own. */
  executed: ExecutedPrograms;
}>;

/**
 * One command line as both authority judgments read it — the refusal walk
 * (`judgeLine`) and the verify-invocation collector. The traversal is decided
 * HERE, once: which heredoc and substitution bodies execute as lines of their
 * own, how the line splits into pipe-chains once each substitution is replaced
 * by its opaque (runtime) output, the command each segment runs behind its
 * wrappers, and the programs it executes. The two judgments differ only in
 * what they conclude from it, so a grammar fix lands in both or in neither.
 *
 * Not recursive: each judgment recurses into `nestedBodies` and the executed
 * programs itself, at `depth + 1`, with its own scope.
 */
type ParsedLine =
  | Readonly<{ kind: "blank" }>
  /** Nested past MAX_SUBSTITUTION_DEPTH: nobody's legitimate command. */
  | Readonly<{ kind: "too-deep" }>
  | Readonly<{
      kind: "parsed";
      /** Executed heredoc bodies, then substitution bodies. Inert heredoc
       *  bodies are data and drop out. */
      nestedBodies: readonly string[];
      /** An unclosed span: the line cannot be parsed in full. */
      unparseable: boolean;
      /** The line with heredoc bodies stripped but substitutions NOT
       *  flattened — an unclosed substitution truncates the flattened view. */
      unflattened: string;
      chains: readonly (readonly SegmentSite[])[];
    }>;

function parseLine(command: string, depth: number): ParsedLine {
  if (command.trim() === "") return { kind: "blank" };
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "too-deep" };
  const heredocs = splitHeredocs(command);
  const substitutions = scanSubstitutions(heredocs.stripped, () => OPAQUE_OUTPUT);
  return {
    kind: "parsed",
    nestedBodies: [...heredocs.bodies, ...substitutions.bodies],
    unparseable: heredocs.unparseable || substitutions.unclosed,
    unflattened: heredocs.stripped,
    chains: placedPipeChains(substitutions.rebuilt).map((placed) => {
      const chain = placed.map(({ text }) => text);
      return placed.map(({ text: segment, opBefore, opAfter }, index): SegmentSite => {
        const command = segmentCommand(segment);
        return { segment, opBefore, opAfter, chain, index, command, executed: executedPrograms(command.head, command.args) };
      });
    }),
  };
}

type SegmentFacts = Readonly<{
  segment: string;
  readOnly: boolean;
  touches: string | null;
  redirectTouch: string | null;
}>;

/** A segment is refused on its own (an authority helper operation, or a
 *  program it executes), or yields the facts its pipe-chain is judged on. */
type SegmentJudgment =
  | Readonly<{ kind: "refused"; refusal: SubagentAuthorityRefusal }>
  | Readonly<{ kind: "judged"; facts: SegmentFacts }>;

function judgeLine(command: string, context: SubagentAuthorityContext, scope: PathScope, depth: number): Judged {
  const line = parseLine(command, depth);
  if (line.kind === "blank") return null;
  if (line.kind === "too-deep") return refuseUnparseable(command);

  // What the line does to the shell reaches its nested bodies too (`T=/tmp; echo $(rm -rf $T/x)`).
  const scopes = lineScopesOf(command, line, scope);
  for (const body of line.nestedBodies) {
    const judged = judgeLine(body, context, scopes.everywhere, depth + 1);
    if (judged !== null) return judged;
  }

  if (line.unparseable) {
    // Judged on the UNFLATTENED text: an unclosed substitution truncates the
    // flattened view at its opener, hiding everything after it — and with it
    // the separators each segment's own directories follow from.
    const named = pipeChains(line.unflattened).flat().find((segment) =>
      segmentTouches(segment, scopes.everywhere) !== null || /security-audit|orchestration/.test(segment));
    if (named !== undefined) return refuseUnparseable(named);
  }

  for (const chain of line.chains) {
    const facts: SegmentFacts[] = [];
    for (const site of chain) {
      const siteScope = scopes.of(site);
      const fed = judgeFedPrograms(command, site, context, siteScope, depth);
      if (fed !== null) return fed;
      const judged = judgeSegment(site, context, siteScope, depth);
      if (judged.kind === "refused") return judged.refusal;
      facts.push(judged.facts);
    }
    for (const fact of facts) {
      if (fact.redirectTouch !== null) return { rule: "authority-path-write", segment: fact.segment, path: fact.redirectTouch };
    }
    const touched = facts.find((fact) => fact.touches !== null)?.touches ?? null;
    if (touched === null) continue;
    const writer = facts.find((fact) => !fact.readOnly);
    if (writer !== undefined) {
      return { rule: "authority-path-write", segment: writer.segment, path: touched };
    }
  }
  return null;
}

/** Judge every program a segment is fed: shell text as lines of their own,
 *  interpreter code by its literal authority content, and an unreadable
 *  script by whether the LINE may concern authority at all. */
function judgeFedPrograms(
  line: string,
  { segment, chain, index }: SegmentSite,
  context: SubagentAuthorityContext,
  scope: PathScope,
  depth: number,
): Judged {
  for (const program of fedPrograms(chain, index, scope, context.filesystem)) {
    const judged = match(program)
      .returnType<Judged>()
      .with({ kind: "shell" }, ({ text, from }) => judgeLine(text, context, from === "file" ? { ...scope, mode: "script" } : scope, depth + 1))
      .with({ kind: "code" }, ({ text, source }) => {
        const reason = codeAuthorityReason(text, context);
        return reason === null ? null : { rule: "interpreter-authority-code", segment, reason: `${source}: ${reason}` };
      })
      .with({ kind: "unreadable" }, ({ path, reason }) =>
        lineMayConcernAuthority(line, scope) ? { rule: "unreadable-script", segment, path, reason } : null)
      .exhaustive();
    if (judged !== null) return judged;
  }
  return null;
}

/** A segment's command as the shell runs it: its literal head (for `cd` and
 *  executed paths), and the head and arguments behind any wrapper. */
type SegmentCommand = Readonly<{ literalHead: string; head: string; args: readonly string[] }>;

function segmentCommand(segment: string): SegmentCommand {
  const analyzed = analyzeCommandHead(segment);
  const resolved = analyzed === null ? null : resolvedInterpreter(analyzed.head, analyzed.args);
  return {
    literalHead: analyzed?.head ?? "",
    head: resolved?.head ?? analyzed?.head ?? "",
    args: resolved?.args ?? analyzed?.args ?? [],
  };
}

function judgeSegment(
  { segment, command: { literalHead, head, args }, executed }: SegmentSite,
  context: SubagentAuthorityContext,
  scope: PathScope,
  depth: number,
): SegmentJudgment {
  for (const program of executed.programs) {
    const judged = judgeLine(program, context, scope, depth + 1);
    if (judged !== null) return { kind: "refused", refusal: judged };
  }

  const harness = nestedHarness(head, args);
  if (harness !== null) return { kind: "refused", refusal: { rule: "nested-harness", segment, harness } };
  const route = hookRouteOf(context, head, args, scope.mode);
  if (route !== null) return { kind: "refused", refusal: { rule: "harness-hook-entrypoint", segment, route } };

  const invocation = helperInvocation(context.helperOperations, head, args, scope.mode);
  if (invocation !== null && invocation.verdict !== "read-only") {
    return {
      kind: "refused",
      refusal: { rule: "authority-helper-operation", segment, helper: invocation.helper, operation: invocation.operation },
    };
  }

  const redirectTouch = redirectTargets(segment)
    .map((target) => wordTouches(target, scope, true))
    .find((touched) => touched !== null) ?? null;
  // A typed line that may rebind a command name (`hash -p /bin/rm cat`, an
  // alias, a function) may run anything under a read-only head's name.
  const headsTrusted = !(scope.mode === "typed" && scope.shell.commandsRebound);
  const readOnly = headsTrusted && (invocation !== null || hasReadOnlyHead(segment) || CD_HEADS.has(literalHead) ||
    runsReadOnlyScript(segment, scope, context.readOnlyScripts) ||
    isReadOnlyGitInvocation(shellWords(stripComment(segment).trim()).map(staticSpelling)));
  return {
    kind: "judged",
    facts: { segment, readOnly, touches: segmentTouches(segment, scope, executed.words), redirectTouch },
  };
}

/** A word's one static spelling — no runtime part, no glob, exactly one view — or null. */
function staticSpelling(word: string | undefined): string | null {
  if (word === undefined || hasRuntimePart(word)) return null;
  const views = wordViews(word);
  return views !== null && views.length === 1 && !GLOB_CHAR.test(views[0]) ? views[0] : null;
}

/**
 * Does the segment run one of the Loom package's read-only scripts, written
 * plainly: `bun <script>`, `bun run <script>`, or the script executed by its
 * path (a word holding a `/`: a bare name is looked up on `PATH`), as the
 * segment's FIRST word — no environment prefix, no wrapper, on a line that
 * rebinds no command name — and a script word with one static spelling that
 * names a listed script in every directory the segment may run in (in its
 * spelling or its canonical one)? Such a segment reads: the paths it names are
 * what it reads, and only its redirects are judged as writes.
 */
function runsReadOnlyScript(segment: string, scope: PathScope, scripts: readonly string[]): boolean {
  if (scope.shell.commandsRebound) return false;
  const words = shellWords(stripComment(segment).trim());
  const first = staticSpelling(words[0]);
  if (first === null) return false;
  const second = staticSpelling(words[1]);
  const script = first !== "bun" ? first : second === "run" ? staticSpelling(words[2]) : second;
  if (script === null || (first === script && !script.includes("/"))) return false;
  const locations = scriptLocations(script, scope);
  return locations !== null && locations.length > 0 &&
    locations.every((location) => scripts.includes(location) || scripts.includes(scope.canonicalize(location)));
}

/**
 * The decision for one Bash command a subagent asked to run. `allow` is the
 * guard's no-opinion answer; every refusal names its rule and the segment.
 */
export function decideSubagentAuthority(command: string, context: SubagentAuthorityContext): SubagentAuthorityDecision {
  const refusal = judgeLine(command, context, pathScope(command, context), 0);
  return refusal === null ? ALLOW : { kind: "refuse", refusal };
}

/** The path scope a command is judged in: protected directories (everything
 *  beneath them) and registered runs (their authority entries). */
function pathScope(command: string, context: SubagentAuthorityContext): PathScope {
  const roots: AuthorityRoot[] = [
    ...context.protectedDirectories.map((path) => ({ path: trimSlash(normalize(path)), entries: "all" as const })),
    ...(context.runs.kind === "known"
      ? context.runs.directories.map((path) => ({ path: trimSlash(normalize(path)), entries: SECURITY_AUDIT_AUTHORITY_ENTRIES }))
      : []),
  ];
  return {
    roots,
    unknownRuns: context.runs.kind === "unreadable",
    cwds: context.cwd === null ? [] : [trimSlash(normalize(context.cwd))],
    cwdUnresolved: context.cwd === null,
    home: context.home,
    cdSearchPath: context.cdSearchPath,
    shell: NO_SHELL,
    policy: leadingDotPolicyOf(command),
    canonicalize: context.filesystem.canonicalize,
    mode: "typed",
  };
}

// ── `security-audit verify` invocations (the Pi parent's import gate) ────────

/**
 * One `helper security-audit verify` invocation a command line may make. The
 * Pi parent's import gate (ADR-0067) proves the run each one imports, so it
 * needs the invocation's arguments exactly: `static` when every word after the
 * operation has one spelling the shell cannot change, `unresolved` otherwise
 * (an expansion, a substitution, a brace or quote set with several views, a
 * line the guard cannot parse, or an invocation the shell is FED — from a
 * script file, a pipe, a here-string or interpreter code — whose text the
 * shell reads at runtime, after this check). Flags are NOT read here — the
 * shell reads them with the CLI's own reader, so the two cannot disagree.
 */
export type SecurityAuditVerifyInvocation =
  | Readonly<{ kind: "static"; segment: string; args: readonly string[] }>
  | Readonly<{ kind: "unresolved"; segment: string; reason: string }>;

/** A helper invocation that may be `security-audit verify`, or null. */
function verifyInvocationOf(segment: string, invocation: HelperInvocation | null): SecurityAuditVerifyInvocation | null {
  if (invocation === null || invocation.helper === "orchestration" || invocation.operation === null) return null;
  if (!namesLiteral(invocation.operation, "verify", "typed")) return null;
  const args: string[] = [];
  for (const word of invocation.rest) {
    // Brace and glob words are expanded by the shell into words the head
    // tokenizer does not reproduce; they are never read as static.
    const views = hasRuntimePart(word) || /[{}]/.test(word) || GLOB_CHAR.test(word) ? null : wordViews(word);
    if (views === null || views.length !== 1) {
      return { kind: "unresolved", segment, reason: `argument ${JSON.stringify(word)} is completed by the shell at runtime` };
    }
    args.push(views[0]);
  }
  const operation = hasRuntimePart(invocation.operation) ? null : wordViews(invocation.operation);
  const staticVerify = invocation.helper === "security-audit" && operation?.length === 1 && operation[0] === "verify";
  return staticVerify
    ? { kind: "static", segment, args }
    : { kind: "unresolved", segment, reason: "the helper or operation name is completed by the shell at runtime" };
}

/** Every invocation found inside FED text is unresolved: the shell reads that
 *  text at runtime, after the gate. */
const asFed = (found: readonly SecurityAuditVerifyInvocation[], source: string): readonly SecurityAuditVerifyInvocation[] =>
  found.map((invocation) => ({ kind: "unresolved", segment: invocation.segment, reason: `the invocation is fed to the shell from ${source} at runtime` }));

/** Fold one parsed line (parseLine — the same structure `judgeLine` folds):
 *  executed heredoc and substitution bodies, every pipe-chain segment, the
 *  programs a segment executes (`bash -c`, `eval`, `xargs`, `find -exec`) and
 *  the programs it is FED (scripts, pipes, here-strings, interpreter code) —
 *  collecting verify invocations. */
function collectVerifyInvocations(
  command: string,
  context: SubagentAuthorityContext,
  scope: PathScope,
  depth: number,
): readonly SecurityAuditVerifyInvocation[] {
  const line = parseLine(command, depth);
  if (line.kind === "blank") return [];
  if (line.kind === "too-deep") return [{ kind: "unresolved", segment: command, reason: "nested too deeply to read" }];
  // The line's segments run where its `cd`s lead, exactly as `judgeLine` reads them.
  const scopes = lineScopesOf(command, line, scope);
  const found: SecurityAuditVerifyInvocation[] = line.nestedBodies
    .flatMap((body) => collectVerifyInvocations(body, context, scopes.everywhere, depth + 1));
  if (line.unparseable && /security-audit/.test(command)) {
    found.push({ kind: "unresolved", segment: command, reason: "the command cannot be parsed" });
  }
  for (const chain of line.chains) {
    for (const site of chain) {
      const { segment, chain: texts, index, command: { head, args }, executed } = site;
      const lineScope = scopes.of(site);
      for (const program of fedPrograms(texts, index, lineScope, context.filesystem)) {
        found.push(...match(program)
          .returnType<readonly SecurityAuditVerifyInvocation[]>()
          .with({ kind: "shell" }, ({ text, source }) => asFed(collectVerifyInvocations(text, context, lineScope, depth + 1), source))
          .with({ kind: "code" }, ({ text, source }) => /security-audit/.test(text) && /verify/.test(text)
            ? [{ kind: "unresolved", segment, reason: `${source} may import a verification run` }]
            : [])
          .with({ kind: "unreadable" }, ({ path }) => /security-audit/.test(command)
            ? [{ kind: "unresolved", segment, reason: `the script ${path} cannot be read to check what it imports` }]
            : [])
          .exhaustive());
      }
      for (const program of executed.programs) found.push(...collectVerifyInvocations(program, context, lineScope, depth + 1));
      const invocation = verifyInvocationOf(segment, helperInvocation(context.helperOperations, head, args, "typed"));
      if (invocation !== null) found.push(invocation);
    }
  }
  return found;
}

/** Every `helper security-audit verify` invocation `command` may make. */
export const securityAuditVerifyInvocations = (
  command: string,
  context: SubagentAuthorityContext,
): readonly SecurityAuditVerifyInvocation[] => collectVerifyInvocations(command, context, pathScope(command, context), 0);

/** The refusal text both harnesses show the subagent: the rule, the segment,
 *  and what to do instead. */
export function renderSubagentAuthorityRefusal(
  refusal: SubagentAuthorityRefusal,
  context: Pick<SubagentAuthorityContext, "runs" | "helperOperations">,
): string {
  const reason = match(refusal)
    .with({ rule: "authority-helper-operation" }, ({ helper, operation }) => {
      const named = helper === "unresolved" ? AUTHORITY_HELPERS.join("|") : helper;
      return operation === null
        ? `\`helper ${named}\` was invoked without a statically known read-only operation.`
        : `\`helper ${named} ${operation}\` is not a read-only operation; only the parent session runs it.`;
    })
    .with({ rule: "authority-path-write" }, ({ path }) =>
      `The command may write ${path}, an authority path of a security-audit run or a protected Loom directory.`)
    .with({ rule: "unparseable-authority-command" }, () =>
      "The command cannot be parsed and it names audit or orchestration authority.")
    .with({ rule: "harness-hook-entrypoint" }, ({ route }) =>
      `The command invokes the Loom \`${route}\` hook entrypoint; only the harness runs hooks.`)
    .with({ rule: "nested-harness" }, ({ harness }) =>
      `The command launches a nested agent harness (${harness}); a subagent does not start sessions of its own.`)
    .with({ rule: "interpreter-authority-code" }, ({ reason }) =>
      `Interpreter code in the command may change audit or orchestration authority — ${reason}.`)
    .with({ rule: "unreadable-script" }, ({ path, reason }) =>
      `The command runs a script the guard cannot read (${path}: ${reason}), and the line concerns audit or orchestration authority.`)
    .exhaustive();
  const readOnly = AUTHORITY_HELPERS
    .map((helper) => `${helper} ${[...context.helperOperations[helper].readOnly].sort().join("|")}`)
    .join("; ");
  const lines = [
    "BLOCKED by loom guard-subagent-authority (ADR-0067 D6): subagents may not change audit or orchestration authority.",
    reason,
    `Offending segment: ${JSON.stringify(refusal.segment)}`,
  ];
  if (context.runs.kind === "unreadable") {
    lines.push(`(The security-audit run registry is unreadable — ${context.runs.reason} — so every authority-named path is refused.)`);
  }
  lines.push(
    `Allowed: reading anything, read-only helper operations (${readOnly}), Loom's read-only scripts (${READ_ONLY_SCRIPTS.join(", ")}), the sandbox script, and writes under agents/<owner>/{scratch,artifacts}.`,
    "Do not retry another way. Return your result to the parent session as your final message; the parent records it.",
  );
  return lines.join("\n");
}
