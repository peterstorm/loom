import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRepositoryChangeBaseline,
  changedDeclaredArtifactsSinceRevision,
  changedRepositoryArtifactsSince,
} from "../../src/utils/artifact-baseline";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(): { root: string; revision: string } {
  const root = mkdtempSync(join(tmpdir(), "loom-artifact-revision-"));
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

describe("repository attempt change boundaries", () => {
  it("detects tracked edits and new untracked paths from a clean boundary", () => {
    const { root } = repository();
    const baseline = captureRepositoryChangeBaseline(root);
    expect(baseline).toEqual([]);

    writeFileSync(join(root, "unchanged.txt"), "changed\n");
    writeFileSync(join(root, "new file.txt"), "new\n");

    expect(changedRepositoryArtifactsSince(root, baseline)).toEqual([
      "new file.txt",
      "unchanged.txt",
    ]);
  });

  it("detects byte changes, deletion, and reversion of paths already dirty at spawn", () => {
    const { root } = repository();
    writeFileSync(join(root, "unchanged.txt"), "dirty before spawn\n");
    writeFileSync(join(root, "preexisting.txt"), "dirty before spawn\n");
    const baseline = captureRepositoryChangeBaseline(root);

    writeFileSync(join(root, "unchanged.txt"), "changed during attempt\n");
    rmSync(join(root, "preexisting.txt"));
    expect(changedRepositoryArtifactsSince(root, baseline)).toEqual([
      "preexisting.txt",
      "unchanged.txt",
    ]);

    writeFileSync(join(root, "unchanged.txt"), "same\n");
    expect(changedRepositoryArtifactsSince(root, baseline)).toEqual([
      "preexisting.txt",
      "unchanged.txt",
    ]);
  });

  it("detects a mode-only change to a path already dirty at spawn", () => {
    const { root } = repository();
    writeFileSync(join(root, "unchanged.txt"), "dirty before spawn\n");
    const baseline = captureRepositoryChangeBaseline(root);

    chmodSync(join(root, "unchanged.txt"), 0o755);

    expect(changedRepositoryArtifactsSince(root, baseline)).toEqual(["unchanged.txt"]);
  });

  it("snapshots a changed leaf symlink without following it", () => {
    const { root } = repository();
    symlinkSync("unchanged.txt", join(root, "linked.txt"));
    const baseline = captureRepositoryChangeBaseline(root);

    rmSync(join(root, "linked.txt"));
    symlinkSync("assets/icon.bin", join(root, "linked.txt"));

    expect(changedRepositoryArtifactsSince(root, baseline)).toEqual(["linked.txt"]);
  });

  it("rejects a missing repository boundary instead of preserving stale evidence", () => {
    const { root } = repository();
    expect(() => changedRepositoryArtifactsSince(root, undefined))
      .toThrow(/No implementation-attempt repository baseline/);
  });
});

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
