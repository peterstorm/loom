import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { findFile } from "../../src/utils/find-file";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("findFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "loom-ff-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("finds file in top directory", () => {
    writeFileSync(join(tmpDir, "brainstorm.md"), "x");
    expect(findFile(tmpDir, "brainstorm.md")).toBe(join(tmpDir, "brainstorm.md"));
  });

  it("finds file in nested directory", () => {
    const nested = join(tmpDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "spec.md"), "x");
    expect(findFile(tmpDir, "spec.md")).toBe(join(nested, "spec.md"));
  });

  it("returns null for missing file", () => {
    expect(findFile(tmpDir, "nope.md")).toBeNull();
  });

  it("returns null for missing directory", () => {
    expect(findFile(join(tmpDir, "nope"), "f.md")).toBeNull();
  });

  it("logs non-ENOENT errors to stderr", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Create a directory that can't be read
    const unreadable = join(tmpDir, "secret");
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);

    const result = findFile(unreadable, "file.md");

    // Should return null (can't read the dir)
    expect(result).toBeNull();
    // Should have logged to stderr (EACCES or similar)
    const logged = stderrSpy.mock.calls.some(
      ([msg]) => typeof msg === "string" && msg.includes("findFile error"),
    );
    expect(logged).toBe(true);

    // Restore permissions for cleanup
    chmodSync(unreadable, 0o755);
    stderrSpy.mockRestore();
  });
});
