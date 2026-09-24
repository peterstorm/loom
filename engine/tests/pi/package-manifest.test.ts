import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Pi package manifest", () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

  it("loads only the first-class Pi extension, not the legacy bridge", () => {
    expect(pkg.pi.extensions).toEqual(["./pi/extension.ts"]);
    expect(pkg.pi.extensions).not.toContain("./pi");
    expect(pkg.pi.extensions).not.toContain("./pi/loom-bridge.ts");
    expect(existsSync(resolve(repoRoot, "pi/loom-bridge.ts"))).toBe(false);
  });

  it("declares empty skills and prompts; the extension renders them from the package trees", () => {
    // Empty arrays, NOT omitted keys: Pi's convention-dir fallback would
    // otherwise load the raw `skills/` tree whenever a settings filter is
    // present for the package, while the extension's resources_discover
    // handler already supplies the RENDERED copies — two sources for the
    // same names produce startup collision warnings and Pi keeps the
    // unrendered file (literal ${CLAUDE_PLUGIN_ROOT} paths).
    expect(pkg.pi.prompts).toEqual([]);
    expect(pkg.pi.skills).toEqual([]);
  });
});
