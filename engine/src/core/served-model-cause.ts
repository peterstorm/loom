/**
 * Why a `served` routing target's model is unknown, as one closed union, and
 * the one place that union becomes operator-facing prose (functional core:
 * no I/O).
 *
 * The causes are produced in two places — the served-model decision
 * (`core/served-model.ts`, from what the shell observed) and the routing
 * policy (`core/model-routing.ts`, when the context holds no usable
 * observation) — and carried as data through `ServedModel` and
 * `RoutingPolicyError`, so a caller can discriminate on the cause instead of
 * parsing a sentence. `describeServedModelUnknown` renders each cause with its
 * remedy. No cause carries a provider key: the key never reaches the core.
 */

import { match } from "ts-pattern";

/** Which of Pi's files a provider key was read from. */
export type KeySource = "models-json" | "auth-json";

/** Why the shell holds no key it may send to list a provider's models. */
export type UnusableKey =
  /** Neither `auth.json` nor `models.json` holds a key for the provider. */
  | Readonly<{ kind: "absent" }>
  /** The key's template names environment variables that are unset or empty. */
  | Readonly<{ kind: "unset-variables"; source: KeySource; names: readonly string[] }>
  /** The key's `!command` failed or printed nothing. */
  | Readonly<{ kind: "command-failed"; source: KeySource }>
  /** `auth.json` stores a credential for the provider that carries no key
   *  (an `oauth` login, or an `api_key` entry without `key`); Pi then sends
   *  no key, and never falls back to `models.json`. */
  | Readonly<{ kind: "stored-credential-keyless"; credential: "api_key" | "oauth" }>
  /** The resolved key holds a character an HTTP header value may not (a
   *  line break, a control character, or one outside Latin-1). */
  | Readonly<{ kind: "not-a-header-value"; source: KeySource }>;

/** Why the model a provider serves is unknown. */
export type ServedModelUnknownCause =
  /** One of Pi's files is present but cannot be read or parsed; `detail` names the file and the issue, never a value. */
  | Readonly<{ kind: "unreadable-config"; detail: string }>
  | Readonly<{ kind: "no-base-url" }>
  | Readonly<{ kind: "no-usable-key"; key: UnusableKey }>
  | Readonly<{ kind: "unreachable"; url: string; detail: string }>
  | Readonly<{ kind: "key-refused"; url: string; status: number }>
  | Readonly<{ kind: "error-status"; url: string; status: number }>
  | Readonly<{ kind: "not-a-model-list"; url: string; status: number }>
  | Readonly<{ kind: "not-one-model"; url: string; served: readonly string[] }>
  | Readonly<{ kind: "undeclared-model"; model: string }>
  | Readonly<{ kind: "unrecordable-model"; model: string; detail: string }>
  /** The routing context holds no observation for the provider. */
  | Readonly<{ kind: "not-probed" }>
  /** The context's observation for the provider names another provider's model. */
  | Readonly<{ kind: "foreign-model"; provider: string; model: string }>;

const sourceName = (source: KeySource): string =>
  source === "auth-json" ? "the credential Pi's auth.json stores" : "the apiKey Pi's models.json declares";

const keyReason = (provider: string, key: UnusableKey): string =>
  match(key)
    .with({ kind: "absent" }, () =>
      `neither Pi's auth.json nor its models.json holds a key for provider '${provider}', and listing its served model needs one; add the provider's apiKey`)
    .with({ kind: "unset-variables" }, ({ source, names }) =>
      `${sourceName(source)} for provider '${provider}' names unset environment variable${names.length === 1 ? "" : "s"} ${names.join(", ")}; set ${names.length === 1 ? "it" : "them"}`)
    .with({ kind: "command-failed" }, ({ source }) =>
      `the key command in ${sourceName(source)} for provider '${provider}' failed or printed nothing; fix the command`)
    .with({ kind: "stored-credential-keyless" }, ({ credential }) =>
      `Pi's auth.json stores an ${credential} credential for provider '${provider}' that holds no key, and Pi sends no other; store the key with /login, or remove the entry so the models.json apiKey applies`)
    .with({ kind: "not-a-header-value" }, ({ source }) =>
      `${sourceName(source)} for provider '${provider}' resolves to a value an HTTP header cannot carry (a line break or control character); fix the key so it is one line`)
    .exhaustive();

/** The operator-facing reason, with its remedy, that `provider`'s served model is unknown. */
export function describeServedModelUnknown(provider: string, cause: ServedModelUnknownCause): string {
  return match(cause)
    .returnType<string>()
    .with({ kind: "unreadable-config" }, ({ detail }) => detail)
    .with({ kind: "no-base-url" }, () =>
      `Pi's models.json declares no baseUrl for provider '${provider}'; declare it, or route the child to an exact model`)
    .with({ kind: "no-usable-key" }, ({ key }) => keyReason(provider, key))
    .with({ kind: "unreachable" }, ({ url, detail }) => `cannot reach provider '${provider}' at ${url}: ${detail}; bring it up`)
    .with({ kind: "key-refused" }, ({ url, status }) =>
      `${url} refused the key Loom resolved for provider '${provider}' (HTTP ${status}); fix the key`)
    .with({ kind: "error-status" }, ({ url, status }) => `${url} answered HTTP ${status}; bring provider '${provider}' up`)
    .with({ kind: "not-a-model-list" }, ({ url, status }) => `${url} answered HTTP ${status} without an OpenAI-style model list`)
    .with({ kind: "not-one-model" }, ({ url, served }) =>
      `${url} lists ${served.length} models (${served.join(", ") || "none"}); a served target needs exactly one — serve one model, or route the child to an exact model`)
    .with({ kind: "undeclared-model" }, ({ model }) =>
      `provider '${provider}' serves '${model}', which Pi's models.json does not declare for it; add it to the provider's models`)
    .with({ kind: "unrecordable-model" }, ({ model, detail }) =>
      `provider '${provider}' serves '${model}', which is not a recordable provider/model ref: ${detail}`)
    .with({ kind: "not-probed" }, () => "the routing context did not probe it")
    .with({ kind: "foreign-model" }, ({ provider: other, model }) =>
      `the probe answered ${other}/${model}, a model of another provider`)
    .exhaustive();
}
