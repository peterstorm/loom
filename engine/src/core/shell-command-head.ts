/**
 * The simple-command layer of the shell grammar: how one segment of a command
 * line resolves to the command it runs and whether it can write a file.
 *
 *  - commandWords / splitFusedRedirect / unquote / commandArgs — the simple-
 *    command tokenizer feeding analyzeCommandHead; treats `( ) { }` as
 *    standalone tokens so compound syntax never hides a head.
 *  - resolvedInterpreter — the wrapper unwrap (`sudo`, `env`, `timeout`, …)
 *    to the command a wrapper actually launches.
 *  - hasReadOnlyHead — one half of "this segment cannot write a file": a
 *    head from READ_ONLY_STATE_COMMANDS (the other half, no output redirect
 *    except an fd dup or the exact stderr discard, is core/shell-redirects).
 *  - pipeChains / placedPipeChains — segments grouped into pipe-chains, the
 *    trust unit a guard judges together (placed: with the separators around
 *    each segment, which say whether and where it runs).
 *
 * Pure. Extracted from core/guard-state-file so every Bash guard (the
 * state-file guard, the subagent authority guard) judges commands through ONE
 * grammar; tests/core/guard-state-file-walkers.test.ts pins its contracts.
 */

import { READ_ONLY_STATE_COMMANDS } from "./tool-vocabulary";
import { FILTER_INERT_ENVIRONMENT, isReadOnlyFilterInvocation } from "./read-only-filters";
import { GH_INERT_ENVIRONMENT, isReadOnlyGhInvocation } from "./read-only-gh";
import { isReadOnlyGitInvocation } from "./read-only-git";
import { CONTINUE, halt, scanUnquoted, skip } from "./shell-quoting";
import { collapseVariants, hasRuntimePart, staticSpelling } from "./shell-match-views";
import {
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
  type SegmentOp,
} from "./shell-command";

/**
 * A command WORD as the shell resolves it before lookup: backslash escapes
 * removed (`\loom`, `l\oom` and `\rm` name `loom` and `rm` — bash drops an
 * unquoted backslash and keeps the character after it). Applied to heads
 * only: an escaped head must not slip past a name-based judgment.
 */
export const unescapeCommandWord = (word: string): string => word.replace(/\\(.)/gs, "$1");

/** Strip one layer of surrounding quotes from a token (`"…"` / `'…'`). */
export function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.endsWith(first) && token.length >= 2) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * The command NAME one head word resolves to: one layer of surrounding quotes
 * stripped, then backslash escapes removed. The one word-to-name rule every
 * head judgment in this module applies (analyzeCommandHead and hasReadOnlyHead).
 */
const commandName = (word: string): string => unescapeCommandWord(unquote(word));

/**
 * Does the segment write no local file and run no program, by its head? Either
 * a read-only head (READ_ONLY_STATE_COMMANDS) or a read-only git/gh invocation
 * (`isReadOnlySubcommandInvocation`). Exact-name
 * membership (no basename resolution — `./cat` must not inherit `cat`'s
 * trust), after env-prefix stripping so `CI=1 jq …` matches. A pure
 * assignment (`F=active_task_graph.json`) strips to an empty head and
 * therefore fails the check: binding a guarded path to a variable is the
 * seed of every cross-segment indirection, and a read never needs it.
 *
 * The head is the segment's LITERAL first shell word, resolved to a name by
 * the same rule analyzeCommandHead applies (commandName), so an escaped read
 * (`\cat`) is judged as the command bash runs. It deliberately does NOT walk
 * past compound syntax the way analyzeCommandHead does: that walker
 * over-resolves on purpose (finding MORE interpreters is its fail-closed
 * direction), and an allowlist must under-resolve. Skipping a function-
 * definition prefix would read `cat() { rm <state>` — a definition whose body
 * is the write — as a `cat` read; skipping `(`/`{`/`!` would trust what the
 * compound wraps. Any such head is simply not read-only.
 */
export function hasReadOnlyHead(segment: string): boolean {
  const head = shellWords(stripEnvPrefix(segment))[0];
  return head !== undefined && (READ_ONLY_STATE_COMMANDS.has(commandName(head)) || isReadOnlySubcommandInvocation(segment));
}

/** One audited read-only classifier and the environment names its command
 *  may be prefixed with: a name outside the set may make it write or run. */
type ReadOnlyClassifier = Readonly<{
  environment: ReadonlySet<string>;
  reads: (spellings: readonly (string | null)[]) => boolean;
}>;

/** Each classifier owns its prefix rule: none for git (`GIT_EXTERNAL_DIFF=…`
 *  runs a program), credentials and host for gh (its pager, browser and editor
 *  variables run programs), the locale for the filters (`TMPDIR` is where
 *  `sort` spills). */
const READ_ONLY_CLASSIFIERS: readonly ReadOnlyClassifier[] = [
  { environment: new Set<string>(), reads: isReadOnlyGitInvocation },
  { environment: GH_INERT_ENVIRONMENT, reads: isReadOnlyGhInvocation },
  { environment: FILTER_INERT_ENVIRONMENT, reads: isReadOnlyFilterInvocation },
];

/** The names a run of `NAME=value` words assigns. */
const assignmentNames = (words: readonly string[]): readonly string[] =>
  words.map((word) => word.slice(0, word.indexOf("=")));

/**
 * Is the segment a `git`, `gh`, `sort`, `uniq` or `find` invocation that
 * writes no local file and runs no program? Every word after the environment
 * prefix is judged by its one static spelling under `spell` (a word the shell
 * could complete into an option at runtime is not admitted), the prefix by
 * the classifier's own environment set, and the verdict is the audited
 * classifier's: `isReadOnlyGitInvocation` (#177), `isReadOnlyGhInvocation` or
 * `isReadOnlyFilterInvocation` (#216). The state guard spells words as written
 * (`staticSpelling`); the subagent authority guard first pins the values its
 * line binds.
 */
export function isReadOnlySubcommandInvocation(
  segment: string,
  spell: (word: string) => string | null = staticSpelling,
): boolean {
  const line = stripComment(segment).trim();
  const raw = shellWords(line);
  const prefixLength = raw.length - shellWords(stripEnvPrefix(line)).length;
  const spellings = raw.slice(prefixLength).map(spell);
  if (spellings.length === 0) return false;
  const prefixNames = assignmentNames(raw.slice(0, prefixLength));
  return READ_ONLY_CLASSIFIERS.some(({ environment, reads }) =>
    prefixNames.every((name) => environment.has(name)) && reads(spellings));
}

/** Names the shell itself reads: assigning one changes where `~`, `cd`, a
 *  command or a word resolves, so a guard never treats its assignment as inert. */
export const SHELL_STATE_NAMES: ReadonlySet<string> = new Set([
  "HOME", "CDPATH", "PWD", "OLDPWD", "PATH", "ENV", "BASH_ENV", "IFS", "SHELLOPTS", "BASHOPTS",
  "GLOBIGNORE", "DIRSTACK", "BASH_XTRACEFD", "PROMPT_COMMAND", "PS4",
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** May `text` set `name` — an assignment, an `export`, a `read`/`printf -v`
 *  target, an indirection naming it? Any mention but a plain `$name` /
 *  `${name}` read counts. */
export function mayRebind(text: string, name: string): boolean {
  const literal = escapeRegExp(name);
  return new RegExp(`(?<![A-Za-z0-9_$])${literal}(?![A-Za-z0-9_])`).test(text.replace(new RegExp(`\\$\\{${literal}\\}`, "g"), ""));
}

/** Builtins that rebind a command name (`hash`, `alias`, `enable`), run a file
 *  in this shell that may (`source`, `.`), or run shell text later in this
 *  shell (`trap` before a command, `mapfile -C` per line read). */
const REBINDING_HEADS: ReadonlySet<string> = new Set(["hash", "alias", "enable", "source", ".", "trap", "mapfile", "readarray"]);

/** Variables that decide which program a command name runs, or inject code
 *  into every program: the search path, bash's command and alias tables, and
 *  the dynamic loaders' preload and search variables. */
const RESOLUTION_VARIABLES: readonly string[] = ["PATH", "BASH_CMDS", "BASH_ALIASES"];
const LOADER_VARIABLE = /(?<![A-Za-z0-9_$])(?:LD|DYLD)_[A-Z_]+/;

/** How deep a literal `eval` is followed into the text it runs; deeper fails closed. */
const MAX_EVAL_DEPTH = 4;

/**
 * May a command name on this line run something other than the program it
 * names (loom#216)? Judged per segment by the command each one runs, as the
 * head walker resolves it (`analyzeCommandHead`: behind reserved words, case
 * patterns, assignment prefixes, quotes and backslashes; then behind
 * `command`, `builtin`, `time` and the other wrappers):
 *
 * - a rebinding builtin (`REBINDING_HEADS`) or a function definition
 *   (`name()`, `name ( )`, `function name`, with any compound body);
 * - an `eval` of runtime-built text, or of literal text that does either;
 * - in any spelling bash may give the line (`collapseVariants`), a mention of
 *   `PATH`, `BASH_CMDS` or `BASH_ALIASES` other than a plain read, or of an
 *   `LD_*`/`DYLD_*` variable.
 *
 * On such a line no guard trusts a head by its name: `cat(){ rm "$1"; }; cat
 * <state>` is not a read. The one rule both Bash guards apply.
 */
export function commandNamesRebound(line: string): boolean {
  return reboundAt(line, 0);
}

function reboundAt(line: string, depth: number): boolean {
  if (depth > MAX_EVAL_DEPTH) return true;
  const views = collapseVariants(line);
  if (views === null) return true;
  const resolutionChanged = [line, ...views].some((text) =>
    RESOLUTION_VARIABLES.some((name) => mayRebind(text, name)) || LOADER_VARIABLE.test(text));
  return resolutionChanged || pipeChains(line).flat().some((segment) => segmentRebinds(segment, depth));
}

/** Does this one simple command rebind a command name, or run text that may? */
function segmentRebinds(segment: string, depth: number): boolean {
  if (definesFunction(commandWords(withoutReservedWords(segment)))) return true;
  const analyzed = analyzeCommandHead(segment);
  if (analyzed === null) return false;
  const { head, args } = resolvedInterpreter(analyzed.head, analyzed.args) ?? analyzed;
  if (REBINDING_HEADS.has(head)) return true;
  if (head !== "eval") return false;
  const program = args.join(" ");
  return hasRuntimePart(program) || reboundAt(program, depth + 1);
}

/** A name word directly followed by `(` `)` (`cat()`, `cat ( )`), or the
 *  `function` keyword at the head: a function definition, whatever its body. */
const definesFunction = (words: readonly string[]): boolean =>
  unquote(words[0] ?? "") === "function" ||
  words.some((word, index) => words[index + 1] === "(" && words[index + 2] === ")" && /^[\\A-Za-z_][\\\w.:-]*$/.test(word));

/** Reserved words that open or continue a compound command; the command after one is still judged. */
const LEADING_RESERVED = /^(?:if|then|else|elif|while|until|do|!|\{)(?=\s|$)\s*/;
/** Reserved words that close a compound; whatever follows one is redirect syntax or nothing. */
const CLOSING_RESERVED = /^(?:done|fi|\})(?=\s|$|[<>])\s*/;

/**
 * A segment with the reserved words around its command removed: `do cat "$f"`
 * is `cat "$f"`, `if grep -q x f` is `grep -q x f`, `done > out` is `> out`.
 * Never a function-definition prefix (`cat() { rm …` keeps its head); a line
 * holding one is refused by `commandNamesRebound`.
 */
export function withoutReservedWords(segment: string): string {
  let rest = stripComment(segment).trim();
  for (;;) {
    const next = rest.replace(LEADING_RESERVED, "").replace(CLOSING_RESERVED, "");
    if (next === rest) return rest;
    rest = next;
  }
}

/** A shell variable name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variable names a segment binds when binding is all it does, else null:
 * only `NAME=value` words (`F=a G="b c"`), `for NAME [in WORDS]`, or
 * `read [-r] [-s] NAME…`. Such a segment writes no file; what it binds may
 * reach a write elsewhere on its line, which a guard judges there.
 */
export function bindingNames(segment: string): readonly string[] | null {
  const line = stripComment(segment).trim();
  if (line === "") return null;
  if (stripEnvPrefix(line).trim() === "") {
    return shellWords(line).map((word) => word.slice(0, word.indexOf("=")));
  }
  const words = shellWords(line);
  if (words[0] === "for" && words[1] !== undefined && NAME.test(words[1]) && (words.length === 2 || words[2] === "in")) {
    return [words[1]];
  }
  if (words[0] === "read") {
    const names = words.slice(1).filter((word) => word !== "-r" && word !== "-s");
    return names.length > 0 && names.every((word) => NAME.test(word)) ? names : null;
  }
  return null;
}

/**
 * Is the segment, once its compound syntax is removed, only redirects — the
 * `done > out` or `} < in` that closes a compound command?
 */
export function isRedirectsOnly(text: string): boolean {
  const words = commandWords(text);
  for (let k = 0; k < words.length; k++) {
    const w = words[k] as string;
    if (PURE_REDIRECT.test(w)) { k++; continue; }
    if (!FUSED_REDIRECT.test(w)) return false;
  }
  return true;
}

/**
 * One simple command of a pipe-chain with the separators around it. The one
 * before decides WHETHER it runs (`&&` only after a success, `||` only after a
 * failure); the one after decides WHERE its effects land — a segment followed
 * by `|` or `&` runs in a subshell of its own, so a `cd` there moves nothing.
 * Null at either end of the line.
 */
export type PlacedSegment = Readonly<{ text: string; opBefore: SegmentOp | null; opAfter: SegmentOp | null }>;

/** Segments grouped into pipe-chains, each with its separators: `|` links
 *  segments into one chain (data flows through it), every other separator
 *  starts a new chain. Empty segments drop out; a trailing `&` still marks the
 *  segment before it. */
export function placedPipeChains(command: string): readonly (readonly PlacedSegment[])[] {
  const segments = splitCommandSegmentsWithOps(command);
  const chains: PlacedSegment[][] = [];
  segments.forEach(({ text, opBefore }, index) => {
    const placed = { text: stripComment(text).trim(), opBefore, opAfter: segments[index + 1]?.opBefore ?? null };
    if (opBefore === "|" && chains.length > 0) chains[chains.length - 1].push(placed);
    else chains.push([placed]);
  });
  return chains.map((chain) => chain.filter(({ text }) => text !== "")).filter((chain) => chain.length > 0);
}

/** Segment texts grouped into pipe-chains (`placedPipeChains` without the separators). */
export function pipeChains(command: string): string[][] {
  return placedPipeChains(command).map((chain) => chain.map(({ text }) => text));
}

export const headBase = (token: string): string => {
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
  "setsid", "stdbuf", "taskset", "ionice", "chrt", "watch", "env", "time",
]);

/** Wrapper options that CONSUME the next token, so it must not be mistaken
 *  for the wrapped command (`sudo -u root bash`, `timeout -s KILL 5 bash`).
 *  BOOLEAN flags are deliberately ABSENT from this table: `sudo -S` (read
 *  password from stdin), `env -0`/`--null`, `env -v`/`--debug`, and
 *  `watch -d`/`--differences` take no value. Listing one here makes
 *  `unwrapWrapper` swallow the wrapped interpreter (`env -0 bash` → `[]`),
 *  resolution lands off the interpreter set, and a quoted heredoc body is
 *  judged opaque DATA instead of a script — the fail-open direction this
 *  guard exists to close (round-3 reviewer, upheld by the refutation panel).
 *  Boolean flags instead take the plain flag-skip below, leaving the
 *  wrapped command to be resolved as usual. A wrapper with no value-taking
 *  option (`command`, `builtin`, `setsid`, `nohup`) has no row: WRAPPER_HEADS
 *  is the closed set of wrappers, and a missing row means "consumes nothing". */
const WRAPPER_FLAG_ARGS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-C", "-p", "-T", "-R", "-r", "-D"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n"],
  stdbuf: ["-i", "-o", "-e"],
  taskset: ["-c", "-p"],
  ionice: ["-c", "-n", "-p"],
  chrt: ["-p"],
  watch: ["-n"],
  exec: ["-a", "-c"],
  env: ["-u", "--unset", "-C", "--chdir", "--argv0", "-S", "--split-string"],
  // `time -p cmd` (bash keyword and /usr/bin/time): `-f`/`-o` take a value.
  time: ["-f", "--format", "-o", "--output"],
};

/** Unwrap one leading wrapper: skip its options (and option arguments) and
 *  return the wrapped command's tokens, or null when `tokens` does not
 *  START with a recognized wrapper. `env -S 'cmd…'` re-splits the option
 *  value as a command line. */
function unwrapWrapper(tokens: readonly string[]): readonly string[] | null {
  const head = headBase(commandName(tokens[0] ?? ""));
  if (!WRAPPER_HEADS.has(head)) return null;
  const consume = WRAPPER_FLAG_ARGS[head] ?? [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") { i++; break; }
    if (head === "env" && (t === "-S" || t === "--split-string")) {
      // `env -S 'bash -c …'` / `env --split-string '…'`: the option VALUE is
      // the whole command line, so it must be re-split. Split-string is an
      // ENV semantic — `sudo -S` (read password from stdin) is a BOOLEAN
      // flag: it is not in WRAPPER_FLAG_ARGS above, so it takes the flag-skip
      // and the following token is the wrapped command, not its value.
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

/** Resolve a simple command's head through the wrapper chain to the
 *  interpreter it actually runs, or null when the chain does not land on a
 *  recognized head. Same unwrap the heredoc stdin verdicts use — exposed
 *  so the inline-program checks (`inlineProgramArg`, variable detection,
 *  stdin-inheritance recursion) apply to the RESOLVED interpreter rather
 *  than the wrapper that merely fronted it (`sudo bash -c 'sh'`,
 *  `env -S 'bash -c "sh"'`). */
export function resolvedInterpreter(
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
  const rawHead = unquote(tokens[0]);
  const split = splitFusedRedirect(rawHead);
  return { head: headBase(unescapeCommandWord(split?.head ?? rawHead)), args: tokens.slice(1) };
}

/** Leading words that are compound syntax, never a command head. */
const HEAD_KEYWORDS = new Set([
  "if", "then", "else", "elif", "while", "until", "for", "do", "done",
  "case", "esac", "in", "{", "}", "(", ")", "!", "[[", "((", "function",
]);

/**
 * The shell WORDS of one simple-command slice, as bash splits them before
 * expansion: unquoted whitespace separates, quoted regions and `${…}`
 * parameter spans (including their nested braces) stay inside one word. Unlike
 * commandWords, `{`/`}`/`(`/`)` are NOT split out, so `${RUN}/ledger.json` stays
 * one word whose expansion a guard can model. Built on the one quote scan.
 */
export function shellWords(text: string): readonly string[] {
  // The scan visits only UNQUOTED characters (never a quote or escape), so it
  // records where words are cut; the words are the text between the cuts.
  const separators: number[] = [];
  let braceDepth = 0;
  scanUnquoted<never>(text, 0, (char, index) => {
    if (char === "$" && text[index + 1] === "{") {
      braceDepth++;
      return skip(index + 2);
    }
    if (char === "}" && braceDepth > 0) braceDepth--;
    else if (/\s/.test(char) && braceDepth === 0) separators.push(index);
    return CONTINUE;
  });
  const words: string[] = [];
  let start = 0;
  for (const separator of [...separators, text.length]) {
    if (separator > start) words.push(text.slice(start, separator));
    start = separator + 1;
  }
  return words;
}

/**
 * Quote-aware word split of one simple-command slice for HEAD resolution:
 * unquoted `(`/`)`/`{`/`}` are standalone tokens so compound syntax never
 * hides a head (`(bash`, `{ sh`). Quoted regions and escape pairs stay inside
 * their word, verbatim.
 *
 * Why two tokenizers on the one quote scan: shellWords models what a word
 * EXPANDS to, so a `${…}` span with its braces must stay one word
 * (`${RUN}/ledger.json`); commandWords models which word is a COMMAND, so a
 * brace or paren must split even when fused (`{bash`), and `${` gets no
 * special treatment — a head never starts with a parameter span the guard
 * could model anyway. Same quote alphabet and escape rule (scanUnquoted);
 * different cut points.
 */
export function commandWords(text: string): readonly string[] {
  const words: string[] = [];
  let start = 0;
  const cut = (end: number): void => {
    if (end > start) words.push(text.slice(start, end));
  };
  scanUnquoted<never>(text, 0, (char, index) => {
    if (/\s/.test(char)) {
      cut(index);
      start = index + 1;
    } else if (char === "(" || char === ")" || char === "{" || char === "}") {
      cut(index);
      words.push(char);
      start = index + 1;
    }
    return CONTINUE;
  });
  cut(text.length);
  return words;
}

/** First UNQUOTED redirect operator inside a raw word, split off from its
 *  prefix: `bash<<'EOF'` → head `bash` + rest `<<'EOF'`; `2>/dev/null` →
 *  head `2` + rest `>/dev/null`; `2>&1` → head `2` + rest `>&1`. Every
 *  redirect operator starts at an unquoted `<` or `>`, or is `&>`/`&>>`. A
 *  quoted operator (`'a<<b'`) is literal word text and never splits. Returns
 *  null when the word contains no unquoted redirect. */
export function splitFusedRedirect(word: string): { readonly head: string; readonly rest: string } | null {
  const at = scanUnquoted<number>(word, 0, (c, i) =>
    c === "<" || c === ">" || (c === "&" && word[i + 1] === ">") ? halt(i) : CONTINUE);
  return at === null ? null : { head: word.slice(0, at), rest: word.slice(at) };
}

/** A word that is ONLY a redirect operator; its target/delimiter is the next word. */
const PURE_REDIRECT = /^(?:[0-9]*[<>]{1,2}|<<<|&>+|<<-|<>)$/;
/** A word that is a redirect fused with its target (`3>file`, `2>&1`, `<<'EOF'`). */
const FUSED_REDIRECT = /^(?:[0-9]+[<>]|[<>]|&>)[^\s]*$/;

/** Argument words after the head: redirect operators and their
 *  targets/delimiters are consumed (`<< 'EOF'`, `3>file`, `2>&1`),
 *  compound-closing `)`/`}` words are syntax junk (never script-file
 *  arguments). */
function commandArgs(words: readonly string[], from: number): readonly string[] {
  const args: string[] = [];
  for (let k = from; k < words.length; k++) {
    const w = words[k];
    if (w === ")" || w === "}") continue; // compound closes are syntax, never args
    if (PURE_REDIRECT.test(w)) { k++; continue; } // operator + target/delimiter
    if (FUSED_REDIRECT.test(w)) continue; // `3>file`, `2>&1`, `<<'EOF'`
    args.push(unquote(w));
  }
  return args;
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
    const raw = words[i];
    const w = unquote(raw);
    if (w === "case") { inCase = true; i++; continue; }
    // `coproc cmd …` runs cmd; `coproc NAME { …; }` / `coproc NAME ( … )`
    // names the coprocess first, then a compound whose body is the command.
    if (w === "coproc") {
      i += words[i + 2] === "{" || words[i + 2] === "(" ? 2 : 1;
      continue;
    }
    if (inCase) {
      if (w === "in") inCase = false; // `case … in` — patterns follow
      i++;
      continue;
    }
    // `case` PATTERN: a word immediately followed by a standalone `)` with
    // a real word after it. A `)` followed only by redirects is a subshell
    // close (`( x ) << 'EOF'`), not a pattern terminator.
    if (words[i + 1] === ")" && i + 2 < words.length && words[i + 2] !== ")" &&
        !PURE_REDIRECT.test(words[i + 2]) && !FUSED_REDIRECT.test(words[i + 2])) {
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
      return { head: commandName(split.head), args: commandArgs(words, i + 1) };
    }
    break;
  }
  if (i >= words.length) return null;
  return { head: commandName(words[i]), args: commandArgs(words, i + 1) };
}
