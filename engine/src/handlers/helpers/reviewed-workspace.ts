import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import type { Task } from "../../types";
import {
  reviewedWorkspaceObservation,
  type ReviewedArtifact,
  type ReviewedWorkspaceObservation,
} from "../../core/reviewed-workspace";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import { repositoryRoot, visibleLeavesAt } from "../../utils/git";

/** One Git-visible leaf below a declared directory: its bytes, a symlink's
 * target bytes (as directory artifact snapshots hash it), or null when an
 * index entry has no worktree file. */
function leafArtifact(root: string, taskId: string, path: string): ReviewedArtifact {
  const inspected = inspectRepositoryPath(root, path, `Task ${taskId} reviewed artifact`, { allowLeafSymlink: true });
  if (!inspected.exists) return { path, bytes: null };
  const stat = lstatSync(inspected.absolute);
  if (stat.isFile()) return { path, bytes: readFileSync(inspected.absolute) };
  if (stat.isSymbolicLink()) return { path, bytes: readlinkSync(inspected.absolute, { encoding: "buffer" }) };
  throw new Error(`Task ${taskId} reviewed artifact must be a regular file or symlink: ${path}`);
}

/** A declared path's reviewed files: the file itself, or every Git-visible
 * leaf of a declared directory. Ignored files stay out, as they do for
 * directory artifact snapshots; a directory with no visible leaf is absent. */
function reviewedArtifacts(root: string, taskId: string, path: string): readonly ReviewedArtifact[] {
  const inspected = inspectRepositoryPath(root, path, `Task ${taskId} reviewed artifact`);
  if (!inspected.exists) return [{ path, bytes: null }];
  const stat = lstatSync(inspected.absolute);
  if (stat.isFile()) return [{ path, bytes: readFileSync(inspected.absolute) }];
  if (!stat.isDirectory()) throw new Error(`Task ${taskId} reviewed artifact must be a regular file or directory: ${path}`);
  const leaves = visibleLeavesAt(root, path);
  if (!leaves.ok) throw new Error(`Task ${taskId} reviewed directory ${path}: ${leaves.error}`);
  return leaves.paths.length === 0
    ? [{ path, bytes: null }]
    : leaves.paths.map((leaf) => leafArtifact(root, taskId, leaf));
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
    const scope = canonicalRepositoryPaths(
      root,
      [...new Set([...(task.file_list ?? []), ...(task.files_modified ?? [])])],
      `Task ${task.id} review scope`,
    );
    const byPath = new Map<string, ReviewedArtifact>();
    for (const path of scope) {
      for (const artifact of reviewedArtifacts(root, task.id, path)) byPath.set(artifact.path, artifact);
    }
    return reviewedWorkspaceObservation(task.id, scope, [...byPath.values()]);
  });
}
