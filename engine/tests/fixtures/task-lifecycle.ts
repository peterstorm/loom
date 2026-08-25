import {
  derivePendingTaskProof,
  evaluateProofObligations,
  type TaskProof,
} from "../../src/core/proof-obligations";
import type { Task, TaskCommonMetadata, TaskStatus } from "../../src/types";

/** Canonical modern pending lifecycle fixture for tests outside Proof-specific suites. */
export function pendingTaskProof(
  declaredArtifacts: readonly string[] = [],
  newTestsRequired = true,
) {
  return derivePendingTaskProof({ newTestsRequired, declaredArtifacts });
}

export type TaskFixtureInput = TaskCommonMetadata & Readonly<{
  status?: TaskStatus;
  proof?: TaskProof;
  revalidation_required?: true;
}>;

/**
 * Test-only lifecycle smart constructor. It keeps old scenario builders concise
 * without making illegal Task lifecycle combinations representable in production.
 */
export function taskFixture(input: TaskFixtureInput): Task {
  const {
    status = "pending",
    proof: suppliedProof,
    revalidation_required: revalidation,
    ...metadata
  } = input;
  const pending = pendingTaskProof(input.file_list ?? [], input.new_tests_required ?? true);
  if (status === "pending") {
    const proof = suppliedProof ?? pending;
    return proof.state === "satisfied" || revalidation === true
      ? { ...metadata, status: "pending", proof, revalidation_required: true }
      : { ...metadata, status: "pending", proof };
  }
  if (status === "implemented" || status === "completed") {
    return suppliedProof?.state === "satisfied"
      ? { ...metadata, status, proof: suppliedProof }
      : { ...metadata, status, legacy_missing_proof: true };
  }
  const evaluated = suppliedProof?.state === "failed"
    ? suppliedProof
    : evaluateProofObligations(pending.obligations, { taskCompleted: false, filesModified: [] });
  if (evaluated.state !== "failed") {
    return { ...metadata, status: "pending", proof: pending };
  }
  return { ...metadata, status: "failed", proof: evaluated };
}
