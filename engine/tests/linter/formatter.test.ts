/**
 * Tests for violation formatter — structured JSON output and human-readable block messages.
 *
 * Covers:
 * - formatOutput: pass/violations/error mapping
 * - JSON validity on all paths (FR-004, NFR-005, SC-005)
 * - formatBlockMessage: formatting for hook stderr
 * - Edge cases: empty violations array, long text, special characters
 */

import { describe, it, expect } from "vitest";
import { formatOutput, formatBlockMessage } from "../../src/linter/formatter";
import type { LintResult, LintOutput, Violation } from "../../src/linter/types";
import { passResult, violationsResult, lintErrorResult, makeViolation } from "../../src/linter/types";

describe("formatOutput", () => {
  const filePath = "/src/components/App.tsx";

  describe("pass result", () => {
    it("maps pass LintResult to pass LintOutput", () => {
      const result = passResult();
      const output = formatOutput(result, filePath);

      expect(output).toEqual({ status: "pass", file: filePath });
    });

    it("does not include violations or error fields on pass", () => {
      const result = passResult();
      const output = formatOutput(result, filePath);

      expect(output.violations).toBeUndefined();
      expect(output.error).toBeUndefined();
    });
  });

  describe("violations result", () => {
    it("maps violations LintResult to fail LintOutput", () => {
      const violations: Violation[] = [
        makeViolation("no-console", "/src/App.tsx", 42, "console.log('debug')", "Remove console statement"),
      ];
      const result = violationsResult(violations);
      const output = formatOutput(result, filePath);

      expect(output.status).toBe("fail");
      expect(output.file).toBe(filePath);
      expect(output.violations).toEqual(violations);
    });

    it("preserves multiple violations in order", () => {
      const violations: Violation[] = [
        makeViolation("no-console", "/src/App.tsx", 10, "console.log('a')", "Remove console"),
        makeViolation("no-debugger", "/src/App.tsx", 20, "debugger", "Remove debugger"),
        makeViolation("no-console", "/src/App.tsx", 30, "console.warn('b')", "Remove console"),
      ];
      const result: LintResult = { kind: "violations", violations };
      const output = formatOutput(result, filePath);

      expect(output.violations).toHaveLength(3);
      expect(output.violations![0].line).toBe(10);
      expect(output.violations![1].line).toBe(20);
      expect(output.violations![2].line).toBe(30);
    });

    it("does not include error field on fail", () => {
      const violations: Violation[] = [
        makeViolation("no-todo", "/src/App.tsx", 5, "// TODO: fix this", "Remove TODO comment"),
      ];
      const result = violationsResult(violations);
      const output = formatOutput(result, filePath);

      expect(output.error).toBeUndefined();
    });
  });

  describe("error result", () => {
    it("maps error LintResult to error LintOutput", () => {
      const result = lintErrorResult("Failed to read file");
      const output = formatOutput(result, filePath);

      expect(output).toEqual({
        status: "error",
        file: filePath,
        error: "Failed to read file",
      });
    });

    it("does not include violations field on error", () => {
      const result = lintErrorResult("Timeout");
      const output = formatOutput(result, filePath);

      expect(output.violations).toBeUndefined();
    });
  });

  describe("JSON validity (NFR-005, SC-005)", () => {
    it("produces valid JSON for pass result", () => {
      const output = formatOutput(passResult(), filePath);
      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("pass");
      expect(parsed.file).toBe(filePath);
    });

    it("produces valid JSON for violations result", () => {
      const violations: Violation[] = [
        makeViolation("rule-1", filePath, 1, "text with \"quotes\" and \nnewlines", "fix it"),
      ];
      const result: LintResult = { kind: "violations", violations };
      const output = formatOutput(result, filePath);
      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("fail");
      expect(parsed.violations[0].text).toContain("quotes");
    });

    it("produces valid JSON for error result with special characters", () => {
      const result = lintErrorResult('Error: path "C:\\Users\\test" not found\n');
      const output = formatOutput(result, filePath);
      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("error");
      expect(parsed.error).toContain("C:\\Users\\test");
    });

    it("produces valid JSON for error with empty message (falls back to Unknown)", () => {
      const result = lintErrorResult("");
      const output = formatOutput(result, filePath);
      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("error");
      expect(parsed.error).toBe("Unknown linter error");
    });
  });
});

describe("formatBlockMessage", () => {
  describe("pass status", () => {
    it("returns empty string for pass", () => {
      const output: LintOutput = { status: "pass", file: "/src/App.tsx" };
      expect(formatBlockMessage(output)).toBe("");
    });
  });

  describe("fail status (violations)", () => {
    it("renders single violation with header", () => {
      const output: LintOutput = {
        status: "fail",
        file: "path/to/file.ts",
        violations: [
          { rule: "no-console", file: "path/to/file.ts", line: 42, text: "console.log('test')", fixHint: "Remove console statement" },
        ],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT VIOLATIONS in path/to/file.ts");
      expect(msg).toContain("[no-console] line 42: console.log('test')");
      expect(msg).toContain("Fix: Remove console statement");
    });

    it("renders multiple violations", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/index.ts",
        violations: [
          { rule: "no-console", file: "src/index.ts", line: 42, text: "console.log('a')", fixHint: "Remove console" },
          { rule: "no-debugger", file: "src/index.ts", line: 87, text: "debugger", fixHint: "Remove debugger" },
        ],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("[no-console] line 42:");
      expect(msg).toContain("[no-debugger] line 87:");
      // Ensure order is preserved
      const consoleIdx = msg.indexOf("[no-console]");
      const debuggerIdx = msg.indexOf("[no-debugger]");
      expect(consoleIdx).toBeLessThan(debuggerIdx);
    });

    it("handles empty violations array gracefully", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/index.ts",
        violations: [],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT VIOLATIONS in src/index.ts");
      // No violation blocks, just header
    });

    it("handles undefined violations gracefully", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/index.ts",
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT VIOLATIONS in src/index.ts");
    });
  });

  describe("error status", () => {
    it("renders error message with header", () => {
      const output: LintOutput = {
        status: "error",
        file: "path/to/file.ts",
        error: "Failed to read file: ENOENT",
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT ENGINE ERROR in path/to/file.ts");
      expect(msg).toContain("Error: Failed to read file: ENOENT");
    });

    it("handles undefined error gracefully", () => {
      const output: LintOutput = {
        status: "error",
        file: "src/broken.ts",
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT ENGINE ERROR in src/broken.ts");
      expect(msg).toContain("Error: Unknown error");
    });
  });

  describe("edge cases", () => {
    it("handles long violation text without truncation", () => {
      const longText = "a".repeat(500);
      const output: LintOutput = {
        status: "fail",
        file: "src/long.ts",
        violations: [
          { rule: "line-length", file: "src/long.ts", line: 1, text: longText, fixHint: "Break line" },
        ],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain(longText);
    });

    it("handles special characters in text and rule names", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/special.ts",
        violations: [
          { rule: "no-html-entities", file: "src/special.ts", line: 5, text: '<div class="test">&amp;</div>', fixHint: "Use JSX" },
        ],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("[no-html-entities] line 5:");
      expect(msg).toContain('<div class="test">&amp;</div>');
    });

    it("handles file paths with spaces", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/my component/App.tsx",
        violations: [
          { rule: "naming", file: "src/my component/App.tsx", line: 1, text: "import x", fixHint: "Rename" },
        ],
      };
      const msg = formatBlockMessage(output);

      expect(msg).toContain("❌ LINT VIOLATIONS in src/my component/App.tsx");
    });

    it("formats indentation correctly for readability", () => {
      const output: LintOutput = {
        status: "fail",
        file: "src/test.ts",
        violations: [
          { rule: "no-todo", file: "src/test.ts", line: 10, text: "// TODO: fix", fixHint: "Remove TODO" },
        ],
      };
      const msg = formatBlockMessage(output);

      // Violations are indented with 2 spaces
      expect(msg).toMatch(/^ {2}\[no-todo\]/m);
      // Fix hint is indented with 4 spaces
      expect(msg).toMatch(/^ {4}Fix:/m);
    });
  });
});
