/**
 * Returning a Task to revalidation: the one reset shared by every operator
 * transition that invalidates accepted completion without discarding it — a
 * reopened completed Wave, and a Contract Revision of the bytes a claimant
 * implemented against.
 */

import { derivePendingTaskProof } from "./proof-obligations";
import { taskVerificationPolicy } from "./verification-policy";
import type { Task } from "../types";

/**
 * The Task back in protected `pending` revalidation: its accepted completion
 * and review authority are void and fresh Proof is required. Retained Findings
 * and test evidence remain active remediation/audit inputs wherever gate and
 * status projections read them; only a fresh implementation settlement clears
 * the revalidation marker. A legacy Task without Proof gets its pending Proof
 * derived from its policy and declared artifacts.
 */
export function returnToRevalidation(task: Task): Task {
  const proof = task.proof ?? derivePendingTaskProof({
    verificationPolicy: taskVerificationPolicy(task),
    declaredArtifacts: task.file_list ?? [],
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
