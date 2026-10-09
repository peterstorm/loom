/**
 * Resolve the immutable environment a façade invocation emits under, once,
 * at its composition root: the session run binding directory, the parent
 * harness and its session, and — for a Pi parent only — what its route gate
 * reads (Pi's agent directory, `LOOM_ROUTE_GATE`, `model-routing.json` and
 * the parent model). The only I/O is the routing-config read; everything
 * after this value is decided by `core/spawn-emission-gate.ts`.
 */
import { piHomeAgentDirectory, resolvePiAgentDirectory } from "../core/pi-agent-directory";
import { parseRouteGateMode, ROUTE_GATE_VARIABLE } from "../core/route-reachability";
import { announcedParentHarness, type EmissionEnvironment, type EmissionParent } from "../core/spawn-emission-gate";
import { loadModelRoutingConfig, parentModelRefFromEnv } from "./model-routing-context";

export type EmissionEnvironmentSource = Readonly<{
  /** The process environment the parent harness announced itself in. */
  env: NodeJS.ProcessEnv;
  /** The account's home directory (`os.homedir()`), which Pi's agent directory defaults under. */
  home: string;
  /** Where session run bindings are published. */
  bindingDir: string;
}>;

function emissionParent({ env, home }: EmissionEnvironmentSource): EmissionParent {
  const announced = announcedParentHarness(env);
  if (announced === null) return Object.freeze({ harness: "unannounced" });
  if (announced.harness === "claude-code") return Object.freeze({ harness: "claude-code", sessionId: announced.sessionId });
  const agentDir = resolvePiAgentDirectory(env, home);
  const routing = loadModelRoutingConfig(agentDir, piHomeAgentDirectory(home));
  return Object.freeze({
    harness: "pi",
    sessionId: announced.sessionId,
    routeGate: Object.freeze({
      agentDir,
      mode: parseRouteGateMode(env[ROUTE_GATE_VARIABLE]),
      routing: routing.ok
        ? Object.freeze({ ok: true as const, value: Object.freeze({ config: routing.config, parentRef: parentModelRefFromEnv(env) }) })
        : Object.freeze({ ok: false as const, error: routing.error }),
    }),
  });
}

/** The emission environment `source` describes. */
export function resolveEmissionEnvironment(source: EmissionEnvironmentSource): EmissionEnvironment {
  return Object.freeze({ bindingDir: source.bindingDir, parent: emissionParent(source) });
}
