/**
 * The upstream validators are an ORACLE, so they are only worth what their bytes
 * are. `security-oracle.test.ts` and `security-coverage.test.ts` prove the pure
 * cores agree with `cloudflare/security-audit-skill@c1c8a8c` — a claim that is
 * silently false the moment someone "fixes" a vendored validator to match a
 * port's behaviour, because the differential test then compares the port with
 * itself.
 *
 * `MANIFEST.json` records the SHA-256 each vendored file must retain, the same
 * pin the lens taxonomy carries (`security-lens-manifest.test.ts`), both
 * checked by `verifyVendoredManifest`: editing an oracle file, or re-vendoring
 * without updating the manifest, fails here.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyVendoredManifest } from "./vendored-manifest";

const UPSTREAM_DIR = join(import.meta.dirname, "..", "fixtures", "security", "upstream");
const LENS_DIR = join(import.meta.dirname, "..", "..", "..", "references", "security-lenses");

/** The oracle set the differential tests load, plus the notice MIT requires. */
const ORACLE_FILES = ["LICENSE", "report-schema.json", "validate-coverage-ledger.cjs", "validate-findings.cjs"];

describe("vendored upstream validators", () => {
  it("re-digests every vendored file and pins the upstream revision, so the oracle is still upstream's", () => {
    verifyVendoredManifest(UPSTREAM_DIR);
  });

  it("pins exactly the oracle files, and the directory holds nothing else", () => {
    expect(Object.keys(verifyVendoredManifest(UPSTREAM_DIR).files).sort()).toEqual([...ORACLE_FILES].sort());
    expect(readdirSync(UPSTREAM_DIR).sort()).toEqual([...ORACLE_FILES, "MANIFEST.json"].sort());
  });

  it("agrees with the lens taxonomy about which upstream revision was vendored", () => {
    expect(verifyVendoredManifest(UPSTREAM_DIR).upstream.commit).toBe(verifyVendoredManifest(LENS_DIR).upstream.commit);
  });
});
