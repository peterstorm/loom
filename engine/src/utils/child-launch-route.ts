/**
 * The ONE shell observation of the route a spawned Loom child Agent actually
 * launches on, after `model-routing.json` is applied.
 *
 * The functional core deliberately cannot answer this: `core/model-routing.ts`
 * is policy over caller-supplied values and reads nothing, while the launch
 * route depends on the parent session's observed model and the active routing
 * config. The two shells that decide a child's dispatch need the same answer
 * — the request programs' spawn render (`handlers/helpers/programs/spawn-task.ts`)
 * and Pi parent admission (`pi/review-run-authority.ts`) — so the observation
 * lives here exactly once and enters each of them as data. Capture never asks:
 * it reads the decision admission recorded with the child's correlator
 * (`orchestration/harness-capture-runtime.ts`), because the route observed
 * at capture time can differ from the one the child was dispatched on.
 *
 * Degradation matches the route gate: `buildPiRoutingContext` treats an absent
 * config as "no routing" and a malformed one as no routing plus a reported
 * error, so the declared binding is the launch route in both cases. The
 * resolution itself fails for a role outside the Agent Catalog and for a
 * served target whose provider's model is unknown; both are returned as the
 * typed refusal, never as a route the child would not run on, and each caller
 * decides at its own boundary what a refusal means.
 */

import { resolveAgentLaunchBinding, type LaunchBindingResult, type ModelRef } from "../core/model-routing";
import { buildPiRoutingContext } from "./model-routing-context";

/** The route a child launches on, or why it cannot be resolved (its profile, or its routing). */
export type ChildLaunchRouteResult =
  | Readonly<{ ok: true; value: ModelRef }>
  | Extract<LaunchBindingResult, { ok: false }>;

/**
 * The exact `provider/model` the child for `role` will run on under the
 * active parent session and routing config: with no parent ref or no routing
 * config the declared profile binding IS the launch route.
 */
export function routedChildLaunchRoute(role: string): ChildLaunchRouteResult {
  const { context } = buildPiRoutingContext();
  const resolved = resolveAgentLaunchBinding(role, context);
  if (!resolved.ok) return resolved;
  const { provider, model } = resolved.value.effective;
  return Object.freeze({ ok: true, value: Object.freeze({ provider, model }) });
}

/** The operator-facing refusal for a child route that cannot be resolved. */
export function describeChildLaunchRouteRefusal(role: string, refusal: Extract<ChildLaunchRouteResult, { ok: false }>): string {
  return `cannot resolve the routed launch route for agent '${role}': ${refusal.error.message}`;
}
