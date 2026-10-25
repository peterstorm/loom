/**
 * The owner-mutation workspace (AD-8; FR-015, FR-016, AS-016, AS-017) over a
 * real Git fixture repository: a detached worktree outside the repository,
 * overlaid with every path the reviewed workspace changed, deleted or added,
 * sharing `node_modules` by symlink, and removed in `finally` whatever the
 * run did. The real workspace's bytes never change.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withMutationWorkspace, type MutationWorkspaceSpec } from "../../src/orchestration/owner-mutation-workspace";
import {
  buildOwnerVerificationRepo as build,
  canonicalRoot,
  cleanupOwnerVerificationRepos,
  OWNER_FIXTURE,
  type OwnerVerificationRepo,
} from "../fixtures/owner-verification-repo";

afterEach(cleanupOwnerVerificationRepos);

const TIMEOUT_MS = 30_000;

function specOf(repo: OwnerVerificationRepo): MutationWorkspaceSpec {
  return {
    repositoryRoot: canonicalRoot(repo.root),
    ownerPath: OWNER_FIXTURE.owner,
    reportPath: OWNER_FIXTURE.report,
    runnerCwd: ".",
  };
}

const read = (root: string, path: string): string => readFileSync(join(root, ...path.split("/")), "utf8");

describe("withMutationWorkspace", () => {
  it("AS-016: opens a detached worktree outside the repository carrying the uncommitted Wave bytes, and removes it afterwards", async () => {
    const repo = build();
    writeFileSync(join(repo.root, "notes.txt"), "untracked and not ignored\n");
    const before = repo.workspaceBytes();
    const seen = await withMutationWorkspace(specOf(repo), async (workspace) => {
      expect(workspace.root.startsWith(`${repo.root}/`)).toBe(false);
      expect(workspace.root).not.toBe(repo.root);
      expect(read(workspace.root, OWNER_FIXTURE.owner)).toBe(read(repo.root, OWNER_FIXTURE.owner));
      expect(read(workspace.root, "notes.txt")).toBe("untracked and not ignored\n");
      expect(execFileSync("git", ["-C", workspace.root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()).toBe("HEAD");
      expect(repo.worktrees()).toContain(workspace.root);
      return workspace.root;
    });
    expect(seen.ok).toBe(true);
    if (!seen.ok) return;
    expect(existsSync(seen.value)).toBe(false);
    expect(repo.worktrees()).toEqual([repo.root]);
    expect(repo.workspaceBytes()).toEqual(before);
  }, TIMEOUT_MS);

  it("AS-016: a path the reviewed workspace deleted is deleted in the worktree too", async () => {
    const repo = build();
    rmSync(join(repo.root, OWNER_FIXTURE.unrelated));
    const result = await withMutationWorkspace(specOf(repo), async (workspace) =>
      existsSync(join(workspace.root, OWNER_FIXTURE.unrelated)));
    expect(result).toEqual({ ok: true, value: false });
  }, TIMEOUT_MS);

  it("shares the repository root's and the runner cwd's node_modules by symlink, never by copy", async () => {
    const repo = build();
    appendFileSync(join(repo.root, ".git", "info", "exclude"), "node_modules/\n");
    mkdirSync(join(repo.root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo.root, "node_modules", "pkg", "index.js"), "export {};\n");
    mkdirSync(join(repo.root, "tests", "node_modules"), { recursive: true });
    const result = await withMutationWorkspace({ ...specOf(repo), runnerCwd: "tests" }, async (workspace) => {
      const rootLink = join(workspace.root, "node_modules");
      const cwdLink = join(workspace.root, "tests", "node_modules");
      return {
        rootIsLink: lstatSync(rootLink).isSymbolicLink(),
        rootTarget: readlinkSync(rootLink),
        cwdIsLink: lstatSync(cwdLink).isSymbolicLink(),
        cwdTarget: readlinkSync(cwdLink),
      };
    });
    expect(result).toEqual({
      ok: true,
      value: {
        rootIsLink: true,
        rootTarget: join(repo.root, "node_modules"),
        cwdIsLink: true,
        cwdTarget: join(repo.root, "tests", "node_modules"),
      },
    });
    expect(existsSync(join(repo.root, "node_modules", "pkg", "index.js"))).toBe(true);
  }, TIMEOUT_MS);

  it("AS-016: a run rewrites only the owner, deletes the stale report first, and restores the original owner bytes after", async () => {
    const repo = build();
    const original = read(repo.root, OWNER_FIXTURE.owner);
    const result = await withMutationWorkspace(specOf(repo), async (workspace) => {
      const report = join(workspace.root, ...OWNER_FIXTURE.report.split("/"));
      mkdirSync(join(report, ".."), { recursive: true });
      writeFileSync(report, "stale report from an earlier run");
      const during = await workspace.runWithOwner("export const mutated = true;\n", async (root) => ({
        owner: read(root, OWNER_FIXTURE.owner),
        reportPresent: existsSync(join(root, ...OWNER_FIXTURE.report.split("/"))),
        sibling: read(root, OWNER_FIXTURE.siblings[0]),
      }));
      const baseline = await workspace.runWithOwner(null, async (root) => read(root, OWNER_FIXTURE.owner));
      return { during, baseline, after: read(workspace.root, OWNER_FIXTURE.owner) };
    });
    expect(result).toEqual({
      ok: true,
      value: {
        during: { owner: "export const mutated = true;\n", reportPresent: false, sibling: read(repo.root, OWNER_FIXTURE.siblings[0]) },
        baseline: original,
        after: original,
      },
    });
    expect(read(repo.root, OWNER_FIXTURE.owner)).toBe(original);
  }, TIMEOUT_MS);

  it("restores the owner even when the run throws", async () => {
    const repo = build();
    const original = read(repo.root, OWNER_FIXTURE.owner);
    const result = await withMutationWorkspace(specOf(repo), async (workspace) => {
      await expect(workspace.runWithOwner("broken();\n", async () => { throw new Error("run exploded"); })).rejects.toThrow("run exploded");
      return read(workspace.root, OWNER_FIXTURE.owner);
    });
    expect(result).toEqual({ ok: true, value: original });
  }, TIMEOUT_MS);

  it("a run that throws over an owner that cannot be restored rethrows naming both, with the run's throw as the cause", async () => {
    const repo = build();
    const exploded = new Error("run exploded");
    const result = await withMutationWorkspace(specOf(repo), async (workspace) => {
      const thrown = await workspace.runWithOwner("broken();\n", async (root) => {
        const owner = join(root, ...OWNER_FIXTURE.owner.split("/"));
        rmSync(owner);
        mkdirSync(owner);
        throw exploded;
      }).then(() => null, (error: unknown) => error);
      return thrown;
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeInstanceOf(Error);
    const error = result.value as Error;
    expect(error).not.toBe(exploded);
    expect(error.message).toContain("run exploded");
    expect(error.message).toMatch(/could not be restored/);
    expect(error.cause).toBe(exploded);
    expect(repo.worktrees()).toEqual([repo.root]);
  }, TIMEOUT_MS);

  it("removes the worktree even when the use of it throws, and rethrows", async () => {
    const repo = build();
    const before = repo.workspaceBytes();
    let opened = "";
    await expect(withMutationWorkspace(specOf(repo), async (workspace) => {
      opened = workspace.root;
      throw new Error("use exploded");
    })).rejects.toThrow("use exploded");
    expect(opened).not.toBe("");
    expect(existsSync(opened)).toBe(false);
    expect(repo.worktrees()).toEqual([repo.root]);
    expect(repo.workspaceBytes()).toEqual(before);
  }, TIMEOUT_MS);

  it("a use that throws over a worktree that cannot be removed rethrows with the cleanup failure attached", async () => {
    const repo = build();
    let opened = "";
    const exploded = new Error("use exploded");
    const thrown = await withMutationWorkspace(specOf(repo), async (workspace) => {
      opened = workspace.root;
      const stuck = join(workspace.root, "stuck");
      mkdirSync(stuck);
      writeFileSync(join(stuck, "pinned.txt"), "cannot be unlinked from a read-only directory\n");
      chmodSync(stuck, 0o500);
      throw exploded;
    }).then(() => null, (error: unknown) => error);
    try {
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain("use exploded");
      expect(error.message).toMatch(/could not be removed/);
      expect(error.cause).toBe(exploded);
      expect(existsSync(opened)).toBe(true);
    } finally {
      chmodSync(join(opened, "stuck"), 0o700);
      rmSync(opened, { recursive: true, force: true });
      execFileSync("git", ["-C", repo.root, "worktree", "prune"]);
    }
    expect(repo.worktrees()).toEqual([repo.root]);
  }, TIMEOUT_MS);

  it("AS-017: an isolated copy that cannot be made is the named worktree-failed infrastructure failure, and nothing runs", async () => {
    const repo = build({ worktree: "blocked" });
    let used = false;
    const result = await withMutationWorkspace(specOf(repo), async () => { used = true; });
    expect(used).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("worktree-failed");
    expect(result.error.detail.length).toBeGreaterThan(0);
  }, TIMEOUT_MS);
});
