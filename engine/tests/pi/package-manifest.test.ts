import { readFileSync } from "node:fs";
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
  });

  it("registers only top-level slash command templates as prompts", () => {
    expect(pkg.pi.prompts).toEqual(["./commands/*.md"]);
  });

  it("does not point skills at nonexistent command directories", () => {
    expect(pkg.pi.skills).toEqual(["./skills", "./commands/vercel-react-best-practices"]);
  });
});
