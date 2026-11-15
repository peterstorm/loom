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
 * - the subcommand is a key of {@link READ_ONLY_GIT_SUBCOMMANDS}; checkout,
 *   clean, stash, config, branch and every other subcommand with a writing
 *   mode are not;
 * - no argument is one of that subcommand's {@link RiskyOptions}. A long
 *   option is matched by every abbreviation git accepts (`--outp=…` is
 *   `--output`), bare or with `=value`; a short one anywhere in a bundle;
 * - every word before `--` has one static spelling (the caller passes null for
 *   any other), so the shell cannot complete one into an option at runtime.
 *   After `--` every word is a pathspec.
 *
 * The risky options were audited against git 2.56 with
 * `git <subcommand> --git-completion-helper-all`, which lists hidden options
 * too (`ls-remote --exec`, a hidden synonym of `--upload-pack`, is absent from
 * `-h`). Repeat that audit before adding a subcommand. What a repository's own
 * configuration or hooks run (textconv drivers, diff.external, fsmonitor) is
 * out of reach here, as it is for a plain `git status` in the same directory.
 */

/** The options of one subcommand that run a command or write a file outside `.git`. */
export type RiskyOptions = Readonly<{
  /** Long option names, matched in every abbreviation, bare or with `=value`. */
  long: readonly string[];
  /** Short option letters, matched anywhere in a bundle (`-inO`). */
  short: readonly string[];
}>;

/**
 * Diff options every revision-walking subcommand parses: `--output=<file>`
 * writes a file and `--ext-diff` runs the external diff. Refused under every
 * subcommand, whether or not it parses them.
 */
const DIFF_WRITERS: readonly string[] = ["output", "ext-diff"];

const risky = (long: readonly string[] = [], short: readonly string[] = []): RiskyOptions =>
  ({ long: [...DIFF_WRITERS, ...long], short });

/**
 * Each subcommand that writes nothing outside `.git` — at most the index's
 * cached stat data, or for `fetch` the repository's objects and refs — with
 * its risky options:
 *
 * - grep's `--open-files-in-pager`/`-O[<pager>]` runs a pager (diff's `-O<file>`
 *   only reads an order file);
 * - `--upload-pack` names the command a remote runs, which for a local path is
 *   this machine; ls-remote also takes it as the hidden `--exec`, and older git
 *   as `-u <exec>`. fetch's `-u` is `--update-head-ok`, which moves only a ref.
 */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlyMap<string, RiskyOptions> = new Map([
  ...["status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame", "describe",
    "shortlog", "rev-list", "merge-base", "for-each-ref", "show-ref", "name-rev", "version"]
    .map((subcommand): [string, RiskyOptions] => [subcommand, risky()]),
  ["grep", risky(["open-files-in-pager"], ["O"])],
  ["ls-remote", risky(["upload-pack", "exec"], ["u"])],
  ["fetch", risky(["upload-pack"])],
]);

/** Global options that take no value and change nothing git writes. */
const SAFE_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/** Does `--name[=value]` spell, or abbreviate, one of `options`? */
function namesLongOption(word: string, options: readonly string[]): boolean {
  if (!word.startsWith("--")) return false;
  const name = word.slice(2).split("=")[0];
  return options.some((option) => option.startsWith(name));
}

/** Does a bundle of short options (`-inO`) hold one of `letters`? */
const bundles = (word: string, letters: readonly string[]): boolean =>
  /^-[A-Za-z]/.test(word) && letters.some((letter) => word.includes(letter));

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
      if ((spellings[index] ?? null) === null) return false;
      continue;
    }
    if (word === null || !word.startsWith("-")) break;
    if (!SAFE_GLOBAL_FLAGS.has(word)) return false;
  }
  const options = READ_ONLY_GIT_SUBCOMMANDS.get(spellings[index] ?? "");
  if (options === undefined) return false;
  const rest = spellings.slice(index + 1);
  const pathspecs = rest.indexOf("--");
  const before = pathspecs === -1 ? rest : rest.slice(0, pathspecs);
  return before.every((word) => word !== null && !namesLongOption(word, options.long) && !bundles(word, options.short));
}
