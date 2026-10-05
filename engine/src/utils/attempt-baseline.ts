// ---------------------------------------------------------------------------
// Attempt-baseline comparison — ONE implementation, ONE fail-closed contract
// ---------------------------------------------------------------------------
import type { DeclaredArtifactBaseline } from "../core/artifact-baseline";
import { changedDeclaredArtifactsSince } from "./declared-artifact-snapshot";
import { changedRepositoryArtifactsSince } from "./repository-change-baseline";

/**
 * Which stored baseline proves "bytes changed since this attempt started".
 *
 * `repository` is the strict form: only the compact repository boundary counts,
 * and its absence is a comparison FAILURE (there is nothing to compare against).
 * `repository-or-declared` is the compatibility form used where older graphs may
 * carry only a declared-artifact attempt baseline; `extraModifiedPaths` lets a
 * caller add transcript-reported writes that no declared baseline anticipated.
 */
export type AttemptBaselineMode =
  | Readonly<{ kind: "repository" }>
  | Readonly<{ kind: "repository-or-declared"; extraModifiedPaths?: readonly string[] }>;

export interface AttemptBaselineTask {
  readonly artifact_baseline?: readonly DeclaredArtifactBaseline[];
  readonly attempt_artifact_baseline?: readonly DeclaredArtifactBaseline[];
  readonly attempt_repository_baseline?: readonly DeclaredArtifactBaseline[];
  readonly file_list?: readonly string[];
}

export interface AttemptBaselineComparison {
  readonly changedDeclaredArtifacts: readonly string[];
  readonly changedRepositoryArtifacts: readonly string[];
  /** `true` whenever the attempt's bytes moved — OR whenever that cannot be
   *  proven, which is what makes this fail closed. */
  readonly bytesChangedSinceAttempt: boolean;
  /** The comparison's failure cause, or null on a clean comparison. */
  readonly failure: string | null;
}

/**
 * Compare a task's stored baselines against the working tree.
 *
 * This existed THREE times inside `pi/extension.ts` — in
 * `finalizeReservedImplementations`' reducer, in the malformed-transcript
 * reducer, and in the successful-transcript path — with three different
 * `catch` behaviors for the identical failure. Two invalidated the stale
 * evidence and recorded an untrusted resolution; the third only dropped the
 * task from `executing_tasks` and moved on, leaving it pending with NO
 * resolution recorded. So the same thrown comparison — an unreadable artifact,
 * a malformed stored baseline, a git failure — either failed closed with a
 * verdict or silently stranded the task, depending purely on which of the
 * three copies happened to be running.
 *
 * One implementation, one contract: a comparison that cannot complete reports
 * `bytesChangedSinceAttempt: true` (the attempt's evidence is NOT proven
 * current, so it must be re-judged), falls back to the task's declared
 * `file_list` for changed artifacts, and returns the cause in `failure` so the
 * caller records a resolution instead of dropping the task.
 */
export function compareAttemptBaseline(
  root: string,
  task: AttemptBaselineTask,
  mode: AttemptBaselineMode,
): AttemptBaselineComparison {
  try {
    const changedDeclared = changedDeclaredArtifactsSince(root, task.artifact_baseline);
    if (mode.kind === "repository" || task.attempt_repository_baseline !== undefined) {
      const changedRepository = changedRepositoryArtifactsSince(root, task.attempt_repository_baseline);
      return Object.freeze({
        changedDeclaredArtifacts: changedDeclared,
        changedRepositoryArtifacts: changedRepository,
        bytesChangedSinceAttempt: changedRepository.length > 0,
        failure: null,
      });
    }
    const extra = mode.extraModifiedPaths ?? [];
    const bytesChanged = task.attempt_artifact_baseline === undefined ||
      changedDeclaredArtifactsSince(root, task.attempt_artifact_baseline).length > 0 ||
      extra.some((path) => !task.attempt_artifact_baseline?.some(({ artifact }) => artifact === path));
    return Object.freeze({
      changedDeclaredArtifacts: changedDeclared,
      changedRepositoryArtifacts: Object.freeze([]),
      bytesChangedSinceAttempt: bytesChanged,
      failure: null,
    });
  } catch (error) {
    return Object.freeze({
      changedDeclaredArtifacts: Object.freeze([...(task.file_list ?? [])]),
      changedRepositoryArtifacts: Object.freeze([]),
      bytesChangedSinceAttempt: true,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}
