/**
 * The one home of the "vendored means pinned" invariant. Every directory of
 * upstream bytes this repository carries — the lens taxonomy, the oracle
 * validators — records in `MANIFEST.json` the upstream revision and the
 * SHA-256 each file must retain. `verifyVendoredManifest` reads that manifest,
 * re-digests every listed file, and pins the upstream it names; each caller
 * then states only its OWN file set.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { isWireRecord } from "../../src/core/security-audit-contract";

export type VendoredManifest = Readonly<{
  upstream: Readonly<{ repository: string; commit: string; license: string }>;
  /** File name → SHA-256, as the manifest records it. */
  files: Readonly<Record<string, string>>;
}>;

/** The upstream every vendored directory is pinned to. */
export const VENDORED_UPSTREAM = Object.freeze({
  repository: "https://github.com/cloudflare/security-audit-skill",
  /** The short ref every provenance note cites. */
  shortCommit: "c1c8a8c",
  license: "MIT",
});

/** `dir/MANIFEST.json`, parsed: a malformed manifest fails here, naming the field. */
function readManifest(dir: string): VendoredManifest {
  const raw: unknown = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  if (!isWireRecord(raw) || !isWireRecord(raw.upstream) || !isWireRecord(raw.files)) {
    throw new Error(`${dir}/MANIFEST.json must hold an upstream object and a files object`);
  }
  const { repository, commit, license } = raw.upstream;
  if (typeof repository !== "string" || typeof commit !== "string" || typeof license !== "string") {
    throw new Error(`${dir}/MANIFEST.json upstream must name a repository, a commit and a license`);
  }
  const files = Object.entries(raw.files).map(([name, sha256]) => {
    if (typeof sha256 !== "string") throw new Error(`${dir}/MANIFEST.json files.${name} must be a SHA-256`);
    return [name, sha256] as const;
  });
  return { upstream: { repository, commit, license }, files: Object.fromEntries(files) };
}

/**
 * Prove `dir` is still the upstream it says it is: at least one file listed,
 * every listed file re-digesting to its recorded SHA-256, and the manifest
 * pinned to `VENDORED_UPSTREAM` at a full commit. Returns the manifest so the
 * caller can assert its own file set against it.
 */
export function verifyVendoredManifest(dir: string): VendoredManifest {
  const manifest = readManifest(dir);
  const entries = Object.entries(manifest.files);
  expect(entries.length).toBeGreaterThan(0);
  for (const [name, sha256] of entries) {
    expect(createHash("sha256").update(readFileSync(join(dir, name))).digest("hex"), name).toBe(sha256);
  }
  expect(manifest.upstream.repository).toBe(VENDORED_UPSTREAM.repository);
  expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(manifest.upstream.commit.startsWith(VENDORED_UPSTREAM.shortCommit)).toBe(true);
  expect(manifest.upstream.license).toBe(VENDORED_UPSTREAM.license);
  return manifest;
}
