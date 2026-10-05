import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRules } from "../../src/linter/loader";

/**
 * This repository's own project lint rules (INV-1: strict sampling is only ever preferred, never required).
 * Each harness loads exactly ONE project rules directory (`PROJECT_RULES_DIR`
 * in engine/src/config.ts: `.pi/linter/rules` under Pi,
 * `.claude/linter/rules` under Claude Code), so the invariant must be present
 * in both — with one owner. `.claude/linter/rules` holds the canonical rule
 * files; every `.pi/linter/rules` entry is a byte-identical regular-file copy
 * of its canonical twin, and this suite fails the moment the two diverge. A
 * symlink would be the tighter tie, but registered remediation refuses to
 * install symlinked paths, so the copy plus this parity check is the owner.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_RULES_DIR = join(REPO_ROOT, "lint-rules");
const CANONICAL = join(REPO_ROOT, ".claude/linter/rules");
const PI = join(REPO_ROOT, ".pi/linter/rules");

const ruleFiles = (dir: string): readonly string[] => readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

describe("project lint rules: one source for both harnesses", () => {
  it("both harness directories carry the same rule set", () => {
    expect(ruleFiles(CANONICAL)).toContain("inv-1-no-strict-require-constraint.json");
    expect(ruleFiles(PI)).toEqual(ruleFiles(CANONICAL));
  });

  it("every Pi rule is a regular-file, byte-identical copy of its canonical Claude Code rule", () => {
    for (const name of ruleFiles(PI)) {
      expect(lstatSync(join(PI, name)).isFile(), name).toBe(true);
      expect(readFileSync(join(PI, name)), name).toEqual(readFileSync(join(CANONICAL, name)));
    }
  });

  it("loads the identical INV-1 rule under either harness", () => {
    const inv1 = (projectDir: string) => loadRules(DEFAULT_RULES_DIR, projectDir, "full", { includeProgrammatic: false })
      .find((rule) => rule.name === "inv-1-no-strict-require-constraint");
    const claude = inv1(CANONICAL);
    expect(claude).toMatchObject({ kind: "regex", enabled: true });
    expect(inv1(PI)).toEqual(claude);
    expect(readFileSync(join(PI, "inv-1-no-strict-require-constraint.json"))).toEqual(readFileSync(join(CANONICAL, "inv-1-no-strict-require-constraint.json")));
  });
});
