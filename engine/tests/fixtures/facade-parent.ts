/**
 * The harness that parents the engine, and how a suite names it.
 *
 * Whether an issued reviewer gets the emission route depends only on the
 * parent harness: a Pi parent (`PI_CODING_AGENT=true`, the fixture Pi session
 * of ./pi-session) issues reviewers the emission route; a Claude Code parent
 * keeps them extraction-only. A parent announces itself through environment
 * variables, and `PARENT_ANNOUNCEMENTS` is the ONE table of those rules. Each
 * suite names a parent with `FacadeParent` through one of its adapters:
 *
 * - `facadeParentEnvironment` — the whole environment of a facade CLI child;
 * - `parentAnnouncement` — the in-process overlay (for `withEnvOverlay`, or
 *   as a CLI child's environment overrides);
 * - `stubParentAnnouncement` — the same overlay through `vi.stubEnv`, undone
 *   by `vi.unstubAllEnvs`.
 *
 * A further parent harness, or a further announcement variable, is one entry
 * here.
 */
import { join } from "node:path";
import { vi } from "vitest";
import type { EnvironmentOverlay } from "./env-overlay";
import { fixturePiEnvironment } from "./pi-session";

/** The variables by which a process announces a Pi parent session. */
export const PI_PARENT_VARIABLES = ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"] as const;

/** The variables by which Claude Code announces itself to the main agent's Bash commands. */
export const CLAUDE_CODE_PARENT_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"] as const;

/** The one Claude Code session id fixture facade children run under. */
export const FIXTURE_CLAUDE_CODE_SESSION_ID = "8a510c9a-c1fb-4b89-b61f-08ef6a007c78";

const unset = (variables: readonly string[]): EnvironmentOverlay =>
  Object.fromEntries(variables.map((variable) => [variable, undefined]));

/**
 * Each parent's announcement of `sessionId` (`undefined` announces the harness
 * with no session id), and the silence of every other parent's variables, so
 * an ambient announcement never leaks through.
 */
const PARENT_ANNOUNCEMENTS = Object.freeze({
  "pi": (sessionId: string | undefined): EnvironmentOverlay => Object.freeze({
    ...unset(CLAUDE_CODE_PARENT_VARIABLES), ...unset(PI_PARENT_VARIABLES), PI_CODING_AGENT: "true", PI_SESSION_ID: sessionId,
  }),
  "claude-code": (sessionId: string | undefined): EnvironmentOverlay => Object.freeze({
    ...unset(PI_PARENT_VARIABLES), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: sessionId,
  }),
});

/** The harness that parents the engine. */
export type FacadeParent = keyof typeof PARENT_ANNOUNCEMENTS;

/** The overlay by which `parent` announces session `sessionId` to an in-process engine or a CLI child. */
export function parentAnnouncement(parent: FacadeParent, sessionId: string | undefined): EnvironmentOverlay {
  return PARENT_ANNOUNCEMENTS[parent](sessionId);
}

/** `parentAnnouncement` applied with `vi.stubEnv`; `vi.unstubAllEnvs` restores the environment. */
export function stubParentAnnouncement(parent: FacadeParent, sessionId: string | undefined): void {
  for (const [variable, value] of Object.entries(parentAnnouncement(parent, sessionId))) vi.stubEnv(variable, value);
}

/** `base` with `overlay` applied: an `undefined` entry removes the variable. */
function overlaid(base: NodeJS.ProcessEnv, overlay: EnvironmentOverlay): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const [variable, value] of Object.entries(overlay)) {
    if (value === undefined) delete environment[variable]; else environment[variable] = value;
  }
  return environment;
}

/**
 * The environment of a facade CLI child run from Claude Code's Bash for the
 * disposable `repository`: CLAUDECODE=1 and a Claude session id, and no Pi
 * announcement, so every reviewer it issues is extraction-only. The session
 * binding directory sits under the repository's `.git`: removed with the
 * repository, yet outside every worktree byte a review observes.
 */
export function claudeCodeParentEnvironment(repository: string): NodeJS.ProcessEnv {
  return overlaid(process.env, {
    ...parentAnnouncement("claude-code", FIXTURE_CLAUDE_CODE_SESSION_ID),
    LOOM_SUBAGENT_DIR: join(repository, ".git", "loom-claude-session-bindings"),
    LOOM_STATE_PATH: join(repository, ".claude", "state", "active_task_graph.json"),
  });
}

const PARENT_ENVIRONMENTS = Object.freeze({
  "pi": fixturePiEnvironment,
  "claude-code": claudeCodeParentEnvironment,
} satisfies Readonly<Record<FacadeParent, (repository: string) => NodeJS.ProcessEnv>>);

/** The environment of a facade CLI child `parent` runs for the disposable `repository`. */
export function facadeParentEnvironment(parent: FacadeParent, repository: string): NodeJS.ProcessEnv {
  return PARENT_ENVIRONMENTS[parent](repository);
}
