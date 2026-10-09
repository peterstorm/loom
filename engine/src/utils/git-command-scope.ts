/**
 * The command-scope config every policy-bound Git child runs under, as one
 * table and its `-c` argv form. A leaf with no imports: `git-execution-policy`
 * builds both of its forms (argv prefix and GIT_CONFIG_COUNT/KEY/VALUE
 * environment) from it, and test fixtures that script `node:child_process`
 * read the argv prefix from here — a module that imported the child-process
 * module could not be loaded from inside that module's own mock factory.
 */

/** Config forced at command scope on every policy-bound Git child. */
export const COMMAND_SCOPE_CONFIG: readonly (readonly [key: string, value: string])[] = Object.freeze([
  Object.freeze(["core.fsmonitor", "false"] as const),
]);

/** The `-c key=value` argv prefix that opens every policy-bound Git invocation. */
export const COMMAND_SCOPE_ARGV: readonly string[] = Object.freeze(
  COMMAND_SCOPE_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
);

/**
 * The argv a policy-bound Git child receives for the logical command `args`:
 * the command-scope prefix, then `args` unchanged. The one composition of the
 * prefix — the execution policy spawns with it, and a test double that stands
 * in for the `git` executable reads the prefix length from it rather than
 * hard-coding argv positions.
 */
export function policyBoundGitArgv(args: readonly string[]): readonly string[] {
  return Object.freeze([...COMMAND_SCOPE_ARGV, ...args]);
}
