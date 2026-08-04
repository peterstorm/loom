import { execFileSync } from "node:child_process";
import type { HookHandler, Task, TaskGraph } from "../../types";
import { newWaveGate } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import {
  evaluateTaskProof,
  PI_STRUCTURED_EVIDENCE_POLICY,
} from "../../core/proof-obligations";
import { attributedChangedArtifacts } from "../../core/artifact-baseline";
import {
  captureDeclaredArtifactBaselineAtRevision,
  changedDeclaredArtifactsSince,
  changedDeclaredArtifactsSinceRevision,
} from "../../utils/artifact-baseline";
import * as git from "../../utils/git";
import {
  collectNewTestEvidence,
  isWaveComplete,
  type NewTestEvidence,
} from "../subagent-stop/update-task-status";
import { parseWaveArg } from "./wave-args";

const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseRecoveredBaselineSha(args: readonly string[]): string | null {
  const indexes = args.flatMap((arg, index) => arg === "--baseline-sha" ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new Error("--baseline-sha may be supplied only once");
  const value = args[indexes[0]! + 1];
  if (!value || !GIT_SHA.test(value)) {
    throw new Error("--baseline-sha must be a lowercase 40- or 64-character Git SHA");
  }
  return value;
}

function taskCompletionWasObserved(task: Task): boolean {
  return task.proof?.state !== "pending" && task.proof !== undefined &&
    task.proof.results.some((result) =>
      result.state === "satisfied" && result.evidence.kind === "task-completed"
    );
}

/** Re-evaluate a failed aggregate from already-persisted evidence. This does
 * not invent completion or test provenance: it keeps the prior completion
 * observation, stored test result, structured writes, and current byte delta. */
export function reconcileTaskFromStoredEvidence(
  task: Task,
  proofArtifactsChanged: readonly string[],
  collectedNewTests: NewTestEvidence,
): Task {
  if (task.status === "completed" || task.proof?.state === "satisfied") return task;
  const newTestsWritten = task.new_tests_written === true || collectedNewTests.written;
  const newTestEvidence = task.new_test_evidence?.trim() || collectedNewTests.evidence;
  const proof = evaluateTaskProof(
    {
      newTestsRequired: task.new_tests_required !== false,
      declaredArtifacts: task.file_list ?? [],
    },
    {
      taskCompleted: taskCompletionWasObserved(task),
      testResult: task.test_result,
      filesModified: proofArtifactsChanged,
      newTestsWritten,
      newTestEvidence,
    },
    PI_STRUCTURED_EVIDENCE_POLICY,
  );
  return {
    ...task,
    status: proof.state === "satisfied" ? "implemented" : "pending",
    proof,
    new_tests_written: newTestsWritten,
    new_test_evidence: newTestEvidence,
  };
}

function failureSummary(task: Task): string {
  if (task.proof?.state !== "failed") return task.proof?.state ?? "missing";
  return task.proof.failures.map((failure) =>
    failure.kind === "declared-artifact-not-changed"
      ? `${failure.kind}:${failure.artifact}`
      : failure.kind
  ).join(", ");
}

const handler: HookHandler = async (_stdin, args) => {
  let requestedWave: number | null;
  let recoveredBaselineSha: string | null;
  try {
    requestedWave = parseWaveArg(args);
    recoveredBaselineSha = parseRecoveredBaselineSha(args);
  } catch (error) {
    return { kind: "error", message: `reconcile-implementation-proof: ${(error as Error).message}` };
  }

  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (!manager) return { kind: "error", message: `No task graph at ${statePath}` };
  const root = git.repositoryRoot();
  if (!root || !git.isGitRepo()) {
    return { kind: "error", message: "reconcile-implementation-proof requires a git repository" };
  }
  if (recoveredBaselineSha !== null) {
    try {
      execFileSync("git", ["cat-file", "-e", `${recoveredBaselineSha}^{commit}`], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
      });
      execFileSync("git", ["merge-base", "--is-ancestor", recoveredBaselineSha, "HEAD"], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      return {
        kind: "error",
        message: `--baseline-sha ${recoveredBaselineSha} must identify a commit that is an ancestor of HEAD`,
      };
    }
  }

  let wave = requestedWave ?? 1;
  let reconciled: TaskGraph | null = null;
  try {
    await manager.update((state) => {
      wave = requestedWave ?? state.current_wave ?? 1;
      if (!state.tasks.some((task) => task.wave === wave)) {
        throw new Error(`Wave ${wave} has no tasks`);
      }
      const tasks = state.tasks.map((task) => {
        if (task.wave !== wave || task.status === "completed" || task.proof?.state === "satisfied") return task;
        const sourceTask: Task = recoveredBaselineSha === null
          ? task
          : {
              ...task,
              start_sha: recoveredBaselineSha,
              artifact_baseline: captureDeclaredArtifactBaselineAtRevision(
                root,
                recoveredBaselineSha,
                task.file_list ?? [],
              ),
              artifact_baseline_recovered_from: recoveredBaselineSha,
            };
        const snapshotChanges = changedDeclaredArtifactsSince(root, sourceTask.artifact_baseline);
        const revisionChanges = sourceTask.start_sha
          ? changedDeclaredArtifactsSinceRevision(root, sourceTask.start_sha, sourceTask.file_list ?? [])
          : [];
        const byteChanges = [...new Set([...snapshotChanges, ...revisionChanges])];
        const proofArtifactsChanged = attributedChangedArtifacts(byteChanges, sourceTask.files_modified ?? []);
        const collectedNewTests = collectNewTestEvidence(
          sourceTask.files_modified ?? [],
          sourceTask.start_sha,
          sourceTask.new_tests_required,
        );
        return reconcileTaskFromStoredEvidence(sourceTask, proofArtifactsChanged, collectedNewTests);
      });
      const resolved: TaskGraph = { ...state, tasks };
      reconciled = {
        ...resolved,
        wave_gates: {
          ...resolved.wave_gates,
          [String(wave)]: {
            ...(resolved.wave_gates[String(wave)] ?? newWaveGate()),
            impl_complete: isWaveComplete(resolved, wave),
          },
        },
      };
      return reconciled;
    });
  } catch (error) {
    return {
      kind: "error",
      message: `reconcile-implementation-proof failed without changing state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (reconciled === null) {
    return { kind: "error", message: "reconcile-implementation-proof produced no state" };
  }
  const tasks = (reconciled as TaskGraph).tasks.filter((task) => task.wave === wave);
  for (const task of tasks) {
    process.stderr.write(
      `${task.id}: status=${task.status}, proof=${task.proof?.state ?? "missing"}` +
      `${task.proof?.state === "failed" ? `, failures=[${failureSummary(task)}]` : ""}\n`,
    );
  }
  const failed = tasks.filter((task) => task.proof?.state !== "satisfied");
  return failed.length === 0
    ? { kind: "passthrough" }
    : {
        kind: "error",
        message: `Wave ${wave} still has ${failed.length} task(s) with unsatisfied implementation proof`,
      };
};

export default handler;
