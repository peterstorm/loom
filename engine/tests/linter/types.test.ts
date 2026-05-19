import { describe, it, expect } from "vitest";
import {
  isRegexRule,
  isProgrammaticRule,
  isPass,
  isViolations,
  isError,
  makeViolation,
  passResult,
  violationsResult,
  lintErrorResult,
  type RegexRule,
  type ProgrammaticRule,
  type Rule,
  type Violation,
  type LintResult,
} from "../../src/linter/types";

// --- Fixtures ---

const regexRule: RegexRule = {
  kind: "regex",
  name: "no-console-log",
  description: "Disallow console.log",
  extensions: [".ts", ".tsx"],
  pattern: "console\\.log\\(",
  fixHint: "Remove console.log or use a logger",
  enabled: true,
  source: "default",
};

const programmaticRule: ProgrammaticRule = {
  kind: "programmatic",
  name: "no-deep-nesting",
  description: "Disallow deeply nested code",
  extensions: [".ts"],
  handler: () => [],
  fixHint: "Extract nested logic into functions",
  enabled: true,
  source: "project",
};

// --- Type Guard Tests ---

describe("isRegexRule", () => {
  it("returns true for RegexRule", () => {
    expect(isRegexRule(regexRule)).toBe(true);
  });

  it("returns false for ProgrammaticRule", () => {
    expect(isRegexRule(programmaticRule)).toBe(false);
  });
});

describe("isProgrammaticRule", () => {
  it("returns true for ProgrammaticRule", () => {
    expect(isProgrammaticRule(programmaticRule)).toBe(true);
  });

  it("returns false for RegexRule", () => {
    expect(isProgrammaticRule(regexRule)).toBe(false);
  });
});

describe("isPass", () => {
  it("returns true for pass result", () => {
    expect(isPass({ kind: "pass" })).toBe(true);
  });

  it("returns false for violations result", () => {
    expect(isPass({ kind: "violations", violations: [] })).toBe(false);
  });

  it("returns false for error result", () => {
    expect(isPass({ kind: "error", message: "oops" })).toBe(false);
  });
});

describe("isViolations", () => {
  it("returns true for violations result", () => {
    const v: Violation = {
      rule: "test",
      file: "/a.ts",
      line: 1,
      text: "x",
      fixHint: "fix",
    };
    expect(isViolations({ kind: "violations", violations: [v] })).toBe(true);
  });

  it("returns false for pass result", () => {
    expect(isViolations({ kind: "pass" })).toBe(false);
  });
});

describe("isError", () => {
  it("returns true for error result", () => {
    expect(isError({ kind: "error", message: "fail" })).toBe(true);
  });

  it("returns false for pass result", () => {
    expect(isError({ kind: "pass" })).toBe(false);
  });
});

// --- Constructor Tests ---

describe("makeViolation", () => {
  it("creates a valid Violation", () => {
    const v = makeViolation("no-any", "/src/app.ts", 42, "  const x: any = 1;  ", "Use a specific type");
    expect(v).toEqual({
      rule: "no-any",
      file: "/src/app.ts",
      line: 42,
      text: "const x: any = 1;",  // trimmed
      fixHint: "Use a specific type",
    });
  });

  it("trims the text", () => {
    const v = makeViolation("r", "/f.ts", 1, "   hello   ", "hint");
    expect(v.text).toBe("hello");
  });

  it("throws on empty rule name", () => {
    expect(() => makeViolation("", "/f.ts", 1, "text", "hint")).toThrow(
      "Violation rule name must be non-empty"
    );
  });

  it("throws on whitespace-only rule name", () => {
    expect(() => makeViolation("   ", "/f.ts", 1, "text", "hint")).toThrow(
      "Violation rule name must be non-empty"
    );
  });

  it("throws on empty file path", () => {
    expect(() => makeViolation("rule", "", 1, "text", "hint")).toThrow(
      "Violation file path must be non-empty"
    );
  });

  it("throws on zero line number", () => {
    expect(() => makeViolation("rule", "/f.ts", 0, "text", "hint")).toThrow(
      "Violation line must be a positive integer"
    );
  });

  it("throws on negative line number", () => {
    expect(() => makeViolation("rule", "/f.ts", -1, "text", "hint")).toThrow(
      "Violation line must be a positive integer"
    );
  });

  it("throws on non-integer line number", () => {
    expect(() => makeViolation("rule", "/f.ts", 1.5, "text", "hint")).toThrow(
      "Violation line must be a positive integer"
    );
  });
});

describe("passResult", () => {
  it("returns a pass LintResult", () => {
    expect(passResult()).toEqual({ kind: "pass" });
  });
});

describe("violationsResult", () => {
  it("returns violations LintResult when violations exist", () => {
    const violations: Violation[] = [
      { rule: "r", file: "/f.ts", line: 1, text: "x", fixHint: "fix" },
    ];
    const result = violationsResult(violations);
    expect(result.kind).toBe("violations");
    if (result.kind === "violations") {
      expect(result.violations).toEqual(violations);
    }
  });

  it("returns pass LintResult when violations array is empty", () => {
    expect(violationsResult([])).toEqual({ kind: "pass" });
  });
});

describe("lintErrorResult", () => {
  it("returns error LintResult with message", () => {
    const result = lintErrorResult("something broke");
    expect(result).toEqual({ kind: "error", message: "something broke" });
  });

  it("provides fallback for empty message", () => {
    const result = lintErrorResult("");
    expect(result).toEqual({ kind: "error", message: "Unknown linter error" });
  });
});
