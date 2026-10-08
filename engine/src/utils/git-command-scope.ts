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
