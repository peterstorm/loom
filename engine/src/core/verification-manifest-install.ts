/**
 * Pure decision core of `helper write-verification-manifest`.
 *
 * The helper installs the operator's Verification Manifest before Task
 * population. Two questions decide what it may do, and both are answered
 * here without I/O:
 *
 * - **Is the candidate the same authority as what is installed?** Authority is
 *   the parsed manifest, not its bytes. Both sides are canonicalized through
 *   `parseVerificationManifest` and the canonical JSON compared, so a manifest
 *   that differs only in whitespace or key layout is an idempotent replay,
 *   never a conflicting overwrite.
 * - **May different authority be replaced?** Only when the operator asked for
 *   it with `--replace`. The shell has already refused every mutation once
 *   Tasks are populated, so replacement is confined to the pre-population
 *   boundary where nothing has frozen the old commands.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { DomainResult } from "./orchestration-contract";
import { parseVerificationManifest } from "./verification-manifest";

/** Upper bound on a manifest source; anything larger is refused unparsed. */
export const MAX_MANIFEST_SOURCE_BYTES = 1_048_576;

/** The single flag the helper accepts. */
export const REPLACE_FLAG = "--replace" as const;

/** Canonical JSON text of a parsed, valid Verification Manifest. */
export type CanonicalManifest = string & { readonly __brand: "CanonicalManifest" };

/** Whether the operator authorized replacing different installed authority. */
export type ManifestInstallMode = "create-only" | "replace";

/** What the helper shell must do with the candidate manifest. */
export type ManifestInstallPlan =
  /** No manifest is installed: create it. */
  | Readonly<{ kind: "create"; manifest: CanonicalManifest }>
  /** The installed manifest is the same authority: change nothing. */
  | Readonly<{ kind: "unchanged" }>
  /** Different (or invalid) installed authority, and the operator asked to replace it. */
  | Readonly<{ kind: "replace"; manifest: CanonicalManifest }>
  /** Different (or invalid) installed authority, and no replacement was asked for. */
  | Readonly<{ kind: "refuse"; reason: string }>;

/**
 * Parse the helper's argv. Exactly `[]` or `["--replace"]`; anything else is
 * refused so a typo such as `--replce` can never silently mean create-only.
 */
export function parseManifestInstallArgs(
  args: readonly string[],
): DomainResult<ManifestInstallMode, string> {
  if (args.length === 0) return { ok: true, value: "create-only" };
  if (args.length === 1 && args[0] === REPLACE_FLAG) return { ok: true, value: "replace" };
  return {
    ok: false,
    error: `unexpected arguments ${JSON.stringify(args)}; expected none or ${REPLACE_FLAG}`,
  };
}

/** Parse manifest source text into its canonical form, or name why it is not a manifest. */
export function canonicalizeManifestSource(source: string): DomainResult<CanonicalManifest, string> {
  if (Buffer.byteLength(source, "utf-8") > MAX_MANIFEST_SOURCE_BYTES) {
    return { ok: false, error: `source exceeds ${MAX_MANIFEST_SOURCE_BYTES} bytes` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (cause) {
    return {
      ok: false,
      error: `source must be JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const parsed = parseVerificationManifest(raw);
  return parsed.ok
    ? { ok: true, value: `${JSON.stringify(parsed.value, null, 2)}\n` as CanonicalManifest }
    : { ok: false, error: parsed.error.errors.join("; ") };
}

/**
 * Decide the install for a valid candidate against what is installed.
 *
 * @param installed - The installed manifest's text, or `null` when none exists.
 */
export function planManifestInstall(
  installed: string | null,
  candidate: CanonicalManifest,
  mode: ManifestInstallMode,
  manifestPath: string,
): ManifestInstallPlan {
  if (installed === null) return { kind: "create", manifest: candidate };

  const current = canonicalizeManifestSource(installed);
  if (current.ok && current.value === candidate) return { kind: "unchanged" };
  if (mode === "replace") return { kind: "replace", manifest: candidate };

  return {
    kind: "refuse",
    reason: current.ok
      ? `${manifestPath} already exists with different authority; refusing overwrite ` +
        `(pass ${REPLACE_FLAG} to replace it before Task population)`
      : `${manifestPath} already exists but is not a valid verification manifest (${current.error}); ` +
        `refusing overwrite (pass ${REPLACE_FLAG} to replace it before Task population)`,
  };
}
