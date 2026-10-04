import { lstatSync, readFileSync } from "node:fs";
import type { Task } from "../../types";
import {
  reviewedWorkspaceObservation,
  type ReviewedArtifact,
  type ReviewedWorkspaceObservation,
} from "../../core/reviewed-workspace";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import { repositoryRoot } from "../../utils/git";
import { captureDeclaredArtifactBaseline } from "../../utils/artifact-baseline";

function reviewedArtifact(root: string, taskId: string, path: string): ReviewedArtifact {
  const inspected = inspectRepositoryPath(root, path, `Task ${taskId} reviewed artifact`);
  if (!inspected.exists) return { path, bytes: null };
  const stat = lstatSync(inspected.absolute);
  if (stat.isFile()) return { path, bytes: readFileSync(inspected.absolute) };
  if (!stat.isDirectory()) throw new Error(`Task ${taskId} reviewed artifact must be a regular file or directory: ${path}`);
  const [baseline] = captureDeclaredArtifactBaseline(root, [path]);
  if (baseline?.snapshot.kind !== "sha256") throw new Error(`Task ${taskId} reviewed directory vanished during observation: ${path}`);
  return { path, tree: baseline.snapshot.digest };
}

/** I/O adapter for the functional reviewed-workspace core. It reads exact
 * declared bytes, including already-dirty and untracked files, and a declared
 * directory's Git-visible tree digest; Git HEAD is not consulted because it is
 * not the reviewed workspace. */
export function observeReviewedWorkspace(
  tasks: readonly Task[],
  root: string = repositoryRoot() ?? process.cwd(),
): readonly ReviewedWorkspaceObservation[] {
  return tasks.map((task) => {
    const scope = canonicalRepositoryPaths(root, task.file_list ?? [], `Task ${task.id} file_list`);
    const artifacts = scope.map((path) => reviewedArtifact(root, task.id, path));
    return reviewedWorkspaceObservation(task.id, scope, artifacts);
  });
}
