/**
 * Is THIS Pi process a subagent? Pi has no per-call caller marker on
 * `tool_call`: a subagent runs as its own `pi` process, so the caller of a tool
 * call is the process the extension is loaded in. The answer is an explicit
 * ENVIRONMENT MARKER, never an inference from launch flags (a headless parent
 * `pi --mode json -p --no-session` is a parent):
 *
 *  - `LOOM_PI_PARENT_PID` (+ `LOOM_PI_PARENT_SESSION`): the parent extension
 *    publishes its own pid into its process environment at load
 *    (`markPiParentEnvironment`). Every process it spawns inherits it — the
 *    installed json-mode subagent launcher copies `process.env` into each
 *    child — so a process whose marker names ANOTHER pid was launched from a
 *    Loom Pi session. The parent reading its own marker sees its own pid.
 *  - `LOOM_PI_SUBAGENT=1`: set explicitly by every spawn path Loom owns
 *    (`interactive-subagent.ts`'s `--mode rpc` child), so that child is a
 *    subagent whatever the inherited environment holds.
 *
 * The raw environment is parsed ONCE, here, into a `PiProcessMarker`; a value
 * that is set but cannot be a Loom marker (a non-numeric pid, a session with no
 * pid, a subagent flag other than `1`) is the explicit `malformed` case, never
 * silently read as one role or the other.
 *
 * Two policies read the marker, deliberately distinct because their safe
 * directions are opposite:
 *
 *  - AUTHORITY (`piProcessRole`, ADR-0067 D6): any marked process — explicit,
 *    inherited or malformed — is a subagent, because refusing authority writes
 *    is the safe direction. That includes a nested `pi` the parent's own bash
 *    tool launched; a subagent may not launch one at all (the authority fence
 *    refuses nested harnesses).
 *  - RULES GATE (`piRulesGateExemption`): exemption is the UNSAFE direction, so
 *    only a process that is provably a child agent is exempt — the explicit
 *    `LOOM_PI_SUBAGENT=1` marker, or a headless launch (`json`/`rpc`/`print`)
 *    carrying a parent marker that names another pid. An interactive (`tui`)
 *    process that merely inherited a parent marker, or any malformed marker,
 *    stays gated; `interactiveSubagentNotice` tells its operator so.
 *
 * A subagent never re-marks its environment as a parent, so its own children
 * (and anything its tools launch) stay subagents.
 *
 * The one dependency outside this repository: a child started by the
 * installed launcher is a subagent only because that launcher copies the
 * parent's environment (ADR-0067 G). A launcher that scrubs or replaces it
 * yields an unmarked process, which is a parent — the authority gate is inert
 * in it. Launch flags cannot decide the role, but they can raise the alarm:
 * `unmarkedSubagentLaunchNotice` names a process that STARTED like a headless
 * child (`--mode json|rpc`, `--no-session`) yet carries no marker, and the
 * extension writes it to stderr once, at load.
 */

/** Set explicitly in the environment of every child agent Loom spawns. */
export const PI_SUBAGENT_ENV = "LOOM_PI_SUBAGENT";
/** The pid of the Loom Pi session process that launched this one. */
export const PI_PARENT_PID_ENV = "LOOM_PI_PARENT_PID";
/** The session id of that process, when it had one. */
export const PI_PARENT_SESSION_ENV = "LOOM_PI_PARENT_SESSION";

type Environment = Readonly<Record<string, string | undefined>>;

/** A pid parsed from the marker: a positive safe integer. */
export type PiPid = number & { readonly __brand: "PiPid" };

/**
 * The Loom marker this process's environment carries, parsed once:
 *  - `unmarked` — none of the marker variables is set;
 *  - `child` — the explicit `LOOM_PI_SUBAGENT=1`;
 *  - `inherited` — a well-formed `LOOM_PI_PARENT_PID` (its own pid, or the
 *    launching session's);
 *  - `malformed` — a marker variable is set but names no valid marker.
 */
export type PiProcessMarker =
  | Readonly<{ kind: "unmarked" }>
  | Readonly<{ kind: "child"; parentSession: string | null }>
  | Readonly<{ kind: "inherited"; parentPid: PiPid; parentSession: string | null }>
  | Readonly<{ kind: "malformed"; reason: string; parentSession: string | null }>;

const PID_PATTERN = /^[1-9][0-9]*$/;

const parsePid = (raw: string): PiPid | null => {
  const pid = Number(raw);
  return PID_PATTERN.test(raw) && Number.isSafeInteger(pid) ? (pid as PiPid) : null;
};

/** Parse the marker variables of `env`. An empty variable counts as unset. Pure. */
export function parsePiProcessMarker(env: Environment): PiProcessMarker {
  const subagent = env[PI_SUBAGENT_ENV] ?? "";
  const parentPid = env[PI_PARENT_PID_ENV] ?? "";
  const session = env[PI_PARENT_SESSION_ENV] ?? "";
  const parentSession = session === "" ? null : session;
  if (subagent === "1") return Object.freeze({ kind: "child", parentSession });
  if (subagent !== "") {
    return Object.freeze({ kind: "malformed", reason: `${PI_SUBAGENT_ENV}=${JSON.stringify(subagent)} is not "1"`, parentSession });
  }
  if (parentPid !== "") {
    const pid = parsePid(parentPid);
    return pid === null
      ? Object.freeze({ kind: "malformed", reason: `${PI_PARENT_PID_ENV}=${JSON.stringify(parentPid)} is not a pid`, parentSession })
      : Object.freeze({ kind: "inherited", parentPid: pid, parentSession });
  }
  return parentSession === null
    ? Object.freeze({ kind: "unmarked" })
    : Object.freeze({ kind: "malformed", reason: `${PI_PARENT_SESSION_ENV} is set without ${PI_PARENT_PID_ENV}`, parentSession });
}

/** This process's marker, parsed from its environment at the moment of asking. */
export const currentPiProcessMarker = (): PiProcessMarker => parsePiProcessMarker(process.env);

export type PiProcessRole =
  | Readonly<{ kind: "parent" }>
  | Readonly<{ kind: "subagent"; parentSession: string | null }>;

/** The AUTHORITY role of a process with `marker` and `pid`: every marked
 *  process but the parent reading its own pid is a subagent — malformed
 *  included, because refusing authority is the safe direction. Pure. */
export function piProcessRole(marker: PiProcessMarker, pid: number): PiProcessRole {
  switch (marker.kind) {
    case "unmarked":
      return { kind: "parent" };
    case "inherited":
      return marker.parentPid === pid ? { kind: "parent" } : { kind: "subagent", parentSession: marker.parentSession };
    case "child":
    case "malformed":
      return { kind: "subagent", parentSession: marker.parentSession };
    default: {
      const unreachable: never = marker;
      return unreachable;
    }
  }
}

/** This process's authority role, as the authority gates read it. */
export const currentPiProcessRole = (): PiProcessRole => piProcessRole(currentPiProcessMarker(), process.pid);

export const isPiSubagent = (role: PiProcessRole): boolean => role.kind === "subagent";

/** A Pi extension mode with no human at the keyboard. */
const isHeadlessMode = (mode: string): boolean => mode !== "tui";

/**
 * Whether the RULES GATE exempts a process: only a provable child agent — the
 * explicit marker, or a headless launch whose inherited marker names another
 * pid. An interactive process that inherited a parent marker, and every
 * malformed marker, is gated: exemption is the unsafe direction here. Pure.
 */
export function piRulesGateExemption(marker: PiProcessMarker, pid: number, mode: string): "exempt" | "gated" {
  if (marker.kind === "child") return "exempt";
  return marker.kind === "inherited" && marker.parentPid !== pid && isHeadlessMode(mode) ? "exempt" : "gated";
}

/** Why a marker makes its process a subagent, in the operator's words. */
function subagentMarkerExplanation(marker: PiProcessMarker): string {
  switch (marker.kind) {
    case "child":
      return `it carries ${PI_SUBAGENT_ENV}=1`;
    case "malformed":
      return `its Loom marker is malformed (${marker.reason})`;
    case "inherited":
      return `it inherited ${PI_PARENT_PID_ENV} naming another Pi process (likely started from a Loom Pi session's shell)`;
    case "unmarked":
      return "it carries no Loom marker";
    default: {
      const unreachable: never = marker;
      return unreachable;
    }
  }
}

/**
 * The operator notice for an INTERACTIVE process the authority gate treats as
 * a subagent, or null: a human is driving it, yet authority writes are refused
 * — usually a `pi` started from inside a Loom Pi session's shell. It names
 * which policy applies to it. Pure.
 */
export function interactiveSubagentNotice(marker: PiProcessMarker, pid: number, mode: string): string | null {
  if (isHeadlessMode(mode) || !isPiSubagent(piProcessRole(marker, pid))) return null;
  const why = subagentMarkerExplanation(marker);
  const rulesGate = piRulesGateExemption(marker, pid, mode) === "exempt"
    ? "the rules gate exempts it as a child agent"
    : "the rules gate still applies";
  return `this interactive Pi process is treated as a SUBAGENT because ${why}: the subagent authority gate (ADR-0067 D6) refuses audit/orchestration authority changes, and ${rulesGate}.`;
}

/**
 * The environment entries a PARENT publishes so every process it launches
 * inherits the marker: its pid and session. A subagent publishes nothing (its
 * inherited marker already names its launcher). Pure: the caller applies them.
 */
export function parentMarkerEntries(marker: PiProcessMarker, pid: number, sessionId: string | null): Readonly<Record<string, string>> {
  if (isPiSubagent(piProcessRole(marker, pid))) return {};
  return { [PI_PARENT_PID_ENV]: String(pid), ...(sessionId === null ? {} : { [PI_PARENT_SESSION_ENV]: sessionId }) };
}

/** Publish the parent marker into this process's environment (idempotent). */
export function markPiParentEnvironment(sessionId: string | null): void {
  Object.assign(process.env, parentMarkerEntries(currentPiProcessMarker(), process.pid, sessionId));
}

/** The environment a child agent Loom spawns runs with: the inherited one plus
 *  the explicit subagent marker (`LOOM_PI_SUBAGENT=1`); the launching session,
 *  if any, rides on the inherited `LOOM_PI_PARENT_*` entries. Pure. */
export function childAgentEnvironment(env: Environment): Readonly<Record<string, string | undefined>> {
  return { ...env, [PI_SUBAGENT_ENV]: "1" };
}

/** The launch flags a headless child agent starts with, as they appear on
 *  `argv` (`--mode json`, `--mode=rpc`, `--no-session`). */
function subagentLaunchFlags(argv: readonly string[]): readonly string[] {
  return argv.flatMap((arg, index) => {
    if (arg === "--no-session") return [arg];
    const mode = arg === "--mode" ? argv[index + 1] : arg.startsWith("--mode=") ? arg.slice("--mode=".length) : undefined;
    return mode === "json" || mode === "rpc" ? [`--mode ${mode}`] : [];
  });
}

/**
 * The operator notice for a process that was launched like a headless child
 * agent but carries no Loom marker at all, or null. Such a process is a PARENT
 * by the marker rule — correctly so for a headless parent — but if a launcher
 * started it as a subagent without copying the parent's environment, the
 * subagent authority gate is silently inert in it. Pure.
 *
 * Read BEFORE this process marks itself: once `markPiParentEnvironment` has
 * run, the process carries its own marker, so a later factory load in the
 * same process stays quiet — the notice is once per process by construction.
 */
export function unmarkedSubagentLaunchNotice(marker: PiProcessMarker, argv: readonly string[]): string | null {
  const flags = subagentLaunchFlags(argv);
  if (marker.kind !== "unmarked" || flags.length === 0) return null;
  return [
    `this process was launched like a headless subagent (${flags.join(", ")}) but carries no ${PI_SUBAGENT_ENV}/${PI_PARENT_PID_ENV} marker,`,
    "so Loom treats it as a PARENT: the subagent authority gate (ADR-0067 D6) is inert and the rules gate applies.",
    "If a launcher started it as a subagent, that launcher did not copy the parent's environment (ADR-0067 G).",
  ].join(" ");
}
