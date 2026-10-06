import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, write } from "../../../fixtures/git-repository";
import { baselineBlob } from "../../../../src/handlers/helpers/programs/changed-paths";

describe("baselineBlob reads absence from plumbing, not localized stderr", () => {
  const originalCwd = process.cwd();
  let root: string | null = null;

  afterEach(() => {
    process.chdir(originalCwd);
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const repository = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "loom-changed-paths-baseline-"));
    root = dir;
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    git(dir, ["config", "user.name", "Fixture"]);
    write(dir, "a.txt", "hello\n");
    write(dir, "empty.txt", "");
    write(dir, "dir/b.txt", "nested\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "seed"]);
    process.chdir(dir);
    return dir;
  };

  it("returns the exact bytes of a committed file, including an empty one", () => {
    repository();
    expect(Buffer.from(baselineBlob("HEAD", "a.txt") ?? []).toString("utf8")).toBe("hello\n");
    expect(Buffer.from(baselineBlob("HEAD", "dir/b.txt") ?? []).toString("utf8")).toBe("nested\n");
    expect(baselineBlob("HEAD", "empty.txt")).toEqual(new Uint8Array());
  });

  it("returns null for a path the revision does not have, under any Git locale", () => {
    repository();
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = "de_DE.UTF-8";
    try {
      expect(baselineBlob("HEAD", "missing.txt")).toBeNull();
      expect(baselineBlob("HEAD", "dir/missing.txt")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });

  it("throws for a tree path and for an unknown revision instead of reporting an added file", () => {
    repository();
    expect(() => baselineBlob("HEAD", "dir")).toThrow("HEAD:dir is a tree, not a file");
    expect(() => baselineBlob("0".repeat(40), "a.txt")).toThrow();
  });
});
