/**
 * The simple-command layer of the shell grammar: how one segment of a command
 * line resolves to the command it runs and whether it can write a file.
 *
 *  - commandWords / splitFusedRedirect / unquote / commandArgs — the simple-
 *    command tokenizer feeding analyzeCommandHead; treats `( ) { }` as
 *    standalone tokens so compound syntax never hides a head.
 *  - resolvedInterpreter — the wrapper unwrap (`sudo`, `env`, `timeout`, …)
 *    to the command a wrapper actually launches.
 *  - hasReadOnlyHead / hasOutputRedirect — the two halves of "this segment
 *    cannot write a file": a head from READ_ONLY_STATE_COMMANDS and no output
 *    redirect except the exact stderr discard.
 *  - pipeChains — segments grouped into pipe-chains, the trust unit a guard
 *    judges together.
 *
 * Pure. Extracted from core/guard-state-file so every Bash guard (the
 * state-file guard, the subagent authority guard) judges commands through ONE
 * grammar; tests/core/guard-state-file-walkers.test.ts pins its contracts.
 */

import { READ_ONLY_STATE_COMMANDS } from "./tool-vocabulary";
import { CONTINUE, halt, scanUnquoted, skip } from "./shell-quoting";
import {
  classifyFdDupWord,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
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
 * Is the segment's head a command that cannot write a file? Exact-name
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
  return head !== undefined && READ_ONLY_STATE_COMMANDS.has(commandName(head));
}

/**
 * Remove the one output redirect that cannot mutate guarded authority:
 * discarding stderr to the literal `/dev/null`. This is intentionally narrow
 * (`2>` only, no append/clobber variants, expansions, or lookalike paths).
 * Read-only probes routinely use this form for optional guarded directories;
 * treating it as a state write made `ls .loom 2>/dev/null` impossible.
 */
function withoutSafeStderrDiscard(segment: string): string {
  const ranges: Array<Readonly<{ start: number; end: number }>> = [];
  const isBoundary = (char: string | undefined): boolean =>
    char === undefined || /\s/.test(char) || ";&|(){}".includes(char);
  scanUnquoted<never>(segment, 0, (char, index) => {
    if (char !== "2" || !isBoundary(segment[index - 1]) || segment[index + 1] !== ">") {
      return CONTINUE;
    }
    let cursor = index + 2;
    if (segment[cursor] === ">" || segment[cursor] === "&" || segment[cursor] === "|") {
      return CONTINUE;
    }
    while (segment[cursor] === " " || segment[cursor] === "\t") cursor += 1;
    const target = "/dev/null";
    if (!segment.startsWith(target, cursor) || !isBoundary(segment[cursor + target.length])) {
      return CONTINUE;
    }
    const end = cursor + target.length;
    ranges.push(Object.freeze({ start: index, end }));
    return skip(end);
  });
  if (ranges.length === 0) return segment;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += segment.slice(cursor, range.start) + " ";
    cursor = range.end;
  }
  return result + segment.slice(cursor);
}

/**
 * Quote-aware output-redirect detection after removing exact safe stderr
 * discards. Every remaining unquoted `>` counts as a write channel UNLESS it
 * is an fd dup — `>&` followed by a word that is ENTIRELY digits or exactly
 * `-` (`2>&1`, `>&2`, `>&-`), classified by the shared
 * classifyFdDupWord. A `>&` whose word merely starts with a digit but
 * continues into a path (`>&2/../file` — the round-16 bypass) or is any other
 * word (`>&file`, the round-15 bypass) redirects to a file and counts as a
 * write. Quoted `>` characters remain ordinary argument text.
 */
export function hasOutputRedirect(segment: string): boolean {
  const inspected = withoutSafeStderrDiscard(segment);
  return scanUnquoted<true>(inspected, 0, (c, i) => {
    if (c !== ">") return CONTINUE;
    if (inspected[i + 1] !== "&") return halt(true);
    const dup = classifyFdDupWord(inspected, i + 2);
    return dup.isFdDup
      ? skip(dup.end) // digits/`-`: nothing special inside the dup word
      : halt(true); // `>&word` writes the FILE `word`
  }) ?? false;
}

/** Segments grouped into pipe-chains: `|` links segments into one chain
 *  (data flows through it), every other separator starts a new chain. */
export function pipeChains(command: string): string[][] {
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
  const head = headBase(unescapeCommandWord(unquote(tokens[0] ?? "")));
  if (!WRAPPER_HEADS.has(head)) return null;
  const consume = WRAPPER_FLAG_ARGS[head] ?? [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
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
  const rawHead = unquote(tokens[0]!);
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

/** Redirect operators, longest-first, for fused-redirect splitting. The
 *  `&>`-on-`&` form is checked separately (it can only start at the `&`). */
const REDIRECT_OPS = ["<<<", "<<-", "<<", ">>", "<>", ">&", ">", "<"] as const;

/** First UNQUOTED redirect operator inside a raw word, split off from its
 *  prefix: `bash<<'EOF'` → head `bash` + rest `<<'EOF'`; `2>/dev/null` →
 *  head `2` + rest `>/dev/null`; `2>&1` → head `2` + rest `>&1`. A quoted
 *  operator (`'a<<b'`) is literal word text and never splits. Returns null
 *  when the word contains no unquoted redirect. */
export function splitFusedRedirect(word: string): { readonly head: string; readonly rest: string } | null {
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
    const w = words[k]!;
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
    const raw = words[i]!;
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
      return { head: commandName(split.head), args: commandArgs(words, i + 1) };
    }
    break;
  }
  if (i >= words.length) return null;
  return { head: commandName(words[i]!), args: commandArgs(words, i + 1) };
}
