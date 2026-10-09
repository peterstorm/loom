/**
 * Resolve what a façade invocation emits under, at its composition root: the
 * immutable emission environment — the session run binding directory, the
 * parent harness and its session — from the environment variables alone, and,
 * separately, what a Pi parent's route gate reads (Pi's agent directory,
 * `LOOM_ROUTE_GATE`, `model-routing.json` and the parent model). The gate
 * facts carry the only I/O (the routing-config read), and only a Pi parent's
 * spawn batch asks for them (`core/spawn-emission-gate.ts`), so the shell
 * reads them on that request and never otherwise.
 */
import { piHomeAgentDirectory, resolvePiAgentDirectory } from "../core/pi-agent-directory";
import { parseRouteGateMode, ROUTE_GATE_VARIABLE } from "../core/route-reachability";
import {
  announcedParentHarness,
  type EmissionEnvironment,
  type EmissionParent,
  type PiRouteGateFacts,
} from "../core/spawn-emission-gate";
import { loadModelRoutingConfig, parentModelRefFromEnv } from "./model-routing-context";

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

function emissionParent(env: NodeJS.ProcessEnv): EmissionParent {
  const announced = announcedParentHarness(env);
  return announced === null
    ? Object.freeze({ harness: "unannounced" })
    : Object.freeze({ harness: announced.harness, sessionId: announced.sessionId });
}

/** The emission environment `source` describes: environment variables only, no I/O. */
export function resolveEmissionEnvironment(source: EmissionEnvironmentSource): EmissionEnvironment {
  return Object.freeze({ bindingDir: source.bindingDir, parent: emissionParent(source.env) });
}

/** What a Pi parent's route gate reads under `source`: its agent directory, gate mode and routing context, each as parsed. */
export function readPiRouteGateFacts({ env, home }: PiRouteGateSource): PiRouteGateFacts {
  const agentDir = resolvePiAgentDirectory(env, home);
  const routing = loadModelRoutingConfig(agentDir, piHomeAgentDirectory(home));
  return Object.freeze({
    agentDir,
    mode: parseRouteGateMode(env[ROUTE_GATE_VARIABLE]),
    routing: routing.ok
      ? Object.freeze({ ok: true as const, value: Object.freeze({ config: routing.config, parentRef: parentModelRefFromEnv(env) }) })
      : Object.freeze({ ok: false as const, error: routing.error }),
  });
}
