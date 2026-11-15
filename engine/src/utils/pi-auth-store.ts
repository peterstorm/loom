/**
 * Imperative shell: reads the credential Pi's `auth.json` stores for one
 * provider, parsed into `core/provider-key.ts`'s {@link StoredCredential}.
 *
 * The file is validated the way Pi validates it (a leading BOM stripped; an
 * object keyed by provider; every entry an `api_key` entry with an optional
 * string `key` and an optional string-valued `env`, or an `oauth` entry with
 * string `access` and `refresh` and a finite `expires`), so a file Pi would
 * refuse never reads here as "no credential". An absent file is no
 * credential. Errors name the file, the provider and the issue, never a
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

const authFileSchema = z.record(z.string(), z.discriminatedUnion("type", [apiKeyEntry, oauthEntry]));

export type StoredCredentialLookup =
  | Readonly<{ ok: true; credential: StoredCredential | null }>
  | Readonly<{ ok: false; error: string }>;

/** Where an `auth.json` issue sits, by provider: never the offending value. */
function issueText(path: string, issue: z.core.$ZodIssue): string {
  const [provider, field] = issue.path;
  if (provider === undefined) return `invalid ${path}: expected an object keyed by provider`;
  const where = field === undefined ? "" : ` (field ${String(field)})`;
  return `invalid ${path}: the credential for provider "${String(provider)}" is not an api_key or oauth entry Pi accepts${where}`;
}

/**
 * The credential `<agentDir>/auth.json` stores for `provider`: null when the
 * file is absent or stores none, an error when it is unreadable, not JSON, or
 * holds an entry Pi would refuse.
 */
export function readStoredCredential(agentDir: string, provider: string): StoredCredentialLookup {
  const path = join(agentDir, "auth.json");
  const file = readSecretJsonFile(path);
  if (file.kind === "absent") return { ok: true, credential: null };
  if (file.kind === "error") return { ok: false, error: file.error };
  const parsed = authFileSchema.safeParse(file.value);
  if (!parsed.success) return { ok: false, error: issueText(path, parsed.error.issues[0]) };
  const entry = Object.hasOwn(parsed.data, provider) ? parsed.data[provider] : undefined;
  if (entry === undefined) return { ok: true, credential: null };
  return {
    ok: true,
    credential: entry.type === "oauth"
      ? Object.freeze({ type: "oauth" })
      : Object.freeze({ type: "api_key", key: entry.key ?? null, env: Object.freeze({ ...(entry.env ?? {}) }) }),
  };
}
