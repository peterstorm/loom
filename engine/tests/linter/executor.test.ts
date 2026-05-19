/**
 * Tests for rule executor — extension matching, line-by-line regex execution,
 * multi-rule aggregation, timeout behavior, programmatic rules, edge cases.
 */

import { describe, it, expect } from "vitest";
import { executeRules } from "../../src/linter/executor";
import type {
  RegexRule,
  ProgrammaticRule,
  Rule,
  Violation,
} from "../../src/linter/types";
import { makeViolation } from "../../src/linter/types";

// --- Test Helpers ---

function makeRegexRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    kind: "regex",
    name: "test-rule",
    description: "A test rule",
    extensions: [".ts", ".tsx"],
    pattern: "console\\.log",
    flags: undefined,
    fixHint: "Remove console.log",
    enabled: true,
    source: "default",
    ...overrides,
  };
}

function makeProgrammaticRule(
  overrides: Partial<ProgrammaticRule> = {}
): ProgrammaticRule {
  return {
    kind: "programmatic",
    name: "programmatic-test",
    description: "A programmatic test rule",
    extensions: [".ts"],
    handler: (_content: string, _filePath: string) => [],
    fixHint: "Fix it",
    enabled: true,
    source: "default",
    ...overrides,
  };
}

// --- Extension Matching (FR-003, SC-003) ---

describe("executeRules — extension matching", () => {
  it("matches rules when file extension is in rule extensions array", () => {
    const rule = makeRegexRule({ extensions: [".ts", ".tsx"] });
    const content = "console.log('hello');";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations.length).toBe(1);
  });

  it("does NOT match rules when file extension differs (SC-003 zero false positives)", () => {
    const rule = makeRegexRule({ extensions: [".ts", ".tsx"] });
    const content = "console.log('hello');";
    const violations = executeRules([rule], "/src/app.js", content, 1000);
    expect(violations).toEqual([]);
  });

  it("handles dotfiles with no real extension", () => {
    const rule = makeRegexRule({ extensions: [".ts"] });
    const content = "console.log('hello');";
    // .gitignore has extension "" from path.extname
    const violations = executeRules([rule], "/project/.gitignore", content, 1000);
    expect(violations).toEqual([]);
  });

  it("matches .tsx extension specifically", () => {
    const rule = makeRegexRule({ extensions: [".tsx"] });
    const content = "console.log('render');";
    const violations = executeRules([rule], "/src/Component.tsx", content, 1000);
    expect(violations.length).toBe(1);
  });

  it("does not fire disabled rules even if extension matches", () => {
    const rule = makeRegexRule({ enabled: false });
    const content = "console.log('hello');";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations).toEqual([]);
  });

  it("returns empty array when rules array is empty", () => {
    const violations = executeRules([], "/src/app.ts", "console.log('hi');", 1000);
    expect(violations).toEqual([]);
  });
});

// --- Line-by-line Regex Execution (FR-019, SC-002) ---

describe("executeRules — regex line-by-line execution", () => {
  it("finds violations on matching lines with 1-indexed line numbers", () => {
    const rule = makeRegexRule({ pattern: "TODO" });
    const content = "line 1\n// TODO: fix this\nline 3\n// TODO: another";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);

    expect(violations.length).toBe(2);
    expect(violations[0].line).toBe(2);
    expect(violations[0].text).toBe("// TODO: fix this");
    expect(violations[1].line).toBe(4);
    expect(violations[1].text).toBe("// TODO: another");
  });

  it("reports rule name, file path, and fixHint in each violation", () => {
    const rule = makeRegexRule({
      name: "no-console",
      fixHint: "Use logger instead",
    });
    const content = "console.log('x');";
    const violations = executeRules([rule], "/src/index.ts", content, 1000);

    expect(violations[0].rule).toBe("no-console");
    expect(violations[0].file).toBe("/src/index.ts");
    expect(violations[0].fixHint).toBe("Use logger instead");
  });

  it("trims matched line text", () => {
    const rule = makeRegexRule({ pattern: "console\\.log" });
    const content = "  console.log('hello');  ";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);

    expect(violations[0].text).toBe("console.log('hello');");
  });

  it("returns empty when no lines match", () => {
    const rule = makeRegexRule({ pattern: "console\\.log" });
    const content = "const x = 1;\nconst y = 2;";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations).toEqual([]);
  });

  it("handles regex with flags (case-insensitive)", () => {
    const rule = makeRegexRule({ pattern: "todo", flags: "i" });
    const content = "// TODO: fix\n// Todo: later\n// nothing";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations.length).toBe(2);
  });

  it("handles global flag correctly (resets lastIndex per line)", () => {
    const rule = makeRegexRule({ pattern: "x", flags: "g" });
    const content = "x\ny\nx";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations.length).toBe(2);
    expect(violations[0].line).toBe(1);
    expect(violations[1].line).toBe(3);
  });

  it("100% recall: every matching line is reported (SC-002)", () => {
    const rule = makeRegexRule({ pattern: "match" });
    const lines = Array.from({ length: 50 }, (_, i) =>
      i % 5 === 0 ? "match here" : "no hit"
    );
    const content = lines.join("\n");
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    // Lines 0, 5, 10, 15, 20, 25, 30, 35, 40, 45 => 10 matches (1-indexed: 1,6,11,16,21,26,31,36,41,46)
    expect(violations.length).toBe(10);
  });

  it("handles empty content (single empty line)", () => {
    const rule = makeRegexRule({ pattern: "." }); // matches any char
    const content = "";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations).toEqual([]);
  });

  it("handles content with only newlines", () => {
    const rule = makeRegexRule({ pattern: "x" });
    const content = "\n\n\n";
    const violations = executeRules([rule], "/src/app.ts", content, 1000);
    expect(violations).toEqual([]);
  });
});

// --- Multi-rule Aggregation (FR-005) ---

describe("executeRules — multi-rule aggregation", () => {
  it("aggregates violations from multiple rules into one array", () => {
    const rule1 = makeRegexRule({
      name: "no-console",
      pattern: "console\\.log",
    });
    const rule2 = makeRegexRule({
      name: "no-todo",
      pattern: "TODO",
      fixHint: "Resolve TODO",
    });
    const content = "console.log('hi');\n// TODO: fix";
    const violations = executeRules([rule1, rule2], "/src/app.ts", content, 1000);

    expect(violations.length).toBe(2);
    expect(violations[0].rule).toBe("no-console");
    expect(violations[1].rule).toBe("no-todo");
  });

  it("only includes rules matching the file extension", () => {
    const tsRule = makeRegexRule({
      name: "ts-only",
      extensions: [".ts"],
      pattern: "bad",
    });
    const jsRule = makeRegexRule({
      name: "js-only",
      extensions: [".js"],
      pattern: "bad",
    });
    const content = "bad code";
    const violations = executeRules([tsRule, jsRule], "/src/app.ts", content, 1000);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("ts-only");
  });

  it("same line can trigger multiple rules", () => {
    const rule1 = makeRegexRule({ name: "rule-a", pattern: "foo" });
    const rule2 = makeRegexRule({ name: "rule-b", pattern: "bar" });
    const content = "foobar";
    const violations = executeRules([rule1, rule2], "/src/app.ts", content, 1000);

    expect(violations.length).toBe(2);
    expect(violations.map((v) => v.rule).sort()).toEqual(["rule-a", "rule-b"]);
  });
});

// --- Timeout Behavior (NFR-001) ---

describe("executeRules — timeout / deadline", () => {
  it("throws when execution exceeds timeout", () => {
    const rule = makeRegexRule({ pattern: "x" });
    // Create a very large file to force timeout with 1ms budget
    const content = Array.from({ length: 10000 }, () => "x".repeat(100)).join("\n");

    // With a 1ms timeout and 10000 lines, deadline check should trigger
    // Note: deadline is checked every 100 lines
    expect(() => executeRules([rule], "/src/big.ts", content, 1)).toThrow(
      /exceeded timeout/
    );
  });

  it("does not throw when execution is within timeout", () => {
    const rule = makeRegexRule({ pattern: "console\\.log" });
    const content = "console.log('hi');\nconst x = 1;";

    // 1000ms is plenty for 2 lines
    expect(() =>
      executeRules([rule], "/src/app.ts", content, 1000)
    ).not.toThrow();
  });
});

// --- Unsafe Regex (fail-closed) ---

describe("executeRules — unsafe regex rejection", () => {
  it("throws on rule with nested quantifier regex (fail-closed)", () => {
    const rule = makeRegexRule({
      name: "evil-rule",
      pattern: "(a+)+$",
    });
    const content = "aaa";

    expect(() => executeRules([rule], "/src/app.ts", content, 1000)).toThrow(
      /unsafe regex/
    );
  });

  it("throws on invalid regex pattern", () => {
    const rule = makeRegexRule({
      name: "bad-regex",
      pattern: "[unclosed",
    });
    const content = "test";

    expect(() => executeRules([rule], "/src/app.ts", content, 1000)).toThrow(
      /unsafe regex/
    );
  });
});

// --- Programmatic Rule Execution ---

describe("executeRules — programmatic rules", () => {
  it("invokes handler and collects returned violations", () => {
    const rule = makeProgrammaticRule({
      name: "custom-check",
      handler: (content, filePath) => [
        makeViolation("custom-check", filePath, 1, "bad line", "Fix it"),
      ],
    });
    const violations = executeRules([rule], "/src/app.ts", "bad line\nok", 1000);

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("custom-check");
    expect(violations[0].file).toBe("/src/app.ts");
  });

  it("handler receives correct content and filePath", () => {
    let receivedContent = "";
    let receivedPath = "";

    const rule = makeProgrammaticRule({
      handler: (content, filePath) => {
        receivedContent = content;
        receivedPath = filePath;
        return [];
      },
    });

    executeRules([rule], "/src/test.ts", "hello world", 1000);

    expect(receivedContent).toBe("hello world");
    expect(receivedPath).toBe("/src/test.ts");
  });

  it("throws when handler throws (fail-closed)", () => {
    const rule = makeProgrammaticRule({
      handler: () => {
        throw new Error("Handler exploded");
      },
    });

    expect(() => executeRules([rule], "/src/app.ts", "test", 1000)).toThrow(
      "Handler exploded"
    );
  });

  it("respects extension filter for programmatic rules", () => {
    const rule = makeProgrammaticRule({
      extensions: [".java"],
      handler: () => [makeViolation("p-rule", "/src/App.java", 1, "x", "fix")],
    });

    // File is .ts, rule targets .java — should not fire
    const violations = executeRules([rule], "/src/app.ts", "anything", 1000);
    expect(violations).toEqual([]);
  });

  it("does not fire disabled programmatic rules", () => {
    const rule = makeProgrammaticRule({
      enabled: false,
      handler: () => [makeViolation("p-rule", "/src/app.ts", 1, "x", "fix")],
    });

    const violations = executeRules([rule], "/src/app.ts", "anything", 1000);
    expect(violations).toEqual([]);
  });
});

// --- Mixed Rule Types ---

describe("executeRules — mixed regex + programmatic rules", () => {
  it("aggregates violations from both rule types", () => {
    const regexRule = makeRegexRule({
      name: "no-console",
      pattern: "console\\.log",
    });
    const progRule = makeProgrammaticRule({
      name: "custom-check",
      extensions: [".ts"],
      handler: (_content, filePath) => [
        makeViolation("custom-check", filePath, 2, "issue", "fix hint"),
      ],
    });

    const content = "console.log('hi');\nsome code";
    const violations = executeRules(
      [regexRule, progRule],
      "/src/app.ts",
      content,
      1000
    );

    expect(violations.length).toBe(2);
    expect(violations[0].rule).toBe("no-console");
    expect(violations[1].rule).toBe("custom-check");
  });
});
