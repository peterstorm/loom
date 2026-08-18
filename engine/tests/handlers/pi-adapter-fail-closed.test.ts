/**
 * Tests for the fail-closed try/catch pattern in the Pi extension tool_result handler.
 *
 * The extension wraps processToolResult in a try/catch so that if it throws
 * (as opposed to returning an error LintResult), the error is caught and
 * an error response is returned — blocking the edit (fail-closed contract).
 *
 * This test exercises the exact logic pattern used in pi/extension.ts lines 183-216.
 */

import { describe, it, expect } from "vitest";
import { processToolResult } from "../../src/handlers/pi-adapter";

/**
 * Simulates the extension handler logic (the try/catch wrapper from pi/extension.ts).
 * This is a faithful replica of the handler body so we can unit-test the error path
 * without needing the full Pi runtime.
 */
function simulateExtensionHandler(
  toolName: string,
  input: Record<string, unknown>,
  lintFn: Parameters<typeof processToolResult>[2],
) {
  try {
    if (toolName !== "edit" && toolName !== "write") return undefined;

    const response = processToolResult(
      toolName,
      input,
      lintFn
    );

    if (response) {
      return {
        content: response.content.map(c => ({ type: c.type as "text", text: c.text })),
        isError: response.isError,
      };
    }
    return undefined;
  } catch (error: unknown) {
    // Fail-closed: any error → inject error content to block the edit
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `❌ LINT ENGINE ERROR: ${message}` }],
      isError: true,
    };
  }
}

describe("Pi extension tool_result handler fail-closed (try/catch)", () => {
  describe("when processToolResult throws an Error", () => {
    it("catches the error and returns an error response", () => {
      const throwingLint = () => { throw new Error("Catastrophic regex engine failure"); };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0].type).toBe("text");
      expect(result!.content[0].text).toContain("❌ LINT ENGINE ERROR");
      expect(result!.content[0].text).toContain("Catastrophic regex engine failure");
    });

    it("blocks the edit (isError: true)", () => {
      const throwingLint = () => { throw new Error("file system exploded"); };

      const result = simulateExtensionHandler("write", { path: "/src/index.ts", content: "x" }, throwingLint);

      expect(result!.isError).toBe(true);
    });
  });

  describe("when processToolResult throws a non-Error value", () => {
    it("catches string throws and returns error response", () => {
      const throwingLint = () => { throw "raw string error"; };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("❌ LINT ENGINE ERROR");
      expect(result!.content[0].text).toContain("raw string error");
    });

    it("catches number throws and returns error response", () => {
      const throwingLint = () => { throw 42; };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("42");
    });

    it("catches null/undefined throws", () => {
      const throwingNull = () => { throw null; };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingNull);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("❌ LINT ENGINE ERROR");
    });
  });

  describe("normal flow still works correctly within try/catch", () => {
    it("returns undefined for non-edit/write tools (early return unaffected)", () => {
      const throwingLint = () => { throw new Error("should never reach lint"); };

      const result = simulateExtensionHandler("read", { path: "/src/app.ts" }, throwingLint);

      expect(result).toBeUndefined();
    });

    it("returns undefined when lint passes (no violations)", () => {
      const passingLint = () => ({ kind: "pass" as const });

      const result = simulateExtensionHandler("edit", { path: "/src/clean.ts" }, passingLint);

      expect(result).toBeUndefined();
    });

    it("returns error response for violations (normal violation path)", () => {
      const violationLint = () => ({
        kind: "violations" as const,
        violations: [{
          rule: "no-console",
          file: "/src/app.ts",
          line: 5,
          text: "console.log('x')",
          fixHint: "Remove console.log",
        }],
      });

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, violationLint);

      expect(result).toBeDefined();
      expect(result!.isError).toBe(true);
      expect(result!.content[0].text).toContain("LINT VIOLATIONS");
    });
  });

  describe("error message formatting", () => {
    it("includes the full error message for Error instances", () => {
      const throwingLint = () => { throw new Error("ENOENT: no such file or directory"); };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

      // processToolResult catches the throw and wraps it as a lint error result,
      // which formatBlockMessage renders with the file path and error detail
      expect(result!.content[0].text).toContain("ENOENT: no such file or directory");
      expect(result!.isError).toBe(true);
    });

    it("stringifies non-Error throws", () => {
      const throwingLint = () => { throw { code: "ERR_TIMEOUT", detail: "regex took too long" }; };

      const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

      expect(result!.content[0].text).toContain("LINT ENGINE ERROR");
      expect(result!.content[0].text).toContain("[object Object]");
    });
  });
});
