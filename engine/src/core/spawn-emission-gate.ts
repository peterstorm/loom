/**
 * The façade's emission gate (functional core: no I/O): the verdict on a Pi
 * parent's spawn batch.
 *
 * ADR-0023 decision 3: before a Pi parent emits a spawn batch, every distinct
 * route its children launch on must answer, and no request may carry a
 * retired route. That only a Pi parent's spawn batch is gated is a type here,
 * not a check: the one entry point takes a `PiSpawnBatch`, whose parent is a
 * `PiParent`, so neither a Claude Code parent's batch nor any other action
 * can reach it, and no route-gate fact is ever read for one. The entry goes
 * from (the batch's parsed requests, the route-gate facts, the route
 * observations) to a verdict, with the stderr events the shell prints carried
 * as data. Reading the route-gate facts and observing routes are I/O, so the
 * entry returns a verdict or asks the shell for the facts; given them it
 * returns a verdict or the routes to observe together with the pure
 * continuation that decides once they are observed. Every refusal it can
 * make before a fact is read is made before any is read, and every refusal it
 * can make before a probe before any probe. A batch's request authorities
 * arrive already parsed (`ParsedSpawnBatch`, parsed once at the façade's
 * emission seam), so the gate and the session binding act on the one parse.
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
import type { ParsedSpawnBatch } from "./spawn-request-authority";

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
 * A parent harness that announced itself, and the session it publishes
 * capture authority into (`null` when it announced none) — one variant per
 * harness, so a seam only a Pi parent may reach (the route gate) takes a
 * `PiParent`, and a Claude Code parent does not type there.
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
export type AnnouncedParent = PiParent | ClaudeCodeParent;

/** A Pi parent: its spawn batches are gated on their routes (`gateEmission`). */
export type PiParent = Readonly<{ harness: "pi"; sessionId: string | null }>;

/** A Claude Code parent: nothing it emits is gated. */
export type ClaudeCodeParent = Readonly<{ harness: "claude-code"; sessionId: string | null }>;

/** The harness parenting this façade invocation, as its environment announces it. */
export type EmissionParent = AnnouncedParent | Readonly<{ harness: "unannounced" }>;

/** The immutable environment one façade invocation emits under. */
export type EmissionEnvironment = Readonly<{
  /** The session run binding directory (`LOOM_SUBAGENT_DIR`). */
  bindingDir: string;
  parent: EmissionParent;
}>;

/** The variable each announced harness names its session id in. */
export const SESSION_VARIABLE: Readonly<Record<AnnouncedParent["harness"], string>> = Object.freeze({
  "pi": "PI_SESSION_ID",
  "claude-code": "CLAUDE_CODE_SESSION_ID",
});

/** The parent harness a process announces, read from its environment variables (Pi first: a Pi process launched from Claude Code is Pi). */
export function announcedParentHarness(env: Readonly<Record<string, string | undefined>>): AnnouncedParent | null {
  const harness = env.PI_CODING_AGENT === "true" ? "pi" : env.CLAUDECODE === "1" ? "claude-code" : null;
  return harness === null ? null : Object.freeze({ harness, sessionId: env[SESSION_VARIABLE[harness]] ?? null });
}

/** What the gate decides on: a Pi parent's spawn batch, its request authorities parsed once. */
export type PiSpawnBatch = Readonly<{ parent: PiParent; batch: ParsedSpawnBatch }>;

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

/** One step of the gate: a verdict, or — for a batch whose requests were admitted — the pure gate over its route-gate facts. */
export type EmissionGateStep =
  | Decided
  | Readonly<{ kind: "read-route-gate"; gate: (facts: PiRouteGateFacts) => RouteGateStep }>;

/** The verdict on an action nothing gates: emit it as is, reporting no route. */
export const UNGATED: EmissionVerdict = Object.freeze({ kind: "emit", unverified: Object.freeze([]), events: Object.freeze([]) });

/** The verdict refusing an action with the operator's `message`. */
export const refusal = (message: string): EmissionVerdict => Object.freeze({ kind: "refuse", message });
const decided = (verdict: EmissionVerdict): Decided => Object.freeze({ kind: "decided", verdict });
const refuse = (message: string): Decided => decided(refusal(message));
const unreadable = (cause: string): string => `cannot check Pi route reachability: ${cause}`;

/**
 * Gate a Pi parent's spawn batch. It is refused when the batch was not
 * admitted (a request did not parse, so its route is unknown, or belongs to
 * another run) — before any fact is read — or, once the facts are read and
 * before any route is probed, when the gate mode names no mode, the routing
 * config is malformed (the child may launch elsewhere than the declared
 * route) or a launch binding cannot be resolved; otherwise its launch routes
 * are observed and the batch is decided on them and on the retired routes it
 * recorded (`decideSpawnGate`).
 */
export function gateEmission({ batch }: PiSpawnBatch): EmissionGateStep {
  if (!batch.ok) return refuse(batch.message);
  return Object.freeze({ kind: "read-route-gate", gate: (facts: PiRouteGateFacts) => gateRoutes(batch.requests, facts) });
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
