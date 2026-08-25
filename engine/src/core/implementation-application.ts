import type { Task, TaskGraph, TaskTestResult } from "../types";
import { changedDeclaredArtifacts } from "./artifact-baseline";
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
import type { ProofEvaluationPolicy } from "./proof-obligations";
import { invalidateTaskReview } from "./review-output";
import { parseReviewPath, type ReviewPath } from "./review-packet";
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
  /** Exact Task-scope bytes changed, independent of transcript completeness. */
  exactTaskBytesChanged: boolean;
  /** Dirty-set delta is conservative invalidation evidence only. */
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
  repositoryDirtySetChanged: boolean;
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
): Readonly<{ ok: true; changed: readonly ReviewPath[] }> |
  Readonly<{ ok: false; errors: readonly string[] }> {
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
    ? freeze({ ok: true, changed: frozenArray(compared.value as readonly ReviewPath[]) })
    : freeze({ ok: false, errors: frozenArray(compared.errors) });
}

function unavailableReason(errors: readonly string[]): string {
  const joined = errors.join("; ").trim();
  return (joined === "" ? "Task-local byte observation is unavailable" : joined).slice(0, 4_096);
}

/**
 * Build the one engine-owned Task suite from already-observed snapshots.
 * Repository dirty-set movement is deliberately excluded from attribution and
 * suite scope; it can only force conservative review/spec/Wave invalidation.
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
  const errors = [
    ...(attempt.ok ? [] : attempt.errors),
    ...(proof.ok ? [] : proof.errors),
    ...(parserPaths.ok ? [] : parserPaths.errors),
    ...(priorPaths.ok ? [] : priorPaths.errors),
  ];
  if (errors.length > 0 || !attempt.ok || !proof.ok || !parserPaths.ok || !priorPaths.ok) {
    const reason = unavailableReason(errors);
    const suite = createTaskCompletionSuiteResult(input.authority, {
      kind: "observation-unavailable",
      reason,
    });
    if (!suite.ok) throw new Error(suite.error.errors.join("; "));
    return freeze({
      suite: suite.value,
      attributedAttemptChangedPaths: frozenArray([]),
      cumulativeModifiedPaths: priorPaths.ok ? priorPaths.value : frozenArray([]),
      cumulativeProofArtifactChanges: frozenArray([]),
      exactTaskBytesChanged: true,
      invalidationBytesChanged: true,
    });
  }

  const parsedAttemptBaseline = parseCanonicalArtifactBaseline(input.attemptBaseline);
  if (!parsedAttemptBaseline.ok) throw new Error(parsedAttemptBaseline.error.errors.join("; "));
  const allowed = new Set(parsedAttemptBaseline.value.map(({ artifact }) => artifact));
  const outside = parserPaths.value.filter((path) => !allowed.has(path));
  const insideParserPaths = parserPaths.value.filter((path) => allowed.has(path));
  const changedAttempt = new Set(attempt.changed);
  const attributedAttempt = insideParserPaths.filter((path) => changedAttempt.has(path));
  const priorAllowedPaths = priorPaths.value.filter((path) => allowed.has(path));
  const cumulative = frozenArray([...new Set([...priorAllowedPaths, ...insideParserPaths])].sort(compareStrings));
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
    exactTaskBytesChanged: attempt.changed.length > 0,
    invalidationBytesChanged: attempt.changed.length > 0 || input.repositoryDirtySetChanged,
  });
}

export function unavailableTaskLocalByteObservation(
  authority: ImplementationAttemptAuthority,
  reason: string,
): TaskLocalByteObservation {
  const suite = createTaskCompletionSuiteResult(authority, {
    kind: "observation-unavailable",
    reason: unavailableReason([reason]),
  });
  if (!suite.ok) throw new Error(suite.error.errors.join("; "));
  return freeze({
    suite: suite.value,
    attributedAttemptChangedPaths: frozenArray([]),
    cumulativeModifiedPaths: frozenArray([]),
    cumulativeProofArtifactChanges: frozenArray([]),
    exactTaskBytesChanged: true,
    invalidationBytesChanged: true,
  });
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
  newTestsWritten: boolean;
  newTestEvidence: string;
}>;

/** One preservation rule shared by Claude and Pi, without provenance relabeling. */
export function normalizeImplementationEvidence(
  task: Task,
  incoming: IncomingImplementationEvidence,
  bytes: TaskLocalByteObservation,
): NormalizedImplementationEvidence {
  const incomingUntrusted = incoming.testResult?.verdict === "untrusted";
  const preserveTrusted = task.revalidation_required !== true && incomingUntrusted && (
    task.test_result?.verdict === "trusted-fail" ||
    (task.test_result?.verdict === "trusted-pass" && !bytes.exactTaskBytesChanged)
  );
  return freeze({
    ...(preserveTrusted
      ? { testResult: task.test_result, testEvidence: task.test_evidence }
      : {
          ...(incoming.testResult === undefined ? {} : { testResult: incoming.testResult }),
          ...(incoming.testEvidence === undefined ? {} : { testEvidence: incoming.testEvidence }),
        }),
    cumulativeModifiedPaths: bytes.cumulativeModifiedPaths,
    newTestsWritten: incoming.newTestsWritten === true,
    newTestEvidence: incoming.newTestEvidence ?? "",
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
    new_tests_written: evidence.newTestsWritten,
    new_test_evidence: evidence.newTestEvidence,
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
      proof: transition.proof,
      revalidation_required: undefined,
      legacy_missing_proof: undefined,
      failure_reason: undefined,
      ...evidenceFields(facts.normalizedEvidence),
    };
  }
  if (transition.kind === "retry-required" || transition.kind === "escalation-required") {
    if (facts.normalizedEvidence === undefined) throw new Error(`${transition.kind} transition requires normalized evidence`);
    const failure_reason = `${transition.kind}: ${transitionFailureKinds(transition).join(", ")}`;
    return transition.proof.state === "satisfied"
      ? {
          ...common,
          status: "pending",
          proof: transition.proof,
          revalidation_required: true,
          legacy_missing_proof: undefined,
          failure_reason,
          ...evidenceFields(facts.normalizedEvidence),
        }
      : {
          ...common,
          status: "pending",
          proof: transition.proof,
          revalidation_required: undefined,
          legacy_missing_proof: undefined,
          failure_reason,
          ...evidenceFields(facts.normalizedEvidence),
        };
  }
  if (task.proof === undefined) throw new Error("infrastructure settlement requires historical Proof audit data");
  return {
    ...common,
    status: "pending",
    proof: task.proof,
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
  const implComplete = tasks
    .filter((task) => task.wave === target.wave)
    .every((task) => task.status === "implemented" || task.status === "completed");
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
      newTestsWritten: normalized.newTestsWritten,
      newTestEvidence: normalized.newTestEvidence,
    },
    proofEvaluationPolicy,
  });
  return observation.ok
    ? settleAndApply(state, authority, observation.value, bytes, normalized)
    : invalidObservationResult(state, observation.error.errors);
}

/** Pure shared infrastructure settlement; history is retained and no attempt is consumed. */
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
