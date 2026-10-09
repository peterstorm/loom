/**
 * The harness that parents a facade CLI child, and the environment that child
 * runs under.
 *
 * Whether an issued reviewer gets the emission route depends only on the
 * parent harness: a Pi parent (`PI_CODING_AGENT=true`, the fixture Pi session
 * of ./pi-session) issues reviewers the emission route; a Claude Code parent
 * keeps them extraction-only. Suites name the parent with `FacadeParent` and
 * resolve its environment with `facadeParentEnvironment`, so a further parent
 * harness is one entry here.
 */
import { join } from "node:path";
import { fixturePiEnvironment } from "./pi-session";

/** The variables by which a process announces a Pi parent session. */
export const PI_PARENT_VARIABLES = ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"] as const;

/** The one Claude Code session id fixture facade children run under. */
export const FIXTURE_CLAUDE_CODE_SESSION_ID = "8a510c9a-c1fb-4b89-b61f-08ef6a007c78";

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

const PARENT_ENVIRONMENTS = Object.freeze({
  "pi": fixturePiEnvironment,
  "claude-code": claudeCodeParentEnvironment,
} satisfies Readonly<Record<string, (repository: string) => NodeJS.ProcessEnv>>);

/** The harness that parents the facade CLI child. */
export type FacadeParent = keyof typeof PARENT_ENVIRONMENTS;

/** The environment of a facade CLI child `parent` runs for the disposable `repository`. */
export function facadeParentEnvironment(parent: FacadeParent, repository: string): NodeJS.ProcessEnv {
  return PARENT_ENVIRONMENTS[parent](repository);
}
