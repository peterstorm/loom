import { lstatSync, readFileSync } from "node:fs";
import type { Task } from "../../types";
import {
  reviewedWorkspaceObservation,
  type ObservedArtifact,
  type ReviewedWorkspaceObservation,
} from "../../core/reviewed-workspace";
import { taskReviewScope } from "../../core/wave-review-authority";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import { repositoryRoot } from "../../utils/git";
import { worktreeLeafBytes, worktreeVisibleLeaves } from "../../utils/git-leaves";

/** A declared path's reviewed files: the file itself, or every Git-visible
 * leaf of a declared directory — the same leaves a directory artifact
 * snapshot hashes. A leaf is its bytes, a symlink's target bytes, or null
 * when an index entry has no worktree file; a directory with no visible leaf
 * is absent. */
function reviewedArtifacts(root: string, taskId: string, path: string): readonly ObservedArtifact[] {
  const inspected = inspectRepositoryPath(root, path, `Task ${taskId} reviewed artifact`);
  if (!inspected.exists) return [{ path, bytes: null }];
  const stat = lstatSync(inspected.absolute);
  if (stat.isFile()) return [{ path, bytes: readFileSync(inspected.absolute) }];
  if (!stat.isDirectory()) throw new Error(`Task ${taskId} reviewed artifact must be a regular file or directory: ${path}`);
  const leaves = worktreeVisibleLeaves(root, path);
  if (leaves.length === 0) return [{ path, bytes: null }];
  return leaves.map((leaf): ObservedArtifact => {
    switch (leaf.kind) {
      case "file":
      case "symlink":
        return { path: leaf.path, bytes: worktreeLeafBytes(leaf) };
      case "absent":
        return { path: leaf.path, bytes: null };
      case "shadowed":
      case "unsupported":
        throw new Error(`Task ${taskId} reviewed artifact must be a regular file or symlink: ${leaf.path}`);
    }
  });
}

/** I/O adapter for the functional reviewed-workspace core. It reads exact
 * declared bytes, including already-dirty and untracked files, and expands a
 * declared directory into its Git-visible leaf files; Git HEAD is not
 * consulted because it is not the reviewed workspace. */
export function observeReviewedWorkspace(
  tasks: readonly Task[],
  root: string = repositoryRoot() ?? process.cwd(),
): readonly ReviewedWorkspaceObservation[] {
  return tasks.map((task) => {
    const scope = canonicalRepositoryPaths(root, taskReviewScope(task), `Task ${task.id} review scope`);
    const byPath = new Map<string, ObservedArtifact>();
    for (const path of scope) {
      for (const artifact of reviewedArtifacts(root, task.id, path)) byPath.set(artifact.path, artifact);
    }
    const observation = reviewedWorkspaceObservation(task.id, scope, [...byPath.values()]);
    if (!observation.ok) throw new Error(`Task ${task.id} reviewed workspace: ${observation.error}`);
    return observation.value;
  });
}
