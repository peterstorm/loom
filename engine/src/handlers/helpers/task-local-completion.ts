/**
 * Thin Task-local completion observation shell.
 *
 * It executes no Task/project command. The only effects are parser-confined
 * repository path reads, exact file snapshots, and fixed-argv Git dirty-set
 * observation through the existing repository adapter.
 */

import { lstatSync } from "node:fs";
import type { Task } from "../../types";
import {
  buildTaskLocalByteObservation,
  parseNewTestEvidence,
  unavailableTaskLocalByteObservation,
  type NewTestEvidence,
  type TaskLocalByteObservation,
} from "../../core/implementation-application";
import type { ImplementationAttemptAuthority } from "../../core/implementation-completion";
import {
  captureDeclaredArtifactBaseline,
  changedRepositoryArtifactsSince,
} from "../../utils/artifact-baseline";
import { canonicalRepositoryPaths } from "../../utils/repository-path";
import type {
  NewTestWaiverReason,
  VerificationRequirement,
} from "../../core/verification-policy";
import * as git from "../../utils/git";

export type TaskLocalCompletionArgs = Readonly<{
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

export type TaskLocalCompletionPorts = Readonly<{
  observeHead: (repositoryRoot: string) => git.GitHeadObservation;
}>;

const REAL_TASK_LOCAL_PORTS: TaskLocalCompletionPorts = Object.freeze({
  observeHead: git.observeExactHead,
});

function authorityHead(
  args: TaskLocalCompletionArgs,
  ports: TaskLocalCompletionPorts,
  phase: "before" | "after",
): void {
  const observed = ports.observeHead(args.repositoryRoot);
  if (!observed.ok) throw new Error(`Git HEAD ${phase} Task-local observation is unreadable: ${observed.error}`);
  if (observed.headSha !== args.authority.headSha) {
    throw new Error(
      `Git HEAD ${phase} Task-local observation ${observed.headSha} does not equal attempt authority ${args.authority.headSha}`,
    );
  }
}

function observeAvailableTaskScope(
  args: TaskLocalCompletionArgs,
  baselines: RequiredTaskBaselines,
  ports: TaskLocalCompletionPorts,
): TaskLocalByteObservation {
  authorityHead(args, ports, "before");
  let observed: TaskLocalByteObservation | undefined;
  let observationFailure: unknown;
  try {
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
    observed = buildTaskLocalByteObservation({
      authority: args.authority,
      attemptBaseline: baselines.attempt,
      currentAttemptScope,
      proofBaseline: baselines.proof,
      currentProofScope,
      parserModifiedPaths,
      priorAttributedPaths,
      repositoryDirtySetChanged,
    });
  } catch (error) {
    observationFailure = error;
  }
  authorityHead(args, ports, "after");
  if (observationFailure !== undefined) throw observationFailure;
  if (observed === undefined) throw new Error("Task-local observation produced no facts");
  return observed;
}

export function observeTaskLocalCompletion(
  args: TaskLocalCompletionArgs,
  ports: TaskLocalCompletionPorts = REAL_TASK_LOCAL_PORTS,
): TaskLocalByteObservation {
  try {
    return observeAvailableTaskScope(args, requireTaskBaselines(args.task), ports);
  } catch (error) {
    return unavailableTaskLocalByteObservation(
      args.authority,
      `Task-local byte observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type NewTestRequirement = boolean | undefined | VerificationRequirement<NewTestWaiverReason>;

function waivedNewTestEvidence(requirement: NewTestRequirement): NewTestEvidence | null {
  let reason: NewTestWaiverReason | null = null;
  if (requirement === false) reason = "legacy-new-tests-required-false";
  else if (typeof requirement === "object" && requirement.kind === "waived") {
    reason = requirement.reason;
  }
  return reason === null
    ? null
    : parseNewTestEvidence(false, `verification_policy.new_tests waived: ${reason}`);
}

/** Pure new-test evidence classification from already-collected diff bytes. */
export function analyzeNewTests(
  diff: string,
  requirement: NewTestRequirement,
): NewTestEvidence {
  const waiver = waivedNewTestEvidence(requirement);
  if (waiver !== null) return waiver;

  const tests = git.countNewTests(diff);
  const assertions = tests.total > 0 ? git.countAssertions(diff) : 0;
  if (tests.total > 0 && assertions > 0) {
    const details = [
      tests.java > 0 ? `java: ${tests.java} @Test/@Property` : "",
      tests.ts > 0 ? `ts: ${tests.ts} it/test/describe` : "",
      tests.python > 0 ? `python: ${tests.python} test functions` : "",
      tests.rust > 0 ? `rust: ${tests.rust} #[test]` : "",
    ].filter(Boolean).join("; ");
    return parseNewTestEvidence(
      true,
      `${tests.total} new test methods, ${assertions} assertions (${details})`,
    );
  }
  return parseNewTestEvidence(
    false,
    tests.total > 0 ? `${tests.total} test methods but 0 assertions (empty stubs?)` : "",
  );
}

export type FilePresenceResult =
  | Readonly<{ ok: true; exists: boolean }>
  | Readonly<{ ok: false; error: string }>;

/** Narrow injectable filesystem/Git shell used by focused tests. */
export type DiffDeps = Readonly<{
  isTracked: (file: string) => git.GitTrackedResult;
  diffFiles: (files: string[]) => git.GitDiffResult;
  diffFilesStaged: (files: string[]) => git.GitDiffResult;
  diffFilesSince: (revision: string, files: string[]) => git.GitDiffResult;
  diffUntracked: (file: string) => git.GitDiffResult;
  inspectFilePresence: (path: string) => FilePresenceResult;
}>;

function inspectFilePresence(path: string): FilePresenceResult {
  try {
    lstatSync(path);
    return { ok: true, exists: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { ok: true, exists: false }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const REAL_DIFF_DEPS: DiffDeps = {
  isTracked: git.isTracked,
  diffFiles: git.diffFiles,
  diffFilesStaged: git.diffFilesStaged,
  diffFilesSince: git.diffFilesSince,
  diffUntracked: git.diffUntracked,
  inspectFilePresence,
};

export function collectDiff(
  filesModified: readonly string[],
  deps: DiffDeps = REAL_DIFF_DEPS,
  startSha?: string,
): string {
  if (filesModified.length === 0) return "";
  const classified = filesModified.map((file) => {
    const result = deps.isTracked(file);
    if (!result.ok) throw new Error(`new-test diff authority unavailable: ${result.error}`);
    return { file, tracked: result.tracked };
  });
  const tracked = classified.flatMap(({ file, tracked: isTracked }) => isTracked ? [file] : []);
  const untracked = classified.flatMap(({ file, tracked: isTracked }) => {
    if (isTracked) return [];
    const presence = deps.inspectFilePresence(file);
    if (!presence.ok) {
      throw new Error(`new-test diff authority unavailable: cannot inspect ${file}: ${presence.error}`);
    }
    return presence.exists ? [file] : [];
  });
  const diffs = [
    startSha === undefined ? { ok: true as const, diff: "" } : deps.diffFilesSince(startSha, tracked),
    deps.diffFiles(tracked),
    deps.diffFilesStaged(tracked),
    ...untracked.map((file) => deps.diffUntracked(file)),
  ];
  return diffs.map((result) => {
    if (!result.ok) throw new Error(`new-test diff authority unavailable: ${result.error}`);
    return result.diff;
  }).join("\n");
}

/** Shared Claude/Pi shell operation; waiver arms avoid unnecessary Git I/O. */
export function collectNewTestEvidence(
  filesModified: readonly string[],
  requirement: NewTestRequirement,
  startSha?: string,
  deps: DiffDeps = REAL_DIFF_DEPS,
): NewTestEvidence {
  return waivedNewTestEvidence(requirement) ??
    analyzeNewTests(collectDiff(filesModified, deps, startSha), requirement);
}
