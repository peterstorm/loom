/**
 * Which `gh` invocations write no local file and run no program (functional
 * core: words in, a verdict out; the `gh` sibling of `read-only-git.ts`).
 * "Read-only" here means what it means for every read-only head the Bash
 * guards admit (`READ_ONLY_STATE_COMMANDS`): nothing on this machine is
 * written or run. Several listed verbs change GitHub (a PR comment, a rerun),
 * which no local guard protects.
 *
 * The state-file guard blocks a segment that names guarded state unless the
 * segment only reads. A PR body or an issue comment that merely mentions a
 * state path is text sent to GitHub, not a local write, so these invocations
 * read as far as the guards are concerned (loom#198, Cause 5). This module
 * says which, and errs toward "no":
 *
 * - the first word is `gh` itself. The caller admits an environment prefix
 *   only of {@link GH_INERT_ENVIRONMENT} names (credentials, host, repository,
 *   colour and prompt switches): the pager, browser, editor and config
 *   variables name programs gh runs or a directory it writes;
 * - the group and verb are listed in {@link READ_ONLY_GH_INVOCATIONS} (`api`
 *   takes no verb). Verbs that write local files (`pr checkout`, `run
 *   download`, `repo clone`) or switch or delete branches (`pr merge`, `pr
 *   close --delete-branch`), `alias` (whose
 *   `!` aliases run a shell) and `extension` (arbitrary executables) are not;
 * - no option before `--` opens a program the environment names: `--web` /
 *   `-w` (a browser) or `--editor` / `-e` (an editor), in any abbreviation or
 *   short-option bundle;
 * - every word before `--` has one static spelling (the caller passes null
 *   for any other).
 */

/** Each group's verbs that write no local file; a group with no verbs (`api`) is invoked bare. */
export const READ_ONLY_GH_INVOCATIONS: ReadonlyMap<string, ReadonlySet<string> | "no-verb"> = new Map<string, ReadonlySet<string> | "no-verb">([
  ["pr", new Set(["view", "checks", "list", "diff", "status", "create", "comment", "edit", "ready", "review"])],
  ["issue", new Set(["view", "list", "status", "create", "comment", "edit", "close", "reopen"])],
  ["run", new Set(["view", "list", "rerun"])],
  ["api", "no-verb"],
]);

/** Environment names a `gh` invocation may be prefixed with: none names a program or a local path. */
export const GH_INERT_ENVIRONMENT: ReadonlySet<string> = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO", "NO_COLOR", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER",
]);

/** The options that make gh run a program the environment names, by long name and short letter. */
const PROGRAM_OPTIONS: Readonly<{ long: readonly string[]; short: readonly string[] }> = { long: ["web", "editor"], short: ["w", "e"] };

/** Does the option word spell, abbreviate or bundle one of {@link PROGRAM_OPTIONS}? */
function runsProgram(word: string): boolean {
  if (word.startsWith("--") && word.length > 2) {
    const name = word.slice(2).split("=")[0] as string;
    return PROGRAM_OPTIONS.long.some((option) => option.startsWith(name));
  }
  return /^-[A-Za-z]/.test(word) && PROGRAM_OPTIONS.short.some((letter) => word.includes(letter));
}

/**
 * Does this simple command, given as each word's one static spelling (null
 * for a word with a runtime part, a glob or several spellings), run `gh` so
 * that it writes no local file and runs no program?
 */
export function isReadOnlyGhInvocation(spellings: readonly (string | null)[]): boolean {
  if (spellings[0] !== "gh") return false;
  const verbs = READ_ONLY_GH_INVOCATIONS.get(spellings[1] ?? "");
  if (verbs === undefined) return false;
  if (verbs !== "no-verb" && !verbs.has(spellings[2] ?? "")) return false;
  const rest = spellings.slice(verbs === "no-verb" ? 2 : 3);
  const end = rest.indexOf("--");
  const options = end === -1 ? rest : rest.slice(0, end);
  return options.every((word) => word !== null && !runsProgram(word));
}
