import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRules } from "../../src/linter/loader";
import type { RegexRule } from "../../src/linter/types";

// --- Test Helpers ---

function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `linter-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRule(dir: string, filename: string, rule: Record<string, unknown>): void {
  writeFileSync(join(dir, filename), JSON.stringify(rule, null, 2));
}

function makeValidRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "regex",
    name: "test-rule",
    description: "A test rule",
    extensions: [".ts"],
    pattern: "console\\.log\\(",
    flags: "",
    fixHint: "Remove console.log",
    enabled: true,
    ...overrides,
  };
}

// --- Tests ---

describe("loadRules", () => {
  let defaultDir: string;
  let projectDir: string;

  beforeEach(() => {
    defaultDir = createTempDir("defaults");
    projectDir = createTempDir("project");
  });

  afterEach(() => {
    rmSync(defaultDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("basic loading", () => {
    it("loads all rules from defaultDir tagged with source 'default'", () => {
      writeRule(defaultDir, "rule1.json", makeValidRule({ name: "rule-one" }));
      writeRule(defaultDir, "rule2.json", makeValidRule({ name: "rule-two", pattern: "foo" }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.source === "default")).toBe(true);
      const names = rules.map((r) => r.name).sort();
      expect(names).toEqual(["rule-one", "rule-two"]);
    });

    it("only reads .json files, ignoring other files", () => {
      writeRule(defaultDir, "rule1.json", makeValidRule({ name: "valid-rule" }));
      writeFileSync(join(defaultDir, "README.md"), "# Not a rule");
      writeFileSync(join(defaultDir, "notes.txt"), "Some notes");

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("valid-rule");
    });

    it("loads rules from projectDir tagged with source 'project'", () => {
      writeRule(defaultDir, "default.json", makeValidRule({ name: "default-rule" }));
      writeRule(projectDir, "project.json", makeValidRule({ name: "project-rule", pattern: "bar" }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      const projectRules = rules.filter((r) => r.source === "project");
      expect(projectRules).toHaveLength(1);
      expect(projectRules[0].name).toBe("project-rule");
    });

    it("returns empty array when defaultDir has no .json files", () => {
      // defaultDir exists but has no json files
      writeFileSync(join(defaultDir, "readme.md"), "empty");

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(0);
    });
  });

  describe("merge semantics", () => {
    it("project rule with same name overrides default entirely", () => {
      writeRule(defaultDir, "rule.json", makeValidRule({
        name: "no-console",
        description: "Default description",
        pattern: "console\\.log\\(",
        fixHint: "Default hint",
      }));
      writeRule(projectDir, "rule.json", makeValidRule({
        name: "no-console",
        description: "Project override",
        pattern: "console\\.",
        fixHint: "Project hint",
      }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("no-console");
      expect(rules[0].description).toBe("Project override");
      expect(rules[0].source).toBe("project");
      expect((rules[0] as RegexRule).pattern).toBe("console\\.");
      expect(rules[0].fixHint).toBe("Project hint");
    });

    it("project rules that don't match defaults are added (extend)", () => {
      writeRule(defaultDir, "default.json", makeValidRule({ name: "default-rule" }));
      writeRule(projectDir, "extra.json", makeValidRule({ name: "extra-rule", pattern: "debugger" }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(2);
      expect(rules.map((r) => r.name).sort()).toEqual(["default-rule", "extra-rule"]);
    });

    it("multiple defaults can be overridden independently", () => {
      writeRule(defaultDir, "a.json", makeValidRule({ name: "rule-a", pattern: "aaa" }));
      writeRule(defaultDir, "b.json", makeValidRule({ name: "rule-b", pattern: "bbb" }));
      writeRule(defaultDir, "c.json", makeValidRule({ name: "rule-c", pattern: "ccc" }));
      writeRule(projectDir, "b-override.json", makeValidRule({
        name: "rule-b",
        pattern: "BBB",
        description: "Overridden B",
      }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(3);
      const ruleB = rules.find((r) => r.name === "rule-b")!;
      expect(ruleB.source).toBe("project");
      expect(ruleB.description).toBe("Overridden B");
      // A and C remain as defaults
      expect(rules.find((r) => r.name === "rule-a")!.source).toBe("default");
      expect(rules.find((r) => r.name === "rule-c")!.source).toBe("default");
    });
  });

  describe("disable semantics (SC-006)", () => {
    it("project rule with enabled:false disables that rule entirely", () => {
      writeRule(defaultDir, "rule.json", makeValidRule({
        name: "no-console",
        enabled: true,
      }));
      writeRule(projectDir, "disable.json", makeValidRule({
        name: "no-console",
        enabled: false,
      }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      // Disabled rule is excluded from results — zero leakage
      expect(rules).toHaveLength(0);
      expect(rules.find((r) => r.name === "no-console")).toBeUndefined();
    });

    it("disabled rules never appear in results (zero leakage)", () => {
      writeRule(defaultDir, "a.json", makeValidRule({ name: "rule-a", pattern: "aaa" }));
      writeRule(defaultDir, "b.json", makeValidRule({ name: "rule-b", pattern: "bbb" }));
      writeRule(projectDir, "disable-a.json", makeValidRule({ name: "rule-a", enabled: false }));

      const rules = loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe("rule-b");
    });

    it("default rule with enabled:false is also excluded", () => {
      writeRule(defaultDir, "disabled.json", makeValidRule({
        name: "disabled-by-default",
        enabled: false,
      }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(0);
    });
  });

  describe("tier filtering", () => {
    it("tier 'immediate' returns only RegexRule[]", () => {
      writeRule(defaultDir, "regex.json", makeValidRule({
        name: "regex-rule",
        kind: "regex",
        pattern: "foo",
      }));

      const rules = loadRules(defaultDir, null, "immediate");

      expect(rules).toHaveLength(1);
      expect(rules[0].kind).toBe("regex");
    });

    it("tier 'full' returns all enabled rules", () => {
      writeRule(defaultDir, "regex.json", makeValidRule({
        name: "regex-rule",
        kind: "regex",
        pattern: "foo",
      }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
    });

    it("tier 'immediate' with only regex rules returns all of them", () => {
      writeRule(defaultDir, "a.json", makeValidRule({ name: "rule-a", pattern: "aaa" }));
      writeRule(defaultDir, "b.json", makeValidRule({ name: "rule-b", pattern: "bbb" }));

      const rules = loadRules(defaultDir, null, "immediate");

      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.kind === "regex")).toBe(true);
    });
  });

  describe("projectDir handling", () => {
    it("null projectDir only loads defaults", () => {
      writeRule(defaultDir, "rule.json", makeValidRule({ name: "default-only" }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
      expect(rules[0].source).toBe("default");
    });

    it("non-existent projectDir only loads defaults", () => {
      writeRule(defaultDir, "rule.json", makeValidRule({ name: "default-only" }));
      const nonExistent = join(tmpdir(), "does-not-exist-" + Date.now());

      const rules = loadRules(defaultDir, nonExistent, "full", { includeProgrammatic: false });

      expect(rules).toHaveLength(1);
      expect(rules[0].source).toBe("default");
    });

    it("surfaces an inaccessible projectDir instead of silently disabling project policy", () => {
      writeRule(defaultDir, "rule.json", makeValidRule({ name: "default-only" }));
      rmSync(projectDir, { recursive: true, force: true });
      symlinkSync(projectDir, projectDir);

      expect(() => loadRules(defaultDir, projectDir, "full", { includeProgrammatic: false }))
        .toThrow(/ELOOP/i);
    });
  });

  describe("error handling (fail-closed)", () => {
    it("throws when defaultDir does not exist", () => {
      const missing = join(tmpdir(), "missing-defaults-" + Date.now());

      expect(() => loadRules(missing, null, "full")).toThrow(
        /Default rules directory not found/
      );
      expect(() => loadRules(missing, null, "full")).toThrow(
        /installation error/
      );
    });

    it("throws on malformed JSON", () => {
      writeFileSync(join(defaultDir, "bad.json"), "{ invalid json!!!");

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/Malformed JSON/);
    });

    it("throws on JSON that is not an object", () => {
      writeFileSync(join(defaultDir, "array.json"), "[1, 2, 3]");

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/expected a JSON object/);
    });

    it("throws on missing required fields", () => {
      writeFileSync(join(defaultDir, "incomplete.json"), JSON.stringify({
        kind: "regex",
        // missing name, description, etc.
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/must be a non-empty string/);
    });

    it("throws on missing pattern for regex rule", () => {
      writeFileSync(join(defaultDir, "no-pattern.json"), JSON.stringify({
        kind: "regex",
        name: "test",
        description: "test",
        extensions: [".ts"],
        fixHint: "fix it",
        enabled: true,
        // missing pattern
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /regex rule must have a 'pattern' string/
      );
    });

    it("throws on unsafe regex pattern (ReDoS)", () => {
      writeRule(defaultDir, "evil.json", makeValidRule({
        name: "evil-rule",
        pattern: "(a+)+$",  // classic ReDoS
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/unsafe regex pattern/);
    });

    it("throws on unknown rule kind", () => {
      writeRule(defaultDir, "weird.json", makeValidRule({
        name: "weird",
        kind: "unknown-kind",
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/unknown rule kind/);
    });

    it("throws on programmatic rules in JSON", () => {
      writeRule(defaultDir, "prog.json", {
        kind: "programmatic",
        name: "prog-rule",
        description: "A programmatic rule",
        extensions: [".ts"],
        fixHint: "Fix it",
        enabled: true,
      });

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /programmatic rules cannot be defined in JSON/
      );
    });

    it("throws on non-string extensions", () => {
      writeFileSync(join(defaultDir, "bad-ext.json"), JSON.stringify({
        kind: "regex",
        name: "bad-ext",
        description: "Has non-string extensions",
        extensions: [".ts", 42],
        pattern: "foo",
        fixHint: "fix it",
        enabled: true,
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /all extensions must be strings/
      );
    });

    it("throws on enabled being non-boolean", () => {
      writeFileSync(join(defaultDir, "bad-enabled.json"), JSON.stringify({
        kind: "regex",
        name: "bad-enabled",
        description: "Has non-boolean enabled",
        extensions: [".ts"],
        pattern: "foo",
        fixHint: "fix it",
        enabled: "true",
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /'enabled' must be a boolean/
      );
    });
  });

  describe("integration with real lint-rules", () => {
    it("loads the shipped default rules successfully", () => {
      const realDefaultDir = join(__dirname, "../../../lint-rules");
      // Only run this test if the real lint-rules dir exists
      const { existsSync } = require("node:fs");
      if (!existsSync(realDefaultDir)) return;

      const rules = loadRules(realDefaultDir, null, "full", { includeProgrammatic: false });

      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.source === "default")).toBe(true);
      expect(rules.every((r) => r.kind === "regex")).toBe(true);
      expect(rules.every((r) => r.enabled === true)).toBe(true);
    });
  });

  describe("rule fields are correctly populated", () => {
    it("populates all RegexRule fields from JSON", () => {
      writeRule(defaultDir, "full.json", {
        kind: "regex",
        name: "full-rule",
        description: "A fully specified rule",
        extensions: [".ts", ".tsx"],
        pattern: "debugger",
        flags: "i",
        fixHint: "Remove debugger statement",
        enabled: true,
      });

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules).toHaveLength(1);
      const rule = rules[0];
      expect(rule.kind).toBe("regex");
      expect(rule.name).toBe("full-rule");
      expect(rule.description).toBe("A fully specified rule");
      expect(rule.extensions).toEqual([".ts", ".tsx"]);
      expect(rule.pattern).toBe("debugger");
      expect(rule.flags).toBe("i");
      expect(rule.fixHint).toBe("Remove debugger statement");
      expect(rule.enabled).toBe(true);
      expect(rule.source).toBe("default");
    });

    it("defaults flags to empty string when not provided", () => {
      const ruleData = makeValidRule({ name: "no-flags" });
      delete (ruleData as any).flags;
      writeRule(defaultDir, "noflag.json", ruleData);

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules[0].flags).toBe("");
    });
  });

  describe("flags validation (fail-closed)", () => {
    it("throws on non-string flags: number", () => {
      writeRule(defaultDir, "bad-flags.json", makeValidRule({
        name: "bad-flags-num",
        flags: 123,
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /'flags' must be a string/
      );
    });

    it("throws on non-string flags: array", () => {
      writeRule(defaultDir, "bad-flags.json", makeValidRule({
        name: "bad-flags-arr",
        flags: ["g", "i"],
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /'flags' must be a string/
      );
    });

    it("throws on non-string flags: boolean", () => {
      writeRule(defaultDir, "bad-flags.json", makeValidRule({
        name: "bad-flags-bool",
        flags: true,
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(
        /'flags' must be a string/
      );
    });

    it("absent/undefined flags defaults to empty string", () => {
      const ruleData = makeValidRule({ name: "no-flags-rule" });
      delete (ruleData as any).flags;
      writeRule(defaultDir, "noflag.json", ruleData);

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules).toHaveLength(1);
      expect(rules[0].flags).toBe("");
    });

    it("valid string flags 'gi' works correctly", () => {
      writeRule(defaultDir, "gi.json", makeValidRule({
        name: "gi-rule",
        flags: "gi",
      }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules).toHaveLength(1);
      expect(rules[0].flags).toBe("gi");
    });

    it("valid string flags 'i' works correctly", () => {
      writeRule(defaultDir, "i.json", makeValidRule({
        name: "i-rule",
        flags: "i",
      }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules).toHaveLength(1);
      expect(rules[0].flags).toBe("i");
    });

    it("valid string flags 'gm' works correctly", () => {
      writeRule(defaultDir, "gm.json", makeValidRule({
        name: "gm-rule",
        flags: "gm",
      }));

      const rules = loadRules(defaultDir, null, "full", { includeProgrammatic: false }) as RegexRule[];

      expect(rules).toHaveLength(1);
      expect(rules[0].flags).toBe("gm");
    });

    it("error message includes rule name and file path", () => {
      writeRule(defaultDir, "bad.json", makeValidRule({
        name: "my-special-rule",
        flags: 42,
      }));

      expect(() => loadRules(defaultDir, null, "full", { includeProgrammatic: false })).toThrow(/my-special-rule/);
    });
  });

});
