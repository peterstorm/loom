/**
 * The façade's emission gate (functional core: no I/O): whether an action the
 * façade is about to emit is gated on its Pi routes, and the verdict.
 *
 * ADR-0023 decision 3: before a Pi parent emits a spawn batch, every distinct
 * route its children launch on must answer, and no request may carry a
 * retired route. This module is the one entry point from (the action's
 * requests, the parent, the route-gate facts, the route observations) to a
 * verdict, with the stderr events the shell prints carried as data. Reading
 * the route-gate facts and observing routes are I/O, and both are needed only
 * for a Pi parent's spawn batch, so the entry returns a verdict or asks the
 * shell for the facts; given them it returns a verdict or the routes to
 * observe together with the pure continuation that decides once they are
 * observed. Every refusal it can make before a fact is read is made before
 * any is read, and every refusal it can make before a probe before any probe.
 */
import { match } from "ts-pattern";
import type { EffectivePiBinding } from "./model-routing";
import type { AgentRequestAuthority } from "./orchestration-contract";
import {
  decideSpawnGate,
  planSpawnRoutes,
  type RouteGateMode,
  type RouteReachability,
  type SpawnRouting,
  type UnverifiedRoute,
} from "./route-reachability";
import { parseSpawnRequestAuthority, type SpawnRequestParse } from "./spawn-request-authority";

/**
 * What a Pi parent's gate reads, as the shell resolved it for one gated batch:
 * Pi's agent directory (where `models.json` declares each provider's
 * endpoint), the operator's gate mode and the routing context, each as parsed
 * — a value that did not parse is kept as its error, so it refuses the gated
 * batch.
 */
export type PiRouteGateFacts = Readonly<{
  agentDir: string;
  mode: Readonly<{ ok: true; value: RouteGateMode }> | Readonly<{ ok: false; error: string }>;
  routing: Readonly<{ ok: true; value: SpawnRouting }> | Readonly<{ ok: false; error: string }>;
}>;

/**
 * The harness parenting this façade invocation, as its environment announces
 * it, and the session it publishes capture authority into (`null` when the
 * harness announced none). Only a Pi parent's spawn batch asks for route-gate
 * facts, so a gated Claude Code parent is unrepresentable.
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
  | Readonly<{ harness: "pi"; sessionId: string | null }>
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

type Decided = Readonly<{ kind: "decided"; verdict: EmissionVerdict }>;

/** A gated batch's step once its route-gate facts are read: a verdict, or the launch routes to observe and the pure decision over what is observed. */
export type RouteGateStep =
  | Decided
  | Readonly<{
      kind: "observe";
      agentDir: string;
      launch: readonly EffectivePiBinding[];
      decide: (observed: LaunchRouteObservation) => EmissionVerdict;
    }>;

/** One step of the gate: a verdict, or — for a Pi parent's spawn batch whose requests parse — the pure gate over its route-gate facts. */
export type EmissionGateStep =
  | Decided
  | Readonly<{ kind: "read-route-gate"; gate: (facts: PiRouteGateFacts) => RouteGateStep }>;

const UNGATED: EmissionVerdict = Object.freeze({ kind: "emit", unverified: Object.freeze([]), events: Object.freeze([]) });

const refusal = (message: string): EmissionVerdict => Object.freeze({ kind: "refuse", message });
const decided = (verdict: EmissionVerdict): Decided => Object.freeze({ kind: "decided", verdict });
const refuse = (message: string): Decided => decided(refusal(message));
const unreadable = (cause: string): string => `cannot check Pi route reachability: ${cause}`;

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
 * action is emitted as is, and no route-gate fact is read for it. A gated
 * batch is refused when a request authority does not parse (its route is
 * unknown) — before any fact is read — or, once the facts are read and before
 * any route is probed, when the gate mode names no mode, the routing config
 * is malformed (the child may launch elsewhere than the declared route) or a
 * launch binding cannot be resolved; otherwise its launch routes are observed
 * and the batch is decided on them and on the retired routes it recorded
 * (`decideSpawnGate`).
 */
export function gateEmission(action: GatedAction, parent: EmissionParent): EmissionGateStep {
  if (parent.harness !== "pi" || action.kind !== "spawn-batch") return decided(UNGATED);
  const requests = parsedRequests(action.authorities);
  if (!requests.ok) return refuse(requests.message);
  return Object.freeze({ kind: "read-route-gate", gate: (facts: PiRouteGateFacts) => gateRoutes(requests.value, facts) });
}

/** A Pi spawn batch's parsed requests, gated on its route-gate facts. */
function gateRoutes(requests: readonly AgentRequestAuthority[], facts: PiRouteGateFacts): RouteGateStep {
  if (!facts.mode.ok) return refuse(unreadable(facts.mode.error));
  const mode = facts.mode.value;
  if (!facts.routing.ok) return refuse(unreadable(facts.routing.error));
  const plan = planSpawnRoutes(requests, facts.routing.value);
  if (!plan.ok) return refuse(unreadable(plan.error.message));
  const { launch, retired } = plan.value;
  return Object.freeze({
    kind: "observe",
    agentDir: facts.agentDir,
    launch,
    decide: (observed: LaunchRouteObservation): EmissionVerdict => {
      if (!observed.ok) return refusal(unreadable(observed.error));
      return match(decideSpawnGate([...retired, ...observed.decisions], mode))
        .returnType<EmissionVerdict>()
        .with({ kind: "refused" }, ({ message }) => refusal(message))
        .with({ kind: "admitted" }, ({ unverified }) => Object.freeze({
          kind: "emit",
          unverified,
          events: Object.freeze(unverified.map((route) => Object.freeze({ event: "loom-route-unverified" as const, ...route }))),
        }))
        .exhaustive();
    },
  });
}
