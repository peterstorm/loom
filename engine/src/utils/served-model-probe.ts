/**
 * Imperative shell for `served` routing targets: observes which model each
 * provider a served target names is serving right now, and hands the facts to
 * the pure decision in `core/served-model.ts`.
 *
 * Per provider it reads Pi's `models.json` in the active agent directory
 * (`baseUrl`, `apiKey`, the declared model ids) and `auth.json` beside it,
 * picks the key Pi would send (`core/provider-key.ts`: a credential stored in
 * `auth.json` first, else the `models.json` `apiKey`), resolves it in Pi's
 * config-value grammar (`core/pi-config-value.ts`: a `!` command, `$NAME`
 * interpolation or a literal), and requests `GET {baseUrl}/models` with it as
 * `Authorization: Bearer`. This is the one place Loom sends a provider
 * credential, and only to list a served provider's models (ADR-0023,
 * amended 2026-11-15).
 *
 * The key lives in this module's locals and the probe child's environment.
 * It is never logged, never put in a cause, an event or a record, and never
 * passed on a command line. A key no HTTP header can carry is refused before
 * the request (`fetch` would quote it in its error); the request follows no
 * redirect, so the key reaches only the configured `baseUrl`; and every text
 * that comes back — a refusal, each listed model id — is scrubbed of the key
 * before the decision sees it.
 *
 * The probe is synchronous. Every reader of the routing context — the
 * generated-agent validator, the render, the spawn route gate, the
 * interactive launcher and spawn admission — is synchronous, and they
 * must all resolve a served target to the same model; a child process
 * (`process.execPath -e`, Node or Bun) performs the bounded HTTP request so
 * none of them has to become async. The live ports reuse a listing and a
 * key command's output for {@link SERVED_OBSERVATION_TTL_MS}, so the readers
 * of one launch agree without each probing, and a long-lived process still
 * sees the operator switch the served model within that window.
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServedModels } from "../core/model-routing";
import { resolveTemplate, templateVariables } from "../core/pi-config-value";
import {
  isHeaderValue,
  overlaidEnvironment,
  planProviderKey,
  scrubSecret,
  type ProviderKeyPlan,
  type StoredCredential,
} from "../core/provider-key";
import { modelsUrl, type RouteProbe } from "../core/route-reachability";
import { decideServedModel, type ServedProviderObservation } from "../core/served-model";
import type { UnusableKey } from "../core/served-model-cause";
import { readStoredCredential } from "./pi-auth-store";
import { listedModels, readModelsProvider, ROUTE_PROBE_TIMEOUT_MS } from "./route-endpoint";

/**
 * The two effects a served observation performs, so tests substitute plain
 * fakes: running a key command, and listing a provider's models with a key.
 */
export type ServedProbePorts = Readonly<{
  /** Run a key `!command` (without the `!`): its trimmed stdout, or null when it fails or prints nothing. */
  runKeyCommand: (command: string) => string | null;
  /** `GET url` with `Authorization: Bearer <apiKey>`, bounded by the probe timeout, following no redirect. */
  listModels: (url: string, apiKey: string) => RouteProbe;
}>;

/** How long Pi lets a key command run (Pi's own resolver uses the same bound). */
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
 * The probe child: one bounded fetch that follows no redirect, one JSON line
 * on stdout. The URL, key and timeout arrive in its environment, never in
 * argv, so no process listing shows the key. Its refusal text is scrubbed of
 * the key by the parent (`childProcessListModels`).
 */
const PROBE_CHILD = `
const { LOOM_SERVED_PROBE_URL: url, LOOM_SERVED_PROBE_KEY: key, LOOM_SERVED_PROBE_TIMEOUT_MS: timeout } = process.env;
const write = (value) => process.stdout.write(JSON.stringify(value));
const text = (error) => {
  const cause = error instanceof Error && error.cause instanceof Error ? " (" + error.cause.message + ")" : "";
  return (error instanceof Error ? error.message : String(error)) + cause;
};
fetch(url, { headers: { Authorization: "Bearer " + key }, redirect: "error", signal: AbortSignal.timeout(Number(timeout)) })
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

/** One child-process listing, before its refusal text is scrubbed. */
function spawnListing(url: string, apiKey: string, timeoutMs: number): RouteProbe {
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
}

/**
 * List a provider's models synchronously, through one bounded child process.
 * A key no header can carry is refused without a request; a refusal's text
 * never holds the key.
 */
export function childProcessListModels(timeoutMs: number = ROUTE_PROBE_TIMEOUT_MS): ServedProbePorts["listModels"] {
  return (url, apiKey) => {
    if (!isHeaderValue(apiKey)) return { kind: "refused", reason: "the key is not a valid HTTP header value; it was not sent" };
    const probe = spawnListing(url, apiKey, timeoutMs);
    return probe.kind === "refused" ? { kind: "refused", reason: scrubSecret(probe.reason, apiKey) } : probe;
  };
}

/** How long the live ports reuse a listing, or a key command's output. */
export const SERVED_OBSERVATION_TTL_MS = 30_000;

/** A key's fingerprint, so a cache entry is keyed by the key without holding it. */
const fingerprint = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * `ports` with their answers reused for `ttlMs` by the clock `now`: a
 * listing per URL and key (its every outcome, so the readers within one
 * window all see the same answer), and a key command's output per command
 * (only a success — a failing command runs again next time, so fixing it
 * takes effect at once). Pi caches a stored credential's command output for
 * its whole process; the window here also lets a rotated key take effect.
 */
export function memoizedProbePorts(
  ports: ServedProbePorts,
  now: () => number = Date.now,
  ttlMs: number = SERVED_OBSERVATION_TTL_MS,
): ServedProbePorts {
  const listings = new Map<string, Readonly<{ at: number; probe: RouteProbe }>>();
  const commands = new Map<string, Readonly<{ at: number; value: string }>>();
  const fresh = (at: number): boolean => now() - at < ttlMs;
  // Every call drops what has expired, so a key that changes on every
  // command run grows neither map, and no key output outlives its window.
  const evictExpired = (): void => {
    for (const cache of [listings, commands]) for (const [id, entry] of cache) if (!fresh(entry.at)) cache.delete(id);
  };
  return Object.freeze({
    runKeyCommand: (command) => {
      evictExpired();
      const cached = commands.get(command);
      if (cached !== undefined && fresh(cached.at)) return cached.value;
      const value = ports.runKeyCommand(command);
      if (value === null) commands.delete(command);
      else commands.set(command, Object.freeze({ at: now(), value }));
      return value;
    },
    listModels: (url, apiKey) => {
      evictExpired();
      const id = `${url}\u0000${fingerprint(apiKey)}`;
      const cached = listings.get(id);
      if (cached !== undefined && fresh(cached.at)) return cached.probe;
      const probe = ports.listModels(url, apiKey);
      listings.set(id, Object.freeze({ at: now(), probe }));
      return probe;
    },
  });
}

/** The live ports: Pi's command semantics and the child-process listing, each reused for {@link SERVED_OBSERVATION_TTL_MS}. */
export const LIVE_SERVED_PROBE_PORTS: ServedProbePorts = memoizedProbePorts({
  runKeyCommand,
  listModels: childProcessListModels(),
});

export type ResolvedProviderKey =
  | Readonly<{ ok: true; key: string }>
  | Readonly<{ ok: false; unusable: UnusableKey }>;

/**
 * The key Pi would send to `provider`, resolved: the credential `auth.json`
 * stores (`stored`), else the `models.json` `apiKey`, in Pi's grammar against
 * `env` (a stored entry's own `env` read first). A key no HTTP header can
 * carry is unusable, so it is never sent.
 */
export function resolveProviderApiKey(
  stored: StoredCredential | null,
  modelsApiKey: string | null,
  env: Readonly<Record<string, string | undefined>>,
  run: ServedProbePorts["runKeyCommand"],
): ResolvedProviderKey {
  const plan = planProviderKey(stored, modelsApiKey);
  if (plan.kind === "unusable") return { ok: false, unusable: plan.key };
  const resolved = resolvePlannedKey(plan, env, run);
  return !resolved.ok || isHeaderValue(resolved.key)
    ? resolved
    : { ok: false, unusable: { kind: "not-a-header-value", source: plan.source } };
}

/** A planned key's value: its command's output, or its template under `env` with the plan's overlay. */
function resolvePlannedKey(
  { source, reference, overlay }: Extract<ProviderKeyPlan, { kind: "resolve" }>,
  env: Readonly<Record<string, string | undefined>>,
  run: ServedProbePorts["runKeyCommand"],
): ResolvedProviderKey {
  if (reference.kind === "command") {
    const key = run(reference.command);
    return key === null ? { ok: false, unusable: { kind: "command-failed", source } } : { ok: true, key };
  }
  const lookup = overlaidEnvironment(env, overlay);
  const key = resolveTemplate(reference.parts, lookup);
  if (key !== null && key !== "") return { ok: true, key };
  const unset = templateVariables(reference.parts).filter((name) => (lookup[name] ?? "") === "");
  return { ok: false, unusable: unset.length > 0 ? { kind: "unset-variables", source, names: unset } : { kind: "absent" } };
}

/** Observe one provider a served target depends on. */
function observeServedProvider(
  agentDir: string,
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
  ports: ServedProbePorts,
): ServedProviderObservation {
  const lookup = readModelsProvider(agentDir, provider);
  if (!lookup.ok) return { kind: "unreadable", detail: lookup.error };
  if (lookup.provider === null || lookup.provider.baseUrl === null) return { kind: "unconfigured" };
  const stored = readStoredCredential(agentDir, provider);
  if (!stored.ok) return { kind: "unreadable", detail: stored.error };
  const key = resolveProviderApiKey(stored.credential, lookup.provider.apiKey, env, ports.runKeyCommand);
  if (!key.ok) return { kind: "keyless", key: key.unusable };
  const url = modelsUrl({ provider, baseUrl: lookup.provider.baseUrl });
  const probe = withoutKey(ports.listModels(url, key.key), key.key);
  return { kind: "probed", url: scrubSecret(url, key.key), catalog: lookup.provider.catalog, probe };
}

/**
 * A probe with the key scrubbed from every text the server or the probe
 * returned: a refusal's reason, and each listed model id — a server may echo
 * the bearer token as an id, and a listed id reaches causes, refusals and
 * records. An id that held the key no longer matches the catalog, so it
 * resolves to no model.
 */
function withoutKey(probe: RouteProbe, key: string): RouteProbe {
  if (probe.kind === "refused") return { kind: "refused", reason: scrubSecret(probe.reason, key) };
  return probe.servedModels === null ? probe : { ...probe, servedModels: probe.servedModels.map((id) => scrubSecret(id, key)) };
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
