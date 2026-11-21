import {
  buildTaskLocalByteObservation,
  NO_ENGINE_SKELETONS,
  parseNewTestEvidence,
} from "../../src/core/implementation-application";
import type { ExactImplementationSettlementPorts } from "../../src/handlers/helpers/exact-implementation-settlement";

/** The settlement root both I6 settlement suites observe; nothing is read from it. */
export const DECLARED_FILES_CHANGED_ROOT = "/fixture";

const snapshots = (paths: readonly string[], changed: boolean) =>
  [...paths].sort().map((artifact) => ({
    artifact,
    snapshot: changed ? { kind: "sha256" as const, digest: "b".repeat(64) } : { kind: "missing" as const },
  }));

/**
 * Settlement ports for an attempt that changed every declared file in
 * `fileList` and nothing else, reporting new tests in them unless
 * `newTestsWritten` is false.
 */
export function declaredFilesChangedPorts(
  fileList: readonly string[],
  newTestsWritten = true,
): ExactImplementationSettlementPorts {
  return {
    repository: {
      root: DECLARED_FILES_CHANGED_ROOT,
      authoritativeStatePath: `${DECLARED_FILES_CHANGED_ROOT}/.claude/state/active_task_graph.json`,
      observeTaskLocal: () => buildTaskLocalByteObservation({
        attemptBaseline: snapshots(fileList, false),
        currentAttemptScope: snapshots(fileList, true),
        proofBaseline: snapshots(fileList, false),
        currentProofScope: snapshots(fileList, true),
        parserModifiedPaths: [],
        priorAttributedPaths: [],
        repositoryChangedPaths: [...fileList],
        siblingOwnedPaths: [],
        engineSkeletons: NO_ENGINE_SKELETONS,
      }),
    },
    newTests: {
      collect: () => ({
        ok: true,
        value: parseNewTestEvidence(newTestsWritten, newTestsWritten ? `new tests in ${fileList.join(", ")}` : undefined),
      }),
    },
  };
}
