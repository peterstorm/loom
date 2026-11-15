/**
 * Imperative shell for route reachability: reads a provider's endpoint from
 * Pi's `models.json` and probes `GET {baseUrl}/models`, then hands the facts
 * to the pure decision in `core/route-reachability.ts`. It is also the one
 * reader of `models.json` (`readModelsProvider`).
 *
 * The reachability probe reads only `baseUrl` and sends no credentials: an
 * authentication refusal already proves the server answers, and Pi
 * authenticates the inference itself. The one probe that sends a provider's
 * key is the served-model listing (`utils/served-model-probe.ts`), which must
 * learn which model the server serves, not only that it answers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { observePathPresence } from "./path-presence";
import type { ModelRef } from "../core/model-routing";
import {
  decideRouteReachability,
  distinctRoutes,
  modelsUrl,
  type RouteEndpoint,
  type RouteObservation,
  type RouteProbe,
  type RouteReachability,
} from "../core/route-reachability";

/** How long one probe waits before the route counts as unreachable. */
export const ROUTE_PROBE_TIMEOUT_MS = 5_000;

const modelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({
    baseUrl: z.string().min(1).optional(),
    apiKey: z.string().optional(),
    models: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

/**
 * One provider as Pi's `models.json` declares it: its endpoint (null when
 * none), its raw `apiKey` config value (null when none — Pi's grammar, never
 * resolved here) and the model ids it declares.
 */
export type ModelsProvider = Readonly<{ baseUrl: string | null; apiKey: string | null; catalog: readonly string[] }>;

export type ModelsProviderLookup =
  | Readonly<{ ok: true; provider: ModelsProvider | null }>
  | Readonly<{ ok: false; error: string }>;

/**
 * The provider from `<agentDir>/models.json`. An absent file or provider is
 * `provider: null`; a present but malformed or unreadable file is an error,
 * so a broken config never reads as "not declared". Errors name the file and
 * the schema issue, never a field's value.
 */
export function readModelsProvider(agentDir: string, provider: string): ModelsProviderLookup {
  const path = join(agentDir, "models.json");
  const presence = observePathPresence(path);
  if (presence.kind === "absent") return { ok: true, provider: null };
  if (presence.kind === "unknown") return { ok: false, error: `cannot read ${path}: ${presence.cause}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { ok: false, error: `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = modelsConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `invalid ${path}: ${parsed.error.issues.map(({ message }) => message).join("; ")}` };
  const declared = parsed.data.providers?.[provider];
  return {
    ok: true,
    provider: declared === undefined ? null : Object.freeze({
      baseUrl: declared.baseUrl ?? null,
      apiKey: declared.apiKey ?? null,
      catalog: Object.freeze((declared.models ?? []).map(({ id }) => id)),
    }),
  };
}

export type EndpointLookup =
  | Readonly<{ ok: true; endpoint: RouteEndpoint | null }>
  | Readonly<{ ok: false; error: string }>;

/** The provider's endpoint from `<agentDir>/models.json`: null when it declares no `baseUrl` for it. */
export function readRouteEndpoint(agentDir: string, provider: string): EndpointLookup {
  const lookup = readModelsProvider(agentDir, provider);
  if (!lookup.ok) return lookup;
  const baseUrl = lookup.provider?.baseUrl ?? null;
  return { ok: true, endpoint: baseUrl === null ? null : Object.freeze({ provider, baseUrl }) };
}

/** One route probe: the port the gate depends on, so tests substitute a fake. */
export type RouteProbePort = (endpoint: RouteEndpoint) => Promise<RouteProbe>;

const failureText = (error: unknown): string => {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error instanceof Error ? error.message : String(error)}${cause}`;
};

/** The model ids a body lists, or null when it is not an OpenAI-style model list. */
export function listedModels(body: string): readonly string[] | null {
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
 * The live reachability probe: an unauthenticated `GET {baseUrl}/models`, bounded by one
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
