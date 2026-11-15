/**
 * Which model a provider serves right now, decided from what the shell
 * observed (functional core: no I/O).
 *
 * A `served` routing target (`{ "served": "<provider>" }` in
 * `model-routing.json`) names no model: the child runs on whatever single
 * model the provider's server lists at `GET {baseUrl}/models`. Loom records
 * the exact binding every child launches on, so the target must resolve to
 * one exact provider/model before launch. The shell reads the provider from
 * Pi's `models.json`, resolves its `apiKey` the way Pi does, and probes the
 * listing with that key; this module turns those facts into the model or the
 * operator-facing reason there is none. There is no fallback: a provider that
 * lists no model, several, or one Pi's catalog does not declare leaves the
 * target unresolved, and any rule that selects it refuses the launch.
 *
 * The key itself never reaches this module, so no reason can carry it.
 */

import { match } from "ts-pattern";
import { parseModelRef, type ServedModel } from "./model-routing";
import type { RouteProbe } from "./route-reachability";

/** Why the shell holds no key to list a provider's models with. */
export type MissingKey =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unset-variables"; names: readonly string[] }>
  | Readonly<{ kind: "command-failed" }>;

/**
 * What the shell observed for one provider a served target depends on:
 * - `unreadable` — Pi's `models.json` is present but cannot be read or parsed;
 * - `unconfigured` — it declares no `baseUrl` for the provider;
 * - `keyless` — it declares one, but no key could be resolved for it;
 * - `probed` — the listing was requested with the key, against `url`, and
 *   `catalog` is every model id `models.json` declares for the provider.
 */
export type ServedProviderObservation =
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "keyless"; missing: MissingKey }>
  | Readonly<{ kind: "probed"; url: string; catalog: readonly string[]; probe: RouteProbe }>;

const unknown = (reason: string): ServedModel => Object.freeze({ kind: "unknown", reason });

const missingKeyReason = (provider: string, missing: MissingKey): string =>
  match(missing)
    .with({ kind: "absent" }, () =>
      `Pi's models.json declares no apiKey for provider '${provider}', and listing its served model needs one; add the provider's apiKey`)
    .with({ kind: "unset-variables" }, ({ names }) =>
      `the apiKey Pi's models.json declares for provider '${provider}' names unset environment variable${names.length === 1 ? "" : "s"} ${names.join(", ")}; set ${names.length === 1 ? "it" : "them"}`)
    .with({ kind: "command-failed" }, () =>
      `the apiKey command Pi's models.json declares for provider '${provider}' failed or printed nothing; fix the command`)
    .exhaustive();

/** The model one served listing names, or why it names none. */
function decideListing(provider: string, url: string, catalog: readonly string[], probe: RouteProbe): ServedModel {
  if (probe.kind === "refused") return unknown(`cannot reach provider '${provider}' at ${url}: ${probe.reason}; bring it up`);
  const { status, servedModels } = probe;
  if (status === 401 || status === 403) {
    return unknown(`${url} refused the apiKey Pi's models.json declares for provider '${provider}' (HTTP ${status}); fix the key`);
  }
  if (status < 200 || status > 299) return unknown(`${url} answered HTTP ${status}; bring provider '${provider}' up`);
  if (servedModels === null) return unknown(`${url} answered HTTP ${status} without an OpenAI-style model list`);
  if (servedModels.length !== 1) {
    return unknown(
      `${url} lists ${servedModels.length} models (${servedModels.join(", ") || "none"}); a served target needs exactly one — serve one model, or route the child to an exact model`,
    );
  }
  const [id] = servedModels;
  if (!catalog.includes(id)) {
    return unknown(`provider '${provider}' serves '${id}', which Pi's models.json does not declare for it; add it to the provider's models`);
  }
  const ref = parseModelRef(`${provider}/${id}`);
  return ref.ok
    ? Object.freeze({ kind: "served", ref: ref.value })
    : unknown(`provider '${provider}' serves '${id}', which is not a recordable provider/model ref: ${ref.error.message}`);
}

/** The model `provider` serves now, or the operator-facing reason it cannot be known. */
export function decideServedModel(provider: string, observation: ServedProviderObservation): ServedModel {
  return match(observation)
    .returnType<ServedModel>()
    .with({ kind: "unreadable" }, ({ reason }) => unknown(reason))
    .with({ kind: "unconfigured" }, () =>
      unknown(`Pi's models.json declares no baseUrl for provider '${provider}'; declare it, or route the child to an exact model`))
    .with({ kind: "keyless" }, ({ missing }) => unknown(missingKeyReason(provider, missing)))
    .with({ kind: "probed" }, ({ url, catalog, probe }) => decideListing(provider, url, catalog, probe))
    .exhaustive();
}
