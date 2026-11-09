/**
 * The here-document layer of the shell grammar: which heredoc bodies are
 * inert data and which are executed (a body fed to an interpreter that reads
 * its program from stdin, or an unquoted body's live substitutions).
 *
 *  - openerLineGroups — heredoc opener-line group cut at depth 0 on
 *    `; && || &` with compound tracking ({ }, ( ), if/fi, while…done,
 *    case…esac, [[ ]]); pipe members stay in ONE group.
 *  - scanPastHeredocSpans / parseHeredocDelimiter / scanHeredocBodySubstitutions
 *    — the heredoc pre-pass; bodies are data unless the owning group EXECUTES
 *    stdin (commandsExecuteStdin, which recurses into inline `-c` programs
 *    because they inherit the command's stdin).
 *  - unquoted-heredoc bodies are scanned quote-INSENSITIVELY (only `\` escapes),
 *    because quote chars are literal data there.
 *
 * Pure. Extracted from core/guard-state-file (see its walker map) so every Bash
 * guard strips heredoc bodies the same way.
 */

import { findClosingBacktick, findClosingParen } from "./shell-substitution";
import { splitCommandSegmentsWithOps } from "./shell-command";
import { analyzeCommandHead, headBase, resolvedInterpreter, unquote } from "./shell-command-head";

/** Substitution nesting deeper than this on a guarded line is nobody's
 *  legitimate command — fail closed rather than recurse further. */
export const MAX_SUBSTITUTION_DEPTH = 5;

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
export const SH_FAMILY_HEADS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);

/** Interpreter flags that take the PROGRAM INLINE (`bash -c '…'`) — stdin
 *  is then DATA, not the program source. */
const INLINE_PROGRAM_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"], python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval", "-p", "--print"],
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

/** Does this simple command's head turn stdin into executed content?
 *  "script": stdin is a program/commands (an interpreter without its own
 *  program source, or xargs, which turns stdin lines into command
 *  arguments); "data": stdin is input data; null: not an interpreter. */
type StdinVerdict = "script" | "data" | null;

function headExecutesStdinVerdict(head: string, args: readonly string[]): StdinVerdict {
  const resolved = resolvedInterpreter(head, args);
  if (resolved === null) return null;
  if (resolved.head === "xargs") return "script";
  if (!HEREDOC_SCRIPT_HEADS.has(resolved.head)) return null;
  return interpreterExecutesStdin(resolved.head, resolved.args) ? "script" : "data";
}

/** Does this simple command run an INTERPRETER that reads its program from
 *  stdin (so a pipe, here-string or input redirect feeding it is a script)?
 *  The same judgment the heredoc pre-pass makes, for every stdin channel.
 *  `xargs` is not an interpreter here: its stdin becomes arguments, which the
 *  guards treat as an executed program of their own. */
export const readsProgramFromStdin = (head: string, args: readonly string[]): boolean => {
  const resolved = resolvedInterpreter(head, args);
  return resolved !== null && resolved.head !== "xargs" && headExecutesStdinVerdict(head, args) === "script";
};

/** The token right after an interpreter's inline-program flag (`-c`, `-e`,
 *  `-r`, …), or null when the invocation has none. */
export function inlineProgramArg(head: string, args: readonly string[]): string | null {
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
    const pastSpan = pastSubstitutionSpan(line, i);
    if (pastSpan === -1) return [{ start: groupStart, end: n }]; // fail closed: one group
    if (pastSpan !== null) { i = pastSpan; continue; }
    const pastCompound = pastCompoundSyntax(line, i, compound);
    if (pastCompound !== null) { i = pastCompound; continue; }
    const separator = groupSeparatorAt(line, i);
    if (separator !== null) {
      if (separator.cuts && compound.length === 0) {
        groups.push({ start: groupStart, end: i });
        groupStart = i + separator.width;
      }
      i += separator.width;
      continue;
    }
    i++;
  }
  groups.push({ start: groupStart, end: n });
  return groups;
}

/** Past a `${…}`, `$(…)`, `<(…)`/`>(…)` or backtick span opening at `i`: the
 *  index just after its close, -1 when it never closes, or null when no such
 *  span opens at `i`. */
function pastSubstitutionSpan(line: string, i: number): number | null {
  const c = line[i];
  const next = line[i + 1];
  let close: number;
  if (c === "$" && next === "{") close = findClosingBrace(line, i + 2);
  else if ((c === "$" || c === "<" || c === ">") && next === "(") close = findClosingParen(line, i + 2);
  else if (c === "`") close = findClosingBacktick(line, i + 1);
  else return null;
  return close === -1 ? -1 : close + 1;
}

/** Is `pos` outside the line or a word-boundary character? */
const isWordBoundary = (line: string, pos: number): boolean =>
  pos < 0 || pos >= line.length || /\s/.test(line[pos]!) || ";&|(){}".includes(line[pos]!);

/** Close the innermost open compound of `kind` and everything nested in it. */
function popCompoundUntil(compound: string[], kind: string): void {
  for (let k = compound.length - 1; k >= 0; k--) {
    if (compound[k] === kind) { compound.length = k; return; }
  }
}

/** Past the compound syntax at `i` — braces, parens, `[[ ]]`, or a word that
 *  opens/closes `if`/loop/`case` — pushing or popping `compound` (the
 *  caller's open-compound stack); null when `i` starts none of them. */
function pastCompoundSyntax(line: string, i: number, compound: string[]): number | null {
  const c = line[i]!;
  const top = compound[compound.length - 1];
  if (c === "{") { compound.push("{"); return i + 1; }
  if (c === "}") { if (top === "{") compound.pop(); return i + 1; }
  if (c === "(") { compound.push("("); return i + 1; }
  // A `)` closes a subshell ONLY when a `(` is open; in `case x in a)` it
  // terminates a PATTERN and must not uncut the case compound.
  if (c === ")") { if (top === "(") compound.pop(); return i + 1; }
  // `[[ … ]]` test brackets: `&&` inside is a test operator, not a chain cut.
  if (c === "[" && line[i + 1] === "[") { compound.push("[["); return i + 2; }
  if (c === "]" && line[i + 1] === "]") { popCompoundUntil(compound, "[["); return i + 2; }
  if (!/[A-Za-z]/.test(c)) return null;
  const m = line.slice(i).match(/^[A-Za-z][A-Za-z0-9_-]*/);
  if (m !== null && isWordBoundary(line, i - 1) && isWordBoundary(line, i + m[0].length)) {
    const word = m[0];
    if (word === "if") compound.push("if");
    else if (word === "while" || word === "until" || word === "for") compound.push("loop");
    else if (word === "case") compound.push("case");
    else if (word === "fi") popCompoundUntil(compound, "if");
    else if (word === "done") popCompoundUntil(compound, "loop");
    else if (word === "esac") popCompoundUntil(compound, "case");
  }
  return i + (m?.[0].length ?? 1);
}

/** The operator at `i` that a group walk must step over: `width` characters,
 *  and whether it `cuts` the group at depth 0 (`;` `;;` `&` `&&` newline
 *  `||`) or binds within it (`|`, `|&`, and the `&` of a redirect or fd dup).
 *  Null when `i` holds no operator. */
function groupSeparatorAt(line: string, i: number): Readonly<{ width: number; cuts: boolean }> | null {
  const c = line[i];
  const next = line[i + 1];
  if (c === ";" || c === "&" || c === "\n") {
    // `&>`/`&>>` redirects and `2>&1`-style fd dups are NOT separators
    // (mirroring splitCommandSegmentsWithOps): the `&` binds to the
    // redirect/dup syntax around it.
    if (c === "&" && next === ">") return { width: 2, cuts: false };
    if (c === "&" && line[i - 1] === ">") return { width: 1, cuts: false };
    const doubled = (c === "&" || c === ";") && next === c;
    return { width: doubled ? 2 : 1, cuts: true };
  }
  if (c === "|") {
    if (next === "|") return { width: 2, cuts: true };
    return { width: next === "&" ? 2 : 1, cuts: false }; // `|&` = one pipe operator
  }
  return null;
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
    // Depth 0: the group slice is the TOP of the stdin-execution check —
    // pipe members share the body's fate, and recursion into inline `-c`
    // programs starts from here (see commandsExecuteStdin).
    return commandsExecuteStdin(line.slice(group.start, group.end), 0);
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
export function splitHeredocs(text: string): HeredocSplit {
  const n = text.length;
  const bodies: string[] = [];
  let stripped = "";
  let unparseable = false;
  let pos = 0;

  while (pos < n) {
    const scan = scanPastHeredocSpans(text, pos, n);
    if (scan.unparseable || scan.next >= n) {
      if (scan.unparseable) unparseable = true;
      stripped += text.slice(pos);
      break;
    }
    const openerPos = scan.next;
    const lineStart = text.lastIndexOf("\n", openerPos - 1) + 1;
    const lineEnd = text.indexOf("\n", openerPos);
    const lineEndAt = lineEnd === -1 ? n : lineEnd;
    const bodyStart = lineEndAt < n ? lineEndAt + 1 : n;

    const collected = collectLineOpeners(text, openerPos, lineStart, lineEndAt);
    if (collected.kind === "unparseable") {
      unparseable = true;
      stripped += text.slice(pos, lineEndAt) + (lineEndAt < n ? "\n" : "");
      stripped += text.slice(bodyStart);
      break;
    }

    // The opener line stays in the judged text, minus the heredoc constructs.
    stripped += openerLineWithoutHeredocs(text, pos, openerPos, collected.openers, lineEndAt);
    if (lineEndAt < n) stripped += "\n";

    if (collected.dangling) {
      const harvest = danglingHeredocRemainder(text, bodyStart, lineStart, lineEndAt, collected.cursor);
      if (harvest.unclosed) unparseable = true;
      bodies.push(...harvest.bodies);
      break;
    }

    const consumed = consumeHeredocBodies(text, collected.openers, bodyStart);
    if (consumed.unparseable) unparseable = true;
    bodies.push(...consumed.bodies);
    pos = consumed.next;
  }

  return Object.freeze({ stripped, bodies: Object.freeze(bodies), unparseable });
}

interface HeredocSplit {
  /** The command text with every heredoc body and `<<` construct removed. */
  readonly stripped: string;
  /** Body text still judged as command text: script bodies and live substitutions. */
  readonly bodies: readonly string[];
  /** An unclosed span was met — the caller fails closed. */
  readonly unparseable: boolean;
}

/** `<<` with no delimiter word on its line: bash would read the delimiter
 *  from the next line; we cannot know it, so fail closed — judge the
 *  remainder as one body (full command text when the line feeds an
 *  interpreter, substitutions only otherwise). */
function danglingHeredocRemainder(
  text: string,
  bodyStart: number,
  lineStart: number,
  lineEndAt: number,
  cursor: number,
): BodyHarvest {
  const rest = text.slice(bodyStart);
  if (rest === "") return { bodies: [], unclosed: false };
  const script = heredocBodyIsScript(text.slice(lineStart, lineEndAt), cursor - lineStart);
  return heredocBodyContribution(rest, { script, quoted: false });
}

/** Every heredoc opener on one opener line, or `unparseable` when a span
 *  after one of them never closes. `dangling` marks a `<<` with no delimiter
 *  word on its line; `cursor` is then that opener's position. */
type LineOpeners =
  | Readonly<{ kind: "parsed"; openers: readonly HeredocOpener[]; dangling: boolean; cursor: number }>
  | Readonly<{ kind: "unparseable" }>;

/** Collect EVERY heredoc opener on this line: bodies attach in order to the
 *  lines that follow, so they must all be known before consumption. */
function collectLineOpeners(text: string, firstOpener: number, lineStart: number, lineEndAt: number): LineOpeners {
  const openerLine = text.slice(lineStart, lineEndAt);
  const openers: HeredocOpener[] = [];
  let cur = firstOpener;
  while (cur < lineEndAt) {
    const word = parseHeredocDelimiter(text, cur, lineEndAt);
    if (word === null) return { kind: "parsed", openers, dangling: true, cursor: cur };
    openers.push({
      start: cur,
      end: word.end,
      delimiter: word.delimiter,
      quoted: word.quoted,
      minus: word.minus,
      script: heredocBodyIsScript(openerLine, cur - lineStart),
    });
    const more = scanPastHeredocSpans(text, word.end, lineEndAt);
    if (more.unparseable) return { kind: "unparseable" };
    if (more.next >= lineEndAt) break;
    cur = more.next;
  }
  return { kind: "parsed", openers, dangling: false, cursor: cur };
}

/** The opener line's text from `from` to its end with every `<<` construct cut out. */
function openerLineWithoutHeredocs(
  text: string,
  from: number,
  openerPos: number,
  openers: readonly HeredocOpener[],
  lineEndAt: number,
): string {
  let kept = text.slice(from, openerPos);
  let last = openerPos;
  for (const g of openers) {
    kept += text.slice(last, g.start);
    last = g.end;
  }
  return kept + text.slice(last, lineEndAt);
}

type BodyHarvest = Readonly<{ bodies: readonly string[]; unclosed: boolean }>;

/** What one heredoc body contributes to judging. The body is data — BUT a
 *  SCRIPT body (heredoc fed to an interpreter) is full command text and gets
 *  judged wholesale, and an UNQUOTED data body still runs its substitutions
 *  (live commands). Quoted data bodies are opaque. */
function heredocBodyContribution(
  body: string,
  feed: Readonly<{ script: boolean; quoted: boolean }>,
): BodyHarvest {
  if (body === "") return { bodies: [], unclosed: false };
  if (feed.script) return { bodies: [body], unclosed: false };
  if (!feed.quoted) return scanHeredocBodySubstitutions(body);
  return { bodies: [], unclosed: false };
}

/** The line at or after `from` that terminates `opener`'s body (`-1` when
 *  none does) and the position just past it. */
function findHeredocTerminator(
  text: string,
  from: number,
  opener: HeredocOpener,
): Readonly<{ terminatorAt: number; nextBodyPos: number }> {
  const n = text.length;
  let search = from;
  while (search < n) {
    const nl = text.indexOf("\n", search);
    const end = nl === -1 ? n : nl;
    let line = text.slice(search, end);
    if (opener.minus) line = line.replace(/^\t+/, "");
    if (line === opener.delimiter) return { terminatorAt: search, nextBodyPos: nl === -1 ? n : nl + 1 };
    search = nl === -1 ? n : nl + 1;
  }
  return { terminatorAt: -1, nextBodyPos: n };
}

/** Consume bodies in opener order, one terminator line each. Unterminated
 *  heredocs consume to end of input. */
function consumeHeredocBodies(
  text: string,
  openers: readonly HeredocOpener[],
  from: number,
): Readonly<{ bodies: readonly string[]; unparseable: boolean; next: number }> {
  const n = text.length;
  const bodies: string[] = [];
  let unparseable = false;
  let bodyPos = from;
  for (const g of openers) {
    if (bodyPos >= n) break;
    const { terminatorAt, nextBodyPos } = findHeredocTerminator(text, bodyPos, g);
    const harvest = heredocBodyContribution(text.slice(bodyPos, terminatorAt === -1 ? n : terminatorAt), g);
    if (harvest.unclosed) unparseable = true;
    bodies.push(...harvest.bodies);
    bodyPos = nextBodyPos;
    if (terminatorAt === -1) break;
  }
  return { bodies, unparseable, next: bodyPos };
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
