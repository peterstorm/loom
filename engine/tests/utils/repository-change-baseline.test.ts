import { artifactBaselineRepository, type ArtifactBaselineRepository } from "../fixtures/artifact-baseline-repository";
import {
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRepositoryChangeBaseline,
  changedRepositoryArtifactsSince,
} from "../../src/utils/repository-change-baseline";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository(): ArtifactBaselineRepository {
  const repo = artifactBaselineRepository();
  cleanup.push(repo.root);
  return repo;
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
