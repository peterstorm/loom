/**
 * Thin Task-local completion observation shell.
 *
 * It executes no Task/project command. The only effects are parser-confined
 * repository path reads, exact file snapshots, and fixed-argv Git dirty-set
 * observation through the existing repository adapter.
 */

import type { Task } from "../../types";
import {
  buildTaskLocalByteObservation,
  unavailableTaskLocalByteObservation,
  type TaskLocalByteObservation,
} from "../../core/implementation-application";
import type { ImplementationAttemptAuthority } from "../../core/implementation-completion";
import {
  captureDeclaredArtifactBaseline,
  changedRepositoryArtifactsSince,
} from "../../utils/artifact-baseline";
import { canonicalRepositoryPaths } from "../../utils/repository-path";

type TaskLocalCompletionArgs = Readonly<{
  repositoryRoot: string;
  task: Task;
  authority: ImplementationAttemptAuthority;
  parserModifiedPaths: readonly string[];
  parserPathLabel: string;
}>;

type RequiredTaskBaselines = Readonly<{
  attempt: NonNullable<Task["attempt_artifact_baseline"]>;
  proof: NonNullable<Task["artifact_baseline"]>;
  repository: NonNullable<Task["attempt_repository_baseline"]>;
}>;

function requireTaskBaselines(task: Task): RequiredTaskBaselines {
  if (task.attempt_artifact_baseline === undefined) {
    throw new Error("active Implementation Attempt has no attempt_artifact_baseline");
  }
  if (task.artifact_baseline === undefined) {
    throw new Error("Task has no first artifact_baseline for cumulative Proof");
  }
  if (task.attempt_repository_baseline === undefined) {
    throw new Error("active Implementation Attempt has no attempt_repository_baseline");
  }
  return {
    attempt: task.attempt_artifact_baseline,
    proof: task.artifact_baseline,
    repository: task.attempt_repository_baseline,
  };
}

function observeAvailableTaskScope(
  args: TaskLocalCompletionArgs,
  baselines: RequiredTaskBaselines,
): TaskLocalByteObservation {
  const parserModifiedPaths = canonicalRepositoryPaths(
    args.repositoryRoot,
    args.parserModifiedPaths,
    args.parserPathLabel,
  );
  const priorAttributedPaths = canonicalRepositoryPaths(
    args.repositoryRoot,
    args.task.files_modified ?? [],
    `${args.task.id}.files_modified`,
  );
  const currentAttemptScope = captureDeclaredArtifactBaseline(
    args.repositoryRoot,
    baselines.attempt.map(({ artifact }) => artifact),
  );
  const currentProofScope = captureDeclaredArtifactBaseline(
    args.repositoryRoot,
    baselines.proof.map(({ artifact }) => artifact),
  );
  const repositoryDirtySetChanged = changedRepositoryArtifactsSince(
    args.repositoryRoot,
    baselines.repository,
  ).length > 0;
  return buildTaskLocalByteObservation({
    authority: args.authority,
    attemptBaseline: baselines.attempt,
    currentAttemptScope,
    proofBaseline: baselines.proof,
    currentProofScope,
    parserModifiedPaths,
    priorAttributedPaths,
    repositoryDirtySetChanged,
  });
}

export function observeTaskLocalCompletion(args: TaskLocalCompletionArgs): TaskLocalByteObservation {
  try {
    return observeAvailableTaskScope(args, requireTaskBaselines(args.task));
  } catch (error) {
    return unavailableTaskLocalByteObservation(
      args.authority,
      `Task-local byte observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
