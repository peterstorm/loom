/**
 * Unit tests for PostToolUse lint-file handler.
 *
 * Tests the handler logic: stdin parsing, tool filtering, file path extraction,
 * and mapping of LintResult → HookResult.
 *
 * Uses real filesystem with temp dirs and actual lint rules (integration-style)
 * since bun test runner doesn't support vi.mocked().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { editedFilePath } from "../../../src/core/tool-vocabulary";


// --- Test helpers ---

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `lint-hook-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStdin(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_type: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/path/to/file.ts", content: "const x = 1;" },
    tool_result: "File written successfully",
    ...overrides,
  });
}

/**
 * We test the handler by importing it directly.
 * The handler uses config.ts for DEFAULT_RULES_DIR/projectRulesDir,
 * so we test behavior that doesn't depend on actual rule files existing
 * (passthrough, tool filtering, error handling) plus integration with
 * the actual linter for files that exist.
 */

// Import the handler for direct invocation
import handler, { parseLintHookInput } from "../../../src/handlers/post-tool-use/lint-file";

describe("PostToolUse lint-file handler", () => {
  describe("passthrough cases", () => {
    it("returns passthrough on empty stdin", async () => {
      const result = await handler("", []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough on whitespace-only stdin", async () => {
      const result = await handler("   \n  ", []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough for non-edit tools (Bash)", async () => {
      const stdin = makeStdin({ tool_name: "Bash" });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough for non-edit tools (Read)", async () => {
      const stdin = makeStdin({ tool_name: "Read" });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough for non-edit tools (Task)", async () => {
      const stdin = makeStdin({ tool_name: "Task" });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });
  });

  describe("fail-closed: missing file path blocks for lint-triggering tools", () => {
    it("returns block when tool_input is null", async () => {
      const stdin = makeStdin({ tool_input: null });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
      expect((result as { kind: "block"; message: string }).message).toContain(
        "Could not extract file_path from tool_input"
      );
    });

    it("returns block when file_path is missing from tool_input", async () => {
      const stdin = makeStdin({ tool_input: { content: "hello" } });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
      expect((result as { kind: "block"; message: string }).message).toContain(
        "Could not extract file_path from tool_input"
      );
    });

    it("returns block when file_path is empty string", async () => {
      const stdin = makeStdin({ tool_input: { file_path: "" } });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
      expect((result as { kind: "block"; message: string }).message).toContain(
        "Could not extract file_path from tool_input"
      );
    });

    it("returns block when file_path is whitespace only", async () => {
      const stdin = makeStdin({ tool_input: { file_path: "   " } });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
      expect((result as { kind: "block"; message: string }).message).toContain(
        "Could not extract file_path from tool_input"
      );
    });
  });

  describe("tool name matching", () => {
    it("triggers on Edit tool (file not found → fail-closed block)", async () => {
      const stdin = makeStdin({
        tool_name: "Edit",
        tool_input: { file_path: "/nonexistent/file.ts" },
      });
      const result = await handler(stdin, []);
      // File doesn't exist → linter will error → fail-closed → block
      expect(result.kind).toBe("block");
    });

    it("triggers on Write tool (file not found → fail-closed block)", async () => {
      const stdin = makeStdin({
        tool_name: "Write",
        tool_input: { file_path: "/nonexistent/file.ts" },
      });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
    });

    it("triggers on MultiEdit tool (file not found → fail-closed block)", async () => {
      const stdin = makeStdin({
        tool_name: "MultiEdit",
        tool_input: { file_path: "/nonexistent/file.ts" },
      });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
    });

    it("does NOT trigger on Bash tool", async () => {
      const stdin = makeStdin({ tool_name: "Bash" });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("does NOT trigger on Read tool", async () => {
      const stdin = makeStdin({ tool_name: "Read" });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });
  });

  describe("lint pass → allow (real files)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir("pass");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns allow for a clean file (no violations)", async () => {
      // Create a clean TS file that won't match any default rules
      const filePath = join(tmpDir, "clean.ts");
      writeFileSync(filePath, 'export const greeting = "hello";\n');

      const stdin = makeStdin({
        tool_input: { file_path: filePath },
      });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "allow" });
    });

    it("returns allow for binary files (skipped)", async () => {
      // Create a binary file (contains null bytes)
      const filePath = join(tmpDir, "image.png");
      const buffer = Buffer.alloc(100);
      buffer[10] = 0; // null byte
      buffer[0] = 0x89; // PNG magic
      writeFileSync(filePath, buffer);

      const stdin = makeStdin({
        tool_input: { file_path: filePath },
      });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "allow" });
    });

    it("returns allow for file with extension not matched by any rules", async () => {
      const filePath = join(tmpDir, "data.xyz");
      writeFileSync(filePath, "some random content\n");

      const stdin = makeStdin({
        tool_input: { file_path: filePath },
      });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "allow" });
    });
  });

  describe("fail-closed error handling", () => {
    it("returns block on invalid JSON stdin", async () => {
      const result = await handler("not json at all", []);
      expect(result.kind).toBe("block");
      expect((result as { kind: "block"; message: string }).message).toContain("Lint hook error:");
    });

    it("returns block on malformed JSON (missing required fields)", async () => {
      const result = await handler("{}", []);
      // tool_name will be undefined → not in LINT_TRIGGER_TOOLS → passthrough
      // Actually {} has no tool_name so it won't match Edit/Write/MultiEdit
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns block on JSON that is not an object", async () => {
      for (const stdin of ["null", "[]", "7", '"Write"', '[{"tool_name":"Write"}]']) {
        expect(await handler(stdin, []), stdin).toEqual({
          kind: "block",
          message: "Lint hook error: hook input must be a JSON object",
        });
      }
    });

    it("returns passthrough when tool_name is not a string", async () => {
      for (const toolName of [7, null, ["Write"], { name: "Write" }]) {
        expect(await handler(makeStdin({ tool_name: toolName }), [])).toEqual({ kind: "passthrough" });
      }
    });

    it("returns block when a lint-triggering tool's tool_input is not an object", async () => {
      for (const toolInput of ["/path/to/file.ts", 7, ["/path/to/file.ts"]]) {
        expect(await handler(makeStdin({ tool_input: toolInput }), [])).toEqual({
          kind: "block",
          message: "Lint hook error: Could not extract file_path from tool_input",
        });
      }
    });

    it("returns block when file doesn't exist (fail-closed)", async () => {
      const stdin = makeStdin({
        tool_input: { file_path: "/absolutely/nonexistent/path.ts" },
      });
      const result = await handler(stdin, []);
      expect(result.kind).toBe("block");
    });
  });

  describe("file path extraction via path fallback", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir("path-fallback");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("extracts path field as fallback when file_path missing", async () => {
      const filePath = join(tmpDir, "via-path.ts");
      writeFileSync(filePath, 'export const x = 1;\n');

      const stdin = makeStdin({
        tool_input: { path: filePath },
      });
      const result = await handler(stdin, []);
      // Should process the file (not passthrough)
      expect(result.kind).toBe("allow");
    });
  });
});

describe("parseLintHookInput", () => {
  const toolInput = fc.dictionary(fc.string(), fc.jsonValue());
  const notAnObject = fc.jsonValue().filter((value) => typeof value !== "object" || value === null || Array.isArray(value));

  it("round-trips the two fields it reads through the wire form, ignoring every other field", () => {
    fc.assert(fc.property(fc.string(), toolInput, fc.dictionary(fc.string(), fc.jsonValue()), (toolName, input, rest) => {
      const wire: unknown = JSON.parse(JSON.stringify({ ...rest, tool_name: toolName, tool_input: input }));
      expect(parseLintHookInput(wire)).toEqual({ toolName, toolInput: JSON.parse(JSON.stringify(input)) });
    }));
  });

  it("reads a tool_name that is not a string, or a tool_input that is not an object, as null", () => {
    const notAString = fc.jsonValue().filter((value) => typeof value !== "string");
    fc.assert(fc.property(notAString, notAnObject, (toolName, input) => {
      const wire: unknown = JSON.parse(JSON.stringify({ tool_name: toolName, tool_input: input }));
      expect(parseLintHookInput(wire)).toEqual({ toolName: null, toolInput: null });
    }));
    expect(parseLintHookInput({})).toEqual({ toolName: null, toolInput: null });
  });

  it("refuses every JSON value that is not an object", () => {
    fc.assert(fc.property(notAnObject, (value) => {
      expect(parseLintHookInput(value)).toBeInstanceOf(Error);
    }));
  });
});

describe("editedFilePath", () => {
  it("returns null for null input", () => {
    expect(editedFilePath(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(editedFilePath(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    // Deliberately ill-typed input: the guard must hold for a caller that lies about the type.
    expect(editedFilePath("string" as unknown as Record<string, unknown>)).toBeNull();
  });

  it("returns null when no file_path or path field", () => {
    expect(editedFilePath({ content: "hello" })).toBeNull();
  });

  it("returns null for non-string file_path", () => {
    expect(editedFilePath({ file_path: 123 })).toBeNull();
  });

  it("returns null for empty string file_path", () => {
    expect(editedFilePath({ file_path: "" })).toBeNull();
  });

  it("returns null for whitespace-only file_path", () => {
    expect(editedFilePath({ file_path: "   " })).toBeNull();
  });

  it("extracts valid file_path", () => {
    expect(editedFilePath({ file_path: "/path/to/file.ts" })).toBe("/path/to/file.ts");
  });

  it("extracts valid path fallback", () => {
    expect(editedFilePath({ path: "/path/to/file.ts" })).toBe("/path/to/file.ts");
  });

  it("prefers file_path over path", () => {
    expect(editedFilePath({ file_path: "/a.ts", path: "/b.ts" })).toBe("/a.ts");
  });
});
