/**
 * The taxonomy is VENDORED, not paraphrased (ADR-0064 D5): every lens is
 * byte-identical to `cloudflare/security-audit-skill@c1c8a8c`, and `MANIFEST.json`
 * records the SHA-256 each file must retain.
 *
 * This test is the guard three documents promised and none had: editing a lens
 * body, or re-vendoring without updating the manifest, fails here rather than
 * silently changing what a hunter reads.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_LENSES } from "../../src/core/security-lens-select";

const LENS_DIR = join(import.meta.dirname, "..", "..", "..", "references", "security-lenses");

type Manifest = Readonly<{
  upstream: Readonly<{ repository: string; commit: string; license: string }>;
  /** Path → SHA-256, as the manifest records it. */
  files: Readonly<Record<string, string>>;
}>;

const manifest = (): Manifest => JSON.parse(readFileSync(join(LENS_DIR, "MANIFEST.json"), "utf8")) as Manifest;

const digest = (path: string): string => createHash("sha256").update(readFileSync(join(LENS_DIR, path))).digest("hex");

describe("vendored lens taxonomy", () => {
  it("re-digests every vendored file, so 'vendored' stays true", () => {
    const recorded = manifest();
    const entries = Object.entries(recorded.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, sha256] of entries) {
      expect(digest(name), name).toBe(sha256);
    }
  });

  it("lists exactly the lens documents the selector can name", () => {
    // Every name the selector can hand a hunter must exist on disk AND be
    // digest-pinned; ATTRIBUTION.md is Loom's own provenance note, not upstream.
    const recorded = Object.keys(manifest().files).sort();
    expect(recorded).toEqual([...SECURITY_LENSES].sort());
  });

  it("keeps the directory free of unlisted files of its own", () => {
    const onDisk = readdirSync(LENS_DIR).filter((name) => name.endsWith(".md") && name !== "ATTRIBUTION.md").sort();
    const listed = Object.keys(manifest().files).sort();
    expect(onDisk).toEqual(listed);
  });

  it("pins the upstream revision the digests belong to", () => {
    const recorded = manifest();
    expect(recorded.upstream.repository).toBe("https://github.com/cloudflare/security-audit-skill");
    expect(recorded.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(recorded.upstream.license).toBe("MIT");
  });
});
