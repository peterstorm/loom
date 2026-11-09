/**
 * Is THIS Pi process a subagent? Pi has no per-call caller marker on
 * `tool_call`: a subagent runs as its own `pi` process, so the caller of a tool
 * call is the process the extension is loaded in. The answer is an explicit
 * ENVIRONMENT MARKER every child agent carries, never an inference from launch
 * flags (a headless parent `pi --mode json -p --no-session` is a parent):
 *
 *  - `LOOM_PI_PARENT_PID` (+ `LOOM_PI_PARENT_SESSION`): the parent extension
 *    publishes its own pid into its process environment at load
 *    (`markPiParentEnvironment`). Every process it spawns inherits it — the
 *    installed json-mode subagent launcher copies `process.env` into each
 *    child — so a process whose marker names ANOTHER pid was launched from a
 *    Loom Pi session: a subagent. The parent reading its own marker sees its
 *    own pid: a parent.
 *  - `LOOM_PI_SUBAGENT=1`: set explicitly by every spawn path Loom owns
 *    (`interactive-subagent.ts`'s `--mode rpc` child), so that child is a
 *    subagent whatever the inherited environment holds.
 *
 * A subagent never re-marks its environment as a parent, so its own children
 * (and anything its tools launch) stay subagents. A process launched by the
 * parent's own bash tool (a nested `pi`) is also marked — the safe direction;
 * a subagent may not launch one at all (the authority fence refuses nested
 * harnesses).
 */

/** Set explicitly in the environment of every child agent Loom spawns. */
export const PI_SUBAGENT_ENV = "LOOM_PI_SUBAGENT";
/** The pid of the Loom Pi session process that launched this one. */
export const PI_PARENT_PID_ENV = "LOOM_PI_PARENT_PID";
/** The session id of that process, when it had one. */
export const PI_PARENT_SESSION_ENV = "LOOM_PI_PARENT_SESSION";

type Environment = Readonly<Record<string, string | undefined>>;

export type PiProcessRole =
  | Readonly<{ kind: "parent" }>
  | Readonly<{ kind: "subagent"; parentSession: string | null }>;

/** This process's role, read from its environment and pid. Pure. */
export function piProcessRole(env: Environment, pid: number): PiProcessRole {
  const parentSession = env[PI_PARENT_SESSION_ENV] ?? null;
  if (env[PI_SUBAGENT_ENV] === "1") return { kind: "subagent", parentSession };
  const parentPid = env[PI_PARENT_PID_ENV];
  return parentPid !== undefined && parentPid !== "" && parentPid !== String(pid)
    ? { kind: "subagent", parentSession }
    : { kind: "parent" };
}

/** This process's role, as the gates read it. */
export const currentPiProcessRole = (): PiProcessRole => piProcessRole(process.env, process.pid);

export const isPiSubagent = (role: PiProcessRole): boolean => role.kind === "subagent";

/**
 * The environment entries a PARENT publishes so every process it launches
 * inherits the marker: its pid and session. A subagent publishes nothing (its
 * inherited marker already names its launcher). Pure: the caller applies them.
 */
export function parentMarkerEntries(env: Environment, pid: number, sessionId: string | null): Readonly<Record<string, string>> {
  if (piProcessRole(env, pid).kind === "subagent") return {};
  return { [PI_PARENT_PID_ENV]: String(pid), ...(sessionId === null ? {} : { [PI_PARENT_SESSION_ENV]: sessionId }) };
}

/** Publish the parent marker into this process's environment (idempotent). */
export function markPiParentEnvironment(sessionId: string | null): void {
  Object.assign(process.env, parentMarkerEntries(process.env, process.pid, sessionId));
}

/** The environment a child agent Loom spawns runs with: the inherited one plus
 *  the explicit subagent marker and the launching session. Pure. */
export function childAgentEnvironment(env: Environment, sessionId: string | null): Readonly<Record<string, string | undefined>> {
  const parentSession = env[PI_PARENT_SESSION_ENV] ?? sessionId;
  return {
    ...env,
    [PI_SUBAGENT_ENV]: "1",
    ...(parentSession === null ? {} : { [PI_PARENT_SESSION_ENV]: parentSession }),
  };
}
