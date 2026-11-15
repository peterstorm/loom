/**
 * Which `git` invocations write nothing outside the repository's own `.git`
 * (functional core: words in, a verdict out).
 *
 * The subagent authority guard judges a segment that names a path at or above
 * a protected directory as a write unless the segment only reads. `git -C
 * <checkout> fetch` names the checkout that holds Loom's protected `machines/`
 * and writes only the repository's objects and refs, so it reads as far as
 * the guard is concerned. This module says which invocations are of that
 * kind, and errs toward "no":
 *
 * - the first word is `git` itself — no environment prefix (`GIT_DIR=…`,
 *   `GIT_CONFIG_PARAMETERS=…`), no wrapper;
 * - its global options are only `-C <dir>`, `--no-pager`, `-P`,
 *   `--no-optional-locks` and `--literal-pathspecs` — never `-c` (a config
 *   value such as core.fsmonitor or core.sshCommand runs a command),
 *   `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`;
 * - the subcommand is one that reads ({@link READ_ONLY_GIT_SUBCOMMANDS}), or
 *   `fetch`, which writes only objects and refs; checkout, clean, stash,
 *   config, branch and every other subcommand with a writing mode are not;
 * - no argument writes a file or runs a command: `--output` (log, show, diff),
 *   `-O`/`--open-files-in-pager` (grep), `--ext-diff`, and for `fetch` and
 *   `ls-remote` `-u`/`--upload-pack`. A long option is matched by every
 *   abbreviation git accepts (`--outp=…` is `--output`);
 * - every word before `--` has one static spelling (the caller passes null for
 *   any other), so the shell cannot complete one into an option at runtime.
 *   After `--` every word is a pathspec.
 *
 * What a repository's own configuration or hooks run is out of reach here, as
 * it is for a plain `git status` in the same directory.
 */

/** Subcommands that write nothing but, at most, the index's cached stat data. */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "ls-remote", "cat-file", "blame",
  "describe", "shortlog", "rev-list", "merge-base", "for-each-ref", "show-ref", "name-rev", "grep", "version",
]);

/** The subcommand that writes only the repository's objects and refs. */
const FETCH = "fetch";

/** Global options that take no value and change nothing git writes. */
const SAFE_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/** Long options that write a file or run a command, in any subcommand. */
const WRITING_LONG_OPTIONS: readonly string[] = ["output", "open-files-in-pager", "ext-diff"];

/** Long options that run a command, for the subcommands that talk to a remote. */
const REMOTE_COMMAND_LONG_OPTIONS: readonly string[] = ["upload-pack"];

const REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set([FETCH, "ls-remote"]);

/** Does `--name[=value]` spell, or abbreviate, one of `options`? */
function namesLongOption(word: string, options: readonly string[]): boolean {
  if (!word.startsWith("--") || word === "--") return false;
  const name = word.slice(2).split("=")[0];
  return options.some((option) => option.startsWith(name));
}

/** Does a bundle of short options (`-inO`) hold `letter`? */
const bundles = (word: string, letter: string): boolean => /^-[A-Za-z]/.test(word) && !word.startsWith("--") && word.includes(letter);

function writesOrRuns(subcommand: string, word: string): boolean {
  if (namesLongOption(word, WRITING_LONG_OPTIONS) || (subcommand === "grep" && bundles(word, "O"))) return true;
  if (!REMOTE_SUBCOMMANDS.has(subcommand)) return false;
  return namesLongOption(word, REMOTE_COMMAND_LONG_OPTIONS) || bundles(word, "u");
}

/**
 * Does this simple command, given as each word's one static spelling (null
 * for a word with a runtime part, a glob or several spellings), run git so
 * that it writes nothing outside the repository's own `.git`?
 */
export function isReadOnlyGitInvocation(spellings: readonly (string | null)[]): boolean {
  if (spellings[0] !== "git") return false;
  let index = 1;
  for (; index < spellings.length; index++) {
    const word = spellings[index];
    if (word === "-C") {
      index++;
      if (spellings[index] === null || spellings[index] === undefined) return false;
      continue;
    }
    if (word === null || !word.startsWith("-")) break;
    if (!SAFE_GLOBAL_FLAGS.has(word)) return false;
  }
  const subcommand = spellings[index];
  if (subcommand === null || subcommand === undefined) return false;
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) && subcommand !== FETCH) return false;
  const rest = spellings.slice(index + 1);
  const pathspecs = rest.indexOf("--");
  const options = pathspecs === -1 ? rest : rest.slice(0, pathspecs);
  return options.every((word) => word !== null && !writesOrRuns(subcommand, word));
}
