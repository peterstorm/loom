import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelGuardTargets } from "../../../pi/extension";

/**
 * Executable pins for the Pi panel guard's write-target projection
 * (`panelGuardTargets`) — the pi twin of the Claude handler's
 * `panelWriteTargetPaths` wiring proofs in block-direct-edits.test.ts. The
 * guard's admission is only as sound as the projection feeding it: a target
 * the shell cannot prove in-scope must ARRIVE out-of-scope (`../`, the shape
 * the role admission blocks), and an unobservable repository root must arrive
 * as NO targets — fail closed — never as a silently-projected path that reads
 * like an admission.
 *
 * `gitRepositoryRoot()` is anchored at process.cwd(), so the suite chdirs (the
 * populate-task-graph precedent) between a real scratch repository and a proven
 * non-repository, restoring the original cwd afterwards. The `cwd` argument is
 * passed explicitly in every call, so each projection is fully determined by
 * the test and no assertion leans on an ambient directory it did not choose.
 */
describe("panelGuardTargets — the Pi write-target projection feeding the panel admission", () => {
  const originalCwd = process.cwd();
  let repoDir: string;
  let nonRepoDir: string;

  const git = (args: string[], cwd: string): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "loom-panel-guard-repo-"));
    git(["init", "-q"], repoDir);
    nonRepoDir = mkdtempSync(join(tmpdir(), "loom-panel-guard-nonrepo-"));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    for (const dir of [repoDir, nonRepoDir]) rmSync(dir, { recursive: true, force: true });
  });

  it("projects an in-repo target to its repo-relative form — the admission's in-scope shape", () => {
    process.chdir(repoDir);
    expect(panelGuardTargets({ path: join(repoDir, "interview.md") }, repoDir))
      .toEqual(["interview.md"]);
  });

  it("projects an outside-the-repo target out of scope — the shape the role admission blocks", () => {
    process.chdir(repoDir);
    const [relative] = panelGuardTargets({ file_path: join(tmpdir(), `outside-${process.pid}.md`) }, repoDir);
    expect(relative).toMatch(/^\.\.\//);
  });

  it("a `..` segment that normalizes out of the repository projects out of scope", () => {
    process.chdir(repoDir);
    expect(panelGuardTargets({ path: join(repoDir, "..", "escape.md") }, repoDir))
      .toEqual(["../escape.md"]);
  });

  it("an edits-array input projects every deduplicated target, in order", () => {
    process.chdir(repoDir);
    expect(panelGuardTargets({ edits: [
      { path: join(repoDir, "a.md") },
      { filePath: join(repoDir, "b.md") },
      { file_path: join(repoDir, "a.md") },
    ] }, repoDir)).toEqual(["a.md", "b.md"]);
  });

  it("an unobservable repository root yields NO targets — fail closed", () => {
    process.chdir(nonRepoDir);
    // The proven non-repository answer returns silently (no stderr
    // announcement — that is the catch branch's job, for UNEXPECTED probe
    // failures); the empty list is the fail-closed answer the role admission
    // then blocks on.
    expect(panelGuardTargets({ filePath: join(nonRepoDir, "candidate.md") }, nonRepoDir))
      .toEqual([]);
  });
});
