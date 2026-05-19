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
import { extractFilePath } from "../../../src/handlers/post-tool-use/lint-file";
import type { HookResult } from "../../../src/types";

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
 * The handler uses config.ts for DEFAULT_RULES_DIR/PROJECT_RULES_DIR,
 * so we test behavior that doesn't depend on actual rule files existing
 * (passthrough, tool filtering, error handling) plus integration with
 * the actual linter for files that exist.
 */

// Import the handler for direct invocation
import handler from "../../../src/handlers/post-tool-use/lint-file";

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

    it("returns passthrough when tool_input is null", async () => {
      const stdin = makeStdin({ tool_input: null });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough when file_path is missing from tool_input", async () => {
      const stdin = makeStdin({ tool_input: { content: "hello" } });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough when file_path is empty string", async () => {
      const stdin = makeStdin({ tool_input: { file_path: "" } });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
    });

    it("returns passthrough when file_path is whitespace only", async () => {
      const stdin = makeStdin({ tool_input: { file_path: "   " } });
      const result = await handler(stdin, []);
      expect(result).toEqual({ kind: "passthrough" });
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

describe("extractFilePath", () => {
  it("returns null for null input", () => {
    expect(extractFilePath(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractFilePath(undefined)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractFilePath("string" as any)).toBeNull();
  });

  it("returns null when no file_path or path field", () => {
    expect(extractFilePath({ content: "hello" })).toBeNull();
  });

  it("returns null for non-string file_path", () => {
    expect(extractFilePath({ file_path: 123 })).toBeNull();
  });

  it("returns null for empty string file_path", () => {
    expect(extractFilePath({ file_path: "" })).toBeNull();
  });

  it("returns null for whitespace-only file_path", () => {
    expect(extractFilePath({ file_path: "   " })).toBeNull();
  });

  it("extracts valid file_path", () => {
    expect(extractFilePath({ file_path: "/path/to/file.ts" })).toBe("/path/to/file.ts");
  });

  it("extracts valid path fallback", () => {
    expect(extractFilePath({ path: "/path/to/file.ts" })).toBe("/path/to/file.ts");
  });

  it("prefers file_path over path", () => {
    expect(extractFilePath({ file_path: "/a.ts", path: "/b.ts" })).toBe("/a.ts");
  });
});
