import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitOutput,
  nulSeparatedGitPaths,
  presentAtRevision,
  reviewedDirectoryLeafPaths,
  revisionTreeLeaves,
  worktreeLeafBytes,
  worktreeVisibleLeafPaths,
  worktreeVisibleLeaves,
  type WorktreeLeaf,
} from "../../src/utils/git-leaves";
import { untrackedLeavesAt, visibleLeavesAt } from "../../src/utils/git";
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

/**
 * One enumerator, every caller. The Result adapters in utils/git.ts used to
 * run their own `ls-files` with no `--literal-pathspecs` and a shadow Git
 * directory, so a glob-named path was a pattern and `info/exclude` was
 * ignored for the Review Packet and Wave lint while the snapshot hasher and
 * reviewed-workspace reader treated both the repository's way.
 */
describe("worktreeVisibleLeafPaths and its Result adapters", () => {
  const unusualRepository = () => {
    write(root, "lib/a.txt", "a");
    write(root, "lib/*.txt", "star");
    write(root, "lib/[ab].txt", "bracket");
    write(root, "lib/excluded.tmp", "excluded by info/exclude only");
    write(root, "lib/tracked.txt", "tracked");
    git(root, ["add", "lib/tracked.txt"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    writeFileSync(join(root, ".git", "info", "exclude"), "*.tmp\n");
  };

  it("lists the same leaves as the typed enumerator, and only untracked ones on request", () => {
    unusualRepository();
    expect(worktreeVisibleLeafPaths(root, "lib")).toEqual(worktreeVisibleLeaves(root, "lib").map(({ path }) => path));
    expect(worktreeVisibleLeafPaths(root, "lib")).toEqual(["lib/*.txt", "lib/[ab].txt", "lib/a.txt", "lib/tracked.txt"]);
    expect(worktreeVisibleLeafPaths(root, "lib", "untracked")).toEqual(["lib/*.txt", "lib/[ab].txt", "lib/a.txt"]);
    expect(Object.isFrozen(worktreeVisibleLeafPaths(root, "lib"))).toBe(true);
  });

  it("gives every Result-adapter caller the enumerator's literal-pathspec and ignore semantics", () => {
    unusualRepository();
    for (const path of ["lib", "lib/*.txt", "lib/[ab].txt"]) {
      expect(visibleLeavesAt(root, path), path).toEqual({ ok: true, paths: worktreeVisibleLeafPaths(root, path) });
      expect(untrackedLeavesAt(root, path), path)
        .toEqual({ ok: true, paths: worktreeVisibleLeafPaths(root, path, "untracked") });
    }
    // A glob-named path is that one file, never the pattern it spells.
    expect(visibleLeavesAt(root, "lib/*.txt")).toEqual({ ok: true, paths: ["lib/*.txt"] });
    expect(visibleLeavesAt(root, "lib/[ab].txt")).toEqual({ ok: true, paths: ["lib/[ab].txt"] });
  });

  it("reports an enumeration failure as a value in the Result adapters", () => {
    const outside = canonicalTempDir("loom-git-leaves-adapter-outside-");
    try {
      const listed = visibleLeavesAt(outside, ".");
      expect(listed.ok).toBe(false);
      if (!listed.ok) expect(listed.error).toMatch(/^cannot list Git-visible files below "\.": /);
      const untracked = untrackedLeavesAt(outside, ".");
      expect(untracked.ok).toBe(false);
      if (!untracked.ok) expect(untracked.error).toMatch(/^cannot list untracked files below "\.": /);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the shared Git execution policy", () => {
  const AMBIENT_KEYS = [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1",
  ] as const;

  function withAmbientGit<T>(environment: Readonly<Partial<Record<(typeof AMBIENT_KEYS)[number], string>>>, run: () => T): T {
    const previous = new Map(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
    for (const key of AMBIENT_KEYS) {
      const value = environment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return run();
    } finally {
      for (const key of AMBIENT_KEYS) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("never lets ambient GIT_* variables redirect, re-ignore or re-pattern the one leaf enumerator", () => {
    write(root, "lib/tracked.txt", "tracked");
    const head = commitAll("base");
    write(root, "lib/untracked.txt", "untracked");
    write(root, "lib/*.txt", "star");
    write(root, "lib/hidden.dat", "would be ignored by injected config");
    const expected = ["lib/*.txt", "lib/hidden.dat", "lib/tracked.txt", "lib/untracked.txt"];

    // A foreign repository the ambient GIT_DIR/GIT_INDEX_FILE would substitute.
    const foreign = canonicalTempDir("loom-git-leaves-foreign-");
    const marker = join(foreign, "FSMONITOR_EXECUTED");
    try {
      initRepository(foreign);
      write(foreign, "lib/foreign.txt", "foreign");
      git(foreign, ["add", "-A"]);
      git(foreign, ["commit", "--quiet", "-m", "foreign"]);
      write(foreign, "ignore-everything", "*.dat\nlib/untracked.txt\n");
      writeFileSync(join(foreign, "fsmonitor.sh"), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(foreign, "fsmonitor.sh"), 0o755);

      const observed = withAmbientGit({
        GIT_DIR: join(foreign, ".git"),
        GIT_WORK_TREE: foreign,
        GIT_INDEX_FILE: join(foreign, ".git", "index"),
        GIT_GLOB_PATHSPECS: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: join(foreign, "ignore-everything"),
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: join(foreign, "fsmonitor.sh"),
      }, () => ({
        visible: worktreeVisibleLeafPaths(root, "lib"),
        untracked: worktreeVisibleLeafPaths(root, "lib", "untracked"),
        literal: worktreeVisibleLeafPaths(root, "lib/*.txt"),
        adapter: visibleLeavesAt(root, "lib"),
        head: gitOutput(root, ["rev-parse", "HEAD"]).toString("utf-8").trim(),
        atRevision: revisionTreeLeaves(root, head, "lib").map(({ path }) => path),
      }));

      expect(observed.visible).toEqual(expected);
      expect(observed.untracked).toEqual(["lib/*.txt", "lib/hidden.dat", "lib/untracked.txt"]);
      expect(observed.literal).toEqual(["lib/*.txt"]);
      expect(observed.adapter).toEqual({ ok: true, paths: expected });
      expect(observed.head).toBe(head);
      expect(observed.atRevision).toEqual(["lib/tracked.txt"]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("still honours the repository's own ignore rules, which a shadow Git directory would drop", () => {
    write(root, "lib/tracked.txt", "tracked");
    commitAll("base");
    write(root, "lib/info-excluded.tmp", "excluded by info/exclude");
    write(root, "lib/config-excluded.log", "excluded by repository core.excludesFile");
    writeFileSync(join(root, ".git", "info", "exclude"), "*.tmp\n");
    writeFileSync(join(root, "repo-excludes"), "*.log\n");
    git(root, ["config", "core.excludesFile", join(root, "repo-excludes")]);
    expect(worktreeVisibleLeafPaths(root, "lib")).toEqual(["lib/tracked.txt"]);
  });
});

describe("reviewedDirectoryLeafPaths", () => {
  it("is the workspace-visible leaf set plus exactly the leaves deleted since the packet base", () => {
    write(root, "feature/kept.ts", "kept");
    write(root, "feature/removed.ts", "removed");
    write(root, "feature/unstaged-delete.ts", "still indexed");
    const base = commitAll("base");
    git(root, ["rm", "--quiet", "feature/removed.ts"]);
    rmSync(join(root, "feature/unstaged-delete.ts"));
    write(root, "feature/added.ts", "added");

    const workspace = worktreeVisibleLeafPaths(root, "feature");
    expect(workspace).toEqual(["feature/added.ts", "feature/kept.ts", "feature/unstaged-delete.ts"]);
    const packet = reviewedDirectoryLeafPaths(root, base, "feature");
    expect(packet).toEqual(["feature/added.ts", "feature/kept.ts", "feature/removed.ts", "feature/unstaged-delete.ts"]);
    expect(packet.filter((path) => !workspace.includes(path))).toEqual(["feature/removed.ts"]);
    expect(Object.isFrozen(packet)).toBe(true);
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
