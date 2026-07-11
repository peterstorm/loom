import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadRules } from "../../../src/linter/loader";
import type { Rule } from "../../../src/linter/types";

/**
 * Integration test: verifies programmatic rules are included in the full tier
 * and can be disabled via project overrides.
 */
describe("programmatic rules integration", () => {
  const realDefaultDir = join(__dirname, "../../../../lint-rules");

  it("full tier includes programmatic rules by default", () => {
    const rules = loadRules(realDefaultDir, null, "full");
    const programmatic = rules.filter((r: Rule) => r.kind === "programmatic");

    expect(programmatic.length).toBe(4);
    const names = programmatic.map((r) => r.name).sort();
    expect(names).toEqual([
      "fugue-generated-integrity",
      "max-function-lines",
      "no-cross-boundary-imports",
      "no-io-in-pure-modules",
    ]);
  });

  it("immediate tier does NOT include programmatic rules", () => {
    const rules = loadRules(realDefaultDir, null, "immediate");
    const programmatic = rules.filter((r: Rule) => r.kind === "programmatic");
    expect(programmatic.length).toBe(0);
  });

  it("includeProgrammatic: false excludes them", () => {
    const rules = loadRules(realDefaultDir, null, "full", { includeProgrammatic: false });
    const programmatic = rules.filter((r: Rule) => r.kind === "programmatic");
    expect(programmatic.length).toBe(0);
  });

  it("all programmatic rules have required fields", () => {
    const rules = loadRules(realDefaultDir, null, "full");
    const programmatic = rules.filter((r: Rule) => r.kind === "programmatic");

    for (const rule of programmatic) {
      expect(rule.name).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.extensions.length).toBeGreaterThan(0);
      expect(rule.fixHint).toBeTruthy();
      expect(rule.enabled).toBe(true);
      expect(rule.source).toBe("default");
      if (rule.kind === "programmatic") {
        expect(typeof rule.handler).toBe("function");
      }
    }
  });
});
