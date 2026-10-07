import {
  derivePendingTaskProof,
  evaluateProofObligations,
  type TaskProof,
} from "../../src/core/proof-obligations";
import type { ParseResult } from "../../src/machine";
import {
  parseActiveWaveGateRegistration,
  parseCompletedWaveGateRegistration,
  parseTaskGraph,
} from "../../src/state-file-wire";
import {
  parseNewTestEvidence,
  type ActiveWaveGateRegistration,
  type CompletedWaveGateRegistration,
  type NewTestEvidence,
  type Task,
  type TaskCommonMetadata,
  type TaskGraph,
  type TaskStatus,
} from "../../src/types";

/*
 * Protected-state builders. Each mints its value through the production
 * State File parser instead of casting a literal past the type system, so a
 * schema change to the shape breaks the fixture at the load boundary rather
 * than leaving a test asserting against a state no engine could load.
 */

const parsedFixture = <T>(what: string, result: ParseResult<T>): T => {
  if (!result.ok) throw new Error(`${what} fixture is not loadable protected state: ${result.error}`);
  return result.value;
};

/** A whole protected TaskGraph, proven by the State File wire parser. */
export function protectedGraphFixture(raw: unknown): TaskGraph {
  return parsedFixture("TaskGraph", parseTaskGraph(raw));
}

/** An `active_wave_gate` anchor, proven by its State File parser: live by
 *  default, at revision 0, under the `/runs` authoritative parent. */
export function activeWaveGateFixture(input: Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
  revision?: number;
  runsRoot?: string;
  terminalOutcome?: unknown;
}>): ActiveWaveGateRegistration {
  return parsedFixture("active_wave_gate", parseActiveWaveGateRegistration({
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: input.runId,
    wave: input.wave,
    authorityDigest: input.authorityDigest,
    revision: input.revision ?? 0,
    runsRoot: input.runsRoot ?? "/runs",
    terminalOutcome: input.terminalOutcome ?? null,
  }));
}

/** One completed `wave_gate_history` entry, proven by its State File parser,
 *  with a completion receipt committed at the entry's own revision. */
export function completedWaveGateFixture(input: Readonly<{
  runId: string;
  wave: number;
  authorityDigest?: string;
  revision?: number;
}>): CompletedWaveGateRegistration {
  const revision = input.revision ?? 1;
  return parsedFixture("wave_gate_history entry", parseCompletedWaveGateRegistration({
    schemaVersion: 1,
    kind: "completed-wave-gate",
    runId: input.runId,
    wave: input.wave,
    authorityDigest: input.authorityDigest ?? "d".repeat(64),
    revision,
    completionReceipt: {
      kind: "protected-wave-state-committed",
      effectId: `effect:wave-gate-complete:${input.runId}`,
      runId: input.runId,
      committedRevision: revision,
      stateDigest: "e".repeat(64),
    },
  }));
}

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
