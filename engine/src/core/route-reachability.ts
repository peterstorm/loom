/**
 * Route reachability — the fail-closed gate before a Pi parent spawns
 * children on a route (functional core: no I/O).
 *
 * Pi runs local models only (ADR-0023), and a local server can be down.
 * Spawning a batch onto a route that does not answer leaves every child to
 * hang or fail one by one, so the shell observes each route the batch will
 * actually launch on once, and this module decides. There is no fallback
 * route: an unreachable, unconfigured or retired route refuses the spawn,
 * naming the route and what the operator can do about it.
 *
 * This module is also the one owner of what a `GET {baseUrl}/models` answer
 * means. The calibration preflight maps {@link decideProbedRoute}'s closed
 * union into its own fact rather than re-reading HTTP status codes.
 */

import { match } from "ts-pattern";
import { recordedProfileBindings, type PolicyResult, type RecordedLlmProfileId } from "./model-profiles";
import { resolveAgentLaunchBinding, type EffectivePiBinding, type ModelRef, type ModelRoutingConfig } from "./model-routing";
import type { AgentRequestAuthority } from "./orchestration-contract";
import { samePiBinding } from "./orchestration-contract/roster";

/** The provider's configured endpoint, as Pi's `models.json` declares it. */
export type RouteEndpoint = Readonly<{ provider: string; baseUrl: string }>;

/**
 * What one `GET {baseUrl}/models` observed. `answered` is any HTTP response:
 * `servedModels` is the listed model ids when a 2xx body lists them, null
 * otherwise. `refused` is a connection failure or timeout.
 */
export type RouteProbe =
  | Readonly<{ kind: "answered"; status: number; servedModels: readonly string[] | null }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * What the shell observed for one route: Pi's `models.json` declares no
 * endpoint for the provider (nothing to probe — Pi cannot run it either), or
 * the declared endpoint and what probing it answered.
 */
export type RouteObservation =
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "probed"; endpoint: RouteEndpoint; probe: RouteProbe }>;

/**
 * Why a live server's model list could not confirm the model:
 * - `auth-refused` — 401/403: listing needs the provider's credentials, which
 *   Loom never resolves or sends (Pi authenticates the inference itself);
 * - `unreadable-listing` — a 2xx whose body is not an OpenAI-style model list
 *   (a proxy, a captive page, a non-OpenAI server).
 */
export type UnlistedCause = "auth-refused" | "unreadable-listing";

/** Whether the server's own model list confirmed the model. `listed` carries everything it serves. */
export type ServedModelEvidence =
  | Readonly<{ kind: "listed"; models: readonly string[] }>
  | Readonly<{ kind: "unlisted"; cause: UnlistedCause; status: number }>;

/** Why a configured route cannot run the model. */
export type UnreachableCause =
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "http-status"; status: number }>
  | Readonly<{ kind: "model-not-served"; model: string; served: readonly string[] }>;

/** The decision for a route whose endpoint was probed. */
export type ProbedRouteReachability =
  | Readonly<{ kind: "reachable"; route: string; url: string; served: ServedModelEvidence }>
  | Readonly<{ kind: "unreachable"; route: string; url: string; cause: UnreachableCause }>;

/** The decision for one observed route. */
export type RouteReachability =
  | ProbedRouteReachability
  | Readonly<{ kind: "unconfigured"; route: string; provider: string }>;

/**
 * A request recorded on a cloud route the catalog has retired. Pi launches
 * every child on the local route now, so no probe can make the recorded
 * route runnable: the run predates local-only routing and must be restarted.
 */
export type RetiredRoute = Readonly<{ kind: "retired"; route: string; profile: RecordedLlmProfileId }>;

/** Every outcome the Pi spawn gate refuses or admits on. */
export type SpawnRouteDecision = RouteReachability | RetiredRoute;

/** A reachable route whose served model the server's list did not confirm. */
export type UnverifiedRoute = Readonly<{ route: string; url: string; cause: UnlistedCause; status: number }>;

/** `provider/model`, the name Pi and the operator use for a route. */
export function routeName(binding: ModelRef): string {
  return `${binding.provider}/${binding.model}`;
}

/** The URL the probe reads for an endpoint. */
export function modelsUrl(endpoint: RouteEndpoint): string {
  return `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
}

/** The distinct routes a batch of Pi bindings runs on, in first-seen order. */
export function distinctRoutes<Route extends ModelRef>(bindings: readonly Route[]): readonly Route[] {
  const seen = new Map<string, Route>();
  for (const binding of bindings) if (!seen.has(routeName(binding))) seen.set(routeName(binding), binding);
  return Object.freeze([...seen.values()]);
}

/** The routing inputs a Pi launch is resolved under (`PiRoutingContext`, as the shell observes it). */
export type SpawnRouting = Readonly<{ parentRef: ModelRef | null; config: ModelRoutingConfig | null }>;

/** The routes a Pi spawn batch needs: what its children launch on, and the retired routes it recorded. */
export type SpawnRoutePlan = Readonly<{ launch: readonly EffectivePiBinding[]; retired: readonly RetiredRoute[] }>;

/**
 * Plan a batch's routes. A request whose recorded Pi binding is not its
 * profile's current one was issued on a route the catalog has retired; every
 * other request launches on {@link resolveAgentLaunchBinding} — the exact
 * binding the generated-agent render carries, routing rules included.
 */
export function planSpawnRoutes(
  requests: readonly Pick<AgentRequestAuthority, "role" | "modelProfile" | "harnessBinding">[],
  routing: SpawnRouting,
): PolicyResult<SpawnRoutePlan> {
  const launch: EffectivePiBinding[] = [];
  const retired = new Map<string, RetiredRoute>();
  for (const { role, modelProfile, harnessBinding: { pi: recorded } } of requests) {
    if (!samePiBinding(recorded, recordedProfileBindings(modelProfile).pi[0])) {
      const route = routeName(recorded);
      if (!retired.has(route)) retired.set(route, Object.freeze({ kind: "retired", route, profile: modelProfile }));
      continue;
    }
    const resolved = resolveAgentLaunchBinding(role, routing.parentRef, routing.config);
    if (!resolved.ok) return resolved;
    launch.push(resolved.value.effective);
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({ launch: distinctRoutes(launch), retired: Object.freeze([...retired.values()]) }),
  });
}

/**
 * Decide a probed route. Authentication refusals (401/403) prove the server
 * is up; a 2xx proves it too, and its list either confirms the model, lacks
 * it (unreachable: the server does not serve it), or is unreadable. Every
 * other status, and any refused connection, is unreachable.
 */
export function decideProbedRoute(binding: ModelRef, endpoint: RouteEndpoint, probe: RouteProbe): ProbedRouteReachability {
  const route = routeName(binding);
  const url = modelsUrl(endpoint);
  const reachable = (served: ServedModelEvidence): ProbedRouteReachability =>
    Object.freeze({ kind: "reachable", route, url, served: Object.freeze(served) });
  const unreachable = (cause: UnreachableCause): ProbedRouteReachability =>
    Object.freeze({ kind: "unreachable", route, url, cause: Object.freeze(cause) });
  return match(probe)
    .returnType<ProbedRouteReachability>()
    .with({ kind: "refused" }, ({ reason }) => unreachable({ kind: "refused", reason }))
    .with({ kind: "answered" }, ({ status, servedModels }) => {
      if (status === 401 || status === 403) return reachable({ kind: "unlisted", cause: "auth-refused", status });
      if (status < 200 || status > 299) return unreachable({ kind: "http-status", status });
      if (servedModels === null) return reachable({ kind: "unlisted", cause: "unreadable-listing", status });
      return servedModels.includes(binding.model)
        ? reachable({ kind: "listed", models: servedModels })
        : unreachable({ kind: "model-not-served", model: binding.model, served: servedModels });
    })
    .exhaustive();
}

/** Decide one observed route: unconfigured when Pi declares no endpoint, else {@link decideProbedRoute}. */
export function decideRouteReachability(binding: ModelRef, observation: RouteObservation): RouteReachability {
  return match(observation)
    .returnType<RouteReachability>()
    .with({ kind: "unconfigured" }, () => Object.freeze({ kind: "unconfigured", route: routeName(binding), provider: binding.provider }))
    .with({ kind: "probed" }, ({ endpoint, probe }) => decideProbedRoute(binding, endpoint, probe))
    .exhaustive();
}

/** The operator-facing reason a configured route cannot run its model. */
export function unreachableReason(cause: UnreachableCause): string {
  return match(cause)
    .with({ kind: "refused" }, ({ reason }) => reason)
    .with({ kind: "http-status" }, ({ status }) => `GET /models answered HTTP ${status}`)
    .with({ kind: "model-not-served" }, ({ model, served }) =>
      `the server does not serve '${model}' (serves: ${served.join(", ") || "nothing"})`)
    .exhaustive();
}

/**
 * How the gate treats a reachable route whose served model went unconfirmed
 * (401/403, or a 2xx without a readable model list):
 * - `admit-unverified` (the default, ADR-0023) admits it, and the shell
 *   reports it on stderr as a `loom-route-unverified` event;
 * - `strict` refuses it, for an operator whose authenticating gateway can
 *   answer while the model server behind it is down.
 */
export type RouteGateMode = "admit-unverified" | "strict";

/** The environment variable through which an operator chooses the {@link RouteGateMode}. */
export const ROUTE_GATE_VARIABLE = "LOOM_ROUTE_GATE";

const ROUTE_GATE_MODES: readonly RouteGateMode[] = Object.freeze(["admit-unverified", "strict"]);

/**
 * Parse the operator's {@link ROUTE_GATE_VARIABLE}. Unset or empty is the
 * default; a value naming no mode is an error, never the default, so a
 * misspelt `strict` cannot quietly admit unverified routes.
 */
export function parseRouteGateMode(
  raw: string | undefined,
): Readonly<{ ok: true; value: RouteGateMode }> | Readonly<{ ok: false; error: string }> {
  if (raw === undefined || raw === "") return { ok: true, value: "admit-unverified" };
  const mode = ROUTE_GATE_MODES.find((candidate) => candidate === raw);
  return mode === undefined
    ? { ok: false, error: `${ROUTE_GATE_VARIABLE} must be unset, 'admit-unverified' or 'strict', not '${raw}'` }
    : { ok: true, value: mode };
}

/** The gate's verdict on a batch: admitted (with the unverified routes the shell reports), or refused. */
export type SpawnGateVerdict =
  | Readonly<{ kind: "admitted"; unverified: readonly UnverifiedRoute[] }>
  | Readonly<{ kind: "refused"; message: string }>;

/** The operator-facing reason a live server's model list could not confirm its model. */
function unlistedReason(cause: UnlistedCause, status: number): string {
  return match(cause)
    .with("auth-refused", () => `GET /models answered HTTP ${status}, so its served models cannot be listed without credentials`)
    .with("unreadable-listing", () => `GET /models answered HTTP ${status} without an OpenAI-style model list`)
    .exhaustive();
}

/** Remedy kinds, in the order a refusal reports them. */
const REMEDY_ORDER = ["resume", "verify", "configure", "restart"] as const;
type Remedy = (typeof REMEDY_ORDER)[number];
const REMEDIES: Readonly<Record<Remedy, string>> = Object.freeze({
  resume: "bring the route up, then resume the run",
  verify: `make the route list its models at GET /models without credentials, or unset ${ROUTE_GATE_VARIABLE} to admit unverified routes, then resume the run`,
  configure: "declare the provider's baseUrl in Pi's models.json or route the child elsewhere in model-routing.json, then resume the run",
  restart: "this run predates local-only routing and can never resume its retired routes, so start a fresh run",
});

/**
 * Decide a batch from its route decisions: refused, naming every route that
 * cannot run, when any cannot; otherwise admitted with the reachable routes
 * whose served model went unconfirmed. Each refused route carries its own
 * remedy: a down route is brought up and the run resumed; an unverified
 * route — refused only under `strict` — is made to list its models or the
 * gate relaxed, then resumed; an unconfigured one (often a routing rule
 * naming a provider `models.json` does not declare) is declared or routed
 * elsewhere, then resumed; a retired route never comes back, so the run is
 * restarted.
 */
export function decideSpawnGate(decisions: readonly SpawnRouteDecision[], mode: RouteGateMode): SpawnGateVerdict {
  type Refusal = Readonly<{ remedy: Remedy; text: string }>;
  const unverified = decisions.flatMap((decision): UnverifiedRoute[] =>
    decision.kind === "reachable" && decision.served.kind === "unlisted"
      ? [Object.freeze({ route: decision.route, url: decision.url, cause: decision.served.cause, status: decision.served.status })]
      : []);
  const refusals = decisions.flatMap((decision) => match(decision)
    .returnType<readonly Refusal[]>()
    .with({ kind: "reachable", served: { kind: "unlisted" } }, ({ route, url, served: { cause, status } }) => mode === "strict"
      ? [{ remedy: "verify", text: `route ${route} is unverified at ${url} (${ROUTE_GATE_VARIABLE}=strict): ${unlistedReason(cause, status)}` }]
      : [])
    .with({ kind: "reachable" }, () => [])
    .with({ kind: "unreachable" }, ({ route, url, cause }) => [
      { remedy: "resume", text: `route ${route} is unreachable at ${url}: ${unreachableReason(cause)}` },
    ])
    .with({ kind: "unconfigured" }, ({ route, provider }) => [
      { remedy: "configure", text: `route ${route} is unconfigured: Pi's models.json declares no baseUrl for provider '${provider}'` },
    ])
    .with({ kind: "retired" }, ({ route, profile }) => [
      { remedy: "restart", text: `route ${route} (recorded under profile '${profile}') is retired: Pi runs on the local route only since ADR-0023` },
    ])
    .exhaustive());
  if (refusals.length === 0) return Object.freeze({ kind: "admitted", unverified: Object.freeze(unverified) });
  const needed = new Set(refusals.map(({ remedy }) => remedy));
  const remedies = REMEDY_ORDER.filter((remedy) => needed.has(remedy)).map((remedy) => REMEDIES[remedy]);
  return Object.freeze({
    kind: "refused",
    message: `refusing to spawn: ${refusals.map(({ text }) => text).join("; ")}. To proceed, ${remedies.join("; ")}. Nothing was spawned.`,
  });
}
