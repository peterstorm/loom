import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findFile } from "../../src/utils/find-file";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

  it("throws on non-ENOENT errors instead of reporting the directory absent", () => {
    const unreadable = join(tmpDir, "loop");
    symlinkSync(unreadable, unreadable);

    expect(() => findFile(unreadable, "file.md")).toThrow(/findFile error.*ELOOP|findFile error.*symbolic/i);
  });
});
