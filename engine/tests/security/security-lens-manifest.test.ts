/**
 * The taxonomy is VENDORED, not paraphrased (ADR-0066 D5): every lens is
 * byte-identical to `cloudflare/security-audit-skill@c1c8a8c`, and `MANIFEST.json`
 * records the SHA-256 each file must retain.
 *
 * This test is the guard three documents promised and none had: editing a lens
 * body, or re-vendoring without updating the manifest, fails here rather than
 * silently changing what a hunter reads. The digest and pin checks are the
 * shared `verifyVendoredManifest`; this file states the lens set.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_LENSES } from "../../src/core/security-lenses";
import { verifyVendoredManifest } from "./vendored-manifest";

const LENS_DIR = join(import.meta.dirname, "..", "..", "..", "references", "security-lenses");

/** Loom-authored documents in the lens directory: provenance and Loom-specific
 *  guidance, never upstream bytes, so they carry no digest. */
const LOOM_NOTES: readonly string[] = ["ATTRIBUTION.md", "LOOM-DELTAS.md"];

describe("vendored lens taxonomy", () => {
  it("re-digests every vendored file and pins the upstream revision, so 'vendored' stays true", () => {
    verifyVendoredManifest(LENS_DIR);
  });

  it("lists exactly the lens documents the selector can name", () => {
    // Every name the selector can hand a hunter must exist on disk AND be
    // digest-pinned; ATTRIBUTION.md is Loom's own provenance note, not upstream.
    expect(Object.keys(verifyVendoredManifest(LENS_DIR).files).sort()).toEqual([...SECURITY_LENSES].sort());
  });

  it("keeps the directory free of unlisted files of its own", () => {
    // Loom's own notes sit beside the vendored files by design (ATTRIBUTION.md
    // says where Loom guidance lives); every OTHER `.md` must be digest-pinned.
    const onDisk = readdirSync(LENS_DIR).filter((name) => name.endsWith(".md") && !LOOM_NOTES.includes(name)).sort();
    expect(onDisk).toEqual(Object.keys(verifyVendoredManifest(LENS_DIR).files).sort());
  });
});
