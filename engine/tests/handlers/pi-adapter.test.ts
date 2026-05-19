/**
 * Tests for Pi extension adapter — pure function for edit/write lint integration.
 *
 * Tests the functional core without any Pi runtime dependency:
 * - shouldTriggerLint: only edit/write tools
 * - extractFilePath: graceful path extraction
 * - handleLintResult: LintResult → PiToolResultResponse mapping
 * - processToolResult: end-to-end orchestration with injected lint function
 */

import { describe, it, expect } from "vitest";
import {
  shouldTriggerLint,
  extractFilePath,
  handleLintResult,
  processToolResult,
  type PiToolResultResponse,
} from "../../src/handlers/pi-adapter";
import type { LintResult, Violation } from "../../src/linter/types";
import { passResult, violationsResult, lintErrorResult, makeViolation } from "../../src/linter/types";

// --- Test fixtures ---

function makeTestViolation(overrides?: Partial<Violation>): Violation {
  return makeViolation(
    overrides?.rule ?? "no-console",
    overrides?.file ?? "/src/app.ts",
    overrides?.line ?? 5,
    overrides?.text ?? "console.log('hello')",
    overrides?.fixHint ?? "Remove console.log in production code"
  );
}

// --- shouldTriggerLint ---

describe("shouldTriggerLint", () => {
  it("returns true for 'edit' tool", () => {
    expect(shouldTriggerLint("edit")).toBe(true);
  });

  it("returns true for 'write' tool", () => {
    expect(shouldTriggerLint("write")).toBe(true);
  });

  it("returns false for 'read' tool", () => {
    expect(shouldTriggerLint("read")).toBe(false);
  });

  it("returns false for 'bash' tool", () => {
    expect(shouldTriggerLint("bash")).toBe(false);
  });

  it("returns false for 'grep' tool", () => {
    expect(shouldTriggerLint("grep")).toBe(false);
  });

  it("returns false for 'find' tool", () => {
    expect(shouldTriggerLint("find")).toBe(false);
  });

  it("returns false for 'ls' tool", () => {
    expect(shouldTriggerLint("ls")).toBe(false);
  });

  it("returns false for 'subagent' tool", () => {
    expect(shouldTriggerLint("subagent")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldTriggerLint("")).toBe(false);
  });

  it("returns false for unknown custom tool", () => {
    expect(shouldTriggerLint("my-custom-tool")).toBe(false);
  });
});

// --- extractFilePath ---

describe("extractFilePath", () => {
  it("extracts path from edit tool input", () => {
    const input = { path: "/src/app.ts", edits: [] };
    expect(extractFilePath(input)).toBe("/src/app.ts");
  });

  it("extracts path from write tool input", () => {
    const input = { path: "/src/new-file.ts", content: "hello" };
    expect(extractFilePath(input)).toBe("/src/new-file.ts");
  });

  it("returns null for missing path", () => {
    const input = { content: "hello" };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for empty string path", () => {
    const input = { path: "" };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for whitespace-only path", () => {
    const input = { path: "   " };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for non-string path (number)", () => {
    const input = { path: 42 };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for non-string path (boolean)", () => {
    const input = { path: true };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for null path", () => {
    const input = { path: null };
    expect(extractFilePath(input)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractFilePath(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it("handles relative paths", () => {
    const input = { path: "src/app.ts" };
    expect(extractFilePath(input)).toBe("src/app.ts");
  });
});

// --- handleLintResult ---

describe("handleLintResult", () => {
  const testFilePath = "/src/app.ts";

  describe("pass results", () => {
    it("returns undefined for pass result", () => {
      const result = handleLintResult(testFilePath, passResult());
      expect(result).toBeUndefined();
    });
  });

  describe("violation results", () => {
    it("returns error response with formatted message for violations", () => {
      const violation = makeTestViolation();
      const lintResult: LintResult = { kind: "violations", violations: [violation] };

      const response = handleLintResult(testFilePath, lintResult);

      expect(response).toBeDefined();
      expect(response!.isError).toBe(true);
      expect(response!.content).toHaveLength(1);
      expect(response!.content[0].type).toBe("text");
      expect(response!.content[0].text).toContain("LINT VIOLATIONS");
      expect(response!.content[0].text).toContain(testFilePath);
      expect(response!.content[0].text).toContain("no-console");
    });

    it("includes all violations in message", () => {
      const violations: Violation[] = [
        makeTestViolation({ rule: "no-console", line: 5 }),
        makeTestViolation({ rule: "no-debugger", line: 10, text: "debugger;", fixHint: "Remove debugger statement" }),
      ];
      const lintResult: LintResult = { kind: "violations", violations };

      const response = handleLintResult(testFilePath, lintResult);

      expect(response!.content[0].text).toContain("no-console");
      expect(response!.content[0].text).toContain("no-debugger");
      expect(response!.content[0].text).toContain("line 5");
      expect(response!.content[0].text).toContain("line 10");
    });

    it("includes fix hints in message", () => {
      const violation = makeTestViolation({ fixHint: "Use a proper logger instead" });
      const lintResult: LintResult = { kind: "violations", violations: [violation] };

      const response = handleLintResult(testFilePath, lintResult);

      expect(response!.content[0].text).toContain("Use a proper logger instead");
    });
  });

  describe("error results", () => {
    it("returns error response for lint engine errors", () => {
      const lintResult = lintErrorResult("Rule file not found: /path/to/rules.json");

      const response = handleLintResult(testFilePath, lintResult);

      expect(response).toBeDefined();
      expect(response!.isError).toBe(true);
      expect(response!.content).toHaveLength(1);
      expect(response!.content[0].type).toBe("text");
      expect(response!.content[0].text).toContain("LINT ENGINE ERROR");
      expect(response!.content[0].text).toContain(testFilePath);
      expect(response!.content[0].text).toContain("Rule file not found");
    });

    it("handles empty error message gracefully", () => {
      const lintResult = lintErrorResult("");

      const response = handleLintResult(testFilePath, lintResult);

      expect(response).toBeDefined();
      expect(response!.isError).toBe(true);
      expect(response!.content[0].text).toContain("LINT ENGINE ERROR");
    });
  });
});

// --- processToolResult (end-to-end orchestration) ---

describe("processToolResult", () => {
  describe("tool filtering", () => {
    it("returns undefined for non-edit/write tools", () => {
      const mockLint = () => passResult();
      expect(processToolResult("read", { path: "/src/app.ts" }, mockLint)).toBeUndefined();
      expect(processToolResult("bash", { command: "ls" }, mockLint)).toBeUndefined();
      expect(processToolResult("grep", { pattern: "foo" }, mockLint)).toBeUndefined();
      expect(processToolResult("subagent", { agent: "test" }, mockLint)).toBeUndefined();
    });

    it("processes edit tool results", () => {
      const mockLint = () => passResult();
      const result = processToolResult("edit", { path: "/src/app.ts", edits: [] }, mockLint);
      expect(result).toBeUndefined(); // pass → undefined
    });

    it("processes write tool results", () => {
      const mockLint = () => passResult();
      const result = processToolResult("write", { path: "/src/app.ts", content: "x" }, mockLint);
      expect(result).toBeUndefined(); // pass → undefined
    });
  });

  describe("path extraction failure", () => {
    it("returns error when path is missing from input", () => {
      const mockLint = () => passResult();
      const result = processToolResult("edit", { edits: [] }, mockLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("Could not extract file path");
    });

    it("returns error when path is empty", () => {
      const mockLint = () => passResult();
      const result = processToolResult("write", { path: "", content: "x" }, mockLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("Could not extract file path");
    });
  });

  describe("lint passes", () => {
    it("returns undefined when lint passes", () => {
      const mockLint = () => passResult();
      const result = processToolResult("edit", { path: "/src/clean.ts" }, mockLint);
      expect(result).toBeUndefined();
    });
  });

  describe("lint violations", () => {
    it("returns error response with violations", () => {
      const violation = makeTestViolation({ file: "/src/bad.ts" });
      const mockLint = () => ({ kind: "violations" as const, violations: [violation] });

      const result = processToolResult("edit", { path: "/src/bad.ts" }, mockLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("LINT VIOLATIONS");
      expect(result!.content[0].text).toContain("no-console");
    });

    it("passes correct file path to lint function", () => {
      let receivedPath: string | undefined;
      const mockLint = (filePath: string) => {
        receivedPath = filePath;
        return passResult();
      };

      processToolResult("write", { path: "/some/specific/path.ts" }, mockLint);

      expect(receivedPath).toBe("/some/specific/path.ts");
    });
  });

  describe("lint errors (fail-closed)", () => {
    it("returns error response when lint engine errors", () => {
      const mockLint = () => lintErrorResult("Unexpected regex timeout");

      const result = processToolResult("edit", { path: "/src/file.ts" }, mockLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("LINT ENGINE ERROR");
      expect(result!.content[0].text).toContain("Unexpected regex timeout");
    });

    it("handles lint function throwing (caller responsibility, but tests contract)", () => {
      // processToolResult doesn't catch throws — that's lintFile's job.
      // But we document the expectation that lintFn itself handles errors.
      const mockLint = (): LintResult => lintErrorResult("Internal failure");

      const result = processToolResult("write", { path: "/src/file.ts" }, mockLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
    });
  });

  describe("response shape", () => {
    it("content array contains exactly one text block for violations", () => {
      const violation = makeTestViolation();
      const mockLint = () => ({ kind: "violations" as const, violations: [violation] });

      const result = processToolResult("edit", { path: "/src/file.ts" }, mockLint);

      expect(result!.content).toHaveLength(1);
      expect(result!.content[0]).toEqual({
        type: "text",
        text: expect.any(String),
      });
    });

    it("content array contains exactly one text block for errors", () => {
      const mockLint = () => lintErrorResult("Something broke");

      const result = processToolResult("edit", { path: "/src/file.ts" }, mockLint);

      expect(result!.content).toHaveLength(1);
      expect(result!.content[0]).toEqual({
        type: "text",
        text: expect.any(String),
      });
    });

    it("isError is always true for non-undefined responses", () => {
      const violation = makeTestViolation();
      const mockLintViolations = () => ({ kind: "violations" as const, violations: [violation] });
      const mockLintError = () => lintErrorResult("err");

      const r1 = processToolResult("edit", { path: "/f.ts" }, mockLintViolations);
      const r2 = processToolResult("edit", { path: "/f.ts" }, mockLintError);
      const r3 = processToolResult("edit", { path: "" }, () => passResult()); // missing path

      expect(r1!.isError).toBe(true);
      expect(r2!.isError).toBe(true);
      expect(r3!.isError).toBe(true);
    });
  });

  describe("fail-closed on throwing lintFn", () => {
    it("catches lintFn that throws an Error and returns error response", () => {
      const throwingLint = (): never => { throw new Error("catastrophic regex engine failure"); };

      const result = processToolResult("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("LINT ENGINE ERROR");
      expect(result!.content[0].text).toContain("catastrophic regex engine failure");
    });

    it("catches lintFn that throws a non-Error value", () => {
      const throwingLint = (): never => { throw "raw string error"; };

      const result = processToolResult("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("raw string error");
    });

    it("does not return undefined (pass) when lintFn throws", () => {
      const throwingLint = (): never => { throw new Error("boom"); };

      const result = processToolResult("write", { path: "/src/index.ts" }, throwingLint);

      // Must NOT be undefined (which would mean "pass") — must be an error response
      expect(result).not.toBeUndefined();
      expect(result!.isError).toBe(true);
    });

    it("works with multi_edit tool name", () => {
      const throwingLint = (): never => { throw new Error("timeout"); };

      const result = processToolResult("multi_edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
    });
  });
});
