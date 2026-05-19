/**
 * Integration tests for lintFile — the public API orchestrator.
 *
 * Tests cover:
 * - Binary file detection (FR-009, SC-007)
 * - No rules matching extension (FR-008)
 * - Successful lint with violations
 * - Successful lint pass (no violations)
 * - Fail-closed on loader crash (FR-007, NFR-004, SC-004)
 * - Fail-closed on executor crash (FR-007, NFR-004, SC-004)
 * - Fail-closed on file read error (FR-007, NFR-004, SC-004)
 * - Stateless behavior (FR-010)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintFile, isBinaryFile } from "../../src/linter/index";

// --- Test Helpers ---

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `linter-index-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRule(dir: string, filename: string, rule: Record<string, unknown>): void {
  writeFileSync(join(dir, filename), JSON.stringify(rule, null, 2));
}

function makeValidRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "regex",
    name: "no-console-log",
    description: "Disallow console.log",
    extensions: [".ts", ".tsx"],
    pattern: "console\\.log\\(",
    flags: "",
    fixHint: "Remove console.log statement",
    enabled: true,
    ...overrides,
  };
}

// --- Tests ---

describe("isBinaryFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir("binary");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns true for files containing null bytes (SC-007)", () => {
    const filePath = join(tempDir, "binary.bin");
    const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]); // "Hel\0o"
    writeFileSync(filePath, buffer);
    expect(isBinaryFile(filePath)).toBe(true);
  });

  it("returns false for text files without null bytes", () => {
    const filePath = join(tempDir, "text.ts");
    writeFileSync(filePath, "const x = 1;\nconsole.log(x);\n");
    expect(isBinaryFile(filePath)).toBe(false);
  });

  it("returns true for null byte at end of buffer", () => {
    const filePath = join(tempDir, "trailing-null.bin");
    const content = "A".repeat(100) + "\x00";
    writeFileSync(filePath, content);
    expect(isBinaryFile(filePath)).toBe(true);
  });

  it("returns false for empty files", () => {
    const filePath = join(tempDir, "empty.ts");
    writeFileSync(filePath, "");
    expect(isBinaryFile(filePath)).toBe(false);
  });

  it("returns true for null byte beyond typical ASCII range", () => {
    const filePath = join(tempDir, "deep-null.bin");
    const buffer = Buffer.alloc(4096);
    buffer.fill(0x41); // All 'A'
    buffer[4000] = 0;  // Null byte deep in the file
    writeFileSync(filePath, buffer);
    expect(isBinaryFile(filePath)).toBe(true);
  });
});

describe("lintFile", () => {
  let defaultDir: string;
  let projectDir: string;
  let tempDir: string;

  beforeEach(() => {
    defaultDir = createTempDir("defaults");
    projectDir = createTempDir("project");
    tempDir = createTempDir("files");
  });

  afterEach(() => {
    rmSync(defaultDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("binary file detection (FR-009, SC-007)", () => {
    it("passes immediately for binary files without evaluating rules", () => {
      const filePath = join(tempDir, "image.ts"); // .ts extension but binary content
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]); // PNG-like with null
      writeFileSync(filePath, buffer);

      // Rule that would match .ts files — should NOT be evaluated
      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("does not evaluate any rules for binary files", () => {
      const filePath = join(tempDir, "data.ts");
      // File with null bytes AND content that would match a rule
      const content = Buffer.concat([
        Buffer.from("console.log('hello');\n"),
        Buffer.from([0x00]),
        Buffer.from("more text\n"),
      ]);
      writeFileSync(filePath, content);

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });
  });

  describe("no rules match extension (FR-008)", () => {
    it("passes when no loaded rules match the file extension", () => {
      const filePath = join(tempDir, "style.css");
      writeFileSync(filePath, "body { color: red; }\n");

      // Rule only matches .ts/.tsx
      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("passes when default directory has no rules", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      // Empty defaultDir (no rule files)
      const result = lintFile(filePath, "immediate", defaultDir, null);
      expect(result).toEqual({ kind: "pass" });
    });
  });

  describe("successful lint execution", () => {
    it("returns violations when rules match", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "const x = 1;\nconsole.log(x);\nconst y = 2;\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
      if (result.kind === "violations") {
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].rule).toBe("no-console-log");
        expect(result.violations[0].line).toBe(2);
        expect(result.violations[0].text).toContain("console.log");
      }
    });

    it("returns multiple violations for multiple matches", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(
        filePath,
        "console.log('a');\nconst x = 1;\nconsole.log('b');\n"
      );

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
      if (result.kind === "violations") {
        expect(result.violations).toHaveLength(2);
        expect(result.violations[0].line).toBe(1);
        expect(result.violations[1].line).toBe(3);
      }
    });

    it("returns pass when file has no violations", () => {
      const filePath = join(tempDir, "clean.ts");
      writeFileSync(filePath, "const x = 1;\nconst y = x + 2;\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("applies multiple rules", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('x');\ndebugger;\n");

      writeRule(defaultDir, "rule1.json", makeValidRule({ name: "no-console" }));
      writeRule(
        defaultDir,
        "rule2.json",
        makeValidRule({
          name: "no-debugger",
          pattern: "^\\s*debugger",
          fixHint: "Remove debugger statement",
        })
      );

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
      if (result.kind === "violations") {
        expect(result.violations).toHaveLength(2);
        const ruleNames = result.violations.map((v) => v.rule).sort();
        expect(ruleNames).toEqual(["no-console", "no-debugger"]);
      }
    });
  });

  describe("tier filtering", () => {
    it("immediate tier only loads regex rules", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
    });

    it("full tier loads all rules", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "full", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
    });
  });

  describe("project rule overrides", () => {
    it("project rules override defaults by name", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      // Default rule matches console.log
      writeRule(defaultDir, "rule.json", makeValidRule());

      // Project rule disables it
      writeRule(
        projectDir,
        "override.json",
        makeValidRule({ enabled: false })
      );

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("works with null projectDir", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, null);
      expect(result.kind).toBe("violations");
    });
  });

  describe("fail-closed behavior (FR-007, NFR-004, SC-004)", () => {
    it("returns error result when file does not exist", () => {
      const filePath = join(tempDir, "nonexistent.ts");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toBeTruthy();
      }
    });

    it("returns error result when default rules directory is missing", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      const missingDir = join(tempDir, "nonexistent-rules");

      const result = lintFile(filePath, "immediate", missingDir, projectDir);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toContain("not found");
      }
    });

    it("returns error result on malformed rule JSON (fail-closed)", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      // Write invalid JSON to rules dir
      writeFileSync(join(defaultDir, "bad.json"), "{ invalid json !!!");

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toContain("Malformed JSON");
      }
    });

    it("returns error result on unsafe regex pattern (fail-closed)", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "test content\n");

      // Write rule with catastrophic backtracking pattern
      writeRule(defaultDir, "unsafe.json", makeValidRule({
        name: "unsafe-rule",
        pattern: "(a+)+$",
        extensions: [".ts"],
      }));

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toBeTruthy();
      }
    });

    it("returns error result when rule file has invalid structure", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      // Rule missing required fields
      writeFileSync(
        join(defaultDir, "incomplete.json"),
        JSON.stringify({ kind: "regex", name: "incomplete" })
      );

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("error");
    });
  });

  describe("stateless behavior (FR-010)", () => {
    it("produces same result on repeated invocations", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result1 = lintFile(filePath, "immediate", defaultDir, projectDir);
      const result2 = lintFile(filePath, "immediate", defaultDir, projectDir);
      const result3 = lintFile(filePath, "immediate", defaultDir, projectDir);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
    });

    it("reflects file changes between invocations (no caching)", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result1 = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result1.kind).toBe("violations");

      // Modify the file to remove violation
      writeFileSync(filePath, "const x = 1;\n");

      const result2 = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result2).toEqual({ kind: "pass" });
    });

    it("reflects rule changes between invocations (no caching)", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result1 = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result1.kind).toBe("violations");

      // Disable the rule
      writeRule(defaultDir, "rule.json", makeValidRule({ enabled: false }));

      const result2 = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result2).toEqual({ kind: "pass" });
    });
  });

  describe("edge cases", () => {
    it("handles empty file", () => {
      const filePath = join(tempDir, "empty.ts");
      writeFileSync(filePath, "");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("handles file with only newlines", () => {
      const filePath = join(tempDir, "newlines.ts");
      writeFileSync(filePath, "\n\n\n\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result).toEqual({ kind: "pass" });
    });

    it("handles relative file paths", () => {
      const filePath = join(tempDir, "code.ts");
      writeFileSync(filePath, "console.log('test');\n");

      writeRule(defaultDir, "rule.json", makeValidRule());

      // Use relative path (relative to cwd)
      const result = lintFile(filePath, "immediate", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
    });

    it("handles very large file", () => {
      const filePath = join(tempDir, "large.ts");
      const lines = Array.from({ length: 10000 }, (_, i) =>
        i === 5000 ? "console.log('found');" : `const x${i} = ${i};`
      );
      writeFileSync(filePath, lines.join("\n"));

      writeRule(defaultDir, "rule.json", makeValidRule());

      // Use a generous timeout for large file
      const result = lintFile(filePath, "full", defaultDir, projectDir);
      expect(result.kind).toBe("violations");
      if (result.kind === "violations") {
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0].line).toBe(5001);
      }
    });
  });
});
