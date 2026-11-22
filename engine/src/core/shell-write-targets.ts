/**
 * Bash-authored file writes: the paths one Bash command line names as write
 * targets — redirections, `tee` targets, and literal `mv`/`git mv`/`cp`
 * destinations. Pure text scanning, shared by both harnesses through
 * `extractEvidence`, which mints each target as a via-shell FileWrite.
 */

import { splitCommandSegments, stripComment, stripEnvPrefix } from "./shell-command";
import { CONTINUE, halt, lexShellQuotes } from "./shell-quoting";
import { redirectTargetsOf } from "./shell-redirects";

/** Quote-aware words of a segment with their quotes and escapes removed,
 *  stopping at the first unquoted redirect character (`>`, `<`, `&`) —
 *  those belong to the redirect scan. */
function wordsBeforeRedirect(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current !== "") words.push(current);
    current = "";
  };
  // Quote characters only delimit regions; an escape contributes the character it escapes.
  lexShellQuotes<true>(segment, 0, (token) => {
    if (token.kind === "escape") current += token.escaped;
    if (token.kind !== "text") return CONTINUE;
    if (token.quote === null && /[><&]/.test(token.char)) return halt(true);
    if (token.quote === null && /\s/.test(token.char)) flush();
    else current += token.char;
    return CONTINUE;
  });
  flush();
  return words;
}

/** Collect `tee [-a] file…` targets in one segment (flags skipped, `--` ends them). */
function collectTeeTargets(segment: string, out: string[]): void {
  const words = wordsBeforeRedirect(stripEnvPrefix(segment.trim()));
  if (words.length === 0) return;
  const head = words[0];
  if (head !== "tee" && !head.endsWith("/tee")) return;
  let flagsDone = false;
  for (const w of words.slice(1)) {
    if (!flagsDone && w === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && w.startsWith("-")) continue;
    out.push(w);
  }
}

/** The words after a literal `mv`, `cp` or `git mv` head, or null for any
 *  other command. A path-qualified head (`/bin/mv`) is the same command. */
function moveCopyArguments(words: readonly string[]): readonly string[] | null {
  const isHead = (word: string | undefined, name: string): boolean =>
    word !== undefined && (word === name || word.endsWith(`/${name}`));
  if (isHead(words[0], "mv") || isHead(words[0], "cp")) return words.slice(1);
  if (isHead(words[0], "git") && words[1] === "mv") return words.slice(2);
  return null;
}

/** Options of `mv`/`cp` that take a separate value: that value is never a
 *  path operand. `t` / `--target-directory` names the destination directory. */
const VALUE_SHORT_OPTIONS: ReadonlySet<string> = new Set(["t", "S"]);
const VALUE_LONG_OPTIONS: ReadonlySet<string> = new Set(["--target-directory", "--suffix"]);
const TARGET_DIRECTORY_PREFIX = "--target-directory=";

/** Where one source lands inside a destination directory. */
function insideDirectory(directory: string, source: string): string {
  const base = source.replace(/\/+$/, "").split("/").pop() ?? source;
  return `${directory.replace(/\/+$/, "")}/${base}`;
}

/** The operands and `-t` target directory of a `mv`/`cp` argument list. */
function moveCopyOperands(args: readonly string[]): Readonly<{ operands: readonly string[]; targetDirectory: string | null }> {
  const operands: string[] = [];
  let targetDirectory: string | null = null;
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (optionsDone || word === "-" || !word.startsWith("-")) {
      operands.push(word);
    } else if (word === "--") {
      optionsDone = true;
    } else if (word.startsWith(TARGET_DIRECTORY_PREFIX)) {
      targetDirectory = word.slice(TARGET_DIRECTORY_PREFIX.length);
    } else if (VALUE_LONG_OPTIONS.has(word)) {
      const value = args[++i];
      if (word === "--target-directory" && value !== undefined) targetDirectory = value;
    } else if (!word.startsWith("--")) {
      // A short-option group (`-rt DIR`, `-tDIR`): a value-taking letter
      // consumes the rest of the group, or else the next word.
      const letters = word.slice(1);
      const at = [...letters].findIndex((letter) => VALUE_SHORT_OPTIONS.has(letter));
      if (at !== -1) {
        const rest = letters.slice(at + 1);
        const value = rest !== "" ? rest : args[++i];
        if (letters[at] === "t" && value !== undefined) targetDirectory = value;
      }
    }
  }
  return { operands, targetDirectory };
}

/**
 * Collect the destinations of a literal `mv`, `git mv` or `cp` in one segment
 * (FR-034): the paths the command creates, so a renamed or copied file
 * appears under its NEW path. Options are skipped (`--` ends them), and an
 * option's separate value is never read as a path.
 * - `-t DIR` / `--target-directory[=]DIR`: every operand lands in DIR.
 * - Several sources, or a destination spelled with a trailing `/`: the
 *   destination is a directory, and each source lands inside it.
 * - Otherwise the last operand is the destination path itself.
 * Purely textual: `mv a existing-dir` names `existing-dir` itself, not
 * `existing-dir/a`, which only over-mints. A source is not a write.
 */
function collectMoveCopyTargets(segment: string, out: string[]): void {
  const args = moveCopyArguments(wordsBeforeRedirect(stripEnvPrefix(segment.trim())));
  if (args === null) return;
  const { operands, targetDirectory } = moveCopyOperands(args);
  if (targetDirectory !== null) {
    for (const source of operands) out.push(insideDirectory(targetDirectory, source));
    return;
  }
  if (operands.length < 2) return;
  const destination = operands[operands.length - 1];
  const sources = operands.slice(0, -1);
  if (sources.length > 1 || destination.endsWith("/")) {
    for (const source of sources) out.push(insideDirectory(destination, source));
  } else {
    out.push(destination);
  }
}

/** The process-stream and sink devices a write can name: `/dev/null`, the
 *  stdio streams, the controlling terminal, and `/dev/fd/<n>`. */
const DEVICE_STREAM_PATH = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Whether a write target names a device stream rather than a file: writing
 * to it stores nothing anyone can read back from the filesystem, so it is
 * not a file write (`cmd 2>/dev/null`, `| tee /dev/stderr`, `>/dev/fd/3`).
 *
 * Only an ABSOLUTE target can be judged here. It is normalized lexically
 * first, so `//dev/null` and `/dev/./null` match while `/dev/../repo/x`
 * does not. A relative target is never a device: targets are not resolved
 * against a cwd in this module (consumers do that), and keeping it can only
 * over-mint. The set is closed on purpose — `/dev/shm/…` and other paths
 * under `/dev` are real, readable files and stay write targets.
 */
export function isDeviceStreamPath(target: string): boolean {
  return target.startsWith("/") && DEVICE_STREAM_PATH.test(normalizeAbsolute(target));
}

/** An absolute path with empty, `.` and `..` segments folded lexically
 *  (`..` at the root stays at the root) and no trailing slash. Lexical
 *  only — no symlink is followed, which the pure core cannot see. */
function normalizeAbsolute(path: string): string {
  const segments = path.split("/").reduce<readonly string[]>((kept, segment) => {
    if (segment === "" || segment === ".") return kept;
    if (segment === "..") return kept.slice(0, -1);
    return [...kept, segment];
  }, []);
  return `/${segments.join("/")}`;
}

/**
 * Every file path a Bash command line writes, as far as its text names it:
 * redirections (`>`, `>>`, `>|`, `&>`, `n>`, `n>>`, `<>`, `>&file`), `tee` targets, and the
 * destinations of a literal `mv`, `git mv` or `cp` — quote-aware and
 * unquoted, per segment, comments stripped. These mint FileWrite evidence so
 * a report artifact STAGED via Bash (`cat > /tmp/r.json <<EOF …`,
 * `cp staged.json r.json`) is visible to the agent-authored-artifact veto
 * exactly like an Edit/Write would be, and so a renamed file appears among
 * the changed files under its new path (FR-034).
 * Unexpandable targets (`$VAR/…`) are kept as-is: they resolve to paths
 * that match nothing, which only fails closed. Targets are NOT resolved
 * here — consumers normalize with their cwd like every other FileWrite.
 * A device stream (`isDeviceStreamPath`: `2>/dev/null`, `tee /dev/stderr`)
 * is not a file and is never a target.
 *
 * Under-minting is the other direction, and it is not closed: only these
 * literal forms are read. A file created by any other command (`ln`,
 * `install`, `rsync`, `tar -x`, `sed -i`, `dd of=`, an interpreter) or by a
 * wrapped head (`sudo cp`, `env cp`, `command mv`) mints nothing. That is the
 * logged-facts-only limit of the veto, I6 and I7 that `machines/README.md`
 * documents: such a write is invisible to all three.
 */
export function extractShellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  for (const raw of splitCommandSegments(command)) {
    const segment = stripComment(raw);
    targets.push(...redirectTargetsOf(segment));
    collectTeeTargets(segment, targets);
    collectMoveCopyTargets(segment, targets);
  }
  return [...new Set(targets)].filter((target) => !isDeviceStreamPath(target));
}
