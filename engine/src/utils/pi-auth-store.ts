/**
 * Imperative shell: reads the credential Pi's `auth.json` stores for one
 * provider, parsed into `core/provider-key.ts`'s {@link StoredCredential}.
 *
 * Pi's session runtime (its AuthStorage) parses the file as JSON (a leading BOM
 * stripped) and reads the requested provider's entry, validating nothing
 * else; an unrelated provider's entry never stops it. So only the requested
 * entry is parsed here: an `api_key` entry with an optional string `key` and
 * an optional string-valued `env`, or an `oauth` entry with string `access`
 * and `refresh` and a finite `expires`. Where Pi's own answer depends on more
 * than the file — a file that is not JSON (Pi keeps its last good snapshot),
 * a top level that is not an object, or a requested entry of another shape —
 * the read fails closed rather than guess the key. An absent file or entry is
 * no credential. Errors name the file, the provider and the issue, never a
 * value: the file holds keys and tokens.
 */

import { join } from "node:path";
import { z } from "zod";
import type { StoredCredential } from "../core/provider-key";
import { readSecretJsonFile } from "./secret-json-file";

const apiKeyEntry = z.object({
  type: z.literal("api_key"),
  key: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const oauthEntry = z.object({
  type: z.literal("oauth"),
  access: z.string(),
  refresh: z.string(),
  expires: z.number().finite(),
});

/** The file's top level: entries keyed by provider, each read only when asked for. */
const authFileSchema = z.record(z.string(), z.unknown());

const credentialEntry = z.discriminatedUnion("type", [apiKeyEntry, oauthEntry]);

export type StoredCredentialLookup =
  | Readonly<{ ok: true; credential: StoredCredential | null }>
  | Readonly<{ ok: false; error: string }>;

/** Where the requested entry's issue sits: never the offending value. */
function entryIssueText(path: string, provider: string, issue: z.core.$ZodIssue | undefined): string {
  const field = issue?.path[0];
  const where = field === undefined ? "" : ` (field ${String(field)})`;
  return `invalid ${path}: the credential for provider "${provider}" is not an api_key or oauth entry Pi accepts${where}`;
}

/**
 * The credential `<agentDir>/auth.json` stores for `provider`: null when the
 * file is absent or stores none, an error when it is unreadable, not JSON, not
 * an object keyed by provider, or stores an entry for `provider` of a shape
 * Pi does not accept. Entries for other providers are not read.
 */
export function readStoredCredential(agentDir: string, provider: string): StoredCredentialLookup {
  const path = join(agentDir, "auth.json");
  const file = readSecretJsonFile(path);
  if (file.kind === "absent") return { ok: true, credential: null };
  if (file.kind === "error") return { ok: false, error: file.error };
  const entries = authFileSchema.safeParse(file.value);
  if (!entries.success) return { ok: false, error: `invalid ${path}: expected an object keyed by provider` };
  if (!Object.hasOwn(entries.data, provider)) return { ok: true, credential: null };
  const entry = credentialEntry.safeParse(entries.data[provider]);
  if (!entry.success) return { ok: false, error: entryIssueText(path, provider, entry.error.issues[0]) };
  const credential = entry.data;
  return {
    ok: true,
    credential: credential.type === "oauth"
      ? Object.freeze({ type: "oauth" })
      : Object.freeze({ type: "api_key", key: credential.key ?? null, env: Object.freeze({ ...(credential.env ?? {}) }) }),
  };
}
