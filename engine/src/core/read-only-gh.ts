/**
 * Which `gh` invocations write no local file and run no program (functional
 * core: words in, a verdict out; the `gh` sibling of `read-only-git.ts`).
 *
 * The state-file guard blocks a segment that names guarded state unless the
 * segment only reads. A PR body or an issue comment that merely mentions a
 * state path is text sent to GitHub, not a local write, so these invocations
 * read as far as the guard is concerned (loom#198, Cause 5). This module says
 * which, and errs toward "no":
 *
 * - the first word is `gh` itself (the caller refuses an environment prefix:
 *   the pager, browser and editor variables name programs gh runs);
 * - `gh <group> <verb>` is listed in {@link READ_ONLY_GH_INVOCATIONS}, or the
 *   group is `api`. Verbs that write local files (`pr checkout`, `run
 *   download`, `repo clone`) or switch branches (`pr merge`), `alias` (whose
 *   `!` aliases run a shell) and `extension` (arbitrary executables) are not;
 * - no word before `--` is `--web` or bundles `-w`: that opens a browser, a
 *   program named by the environment;
 * - every word before `--` has one static spelling (the caller passes null
 *   for any other).
 */

/** `gh <group> <verb>` pairs that write no local file. `api` is listed alone: it has no verb. */
export const READ_ONLY_GH_INVOCATIONS: ReadonlySet<string> = new Set([
  "pr view", "pr checks", "pr list", "pr diff", "pr status", "pr create", "pr comment", "pr edit",
  "issue view", "issue list", "issue status", "issue create", "issue comment", "issue edit",
  "run view", "run list", "run rerun",
  "api",
]);

/** Does `--name[=value]` spell, or abbreviate, `web` (the flag parser accepts no abbreviation, but err toward "no")? */
const opensBrowser = (word: string): boolean =>
  (word.startsWith("--") && "web".startsWith(word.slice(2).split("=")[0] as string) && word.length > 2) ||
  (/^-[A-Za-z]/.test(word) && word.includes("w"));

/**
 * Does this simple command, given as each word's one static spelling (null
 * for a word with a runtime part, a glob or several spellings), run `gh` so
 * that it writes no local file and runs no program?
 */
export function isReadOnlyGhInvocation(spellings: readonly (string | null)[]): boolean {
  if (spellings[0] !== "gh") return false;
  const group = spellings[1] ?? null;
  const invocation = group === "api" ? "api" : `${group ?? ""} ${spellings[2] ?? ""}`;
  if (group === null || !READ_ONLY_GH_INVOCATIONS.has(invocation)) return false;
  const rest = spellings.slice(group === "api" ? 2 : 3);
  const end = rest.indexOf("--");
  const options = end === -1 ? rest : rest.slice(0, end);
  return options.every((word) => word !== null && !opensBrowser(word));
}
