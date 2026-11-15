/**
 * Which model a provider serves right now, decided from what the shell
 * observed (functional core: no I/O).
 *
 * A `served` routing target (`{ "served": "<provider>" }` in
 * `model-routing.json`) names no model: the child runs on whatever single
 * model the provider's server lists at `GET {baseUrl}/models`. Loom records
 * the exact binding every child launches on, so the target must resolve to
 * one exact provider/model before launch. The shell reads the provider from
 * Pi's `models.json`, resolves its key the way Pi does (a credential stored in
 * `auth.json` first, else the `models.json` `apiKey`), and probes the listing
 * with that key; this module turns those facts into the model or the typed
 * cause there is none (`core/served-model-cause.ts`). There is no fallback: a
 * provider that lists no model, several, or one Pi's catalog does not declare
 * leaves the target unresolved, and any rule that selects it refuses the
 * launch.
 *
 * The key itself never reaches this module, so no cause can carry it.
 */

import { match } from "ts-pattern";
import { parseModelRef, type ServedModel } from "./model-routing";
import type { RouteProbe } from "./route-reachability";
import type { ServedModelUnknownCause, UnusableKey } from "./served-model-cause";

/**
 * What the shell observed for one provider a served target depends on:
 * - `unreadable` — Pi's `models.json` or `auth.json` is present but cannot be
 *   read or parsed (`detail` names the file and the issue, never a value);
 * - `unconfigured` — `models.json` declares no `baseUrl` for the provider;
 * - `keyless` — it declares one, but no key the probe may send resolved;
 * - `probed` — the listing was requested with the key, against `url`, and
 *   `catalog` is every model id `models.json` declares for the provider.
 */
export type ServedProviderObservation =
  | Readonly<{ kind: "unreadable"; detail: string }>
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "keyless"; key: UnusableKey }>
  | Readonly<{ kind: "probed"; url: string; catalog: readonly string[]; probe: RouteProbe }>;

const unknown = (cause: ServedModelUnknownCause): ServedModel => Object.freeze({ kind: "unknown", cause: Object.freeze(cause) });

/** The model one served listing names, or why it names none. */
function decideListing(provider: string, url: string, catalog: readonly string[], probe: RouteProbe): ServedModel {
  if (probe.kind === "refused") return unknown({ kind: "unreachable", url, detail: probe.reason });
  const { status, servedModels } = probe;
  if (status === 401 || status === 403) return unknown({ kind: "key-refused", url, status });
  if (status < 200 || status > 299) return unknown({ kind: "error-status", url, status });
  if (servedModels === null) return unknown({ kind: "not-a-model-list", url, status });
  if (servedModels.length !== 1) return unknown({ kind: "not-one-model", url, served: Object.freeze([...servedModels]) });
  const [id] = servedModels;
  if (!catalog.includes(id)) return unknown({ kind: "undeclared-model", model: id });
  const ref = parseModelRef(`${provider}/${id}`);
  return ref.ok
    ? Object.freeze({ kind: "served", ref: ref.value })
    : unknown({ kind: "unrecordable-model", model: id, detail: ref.error.message });
}

/** The model `provider` serves now, or the typed cause it cannot be known. */
export function decideServedModel(provider: string, observation: ServedProviderObservation): ServedModel {
  return match(observation)
    .returnType<ServedModel>()
    .with({ kind: "unreadable" }, ({ detail }) => unknown({ kind: "unreadable-config", detail }))
    .with({ kind: "unconfigured" }, () => unknown({ kind: "no-base-url" }))
    .with({ kind: "keyless" }, ({ key }) => unknown({ kind: "no-usable-key", key }))
    .with({ kind: "probed" }, ({ url, catalog, probe }) => decideListing(provider, url, catalog, probe))
    .exhaustive();
}
