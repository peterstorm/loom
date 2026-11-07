/**
 * The no-clobber skeleton writer over a temp directory (AD-12): what each
 * result means on disk — written bytes and mode, `exists` on any existing
 * leaf, refusals of unsafe, frozen and symlinked paths, the refresh digest
 * guard, I/O failures as values, and no prepared file ever left behind.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/digest";
import { createSkeleton, refreshSkeleton, renderSkeletonWriteResult } from "../../src/orchestration/skeleton-writer";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

const repo = (): string => {
  const root = canonicalTempDir("loom-skeleton-writer-");
  roots.push(root);
  return root;
};

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const read = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;

const NONE: ReadonlySet<string> = new Set();
const BYTES = "export const a = 1;\n";
const OTHER = "export const b = 2;\n";

/** Every name in a directory: no prepared or temp file survives a write. */
const entries = (root: string, directory: string): readonly string[] => readdirSync(join(root, directory)).sort();

describe("createSkeleton", () => {
  it("writes the bytes, world-readable, and reports their digest", () => {
    const root = repo();
    put(root, "src/keep.ts", OTHER);
    expect(createSkeleton(root, "src/a.ts", BYTES, NONE)).toEqual({ kind: "written", sha256: sha256Hex(BYTES), leftover: null });
    expect(read(root, "src/a.ts")).toBe(BYTES);
    expect(statSync(join(root, "src/a.ts")).mode & 0o777).toBe(0o644);
    expect(entries(root, "src")).toEqual(["a.ts", "keep.ts"]);
  });

  it("creates missing parent directories one component at a time", () => {
    const root = repo();
    expect(createSkeleton(root, "src/main/java/a/b/C.java", BYTES, NONE).kind).toBe("written");
    expect(read(root, "src/main/java/a/b/C.java")).toBe(BYTES);
    expect(statSync(join(root, "src/main/java/a/b")).isDirectory()).toBe(true);
  });

  it("writes at the repository root", () => {
    const root = repo();
    expect(createSkeleton(root, "a.ts", BYTES, NONE).kind).toBe("written");
    expect(entries(root, ".")).toEqual(["a.ts"]);
  });

  it("never replaces an existing file (EEXIST is `exists`)", () => {
    const root = repo();
    put(root, "src/a.ts", OTHER);
    expect(createSkeleton(root, "src/a.ts", BYTES, NONE)).toEqual({ kind: "exists" });
    expect(read(root, "src/a.ts")).toBe(OTHER);
    expect(entries(root, "src")).toEqual(["a.ts"]);
  });

  it("never replaces an existing symlink, nor writes through it", () => {
    const root = repo();
    put(root, "elsewhere/target.ts", OTHER);
    mkdirSync(join(root, "src"));
    symlinkSync(join(root, "elsewhere/target.ts"), join(root, "src/a.ts"));
    expect(createSkeleton(root, "src/a.ts", BYTES, NONE)).toEqual({ kind: "exists" });
    expect(read(root, "elsewhere/target.ts")).toBe(OTHER);
  });

  it("never replaces an existing directory", () => {
    const root = repo();
    mkdirSync(join(root, "src/a.ts"), { recursive: true });
    expect(createSkeleton(root, "src/a.ts", BYTES, NONE)).toEqual({ kind: "exists" });
    expect(statSync(join(root, "src/a.ts")).isDirectory()).toBe(true);
  });

  it("refuses a path under a symlinked ancestor and writes nothing through it", () => {
    const root = repo();
    mkdirSync(join(root, "outside"));
    mkdirSync(join(root, "src"));
    symlinkSync(join(root, "outside"), join(root, "src/linked"));
    expect(createSkeleton(root, "src/linked/a.ts", BYTES, NONE)).toEqual({ kind: "refused", reason: "symlinked-ancestor" });
    expect(entries(root, "outside")).toEqual([]);
  });

  it("refuses a symlinked top-level directory", () => {
    const root = repo();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "src"));
    expect(createSkeleton(root, "src/deeper/a.ts", BYTES, NONE)).toEqual({ kind: "refused", reason: "symlinked-ancestor" });
    expect(entries(root, "outside")).toEqual([]);
  });

  it("refuses a frozen path, whether or not it exists", () => {
    const root = repo();
    const frozen = new Set(["src/contract.ts", "./tests/a.test.ts"]);
    expect(createSkeleton(root, "src/contract.ts", BYTES, frozen)).toEqual({ kind: "refused", reason: "frozen-path" });
    expect(createSkeleton(root, "tests/a.test.ts", BYTES, frozen)).toEqual({ kind: "refused", reason: "frozen-path" });
    expect(read(root, "src/contract.ts")).toBeNull();
    expect(read(root, "tests/a.test.ts")).toBeNull();
  });

  for (const path of ["", "/abs/a.ts", "../a.ts", "src/../a.ts", "./a.ts", "src//a.ts", "src/./a.ts", "src\\a.ts", "C:/a.ts", "src/"]) {
    it(`refuses the non-repo-relative path ${JSON.stringify(path)}`, () => {
      const root = repo();
      expect(createSkeleton(root, path, BYTES, NONE)).toEqual({ kind: "refused", reason: "not-repo-relative" });
      expect(entries(root, ".")).toEqual([]);
    });
  }

  it("reports a non-directory ancestor as an I/O failure, a value", () => {
    const root = repo();
    put(root, "src", OTHER);
    const result = createSkeleton(root, "src/a.ts", BYTES, NONE);
    expect(result.kind).toBe("io-failed");
    expect(read(root, "src")).toBe(OTHER);
  });

  it("reports an unwritable directory as an I/O failure and leaves no prepared file", () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    chmodSync(join(root, "src"), 0o555);
    try {
      const result = createSkeleton(root, "src/a.ts", BYTES, NONE);
      expect(result.kind).toBe("io-failed");
      expect(entries(root, "src")).toEqual([]);
    } finally {
      chmodSync(join(root, "src"), 0o755);
    }
  });

  it("reports a missing repository root as an I/O failure", () => {
    const root = repo();
    expect(createSkeleton(join(root, "gone"), "a.ts", BYTES, NONE).kind).toBe("io-failed");
  });
});

describe("refreshSkeleton", () => {
  it("replaces a file whose bytes are the expected engine bytes", () => {
    const root = repo();
    put(root, "src/a.ts", OTHER);
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(OTHER), BYTES, NONE)).toEqual({ kind: "written", sha256: sha256Hex(BYTES), leftover: null });
    expect(read(root, "src/a.ts")).toBe(BYTES);
    expect(statSync(join(root, "src/a.ts")).mode & 0o777).toBe(0o644);
    expect(entries(root, "src")).toEqual(["a.ts"]);
  });

  it("refuses a modified file and leaves its bytes", () => {
    const root = repo();
    put(root, "src/a.ts", OTHER);
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(BYTES), BYTES, NONE)).toEqual({ kind: "refused", reason: "modified", leftover: null });
    expect(read(root, "src/a.ts")).toBe(OTHER);
  });

  it("refuses an absent file and creates nothing", () => {
    const root = repo();
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(OTHER), BYTES, NONE)).toEqual({ kind: "refused", reason: "absent" });
    expect(read(root, "src/a.ts")).toBeNull();
  });

  it("refuses a symlink leaf and leaves its target", () => {
    const root = repo();
    put(root, "elsewhere/target.ts", OTHER);
    mkdirSync(join(root, "src"));
    symlinkSync(join(root, "elsewhere/target.ts"), join(root, "src/a.ts"));
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(OTHER), BYTES, NONE)).toEqual({ kind: "refused", reason: "not-a-regular-file" });
    expect(read(root, "elsewhere/target.ts")).toBe(OTHER);
  });

  it("refuses a frozen path, a symlinked ancestor and an unsafe path", () => {
    const root = repo();
    put(root, "outside/a.ts", OTHER);
    symlinkSync(join(root, "outside"), join(root, "src"));
    expect(refreshSkeleton(root, "frozen.ts", sha256Hex(OTHER), BYTES, new Set(["frozen.ts"]))).toEqual({ kind: "refused", reason: "frozen-path" });
    expect(refreshSkeleton(root, "src/a.ts", sha256Hex(OTHER), BYTES, NONE)).toEqual({ kind: "refused", reason: "symlinked-ancestor" });
    expect(refreshSkeleton(root, "../a.ts", sha256Hex(OTHER), BYTES, NONE)).toEqual({ kind: "refused", reason: "not-repo-relative" });
    expect(read(root, "outside/a.ts")).toBe(OTHER);
  });

  it("reports an unwritable directory as an I/O failure, keeping the bytes and leaving no temp file", () => {
    const root = repo();
    put(root, "src/a.ts", OTHER);
    chmodSync(join(root, "src"), 0o555);
    try {
      expect(refreshSkeleton(root, "src/a.ts", sha256Hex(OTHER), BYTES, NONE).kind).toBe("io-failed");
      expect(read(root, "src/a.ts")).toBe(OTHER);
      expect(entries(root, "src")).toEqual(["a.ts"]);
    } finally {
      chmodSync(join(root, "src"), 0o755);
    }
  });
});

describe("renderSkeletonWriteResult", () => {
  it("names the path and why it was not written", () => {
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "written", sha256: "0".repeat(64), leftover: null })).toBe("src/a.ts: written");
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "exists" })).toContain("left untouched");
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "refused", reason: "frozen-path" })).toBe("src/a.ts: refused (frozen-path)");
    expect(renderSkeletonWriteResult("src/a.ts", { kind: "io-failed", message: "EACCES" })).toBe("src/a.ts: write failed (EACCES)");
  });
});
