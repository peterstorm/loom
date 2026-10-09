/**
 * The façade's emission gate (functional core: no I/O): whether an action the
 * façade is about to emit is gated on its Pi routes, and the verdict.
 *
 * ADR-0023 decision 3: before a Pi parent emits a spawn batch, every distinct
 * route its children launch on must answer, and no request may carry a
 * retired route. This module is the one entry point from (the action's
 * requests, the emission environment, the route observations) to a verdict,
 * with the stderr events the shell prints carried as data. Route observation
 * is I/O, and which routes to observe is only known once the requests are
 * planned, so the entry returns either a verdict or the routes to observe
 * together with the pure continuation that decides once they are observed.
 * Every refusal it can make before a probe is made before any probe.
 */
import { match } from "ts-pattern";
import type { EffectivePiBinding } from "./model-routing";
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract";
import {
  decideSpawnGate,
  planSpawnRoutes,
  type RouteGateMode,
  type RouteReachability,
  type SpawnRouting,
  type UnverifiedRoute,
} from "./route-reachability";

/**
 * What a Pi parent's gate reads, resolved once at the composition root: Pi's
 * agent directory (where `models.json` declares each provider's endpoint),
 * the operator's gate mode and the routing context, each as parsed — a value
 * that did not parse is kept as its error, so it refuses a gated batch and
 * nothing else.
 */
export type PiRouteGateFacts = Readonly<{
  agentDir: string;
  mode: Readonly<{ ok: true; value: RouteGateMode }> | Readonly<{ ok: false; error: string }>;
  routing: Readonly<{ ok: true; value: SpawnRouting }> | Readonly<{ ok: false; error: string }>;
}>;

/**
 * The harness parenting this façade invocation, as its environment announces
 * it, and the session it publishes capture authority into (`null` when the
 * harness announced none). Only a Pi parent carries route-gate facts, so a
 * gated Claude Code parent is unrepresentable.
 *
 * A Pi parent is exactly `PI_CODING_AGENT=true`: Pi's own entry points
 * (`dist/cli.js`, `dist/rpc-entry.js` of pi-coding-agent) assign it before
 * anything else runs, so every command a Pi session launches inherits it.
 * A Pi spawn batch therefore always reaches emission as a Pi parent — gated —
 * whether or not a session id came with it; one with no session id is gated
 * first and then refused by session publication. Only a process that strips
 * the variable stops announcing Pi, and that process is not a Pi parent to
 * any Loom seam (session binding, emission route, runtime handshake) either.
 */
export type EmissionParent =
  | Readonly<{ harness: "pi"; sessionId: string | null; routeGate: PiRouteGateFacts }>
  | Readonly<{ harness: "claude-code"; sessionId: string | null }>
  | Readonly<{ harness: "unannounced" }>;

/** The immutable environment one façade invocation emits under. */
export type EmissionEnvironment = Readonly<{
  /** The session run binding directory (`LOOM_SUBAGENT_DIR`). */
  bindingDir: string;
  parent: EmissionParent;
}>;

/** The parent harness a process announces, read from its environment variables (Pi first: a Pi process launched from Claude Code is Pi). */
export function announcedParentHarness(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ harness: "pi" | "claude-code"; sessionId: string | null }> | null {
  if (env.PI_CODING_AGENT === "true") return Object.freeze({ harness: "pi", sessionId: env.PI_SESSION_ID ?? null });
  if (env.CLAUDECODE === "1") return Object.freeze({ harness: "claude-code", sessionId: env.CLAUDE_CODE_SESSION_ID ?? null });
  return null;
}

/** What the façade is about to emit, as far as the gate is concerned: a spawn batch's raw request authorities, or anything else. */
export type GatedAction =
  | Readonly<{ kind: "spawn-batch"; authorities: readonly unknown[] }>
  | Readonly<{ kind: "other" }>;

/** One stderr event the shell prints for an admitted action. */
export type EmissionEvent = Readonly<{ event: "loom-route-unverified" } & UnverifiedRoute>;

/** The gate's verdict: emit (reporting the unverified routes and their events), or refuse with the operator's message. */
export type EmissionVerdict =
  | Readonly<{ kind: "emit"; unverified: readonly UnverifiedRoute[]; events: readonly EmissionEvent[] }>
  | Readonly<{ kind: "refuse"; message: string }>;

/** What observing the launch routes yielded: one decision per distinct route, or why `models.json` could not be read. */
export type LaunchRouteObservation =
  | Readonly<{ ok: true; decisions: readonly RouteReachability[] }>
  | Readonly<{ ok: false; error: string }>;

/** One step of the gate: a verdict, or the launch routes to observe and the pure decision over what is observed. */
export type EmissionGateStep =
  | Readonly<{ kind: "decided"; verdict: EmissionVerdict }>
  | Readonly<{
      kind: "observe";
      agentDir: string;
      launch: readonly EffectivePiBinding[];
      decide: (observed: LaunchRouteObservation) => EmissionVerdict;
    }>;

const UNGATED: EmissionVerdict = Object.freeze({ kind: "emit", unverified: Object.freeze([]), events: Object.freeze([]) });

const decided = (verdict: EmissionVerdict): EmissionGateStep => Object.freeze({ kind: "decided", verdict });
const refuse = (message: string): EmissionGateStep => decided(Object.freeze({ kind: "refuse", message }));
const unreadable = (cause: string): string => `cannot check Pi route reachability: ${cause}`;

type SpawnRequestParse<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>;

/**
 * One spawn request's authority as the stored-request parser admits it; a
 * refusal names the harness (`label`), the request's index and every
 * violation. The gate and the session binding both re-parse through it.
 */
export function parseSpawnRequestAuthority(label: string, index: number, authority: unknown): SpawnRequestParse<AgentRequestAuthority> {
  const parsed = parseStoredAgentRequestAuthority(authority);
  return parsed.ok
    ? parsed
    : { ok: false, message: `${label} orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}` };
}

/** Every request authority as the stored-request parser admits it, or the refusal naming the first that does not parse. */
function parsedRequests(authorities: readonly unknown[]): SpawnRequestParse<readonly AgentRequestAuthority[]> {
  const requests: AgentRequestAuthority[] = [];
  for (const [index, authority] of authorities.entries()) {
    const parsed = parseSpawnRequestAuthority("Pi", index, authority);
    if (!parsed.ok) return parsed;
    requests.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(requests) };
}

/**
 * Gate one action. Only a Pi parent's spawn batch is gated; every other
 * action is emitted as is. A gated batch is refused — before any route is
 * probed — when a request authority does not parse (its route is unknown),
 * the gate mode names no mode, the routing config is malformed (the child may
 * launch elsewhere than the declared route) or a launch binding cannot be
 * resolved; otherwise its launch routes are observed and the batch is decided
 * on them and on the retired routes it recorded (`decideSpawnGate`).
 */
export function gateEmission(action: GatedAction, parent: EmissionParent): EmissionGateStep {
  if (parent.harness !== "pi" || action.kind !== "spawn-batch") return decided(UNGATED);
  const { routeGate } = parent;
  const requests = parsedRequests(action.authorities);
  if (!requests.ok) return refuse(requests.message);
  if (!routeGate.mode.ok) return refuse(unreadable(routeGate.mode.error));
  const mode = routeGate.mode.value;
  if (!routeGate.routing.ok) return refuse(unreadable(routeGate.routing.error));
  const plan = planSpawnRoutes(requests.value, routeGate.routing.value);
  if (!plan.ok) return refuse(unreadable(plan.error.message));
  const { launch, retired } = plan.value;
  return Object.freeze({
    kind: "observe",
    agentDir: routeGate.agentDir,
    launch,
    decide: (observed: LaunchRouteObservation): EmissionVerdict => {
      if (!observed.ok) return Object.freeze({ kind: "refuse", message: unreadable(observed.error) });
      return match(decideSpawnGate([...retired, ...observed.decisions], mode))
        .returnType<EmissionVerdict>()
        .with({ kind: "refused" }, ({ message }) => Object.freeze({ kind: "refuse", message }))
        .with({ kind: "admitted" }, ({ unverified }) => Object.freeze({
          kind: "emit",
          unverified,
          events: Object.freeze(unverified.map((route) => Object.freeze({ event: "loom-route-unverified" as const, ...route }))),
        }))
        .exhaustive();
    },
  });
}
