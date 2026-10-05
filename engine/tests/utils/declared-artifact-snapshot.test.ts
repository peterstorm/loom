import { execFileSync } from "node:child_process";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureDeclaredArtifactBaseline,
  captureDeclaredArtifactBaselineAtRevision,
  changedDeclaredArtifactsSince,
  changedDeclaredArtifactsSinceRevision,
} from "../../src/utils/declared-artifact-snapshot";
import { treeSnapshotDigest } from "../../src/core/artifact-baseline";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(): { root: string; revision: string } {
  const root = canonicalTempDir("loom-artifact-revision-");
  cleanup.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "icon.bin"), Buffer.from([0x00, 0xff, 0x01]));
  writeFileSync(join(root, "unchanged.txt"), "same\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
  return { root, revision };
}


describe("changedDeclaredArtifactsSinceRevision", () => {
  it("recovers binary and newly-created artifact changes from a retained git baseline", () => {
    const { root, revision } = repository();
    writeFileSync(join(root, "assets", "icon.bin"), Buffer.from([0x00, 0xfe, 0x01]));
    writeFileSync(join(root, "created.txt"), "new\n");

    expect(changedDeclaredArtifactsSinceRevision(root, revision, [
      "assets/icon.bin", "unchanged.txt", "created.txt",
    ])).toEqual(["assets/icon.bin", "created.txt"]);
  });

  it("fails closed when a historical path exists but its blob is unreadable", () => {
    const { root, revision } = repository();
    const blob = execFileSync("git", ["rev-parse", `${revision}:unchanged.txt`], {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    const blobPath = join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    rmSync(blobPath);

    expect(() => changedDeclaredArtifactsSinceRevision(root, revision, ["unchanged.txt"]))
      .toThrow(/Cannot read declared artifact unchanged\.txt/);
  });

  it("rejects a revision that is not a trusted commit", () => {
    const { root } = repository();
    expect(() => changedDeclaredArtifactsSinceRevision(root, "0".repeat(40), ["unchanged.txt"]))
      .toThrow();
  });
});

const hasMkfifo = (() => {
  try {
    execFileSync("which", ["mkfifo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A committed directory artifact with a nested file, used by every directory case. */
function directoryRepository(): { root: string; revision: string } {
  const { root } = repository();
  mkdirSync(join(root, "calibration", "run", "nested"), { recursive: true });
  writeFileSync(join(root, "calibration", "run", "a.json"), "{\"a\":1}\n");
  writeFileSync(join(root, "calibration", "run", "nested", "b.json"), "{\"b\":1}\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "directory artifact"], { cwd: root });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
  return { root, revision };
}

describe("directory artifacts", () => {
  it("baselines an existing directory deterministically instead of throwing EISDIR", () => {
    const { root } = directoryRepository();
    const first = captureDeclaredArtifactBaseline(root, ["calibration/run"]);
    expect(first[0]?.snapshot).toEqual({ kind: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(captureDeclaredArtifactBaseline(root, ["calibration/run"])).toEqual(first);
  });

  it("reports a directory created after a revision where it was missing", () => {
    const { root, revision } = repository();
    mkdirSync(join(root, "calibration", "run"), { recursive: true });
    writeFileSync(join(root, "calibration", "run", "a.json"), "{}\n");
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"]))
      .toEqual(["calibration/run"]);
  });

  it("agrees across worktree and revision for an unchanged directory", () => {
    const { root, revision } = directoryRepository();
    expect(captureDeclaredArtifactBaselineAtRevision(root, revision, ["calibration/run"]))
      .toEqual(captureDeclaredArtifactBaseline(root, ["calibration/run"]));
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual([]);
  });

  it.each([
    ["edits a file", (root: string) => writeFileSync(join(root, "calibration", "run", "a.json"), "{\"a\":2}\n")],
    ["adds a file", (root: string) => writeFileSync(join(root, "calibration", "run", "c.json"), "{}\n")],
    ["deletes a file", (root: string) => rmSync(join(root, "calibration", "run", "nested", "b.json"))],
    ["renames a file", (root: string) => renameSync(
      join(root, "calibration", "run", "a.json"),
      join(root, "calibration", "run", "renamed.json"),
    )],
  ])("reports the directory changed when the implementer %s inside it", (_name, mutate) => {
    const { root, revision } = directoryRepository();
    const baseline = captureDeclaredArtifactBaseline(root, ["calibration/run"]);
    mutate(root);
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual(["calibration/run"]);
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual(["calibration/run"]);
  });

  it("hashes a symlink inside the directory by target text without following it", () => {
    const { root, revision } = directoryRepository();
    symlinkSync("a.json", join(root, "calibration", "run", "latest"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "symlink"], { cwd: root });
    const linkedRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    expect(changedDeclaredArtifactsSinceRevision(root, linkedRevision, ["calibration/run"])).toEqual([]);
    const baseline = captureDeclaredArtifactBaseline(root, ["calibration/run"]);

    // The link entry is its target text, so retargeting must register.
    rmSync(join(root, "calibration", "run", "latest"));
    symlinkSync("nested/b.json", join(root, "calibration", "run", "latest"));
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual(["calibration/run"]);
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual(["calibration/run"]);

    // A dangling link is fine: it is never dereferenced.
    rmSync(join(root, "calibration", "run", "latest"));
    symlinkSync("does-not-exist", join(root, "calibration", "run", "latest"));
    expect(() => captureDeclaredArtifactBaseline(root, ["calibration/run"])).not.toThrow();
  });

  it("does not credit a mode-only change, matching the declared-artifact file contract", () => {
    const { root } = directoryRepository();
    const baseline = captureDeclaredArtifactBaseline(root, ["calibration/run"]);
    chmodSync(join(root, "calibration", "run", "a.json"), 0o755);
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual([]);
  });

  it.skipIf(!hasMkfifo)("leaves a fifo out: Git cannot see it, so no revision could hold it either", () => {
    const { root, revision } = directoryRepository();
    const before = captureDeclaredArtifactBaseline(root, ["calibration/run"]);
    execFileSync("mkfifo", [join(root, "calibration", "run", "pipe")]);
    expect(captureDeclaredArtifactBaseline(root, ["calibration/run"])).toEqual(before);
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual([]);
  });

  it("rejects an embedded repository inside the directory with its path", () => {
    const { root } = directoryRepository();
    mkdirSync(join(root, "calibration", "run", "inner"));
    execFileSync("git", ["init", "--quiet"], { cwd: join(root, "calibration", "run", "inner") });
    writeFileSync(join(root, "calibration", "run", "inner", "f.json"), "{}\n");
    expect(() => captureDeclaredArtifactBaseline(root, ["calibration/run"]))
      .toThrow("declared artifact calibration/run contains a node that is not a file, directory or symlink: calibration/run/inner");
  });

  it("pins the directory digest bytes: Git-visible leaves only, by repository ignore rules", () => {
    const { root } = directoryRepository();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    // Ignored by the repository's own info/exclude, not only by .gitignore files.
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "*.tmp\n");
    writeFileSync(join(root, "calibration", "run", "scratch.tmp"), "ignored\n");
    // A tracked leaf deleted from the worktree has no bytes to hash.
    rmSync(join(root, "calibration", "run", "nested", "b.json"));
    // A literal path: glob characters in the artifact never widen the listing.
    mkdirSync(join(root, "calibration", "run", "x[1]"));
    writeFileSync(join(root, "calibration", "run", "x[1]", "c.json"), "{}\n");
    mkdirSync(join(root, "calibration", "run", "x1"));
    writeFileSync(join(root, "calibration", "run", "x1", "d.json"), "{}\n");
    symlinkSync("a.json", join(root, "calibration", "run", "latest"));

    expect(captureDeclaredArtifactBaseline(root, ["calibration/run"])[0]?.snapshot).toEqual({
      kind: "sha256",
      digest: treeSnapshotDigest([
        { path: "a.json", kind: "file", contentSha256: sha("{\"a\":1}\n") },
        { path: "latest", kind: "symlink", contentSha256: sha("a.json") },
        { path: "x1/d.json", kind: "file", contentSha256: sha("{}\n") },
        { path: "x[1]/c.json", kind: "file", contentSha256: sha("{}\n") },
      ]),
    });
    expect(captureDeclaredArtifactBaseline(root, ["calibration/run/x[1]"])[0]?.snapshot).toEqual({
      kind: "sha256",
      digest: treeSnapshotDigest([{ path: "c.json", kind: "file", contentSha256: sha("{}\n") }]),
    });
  });

  it("ignores Git-ignored leaves so worktree and revision cover the same Git-visible set", () => {
    const { root, revision } = directoryRepository();
    writeFileSync(join(root, ".gitignore"), "*.cache\n");
    writeFileSync(join(root, "calibration", "run", "warm.cache"), "ignored\n");
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual([]);

    const baseline = captureDeclaredArtifactBaseline(root, ["calibration/run"]);
    writeFileSync(join(root, "calibration", "run", "warm.cache"), "rewritten\n");
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual([]);

    // An untracked file Git does not ignore is genuinely new against the revision.
    writeFileSync(join(root, "calibration", "run", "new.json"), "{}\n");
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual(["calibration/run"]);
  });

  it("keeps a tracked file that matches an ignore pattern, as Git does", () => {
    const { root, revision } = directoryRepository();
    writeFileSync(join(root, ".gitignore"), "*.json\n");
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual([]);
    writeFileSync(join(root, "calibration", "run", "a.json"), "{\"a\":2}\n");
    expect(changedDeclaredArtifactsSinceRevision(root, revision, ["calibration/run"])).toEqual(["calibration/run"]);
  });

  it.skipIf(!hasMkfifo)("does not inspect a fifo that Git ignores", () => {
    const { root } = directoryRepository();
    writeFileSync(join(root, ".gitignore"), "pipe\n");
    execFileSync("mkfifo", [join(root, "calibration", "run", "pipe")]);
    expect(() => captureDeclaredArtifactBaseline(root, ["calibration/run"])).not.toThrow();
  });

  it("rejects a submodule inside a historical directory", () => {
    const { root } = directoryRepository();
    execFileSync("git", [
      "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},calibration/run/module`,
    ], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "gitlink"], { cwd: root });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    expect(() => captureDeclaredArtifactBaselineAtRevision(root, revision, ["calibration/run"]))
      .toThrow(/Cannot read declared artifact calibration\/run at .*unsupported tree entry mode 160000/);
  });

  it("keeps a lone file artifact on the exact historical-bytes path", () => {
    const { root, revision } = directoryRepository();
    expect(captureDeclaredArtifactBaselineAtRevision(root, revision, ["calibration/run/a.json"]))
      .toEqual(captureDeclaredArtifactBaseline(root, ["calibration/run/a.json"]));
  });
});
