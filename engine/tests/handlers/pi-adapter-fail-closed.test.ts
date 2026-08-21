/**
 * Fail-closed coverage for the Pi extension's `tool_result` lint path.
 *
 * There are TWO catches on this path, and they are not interchangeable:
 *
 *  1. `processToolResult`'s own catch (`src/handlers/pi-adapter.ts`) converts a
 *     throwing `lintFn` into an `{ kind: "error" }` LintResult and RETURNS it.
 *     It never rethrows.
 *  2. The extension's outer `try/catch` (`pi/extension.ts`, the `tool_result`
 *     handler registered for `edit`/`write`) catches anything the handler body
 *     throws AROUND that call — project-root and rules-directory resolution,
 *     and the response mapping.
 *
 * This file used to feed a throwing `lintFn` and claim it covered (2). It did
 * not: (1) swallows that throw first, so every assertion passed through the
 * normal return path while the outer wrapper was never entered. Both layers are
 * covered below, each by an input that can only reach it.
 */

import { describe, it, expect } from "vitest";
import { processToolResult } from "../../src/handlers/pi-adapter";

/**
 * A faithful replica of the extension's handler body, including the
 * pre-`processToolResult` work that lives INSIDE its try block. `resolveRoot`
 * stands in for `process.cwd()` + `existsSync(...)`: real, fallible I/O —
 * `process.cwd()` throws `ENOENT` when the working directory has been removed
 * out from under a long-lived process.
 */
function simulateExtensionHandler(
  toolName: string,
  input: Record<string, unknown>,
  lintFn: Parameters<typeof processToolResult>[2],
  resolveRoot: () => string = () => "/repo",
) {
  try {
    if (toolName !== "edit" && toolName !== "write") return undefined;

    // Inside the try, exactly as in pi/extension.ts.
    const projectRoot = resolveRoot();

    const response = processToolResult(
      toolName,
      { ...input, projectRoot },
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

describe("the extension's outer fail-closed wrapper", () => {
  // These are the ONLY cases in this file that reach the outer catch: the
  // throw happens before processToolResult is ever called, so its internal
  // catch cannot intercept it.
  it("blocks the edit when project-root resolution throws", () => {
    const cwdGone = () => { throw new Error("ENOENT: uv_cwd"); };
    const passingLint = () => ({ kind: "pass" as const });

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, passingLint, cwdGone);

    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("❌ LINT ENGINE ERROR");
    expect(result!.content[0].text).toContain("ENOENT: uv_cwd");
  });

  it("blocks the edit on a non-Error throw from the same step", () => {
    const cwdGone = () => { throw "raw string error"; };
    const passingLint = () => ({ kind: "pass" as const });

    const result = simulateExtensionHandler("write", { path: "/src/index.ts", content: "x" }, passingLint, cwdGone);

    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("raw string error");
  });

  it("does not fire for tools it does not gate, even when resolution would throw", () => {
    const cwdGone = () => { throw new Error("should never be reached"); };
    const passingLint = () => ({ kind: "pass" as const });

    // The early return precedes the resolution step, so nothing throws at all.
    expect(simulateExtensionHandler("read", { path: "/src/app.ts" }, passingLint, cwdGone)).toBeUndefined();
  });
});

describe("processToolResult's own fail-closed catch", () => {
  // A throwing lintFn never escapes processToolResult, so these prove the
  // INNER catch and its error formatting — not the wrapper above.
  it("converts a thrown Error into a blocking error result", () => {
    const throwingLint = () => { throw new Error("Catastrophic regex engine failure"); };

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content).toHaveLength(1);
    expect(result!.content[0].type).toBe("text");
    expect(result!.content[0].text).toContain("Catastrophic regex engine failure");
  });

  it("blocks the edit for a write as well", () => {
    const throwingLint = () => { throw new Error("file system exploded"); };

    const result = simulateExtensionHandler("write", { path: "/src/index.ts", content: "x" }, throwingLint);

    expect(result!.isError).toBe(true);
  });

  it("never rethrows, so the outer wrapper is not what produced the result", () => {
    const throwingLint = () => { throw new Error("boom"); };

    // Called directly — no surrounding try/catch. A rethrow would fail this.
    expect(() => processToolResult("edit", { path: "/src/app.ts" }, throwingLint)).not.toThrow();
    const direct = processToolResult("edit", { path: "/src/app.ts" }, throwingLint);
    expect(direct?.isError).toBe(true);
    expect(direct?.content[0]!.text).toContain("boom");
  });

  it("stringifies a thrown string", () => {
    const throwingLint = () => { throw "raw string error"; };

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("raw string error");
  });

  it("stringifies a thrown number", () => {
    const throwingLint = () => { throw 42; };

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].text).toContain("42");
  });

  it("still blocks when the thrown value is null", () => {
    const throwingNull = () => { throw null; };

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingNull);

    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
  });

  it("stringifies a thrown object", () => {
    const throwingLint = () => { throw { code: "ERR_TIMEOUT", detail: "regex took too long" }; };

    const result = simulateExtensionHandler("edit", { path: "/src/app.ts" }, throwingLint);

    expect(result!.content[0].text).toContain("[object Object]");
  });
});

describe("normal flow through both layers", () => {
  it("returns undefined for non-edit/write tools", () => {
    const throwingLint = () => { throw new Error("should never reach lint"); };

    expect(simulateExtensionHandler("read", { path: "/src/app.ts" }, throwingLint)).toBeUndefined();
  });

  it("returns undefined when lint passes", () => {
    const passingLint = () => ({ kind: "pass" as const });

    expect(simulateExtensionHandler("edit", { path: "/src/clean.ts" }, passingLint)).toBeUndefined();
  });

  it("returns an error response for violations", () => {
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
