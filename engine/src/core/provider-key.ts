/**
 * Which key Pi would send to a custom provider, decided from Pi's two config
 * files, and the two guards on a resolved key before Loom sends it anywhere
 * (functional core: no I/O).
 *
 * Pi (1.5.2, the API-key auth its provider composer builds) resolves a custom
 * provider's key in this order:
 *
 * 1. a credential `auth.json` stores for the provider wins outright: an
 *    `api_key` entry with a non-empty `key` is that key (Pi's config-value
 *    grammar, its `$NAME` lookups reading the entry's own `env` before the
 *    process environment); an `api_key` entry without a key, or an `oauth`
 *    entry, sends no key at all — Pi never falls back to `models.json` once
 *    a credential is stored;
 * 2. otherwise the provider's `models.json` `apiKey`, in the same grammar,
 *    against the process environment.
 *
 * {@link planProviderKey} is that order; the shell (`utils/served-model-probe.ts`)
 * runs the command or reads the environment it names. {@link isHeaderValue}
 * refuses a key no HTTP header can carry before it reaches `fetch` (whose
 * error would echo the value), and {@link scrubSecret} removes a key from any
 * text that leaves the shell.
 */

import { parseConfigValueReference, type ConfigValueReference } from "./pi-config-value";
import type { KeySource, UnusableKey } from "./served-model-cause";

/**
 * A credential Pi's `auth.json` stores for one provider, as parsed: an
 * `api_key` entry (its raw `key` in Pi's grammar, null when the entry holds
 * none, and the entry's `env` overlay), or an `oauth` login (whose tokens
 * Loom never reads).
 */
export type StoredCredential =
  | Readonly<{ type: "api_key"; key: string | null; env: Readonly<Record<string, string>> }>
  | Readonly<{ type: "oauth" }>;

/** The key Pi would send: a config value to resolve, from one file, or why there is none. */
export type ProviderKeyPlan =
  | Readonly<{
      kind: "resolve";
      source: KeySource;
      reference: ConfigValueReference;
      /** Variables a template reads before the process environment (an `auth.json` entry's `env`). */
      overlay: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "unusable"; key: UnusableKey }>;

const NO_OVERLAY: Readonly<Record<string, string>> = Object.freeze({});

/** Pi's precedence for a custom provider's key: a stored credential, else the `models.json` `apiKey`. */
export function planProviderKey(stored: StoredCredential | null, modelsApiKey: string | null): ProviderKeyPlan {
  if (stored !== null) {
    if (stored.type === "oauth") return Object.freeze({ kind: "unusable", key: Object.freeze({ kind: "stored-credential-keyless", credential: "oauth" }) });
    if (stored.key === null || stored.key === "") {
      return Object.freeze({ kind: "unusable", key: Object.freeze({ kind: "stored-credential-keyless", credential: "api_key" }) });
    }
    return Object.freeze({ kind: "resolve", source: "auth-json", reference: parseConfigValueReference(stored.key), overlay: stored.env });
  }
  if (modelsApiKey === null) return Object.freeze({ kind: "unusable", key: Object.freeze({ kind: "absent" }) });
  return Object.freeze({ kind: "resolve", source: "models-json", reference: parseConfigValueReference(modelsApiKey), overlay: NO_OVERLAY });
}

/**
 * The environment a template resolves against: the overlay's non-empty
 * values over `env`. Pi reads `overlay[name] || env[name]`, so an empty
 * overlay value falls through to the process environment.
 */
export function overlaidEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  overlay: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({ ...env, ...Object.fromEntries(Object.entries(overlay).filter(([, value]) => value !== "")) });
}

/**
 * Whether `value` can be sent as an HTTP header value: non-empty, and only
 * tab, visible ASCII, space and Latin-1 — no line break, NUL or other control
 * character, nothing above U+00FF. `fetch` rejects anything else with an
 * error that quotes the value, so such a key is refused before the request.
 */
export function isHeaderValue(value: string): boolean {
  return value !== "" && /^[\t\x20-\x7E\x80-\xFF]*$/.test(value);
}

/** What stands in for a removed secret. Shorter than every needle it replaces, so scrubbing terminates. */
const REDACTED = "***";
/** The shortest piece of a multi-line secret worth removing on its own. */
const MIN_FRAGMENT = 4;

/**
 * The forms a secret can take in an error text: itself, JSON-escaped,
 * percent-encoded, and each of its lines long enough to identify it.
 */
function secretNeedles(secret: string): readonly string[] {
  // A lone surrogate has no percent-encoding (encodeURIComponent throws); such a secret has no encoded form to find.
  const percentEncoded = secret.isWellFormed() ? encodeURIComponent(secret) : secret;
  const forms = [secret, JSON.stringify(secret).slice(1, -1), percentEncoded];
  const lines = secret.split(/[\r\n]+/).filter((line) => line.length >= MIN_FRAGMENT);
  return [...new Set([...forms, ...lines])].filter((needle) => needle !== "").sort((a, b) => b.length - a.length);
}

/**
 * `text` with every occurrence of `secret` in any of its forms removed.
 * Replacing can splice a new occurrence out of the text around it, so it
 * repeats until no form occurs; each pass shrinks the text (a needle shorter
 * than the marker is deleted outright), so it ends.
 */
export function scrubSecret(text: string, secret: string): string {
  if (secret === "") return text;
  const needles = secretNeedles(secret);
  let scrubbed = text;
  for (;;) {
    const next = needles.reduce(
      (current, needle) => current.split(needle).join(needle.length > REDACTED.length ? REDACTED : ""),
      scrubbed,
    );
    if (next === scrubbed) return scrubbed;
    scrubbed = next;
  }
}
