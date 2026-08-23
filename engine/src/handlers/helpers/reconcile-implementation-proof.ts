import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  HookHandler,
  RecoveredArtifactWriteEvidence,
  Task,
  TaskGraph,
} from "../../types";
import { newWaveGate } from "../../types";
import { taskGraphPath } from "../../config";
import { PostCommitStateProtectionError, StateManager } from "../../state-manager";
import {
  evaluateTaskProof,
  PI_STRUCTURED_EVIDENCE_POLICY,
} from "../../core/proof-obligations";
import { attributedChangedArtifacts } from "../../core/artifact-baseline";
import { invalidateTaskReview } from "../../core/review-output";
import {
  parseReviewPacketRecovery,
  type VerifiedReviewPacketRecovery,
} from "../../core/review-packet";
import {
  captureDeclaredArtifactBaselineAtRevision,
  changedDeclaredArtifactsSince,
  changedDeclaredArtifactsSinceRevision,
} from "../../utils/artifact-baseline";
import * as git from "../../utils/git";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import {
  collectNewTestEvidence,
  isWaveComplete,
  type NewTestEvidence,
} from "../subagent-stop/update-task-status";
import { parseWaveArg } from "./wave-args";
import { isExactGitSha } from "../../core/git-sha";
import { taskVerificationPolicy } from "../../core/verification-policy";

export interface RecoveryPacketBinding {
  readonly taskId: string;
  readonly packetPath: string;
}

export function parseRecoveryPacketBindings(args: readonly string[]): readonly RecoveryPacketBinding[] {
  const bindings: RecoveryPacketBinding[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--packet") continue;
    const value = args[index + 1];
    const separator = value?.indexOf("=") ?? -1;
    if (!value || separator <= 0 || separator === value.length - 1) {
      throw new Error("--packet must use TASK_ID=REPOSITORY_RELATIVE_PACKET_PATH");
    }
    bindings.push(Object.freeze({
      taskId: value.slice(0, separator),
      packetPath: value.slice(separator + 1),
    }));
  }
  const duplicate = bindings.find((binding, index) =>
    bindings.slice(0, index).some((prior) =>
      prior.taskId === binding.taskId && prior.packetPath === binding.packetPath
    )
  );
  if (duplicate) throw new Error(`duplicate --packet binding ${duplicate.taskId}=${duplicate.packetPath}`);
  return Object.freeze(bindings);
}

export function parseRecoveredBaselineSha(args: readonly string[]): string | null {
  const indexes = args.flatMap((arg, index) => arg === "--baseline-sha" ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new Error("--baseline-sha may be supplied only once");
  const value = args[indexes[0]! + 1];
  if (!isExactGitSha(value)) {
    throw new Error("--baseline-sha must be a lowercase 40- or 64-character Git SHA");
  }
  return value;
}

interface RecoveredPacketEvidence {
  readonly modifiedPathsByTask: ReadonlyMap<string, readonly string[]>;
  readonly auditByTask: ReadonlyMap<string, readonly RecoveredArtifactWriteEvidence[]>;
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function verifyIssuedPacketRegistration(
  task: Task,
  packetPath: string,
  packet: VerifiedReviewPacketRecovery,
): void {
  const registration = (task.issued_review_packets ?? []).find((entry) => entry.packet_id === packet.packetId);
  if (registration === undefined) {
    throw new Error(`recovery packet ${packetPath} is not registered as engine-issued for ${task.id}`);
  }
  const packetScope = [...new Set([...packet.declaredPaths, ...packet.modifiedPaths])].sort();
  if (
    registration.task_id !== task.id ||
    registration.packet_path !== packetPath ||
    registration.base_sha !== packet.baseSha ||
    registration.head_sha !== packet.headSha ||
    !samePathSet(registration.scope, packetScope)
  ) {
    throw new Error(`recovery packet ${packetPath} does not exactly match its engine-issued registration`);
  }
}

function verifyPacketCommitRange(root: string, packet: VerifiedReviewPacketRecovery): void {
  execFileSync("git", ["cat-file", "-e", `${packet.headSha}^{commit}`], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync("git", ["merge-base", "--is-ancestor", packet.baseSha, packet.headSha], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync("git", ["merge-base", "--is-ancestor", packet.headSha, "HEAD"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
}

function recoverPacketEvidence(
  root: string,
  state: TaskGraph,
  wave: number,
  baselineSha: string,
  bindings: readonly RecoveryPacketBinding[],
): RecoveredPacketEvidence {
  const pathsByTask = new Map<string, string[]>();
  const auditByTask = new Map<string, RecoveredArtifactWriteEvidence[]>();
  const seenPacketIds = new Set<string>();

  for (const binding of bindings) {
    const task = state.tasks.find((candidate) => candidate.id === binding.taskId && candidate.wave === wave);
    if (!task) throw new Error(`packet binding names no Task ${binding.taskId} in wave ${wave}`);
    if (task.status === "completed" || task.proof?.state === "satisfied") {
      throw new Error(`packet binding names ${binding.taskId}, which already has satisfied implementation proof`);
    }
    const inspectedPacket = inspectRepositoryPath(
      root,
      binding.packetPath,
      `recovery packet for ${binding.taskId}`,
      { mustExist: true, mustBeFile: true },
    );
    const parsed = parseReviewPacketRecovery(readFileSync(inspectedPacket.absolute, "utf-8"));
    if (!parsed.ok) throw new Error(`invalid recovery packet ${inspectedPacket.relative}: ${parsed.errors.join("; ")}`);
    const packet = parsed.value;
    if (seenPacketIds.has(packet.packetId)) throw new Error(`recovery packet id ${packet.packetId} is repeated`);
    seenPacketIds.add(packet.packetId);
    if (packet.taskId !== task.id) {
      throw new Error(`recovery packet ${inspectedPacket.relative} belongs to ${packet.taskId}, not ${task.id}`);
    }
    verifyIssuedPacketRegistration(task, inspectedPacket.relative, packet);
    if (packet.baseSha !== baselineSha) {
      throw new Error(`recovery packet ${inspectedPacket.relative} base ${packet.baseSha} does not equal ${baselineSha}`);
    }
    verifyPacketCommitRange(root, packet);

    const declared = [...canonicalRepositoryPaths(root, task.file_list ?? [], `${task.id}.file_list`)].sort();
    if (!samePathSet(declared, packet.declaredPaths)) {
      throw new Error(`recovery packet ${inspectedPacket.relative} declaredPaths do not equal ${task.id}.file_list`);
    }
    const declaredSet = new Set(declared);
    const artifactPaths = new Set(packet.artifacts.map((artifact) => artifact.path));
    const currentChangesFromBaseline = new Set(
      changedDeclaredArtifactsSinceRevision(root, baselineSha, declared),
    );
    const recoveredPaths: string[] = [];
    for (const path of packet.modifiedPaths.filter((candidate) => declaredSet.has(candidate))) {
      if (!artifactPaths.has(path)) {
        throw new Error(`recovery packet ${inspectedPacket.relative} has no artifact for ${path}`);
      }
      // A packet proves that this Task historically wrote the path. Current
      // bytes may legitimately contain later cumulative edits, so bind the
      // recovered attribution to the trusted Git baseline—not to the packet's
      // historical postimage.
      if (!currentChangesFromBaseline.has(path)) {
        throw new Error(
          `recovery packet ${inspectedPacket.relative} names ${path}, but current bytes do not differ from recovered baseline ${baselineSha}`,
        );
      }
      recoveredPaths.push(path);
    }
    if (recoveredPaths.length === 0) {
      throw new Error(`recovery packet ${inspectedPacket.relative} contributes no modified declared paths for ${task.id}`);
    }
    pathsByTask.set(task.id, [
      ...(pathsByTask.get(task.id) ?? []),
      ...recoveredPaths,
    ]);
    auditByTask.set(task.id, [
      ...(auditByTask.get(task.id) ?? []),
      Object.freeze({
        baseline_sha: baselineSha,
        packet_id: packet.packetId,
        packet_path: inspectedPacket.relative,
        modified_paths: Object.freeze([...new Set(recoveredPaths)].sort()),
      }),
    ]);
  }

  return {
    modifiedPathsByTask: new Map([...pathsByTask].map(([taskId, paths]) => [
      taskId,
      Object.freeze([...new Set(paths)].sort()),
    ])),
    auditByTask,
  };
}

function taskCompletionWasObserved(task: Task): boolean {
  const proof = task.proof;
  if (proof === undefined || proof.state === "pending") return false;
  return proof.results.some((result) =>
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
  if (task.status === "completed") return task;
  const newTestsWritten = collectedNewTests.written;
  const newTestEvidence = collectedNewTests.evidence;
  const proof = evaluateTaskProof(
    {
      verificationPolicy: taskVerificationPolicy(task),
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

export function reconciliationFailureMessage(error: unknown): string {
  if (error instanceof PostCommitStateProtectionError) {
    return `reconcile-implementation-proof committed state but failed to restore read-only protection: ${error.message}`;
  }
  return `reconcile-implementation-proof failed without changing state: ${error instanceof Error ? error.message : String(error)}`;
}

const handler: HookHandler = async (_stdin, args) => {
  let requestedWave: number | null;
  let recoveredBaselineSha: string | null;
  let packetBindings: readonly RecoveryPacketBinding[];
  try {
    requestedWave = parseWaveArg(args);
    recoveredBaselineSha = parseRecoveredBaselineSha(args);
    packetBindings = parseRecoveryPacketBindings(args);
    if (packetBindings.length > 0 && recoveredBaselineSha === null) {
      throw new Error("--packet recovery requires --baseline-sha");
    }
    if (recoveredBaselineSha !== null && packetBindings.length === 0) {
      throw new Error("--baseline-sha recovery requires at least one --packet binding");
    }
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
    } catch (error) {
      // The three failures this conflates are operator-distinguishable: an
      // unknown revision (typo), a real but unrelated commit (not an ancestor),
      // and git infrastructure failure (corrupt repo, missing binary). The
      // corrective action differs per case, so the cause must not be thrown
      // away.
      const diagnostic = error instanceof Error
        ? error.message.trim()
        : String(error);
      return {
        kind: "error",
        message: `--baseline-sha ${recoveredBaselineSha} must identify a commit that is an ancestor of HEAD${diagnostic === "" ? "" : `: ${diagnostic}`}`,
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
      const recoveredPackets = recoveredBaselineSha !== null && packetBindings.length > 0
        ? recoverPacketEvidence(root, state, wave, recoveredBaselineSha, packetBindings)
        : { modifiedPathsByTask: new Map(), auditByTask: new Map() };
      let recoveredWritesApplied = false;
      const tasks = state.tasks.map((task) => {
        if (task.wave !== wave || task.status === "completed" || task.proof?.state === "satisfied") return task;
        const recoveredPaths = recoveredPackets.modifiedPathsByTask.get(task.id) ?? [];
        // Historical recovery may alter only Tasks carrying engine-issued,
        // registration-verified packet evidence. Ordinary reconciliation has
        // no recovered baseline and re-evaluates every unresolved Task.
        if (recoveredBaselineSha !== null && recoveredPaths.length === 0) return task;
        if (recoveredPaths.length > 0) recoveredWritesApplied = true;
        const recoveredAudit = recoveredPackets.auditByTask.get(task.id) ?? [];
        const priorAudit = task.recovered_artifact_writes ?? [];
        const auditByPacket = new Map(priorAudit.map((entry) => [entry.packet_id, entry]));
        for (const entry of recoveredAudit) auditByPacket.set(entry.packet_id, entry);
        const recoveredTask: Task = {
          ...task,
          files_modified: [...new Set([...(task.files_modified ?? []), ...recoveredPaths])].sort(),
          ...(recoveredBaselineSha === null
            ? {}
            : {
                start_sha: recoveredBaselineSha,
                artifact_baseline: captureDeclaredArtifactBaselineAtRevision(
                  root,
                  recoveredBaselineSha,
                  task.file_list ?? [],
                ),
                artifact_baseline_recovered_from: recoveredBaselineSha,
              }),
          ...(auditByPacket.size > 0
            ? { recovered_artifact_writes: [...auditByPacket.values()] }
            : {}),
        };
        const sourceTask = recoveredPaths.length > 0
          ? invalidateTaskReview(recoveredTask)
          : recoveredTask;
        const snapshotChanges = changedDeclaredArtifactsSince(root, sourceTask.artifact_baseline);
        const revisionChanges = sourceTask.start_sha
          ? changedDeclaredArtifactsSinceRevision(root, sourceTask.start_sha, sourceTask.file_list ?? [])
          : [];
        const byteChanges = [...new Set([...snapshotChanges, ...revisionChanges])];
        const proofArtifactsChanged = attributedChangedArtifacts(byteChanges, sourceTask.files_modified ?? []);
        const collectedNewTests = collectNewTestEvidence(
          sourceTask.files_modified ?? [],
          taskVerificationPolicy(sourceTask).newTests,
          sourceTask.start_sha,
        );
        return reconcileTaskFromStoredEvidence(sourceTask, proofArtifactsChanged, collectedNewTests);
      });
      const resolved: TaskGraph = {
        ...state,
        tasks,
        ...(recoveredWritesApplied && state.spec_check?.wave === wave ? { spec_check: undefined } : {}),
      };
      reconciled = {
        ...resolved,
        wave_gates: {
          ...resolved.wave_gates,
          [String(wave)]: {
            ...(resolved.wave_gates[String(wave)] ?? newWaveGate()),
            impl_complete: isWaveComplete(resolved, wave),
            ...(recoveredWritesApplied ? { tests_passed: null, reviews_complete: false } : {}),
          },
        },
      };
      return reconciled;
    });
  } catch (error) {
    return { kind: "error", message: reconciliationFailureMessage(error) };
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
