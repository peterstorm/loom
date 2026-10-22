import {
  NEW_TEST_EVIDENCE_NOT_WRITTEN,
  storedNewTestEvidence,
  type NewTestEvidence,
  type Task,
  type TaskGraph,
  type TaskTestResult,
} from "../types";
export { parseNewTestEvidence, type NewTestEvidence } from "../types";
import {
  DECLARED_ARTIFACT_BASELINE,
  attributedChangedArtifacts,
  changedDeclaredArtifacts,
  type DeclaredArtifactBaseline,
} from "./artifact-baseline";
import { artifactCovers } from "./path-coverage";
import {
  createTaskCompletionSuiteResult,
  parseCanonicalArtifactBaseline,
  parseImplementationObservation,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationCompletionError,
  type ImplementationCompletionFailure,
  type ImplementationCompletionTransition,
  type IsoInstant,
  type TaskCompletionSuiteResult,
} from "./implementation-completion";
import { compareStrings } from "./ordering";
import {
  deriveProofObligations,
  evaluateTaskProof,
  frozenRedThenGreenEra,
  PI_STRUCTURED_EVIDENCE_POLICY,
  type ProofEvaluationPolicy,
  type ProofObligation,
} from "./proof-obligations";
import type { RedThenGreenObservation } from "./red-then-green-types";
import { invalidateTaskReview } from "./review-output";
import { parseReviewPath, type ReviewPath } from "./review-packet";
import type { FrozenTestFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
import { taskVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const frozenArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

export type TaskLocalByteObservation = Readonly<{
  suite: TaskCompletionSuiteResult;
  /** Parser-proven paths whose bytes changed during this exact attempt. */
  attributedAttemptChangedPaths: readonly ReviewPath[];
  /** EVERY task-scope path whose bytes changed vs the attempt baseline —
   *  transcript attribution OR NOT. This is the attestation oracle: a
   *  verify-only child must leave these empty, and an unreported write is
   *  drift, never an attested pass. */
  attemptScopeChangedPaths: readonly ReviewPath[];
  /** Cumulative Task paths retained for audit/lint scope: prior attributions,
   *  this attempt's parser-proven changes, and every declared artifact whose
   *  bytes differ from the first Task baseline. */
  cumulativeModifiedPaths: readonly ReviewPath[];
  /** Declared paths whose bytes differ from the first Task baseline. */
  cumulativeProofArtifactChanges: readonly ReviewPath[];
  /** Task-scope bytes changed, or exact observation was unavailable. */
  taskBytesChangedOrUnobservable: boolean;
  /** Unowned foreign paths still different from the retained repository boundary. */
  unresolvedRepositoryPaths: readonly ReviewPath[];
  /** Task-local changes, unobservable exact bytes, or unresolved unowned foreign bytes invalidate. */
  invalidationBytesChanged: boolean;
}>;

export type TaskLocalObservationInput = Readonly<{
  authority: ImplementationAttemptAuthority;
  attemptBaseline: unknown;
  currentAttemptScope: unknown;
  proofBaseline: unknown;
  currentProofScope: unknown;
  parserModifiedPaths: readonly unknown[];
  priorAttributedPaths: readonly unknown[];
  repositoryChangedPaths: readonly unknown[];
  siblingOwnedPaths: readonly unknown[];
}>;

function parsePaths(raw: readonly unknown[], path: string):
  | Readonly<{ ok: true; value: readonly ReviewPath[] }>
  | Readonly<{ ok: false; errors: readonly string[] }> {
  const values: ReviewPath[] = [];
  const errors: string[] = [];
  raw.forEach((value, index) => {
    const parsed = parseReviewPath(value, `${path}[${index}]`);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  return errors.length === 0
    ? freeze({ ok: true, value: frozenArray([...new Set(values)].sort(compareStrings)) })
    : freeze({ ok: false, errors: frozenArray(errors) });
}

function compareExactBaselines(
  baseline: unknown,
  current: unknown,
  path: string,
): Readonly<{
  ok: true;
  baseline: readonly DeclaredArtifactBaseline[];
  changed: readonly ReviewPath[];
}> | Readonly<{ ok: false; errors: readonly string[] }> {
  // Both Task-local scopes (attempt and proof) are captured as declared-artifact
  // snapshots, so both sides parse under that one digest scheme.
  const parsedBaseline = parseCanonicalArtifactBaseline(baseline, `${path}.baseline`, DECLARED_ARTIFACT_BASELINE);
  const parsedCurrent = parseCanonicalArtifactBaseline(current, `${path}.current`, DECLARED_ARTIFACT_BASELINE);
  if (!parsedBaseline.ok || !parsedCurrent.ok) {
    return freeze({
      ok: false,
      errors: frozenArray([
        ...(parsedBaseline.ok ? [] : parsedBaseline.error.errors),
        ...(parsedCurrent.ok ? [] : parsedCurrent.error.errors),
      ]),
    });
  }
  const compared = changedDeclaredArtifacts(parsedBaseline.value, parsedCurrent.value);
  return compared.ok
    ? freeze({
        ok: true,
        baseline: parsedBaseline.value,
        changed: frozenArray(compared.value as readonly ReviewPath[]),
      })
    : freeze({ ok: false, errors: frozenArray(compared.errors) });
}

function unavailableReason(errors: readonly string[]): string {
  const joined = errors.join("; ").trim();
  return (joined === "" ? "Task-local byte observation is unavailable" : joined).slice(0, 4_096);
}

/**
 * Build the one engine-owned Task suite from already-observed snapshots.
 * Repository movement is classified against locked Wave ownership. It never
 * grants attribution: allowed paths stay Task-local, sibling paths are inert,
 * and every remaining changed path is semantic out-of-scope evidence.
 */
export function buildTaskLocalByteObservation(
  input: TaskLocalObservationInput,
): TaskLocalByteObservation {
  const attempt = compareExactBaselines(
    input.attemptBaseline,
    input.currentAttemptScope,
    "attemptScope",
  );
  const proof = compareExactBaselines(
    input.proofBaseline,
    input.currentProofScope,
    "proofScope",
  );
  const parserPaths = parsePaths(input.parserModifiedPaths, "parserModifiedPaths");
  const priorPaths = parsePaths(input.priorAttributedPaths, "priorAttributedPaths");
  const repositoryPaths = parsePaths(input.repositoryChangedPaths, "repositoryChangedPaths");
  const siblingPaths = parsePaths(input.siblingOwnedPaths, "siblingOwnedPaths");
  const errors = [
    ...(attempt.ok ? [] : attempt.errors),
    ...(proof.ok ? [] : proof.errors),
    ...(parserPaths.ok ? [] : parserPaths.errors),
    ...(priorPaths.ok ? [] : priorPaths.errors),
    ...(repositoryPaths.ok ? [] : repositoryPaths.errors),
    ...(siblingPaths.ok ? [] : siblingPaths.errors),
  ];
  if (errors.length > 0 || !attempt.ok || !proof.ok || !parserPaths.ok || !priorPaths.ok ||
      !repositoryPaths.ok || !siblingPaths.ok) {
    const reason = unavailableReason(errors);
    return unavailableTaskLocalByteObservation(
      input.authority,
      reason,
      priorPaths.ok ? priorPaths.value : frozenArray([]),
    );
  }

  const allowed = attempt.baseline.map(({ artifact }) => artifact);
  const covered = (artifacts: readonly string[], path: string) =>
    artifacts.some((artifact) => artifactCovers(artifact, path));
  // Parser authority is strict independently of repository ownership: a raw
  // transcript path outside this Task's registered scope always fails. A
  // directory artifact covers every path below it.
  const rawOutside = parserPaths.value.filter((path) => !covered(allowed, path));
  const unresolvedRepositoryPaths = frozenArray(repositoryPaths.value.filter((path) =>
    !covered(allowed, path) && !covered(siblingPaths.value, path)
  ));
  const outside = frozenArray(
    [...new Set([...rawOutside, ...unresolvedRepositoryPaths])].sort(compareStrings),
  );
  // Attribution is per declared artifact: a write below a directory artifact
  // attributes the directory, never the raw leaf path.
  const attributedAttempt = attributedChangedArtifacts(attempt.changed, parserPaths.value);
  const priorAllowedPaths = priorPaths.value.filter((path) => covered(allowed, path));
  // A declared artifact that differs from the first Task baseline is this
  // Task's own production: declared artifacts are Wave-exclusive and that
  // baseline predates every attempt. Crediting it keeps an earlier attempt's
  // bytes when their attribution was lost to an infrastructure-blocked
  // settlement, so a verify-only retry is not failed for work already done.
  const cumulative = frozenArray(
    [...new Set([...priorAllowedPaths, ...attributedAttempt, ...proof.changed])].sort(compareStrings),
  );
  const suite = createTaskCompletionSuiteResult(
    input.authority,
    outside.length > 0
      ? { kind: "out-of-scope-writes", paths: outside }
      : { kind: "accepted", changedPaths: attributedAttempt },
  );
  if (!suite.ok) throw new Error(suite.error.errors.join("; "));
  return freeze({
    suite: suite.value,
    attributedAttemptChangedPaths: frozenArray(attributedAttempt),
    attemptScopeChangedPaths: attempt.changed,
    cumulativeModifiedPaths: cumulative,
    cumulativeProofArtifactChanges: proof.changed,
    taskBytesChangedOrUnobservable: attempt.changed.length > 0,
    unresolvedRepositoryPaths,
    invalidationBytesChanged: attempt.changed.length > 0 || unresolvedRepositoryPaths.length > 0,
  });
}

export function unavailableTaskLocalByteObservation(
  authority: ImplementationAttemptAuthority,
  reason: string,
  cumulativeModifiedPaths: readonly ReviewPath[] = frozenArray([]),
): TaskLocalByteObservation {
  const suite = createTaskCompletionSuiteResult(authority, {
    kind: "observation-unavailable",
    reason: unavailableReason([reason]),
  });
  if (!suite.ok) throw new Error(suite.error.errors.join("; "));
  return freeze({
    suite: suite.value,
    attributedAttemptChangedPaths: frozenArray([]),
    attemptScopeChangedPaths: frozenArray([]),
    cumulativeModifiedPaths: frozenArray(cumulativeModifiedPaths),
    cumulativeProofArtifactChanges: frozenArray([]),
    taskBytesChangedOrUnobservable: true,
    unresolvedRepositoryPaths: frozenArray([]),
    invalidationBytesChanged: true,
  });
}

/** What an authority-free Stop resolution observed. It can preserve diagnostic
 * evidence and release only a proven legacy reservation; it never mints modern
 * completion authority. */
export type UntrustedStopResolution = Readonly<{
  taskCompleted: boolean;
  testResult: TaskTestResult;
  testEvidence: string;
  filesModified: readonly string[];
  changedDeclaredArtifacts: readonly string[];
  bytesChangedSinceAttempt: boolean;
  /** One parsed ADT, produced once at the transport boundary; core never
   *  re-coerces a boolean/string pair into evidence (type-design-analyzer-1). */
  newTests: NewTestEvidence;
}>;

export type AppliedStopResolution = Readonly<{
  state: TaskGraph;
  /** true means the target was absent/completed or lacked legacy authority. */
  skipped: boolean;
}>;

export function cumulativeModifiedPaths(
  previous: readonly string[] | undefined,
  current: readonly string[],
): string[] {
  return [...new Set([...(previous ?? []), ...current])].sort();
}

function tasksAreImplementationComplete(tasks: readonly Task[]): boolean {
  return tasks.every((task) => task.status === "implemented" || task.status === "completed");
}

/** Wave completion projection shared by both harness shells. */
export function isWaveComplete(state: TaskGraph, wave: number): boolean {
  return tasksAreImplementationComplete(state.tasks.filter((task) => task.wave === wave));
}

function applyResolvedTask(
  state: TaskGraph,
  taskId: string,
  wave: number,
  codeChanged: boolean,
  clearedExecuting: readonly string[],
  resolveTask: (task: Task) => Task,
): TaskGraph {
  const resolved: TaskGraph = {
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== taskId) return task;
      const updated = resolveTask(task);
      return codeChanged ? invalidateTaskReview(updated) : updated;
    }),
    executing_tasks: [...clearedExecuting],
  };
  const specCheckCleared = codeChanged && resolved.spec_check?.wave === wave;
  return {
    ...resolved,
    ...(specCheckCleared ? { spec_check: undefined } : {}),
    wave_gates: {
      ...resolved.wave_gates,
      [String(wave)]: {
        ...(resolved.wave_gates[String(wave)] ?? newWaveGate()),
        impl_complete: isWaveComplete(resolved, wave),
        ...(codeChanged
          ? {
              tests_passed: null,
              reviews_complete: false,
              ...(specCheckCleared ? { blocked: false } : {}),
            }
          : {}),
      },
    },
  };
}

/** Legacy-only infrastructure cleanup. Modern attempts require an exact
 * Oracle receipt and are deliberately left untouched by this capability-free
 * path. */
export function applyCompletionInfrastructureFailure(
  state: TaskGraph,
  taskId: string,
  bytesChangedSinceAttempt: boolean,
  expectedAuthority?: ImplementationAttemptAuthority,
): TaskGraph {
  const target = state.tasks.find((task) => task.id === taskId);
  if (target?.active_implementation_attempt !== undefined || expectedAuthority !== undefined) return state;
  const clearedExecuting = (state.executing_tasks ?? []).filter((id) => id !== taskId);
  if (target === undefined || target.status === "completed" || target.legacy_missing_proof === true) {
    return {
      ...state,
      executing_tasks: clearedExecuting,
      tasks: state.tasks.map((task) => task.id === taskId
        ? { ...task, reserved_at: undefined, legacy_execution_reservation: undefined }
        : task),
    };
  }
  return applyResolvedTask(
    state,
    taskId,
    target.wave,
    bytesChangedSinceAttempt,
    clearedExecuting,
    (task) => task.proof === undefined ? task : ({
      ...clearAttempt(task),
      status: "pending",
      proof: task.proof,
      revalidation_required: true,
      legacy_missing_proof: undefined,
    }),
  );
}

/** Apply one authority-free legacy Stop observation against locked state. */
export function applyUntrustedStopResolution(
  state: TaskGraph,
  taskId: string,
  resolution: UntrustedStopResolution,
  proofPolicy: ProofEvaluationPolicy = PI_STRUCTURED_EVIDENCE_POLICY,
): AppliedStopResolution {
  const executing = state.executing_tasks ?? [];
  const target = state.tasks.find((task) => task.id === taskId);
  if (!executing.includes(taskId) || target?.active_implementation_attempt !== undefined) {
    return { state, skipped: true };
  }
  const clearedExecuting = executing.filter((id) => id !== taskId);
  if (target === undefined || target.status === "completed") {
    return { state: { ...state, executing_tasks: clearedExecuting }, skipped: true };
  }
  const codeChanged = resolution.bytesChangedSinceAttempt;
  const preserveExistingTrusted = shouldPreserveTrustedEvidence(
    target,
    resolution.testResult,
    codeChanged,
  );
  const cumulativeFiles = cumulativeModifiedPaths(target.files_modified, resolution.filesModified);
  const currentNewTests = resolution.newTests;
  const proofTestResult = preserveExistingTrusted ? target.test_result : resolution.testResult;
  const proofArtifactsChanged = attributedChangedArtifacts(
    resolution.changedDeclaredArtifacts,
    cumulativeFiles,
  );
  const proof = evaluateTaskProof(
    {
      verificationPolicy: taskVerificationPolicy(target),
      declaredArtifacts: target.file_list ?? [],
      declaredArtifactExpectation: target.implementation_attestation === true ? "attested" : "changed",
    },
    {
      taskCompleted: false,
      testResult: proofTestResult,
      filesModified: proofArtifactsChanged,
      newTestsWritten: currentNewTests.written,
      newTestEvidence: currentNewTests.evidence,
    },
    proofPolicy,
  );
  return {
    skipped: false,
    state: applyResolvedTask(state, taskId, target.wave, codeChanged, clearedExecuting, (task): Task => ({
      ...task,
      status: "pending",
      proof,
      revalidation_required: true,
      legacy_missing_proof: undefined,
      test_result: proofTestResult,
      test_evidence: preserveExistingTrusted ? task.test_evidence : resolution.testEvidence,
      files_modified: cumulativeFiles,
      ...storedNewTestEvidence(currentNewTests),
    })),
  };
}

export type IncomingImplementationEvidence = Readonly<{
  taskCompleted: boolean;
  testResult?: TaskTestResult;
  testEvidence?: string;
  /** One parsed ADT when the transport carried one; absent reads as the
   *  canonical not-written observation (type-design-analyzer-1). */
  newTests?: NewTestEvidence;
  /** The I6 judgment over the attempt epoch, present exactly when the Task
   *  owes `red-then-green` and the settlement shell judged its ledger. */
  redThenGreen?: RedThenGreenObservation;
}>;

/**
 * Whether a Task owes I6 (`red-then-green`), answered once for settlement,
 * reconcile and the brief.
 *
 * The frozen Proof is authoritative: population derived its obligations from
 * the Task's era (`taskRedThenGreenEra`: the TaskGraph's frozen-manifest era,
 * or `not-owed` for an Acceptance Contract writer), and the State File load
 * refuses a Task whose stored obligations disagree with that era (INV-6), so a
 * loaded Task's obligations already carry its era. The graph era
 * (`frozenRedThenGreenEra`) decides only for a Task carrying no frozen Proof —
 * never a contract writer, whose graph froze every Proof — and otherwise supplies
 * the classification an owed Proof is judged by. Every way the two
 * could still disagree is its own named arm, never a silent "not owed":
 * - `owed` carries the frozen test-file classification the judge and the
 *   brief split the Task's `file_list` with (INV-2);
 * - `classification-unfrozen`: the Proof owes I6 but the manifest froze no
 *   classification to judge it by — an infrastructure fault, never a retry;
 * - `proof-unfrozen`: no frozen Proof, yet the era obligates this Task —
 *   nothing to settle against, so it is refused.
 */
export type RedThenGreenDuty =
  | Readonly<{ kind: "not-owed" }>
  | Readonly<{ kind: "owed"; testFiles: FrozenTestFiles }>
  | Readonly<{ kind: "classification-unfrozen"; reason: string }>
  | Readonly<{ kind: "proof-unfrozen"; reason: string }>;

const NOT_OWED: RedThenGreenDuty = freeze({ kind: "not-owed" });

const owesRedThenGreen = (obligations: readonly ProofObligation[]): boolean =>
  obligations.some(({ kind }) => kind === "red-then-green");

export function redThenGreenDuty(
  task: Task,
  manifest: FrozenVerificationManifest | undefined,
): RedThenGreenDuty {
  const era = frozenRedThenGreenEra(manifest);
  if (task.proof === undefined) {
    const eraObligations = deriveProofObligations({
      verificationPolicy: taskVerificationPolicy(task),
      declaredArtifacts: task.file_list ?? [],
      redThenGreen: era.kind,
    });
    return owesRedThenGreen(eraObligations)
      ? freeze({
          kind: "proof-unfrozen",
          reason: `${task.id} carries no frozen Proof, but its TaskGraph's I6 era owes red-then-green for a Task that requires new tests`,
        })
      : NOT_OWED;
  }
  if (!owesRedThenGreen(task.proof.obligations)) return NOT_OWED;
  // The frozen Proof has decided the duty; the era supplies the classification
  // it is judged by, and a pre-I6 era is the `classification-unfrozen` disagreement.
  return era.kind === "owed-if-new-tests"
    ? freeze({ kind: "owed", testFiles: era.testFiles })
    : freeze({
        kind: "classification-unfrozen",
        reason: `${task.id} owes red-then-green but its TaskGraph freezes no test-file classification`,
      });
}

export type NormalizedImplementationEvidence = Readonly<{
  testResult?: TaskTestResult;
  testEvidence?: string;
  cumulativeModifiedPaths: readonly ReviewPath[];
  newTests: NewTestEvidence;
}>;

function shouldPreserveTrustedEvidence(
  task: Task,
  incoming: TaskTestResult | undefined,
  bytesChangedOrUnobservable: boolean,
): boolean {
  return task.revalidation_required !== true && incoming?.verdict === "untrusted" && (
    task.test_result?.verdict === "trusted-fail" ||
    (task.test_result?.verdict === "trusted-pass" && !bytesChangedOrUnobservable)
  );
}

/** One preservation rule shared by Claude and Pi, without provenance relabeling. */
export function normalizeImplementationEvidence(
  task: Task,
  incoming: IncomingImplementationEvidence,
  bytes: TaskLocalByteObservation,
): NormalizedImplementationEvidence {
  const preserveTrusted = shouldPreserveTrustedEvidence(
    task,
    incoming.testResult,
    bytes.taskBytesChangedOrUnobservable,
  );
  return freeze({
    ...(preserveTrusted
      ? { testResult: task.test_result, testEvidence: task.test_evidence }
      : {
          ...(incoming.testResult === undefined ? {} : { testResult: incoming.testResult }),
          ...(incoming.testEvidence === undefined ? {} : { testEvidence: incoming.testEvidence }),
        }),
    cumulativeModifiedPaths: bytes.cumulativeModifiedPaths,
    newTests: incoming.newTests ?? NEW_TEST_EVIDENCE_NOT_WRITTEN,
  });
}

export type ImplementationTransitionFacts = Readonly<{
  bytes: TaskLocalByteObservation;
  normalizedEvidence?: NormalizedImplementationEvidence;
}>;

export type ImplementationTransitionApplication =
  | Readonly<{ kind: "applied"; state: TaskGraph; transition: Exclude<ImplementationCompletionTransition, { kind: "ignored" }> }>
  | Readonly<{ kind: "ignored"; state: TaskGraph; reason: "stale" | "duplicate" | "already-completed" }>;

/** How many offending paths a settlement names before it counts the rest. */
export const NAMED_SCOPE_VIOLATION_PATHS = 10;

/** One semantic failure as an operator reads it. A byte-scope violation names
 *  the paths written outside the Task's declared files, so the cause can be
 *  fixed without re-deriving it from the attempt's byte observation. */
function describeCompletionFailure(failure: ImplementationCompletionFailure): string {
  switch (failure.kind) {
    case "proof-obligation-failure":
      return failure.failure.kind;
    case "task-byte-scope-violation": {
      const named = failure.paths.slice(0, NAMED_SCOPE_VIOLATION_PATHS).join(", ");
      const unnamed = failure.paths.length - NAMED_SCOPE_VIOLATION_PATHS;
      return `${failure.kind} (outside the declared files: ${named}${unnamed > 0 ? ` and ${unnamed} more` : ""})`;
    }
  }
}

/** A settled transition as an operator reads it: its kind and, for a failed
 *  attempt, each failure's kind; a byte-scope violation also names the
 *  offending paths. Both harnesses print it and the Task's `failure_reason`
 *  stores it. */
export function describeSettlement(transition: Exclude<ImplementationCompletionTransition, { kind: "ignored" }>): string {
  switch (transition.kind) {
    case "implemented":
      return transition.kind;
    case "infrastructure-blocked":
      return `${transition.kind}: ${transition.failures.map((failure) => failure.kind).join(", ")}`;
    case "retry-required":
    case "escalation-required":
      return `${transition.kind}: ${transition.failures.map(describeCompletionFailure).join(", ")}`;
  }
}

function clearAttempt(task: Task): Task {
  return {
    ...task,
    active_implementation_attempt: undefined,
    active_implementation_context: undefined,
    attempt_artifact_baseline: undefined,
    attempt_repository_baseline: undefined,
    reserved_at: undefined,
    legacy_execution_reservation: undefined,
  };
}

function evidenceFields(evidence: NormalizedImplementationEvidence) {
  return {
    ...(evidence.testResult === undefined ? {} : { test_result: evidence.testResult }),
    ...(evidence.testEvidence === undefined ? {} : { test_evidence: evidence.testEvidence }),
    files_modified: evidence.cumulativeModifiedPaths,
    ...storedNewTestEvidence(evidence.newTests),
  };
}

/**
 * Each attempt owns the repository boundary frozen at its own spawn, so every
 * settlement retires it with its unresolved-foreign diagnostics. A retry or an
 * infrastructure-blocked settlement then re-arms an attempt that freezes a
 * FRESH boundary instead of inheriting a stale snapshot that turns every
 * unrelated repository movement between attempts into out-of-scope evidence
 * for THIS task (the wave-3 cross-task retry jam). Foreign or sibling paths
 * observed DURING an attempt still invalidate its review — only the
 * inter-attempt carry is gone, which is why Task no longer has an
 * unresolved-path field at all.
 */
const RETIRED_ATTEMPT_BOUNDARY = Object.freeze({
  repository_baseline: undefined,
});

function transitionedTask(
  task: Task,
  transition: Exclude<ImplementationCompletionTransition, { kind: "ignored" }>,
  facts: ImplementationTransitionFacts,
): Task {
  const history = [...(task.implementation_attempt_history ?? []), transition.receipt];
  const common = {
    ...clearAttempt(task),
    ...RETIRED_ATTEMPT_BOUNDARY,
    implementation_attempt_history: history,
  };
  if (transition.kind === "implemented") {
    if (facts.normalizedEvidence === undefined) throw new Error("implemented transition requires normalized evidence");
    return {
      ...common,
      status: "implemented",
      proof: transition.proof,
      revalidation_required: undefined,
      legacy_missing_proof: undefined,
      failure_reason: undefined,
      retry_count: undefined,
      ...evidenceFields(facts.normalizedEvidence),
    };
  }
  if (transition.kind === "retry-required" || transition.kind === "escalation-required") {
    if (facts.normalizedEvidence === undefined) throw new Error(`${transition.kind} transition requires normalized evidence`);
    const pending = {
      ...common,
      status: "pending" as const,
      legacy_missing_proof: undefined,
      failure_reason: describeSettlement(transition),
      retry_count: transition.kind === "retry-required" ? 1 : 2,
      ...evidenceFields(facts.normalizedEvidence),
    };
    return transition.proof.state === "satisfied"
      ? { ...pending, proof: transition.proof, revalidation_required: true }
      : { ...pending, proof: transition.proof, revalidation_required: undefined };
  }
  if (task.proof === undefined) throw new Error("infrastructure settlement requires historical Proof audit data");
  return {
    ...common,
    status: "pending",
    proof: task.proof,
    revalidation_required: true,
    legacy_missing_proof: undefined,
    failure_reason: describeSettlement(transition),
  };
}

/** Apply exactly one Oracle transition; only the matching live authority is released. */
export function applyImplementationCompletionTransition(
  state: TaskGraph,
  authority: ImplementationAttemptAuthority,
  transition: ImplementationCompletionTransition,
  facts: ImplementationTransitionFacts,
): ImplementationTransitionApplication {
  if (transition.kind === "ignored") return freeze({ kind: "ignored", state, reason: transition.reason });
  if (transition.receipt.taskId !== authority.taskId ||
      transition.receipt.reservationId !== authority.reservationId ||
      transition.receipt.authorityDigest !== authority.authorityDigest ||
      transition.receipt.semanticAttempt !== authority.semanticAttempt) {
    return freeze({ kind: "ignored", state, reason: "stale" });
  }
  const target = state.tasks.find((task) => task.id === authority.taskId);
  if (target?.implementation_attempt_history?.some((receipt) => receipt.authorityDigest === authority.authorityDigest)) {
    return freeze({ kind: "ignored", state, reason: "duplicate" });
  }
  if (target?.active_implementation_attempt?.authorityDigest !== authority.authorityDigest) {
    return freeze({ kind: "ignored", state, reason: "stale" });
  }
  let nextTask = transitionedTask(target, transition, facts);
  if (facts.bytes.invalidationBytesChanged) nextTask = invalidateTaskReview(nextTask);
  const tasks = state.tasks.map((task) => task.id === target.id ? nextTask : task);
  const specCheckCleared = facts.bytes.invalidationBytesChanged && state.spec_check?.wave === target.wave;
  const existingGate = state.wave_gates[String(target.wave)] ?? newWaveGate();
  const implComplete = tasksAreImplementationComplete(
    tasks.filter((task) => task.wave === target.wave),
  );
  const specCheck = specCheckCleared ? undefined : state.spec_check;
  const updatedGates = {
    ...state.wave_gates,
    [String(target.wave)]: {
      ...existingGate,
      impl_complete: implComplete,
      ...(facts.bytes.invalidationBytesChanged
        ? { tests_passed: null, reviews_complete: false }
        : {}),
    },
  };
  const nextState: TaskGraph = {
    ...state,
    tasks,
    executing_tasks: (state.executing_tasks ?? []).filter((taskId) => taskId !== target.id),
    ...(specCheckCleared ? { spec_check: undefined } : {}),
    wave_gates: reconcileWaveBlock(updatedGates, tasks, specCheck, target.wave),
  };
  return freeze({ kind: "applied", state: nextState, transition });
}

export type ImplementationSettlementApplicationResult =
  | ImplementationTransitionApplication
  | Readonly<{ kind: "error"; state: TaskGraph; error: ImplementationCompletionError }>;

function invalidObservationResult(
  state: TaskGraph,
  errors: readonly string[],
): ImplementationSettlementApplicationResult {
  const [head = "implementation observation is invalid", ...tail] = errors;
  return freeze({
    kind: "error",
    state,
    error: freeze({
      kind: "invalid-task",
      errors: Object.freeze([head, ...tail]) as readonly [string, ...string[]],
    }),
  });
}

function settleAndApply(
  state: TaskGraph,
  authority: ImplementationAttemptAuthority,
  observation: unknown,
  bytes: TaskLocalByteObservation,
  normalizedEvidence?: NormalizedImplementationEvidence,
): ImplementationSettlementApplicationResult {
  const task = state.tasks.find((candidate) => candidate.id === authority.taskId);
  if (task === undefined) return freeze({ kind: "ignored", state, reason: "stale" });
  const current = task.active_implementation_attempt ?? authority;
  const settled = settleImplementationAttempt(task, current, authority, observation, bytes.suite);
  if (!settled.ok) return freeze({ kind: "error", state, error: settled.error });
  return applyImplementationCompletionTransition(
    state,
    authority,
    settled.value,
    freeze({ bytes, ...(normalizedEvidence === undefined ? {} : { normalizedEvidence }) }),
  );
}

/** Pure shared Claude/Pi positive and semantic-failure settlement path. */
export function settleObservedImplementation(
  state: TaskGraph,
  authority: ImplementationAttemptAuthority,
  observedAt: IsoInstant,
  incoming: IncomingImplementationEvidence,
  proofEvaluationPolicy: ProofEvaluationPolicy,
  bytes: TaskLocalByteObservation,
): ImplementationSettlementApplicationResult {
  const task = state.tasks.find((candidate) => candidate.id === authority.taskId);
  if (task === undefined) return freeze({ kind: "ignored", state, reason: "stale" });
  const normalized = normalizeImplementationEvidence(task, incoming, bytes);
  const observation = parseImplementationObservation({
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt,
    evidence: {
      taskCompleted: incoming.taskCompleted,
      ...(normalized.testResult === undefined ? {} : { testResult: normalized.testResult }),
      // Attestation reads the raw attempt-scope byte delta, never the
      // transcript-attributed set: an unreported write must surface as drift
      // on the attested obligations, not as a clean verification.
      filesModified: task.implementation_attestation === true
        ? bytes.attemptScopeChangedPaths
        : bytes.cumulativeProofArtifactChanges,
      newTestsWritten: normalized.newTests.written,
      newTestEvidence: normalized.newTests.evidence,
      ...(incoming.redThenGreen === undefined ? {} : { redThenGreen: incoming.redThenGreen }),
    },
    proofEvaluationPolicy,
  });
  return observation.ok
    ? settleAndApply(state, authority, observation.value, bytes, normalized)
    : invalidObservationResult(state, observation.error.errors);
}

/** Pure shared infrastructure settlement. The execution reservation is
 * released and receipted, while semantic retry budget is not consumed. */
export function settleUnavailableImplementation(
  state: TaskGraph,
  authority: ImplementationAttemptAuthority,
  observedAt: IsoInstant,
  reason: string,
  bytes: TaskLocalByteObservation = unavailableTaskLocalByteObservation(authority, reason),
): ImplementationSettlementApplicationResult {
  const observation = parseImplementationObservation({
    schemaVersion: 1,
    kind: "implementation-observation-unavailable",
    observedAt,
    failure: { kind: "observation-unavailable", message: unavailableReason([reason]) },
  });
  return observation.ok
    ? settleAndApply(state, authority, observation.value, bytes)
    : invalidObservationResult(state, observation.error.errors);
}
