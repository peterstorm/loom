/**
 * Imperative shell for `served` routing targets: observes which model each
 * provider a served target names is serving right now, and hands the facts to
 * the pure decision in `core/served-model.ts`.
 *
 * Per provider it reads Pi's `models.json` in the active agent directory
 * (`baseUrl`, `apiKey`, the declared model ids), resolves the `apiKey` the way
 * Pi does (`core/pi-config-value.ts`: a `!` command, `$NAME` interpolation or
 * a literal), and requests `GET {baseUrl}/models` with it as
 * `Authorization: Bearer`. This is the one place Loom sends a provider
 * credential, and only to list a served provider's models (ADR-0023,
 * amended 2026-11-15). The key lives in this module's locals and the probe
 * child's environment: it is never logged, never put in a reason, an event
 * or a record, and never passed on a command line.
 *
 * The probe is synchronous. Every reader of the routing context — the
 * generated-agent validator, the render, the spawn route gate, the
 * interactive launcher and the emission route — is synchronous, and they
 * must all resolve a served target to the same model; a child process
 * (`process.execPath -e`, Node or Bun) performs the bounded HTTP request so
 * none of them has to become async.
 */

import { execSync, spawnSync } from "node:child_process";
import { z } from "zod";
import type { ServedModels } from "../core/model-routing";
import { parseConfigValueReference, resolveTemplate, templateVariables } from "../core/pi-config-value";
import { modelsUrl, type RouteProbe } from "../core/route-reachability";
import { decideServedModel, type MissingKey, type ServedProviderObservation } from "../core/served-model";
import { listedModels, readModelsProvider, ROUTE_PROBE_TIMEOUT_MS } from "./route-endpoint";

/**
 * The two effects a served observation performs, so tests substitute plain
 * fakes: running an `apiKey` command, and listing a provider's models with a
 * key.
 */
export type ServedProbePorts = Readonly<{
  /** Run an `apiKey` `!command` (without the `!`): its trimmed stdout, or null when it fails or prints nothing. */
  runKeyCommand: (command: string) => string | null;
  /** `GET url` with `Authorization: Bearer <apiKey>`, bounded by the probe timeout. */
  listModels: (url: string, apiKey: string) => RouteProbe;
}>;

/** How long Pi lets an `apiKey` command run (Pi's own resolver uses the same bound). */
const KEY_COMMAND_TIMEOUT_MS = 10_000;

/** Run a key command as Pi does: the default shell, stdout only, trimmed, empty is no value. */
function runKeyCommand(command: string): string | null {
  try {
    const output = execSync(command, { encoding: "utf-8", timeout: KEY_COMMAND_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const value = output.trim();
    return value === "" ? null : value;
  } catch {
    // A failing command is a missing key, reported as such; its output is
    // never shown because it may hold the key.
    return null;
  }
}

/**
 * The probe child: one bounded fetch, one JSON line on stdout. The URL, key
 * and timeout arrive in its environment, never in argv, so no process
 * listing shows the key.
 */
const PROBE_CHILD = `
const { LOOM_SERVED_PROBE_URL: url, LOOM_SERVED_PROBE_KEY: key, LOOM_SERVED_PROBE_TIMEOUT_MS: timeout } = process.env;
const write = (value) => process.stdout.write(JSON.stringify(value));
const text = (error) => {
  const cause = error instanceof Error && error.cause instanceof Error ? " (" + error.cause.message + ")" : "";
  return (error instanceof Error ? error.message : String(error)) + cause;
};
fetch(url, { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(Number(timeout)) })
  .then(async (response) => {
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return write({ kind: "answered", status: response.status, body: null }); }
    try { write({ kind: "answered", status: response.status, body: await response.text() }); }
    catch (error) { write({ kind: "refused", reason: "HTTP " + response.status + " body did not arrive: " + text(error) }); }
  })
  .catch((error) => write({ kind: "refused", reason: text(error) }));
`;

const probeChildOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answered"), status: z.number().int(), body: z.string().nullable() }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
]);

/** List a provider's models synchronously, through one bounded child process. */
export function childProcessListModels(timeoutMs: number = ROUTE_PROBE_TIMEOUT_MS): ServedProbePorts["listModels"] {
  return (url, apiKey) => {
    const child = spawnSync(process.execPath, ["-e", PROBE_CHILD], {
      encoding: "utf-8",
      env: { LOOM_SERVED_PROBE_URL: url, LOOM_SERVED_PROBE_KEY: apiKey, LOOM_SERVED_PROBE_TIMEOUT_MS: String(timeoutMs) },
      // The child's own fetch timeout fires first; this bound only stops a child that never exits.
      timeout: timeoutMs + 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (child.error !== undefined) return { kind: "refused", reason: `the probe process failed: ${child.error.message}` };
    let raw: unknown;
    try {
      raw = JSON.parse(child.stdout);
    } catch {
      return { kind: "refused", reason: `the probe process exited ${child.status ?? child.signal} without an answer` };
    }
    const parsed = probeChildOutput.safeParse(raw);
    if (!parsed.success) return { kind: "refused", reason: "the probe process answered in an unknown shape" };
    return parsed.data.kind === "refused"
      ? { kind: "refused", reason: parsed.data.reason }
      : { kind: "answered", status: parsed.data.status, servedModels: parsed.data.body === null ? null : listedModels(parsed.data.body) };
  };
}

/** The live ports: Pi's command semantics and the child-process listing. */
export const LIVE_SERVED_PROBE_PORTS: ServedProbePorts = Object.freeze({
  runKeyCommand,
  listModels: childProcessListModels(),
});

/** A provider's `apiKey` as Pi resolves it, or why there is none. */
export function resolveProviderApiKey(
  apiKey: string | null,
  env: Readonly<Record<string, string | undefined>>,
  run: ServedProbePorts["runKeyCommand"],
): Readonly<{ ok: true; key: string }> | Readonly<{ ok: false; missing: MissingKey }> {
  if (apiKey === null) return { ok: false, missing: { kind: "absent" } };
  const reference = parseConfigValueReference(apiKey);
  if (reference.kind === "command") {
    const key = run(reference.command);
    return key === null ? { ok: false, missing: { kind: "command-failed" } } : { ok: true, key };
  }
  const key = resolveTemplate(reference.parts, env);
  if (key !== null && key !== "") return { ok: true, key };
  const unset = templateVariables(reference.parts).filter((name) => (env[name] ?? "") === "");
  return { ok: false, missing: unset.length > 0 ? { kind: "unset-variables", names: unset } : { kind: "absent" } };
}

/** Observe one provider a served target depends on. */
function observeServedProvider(
  agentDir: string,
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
  ports: ServedProbePorts,
): ServedProviderObservation {
  const lookup = readModelsProvider(agentDir, provider);
  if (!lookup.ok) return { kind: "unreadable", reason: lookup.error };
  if (lookup.provider === null || lookup.provider.baseUrl === null) return { kind: "unconfigured" };
  const key = resolveProviderApiKey(lookup.provider.apiKey, env, ports.runKeyCommand);
  if (!key.ok) return { kind: "keyless", missing: key.missing };
  const url = modelsUrl({ provider, baseUrl: lookup.provider.baseUrl });
  return { kind: "probed", url, catalog: lookup.provider.catalog, probe: ports.listModels(url, key.key) };
}

/**
 * What each provider in `providers` serves now: one observation and one
 * decision per provider, so every rule that selects one of its served
 * targets resolves to the same model.
 */
export function observeServedModels(
  providers: readonly string[],
  agentDir: string,
  env: Readonly<Record<string, string | undefined>>,
  ports: ServedProbePorts,
): ServedModels {
  return Object.freeze(Object.fromEntries(
    providers.map((provider) => [provider, decideServedModel(provider, observeServedProvider(agentDir, provider, env, ports))]),
  ));
}
