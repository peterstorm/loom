/**
 * Imperative shell for route reachability: reads a provider's endpoint from
 * Pi's `models.json` and probes `GET {baseUrl}/models`, then hands the facts
 * to the pure decision in `core/route-reachability.ts`.
 *
 * Only `baseUrl` is read from `models.json`. The provider's credentials are
 * never resolved, read or sent: an authentication refusal already proves the
 * server answers, and Pi authenticates the inference itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ModelRef } from "../core/model-routing";
import {
  decideRouteReachability,
  distinctRoutes,
  modelsUrl,
  planSpawnRoutes,
  type RouteEndpoint,
  type RouteObservation,
  type RouteProbe,
  type RouteReachability,
  type SpawnRouteDecision,
  type SpawnRouting,
} from "../core/route-reachability";

/** How long one probe waits before the route counts as unreachable. */
export const ROUTE_PROBE_TIMEOUT_MS = 5_000;

const modelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({ baseUrl: z.string().min(1).optional() }).passthrough()).optional(),
}).passthrough();

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

export type EndpointLookup =
  | Readonly<{ ok: true; endpoint: RouteEndpoint | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The provider's endpoint from `<agentDir>/models.json`. An absent file or
 * provider is `endpoint: null`; a present but malformed file is an error, so
 * a broken config never reads as "no endpoint".
 */
export function readRouteEndpoint(agentDir: string, provider: string): EndpointLookup {
  const path = join(agentDir, "models.json");
  if (!existsSync(path)) return { ok: true, endpoint: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { ok: false, error: `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = modelsConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `invalid ${path}: ${parsed.error.issues.map(({ message }) => message).join("; ")}` };
  const baseUrl = parsed.data.providers?.[provider]?.baseUrl;
  return { ok: true, endpoint: baseUrl === undefined ? null : Object.freeze({ provider, baseUrl }) };
}

/** One route probe: the port the gate depends on, so tests substitute a fake. */
export type RouteProbePort = (endpoint: RouteEndpoint) => Promise<RouteProbe>;

const failureText = (error: unknown): string => {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error instanceof Error ? error.message : String(error)}${cause}`;
};

/** The model ids a body lists, or null when it is not an OpenAI-style model list. */
function listedModels(body: string): readonly string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const listed = modelListSchema.safeParse(raw);
  return listed.success ? Object.freeze(listed.data.data.map(({ id }) => id)) : null;
}

/**
 * The live probe: an unauthenticated `GET {baseUrl}/models`, bounded by one
 * timeout over the whole exchange. A server that never answers, or that
 * stalls mid-body, is `refused`; a body that arrives but lists nothing
 * readable is an answer without a list.
 */
export function httpRouteProbe(timeoutMs: number = ROUTE_PROBE_TIMEOUT_MS): RouteProbePort {
  return async (endpoint) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(modelsUrl(endpoint), { signal });
    } catch (error) {
      return { kind: "refused", reason: failureText(error) };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "answered", status: response.status, servedModels: null };
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      return { kind: "refused", reason: `HTTP ${response.status} body did not arrive: ${failureText(error)}` };
    }
    return { kind: "answered", status: response.status, servedModels: listedModels(body) };
  };
}

/**
 * Observe and decide every distinct route a batch runs on. A malformed
 * `models.json` is reported as the decision's error rather than guessed past.
 */
export async function observeRouteReachability(
  bindings: readonly ModelRef[],
  agentDir: string,
  probe: RouteProbePort,
): Promise<Readonly<{ ok: true; decisions: readonly RouteReachability[] }> | Readonly<{ ok: false; error: string }>> {
  const decisions: RouteReachability[] = [];
  for (const binding of distinctRoutes(bindings)) {
    const lookup = readRouteEndpoint(agentDir, binding.provider);
    if (!lookup.ok) return lookup;
    const observation: RouteObservation = lookup.endpoint === null
      ? { kind: "unconfigured" }
      : { kind: "probed", endpoint: lookup.endpoint, probe: await probe(lookup.endpoint) };
    decisions.push(decideRouteReachability(binding, observation));
  }
  return { ok: true, decisions: Object.freeze(decisions) };
}

/** What the Pi spawn gate observes with: Pi's agent directory, the routing context and the probe. */
export type SpawnRouteGatePorts = Readonly<{ agentDir: string; routing: SpawnRouting; probe: RouteProbePort }>;

/**
 * Observe and decide every route a Pi spawn batch needs: the retired routes
 * it recorded (decided without a probe — none can come back) and each
 * distinct route its children launch on, resolved by the same rule as the
 * generated-agent render.
 */
export async function observeSpawnRoutes(
  requests: Parameters<typeof planSpawnRoutes>[0],
  ports: SpawnRouteGatePorts,
): Promise<Readonly<{ ok: true; decisions: readonly SpawnRouteDecision[] }> | Readonly<{ ok: false; error: string }>> {
  const plan = planSpawnRoutes(requests, ports.routing);
  if (!plan.ok) return { ok: false, error: plan.error.message };
  const observed = await observeRouteReachability(plan.value.launch, ports.agentDir, ports.probe);
  if (!observed.ok) return observed;
  return { ok: true, decisions: Object.freeze([...plan.value.retired, ...observed.decisions]) };
}
