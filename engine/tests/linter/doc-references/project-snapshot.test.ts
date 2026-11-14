/**
 * The filesystem adapter behind ProjectSnapshot. The fake in fake-snapshot.ts
 * stands in for it everywhere else, so what only a real filesystem and a real
 * git can do is pinned here: outside git, a path that runs THROUGH a file
 * names nothing; inside git, the snapshot is the tree as every clone has it;
 * and a broken repository fails closed instead of falling back to the disk.
 * Under Bun a stat through a file throws ENOTDIR; lint-project-cli.test.ts
 * replays that case through the Bun-run script.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsProjectSnapshot } from "../../../src/linter/doc-references/project-snapshot";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

/** A project in no git repository: one file at the root and one in a directory. */
function project(): string {
  const root = canonicalTempDir("loom-doc-snapshot-");
  roots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# Readme\n");
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  return root;
}

describe("fsProjectSnapshot outside git: the filesystem", () => {
  it("answers a file, a directory and an absent path", () => {
    const snapshot = fsProjectSnapshot(project());
    expect(snapshot.entryAt("README.md")).toBe("file");
    expect(snapshot.entryAt("docs")).toBe("directory");
    expect(snapshot.entryAt("docs/missing.md")).toBeNull();
  });

  it.each(["README.md/child", "docs/guide.md/x/y"])(
    "answers nothing, and does not throw, for a path through a file: %s",
    (path) => {
      const snapshot = fsProjectSnapshot(project());
      expect(snapshot.entryAt(path)).toBeNull();
      expect(snapshot.read(path)).toBeNull();
    },
  );

  it("reads a file's text, and nothing for a directory or an absent path", () => {
    const snapshot = fsProjectSnapshot(project());
    expect(snapshot.read("docs/guide.md")).toBe("# Guide\n");
    expect(snapshot.read("docs")).toBeNull();
    expect(snapshot.read("missing.md")).toBeNull();
  });

  it("lists the project's files, project-relative and forward-slashed", () => {
    const files = fsProjectSnapshot(project()).files();
    expect(files).toContain("README.md");
    expect(files).toContain("docs/guide.md");
  });
});

describe("fsProjectSnapshot in a git repository: the tree as every clone has it", () => {
  const git = (root: string, ...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  };

  /**
   * A repository with a tracked file, an ignored runtime directory holding a
   * file, an untracked file not yet added, a tracked file deleted from the
   * working tree, and a tracked plan beneath a directory the walk never enters.
   */
  function repository(): string {
    const root = canonicalTempDir("loom-doc-snapshot-git-");
    roots.push(root);
    git(root, "init", "-q");
    const write = (path: string, text: string): void => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(".gitignore", "state/\n");
    write("src/tracked.ts", "export const trackedName = 1;\n");
    write("src/deleted.ts", "export const deletedName = 1;\n");
    write(".claude/plans/plan.md", "# Plan\n");
    git(root, "add", "-A");
    write("state/run.ts", "export const runtimeOnlyName = 1;\n");
    write("src/new.ts", "export const notYetAdded = 1;\n");
    rmSync(join(root, "src/deleted.ts"));
    return root;
  }

  it("answers a tracked or not-yet-added file and its directories, never an ignored or deleted one", () => {
    const snapshot = fsProjectSnapshot(repository());
    expect(snapshot.entryAt("src/tracked.ts")).toBe("file");
    expect(snapshot.entryAt("src/new.ts")).toBe("file");
    expect(snapshot.entryAt("src")).toBe("directory");
    expect(snapshot.entryAt(".claude/plans/plan.md")).toBe("file");
    expect(snapshot.entryAt(".claude/plans")).toBe("directory");
    expect(snapshot.entryAt("state/run.ts")).toBeNull();
    expect(snapshot.entryAt("state")).toBeNull();
    expect(snapshot.entryAt("src/deleted.ts")).toBeNull();
    expect(snapshot.entryAt("src/tracked.ts/x")).toBeNull();
    expect(snapshot.entryAt(".git/index")).toBeNull();
  });

  it("lists git's files outside the directories that never hold source, so an ignored file never feeds the corpus", () => {
    const files = fsProjectSnapshot(repository()).files();
    expect([...files].sort()).toEqual([".gitignore", "src/new.ts", "src/tracked.ts"]);
  });

  it("fails closed on a broken repository instead of reading the disk: a worktree whose .git points nowhere", () => {
    const root = project();
    writeFileSync(join(root, ".git"), "gitdir: /nowhere/.git/worktrees/x\n");
    expect(() => fsProjectSnapshot(root).files()).toThrow(/git ls-files failed in .*gitfile does not point to a valid repository/);
  });
});
