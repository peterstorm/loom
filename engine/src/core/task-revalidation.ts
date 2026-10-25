/**
 * Returning a Task to revalidation: the one reset shared by every operator
 * transition that invalidates accepted completion without discarding it — a
 * reopened completed Wave, a Contract Revision of the bytes a claimant
 * implemented against, and a Task reopened in the active Wave to fix a Wave
 * Gate Finding.
 */

import { derivePendingTaskProof, redThenGreenEra } from "./proof-obligations";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { taskVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";
import { retireWaveReviewAuthority } from "./wave-gate-registration";
import type { Task, TaskGraph } from "../types";

/**
 * The Task back in protected `pending` revalidation: its accepted completion
 * and review authority are void and fresh Proof is required. Retained Findings
 * and test evidence remain active remediation/audit inputs wherever gate and
 * status projections read them; only a fresh implementation settlement clears
 * the revalidation marker. A legacy Task without Proof gets its pending Proof
 * derived from its policy, its declared artifacts and its TaskGraph's I6 era
 * (`redThenGreenEra` of the graph's frozen `verificationManifest`, INV-6).
 * `verificationManifest` is required so every caller states its graph's era;
 * `undefined` means the graph has no manifest, which is the legacy era.
 */
export function returnToRevalidation(task: Task, verificationManifest: FrozenVerificationManifest | undefined): Task {
  const proof = task.proof ?? derivePendingTaskProof({
    verificationPolicy: taskVerificationPolicy(task),
    declaredArtifacts: task.file_list ?? [],
    redThenGreen: redThenGreenEra(verificationManifest),
  });
  return {
    ...task,
    status: "pending",
    proof,
    revalidation_required: true,
    legacy_missing_proof: undefined,
    review_status: "pending",
    review_generation: (task.review_generation ?? 0) + 1,
    review_run: undefined,
    accepted_review_authority: undefined,
    review_error: undefined,
    review_evidence_failures: undefined,
  };
}

/**
 * Return `taskIds` of the active `wave` to revalidation and retire the review
 * and suite authority that judged them, as one transition: the shared core of
 * a Contract Revision and a Task reopening. The Wave's review authority (an
 * abandoned run's tombstone, epoch, spec-check and suite receipt) is retired
 * first, so review evidence the run accepted is kept as Findings before each
 * named Task resets; then the gate bits that judged the Wave are cleared and
 * its block re-derived. The other Tasks of the Wave keep their status.
 *
 * A live Wave Gate is the caller's precondition to refuse:
 * `retireWaveReviewAuthority` throws on one.
 */
export function returnWaveTasksToRevalidation(graph: TaskGraph, wave: number, taskIds: readonly string[]): TaskGraph {
  const retired = retireWaveReviewAuthority(graph, wave);
  const tasks = retired.tasks.map((task) =>
    taskIds.includes(task.id) ? returnToRevalidation(task, retired.verification_manifest) : task);
  const existing = retired.wave_gates[String(wave)] ?? newWaveGate();
  const gate = {
    ...existing,
    impl_complete: taskIds.length > 0 ? false : existing.impl_complete,
    tests_passed: null,
    reviews_complete: false,
  };
  return {
    ...retired,
    tasks,
    wave_gates: reconcileWaveBlock({ ...retired.wave_gates, [String(wave)]: gate }, tasks, retired.spec_check, wave),
  };
}
