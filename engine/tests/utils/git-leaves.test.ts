import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitOutput,
  nulSeparatedGitPaths,
  presentAtRevision,
  revisionTreeLeaves,
  worktreeLeafBytes,
  worktreeVisibleLeaves,
  type WorktreeLeaf,
} from "../../src/utils/git-leaves";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git, gitResult, write } from "../fixtures/git-repository";

let root: string;

function initRepository(dir: string): void {
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", message]);
  return gitResult(root, ["rev-parse", "HEAD"]).stdout.trim();
}

const blobSha = (revision: string, path: string): string =>
  gitResult(root, ["rev-parse", `${revision}:${path}`]).stdout.trim();

const present = (leaf: WorktreeLeaf): Extract<WorktreeLeaf, { absolute: string }> => {
  if (leaf.kind !== "file" && leaf.kind !== "symlink") throw new Error(`present leaf expected, got ${leaf.kind}`);
  return leaf;
};

beforeEach(() => {
  root = canonicalTempDir("loom-git-leaves-");
  initRepository(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("gitOutput", () => {
  it("returns stdout bytes verbatim", () => {
    write(root, "a.txt", "alpha\n");
    const head = commitAll("base");
    const output = gitOutput(root, ["rev-parse", "HEAD"]);
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString("utf-8")).toBe(`${head}\n`);
    expect(gitOutput(root, ["cat-file", "-p", `${head}:a.txt`]).toString("utf-8")).toBe("alpha\n");
  });

  it("throws when git exits non-zero", () => {
    expect(() => gitOutput(root, ["rev-parse", "--verify", "no-such-revision"])).toThrow(/Command failed: git rev-parse --verify no-such-revision/);
  });
});

describe("nulSeparatedGitPaths", () => {
  it("splits NUL-terminated output and keeps spaces, newlines and tabs inside paths", () => {
    write(root, "plain.txt", "1");
    write(root, "with space.txt", "2");
    write(root, "line\nbreak.txt", "3");
    write(root, "tab\there.txt", "4");
    git(root, ["add", "-A"]);
    expect(nulSeparatedGitPaths(root, ["ls-files", "-z"])).toEqual(["line\nbreak.txt", "plain.txt", "tab\there.txt", "with space.txt"]);
  });

  it("returns no paths for empty output", () => {
    expect(nulSeparatedGitPaths(root, ["ls-files", "-z"])).toEqual([]);
  });
});

describe("worktreeVisibleLeaves", () => {
  it("lists tracked, untracked and unusual-name files sorted, without ignored files or empty directories", () => {
    write(root, ".gitignore", "*.log\nbuild/\n");
    write(root, "src/tracked.ts", "tracked");
    write(root, "src/forced.log", "tracked although ignored");
    git(root, ["add", ".gitignore", "src/tracked.ts"]);
    git(root, ["add", "-f", "src/forced.log"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    write(root, "src/untracked file.ts", "untracked");
    write(root, "src/new\nline.ts", "newline");
    write(root, "src/ignored.log", "ignored");
    write(root, "src/build/out.js", "ignored directory");
    mkdirSync(join(root, "src/empty"), { recursive: true });

    expect(worktreeVisibleLeaves(root, "src")).toEqual([
      { kind: "file", path: "src/forced.log", absolute: join(root, "src/forced.log") },
      { kind: "file", path: "src/new\nline.ts", absolute: join(root, "src/new\nline.ts") },
      { kind: "file", path: "src/tracked.ts", absolute: join(root, "src/tracked.ts") },
      { kind: "file", path: "src/untracked file.ts", absolute: join(root, "src/untracked file.ts") },
    ]);
  });

  it("lists a lone file path as itself and a missing path as nothing", () => {
    write(root, "one.txt", "1");
    write(root, "two.txt", "2");
    expect(worktreeVisibleLeaves(root, "one.txt")).toEqual([{ kind: "file", path: "one.txt", absolute: join(root, "one.txt") }]);
    expect(worktreeVisibleLeaves(root, "missing")).toEqual([]);
    expect(worktreeVisibleLeaves(root, "missing/deeper.txt")).toEqual([]);
  });

  it("treats the path literally, never as a glob", () => {
    write(root, "a.txt", "a");
    write(root, "*.txt", "star");
    expect(worktreeVisibleLeaves(root, "*.txt")).toEqual([{ kind: "file", path: "*.txt", absolute: join(root, "*.txt") }]);
  });

  it("types symlinks by lstat, including dangling and directory links, without following them", () => {
    write(root, "dir/target.txt", "target");
    symlinkSync("target.txt", join(root, "dir/link"));
    symlinkSync("nowhere", join(root, "dir/dangling"));
    mkdirSync(join(root, "elsewhere"));
    write(root, "elsewhere/hidden.txt", "behind a directory link");
    symlinkSync("../elsewhere", join(root, "dir/dirlink"));
    expect(worktreeVisibleLeaves(root, "dir")).toEqual([
      { kind: "symlink", path: "dir/dangling", absolute: join(root, "dir/dangling") },
      { kind: "symlink", path: "dir/dirlink", absolute: join(root, "dir/dirlink") },
      { kind: "symlink", path: "dir/link", absolute: join(root, "dir/link") },
      { kind: "file", path: "dir/target.txt", absolute: join(root, "dir/target.txt") },
    ]);
  });

  it("reports a deleted index entry as absent", () => {
    write(root, "src/gone.ts", "gone");
    write(root, "src/kept.ts", "kept");
    commitAll("base");
    rmSync(join(root, "src/gone.ts"));
    expect(worktreeVisibleLeaves(root, "src")).toEqual([
      { kind: "absent", path: "src/gone.ts" },
      { kind: "file", path: "src/kept.ts", absolute: join(root, "src/kept.ts") },
    ]);
  });

  it("reports an index entry behind a parent that became a file or a symlink as shadowed", () => {
    write(root, "was-dir/inner.ts", "inner");
    write(root, "linked/inner.ts", "inner");
    write(root, "real/inner.ts", "real");
    commitAll("base");
    rmSync(join(root, "was-dir"), { recursive: true });
    writeFileSync(join(root, "was-dir"), "now a file");
    rmSync(join(root, "linked"), { recursive: true });
    symlinkSync("real", join(root, "linked"));
    expect(worktreeVisibleLeaves(root, "was-dir")).toEqual([
      { kind: "file", path: "was-dir", absolute: join(root, "was-dir") },
      { kind: "shadowed", path: "was-dir/inner.ts" },
    ]);
    expect(worktreeVisibleLeaves(root, "linked")).toEqual([
      { kind: "symlink", path: "linked", absolute: join(root, "linked") },
      { kind: "shadowed", path: "linked/inner.ts" },
    ]);
  });

  it("reports a tracked file replaced by a directory, and an untracked embedded repository, as unsupported", () => {
    write(root, "became-dir", "file");
    commitAll("base");
    rmSync(join(root, "became-dir"));
    write(root, "became-dir/child.ts", "child");
    const nested = join(root, "nested");
    mkdirSync(nested);
    initRepository(nested);
    write(nested, "inside.ts", "inside");
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "--quiet", "-m", "nested"]);

    expect(worktreeVisibleLeaves(root, "became-dir")).toEqual([
      { kind: "unsupported", path: "became-dir" },
      { kind: "file", path: "became-dir/child.ts", absolute: join(root, "became-dir/child.ts") },
    ]);
    expect(worktreeVisibleLeaves(root, "nested")).toEqual([{ kind: "unsupported", path: "nested" }]);
  });

  it("returns frozen leaves", () => {
    write(root, "a.txt", "a");
    const leaves = worktreeVisibleLeaves(root, "a.txt");
    expect(Object.isFrozen(leaves)).toBe(true);
    expect(Object.isFrozen(leaves[0])).toBe(true);
  });

  it("throws when the root is not a repository", () => {
    const outside = canonicalTempDir("loom-git-leaves-outside-");
    try {
      expect(() => worktreeVisibleLeaves(outside, ".")).toThrow(/Command failed: git/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("worktreeLeafBytes", () => {
  it("reads a file's content and a symlink's target text, never following the link", () => {
    write(root, "dir/target.bin", "");
    writeFileSync(join(root, "dir/target.bin"), Buffer.from([0, 1, 2, 255]));
    symlinkSync("target.bin", join(root, "dir/link"));
    symlinkSync("does/not exist", join(root, "dir/dangling"));
    const leaves = worktreeVisibleLeaves(root, "dir").map(present);
    expect(leaves.map((leaf) => [leaf.path, worktreeLeafBytes(leaf)])).toEqual([
      ["dir/dangling", Buffer.from("does/not exist")],
      ["dir/link", Buffer.from("target.bin")],
      ["dir/target.bin", Buffer.from([0, 1, 2, 255])],
    ]);
  });
});

describe("revisionTreeLeaves / presentAtRevision", () => {
  it("lists a lone file as itself and a directory as every leaf below it, with mode and blob sha", () => {
    write(root, "src/a.ts", "a");
    write(root, "src/deep/b.ts", "b");
    write(root, "src/run.sh", "#!/bin/sh\n");
    chmodSync(join(root, "src/run.sh"), 0o755);
    symlinkSync("a.ts", join(root, "src/link"));
    write(root, "src/new\nline.ts", "newline");
    write(root, "other.ts", "other");
    const head = commitAll("base");

    expect(revisionTreeLeaves(root, head, "src/a.ts")).toEqual([
      { mode: "100644", sha: blobSha(head, "src/a.ts"), path: "src/a.ts" },
    ]);
    expect(revisionTreeLeaves(root, "HEAD", "src")).toEqual([
      { mode: "100644", sha: blobSha(head, "src/a.ts"), path: "src/a.ts" },
      { mode: "100644", sha: blobSha(head, "src/deep/b.ts"), path: "src/deep/b.ts" },
      { mode: "120000", sha: blobSha(head, "src/link"), path: "src/link" },
      { mode: "100644", sha: blobSha(head, "src/new\nline.ts"), path: "src/new\nline.ts" },
      { mode: "100755", sha: blobSha(head, "src/run.sh"), path: "src/run.sh" },
    ]);
    expect(Object.isFrozen(revisionTreeLeaves(root, head, "src/a.ts")[0])).toBe(true);
  });

  it("reads the revision, not the worktree", () => {
    write(root, "kept.ts", "v1");
    const first = commitAll("first");
    write(root, "kept.ts", "v2");
    write(root, "added.ts", "added");
    const second = commitAll("second");
    expect(revisionTreeLeaves(root, first, "kept.ts")).toEqual([{ mode: "100644", sha: blobSha(first, "kept.ts"), path: "kept.ts" }]);
    expect(blobSha(first, "kept.ts")).not.toBe(blobSha(second, "kept.ts"));
    expect(revisionTreeLeaves(root, first, "added.ts")).toEqual([]);
    expect(presentAtRevision(root, first, ["kept.ts", "added.ts"])).toEqual(new Set(["kept.ts"]));
    expect(presentAtRevision(root, second, ["kept.ts", "added.ts"])).toEqual(new Set(["kept.ts", "added.ts"]));
  });

  it("reports present files and directories and omits missing paths", () => {
    write(root, "src/a.ts", "a");
    write(root, "docs/readme.md", "docs");
    const head = commitAll("base");
    mkdirSync(join(root, "worktree-only-dir"));
    write(root, "worktree-only.ts", "uncommitted");
    expect(presentAtRevision(root, head, ["src", "src/a.ts", "docs/readme.md", "missing.ts", "worktree-only.ts", "worktree-only-dir"]))
      .toEqual(new Set(["src", "src/a.ts", "docs/readme.md"]));
    expect(presentAtRevision(root, head, [])).toEqual(new Set());
  });

  it("throws for an unknown revision", () => {
    write(root, "a.ts", "a");
    commitAll("base");
    expect(() => revisionTreeLeaves(root, "no-such-revision", "a.ts")).toThrow(/Command failed: git ls-tree/);
    expect(() => presentAtRevision(root, "no-such-revision", ["a.ts"])).toThrow(/Command failed: git ls-tree/);
  });
});
