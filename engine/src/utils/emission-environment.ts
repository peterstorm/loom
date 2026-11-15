/**
 * Resolve what a façade invocation emits under, at its composition root: the
 * immutable emission environment — the session run binding directory, the
 * parent harness and its session — from the environment variables alone, and,
 * separately, what a Pi parent's route gate reads (Pi's agent directory,
 * `LOOM_ROUTE_GATE`, `model-routing.json`, the parent model and the model each
 * reachable served target's provider serves). The gate facts carry the only
 * I/O (the routing-config read and the served-model probes), and only a Pi
 * parent's spawn batch asks for them (`core/spawn-emission-gate.ts`), so the
 * shell reads them on that request and never otherwise.
 */
import { piHomeAgentDirectory, resolvePiAgentDirectory } from "../core/pi-agent-directory";
import { parseRouteGateMode, ROUTE_GATE_VARIABLE } from "../core/route-reachability";
import {
  announcedParentHarness,
  type EmissionEnvironment,
  type EmissionParent,
  type PiRouteGateFacts,
} from "../core/spawn-emission-gate";
import { loadModelRoutingConfig, observeRoutingContext, parentModelRefFromEnv } from "./model-routing-context";
import { LIVE_SERVED_PROBE_PORTS, type ServedProbePorts } from "./served-model-probe";

export type EmissionEnvironmentSource = Readonly<{
  /** The process environment the parent harness announced itself in. */
  env: NodeJS.ProcessEnv;
  /** Where session run bindings are published. */
  bindingDir: string;
}>;

export type PiRouteGateSource = Readonly<{
  /** The process environment the Pi parent announced itself in. */
  env: NodeJS.ProcessEnv;
  /** The account's home directory (`os.homedir()`), which Pi's agent directory defaults under. */
  home: string;
}>;

/** The emission environment `source` describes: environment variables only, no I/O. */
export function resolveEmissionEnvironment({ env, bindingDir }: EmissionEnvironmentSource): EmissionEnvironment {
  const parent: EmissionParent = announcedParentHarness(env) ?? Object.freeze({ harness: "unannounced" });
  return Object.freeze({ bindingDir, parent });
}

/** What a Pi parent's route gate reads under `source`: its agent directory, gate mode and routing context, each as parsed. */
export function readPiRouteGateFacts(
  { env, home }: PiRouteGateSource,
  ports: ServedProbePorts = LIVE_SERVED_PROBE_PORTS,
): PiRouteGateFacts {
  const agentDir = resolvePiAgentDirectory(env, home);
  const routing = loadModelRoutingConfig(agentDir, piHomeAgentDirectory(home));
  return Object.freeze({
    agentDir,
    mode: parseRouteGateMode(env[ROUTE_GATE_VARIABLE]),
    routing: routing.ok
      ? Object.freeze({ ok: true as const, value: observeRoutingContext(routing.config, parentModelRefFromEnv(env), agentDir, env, ports) })
      : Object.freeze({ ok: false as const, error: routing.error }),
  });
}
