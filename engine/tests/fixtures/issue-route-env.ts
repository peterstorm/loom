/**
 * Parent-harness environment for the suites.
 *
 * Reviewer issuance no longer reads the parent's model: every catalog profile
 * lowers its Pi binding to the one local route, so what a reviewer is issued
 * depends only on its role, and whether it is issued the emission route
 * depends only on which harness parents the facade CLI (a Pi parent —
 * `PI_CODING_AGENT=true`, see `fixturePiEnvironment` in ./pi-session — emits;
 * a Claude Code parent, `claudeCodeParentEnvironment` below, is
 * extraction-only).
 *
 * What stays ambient-sensitive is spawn-time routing: the parent model
 * `utils/model-routing-context.ts parentModelRefFromEnv` reads from
 * PI_PROVIDER/PI_MODEL (with the PI_REASONING_LEVEL that accompanies them in a
 * Pi handshake), and `fixturePiEnvironment` spreads process.env into every
 * CLI child. The ONE place that ambient parent model is cleared is the Vitest
 * setup file (`tests/setup/scrub-parent-model.ts`, registered in
 * `vitest.config.ts`), before every test file — so a wrapper Pi session
 * running the suite never leaks its own model into a test. A suite that wants
 * a parent model sets it explicitly with `withEnvOverlay`.
 *
 * `withEnvOverlay` is the suites' ONE process-environment overlay scope (the
 * parent model, run-directory roots, the Pi agent marker, any other
 * variable): one apply/restore-in-finally implementation, so no suite keeps
 * its own.
 *
 * Dependency-free on purpose: the setup file imports it before every test
 * file, so it must load no engine module a suite might later `vi.mock`.
 */
import { join } from "node:path";

/** A process-environment overlay: `undefined` unsets the variable for the operation. */
export type EnvironmentOverlay = Readonly<Record<string, string | undefined>>;

/** No parent model: every variable a Pi handshake names its model by, unset. */
export const NO_PARENT_MODEL_ENV: EnvironmentOverlay = Object.freeze({
  PI_PROVIDER: undefined, PI_MODEL: undefined, PI_REASONING_LEVEL: undefined,
});

/** The variables by which a process announces a Pi parent session. */
const PI_PARENT_VARIABLES = ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"] as const;

/** The one Claude Code session id fixture facade children run under. */
export const FIXTURE_CLAUDE_CODE_SESSION_ID = "8a510c9a-c1fb-4b89-b61f-08ef6a007c78";

function applyOverlay(overlay: EnvironmentOverlay): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Clear the worker's ambient parent model — the setup file's one call,
 *  before any suite body runs. */
export function scrubAmbientParentModel(): void {
  applyOverlay(NO_PARENT_MODEL_ENV);
}

/**
 * The environment of a facade CLI child run from Claude Code's Bash for the
 * disposable `repository`: CLAUDECODE=1 and a Claude session id, and no Pi
 * announcement, so every reviewer it issues is extraction-only. The session
 * binding directory sits under the repository's `.git`: removed with the
 * repository, yet outside every worktree byte a review observes.
 */
export function claudeCodeParentEnvironment(repository: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: FIXTURE_CLAUDE_CODE_SESSION_ID,
    LOOM_SUBAGENT_DIR: join(repository, ".git", "loom-claude-session-bindings"),
    LOOM_STATE_PATH: join(repository, ".claude", "state", "active_task_graph.json"),
  };
  for (const key of PI_PARENT_VARIABLES) delete environment[key];
  return environment;
}

/** Run `operation` under any process-environment `overlay`, restoring every
 *  touched variable afterwards — a variable that was unset before is deleted
 *  again. */
export async function withEnvOverlay<T>(overlay: EnvironmentOverlay, operation: () => T | Promise<T>): Promise<T> {
  const previous: EnvironmentOverlay = Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]]));
  try {
    applyOverlay(overlay);
    return await operation();
  } finally {
    applyOverlay(previous);
  }
}
