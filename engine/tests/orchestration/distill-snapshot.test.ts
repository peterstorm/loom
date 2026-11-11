/**
 * The Git adapter of the Distill Snapshot port (ADR-0068 §5) against real
 * temporary repositories: capture stores the scope as one tree under
 * `refs/loom/distill/<digest>` without touching the user's index or
 * worktree, restore brings back exact bytes, modes, links and absence, and
 * discard forgets the snapshot.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { distillSnapshotRef } from "../../src/core/distill-task";
import { gitDistillSnapshots } from "../../src/orchestration/distill-snapshot";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { git, gitResult, write } from "../fixtures/git-repository";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const REF = distillSnapshotRef(DIGEST);

/** A committed repository holding `files`, with `.gitignore` ignoring `ignored/` and `*.log`. */
function repository(files: Readonly<Record<string, string>>): string {
  const root = canonicalTempDir("loom-distill-snapshot-");
  roots.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "loom@example.test"]);
  git(root, ["config", "user.name", "Loom Test"]);
  write(root, ".gitignore", "ignored/\n*.log\n");
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);
  return root;
}

const read = (root: string, path: string): string => readFileSync(join(root, path), "utf-8");
const executable = (root: string, path: string): boolean => (statSync(join(root, path)).mode & 0o100) !== 0;
const stdout = (root: string, args: readonly string[]): string => gitResult(root, args).stdout.trim();
const refExists = (root: string, ref: string): boolean => stdout(root, ["for-each-ref", "--format=%(refname)", ref]) === ref;

const expectOk = (result: ReturnType<typeof gitDistillSnapshots.capture>): void => {
  expect(result).toEqual({ ok: true, value: { ref: REF } });
};

describe("capture then restore", () => {
  it("brings back an edit, a deletion, a file created at a missing scope path, an executable bit and a link", () => {
    const root = repository({ "src/edited.ts": "edited v1\n", "src/deleted.ts": "deleted v1\n", "bin/tool.sh": "#!/bin/sh\n", "src/target.ts": "target\n" });
    chmodSync(join(root, "bin/tool.sh"), 0o755);
    symlinkSync("target.ts", join(root, "src/link.ts"));
    const scope = ["src/edited.ts", "src/deleted.ts", "src/created.ts", "bin/tool.sh", "src/link.ts", "src/plain.ts"];
    write(root, "src/plain.ts", "plain\n");

    expectOk(gitDistillSnapshots.capture(root, DIGEST, scope));

    writeFileSync(join(root, "src/edited.ts"), "edited v2\n");
    rmSync(join(root, "src/deleted.ts"));
    write(root, "src/created.ts", "created by the attempt\n");
    chmodSync(join(root, "bin/tool.sh"), 0o644);
    chmodSync(join(root, "src/plain.ts"), 0o755);
    rmSync(join(root, "src/link.ts"));
    writeFileSync(join(root, "src/link.ts"), "a file where the link was\n");

    expectOk(gitDistillSnapshots.restore(root, DIGEST, scope));

    expect(read(root, "src/edited.ts")).toBe("edited v1\n");
    expect(read(root, "src/deleted.ts")).toBe("deleted v1\n");
    expect(existsSync(join(root, "src/created.ts"))).toBe(false);
    expect(executable(root, "bin/tool.sh")).toBe(true);
    expect(executable(root, "src/plain.ts")).toBe(false);
    expect(lstatSync(join(root, "src/link.ts")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "src/link.ts"))).toBe("target.ts");
    expect(read(root, "src/target.ts")).toBe("target\n");
  });

  it("stores exact bytes: no line-ending or clean-filter conversion, and binary content", () => {
    const root = repository({ ".gitattributes": "*.txt text eol=lf\n" });
    const crlf = Buffer.from("one\r\ntwo\r\n", "utf-8");
    const binary = Buffer.from([0, 255, 10, 13, 0, 128]);
    writeFileSync(join(root, "crlf.txt"), crlf);
    writeFileSync(join(root, "blob.bin"), binary);

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["crlf.txt", "blob.bin"]));
    writeFileSync(join(root, "crlf.txt"), "rewritten\n");
    writeFileSync(join(root, "blob.bin"), "rewritten\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["crlf.txt", "blob.bin"]));

    expect(readFileSync(join(root, "crlf.txt")).equals(crlf)).toBe(true);
    expect(readFileSync(join(root, "blob.bin")).equals(binary)).toBe(true);
  });

  it("snapshots a scope path the ignore rules hide", () => {
    const root = repository({ "src/a.ts": "a\n" });
    write(root, "ignored/generated.ts", "generated v1\n");
    write(root, "debug.log", "log v1\n");
    expect(stdout(root, ["status", "--porcelain"])).toBe("");

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["ignored/generated.ts", "debug.log"]));
    writeFileSync(join(root, "ignored/generated.ts"), "generated v2\n");
    rmSync(join(root, "debug.log"));
    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["ignored/generated.ts", "debug.log"]));

    expect(read(root, "ignored/generated.ts")).toBe("generated v1\n");
    expect(read(root, "debug.log")).toBe("log v1\n");
  });

  it("restores a scope directory leaf by leaf, and removes one the attempt created", () => {
    const root = repository({ "pkg/a.ts": "a v1\n", "pkg/nested/b.ts": "b v1\n", "pkg/nested/gone.ts": "gone v1\n" });
    const scope = ["pkg", "fresh"];

    expectOk(gitDistillSnapshots.capture(root, DIGEST, scope));
    writeFileSync(join(root, "pkg/a.ts"), "a v2\n");
    rmSync(join(root, "pkg/nested/gone.ts"));
    write(root, "pkg/extra/new.ts", "new\n");
    write(root, "fresh/deep/created.ts", "created\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, scope));

    expect(read(root, "pkg/a.ts")).toBe("a v1\n");
    expect(read(root, "pkg/nested/b.ts")).toBe("b v1\n");
    expect(read(root, "pkg/nested/gone.ts")).toBe("gone v1\n");
    expect(existsSync(join(root, "pkg/extra"))).toBe(false);
    expect(existsSync(join(root, "fresh"))).toBe(false);
  });

  it("puts a file back where the attempt left a directory, and a directory's files back where it left a file", () => {
    const root = repository({ "src/file.ts": "file\n", "lib/inner/x.ts": "x\n" });
    const scope = ["src/file.ts", "lib"];

    expectOk(gitDistillSnapshots.capture(root, DIGEST, scope));
    rmSync(join(root, "src/file.ts"));
    write(root, "src/file.ts/child.ts", "child\n");
    rmSync(join(root, "lib/inner"), { recursive: true });
    writeFileSync(join(root, "lib/inner"), "a file where the directory was\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, scope));

    expect(read(root, "src/file.ts")).toBe("file\n");
    expect(read(root, "lib/inner/x.ts")).toBe("x\n");
  });

  it("is idempotent and leaves an unchanged file's mtime alone", () => {
    const root = repository({ "src/kept.ts": "kept\n", "src/edited.ts": "v1\n" });
    const scope = ["src/kept.ts", "src/edited.ts"];
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(join(root, "src/kept.ts"), past, past);

    expectOk(gitDistillSnapshots.capture(root, DIGEST, scope));
    writeFileSync(join(root, "src/edited.ts"), "v2\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, scope));
    expectOk(gitDistillSnapshots.restore(root, DIGEST, scope));

    expect(read(root, "src/edited.ts")).toBe("v1\n");
    expect(statSync(join(root, "src/kept.ts")).mtime.toISOString()).toBe(past.toISOString());
    expect(refExists(root, REF)).toBe(true);
  });
});

describe("what capture leaves alone", () => {
  it("keeps the snapshot as a tree under the attempt's ref, with one entry per present scope path", () => {
    const root = repository({ "src/a.ts": "a\n" });
    chmodSync(join(root, "src/a.ts"), 0o755);

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts", "src/missing.ts"]));

    expect(stdout(root, ["cat-file", "-t", REF])).toBe("tree");
    expect(stdout(root, ["ls-tree", "-r", "--name-only", REF])).toBe("src/a.ts");
    expect(stdout(root, ["ls-tree", "-r", REF])).toMatch(/^100755 blob /);
  });

  it("touches neither the user's index nor any file, staged, unstaged or untracked", () => {
    const root = repository({ "src/a.ts": "a\n", "other.ts": "other\n" });
    writeFileSync(join(root, "other.ts"), "staged change\n");
    git(root, ["add", "other.ts"]);
    writeFileSync(join(root, "other.ts"), "unstaged change on top\n");
    writeFileSync(join(root, "src/a.ts"), "scope file, dirty in the worktree\n");
    write(root, "untracked.ts", "untracked\n");
    const before = {
      status: stdout(root, ["status", "--porcelain"]),
      index: stdout(root, ["write-tree"]),
      head: stdout(root, ["rev-parse", "HEAD"]),
    };

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    writeFileSync(join(root, "src/a.ts"), "the attempt's edit\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["src/a.ts"]));

    expect(stdout(root, ["status", "--porcelain"])).toBe(before.status);
    expect(stdout(root, ["write-tree"])).toBe(before.index);
    expect(stdout(root, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(read(root, "src/a.ts")).toBe("scope file, dirty in the worktree\n");
    expect(read(root, "other.ts")).toBe("unstaged change on top\n");
    expect(read(root, "untracked.ts")).toBe("untracked\n");
  });

  it("restores only the scope it is given", () => {
    const root = repository({ "src/a.ts": "a v1\n", "src/b.ts": "b v1\n" });

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    writeFileSync(join(root, "src/a.ts"), "a v2\n");
    writeFileSync(join(root, "src/b.ts"), "b v2\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["src/a.ts"]));

    expect(read(root, "src/a.ts")).toBe("a v1\n");
    expect(read(root, "src/b.ts")).toBe("b v2\n");
  });
});

describe("discard and leftovers", () => {
  it("deletes the ref, any number of times, and a restore after it is a typed no-snapshot failure", () => {
    const root = repository({ "src/a.ts": "a\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    expect(refExists(root, REF)).toBe(true);

    expectOk(gitDistillSnapshots.discard(root, DIGEST));
    expect(refExists(root, REF)).toBe(false);
    expectOk(gitDistillSnapshots.discard(root, DIGEST));

    writeFileSync(join(root, "src/a.ts"), "edited\n");
    expect(gitDistillSnapshots.restore(root, DIGEST, ["src/a.ts"])).toEqual({ ok: false, error: { kind: "no-snapshot", ref: REF } });
    expect(read(root, "src/a.ts")).toBe("edited\n");
  });

  it("discarding a snapshot that was never captured is no failure", () => {
    const root = repository({ "src/a.ts": "a\n" });
    expectOk(gitDistillSnapshots.discard(root, DIGEST));
  });

  it("replaces a snapshot left under the same ref", () => {
    const root = repository({ "src/a.ts": "first\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    writeFileSync(join(root, "src/a.ts"), "second\n");
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));

    writeFileSync(join(root, "src/a.ts"), "third\n");
    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["src/a.ts"]));
    expect(read(root, "src/a.ts")).toBe("second\n");
  });

  it("keeps each attempt's snapshot under its own ref", () => {
    const root = repository({ "src/a.ts": "first\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    writeFileSync(join(root, "src/a.ts"), "second\n");
    expect(gitDistillSnapshots.capture(root, OTHER_DIGEST, ["src/a.ts"]).ok).toBe(true);

    expectOk(gitDistillSnapshots.discard(root, DIGEST));
    expect(refExists(root, distillSnapshotRef(OTHER_DIGEST))).toBe(true);
    writeFileSync(join(root, "src/a.ts"), "third\n");
    expect(gitDistillSnapshots.restore(root, OTHER_DIGEST, ["src/a.ts"]).ok).toBe(true);
    expect(read(root, "src/a.ts")).toBe("second\n");
  });
});

describe("refusals are values", () => {
  it("fails capture outside a Git repository, storing nothing", () => {
    const root = canonicalTempDir("loom-distill-no-git-");
    roots.push(root);
    write(root, "src/a.ts", "a\n");

    const captured = gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]);

    expect(captured).toMatchObject({ ok: false, error: { kind: "git-failed", command: "hash-object" } });
  });

  it("refuses a scope path that leaves the repository through a link, at capture and at restore", () => {
    const root = repository({ "src/a.ts": "a\n" });
    const outside = canonicalTempDir("loom-distill-outside-");
    roots.push(outside);
    write(outside, "a.ts", "outside\n");

    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["src/a.ts"]));
    rmSync(join(root, "src"), { recursive: true });
    symlinkSync(outside, join(root, "src"), "dir");

    expect(gitDistillSnapshots.restore(root, DIGEST, ["src/a.ts"]))
      .toMatchObject({ ok: false, error: { kind: "scope-path-failed", path: "src/a.ts" } });
    expect(read(outside, "a.ts")).toBe("outside\n");
    expect(gitDistillSnapshots.capture(root, OTHER_DIGEST, ["src/a.ts"]))
      .toMatchObject({ ok: false, error: { kind: "scope-path-failed", path: "src/a.ts" } });
    expect(refExists(root, distillSnapshotRef(OTHER_DIGEST))).toBe(false);
  });

  it("refuses a scope path outside the repository root", () => {
    const root = repository({ "src/a.ts": "a\n" });
    expect(gitDistillSnapshots.capture(root, DIGEST, ["../escape.ts"]))
      .toMatchObject({ ok: false, error: { kind: "scope-path-failed", path: "../escape.ts" } });
    expect(refExists(root, REF)).toBe(false);
  });

  it("fails a restore whose file cannot be written, as that path's failure", () => {
    const root = repository({ "locked/a.ts": "a v1\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["locked/a.ts"]));
    rmSync(join(root, "locked/a.ts"));
    mkdirSync(join(root, "locked/a.ts"));
    writeFileSync(join(root, "locked/a.ts/keep"), "keep\n");
    chmodSync(join(root, "locked"), 0o555);
    try {
      const restored = gitDistillSnapshots.restore(root, DIGEST, ["locked/a.ts"]);
      // Root ignores directory permissions; everyone else gets the typed failure.
      if (process.getuid?.() === 0) expect(restored.ok).toBe(true);
      else expect(restored).toMatchObject({ ok: false, error: { kind: "scope-path-failed", path: "locked/a.ts" } });
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });

  it("fails a restore that cannot remove a directory the attempt created, rather than reporting the scope restored", () => {
    const root = repository({ "pkg/keep.ts": "keep\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["pkg"]));
    write(root, "pkg/made/deep/new.ts", "new\n");
    // `deep` empties, and its parent refuses to let it go.
    chmodSync(join(root, "pkg/made"), 0o555);
    try {
      const restored = gitDistillSnapshots.restore(root, DIGEST, ["pkg"]);
      // Root ignores directory permissions; everyone else gets the typed failure.
      if (process.getuid?.() === 0) {
        expect(restored.ok).toBe(true);
        expect(existsSync(join(root, "pkg/made"))).toBe(false);
      } else {
        expect(restored).toMatchObject({
          ok: false, error: { kind: "scope-path-failed", path: "pkg", detail: expect.stringMatching(/EACCES|EPERM/) },
        });
        expect(existsSync(join(root, "pkg/made/deep"))).toBe(true);
      }
    } finally {
      chmodSync(join(root, "pkg/made"), 0o755);
    }
  });

  it("stops at a directory that still holds something, which is no failure", () => {
    const root = repository({ "pkg/keep.ts": "keep\n", "pkg/made/kept.ts": "kept\n" });
    expectOk(gitDistillSnapshots.capture(root, DIGEST, ["pkg"]));
    write(root, "pkg/made/deep/new.ts", "new\n");

    expectOk(gitDistillSnapshots.restore(root, DIGEST, ["pkg"]));

    expect(existsSync(join(root, "pkg/made/deep"))).toBe(false);
    expect(read(root, "pkg/made/kept.ts")).toBe("kept\n");
  });
});
