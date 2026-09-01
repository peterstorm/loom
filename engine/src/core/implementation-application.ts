import {
  parseNewTestEvidence,
  storedNewTestEvidence,
  type NewTestEvidence,
  type Task,
  type TaskGraph,
  type TaskTestResult,
} from "../types";
export { parseNewTestEvidence, type NewTestEvidence } from "../types";
import {
  attributedChangedArtifacts,
  changedDeclaredArtifacts,
  type DeclaredArtifactBaseline,
} from "./artifact-baseline";
import {
  createTaskCompletionSuiteResult,
  parseCanonicalArtifactBaseline,
  parseImplementationObservation,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationCompletionError,
  type ImplementationCompletionTransition,
  type IsoInstant,
  type TaskCompletionSuiteResult,
} from "./implementation-completion";
import { compareStrings } from "./ordering";
import {
  evaluateTaskProof,
  PI_STRUCTURED_EVIDENCE_POLICY,
  type ProofEvaluationPolicy,
} from "./proof-obligations";
import { invalidateTaskReview } from "./review-output";
import { parseReviewPath, type ReviewPath } from "./review-packet";
import { taskVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const frozenArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

export type TaskLocalByteObservation = Readonly<{
  suite: TaskCompletionSuiteResult;
  /** Parser-proven paths whose bytes changed during this exact attempt. */
  attributedAttemptChangedPaths: readonly ReviewPath[];
  /** Parser-proven cumulative paths retained for audit/lint scope. */
  cumulativeModifiedPaths: readonly ReviewPath[];
  /** Declared paths changed from the first Task baseline and parser-attributed. */
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
  const parsedBaseline = parseCanonicalArtifactBaseline(baseline, `${path}.baseline`);
  const parsedCurrent = parseCanonicalArtifactBaseline(current, `${path}.current`);
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

  const allowed = new Set(attempt.baseline.map(({ artifact }) => artifact));
  const siblings = new Set(siblingPaths.value);
  // Parser authority is strict independently of repository ownership: a raw
  // transcript path outside this Task's registered scope always fails.
  const rawOutside = parserPaths.value.filter((path) => !allowed.has(path));
  const unresolvedRepositoryPaths = frozenArray(repositoryPaths.value.filter((path) =>
    !allowed.has(path) && !siblings.has(path)
  ));
  const outside = frozenArray(
    [...new Set([...rawOutside, ...unresolvedRepositoryPaths])].sort(compareStrings),
  );
  const insideParserPaths = parserPaths.value.filter((path) => allowed.has(path));
  const changedAttempt = new Set(attempt.changed);
  const attributedAttempt = insideParserPaths.filter((path) => changedAttempt.has(path));
  const priorAllowedPaths = priorPaths.value.filter((path) => allowed.has(path));
  const cumulative = frozenArray([...new Set([...priorAllowedPaths, ...attributedAttempt])].sort(compareStrings));
  const cumulativeSet = new Set(cumulative);
  const proofChanges = proof.changed.filter((path) => cumulativeSet.has(path));
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
    cumulativeModifiedPaths: cumulative,
    cumulativeProofArtifactChanges: frozenArray(proofChanges),
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
  newTestsWritten: boolean;
  newTestEvidence: string;
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
    return { ...state, executing_tasks: clearedExecuting };
  }
  return applyResolvedTask(
    state,
    taskId,
    target.wave,
    bytesChangedSinceAttempt,
    clearedExecuting,
    (task) => task.proof === undefined ? task : ({
      ...task,
      status: "pending",
      proof: task.proof,
      revalidation_required: true,
      legacy_missing_proof: undefined,
      active_implementation_attempt: undefined,
      active_implementation_context: undefined,
      attempt_artifact_baseline: undefined,
      attempt_repository_baseline: undefined,
      reserved_at: undefined,
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
  const currentNewTests = parseNewTestEvidence(
    resolution.newTestsWritten,
    resolution.newTestEvidence,
  );
  const proofTestResult = preserveExistingTrusted ? target.test_result : resolution.testResult;
  const proofArtifactsChanged = attributedChangedArtifacts(
    resolution.changedDeclaredArtifacts,
    cumulativeFiles,
  );
  const proof = evaluateTaskProof(
    {
      verificationPolicy: taskVerificationPolicy(target),
      declaredArtifacts: target.file_list ?? [],
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
  newTestsWritten?: boolean;
  newTestEvidence?: string;
}>;

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
    newTests: parseNewTestEvidence(incoming.newTestsWritten, incoming.newTestEvidence),
  });
}

export type ImplementationTransitionFacts = Readonly<{
  bytes: TaskLocalByteObservation;
  normalizedEvidence?: NormalizedImplementationEvidence;
}>;

export type ImplementationTransitionApplication =
  | Readonly<{ kind: "applied"; state: TaskGraph; transition: Exclude<ImplementationCompletionTransition, { kind: "ignored" }> }>
  | Readonly<{ kind: "ignored"; state: TaskGraph; reason: "stale" | "duplicate" | "already-completed" }>;

function transitionFailureKinds(transition: Exclude<ImplementationCompletionTransition, { kind: "implemented" | "ignored" }>): readonly string[] {
  if (transition.kind === "infrastructure-blocked") {
    return transition.failures.map((failure) => failure.kind);
  }
  return transition.failures.map((failure) => {
    if (failure.kind === "proof-obligation-failure") return failure.failure.kind;
    return failure.kind;
  });
}

function clearAttempt(task: Task): Omit<Task, "status" | "proof" | "revalidation_required" | "legacy_missing_proof"> {
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

function transitionedTask(
  task: Task,
  transition: Exclude<ImplementationCompletionTransition, { kind: "ignored" }>,
  facts: ImplementationTransitionFacts,
): Task {
  const history = [...(task.implementation_attempt_history ?? []), transition.receipt];
  const common = {
    ...clearAttempt(task),
    implementation_attempt_history: history,
  };
  if (transition.kind === "implemented") {
    if (facts.normalizedEvidence === undefined) throw new Error("implemented transition requires normalized evidence");
    return {
      ...common,
      status: "implemented",
      repository_baseline: undefined,
      unresolved_repository_paths: undefined,
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
    const repositoryBaseline = task.repository_baseline ?? task.attempt_repository_baseline;
    const pending = {
      ...common,
      status: "pending" as const,
      ...(repositoryBaseline === undefined ? {} : { repository_baseline: repositoryBaseline }),
      unresolved_repository_paths: facts.bytes.unresolvedRepositoryPaths.length === 0
        ? undefined
        : facts.bytes.unresolvedRepositoryPaths,
      legacy_missing_proof: undefined,
      failure_reason: `${transition.kind}: ${transitionFailureKinds(transition).join(", ")}`,
      retry_count: transition.kind === "retry-required" ? 1 : 2,
      ...evidenceFields(facts.normalizedEvidence),
    };
    return transition.proof.state === "satisfied"
      ? { ...pending, proof: transition.proof, revalidation_required: true }
      : { ...pending, proof: transition.proof, revalidation_required: undefined };
  }
  if (task.proof === undefined) throw new Error("infrastructure settlement requires historical Proof audit data");
  const byteOutcome = facts.bytes.suite.checks[0]?.outcome;
  const unresolvedRepositoryPaths = byteOutcome?.kind === "observation-unavailable"
    ? task.unresolved_repository_paths
    : facts.bytes.unresolvedRepositoryPaths;
  return {
    ...common,
    status: "pending",
    proof: task.proof,
    repository_baseline: task.repository_baseline ?? task.attempt_repository_baseline,
    unresolved_repository_paths: unresolvedRepositoryPaths === undefined || unresolvedRepositoryPaths.length === 0
      ? undefined
      : unresolvedRepositoryPaths,
    revalidation_required: true,
    legacy_missing_proof: undefined,
    failure_reason: `infrastructure-blocked: ${transitionFailureKinds(transition).join(", ")}`,
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
      filesModified: bytes.cumulativeProofArtifactChanges,
      newTestsWritten: normalized.newTests.written,
      newTestEvidence: normalized.newTests.evidence,
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
