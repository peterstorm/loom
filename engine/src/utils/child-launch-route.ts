/**
 * The ONE shell observation of the route a spawned Loom child Agent actually
 * launches on, after `model-routing.json` is applied.
 *
 * The functional core deliberately cannot answer this: `core/model-routing.ts`
 * is policy over caller-supplied values and reads nothing, while the launch
 * route depends on the parent session's observed model and the active routing
 * config. Three shells need the same answer — the request programs' spawn
 * render (`handlers/helpers/programs/spawn-task.ts`), the capture runtime
 * (`orchestration/harness-capture-runtime.ts`), and Pi parent admission
 * (`pi/review-run-authority.ts`) — so the observation lives here exactly once
 * and enters each of them as data.
 *
 * Degradation matches the route gate: `buildPiRoutingContext` treats an absent
 * config as "no routing" and a malformed one as no routing plus a reported
 * error, so the declared binding is the launch route in both cases. The
 * resolution itself only fails for a role outside the Agent Catalog, which is
 * a programmer error and throws rather than silently disabling a rule.
 */

import { resolveAgentLaunchBinding, type ModelRef } from "../core/model-routing";
import { buildPiRoutingContext } from "./model-routing-context";

/**
 * The exact `provider/model` the child for `role` will run on under the
 * active parent session and routing config. Never `null`: with no parent ref
 * or no routing config the declared profile binding IS the launch route.
 */
export function routedChildLaunchRoute(role: string): ModelRef {
  const { context } = buildPiRoutingContext();
  const resolved = resolveAgentLaunchBinding(role, context.parentRef, context.config);
  if (!resolved.ok) {
    throw new Error(`cannot resolve the routed launch route for agent '${role}': ${resolved.error.message}`);
  }
  const { provider, model } = resolved.value.effective;
  return Object.freeze({ provider, model });
}
