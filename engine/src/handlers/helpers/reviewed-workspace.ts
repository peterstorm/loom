import { readFileSync } from "node:fs";
import type { Task } from "../../types";
import {
  reviewedWorkspaceObservation,
  type ReviewedArtifact,
  type ReviewedWorkspaceObservation,
} from "../../core/reviewed-workspace";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import { repositoryRoot } from "../../utils/git";

/** I/O adapter for the functional reviewed-workspace core. It reads exact
 * declared bytes, including already-dirty and untracked files; Git HEAD is not
 * consulted because it is not the reviewed workspace. */
export function observeReviewedWorkspace(
  tasks: readonly Task[],
  root: string = repositoryRoot() ?? process.cwd(),
): readonly ReviewedWorkspaceObservation[] {
  return tasks.map((task) => {
    const scope = canonicalRepositoryPaths(root, task.file_list ?? [], `Task ${task.id} file_list`);
    const artifacts: ReviewedArtifact[] = scope.map((path) => {
      const inspected = inspectRepositoryPath(root, path, `Task ${task.id} reviewed artifact`, { mustBeFile: true });
      return { path, bytes: inspected.exists ? readFileSync(inspected.absolute) : null };
    });
    return reviewedWorkspaceObservation(task.id, scope, artifacts);
  });
}
