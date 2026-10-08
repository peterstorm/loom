/**
 * Route reachability — the fail-closed gate before a Pi parent spawns
 * children on a route (functional core: no I/O).
 *
 * Pi runs local models only, and a local server can be down. Spawning a batch
 * onto a route that does not answer leaves every child to hang or fail one by
 * one, so the shell observes each issued route's endpoint once and this
 * module decides. There is no fallback route: an unreachable or unconfigured
 * route refuses the spawn, naming the route, the URL and the reason.
 */

import { match } from "ts-pattern";
import type { ModelRef } from "./model-routing";

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
 * Whether the server's own model list confirmed the model. `unlisted` means
 * the server answered but listed nothing Loom could read — typically because
 * listing needs the provider's credentials, which Loom never resolves; Pi
 * authenticates the actual inference.
 */
export type ServedModelEvidence = "listed" | "unlisted";

export type RouteReachability =
  | Readonly<{ kind: "reachable"; route: string; url: string; served: ServedModelEvidence }>
  | Readonly<{ kind: "unreachable"; route: string; url: string; reason: string }>
  | Readonly<{ kind: "unconfigured"; route: string; reason: string }>;

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

/**
 * Decide one route. `endpoint` is null when Pi's `models.json` declares no
 * endpoint for the provider: Pi cannot run it either, so it is
 * `unconfigured`. Authentication refusals (401/403) prove the server is up;
 * every other non-2xx status, and any refused connection, is `unreachable`.
 */
export function decideRouteReachability(
  binding: ModelRef,
  endpoint: RouteEndpoint | null,
  probe: RouteProbe | null,
): RouteReachability {
  const route = routeName(binding);
  if (endpoint === null || probe === null) {
    return Object.freeze({
      kind: "unconfigured",
      route,
      reason: `Pi's models.json declares no baseUrl for provider '${binding.provider}'`,
    });
  }
  const url = modelsUrl(endpoint);
  return match(probe)
    .returnType<RouteReachability>()
    .with({ kind: "refused" }, ({ reason }) => Object.freeze({ kind: "unreachable", route, url, reason }))
    .with({ kind: "answered" }, ({ status, servedModels }) => {
      if (status === 401 || status === 403) return Object.freeze({ kind: "reachable", route, url, served: "unlisted" });
      if (status < 200 || status > 299) {
        return Object.freeze({ kind: "unreachable", route, url, reason: `GET /models answered HTTP ${status}` });
      }
      if (servedModels === null) return Object.freeze({ kind: "reachable", route, url, served: "unlisted" });
      return servedModels.includes(binding.model)
        ? Object.freeze({ kind: "reachable", route, url, served: "listed" })
        : Object.freeze({
            kind: "unreachable",
            route,
            url,
            reason: `the server does not serve '${binding.model}' (serves: ${servedModels.join(", ") || "nothing"})`,
          });
    })
    .exhaustive();
}

/** The refusal text for every route that is not reachable, or null when all are. */
export function reachabilityRefusal(decisions: readonly RouteReachability[]): string | null {
  const refusals = decisions.flatMap((decision) => match(decision)
    .with({ kind: "reachable" }, () => [])
    .with({ kind: "unreachable" }, ({ route, url, reason }) => [`route ${route} is unreachable at ${url}: ${reason}`])
    .with({ kind: "unconfigured" }, ({ route, reason }) => [`route ${route} is unconfigured: ${reason}`])
    .exhaustive());
  return refusals.length === 0
    ? null
    : `refusing to spawn: ${refusals.join("; ")}. Bring the route up, then resume the run; nothing was spawned.`;
}
