import {
  derivePendingTaskProof,
  evaluateProofObligations,
  type TaskProof,
} from "../../src/core/proof-obligations";
import {
  parseNewTestEvidence,
  type NewTestEvidence,
  type Task,
  type TaskCommonMetadata,
  type TaskGraph,
  type TaskStatus,
} from "../../src/types";

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
  /** Legacy flat fixture input is normalized at this test-only boundary. */
  new_tests_written?: boolean;
  new_test_evidence?: string;
  new_test_observation?: NewTestEvidence;
}>;

/**
 * Canonical execute-phase TaskGraph shell: the exact literal the graph writers
 * mint for a fresh wave. Tests that need anything beyond this shape pass their
 * own full literal — bespoke fixture sites stay bespoke.
 */
export function graphFixture(tasks: readonly Task[]): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    tasks: [...tasks],
    wave_gates: {},
  };
}

/**
 * Test-only lifecycle smart constructor. It keeps old scenario builders concise
 * without making illegal Task lifecycle combinations representable in production.
 */
export function taskFixture(input: TaskFixtureInput): Task {
  const {
    status = "pending",
    proof: suppliedProof,
    revalidation_required: revalidation,
    new_tests_written: legacyNewTestsWritten,
    new_test_evidence: legacyNewTestEvidence,
    new_test_observation: suppliedNewTestObservation,
    ...baseMetadata
  } = input;
  const newTestObservation = legacyNewTestsWritten !== undefined || legacyNewTestEvidence !== undefined
    ? parseNewTestEvidence(legacyNewTestsWritten, legacyNewTestEvidence)
    : suppliedNewTestObservation;
  const metadata = {
    ...baseMetadata,
    ...(newTestObservation === undefined ? {} : { new_test_observation: newTestObservation }),
  };
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
