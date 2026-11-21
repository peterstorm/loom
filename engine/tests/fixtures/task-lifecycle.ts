import {
  derivePendingTaskProof,
  evaluateProofObligations,
  evaluateTaskProof,
  type ObservedArtifactChanges,
  type ObservedProofEvidence,
  type ObservedProofFacts,
  type RedThenGreenEra,
  type SatisfiedTaskProof,
  type TaskProof,
} from "../../src/core/proof-obligations";
import { readFileSync, writeFileSync } from "node:fs";
import type { RedThenGreenObservation } from "../../src/core/red-then-green-types";
import { labelledValue } from "./parse-result";
import { createImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { completedWaveGateEntry, type CompletedWaveGateInput } from "./accepted-wave-completion-suite";
import { preI6DefaultVerificationManifest } from "../../src/core/verification-manifest";
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
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import { isDistillTask } from "../../src/core/distill-task";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { taskArtifactExpectation } from "../../src/core/task-artifact-expectation";
import { DISTILL_VERIFICATION_POLICY, serializeVerificationPolicy, taskVerificationPolicy } from "../../src/core/verification-policy";

/*
 * Protected-state builders. Each mints its value through the production
 * State File parser instead of casting a literal past the type system, so a
 * schema change to the shape breaks the fixture at the load boundary rather
 * than leaving a test asserting against a state no engine could load.
 */

/**
 * A whole protected TaskGraph, proven by the State File wire parser. An
 * execute-phase fixture that names no `verification_manifest` is stamped with
 * the pre-I6 default, so its Proofs keep the obligations it was written for;
 * the loader itself refuses a manifest-less execute graph (ADR-0098).
 */
export function protectedGraphFixture(raw: unknown): TaskGraph {
  return labelledValue("protected TaskGraph", parseTaskGraph(withExecuteManifest(raw)));
}

/** `raw` with the pre-I6 default manifest when it is an execute-phase graph naming none. */
export function withExecuteManifest(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const graph = raw as Record<string, unknown>;
  return graph.current_phase === "execute" && graph.verification_manifest === undefined
    ? { ...graph, verification_manifest: preI6DefaultVerificationManifest() }
    : raw;
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
  return labelledValue("protected active_wave_gate", parseActiveWaveGateRegistration({
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
 *  with a completion receipt committed at the entry's own revision and the
 *  accepted completion suite it archived. */
export function completedWaveGateFixture(input: CompletedWaveGateInput): CompletedWaveGateRegistration {
  return labelledValue(
    "protected wave_gate_history entry",
    parseCompletedWaveGateRegistration(completedWaveGateEntry(input)),
  );
}

/** The I6 run a satisfied fixture shows: red run 0, then the first write to an
 *  implementation file, then green run 1. */
export function shownRedThenGreen(implementationWrite = "src/fixture.ts"): RedThenGreenObservation {
  return {
    kind: "shown",
    red: { index: 0, command: "npx vitest run" },
    implementationWrite,
    green: { index: 1, command: "npx vitest run" },
  };
}

/** Observed Proof evidence whose completion conformance defaults to
 *  `not-owed` — the judgment every Task outside a skeleton contract settles
 *  with. Pass `contractConformance` to state a different judgment. */
export function observedEvidence(
  evidence: Omit<ObservedProofFacts, "contractConformance"> & Partial<Pick<ObservedProofFacts, "contractConformance">> & ObservedArtifactChanges,
): ObservedProofEvidence {
  return { contractConformance: CONFORMANCE_NOT_OWED, ...evidence };
}

/** Observed evidence of an attempt whose scope was not restored: its changed paths, which a test may replace. */
export type UnrestoredProofEvidence = Extract<ObservedProofEvidence, { restoredAfter?: undefined }>;

/** Observed evidence for a completed Task that changed exactly `files`, with a
 *  ledger-trusted pass and new tests written; `overrides` replace any other field. */
export function trustedPassEvidence(
  files: readonly string[],
  overrides: Partial<ObservedProofFacts> = {},
): UnrestoredProofEvidence {
  return {
    contractConformance: CONFORMANCE_NOT_OWED,
    taskCompleted: true,
    testResult: { verdict: "trusted-pass" },
    filesModified: files,
    newTestsWritten: true,
    ...overrides,
  };
}

/** A satisfied Proof for a Task that changed exactly its declared files, with
 *  trusted test evidence and new tests written. A Task in an I6-era graph
 *  (`redThenGreenEra(manifest)`) also owes red-then-green, shown here. */
export function satisfiedProof(files: readonly string[], era: RedThenGreenEra = "not-owed"): SatisfiedTaskProof {
  const evaluated = evaluateTaskProof(
    { declaredArtifactExpectation: "changed", newTestsRequired: true, declaredArtifacts: files, redThenGreen: era },
    trustedPassEvidence(
      files,
      era === "owed-if-new-tests" ? { redThenGreen: shownRedThenGreen(files[0]) } : {},
    ),
  );
  if (evaluated.state !== "satisfied") throw new Error("satisfied proof fixture must be satisfied");
  return evaluated;
}

/** Canonical modern pending lifecycle fixture for tests outside Proof-specific suites. */
export function pendingTaskProof(
  declaredArtifacts: readonly string[] = [],
  newTestsRequired = true,
  era: RedThenGreenEra = "not-owed",
) {
  return derivePendingTaskProof({ declaredArtifactExpectation: "changed", newTestsRequired, declaredArtifacts, redThenGreen: era });
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
 * own full literal — bespoke fixture sites stay bespoke. It freezes the
 * pre-I6 engine default manifest: every execute-phase graph carries one, and
 * that era owes no red-then-green, so the fixture Proofs stay exact.
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
    verification_manifest: preI6DefaultVerificationManifest(),
  };
}

/**
 * The pending Proof a fixture Task carries, derived under the Task's own
 * expectation (`taskArtifactExpectation`), as population derives it. A
 * Distill Task (`agent: DISTILL_AGENT`) is derived under its engine-only
 * policy, so its Proof is exactly task-completed and behaviour-preserved; a
 * Task naming an explicit `verification_policy` is derived under that policy.
 */
function fixturePendingProof(input: TaskFixtureInput) {
  return derivePendingTaskProof({
    ...fixtureProofPolicy(input),
    declaredArtifacts: input.file_list ?? [],
    declaredArtifactExpectation: taskArtifactExpectation(input),
  });
}

/** The policy a fixture Task's pending Proof is derived under. */
function fixtureProofPolicy(input: TaskFixtureInput) {
  if (isDistillTask(input)) return { verificationPolicy: DISTILL_VERIFICATION_POLICY };
  if (input.verification_policy !== undefined) return { verificationPolicy: taskVerificationPolicy(input) };
  return { newTestsRequired: input.new_tests_required ?? true };
}

/**
 * The satisfied Proof an implemented or completed fixture Task carries when
 * the fixture supplies none: its own pending obligations, met by the evidence
 * an honest completion records (a Distill Task's untouched scope, otherwise a
 * trusted pass that changed exactly its declared files with new tests).
 */
function fixtureSatisfiedProof(input: TaskFixtureInput, pending: ReturnType<typeof fixturePendingProof>): SatisfiedTaskProof {
  const files = input.file_list ?? [];
  if (isDistillTask(input)) return satisfiedDistillProof(files);
  const evaluated = evaluateProofObligations(pending.obligations, trustedPassEvidence(files));
  if (evaluated.state !== "satisfied") throw new Error(`fixture Task ${input.id} has no satisfiable default Proof`);
  return evaluated;
}

/** The policy population stamps on a Distill Task, unless the fixture states its own. */
function distillPolicyDefault(input: TaskFixtureInput): Pick<TaskCommonMetadata, "verification_policy"> {
  return isDistillTask(input) && input.verification_policy === undefined
    ? { verification_policy: serializeVerificationPolicy(DISTILL_VERIFICATION_POLICY) }
    : {};
}

/**
 * Test-only lifecycle smart constructor. It keeps old scenario builders concise
 * without making illegal Task lifecycle combinations representable in production.
 * `taskFixture({ agent: DISTILL_AGENT, file_list: [...], ... })` yields a
 * Distill Task the State File loads.
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
    ...distillPolicyDefault(input),
    ...(newTestObservation === undefined ? {} : { new_test_observation: newTestObservation }),
  };
  const pending = fixturePendingProof(input);
  if (status === "pending") {
    const proof = suppliedProof ?? pending;
    return proof.state === "satisfied" || revalidation === true
      ? { ...metadata, status: "pending", proof, revalidation_required: true }
      : { ...metadata, status: "pending", proof };
  }
  if (status === "implemented" || status === "completed") {
    return { ...metadata, status, proof: suppliedProof?.state === "satisfied" ? suppliedProof : fixtureSatisfiedProof(input, pending) };
  }
  const evaluated = suppliedProof?.state === "failed"
    ? suppliedProof
    : evaluateProofObligations(pending.obligations, observedEvidence({ taskCompleted: false, filesModified: [] }));
  if (evaluated.state !== "failed") {
    return { ...metadata, status: "pending", proof: pending };
  }
  return { ...metadata, status: "failed", proof: evaluated };
}

/** The implementation file a fixture Task owns by default: `src/<id, lower-cased>.ts`. */
export const fileOf = (id: string): string => `src/${id.toLowerCase()}.ts`;

export type SiblingTaskFixtureInput = Readonly<{ id: string }> & Partial<Omit<TaskFixtureInput, "id">>;

/**
 * An implementer Task of the Wave a Distill Task distils: `code-implementer-agent`,
 * Wave 1, no dependencies, owning `fileOf(id)`. Pending unless `status` says
 * otherwise; a settled one carries the satisfied Proof of its `file_list`
 * unless the caller states another. `overrides` replace any field.
 */
export function siblingTaskFixture({ id, ...overrides }: SiblingTaskFixtureInput): Task {
  const file_list = overrides.file_list ?? [fileOf(id)];
  const settled = overrides.status !== undefined && overrides.status !== "pending";
  return taskFixture({
    id,
    description: id,
    agent: "code-implementer-agent",
    wave: 1,
    depends_on: [],
    ...(settled ? { proof: satisfiedProof(file_list) } : {}),
    ...overrides,
    file_list,
  });
}

/**
 * The satisfied Proof of a Distill Task whose pass left every scope path as
 * it found it: `behaviour-preserved` on the `unchanged` basis, the outcome
 * that needs no test evidence (ADR-0068 §4).
 */
export function satisfiedDistillProof(scope: readonly string[]): SatisfiedTaskProof {
  const evaluated = evaluateTaskProof(
    { verificationPolicy: DISTILL_VERIFICATION_POLICY, declaredArtifacts: scope, declaredArtifactExpectation: "preserved" },
    observedEvidence({ taskCompleted: true, filesModified: [] }),
  );
  if (evaluated.state !== "satisfied") throw new Error(`satisfied distill proof fixture is ${evaluated.state}`);
  return evaluated;
}

export type DistillTaskFixtureInput =
  & Readonly<{ id: string; wave: number; /** The Distill Scope: the Task's `file_list`. */ scope: readonly string[] }>
  & Partial<Omit<TaskFixtureInput, "id" | "wave" | "agent" | "file_list">>;

/**
 * A Wave's Distill Task as population writes it: `agent: DISTILL_AGENT`, no
 * dependencies, no Requirement trace, `file_list` = `scope`, review pending.
 * `taskFixture` derives its engine-only policy and pending Proof; a settled
 * status (`implemented`, `completed`) carries `satisfiedDistillProof` unless
 * the caller states another Proof. The one builder every Distill Task suite
 * uses, so a change to what a Distill Task is lands in one place.
 */
export function distillTaskFixture({ id, wave, scope, ...overrides }: DistillTaskFixtureInput): Task {
  const settled = overrides.status === "implemented" || overrides.status === "completed";
  return taskFixture({
    id,
    description: `Distill pass for Wave ${wave}`,
    agent: DISTILL_AGENT,
    wave,
    depends_on: [],
    file_list: [...scope],
    spec_anchors: [],
    spec_contributions: [],
    review_status: "pending",
    ...(settled ? { proof: satisfiedDistillProof(scope) } : {}),
    ...overrides,
  });
}

/**
 * A pending Task under an I6-era manifest (loom#198): `taskFixture`'s Task
 * with the Proof population derives for it there, so a graph frozen with a
 * test-file classification loads it.
 */
export function i6PendingTaskFixture(input: TaskFixtureInput): Task {
  const base = taskFixture({ ...input, status: "pending" });
  if (base.status !== "pending") throw new Error("i6PendingTaskFixture builds a pending Task");
  return {
    ...base,
    proof: derivePendingTaskProof({
      verificationPolicy: taskVerificationPolicy(base),
      declaredArtifacts: base.file_list ?? [],
      declaredArtifactExpectation: taskArtifactExpectation(base),
      redThenGreen: "owed-if-new-tests",
    }),
  };
}

/**
 * An implemented or completed Task under an I6-era manifest: the pending
 * Proof `i6PendingTaskFixture` derives, satisfied by an honest completion
 * that changed exactly its declared files with new tests, shown red then green.
 */
export function i6SatisfiedTaskFixture(input: TaskFixtureInput & Readonly<{ status: "implemented" | "completed" }>): Task {
  const pending = i6PendingTaskFixture(input);
  const files = pending.file_list ?? [];
  const proof = evaluateProofObligations(
    pending.proof.obligations,
    trustedPassEvidence(files, { redThenGreen: shownRedThenGreen(files[0]) }),
  );
  if (proof.state !== "satisfied") throw new Error(`fixture Task ${input.id} has no satisfiable I6 Proof`);
  const { revalidation_required: _revalidation, ...metadata } = pending as Task & { revalidation_required?: true };
  return { ...metadata, status: input.status, proof };
}

/**
 * `graph` with `taskIds` executing, each under its own exact implementation
 * attempt authority (the only executing shape the State File loads), proven
 * by the State File wire parser. `reservedAt` defaults to a fixed instant long
 * past, so a fixture attempt is aged unless a test reserves it now.
 */
export function executingGraphFixture(
  graph: TaskGraph,
  taskIds: readonly string[],
  reservedAt = "2026-08-24T00:00:00.000Z",
): TaskGraph {
  const tasks = graph.tasks.map((task) => {
    if (!taskIds.includes(task.id)) return task;
    // The registration scope: every declared and already-modified path, once.
    const scope = [...new Set([...(task.file_list ?? []), ...(task.files_modified ?? [])])];
    const baseline = scope.map((artifact) => ({ artifact, snapshot: { kind: "missing" as const } }));
    const authority = createImplementationAttemptAuthority({
      taskId: task.id, wave: task.wave, semanticAttempt: 1, reservationId: `fixture-${task.id}`,
      headSha: "1".repeat(40), reservedAt,
      taskScopeBaseline: baseline, dirtySetBaseline: [],
    });
    if (!authority.ok) throw new Error(authority.error.errors.join("; "));
    return {
      ...task,
      active_implementation_attempt: authority.value,
      attempt_artifact_baseline: baseline,
      attempt_repository_baseline: [],
      reserved_at: authority.value.reservedAt,
    };
  });
  return protectedGraphFixture({ ...graph, executing_tasks: [...taskIds], tasks });
}

/**
 * Re-reserves T1 of the State File at `statePath` under exact attempt
 * authority, as a live implementation attempt holds it.
 */
export function reserveLiveAttempt(statePath: string): void {
  const raw: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
  const graph = labelledValue("live-attempt State File", parseTaskGraph(raw));
  writeFileSync(statePath, JSON.stringify(executingGraphFixture(graph, ["T1"])));
}

/**
 * A raw execute-phase graph whose Wave 1 is blocked on review (implemented
 * and tested, reviews not complete), holding `tasks` exactly as given.
 */
export function reviewBlockedWaveGraph<T>(tasks: readonly T[]) {
  return {
    current_phase: "execute",
    verification_manifest: preI6DefaultVerificationManifest(),
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: false, blocked: true } },
    tasks: [...tasks],
  };
}
