/**
 * Returning a Task to revalidation: the one reset shared by every operator
 * transition that invalidates accepted completion without discarding it — a
 * reopened completed Wave, and a Contract Revision of the bytes a claimant
 * implemented against.
 */

import { derivePendingTaskProof, redThenGreenEra } from "./proof-obligations";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { taskVerificationPolicy } from "./verification-policy";
import type { Task } from "../types";

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
