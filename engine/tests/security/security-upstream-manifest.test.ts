/**
 * The upstream validators are an ORACLE, so they are only worth what their bytes
 * are. `security-oracle.test.ts` and `security-coverage.test.ts` prove the pure
 * cores agree with `cloudflare/security-audit-skill@c1c8a8c` — a claim that is
 * silently false the moment someone "fixes" a vendored validator to match a
 * port's behaviour, because the differential test then compares the port with
 * itself.
 *
 * `MANIFEST.json` records the SHA-256 each vendored file must retain, the same
 * pin the lens taxonomy carries (`security-lens-manifest.test.ts`): editing an
 * oracle file, or re-vendoring without updating the manifest, fails here.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UPSTREAM_DIR = join(import.meta.dirname, "..", "fixtures", "security", "upstream");

type Manifest = Readonly<{
  upstream: Readonly<{ repository: string; commit: string; license: string }>;
  /** File name → SHA-256, as the manifest records it. */
  files: Readonly<Record<string, string>>;
}>;

const manifest = (): Manifest => JSON.parse(readFileSync(join(UPSTREAM_DIR, "MANIFEST.json"), "utf8")) as Manifest;

const digest = (name: string): string => createHash("sha256").update(readFileSync(join(UPSTREAM_DIR, name))).digest("hex");

/** The oracle set the differential tests load, plus the notice MIT requires. */
const ORACLE_FILES = ["LICENSE", "report-schema.json", "validate-coverage-ledger.cjs", "validate-findings.cjs"];

describe("vendored upstream validators", () => {
  it("re-digests every vendored file, so the oracle is still upstream's", () => {
    const entries = Object.entries(manifest().files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, sha256] of entries) {
      expect(digest(name), name).toBe(sha256);
    }
  });

  it("pins exactly the oracle files, and the directory holds nothing else", () => {
    expect(Object.keys(manifest().files).sort()).toEqual([...ORACLE_FILES].sort());
    expect(readdirSync(UPSTREAM_DIR).sort()).toEqual([...ORACLE_FILES, "MANIFEST.json"].sort());
  });

  it("pins the upstream revision the digests belong to", () => {
    const recorded = manifest();
    expect(recorded.upstream.repository).toBe("https://github.com/cloudflare/security-audit-skill");
    expect(recorded.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    // The short ref every provenance note cites must name this commit.
    expect(recorded.upstream.commit.startsWith("c1c8a8c")).toBe(true);
    expect(recorded.upstream.license).toBe("MIT");
  });

  it("agrees with the lens taxonomy about which upstream revision was vendored", () => {
    const lenses = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "references", "security-lenses", "MANIFEST.json"), "utf8")) as Manifest;
    expect(manifest().upstream.commit).toBe(lenses.upstream.commit);
  });
});
