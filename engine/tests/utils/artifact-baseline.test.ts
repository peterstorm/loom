import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedDeclaredArtifactsSinceRevision } from "../../src/utils/artifact-baseline";

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
