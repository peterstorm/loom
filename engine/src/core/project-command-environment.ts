/**
 * Project Command Environment: the environment a project command runs under.
 *
 * A harness sets these variables for one hook invocation, naming that
 * invocation's project and plugin. They are not the project's environment: the
 * Wave Gate runs a project command from the operator's shell, where none is
 * set, while a stop check runs the same kind of command from inside a hook.
 * Passed on, they retarget the project's own tests (a test that resolves its
 * repository from `CLAUDE_PROJECT_DIR` lints the real checkout instead of its
 * fixture), so a stop check would fail tests the Wave Gate passes.
 */
export const HOOK_INVOCATION_VARIABLES = [
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE",
] as const;

export type HookInvocationVariable = (typeof HOOK_INVOCATION_VARIABLES)[number];

const HOOK_INVOCATION_NAMES: ReadonlySet<string> = new Set<string>(HOOK_INVOCATION_VARIABLES);

/** The caller's environment without the hook-invocation variables, so a project
 *  command sees the same environment whichever surface launches it. */
export function projectCommandEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !HOOK_INVOCATION_NAMES.has(name)));
}
