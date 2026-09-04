import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("structural specification identifier contract", () => {
  it("requires canonical acceptance-scenario IDs in both the template and specify skill", () => {
    for (const source of [read("references", "spec-template.md"), read("commands", "specify.md")]) {
      expect(source).toContain("AS-001:");
      expect(source).toMatch(/unique canonical `AS-NNN:` ID/u);
      expect(source).not.toMatch(/^\s*-\s+Given\b/gmu);
    }
  });

  it("requires canonical out-of-scope IDs in both the template and specify skill", () => {
    for (const source of [read("references", "spec-template.md"), read("commands", "specify.md")]) {
      expect(source).toContain("OOS-001:");
      expect(source).toMatch(/canonical `OOS-NNN:` ID/u);
    }
  });
});
