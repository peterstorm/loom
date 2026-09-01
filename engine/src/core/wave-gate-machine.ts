import { createHash } from "node:crypto";
import { reviewedWorkspaceDrift, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import type {
  ActiveWaveGateRegistration,
  CanonicalStatusFacts,
  CompletedWaveGateRegistration,
  EngineResumeAction,
  FailedProofObligation,
  FindingCounts,
  LoomStatus,
  NextActionDecision,
  PlanModels,
  RefutationPanelNeed,
  ReviewEvidenceFailure,
  ReviewRosterGap,
  StatusReason,
  StatusTaskCounts,
  Task,
  TaskGraph,
  TestReadiness,
  WaveGateCompletionEligibility,
  WaveGateNextAction,
  WaveGateProtectedSnapshotBinding,
  WaveImplementationAction,
  WaveImplementationDispatch,
  WaveImplementationRecovery,
  WaveCompletionResultObservation,
  WaveCompletionSuiteReadiness,
  WaveWorkspaceObservation,
} from "../types";
import { newWaveGate, reconcileWaveBlock, testResultPassed } from "./wave-gate-model";
import {
  requiresNewTests,
  requiresRegression,
  taskVerificationPolicy,
} from "./verification-policy";
import type { ProofFailure } from "./proof-obligations";
import {
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  type AcceptedWaveCompletionReceipt,
  type CompletionAuthorityFailure,
  type CompletionInfrastructureFailure,
} from "./completion-suite";
import { compareStrings } from "./ordering";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
} from "./verification-manifest";
import { WAVE_REVIEW_AGENTS } from "./model-profiles";
import { deriveImplementationRetryDisposition } from "./implementation-retry";
import { staleReservationsForRosterObservation } from "./validate-task-execution";
import {
  awaitUserAction,
  blockedAction,
  canonicalRecord,
  doneAction,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseArtifactByteLength,
  parseArtifactDigest,
  parseArtifactRef,
  parseContextDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  reconcileEffectReceipt,
  terminalBlockedDiagnostic,
  type AgentRosterSlot,
  type ArtifactRef,
  type CommitProtectedWaveState,
  type DomainResult,
  type EffectIntent,
  type EffectReceipt,
  type ExternalAction,
  type InfrastructureRetryDiagnostic,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type ProtectedWaveStateCommitted,
} from "./orchestration-contract";
import {
  buildFindingBrief,
  reviewSignals,
  selectReviewLenses,
  type BriefFinding,
  type ReviewLens,
} from "./review-panel";
import {
  deriveRefutationVerifierBinding,
  parseRefutationPanelAuthority,
  type RefutationPanelAuthority,
} from "./panel-program";

// ---------------------------------------------------------------------------
// LC-1: closed Wave Gate lifecycle reducer
// ---------------------------------------------------------------------------

const waveReadinessProofs = new WeakSet<object>();

type WaveGateLifecycleCheckpoint = Readonly<{
  runId: OrchestrationRunId;
  registrationRevision: number;
  authorityDigest: import("./orchestration-contract").ArtifactDigest;
  readinessDigest: import("./orchestration-contract").ArtifactDigest;
  checkpointDigest: import("./orchestration-contract").ArtifactDigest;
}>;

export type WaveGateRecoverablePredecessor =
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "preparing" }>
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "awaiting-review-results" }>
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "awaiting-refutation" }>
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "awaiting-advisory-decision" }>
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "ready-to-complete" }>;

export type WaveGateState =
  | WaveGateRecoverablePredecessor
  | Readonly<WaveGateLifecycleCheckpoint & {
      kind: "recoverable-blocked";
      predecessor: WaveGateRecoverablePredecessor;
      diagnostic: InfrastructureRetryDiagnostic;
      expectedIntent: EffectIntent;
    }>
  | Readonly<WaveGateLifecycleCheckpoint & { kind: "done" }>
  | Readonly<WaveGateLifecycleCheckpoint & {
      kind: "terminal-blocked";
      reason: "semantic-attempt-2-rejected";
    }>;

const waveGateLifecycleProofs = new WeakSet<object>();

export type WaveGateEvent =
  | Readonly<{ kind: "preparation-published" }>
  | Readonly<{ kind: "result-accepted"; completeness: "incomplete" }>
  | Readonly<{ kind: "result-rejected"; attempt: 1 }>
  | Readonly<{ kind: "result-rejected"; attempt: 2 }>
  | Readonly<{ kind: "complete-roster-with-criticals" }>
  | Readonly<{ kind: "complete-roster-with-advisories" }>
  | Readonly<{ kind: "complete-roster-clean" }>
  | Readonly<{ kind: "advisory-decision-accepted" }>
  | Readonly<{
      kind: "completion-committed";
      readiness: WaveReadinessSnapshot;
      receipt: ProtectedWaveStateCommitted;
    }>
  | Readonly<{
      kind: "recoverable-effect-failed";
      diagnostic: InfrastructureRetryDiagnostic;
      intent: EffectIntent;
    }>
  | Readonly<{ kind: "recovery-receipt-accepted"; receipt: EffectReceipt }>;

type RecoverableEffectFailedEvent = Extract<WaveGateEvent, { kind: "recoverable-effect-failed" }>;
type EventKind<K extends WaveGateEvent["kind"]> = Extract<WaveGateEvent, { kind: K }>;

/** At concrete call sites, an event not declared from the state's LC-1 arm is unrepresentable. */
export type WaveGateEventFor<S extends WaveGateState> =
  S extends { kind: "done" | "terminal-blocked" } ? never
  : S extends { kind: "recoverable-blocked" }
    ? RecoverableEffectFailedEvent | EventKind<"recovery-receipt-accepted">
  : S extends { kind: "preparing" }
    ? RecoverableEffectFailedEvent | EventKind<"preparation-published">
  : S extends { kind: "awaiting-review-results" }
    ? RecoverableEffectFailedEvent |
      EventKind<"result-accepted"> | EventKind<"result-rejected"> |
      EventKind<"complete-roster-with-criticals"> | EventKind<"complete-roster-with-advisories"> |
      EventKind<"complete-roster-clean">
  : S extends { kind: "awaiting-refutation" }
    ? RecoverableEffectFailedEvent | EventKind<"complete-roster-with-advisories"> | EventKind<"complete-roster-clean">
  : S extends { kind: "awaiting-advisory-decision" }
    ? RecoverableEffectFailedEvent | EventKind<"advisory-decision-accepted">
  : S extends { kind: "ready-to-complete" }
    ? RecoverableEffectFailedEvent | EventKind<"completion-committed">
  : never;

export type WaveGateTransitionTarget<
  S extends WaveGateState,
  E extends WaveGateEventFor<S>,
> = E extends RecoverableEffectFailedEvent
  ? Extract<WaveGateState, { kind: "recoverable-blocked" }>
  : S extends { kind: "recoverable-blocked" }
    ? S["predecessor"]
  : S extends { kind: "preparing" }
    ? Extract<WaveGateState, { kind: "awaiting-review-results" }>
  : S extends { kind: "awaiting-review-results" }
    ? E extends Extract<WaveGateEvent, { kind: "result-rejected"; attempt: 2 }>
      ? Extract<WaveGateState, { kind: "terminal-blocked" }>
      : E extends EventKind<"complete-roster-with-criticals">
        ? Extract<WaveGateState, { kind: "awaiting-refutation" }>
        : E extends EventKind<"complete-roster-with-advisories">
          ? Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>
          : E extends EventKind<"complete-roster-clean">
            ? Extract<WaveGateState, { kind: "ready-to-complete" }>
            : Extract<WaveGateState, { kind: "awaiting-review-results" }>
  : S extends { kind: "awaiting-refutation" }
    ? E extends EventKind<"complete-roster-with-advisories">
      ? Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>
      : Extract<WaveGateState, { kind: "ready-to-complete" }>
  : S extends { kind: "awaiting-advisory-decision" }
    ? Extract<WaveGateState, { kind: "ready-to-complete" }>
  : S extends { kind: "ready-to-complete" }
    ? Extract<WaveGateState, { kind: "done" }>
  : never;

export type WaveGateTransitionError = Readonly<{
  kind: "wave-gate-transition-rejected";
  state: WaveGateState["kind"];
  event: WaveGateEvent["kind"];
  reason: "undeclared-transition" | "terminal-state" | "authority-mismatch" | "recovery-receipt-mismatch" | "completion-ineligible";
  message: string;
}>;

const transitionOk = (state: WaveGateState): DomainResult<WaveGateState, WaveGateTransitionError> =>
  canonicalRecord({ ok: true, value: state });

function transitionRejected(
  state: WaveGateState,
  event: WaveGateEvent,
  reason: WaveGateTransitionError["reason"],
  message: string,
): DomainResult<WaveGateState, WaveGateTransitionError> {
  return canonicalRecord({
    ok: false,
    error: canonicalRecord({ kind: "wave-gate-transition-rejected", state: state.kind, event: event.kind, reason, message }),
  });
}

function parseLifecycleDigest(value: string): import("./orchestration-contract").ArtifactDigest {
  const parsed = parseArtifactDigest(createHash("sha256").update(value).digest("hex"));
  if (!parsed.ok) throw new Error("internal Wave Gate lifecycle digest is invalid");
  return parsed.value;
}

function lifecycleEventIdentity(event: WaveGateEvent): string {
  switch (event.kind) {
    case "result-accepted":
      return JSON.stringify({ kind: event.kind, completeness: event.completeness });
    case "result-rejected":
      return JSON.stringify({ kind: event.kind, attempt: event.attempt });
    case "completion-committed":
      return JSON.stringify({ kind: event.kind, receipt: event.receipt });
    case "recoverable-effect-failed":
      return JSON.stringify({ kind: event.kind, diagnostic: event.diagnostic, intent: event.intent });
    case "recovery-receipt-accepted":
      return JSON.stringify({ kind: event.kind, receipt: event.receipt });
    default:
      return JSON.stringify({ kind: event.kind });
  }
}

function checkpointState<K extends WaveGateState["kind"]>(
  source: WaveGateLifecycleCheckpoint,
  kind: K,
  eventIdentity: string,
  extra: object = {},
): Extract<WaveGateState, { kind: K }> {
  const state = canonicalRecord({
    kind,
    runId: source.runId,
    registrationRevision: source.registrationRevision,
    authorityDigest: source.authorityDigest,
    readinessDigest: source.readinessDigest,
    checkpointDigest: parseLifecycleDigest(`${source.checkpointDigest}|${kind}|${eventIdentity}`),
    ...extra,
  }) as Extract<WaveGateState, { kind: K }>;
  waveGateLifecycleProofs.add(state);
  return state;
}

/** Connect LC-1 to one exact parser-derived protected readiness snapshot. A
 * run id alone is deliberately insufficient lifecycle authority. */
export function createWaveGateState(
  snapshot: WaveReadinessSnapshot,
): DomainResult<Extract<WaveGateState, { kind: "preparing" }>, Readonly<{ kind: "invalid-wave-gate-run"; message: string }>> {
  if (!waveReadinessProofs.has(snapshot) || snapshot.graph.active_wave_gate !== snapshot.registration) {
    return canonicalRecord({
      ok: false,
      error: canonicalRecord({ kind: "invalid-wave-gate-run", message: "Wave Gate lifecycle requires the exact canonical protected readiness snapshot" }),
    });
  }
  const initial = canonicalRecord({
    kind: "preparing" as const,
    runId: snapshot.registration.runId,
    registrationRevision: snapshot.registration.revision,
    authorityDigest: snapshot.registration.authorityDigest,
    readinessDigest: snapshot.readinessDigest,
    checkpointDigest: parseLifecycleDigest([
      snapshot.registration.runId,
      snapshot.registration.revision,
      snapshot.registration.authorityDigest,
      snapshot.readinessDigest,
      "preparing",
    ].join("|")),
  });
  waveGateLifecycleProofs.add(initial);
  return canonicalRecord({ ok: true, value: initial });
}

function activePredecessor(state: Exclude<WaveGateState, { kind: "done" } | { kind: "terminal-blocked" }>): WaveGateRecoverablePredecessor {
  return state.kind === "recoverable-blocked" ? state.predecessor : state;
}

type CompleteRosterDestination = Extract<
  WaveGateState,
  { kind: "awaiting-advisory-decision" | "ready-to-complete" }
>;

function completeRosterTransition(
  state: WaveGateLifecycleCheckpoint,
  event: WaveGateEvent,
): CompleteRosterDestination | null {
  if (event.kind === "complete-roster-with-advisories") {
    return checkpointState(state, "awaiting-advisory-decision", lifecycleEventIdentity(event));
  }
  if (event.kind === "complete-roster-clean") {
    return checkpointState(state, "ready-to-complete", lifecycleEventIdentity(event));
  }
  return null;
}

/**
 * Total immutable LC-1 reducer. Expected failures are values. In particular,
 * terminal states reject late input and an attempt-2 rejection can only become
 * terminal-blocked. A repeated infrastructure failure while already blocked
 * preserves the original recoverable predecessor.
 */
export function reduceWaveGate<
  S extends WaveGateState,
  E extends WaveGateEventFor<S>,
>(
  state: S,
  event: E & WaveGateEventFor<NoInfer<S>>,
): DomainResult<WaveGateTransitionTarget<S, E>, WaveGateTransitionError> {
  return replayWaveGateTransition(state, event) as
    DomainResult<WaveGateTransitionTarget<S, E>, WaveGateTransitionError>;
}

/**
 * The SAME reducer, entered with the plain unions.
 *
 * `reduceWaveGate`'s generic signature pairs each state with exactly the events
 * that state declares, which is what gives ordinary call sites their
 * compile-time transition check. A replay loop cannot satisfy it: its state and
 * its event are both runtime-varying unions. `projectWaveGateLifecycle` used to
 * force them through with `state as Extract<…, {kind:"preparing"}>` and
 * `event as never` — asserting a pairing it had not established, at the one
 * site that walks EVERY transition, and losing the failure the generic
 * signature exists to produce. This door takes the unions honestly: the
 * transition is still checked, at runtime, by the reducer's own
 * `undeclared-transition` refusal.
 */
export function replayWaveGateTransition(
  state: WaveGateState,
  event: WaveGateEvent,
): DomainResult<WaveGateState, WaveGateTransitionError> {
  if (!waveGateLifecycleProofs.has(state)) {
    return transitionRejected(state, event, "authority-mismatch", "lifecycle state is not connected to a canonical protected readiness snapshot");
  }
  if (state.kind === "done" || state.kind === "terminal-blocked") {
    return transitionRejected(state, event, "terminal-state", `${state.kind} is monotonic and rejects ${event.kind}`);
  }

  if (event.kind === "recoverable-effect-failed") {
    if (
      event.diagnostic.runId !== state.runId || event.intent.runId !== state.runId ||
      event.diagnostic.effectId !== event.intent.effectId
    ) {
      return transitionRejected(
        state,
        event,
        "authority-mismatch",
        "recoverable diagnostic and expected effect intent must belong to this exact run/effect",
      );
    }
    if (state.kind === "recoverable-blocked" && (
      state.expectedIntent.kind !== event.intent.kind ||
      state.expectedIntent.runId !== event.intent.runId ||
      state.expectedIntent.effectId !== event.intent.effectId
    )) {
      return transitionRejected(state, event, "authority-mismatch", "a repeated failure cannot replace the blocked effect intent");
    }
    return transitionOk(checkpointState(
      state,
      "recoverable-blocked",
      lifecycleEventIdentity(event),
      {
        predecessor: activePredecessor(state),
        diagnostic: event.diagnostic,
        expectedIntent: state.kind === "recoverable-blocked" ? state.expectedIntent : event.intent,
      },
    ));
  }

  if (state.kind === "recoverable-blocked") {
    if (event.kind !== "recovery-receipt-accepted") {
      return transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from recoverable-blocked`);
    }
    const reconciled = reconcileEffectReceipt(state.expectedIntent, event.receipt);
    if (!reconciled.ok) {
      return transitionRejected(
        state,
        event,
        "recovery-receipt-mismatch",
        `recovery receipt does not reconcile with the blocked ${state.expectedIntent.kind} intent: ${reconciled.error.message}`,
      );
    }
    return transitionOk(state.predecessor);
  }

  switch (state.kind) {
    case "preparing":
      return event.kind === "preparation-published"
        ? transitionOk(checkpointState(state, "awaiting-review-results", lifecycleEventIdentity(event)))
        : transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from preparing`);
    case "awaiting-review-results":
      if (event.kind === "result-accepted" && event.completeness === "incomplete") {
        return transitionOk(checkpointState(state, "awaiting-review-results", lifecycleEventIdentity(event)));
      }
      if (event.kind === "result-rejected") {
        return event.attempt === 1
          ? transitionOk(checkpointState(state, "awaiting-review-results", lifecycleEventIdentity(event)))
          : transitionOk(checkpointState(state, "terminal-blocked", lifecycleEventIdentity(event), {
              reason: "semantic-attempt-2-rejected",
            }));
      }
      if (event.kind === "complete-roster-with-criticals") {
        return transitionOk(checkpointState(state, "awaiting-refutation", lifecycleEventIdentity(event)));
      }
      {
        const complete = completeRosterTransition(state, event);
        return complete === null
          ? transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from awaiting-review-results`)
          : transitionOk(complete);
      }
    case "awaiting-refutation": {
      const complete = completeRosterTransition(state, event);
      return complete === null
        ? transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from awaiting-refutation`)
        : transitionOk(complete);
    }
    case "awaiting-advisory-decision":
      return event.kind === "advisory-decision-accepted"
        ? transitionOk(checkpointState(state, "ready-to-complete", lifecycleEventIdentity(event)))
        : transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from awaiting-advisory-decision`);
    case "ready-to-complete":
      if (event.kind !== "completion-committed") {
        return transitionRejected(state, event, "undeclared-transition", `${event.kind} is not declared from ready-to-complete`);
      }
      if (
        !waveReadinessProofs.has(event.readiness) ||
        event.readiness.registration.runId !== state.runId ||
        event.readiness.registration.revision !== state.registrationRevision ||
        event.readiness.registration.authorityDigest !== state.authorityDigest ||
        event.readiness.readinessDigest !== state.readinessDigest
      ) {
        return transitionRejected(state, event, "authority-mismatch", "completion requires the exact protected readiness snapshot connected to this lifecycle");
      }
      if (event.readiness.gateDecision.verdict.kind !== "pass") {
        return transitionRejected(state, event, "completion-ineligible", "completion readiness contains failed prerequisites");
      }
      const currentAuthority = completionAuthority(
        event.readiness.graph,
        event.readiness.registration,
        event.readiness.gateDecision,
        event.readiness.currentWaveWorkspaceObservation,
        event.readiness.currentWaveCompletionResultObservation,
      );
      if (
        currentAuthority.readinessDigest !== event.readiness.readinessDigest ||
        currentAuthority.completionIntent.effectId !== event.readiness.completionIntent.effectId
      ) {
        return transitionRejected(state, event, "authority-mismatch", "completion readiness authority drifted after proof derivation");
      }
      const reconciled = reconcileEffectReceipt(event.readiness.completionIntent, event.receipt);
      if (!reconciled.ok || reconciled.value.kind !== "protected-wave-state-committed") {
        return transitionRejected(
          state,
          event,
          "authority-mismatch",
          `completion requires the exact reconciled protected-state receipt: ${reconciled.ok ? "wrong receipt kind" : reconciled.error.message}`,
        );
      }
      return transitionOk(checkpointState(state, "done", lifecycleEventIdentity(event)));
  }
}

// ---------------------------------------------------------------------------
// Existing completion checks, now owned by the Wave Gate functional core
// ---------------------------------------------------------------------------

export type GateCheck =
  | Readonly<{ passed: true; summary: string }>
  | Readonly<{ passed: false; reason: string }>;

const pass = (summary: string): GateCheck => canonicalRecord({ passed: true, summary });
const fail = (reason: string): GateCheck => canonicalRecord({ passed: false, reason });

export function gateCheckMessage(check: GateCheck): string {
  return check.passed ? check.summary : check.reason;
}

function proofFailureMessage(failure: ProofFailure): string {
  switch (failure.kind) {
    case "declared-artifact-not-changed": return `${failure.kind}:${failure.artifact}`;
    case "untrusted-regression-tests-failed":
    case "untrusted-regression-pass": return `${failure.kind}:${failure.label}`;
    default: return failure.kind;
  }
}

function unreadyTaskMessage(task: Task): string {
  const failures = task.proof?.state === "failed"
    ? `, failures=[${task.proof.failures.map(proofFailureMessage).join(", ")}]`
    : "";
  const revalidation = task.revalidation_required === true ? ", revalidation=fresh-test-evidence-required" : "";
  return `${task.id} (status=${task.status}, proof=${task.proof?.state ?? "missing"}${revalidation}${failures})`;
}

export function checkNoExecutingTasks(tasks: readonly Task[], executingTaskIds: readonly string[]): GateCheck {
  const waveTaskIds = new Set(tasks.map((task) => task.id));
  const active = [...new Set(executingTaskIds.filter((id) => waveTaskIds.has(id)))];
  return active.length === 0
    ? pass("No wave tasks are still executing")
    : fail(`FAILED: wave tasks still executing: ${active.join(", ")} — wait for every implementation agent to stop before completing the wave`);
}

export function checkImplementationProof(tasks: readonly Task[]): GateCheck {
  const unready = tasks.filter((task) =>
    task.revalidation_required === true ||
    (task.status !== "implemented" && task.status !== "completed") || task.proof?.state !== "satisfied"
  );
  return unready.length === 0
    ? pass(`1. Implementation proof verified (${tasks.length}/${tasks.length} tasks).`)
    : fail("FAILED: Not all tasks have satisfied implementation proof.\n" +
      `  Unready: ${unready.map(unreadyTaskMessage).join(", ")}`);
}

/**
 * The shared test-readiness predicates, defined ONCE.
 *
 * The gate (`checkTestEvidence`/`checkNewTests`) and the status projection
 * (`deriveTestReadinessForTasks`) must answer "is this task test-ready?"
 * identically — a gate that blocks while status reports ready, or the reverse,
 * is a contradiction the operator has no way to resolve. They read the same
 * fields, so they read them through the same functions.
 */
const regressionExempt = (task: Task): boolean =>
  !requiresRegression(taskVerificationPolicy(task));
const newTestsExempt = (task: Task): boolean =>
  !requiresNewTests(taskVerificationPolicy(task));
const testEvidenceSatisfied = (task: Task): boolean =>
  regressionExempt(task) || testResultPassed(task.test_result);
const newTestsSatisfied = (task: Task): boolean =>
  newTestsExempt(task) || task.new_test_observation?.kind === "written";
const regressionEvidenceLine = (task: Task): string => {
  const requirement = taskVerificationPolicy(task).regression;
  return requirement.kind === "waived"
    ? `not required (verification_policy.regression waived: ${requirement.reason})`
    : (task.test_evidence ?? "evidence present");
};
const newTestEvidenceLine = (task: Task): string => {
  const requirement = taskVerificationPolicy(task).newTests;
  return requirement.kind === "waived"
    ? `not required (verification_policy.new_tests waived: ${requirement.reason})`
    : (task.new_test_observation?.evidence ?? "new tests present");
};

function checkTaskRequirement(
  tasks: readonly Task[],
  satisfied: (task: Task) => boolean,
  failure: string,
  success: string,
  evidenceLine: (task: Task) => string,
): GateCheck {
  const missing = tasks.filter((task) => !satisfied(task));
  if (missing.length > 0) {
    return fail(`${failure}\n  Missing: ${missing.map((task) => task.id).join(", ")}`);
  }
  const lines = tasks.map((task) => `     ${task.id}: ${evidenceLine(task)}`);
  return pass(`${success} (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}`);
}

export function checkTestEvidence(tasks: readonly Task[]): GateCheck {
  return checkTaskRequirement(
    tasks,
    testEvidenceSatisfied,
    "FAILED: Not all tasks have test evidence.",
    "2. Test evidence verified",
    regressionEvidenceLine,
  );
}

export function checkNewTests(tasks: readonly Task[]): GateCheck {
  return checkTaskRequirement(
    tasks,
    newTestsSatisfied,
    "FAILED: Not all tasks satisfied new-test requirement.",
    "3. New tests verified",
    newTestEvidenceLine,
  );
}

export function checkReviews(tasks: readonly Task[]): GateCheck {
  const reviewed = tasks.filter((task) => task.review_status === "passed" || task.review_status === "blocked");
  if (reviewed.length !== tasks.length) {
    const unreviewed = tasks.filter((task) => !task.review_status || task.review_status === "pending").map((task) => task.id);
    const failedReview = tasks.filter((task) => task.review_status === "evidence_capture_failed").map((task) => task.id);
    const parts = ["FAILED: Not all tasks have been reviewed."];
    if (failedReview.length > 0) parts.push(`  Evidence capture failed: ${failedReview.join(", ")}`);
    if (unreviewed.length > 0) parts.push(`  Unreviewed: ${unreviewed.join(", ")}`);
    return fail(parts.join("\n"));
  }
  return pass(`5. Reviews verified (${tasks.length}/${tasks.length} tasks):\n${tasks.map((task) => `     ${task.id}: ${task.review_status}`).join("\n")}`);
}

export function checkSpecAlignment(state: TaskGraph, wave: number): GateCheck {
  if (!state.spec_check) return fail(`FAILED: Spec alignment evidence is missing for wave ${wave}. Run /spec-check for wave ${wave}.`);
  if (state.spec_check.wave !== wave) {
    return fail(`FAILED: Spec alignment was run for wave ${state.spec_check.wave}, not ${wave}. Re-run /spec-check for wave ${wave}.`);
  }
  if (state.spec_check.verdict === "EVIDENCE_CAPTURE_FAILED") {
    return fail(`FAILED: Spec alignment evidence is unusable (verdict: ${state.spec_check.verdict}, critical_count: missing).` +
      `\n  ${state.spec_check.error}\n  Re-run /spec-check for wave ${wave}.`);
  }
  if (state.spec_check.critical_count > 0) {
    return fail(`FAILED: Spec alignment has ${state.spec_check.critical_count} critical findings.\n${state.spec_check.critical_findings.map((finding) => `  - ${finding}`).join("\n")}`);
  }
  if (state.spec_check.verdict !== "PASSED") {
    return fail(`FAILED: Spec alignment verdict is ${state.spec_check.verdict}; only PASSED with zero critical findings can advance wave ${wave}.`);
  }
  return pass("6. Spec alignment verified (verdict: PASSED).");
}

export function checkCriticalFindings(tasks: readonly Task[]): GateCheck {
  const criticalByTask = tasks.map((task) => ({
    taskId: task.id,
    findings: (task.critical_findings ?? []).filter((finding) => finding.trim() !== ""),
  }));
  const totalCritical = criticalByTask.reduce((sum, { findings }) => sum + findings.length, 0);
  if (totalCritical > 0) {
    const details = criticalByTask
      .filter(({ findings }) => findings.length > 0)
      .map(({ taskId, findings }) => `  ${taskId}: ${findings.join(", ")}`)
      .join("\n");
    return fail(`FAILED: ${totalCritical} critical code review findings.\n${details}`);
  }
  return pass("7. No critical code review findings.");
}

export type PlanModelsSource =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unreadable"; path: string; error: string }>
  | Readonly<{ kind: "loaded"; models: PlanModels }>;

export type FilePresence =
  | Readonly<{ ok: true; exists: boolean }>
  | Readonly<{ ok: false; error: string }>;

const normalizeBindingPath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "");
const lifecyclePathMatches = (taskFile: string, declared: string): boolean => {
  const task = normalizeBindingPath(taskFile);
  const model = normalizeBindingPath(declared);
  return task === model || (model.includes("/") && task.endsWith(`/${model}`));
};

export function checkLifecycleArtifacts(
  source: PlanModelsSource,
  waveTasks: readonly Task[],
  filePresence: (path: string) => FilePresence,
): GateCheck {
  if (source.kind === "none") {
    return fail("FAILED: plan file is missing — cannot verify Lifecycle Machine artifacts (fail-closed).");
  }
  if (source.kind === "unreadable") {
    return fail(`FAILED: plan file '${source.path}' is unreadable — cannot verify lifecycle machine artifacts (fail-closed): ${source.error}`);
  }
  const waveFiles = waveTasks.flatMap((task) => task.file_list ?? []);
  const bound = source.models.lifecycles.flatMap((lifecycle) => {
    const machineFile = lifecycle.machineFile;
    return machineFile !== null && waveFiles.some((file) => lifecyclePathMatches(file, machineFile))
      ? [{ lifecycle, machineFile }]
      : [];
  });
  if (bound.length === 0) return pass("8. Lifecycle artifacts: none bound to this wave.");
  const observed = bound.map(({ lifecycle, machineFile }) => {
    const variants = [...new Set([
      machineFile,
      ...waveFiles.filter((file) => lifecyclePathMatches(file, machineFile)),
    ])];
    return { lifecycle, machineFile, variants: variants.map((path) => ({ path, presence: filePresence(path) })) };
  });
  const unresolved = observed.filter(({ variants }) =>
    !variants.some(({ presence }) => presence.ok && presence.exists)
  );
  const unavailable = unresolved.flatMap(({ lifecycle, variants }) =>
    variants.flatMap(({ path, presence }) => presence.ok ? [] : [{ lifecycle, path, error: presence.error }])
  );
  if (unavailable.length > 0) {
    return fail("FAILED: lifecycle machine artifact presence is unavailable (fail-closed):\n" +
      unavailable.map(({ lifecycle, path, error }) => `  ${lifecycle.id}: ${path}: ${error}`).join("\n"));
  }
  if (unresolved.length > 0) {
    return fail("FAILED: lifecycle machine files declared in the plan were not created by this wave:\n" +
      unresolved.map(({ lifecycle, machineFile }) => `  ${lifecycle.id}: ${machineFile}`).join("\n"));
  }
  return pass(`8. Lifecycle artifacts verified (${bound.length}):\n` +
    bound.map(({ lifecycle, machineFile }) => `     ${lifecycle.id}: ${machineFile}`).join("\n"));
}

export type ImplementationReservationStatusObservation =
  | Readonly<{ kind: "observed"; observedAtMs: number; anyActiveForGraph: boolean }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export interface GateDeps {
  readonly loadPlanModels: (planFile: string | null | undefined) => PlanModelsSource;
  readonly filePresence: (path: string) => FilePresence;
  /** Shell observation of current declared bytes. Required whenever accepted
   * packet authority exists; omitted observations fail closed. */
  readonly reviewedWorkspace?: (tasks: readonly Task[]) => readonly ReviewedWorkspaceObservation[];
  /** Shell-supplied current Wave workspace observation. The functional core
   * compares it with suite authority and performs no repository I/O. */
  readonly currentWaveWorkspace?: WaveWorkspaceObservation;
  /** Shell-supplied persisted result observation, separate from workspace
   * authority so absence cannot be confused with an unreadable artifact. */
  readonly currentWaveCompletionResult?: WaveCompletionResultObservation;
  /** Shell observation used only to make policy-expired reservations
   * dispatchable again. Absence/unavailability keeps them active fail-closed. */
  readonly implementationReservations?: ImplementationReservationStatusObservation;
}

function exactCompletionSuiteError(
  registration: ActiveWaveGateRegistration,
  receipt: AcceptedWaveCompletionReceipt,
  graph: TaskGraph,
): string | null {
  const parsed = parseAcceptedWaveCompletionReceipt(receipt);
  if (!parsed.ok) return parsed.error.errors.join("; ");
  if (
    parsed.value.runId !== registration.runId || parsed.value.wave !== registration.wave ||
    parsed.value.revision !== registration.revision ||
    parsed.value.authorityDigest !== registration.authorityDigest
  ) {
    return "accepted suite does not match the active Wave Gate run/Wave/revision/authority";
  }
  const manifest = graph.verification_manifest ?? defaultVerificationManifest();
  if (parsed.value.manifestDigest !== manifest.manifestDigest) {
    return "accepted suite manifest digest does not match protected verification_manifest";
  }
  const authorized = authorizeWaveCompletionSuite(manifest, registration, parsed.value.workspaceDigest);
  if (!authorized.ok) return authorized.error.errors.join("; ");
  if (parsed.value.manifestDigest !== authorized.value.manifestDigest ||
      parsed.value.suiteDigest !== authorized.value.suiteDigest ||
      parsed.value.checks.length !== authorized.value.checks.length) {
    return "accepted suite does not match the exact protected completion roster";
  }
  for (let index = 0; index < authorized.value.checks.length; index += 1) {
    const expected = authorized.value.checks[index]!;
    const actual = parsed.value.checks[index]!;
    if (actual.checkId !== expected.checkId || actual.scope !== expected.scope) {
      return "accepted suite does not match the exact protected completion roster";
    }
    if (actual.outcome.kind !== "observed") return `accepted suite check ${actual.checkId} is not observed`;
    const reportMatches = expected.reportPolicy.kind === "not-required"
      ? actual.outcome.report.kind === "not-required"
      : actual.outcome.report.kind === "produced" && actual.outcome.report.path === expected.reportPolicy.path;
    if (!reportMatches) return `accepted suite check ${actual.checkId} contradicts its report policy`;
  }
  return null;
}

type CompletionSuiteReadinessSource = Readonly<{
  receipt: AcceptedWaveCompletionReceipt | undefined;
  registration: ActiveWaveGateRegistration | CompletedWaveGateRegistration | undefined;
  legacyHistory: boolean;
  terminal: boolean;
}>;

function completionSuiteReadinessSource(
  graph: TaskGraph,
  wave: number | null,
): CompletionSuiteReadinessSource {
  if (graph.active_wave_gate !== undefined && (wave === null || graph.active_wave_gate.wave === wave)) {
    return canonicalRecord({
      receipt: graph.active_wave_completion_suite,
      registration: graph.active_wave_gate,
      legacyHistory: false,
      terminal: false,
    });
  }
  const terminal = wave === null ? undefined : (graph.wave_gate_history ?? []).find((entry) => entry.wave === wave);
  return terminal?.schemaVersion === 2
    ? canonicalRecord({ receipt: terminal.completionSuite, registration: terminal, legacyHistory: false, terminal: true })
    : canonicalRecord({
        receipt: undefined,
        registration: terminal,
        legacyHistory: terminal?.schemaVersion === 1,
        terminal: terminal !== undefined,
      });
}

function sortedUniqueNonEmpty<T extends string>(head: T, tail: readonly T[]): NonEmpty<T> {
  const [first, ...rest] = [...new Set([head, ...tail])].sort(compareStrings);
  if (first === undefined) throw new Error("non-empty completion failure set became empty");
  return Object.freeze([first, ...rest]);
}

function completionEvaluationFailureDetail(
  authorityFailures: readonly CompletionAuthorityFailure[],
  infrastructureFailures: readonly CompletionInfrastructureFailure[],
): string {
  const kinds = [
    ...authorityFailures.map((failure) => failure.kind),
    ...infrastructureFailures.map((failure) => failure.kind),
  ].sort(compareStrings);
  return `persisted completion result is invalid for current authority: ${kinds.join(", ")}`;
}

type RequiredWaveCompletionSuite = Extract<WaveCompletionSuiteReadiness, { kind: "required" }>;

function requiredWaveCompletionSuite(
  reason: RequiredWaveCompletionSuite["reason"],
  detail: string,
  verificationManifestDigest: RequiredWaveCompletionSuite["verificationManifestDigest"],
  acceptedResultDigest: RequiredWaveCompletionSuite["acceptedResultDigest"] = null,
): RequiredWaveCompletionSuite {
  return canonicalRecord({
    kind: "required",
    reason,
    detail,
    verificationManifestDigest,
    acceptedResultDigest,
  });
}

function parseWorkspaceObservation(
  currentWorkspace: WaveWorkspaceObservation | undefined,
  manifestDigest: RequiredWaveCompletionSuite["verificationManifestDigest"],
  acceptedResultDigest: RequiredWaveCompletionSuite["acceptedResultDigest"] = null,
): DomainResult<Extract<WaveWorkspaceObservation, { kind: "observed" }>, RequiredWaveCompletionSuite> {
  if (currentWorkspace === undefined) {
    return canonicalRecord({
      ok: false,
      error: requiredWaveCompletionSuite(
        "workspace-observation-missing",
        "current Wave workspace observation is missing",
        manifestDigest,
        acceptedResultDigest,
      ),
    });
  }
  return currentWorkspace.kind === "unavailable"
    ? canonicalRecord({
        ok: false,
        error: requiredWaveCompletionSuite(
          "workspace-observation-unavailable",
          currentWorkspace.reason,
          manifestDigest,
          acceptedResultDigest,
        ),
      })
    : canonicalRecord({ ok: true, value: currentWorkspace });
}

/** Pure canonical status for active or terminal Wave completion-suite evidence. */
export function deriveWaveCompletionSuiteReadiness(
  graph: TaskGraph,
  wave: number | null,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined = undefined,
): WaveCompletionSuiteReadiness {
  const source = completionSuiteReadinessSource(graph, wave);
  const manifest = graph.verification_manifest;
  const manifestDigest = manifest?.manifestDigest ?? null;
  if (source.receipt === undefined) {
    if ((manifestDigest === null && graph.active_wave_completion_suite === undefined) || source.legacyHistory) {
      return canonicalRecord({ kind: "legacy-unavailable", verificationManifestDigest: null });
    }
    if (source.registration?.kind !== "active-wave-gate" || manifest === undefined) {
      return requiredWaveCompletionSuite(
        "accepted-suite-missing",
        "an exact accepted Wave completion suite is required",
        manifestDigest,
      );
    }
    const workspace = parseWorkspaceObservation(currentWorkspace, manifestDigest);
    if (!workspace.ok) return workspace.error;
    if (currentResult === undefined || currentResult.kind === "absent") {
      return requiredWaveCompletionSuite(
        "accepted-suite-missing",
        "an exact accepted Wave completion suite is required",
        manifestDigest,
      );
    }
    if (currentResult.kind === "unavailable") {
      return requiredWaveCompletionSuite(
        "completion-result-unavailable",
        currentResult.reason,
        manifestDigest,
      );
    }
    const authorized = authorizeWaveCompletionSuite(
      manifest,
      source.registration,
      workspace.value.workspaceDigest,
    );
    if (!authorized.ok) {
      return requiredWaveCompletionSuite(
        "completion-result-invalid",
        authorized.error.errors.join("; "),
        manifestDigest,
      );
    }
    const evaluation = evaluateWaveCompletionSuite(authorized.value, currentResult.result);
    if (evaluation.kind === "accepted") {
      return requiredWaveCompletionSuite(
        "accepted-suite-missing",
        "persisted completion result is accepted; protected receipt recovery required",
        manifestDigest,
      );
    }
    const firstSemanticFailure = evaluation.semanticFailures[0];
    if (evaluation.authorityFailures.length > 0 || evaluation.infrastructureFailures.length > 0 ||
        firstSemanticFailure === undefined) {
      return requiredWaveCompletionSuite(
        "completion-result-invalid",
        completionEvaluationFailureDetail(
          evaluation.authorityFailures,
          evaluation.infrastructureFailures,
        ),
        manifestDigest,
      );
    }
    const remainingSemanticFailures = evaluation.semanticFailures.slice(1);
    const failureKinds = sortedUniqueNonEmpty(
      firstSemanticFailure.kind,
      remainingSemanticFailures.map((failure) => failure.kind),
    );
    const checkIds = sortedUniqueNonEmpty(
      firstSemanticFailure.checkId,
      remainingSemanticFailures.map((failure) => failure.checkId),
    );
    return canonicalRecord({
      kind: "rejected",
      verificationManifestDigest: manifest.manifestDigest,
      suiteDigest: authorized.value.suiteDigest,
      workspaceDigest: authorized.value.workspaceDigest,
      failureKinds: Object.freeze(failureKinds),
      checkIds: Object.freeze(checkIds),
    });
  }
  if (source.registration === undefined) {
    return requiredWaveCompletionSuite(
      "accepted-suite-invalid",
      "accepted Wave completion suite has no active or terminal registration authority",
      manifestDigest,
      source.receipt.resultDigest,
    );
  }
  if (source.registration.kind === "active-wave-gate") {
    const exactError = exactCompletionSuiteError(source.registration, source.receipt, graph);
    if (exactError !== null) {
      return requiredWaveCompletionSuite(
        "accepted-suite-invalid",
        exactError,
        manifestDigest,
        source.receipt.resultDigest,
      );
    }
  }
  if (source.terminal) {
    return canonicalRecord({
      kind: "accepted",
      verificationManifestDigest: source.receipt.manifestDigest,
      suiteDigest: source.receipt.suiteDigest,
      resultDigest: source.receipt.resultDigest,
      workspaceDigest: source.receipt.workspaceDigest,
      checkCount: source.receipt.checks.length,
    });
  }
  const workspace = parseWorkspaceObservation(
    currentWorkspace,
    manifestDigest,
    source.receipt.resultDigest,
  );
  if (!workspace.ok) return workspace.error;
  if (workspace.value.workspaceDigest !== source.receipt.workspaceDigest) {
    return canonicalRecord({
      kind: "stale",
      verificationManifestDigest: manifestDigest,
      suiteDigest: source.receipt.suiteDigest,
      resultDigest: source.receipt.resultDigest,
      acceptedWorkspaceDigest: source.receipt.workspaceDigest,
      currentWorkspaceDigest: workspace.value.workspaceDigest,
      checkCount: source.receipt.checks.length,
    });
  }
  return canonicalRecord({
    kind: "accepted",
    verificationManifestDigest: manifestDigest,
    suiteDigest: source.receipt.suiteDigest,
    resultDigest: source.receipt.resultDigest,
    workspaceDigest: source.receipt.workspaceDigest,
    checkCount: source.receipt.checks.length,
  });
}

export function checkWaveCompletionSuite(
  state: TaskGraph,
  wave: number,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined = undefined,
): GateCheck {
  const readiness = deriveWaveCompletionSuiteReadiness(state, wave, currentWorkspace, currentResult);
  switch (readiness.kind) {
    case "legacy-unavailable":
      return pass("4. Wave completion suite: legacy-unavailable (verification_manifest and active receipt absent).");
    case "required":
      return fail(`FAILED: Wave completion suite required (${readiness.reason}): ${readiness.detail}.`);
    case "rejected":
      return fail(
        `FAILED: Wave completion suite rejected (${readiness.failureKinds.join(", ")}): ` +
        `${readiness.checkIds.join(", ")}.`,
      );
    case "stale":
      return fail(
        "FAILED: accepted Wave completion suite is stale: " +
        `accepted workspace ${readiness.acceptedWorkspaceDigest}, current workspace ${readiness.currentWorkspaceDigest}.`,
      );
    case "accepted":
      return pass(
        `4. Wave completion suite accepted (${readiness.checkCount} checks; ` +
        `result ${readiness.resultDigest}; workspace ${readiness.workspaceDigest}).`,
      );
  }
}

export function checkReviewedWorkspace(tasks: readonly Task[], deps: GateDeps): GateCheck {
  if (!tasks.some((task) => task.accepted_review_authority !== undefined)) {
    // Pre-integrity historical packets have no byte snapshot authority to
    // compare. New engine-owned Wave packets always retain one on acceptance.
    return pass("9. Review Packet workspace integrity: legacy packet authority unavailable.");
  }
  if (deps.reviewedWorkspace === undefined) {
    return fail("FAILED: Review Packet workspace integrity cannot be observed; refresh review evidence after restoring repository access.");
  }
  try {
    const drift = reviewedWorkspaceDrift(tasks, deps.reviewedWorkspace(tasks));
    return drift.length === 0
      ? pass(`9. Review Packet workspace integrity verified (${tasks.length}/${tasks.length} tasks).`)
      : fail(`FAILED: accepted Review Packet authority is stale:\n  ${drift.join("\n  ")}\n  Protected block: rerun the Wave Gate review batch to refresh evidence.`);
  } catch (error) {
    return fail(`FAILED: Review Packet workspace integrity could not be proven (fail-closed): ${error instanceof Error ? error.message : String(error)}. Refresh review evidence after correcting the repository path.`);
  }
}

export type AdvisoryApprovalObservation =
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "not-approved" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Shell-supplied observation of the active registration's authoritative Run
 * Directory. Core never performs filesystem I/O; status consumes this proof
 * before it describes a registered run as resumable. */
export type ActiveRunDirectoryObservation =
  | Readonly<{ kind: "unverified" }>
  | Readonly<{
      kind: "present";
      runId: string;
      path: string;
      /** Event-log evidence for this run's exact advisory request. Absent only
       * for compatibility callers, where it reads as not approved. */
      advisoryApproval?: AdvisoryApprovalObservation;
    }>
  | Readonly<{ kind: "absent"; runId: string; path: string }>
  | Readonly<{ kind: "invalid"; runId: string; path: string; message: string }>;

export interface GateDecision {
  readonly wave: number;
  readonly checks: readonly GateCheck[];
  readonly verdict:
    | Readonly<{ kind: "fail"; reason: string }>
    | Readonly<{ kind: "pass"; taskIds: readonly string[]; nextWave: number | null }>;
}

export function computeNextWave(tasks: readonly Task[], currentWave: number): number | null {
  const waves = [...new Set(tasks.map((task) => task.wave))].sort((left, right) => left - right);
  return waves.find((wave) => wave > currentWave) ?? null;
}

type WaveGateAuthorityCheck = Readonly<{
  wave: number;
  failures: readonly string[];
}>;

function waveGateAuthorityCheck(state: TaskGraph, waveArg: number | null): WaveGateAuthorityCheck {
  const currentWave = state.current_wave;
  const registration = state.active_wave_gate;
  const requestedWave = waveArg ?? currentWave;
  const failures: string[] = [];
  if (state.current_phase !== "execute") failures.push(`current Phase is ${state.current_phase}, not execute`);
  if (currentWave === undefined) failures.push("protected current_wave authority is missing");
  if (registration === undefined) failures.push("active Wave Gate registration is missing; explicitly register or migrate legacy authority first");
  if (registration?.terminalOutcome !== null && registration !== undefined) {
    failures.push(`active Wave Gate run ${registration.runId} is terminal and must be archived before another completion`);
  }
  if (requestedWave === undefined) failures.push("no Wave was selected by protected authority");
  if (waveArg !== null && currentWave !== undefined && waveArg !== currentWave) {
    failures.push(`requested wave ${waveArg} does not match protected current_wave ${currentWave}`);
  }
  if (registration !== undefined && currentWave !== undefined && registration.wave !== currentWave) {
    failures.push(`active Wave Gate wave ${registration.wave} does not match protected current_wave ${currentWave}`);
  }
  if (registration !== undefined && requestedWave !== undefined && registration.wave !== requestedWave) {
    failures.push(`active Wave Gate wave ${registration.wave} does not authorize requested wave ${requestedWave}`);
  }
  return canonicalRecord({ wave: requestedWave ?? 0, failures: Object.freeze(failures) });
}

function failedGateDecision(wave: number, checks: readonly GateCheck[], reason: string): GateDecision {
  return canonicalRecord({ wave, checks, verdict: canonicalRecord({ kind: "fail", reason }) });
}

function waveGateChecks(state: TaskGraph, wave: number, waveTasks: readonly Task[], deps: GateDeps): readonly GateCheck[] {
  return Object.freeze([
    checkNoExecutingTasks(waveTasks, state.executing_tasks ?? []),
    checkImplementationProof(waveTasks),
    checkTestEvidence(waveTasks),
    checkNewTests(waveTasks),
    checkWaveCompletionSuite(
      state,
      wave,
      deps.currentWaveWorkspace,
      deps.currentWaveCompletionResult,
    ),
    checkReviews(waveTasks),
    checkSpecAlignment(state, wave),
    checkCriticalFindings(waveTasks),
    checkLifecycleArtifacts(deps.loadPlanModels(state.plan_file ?? state.phase_artifacts?.architecture), waveTasks, deps.filePresence),
    checkReviewedWorkspace(waveTasks, deps),
  ]);
}

function passedGateDecision(state: TaskGraph, wave: number, checks: readonly GateCheck[], waveTasks: readonly Task[]): GateDecision {
  return canonicalRecord({
    wave,
    checks,
    verdict: canonicalRecord({ kind: "pass", taskIds: Object.freeze(waveTasks.map((task) => task.id)), nextWave: computeNextWave(state.tasks, wave) }),
  });
}

export function evaluateWaveGate(state: TaskGraph, waveArg: number | null, deps: GateDeps): GateDecision {
  const authority = waveGateAuthorityCheck(state, waveArg);
  if (authority.failures.length > 0) {
    return failedGateDecision(
      authority.wave,
      Object.freeze([]),
      `FAILED: Wave Gate authority unavailable or contradictory:\n  - ${authority.failures.join("\n  - ")}`,
    );
  }
  const waveTasks = state.tasks.filter((task) => task.wave === authority.wave);
  if (waveTasks.length === 0) {
    return failedGateDecision(
      authority.wave,
      Object.freeze([]),
      `FAILED: wave ${authority.wave} has no tasks — nothing to gate (wrong --wave or unpopulated task graph?)`,
    );
  }
  const checks = waveGateChecks(state, authority.wave, waveTasks, deps);
  const failed = checks.find((check): check is Extract<GateCheck, { passed: false }> => !check.passed);
  return failed === undefined
    ? passedGateDecision(state, authority.wave, checks, waveTasks)
    : failedGateDecision(authority.wave, checks, failed.reason);
}

export function applyGateDecision(state: TaskGraph, decision: GateDecision): TaskGraph {
  if (
    decision.verdict.kind !== "pass" || state.current_wave !== decision.wave ||
    state.active_wave_gate === undefined || state.active_wave_gate.wave !== decision.wave ||
    state.active_wave_gate.terminalOutcome !== null
  ) return state;
  const defaultGate = newWaveGate();
  const clearedTasks = state.tasks.map((task): Task => {
    if (task.wave !== decision.wave || task.status === "completed") return task;
    if (task.status !== "implemented" || task.proof?.state !== "satisfied") return task;
    return {
      ...task,
      status: "completed",
      proof: task.proof,
      legacy_missing_proof: undefined,
      review_status: "passed",
    };
  });
  // `blocked` is DERIVED, never asserted. `wave-gate-model`'s `waveHasBlockCause`
  // is documented as the only copy of the rule every writer computes from, and a
  // literal `blocked: false` here was the writer that made that false. On a pass
  // verdict `checkCriticalFindings` and `checkSpecAlignment` have already proven
  // there is no cause, so re-deriving cannot change the outcome — it removes the
  // second, drifting copy of the rule rather than the behaviour.
  const gatesAfterDecision = reconcileWaveBlock(
    {
      ...state.wave_gates,
      [String(decision.wave)]: {
        ...(state.wave_gates[String(decision.wave)] ?? defaultGate),
        impl_complete: true,
        tests_passed: true,
        reviews_complete: true,
      },
      ...(decision.verdict.nextWave === null ? {} : {
        [String(decision.verdict.nextWave)]: { ...(state.wave_gates[String(decision.verdict.nextWave)] ?? defaultGate) },
      }),
    },
    clearedTasks,
    state.spec_check,
    decision.wave,
  );
  return {
    ...state,
    tasks: clearedTasks,
    wave_gates: gatesAfterDecision,
    ...(decision.verdict.nextWave === null ? {} : { current_wave: decision.verdict.nextWave }),
    wave_review_epoch: undefined,
  };
}

// ---------------------------------------------------------------------------
// One canonical readiness/status projection
// ---------------------------------------------------------------------------

export type WaveReadinessSnapshot = Readonly<{
  graph: TaskGraph;
  registration: ActiveWaveGateRegistration;
  wave: number;
  waveTasks: readonly Task[];
  gateDecision: GateDecision;
  facts: CanonicalStatusFacts;
  readinessDigest: import("./orchestration-contract").ArtifactDigest;
  completionIntent: CommitProtectedWaveState;
  nextActionAuthority: WaveGateNextAction | null;
  lifecycleCheckpointDigest: import("./orchestration-contract").ArtifactDigest | null;
  currentWaveWorkspaceObservation: WaveWorkspaceObservation | null;
  currentWaveCompletionResultObservation: WaveCompletionResultObservation | null;
  reasons: NonEmpty<StatusReason>;
}>;

const waveNextActionProofs = new WeakSet<object>();

export type WaveGateNextActionError = Readonly<{
  kind: "wave-gate-next-action-rejected";
  message: string;
}>;

function lifecycleCheckpointIdentityIsExact(
  state: WaveGateState,
  registration: ActiveWaveGateRegistration,
  readinessDigest: WaveReadinessSnapshot["readinessDigest"],
): boolean {
  return waveGateLifecycleProofs.has(state) &&
    state.runId === registration.runId &&
    state.registrationRevision === registration.revision &&
    state.authorityDigest === registration.authorityDigest &&
    state.readinessDigest === readinessDigest;
}

function lifecycleMatchesSnapshot(state: WaveGateState, snapshot: WaveReadinessSnapshot): boolean {
  return waveReadinessProofs.has(snapshot) &&
    snapshot.graph.active_wave_gate === snapshot.registration &&
    lifecycleCheckpointIdentityIsExact(state, snapshot.registration, snapshot.readinessDigest);
}

function nextActionProofIdentityIsExact(
  proof: WaveGateNextAction,
  registration: ActiveWaveGateRegistration,
  readinessDigest: WaveReadinessSnapshot["readinessDigest"],
  lifecycle: WaveGateState["kind"],
  checkpointDigest: WaveGateLifecycleCheckpoint["checkpointDigest"],
): boolean {
  const binding = proof.binding;
  return waveNextActionProofs.has(proof) &&
    proof.lifecycle === lifecycle &&
    proof.action.runId === registration.runId &&
    binding.runId === registration.runId &&
    binding.registrationRevision === registration.revision &&
    binding.authorityDigest === registration.authorityDigest &&
    binding.readinessDigest === readinessDigest &&
    binding.lifecycleCheckpointDigest === checkpointDigest;
}

function actionBinding(state: WaveGateState): WaveGateProtectedSnapshotBinding {
  return canonicalRecord({
    runId: state.runId,
    registrationRevision: state.registrationRevision,
    authorityDigest: state.authorityDigest,
    readinessDigest: state.readinessDigest,
    lifecycleCheckpointDigest: state.checkpointDigest,
  });
}

/** A transport action is not Wave policy authority until the exact protected
 * readiness snapshot and its connected lifecycle checkpoint prove it. */
export function proveWaveGateNextAction(
  snapshot: WaveReadinessSnapshot,
  state: WaveGateState,
  action: ExternalAction,
): DomainResult<WaveGateNextAction, WaveGateNextActionError> {
  if (!lifecycleMatchesSnapshot(state, snapshot)) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-gate-next-action-rejected",
      message: "next action lifecycle is disconnected from the exact protected Wave readiness snapshot",
    }) });
  }
  if (action.runId !== state.runId) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-gate-next-action-rejected",
      message: "next action belongs to a different Wave Gate run",
    }) });
  }
  const binding = actionBinding(state);
  let proven: WaveGateNextAction | null = null;
  if (action.kind === "spawn-batch" && (state.kind === "preparing" || state.kind === "awaiting-review-results")) {
    proven = canonicalRecord({ kind: "review-batch", lifecycle: state.kind, action, binding });
  } else if (action.kind === "await-user" && state.kind === "awaiting-advisory-decision") {
    proven = canonicalRecord({ kind: "advisory-decision", lifecycle: state.kind, action, binding });
  } else if (action.kind === "blocked" && (state.kind === "recoverable-blocked" || state.kind === "terminal-blocked")) {
    proven = canonicalRecord({ kind: "blocked", lifecycle: state.kind, action, binding });
  } else if (action.kind === "done" && state.kind === "done") {
    proven = canonicalRecord({ kind: "completed", lifecycle: "done", action, binding });
  }
  if (proven === null) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-gate-next-action-rejected",
      message: `${action.kind} is not authorized from Wave Gate lifecycle state ${state.kind}`,
    }) });
  }
  waveNextActionProofs.add(proven);
  return canonicalRecord({ ok: true, value: proven });
}

const reason = (kind: StatusReason["kind"], message: string, taskId: string | null = null): StatusReason =>
  canonicalRecord({ kind, message, taskId });

const nonEmptyReasons = (values: readonly StatusReason[], fallback: StatusReason): NonEmpty<StatusReason> => {
  const all = values.length === 0 ? [fallback] : values;
  return Object.freeze(all) as NonEmpty<StatusReason>;
};

/** First matching bucket wins; the order below IS the precedence. */
function taskBucket(task: Task, executing: ReadonlySet<string>): keyof StatusTaskCounts {
  if (task.status === "completed") return "completed";
  if (
    task.status === "failed" || task.proof?.state === "failed" ||
    task.review_status === "blocked" || task.review_status === "evidence_capture_failed"
  ) return "blocked";
  if (executing.has(task.id)) return "running";
  if (task.status === "implemented") return "implemented";
  return "pending";
}

function taskCounts(graph: TaskGraph): StatusTaskCounts {
  const executing = new Set(graph.executing_tasks ?? []);
  const counts = { pending: 0, running: 0, implemented: 0, blocked: 0, completed: 0 };
  for (const task of graph.tasks) counts[taskBucket(task, executing)]++;
  return canonicalRecord(counts);
}

function failedProofs(graph: TaskGraph): readonly FailedProofObligation[] {
  return Object.freeze(graph.tasks.flatMap((task) => task.proof?.state === "failed"
    ? task.proof.failures.map((failure) => canonicalRecord({ taskId: task.id, failure }))
    : []));
}

function deriveTestReadinessForTasks(tasks: readonly Task[]): TestReadiness {
  const affected = tasks.flatMap((task) => {
    const reasons: string[] = [];
    if (!testEvidenceSatisfied(task)) reasons.push("passing test evidence is missing");
    if (!newTestsSatisfied(task)) reasons.push("required new tests were not observed");
    return reasons.length === 0 ? [] : [canonicalRecord({ taskId: task.id, reasons: Object.freeze(reasons) as NonEmpty<string> })];
  });
  return affected.length === 0
    ? canonicalRecord({ kind: "ready", affectedTasks: Object.freeze([]) })
    : canonicalRecord({ kind: "not-ready", affectedTasks: Object.freeze(affected) as NonEmpty<(typeof affected)[number]> });
}

const deriveTestReadiness = (graph: TaskGraph, wave: number): TestReadiness =>
  deriveTestReadinessForTasks(graph.tasks.filter((task) => task.wave === wave));

function reviewFacts(graph: TaskGraph): Readonly<{
  rosterGaps: readonly ReviewRosterGap[];
  evidenceFailures: readonly ReviewEvidenceFailure[];
}> {
  const rosterGaps: ReviewRosterGap[] = [];
  const evidenceFailures: ReviewEvidenceFailure[] = [];
  for (const task of graph.tasks) {
    if (task.review_run !== undefined) {
      const supplied = new Set(task.review_run.evidence.map((entry) => entry.agent));
      for (const agent of task.review_run.expected_agents) {
        if (!supplied.has(agent)) rosterGaps.push(canonicalRecord({
          taskId: task.id,
          generation: task.review_run.generation,
          packetId: task.review_run.packet_id,
          agent,
        }));
      }
    }
    for (const agent of task.review_evidence_failures ?? []) {
      evidenceFailures.push(canonicalRecord({
        taskId: task.id,
        generation: task.review_run?.generation ?? task.review_generation ?? null,
        packetId: task.review_run?.packet_id ?? null,
        agent,
        error: task.review_error ?? "review evidence capture failed",
      }));
    }
  }
  return canonicalRecord({ rosterGaps: Object.freeze(rosterGaps), evidenceFailures: Object.freeze(evidenceFailures) });
}

function deriveFindingCounts(tasks: readonly Task[]): FindingCounts {
  let activeCritical = 0;
  let advisory = 0;
  let resolved = 0;
  let refuted = 0;
  for (const task of tasks) {
    if (task.findings !== undefined) {
      activeCritical += task.findings.filter((finding) => finding.severity === "critical").length;
      advisory += task.findings.filter((finding) => finding.severity === "advisory").length;
    } else {
      activeCritical += task.critical_findings?.filter((finding) => finding.trim() !== "").length ?? 0;
      advisory += task.advisory_findings?.filter((finding) => finding.trim() !== "").length ?? 0;
    }
    resolved += task.resolved_findings?.length ?? 0;
    refuted += task.refuted_findings?.length ?? 0;
  }
  return canonicalRecord({ activeCritical, advisory, resolved, refuted });
}

function activeCriticalFindingIds(graph: TaskGraph, wave: number): readonly string[] {
  return Object.freeze(graph.tasks.filter((task) => task.wave === wave).flatMap((task) => {
    if (task.findings !== undefined) {
      return task.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => `${task.id}:${finding.id}`);
    }
    return (task.critical_findings ?? []).flatMap((finding, index) =>
      finding.trim() === "" ? [] : [`${task.id}:legacy-critical:${index + 1}`]);
  }));
}

function panelNeed(graph: TaskGraph, wave: number): RefutationPanelNeed {
  const findingIds = activeCriticalFindingIds(graph, wave);
  return findingIds.length === 0
    ? canonicalRecord({ kind: "not-needed", findingIds: Object.freeze([]), reasons: Object.freeze(["the active Wave has no critical Findings"]) as NonEmpty<string> })
    : canonicalRecord({ kind: "needed", findingIds: Object.freeze(findingIds) as NonEmpty<string>, reasons: Object.freeze([`${findingIds.length} active critical Finding(s) require refutation`]) as NonEmpty<string> });
}

function completionEligibility(decision: GateDecision): WaveGateCompletionEligibility {
  const failed = decision.checks.flatMap((check) => check.passed ? [] : [check.reason]);
  if (decision.verdict.kind === "fail" && decision.checks.length === 0) failed.push(decision.verdict.reason);
  return failed.length === 0
    ? canonicalRecord({ kind: "eligible", failedPrerequisites: Object.freeze([]) })
    : canonicalRecord({ kind: "ineligible", failedPrerequisites: Object.freeze(failed) as NonEmpty<string> });
}

function readinessReasons(
  graph: TaskGraph,
  wave: number,
  decision: GateDecision,
  reviews: ReturnType<typeof reviewFacts>,
  panel: RefutationPanelNeed,
  tests: TestReadiness,
  eligibility: WaveGateCompletionEligibility,
): NonEmpty<StatusReason> {
  const reasons: StatusReason[] = [];
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  const waveTaskIds = new Set(waveTasks.map((task) => task.id));
  for (const task of waveTasks) {
    if ((graph.executing_tasks ?? []).includes(task.id)) reasons.push(reason("task-running", `${task.id} is still executing`, task.id));
    if (task.proof?.state === "failed") reasons.push(reason("proof-failed", `${task.id} has ${task.proof.failures.length} failed proof obligation(s)`, task.id));
  }
  if (tests.kind === "not-ready") {
    for (const affected of tests.affectedTasks) reasons.push(reason("tests-not-ready", `${affected.taskId}: ${affected.reasons.join("; ")}`, affected.taskId));
  }
  for (const gap of reviews.rosterGaps.filter((entry) => waveTaskIds.has(entry.taskId))) {
    reasons.push(reason("review-roster-gap", `${gap.taskId} is missing review evidence from ${gap.agent}`, gap.taskId));
  }
  for (const failure of reviews.evidenceFailures.filter((entry) => waveTaskIds.has(entry.taskId))) {
    reasons.push(reason("review-evidence-failure", `${failure.taskId}/${failure.agent}: ${failure.error}`, failure.taskId));
  }
  if (panel.kind === "needed") reasons.push(reason("refutation-required", panel.reasons.join("; ")));
  if (eligibility.kind === "ineligible") {
    for (const failed of eligibility.failedPrerequisites) reasons.push(reason("completion-prerequisite-failed", failed));
  } else {
    reasons.push(reason("completion-eligible", `Wave ${wave} satisfies every completion prerequisite`));
  }
  return nonEmptyReasons(reasons, reason("wave-gate-ready", decision.verdict.kind === "pass" ? `Wave ${wave} is ready` : decision.verdict.reason));
}

function completionAuthority(
  graph: TaskGraph,
  registration: ActiveWaveGateRegistration,
  decision: GateDecision,
  currentWaveWorkspaceObservation: WaveWorkspaceObservation | null,
  currentWaveCompletionResultObservation: WaveCompletionResultObservation | null,
): Readonly<{
  readinessDigest: import("./orchestration-contract").ArtifactDigest;
  completionIntent: CommitProtectedWaveState;
}> {
  const serialized = JSON.stringify({
    schemaVersion: 1,
    kind: "wave-completion-readiness",
    runId: registration.runId,
    wave: registration.wave,
    authorityDigest: registration.authorityDigest,
    expectedRevision: registration.revision,
    verificationManifestDigest: graph.verification_manifest?.manifestDigest ?? null,
    acceptedCompletionSuite: graph.active_wave_completion_suite ?? null,
    currentWaveWorkspaceObservation,
    currentWaveCompletionResultObservation,
    decision,
    tasks: graph.tasks.filter((task) => task.wave === registration.wave),
    specCheck: graph.spec_check ?? null,
    executingTasks: graph.executing_tasks ?? [],
  });
  const rawDigest = createHash("sha256").update(serialized).digest("hex");
  const digest = parseArtifactDigest(rawDigest);
  const effectId = parseEffectId(`wave-completion:${rawDigest.slice(0, 32)}`);
  if (!digest.ok || !effectId.ok) throw new Error("internal Wave completion authority is invalid");
  return canonicalRecord({
    readinessDigest: digest.value,
    completionIntent: canonicalRecord({
      kind: "commit-protected-wave-state",
      effectId: effectId.value,
      runId: registration.runId,
      expectedRevision: registration.revision,
      stateDigest: digest.value,
    }),
  });
}

/**
 * The lifecycle proof pair, as ONE value.
 *
 * A next-action proof and the lifecycle checkpoint it was derived from are only
 * ever legal TOGETHER: half the pair proves nothing, and the cross-checks below
 * read both. As two independently-nullable parameters that rule lived in a
 * hand-written both-or-neither runtime check — a check the type carries for
 * free once the pair is one value, at every call site rather than inside one
 * function body.
 */
export type WaveLifecycleProof = Readonly<{
  nextActionAuthority: WaveGateNextAction;
  lifecycleCheckpoint: WaveGateState;
}>;

/**
 * Derive every status fact and completion decision once from one parsed graph
 * snapshot. Consumers (program execution and status) must share this value;
 * renderers must not repeat gate policy.
 */
export function deriveWaveReadiness(
  graph: TaskGraph,
  deps: GateDeps,
  lifecycleProof: WaveLifecycleProof | null = null,
): DomainResult<WaveReadinessSnapshot, Readonly<{ kind: "wave-readiness-unavailable"; reasons: NonEmpty<StatusReason> }>> {
  const registration = graph.active_wave_gate;
  const failures: StatusReason[] = [];
  if (graph.current_phase === "execute" && graph.current_wave === undefined) {
    failures.push(reason("authority-unavailable", "execute Phase requires current_wave authority"));
  }
  if (registration === undefined) failures.push(reason("authority-unavailable", "active Wave Gate registration is missing"));
  if (registration !== undefined && registration.wave !== graph.current_wave) {
    failures.push(reason("authority-contradiction", `active Wave Gate wave ${registration.wave} does not match current wave ${graph.current_wave ?? "missing"}`));
  }
  if (registration?.terminalOutcome !== null && registration !== undefined) {
    failures.push(reason("authority-contradiction", "terminal Wave Gate history cannot serve as active current-Wave authority"));
  }
  if (failures.length > 0 || registration === undefined) {
    return canonicalRecord({
      ok: false,
      error: canonicalRecord({
        kind: "wave-readiness-unavailable",
        reasons: nonEmptyReasons(failures, reason("authority-unavailable", "Wave Gate authority is unavailable")),
      }),
    });
  }

  const wave = registration.wave;
  const decision = evaluateWaveGate(graph, wave, deps);
  const reviews = reviewFacts(graph);
  const tests = deriveTestReadiness(graph, wave);
  const findings = deriveFindingCounts(graph.tasks.filter((task) => task.wave === wave));
  const panel = panelNeed(graph, wave);
  const eligibility = completionEligibility(decision);
  const facts: CanonicalStatusFacts = canonicalRecord({
    location: canonicalRecord({ kind: "known", value: canonicalRecord({ activePhase: graph.current_phase, activeWave: graph.current_phase === "execute" ? wave : null }) }),
    tasks: canonicalRecord({ kind: "known", value: canonicalRecord({ counts: taskCounts(graph) }) }),
    failedProofObligations: canonicalRecord({ kind: "known", value: failedProofs(graph) }),
    testReadiness: canonicalRecord({ kind: "known", value: tests }),
    reviewRuns: canonicalRecord({ kind: "known", value: reviews }),
    findingCounts: canonicalRecord({ kind: "known", value: findings }),
    refutationPanelNeed: canonicalRecord({ kind: "known", value: panel }),
    waveCompletionSuiteReadiness: canonicalRecord({
      kind: "known",
      value: deriveWaveCompletionSuiteReadiness(
        graph,
        wave,
        deps.currentWaveWorkspace,
        deps.currentWaveCompletionResult,
      ),
    }),
    waveGateCompletionEligibility: canonicalRecord({ kind: "known", value: eligibility }),
  });
  const workspaceObservation = deps.currentWaveWorkspace ?? null;
  const completionResultObservation = graph.verification_manifest !== undefined &&
    graph.active_wave_completion_suite === undefined &&
    workspaceObservation?.kind === "observed"
    ? deps.currentWaveCompletionResult ?? null
    : null;
  const completion = completionAuthority(
    graph,
    registration,
    decision,
    workspaceObservation,
    completionResultObservation,
  );
  if (lifecycleProof !== null) {
    const { nextActionAuthority, lifecycleCheckpoint } = lifecycleProof;
    const exactBinding = lifecycleCheckpointIdentityIsExact(
      lifecycleCheckpoint,
      registration,
      completion.readinessDigest,
    ) && nextActionProofIdentityIsExact(
      nextActionAuthority,
      registration,
      completion.readinessDigest,
      lifecycleCheckpoint.kind,
      lifecycleCheckpoint.checkpointDigest,
    );
    if (!exactBinding) {
      return canonicalRecord({
        ok: false,
        error: canonicalRecord({
          kind: "wave-readiness-unavailable",
          reasons: Object.freeze([reason(
            "authority-contradiction",
            "Wave next action proof does not match the exact run/revision/authority/readiness/lifecycle checkpoint",
          )]) as NonEmpty<StatusReason>,
        }),
      });
    }
    if (nextActionAuthority.kind === "completed") {
      return canonicalRecord({
        ok: false,
        error: canonicalRecord({
          kind: "wave-readiness-unavailable",
          reasons: Object.freeze([reason(
            "authority-contradiction",
            "Wave done status requires a committed terminal wave_gate_history receipt",
          )]) as NonEmpty<StatusReason>,
        }),
      });
    }
  }
  const snapshot: WaveReadinessSnapshot = canonicalRecord({
    graph,
    registration,
    wave,
    waveTasks: Object.freeze(graph.tasks.filter((task) => task.wave === wave)),
    gateDecision: decision,
    facts,
    readinessDigest: completion.readinessDigest,
    completionIntent: completion.completionIntent,
    nextActionAuthority: lifecycleProof?.nextActionAuthority ?? null,
    lifecycleCheckpointDigest: lifecycleProof?.lifecycleCheckpoint.checkpointDigest ?? null,
    currentWaveWorkspaceObservation: workspaceObservation,
    currentWaveCompletionResultObservation: completionResultObservation,
    reasons: readinessReasons(graph, wave, decision, reviews, panel, tests, eligibility),
  });
  waveReadinessProofs.add(snapshot);
  return canonicalRecord({ ok: true, value: snapshot });
}

export type WaveCompletionCommit = Readonly<{
  graph: TaskGraph;
  receipt: ProtectedWaveStateCommitted;
  completedRegistration: CompletedWaveGateRegistration;
}>;

export type WaveCompletionCommitError = Readonly<{
  kind: "wave-completion-commit-rejected";
  message: string;
}>;

/** Pure atomic payload: shell persists this graph and returns this receipt in
 * one StateManager transaction. No task/wave mutation is exposed separately. */
export function commitWaveGateCompletion(
  snapshot: WaveReadinessSnapshot,
): DomainResult<WaveCompletionCommit, WaveCompletionCommitError> {
  if (!waveReadinessProofs.has(snapshot)) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: "completion requires a parser-derived canonical readiness proof",
    }) });
  }
  if (snapshot.graph.active_wave_gate !== snapshot.registration) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: "snapshot graph active_wave_gate is not the exact readiness registration",
    }) });
  }
  const currentAuthority = completionAuthority(
    snapshot.graph,
    snapshot.registration,
    snapshot.gateDecision,
    snapshot.currentWaveWorkspaceObservation,
    snapshot.currentWaveCompletionResultObservation,
  );
  if (
    currentAuthority.readinessDigest !== snapshot.readinessDigest ||
    currentAuthority.completionIntent.effectId !== snapshot.completionIntent.effectId
  ) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: "completion readiness authority drifted after proof derivation",
    }) });
  }
  if (snapshot.gateDecision.verdict.kind !== "pass") {
    const eligibility = snapshot.facts.waveGateCompletionEligibility;
    const failures = eligibility.kind === "known" && eligibility.value.kind === "ineligible"
      ? eligibility.value.failedPrerequisites
      : [snapshot.gateDecision.verdict.reason];
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: `completion readiness is ineligible: ${failures.join("; ")}`,
    }) });
  }
  const receipt: ProtectedWaveStateCommitted = canonicalRecord({
    kind: "protected-wave-state-committed",
    effectId: snapshot.completionIntent.effectId,
    runId: snapshot.registration.runId,
    committedRevision: snapshot.registration.revision + 1,
    stateDigest: snapshot.readinessDigest,
  });
  const reconciled = reconcileEffectReceipt(snapshot.completionIntent, receipt);
  if (!reconciled.ok || reconciled.value.kind !== "protected-wave-state-committed") {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: reconciled.ok ? "completion produced the wrong receipt kind" : reconciled.error.message,
    }) });
  }
  const advanced = applyGateDecision(snapshot.graph, snapshot.gateDecision);
  if (advanced === snapshot.graph) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: "locked active/current Wave authority drifted before completion",
    }) });
  }
  const activeCompletionSuite = snapshot.graph.active_wave_completion_suite;
  const completedRegistration: CompletedWaveGateRegistration = activeCompletionSuite === undefined
    ? canonicalRecord({
        schemaVersion: 1,
        kind: "completed-wave-gate",
        runId: snapshot.registration.runId,
        wave: snapshot.wave,
        authorityDigest: snapshot.registration.authorityDigest,
        revision: receipt.committedRevision,
        completionReceipt: receipt,
      })
    : canonicalRecord({
        schemaVersion: 2,
        kind: "completed-wave-gate",
        runId: snapshot.registration.runId,
        wave: snapshot.wave,
        authorityDigest: snapshot.registration.authorityDigest,
        revision: receipt.committedRevision,
        completionReceipt: receipt,
        completionSuite: activeCompletionSuite,
      });
  const priorHistory = advanced.wave_gate_history ?? [];
  if (priorHistory.some((entry) => entry.runId === completedRegistration.runId)) {
    return canonicalRecord({ ok: false, error: canonicalRecord({
      kind: "wave-completion-commit-rejected",
      message: `Wave Gate run ${completedRegistration.runId} is already terminal in history`,
    }) });
  }
  const {
    active_wave_gate: _retired,
    active_wave_completion_suite: _archivedCompletionSuite,
    ...withoutActive
  } = advanced;
  const graph: TaskGraph = {
    ...withoutActive,
    wave_gate_history: Object.freeze([...priorHistory, completedRegistration]),
  };
  return canonicalRecord({
    ok: true,
    value: canonicalRecord({ graph, receipt, completedRegistration }),
  });
}

export { WAVE_REVIEW_AGENTS };

export type WavePreparationError = Readonly<{
  kind: "wave-preparation-rejected";
  message: string;
}>;

const preparationFailure = <T>(message: string): DomainResult<T, WavePreparationError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-preparation-rejected", message }) });

export type WaveRefutationPlan = Readonly<{
  runId: OrchestrationRunId;
  findings: NonEmpty<BriefFinding>;
  lenses: NonEmpty<ReviewLens>;
}>;

export type WaveRefutationPreparation = Readonly<WaveRefutationPlan & {
  authority: RefutationPanelAuthority;
}>;

/** Derive the idempotent run/finding/lens authority before request issuance. */
export function deriveWaveRefutationPlan(
  snapshot: WaveReadinessSnapshot,
): DomainResult<WaveRefutationPlan, WavePreparationError> {
  if (!waveReadinessProofs.has(snapshot)) return preparationFailure("refutation preparation requires canonical readiness");
  const collecting = snapshot.waveTasks.filter(({ review_run }) => review_run !== undefined);
  if (collecting.length > 0) {
    return preparationFailure(
      `current Review Packet evidence must complete before refutation: ${collecting.map(({ id, review_run }) =>
        `${id}/${review_run!.packet_id}`).join(", ")}`,
    );
  }
  const unreviewed = snapshot.waveTasks.filter(({ review_status }) =>
    review_status !== "passed" && review_status !== "blocked");
  if (unreviewed.length > 0) {
    return preparationFailure(
      `current-generation review evidence must complete before refutation: ${unreviewed.map(({ id }) => id).join(", ")}`,
    );
  }
  const brief = buildFindingBrief(snapshot.wave, snapshot.graph.tasks);
  if (brief.findings.length === 0) return preparationFailure("an empty critical Finding set cannot start a Refutation Panel");
  const lenses = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!lenses.ok || lenses.value.length === 0) return preparationFailure(lenses.ok ? "no review lenses were derived" : lenses.errors.join("; "));
  const digest = createHash("sha256")
    .update(`${snapshot.registration.runId}|${snapshot.readinessDigest}|${brief.findings.map(({ id }) => id).join("|")}|${lenses.value.join("|")}`)
    .digest("hex");
  const panelRun = parseOrchestrationRunId(`wave-refutation:${digest.slice(0, 32)}`);
  if (!panelRun.ok) return preparationFailure(panelRun.error.message);
  return canonicalRecord({ ok: true, value: canonicalRecord({
    runId: panelRun.value,
    findings: Object.freeze(brief.findings) as NonEmpty<BriefFinding>,
    lenses: Object.freeze(lenses.value) as NonEmpty<ReviewLens>,
  }) });
}

export type WaveRefutationAuthorityClaims = Readonly<{
  /** Comparison-only legacy assertion; never used to select panel slots. */
  verifierSlots?: readonly AgentRosterSlot[];
}>;

function deriveWaveRefutationVerifierSlots(plan: WaveRefutationPlan): DomainResult<NonEmpty<AgentRosterSlot>, WavePreparationError> {
  const panelBindings = canonicalRecord({
    pi: canonicalRecord({ harness: "pi" as const, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" as const }),
    claude: canonicalRecord({ harness: "claude-code" as const, model: "opus" as const }),
  });
  const slots: AgentRosterSlot[] = [];
  for (let index = 0; index < plan.lenses.length; index++) {
    const lens = plan.lenses[index]!;
    const findingIds = [plan.findings[0].id, ...plan.findings.slice(1).map(({ id }) => id)] as const;
    const binding = deriveRefutationVerifierBinding(plan.runId, lens, findingIds);
    if (!binding.ok) return preparationFailure(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const contextDigest = parseContextDigest(createHash("sha256")
        .update(JSON.stringify([binding.value.slotId, attempt]))
        .digest("hex"));
      if (!contextDigest.ok) return null;
      const authority = parseAgentRequestAuthority({
        runId: plan.runId,
        requestId,
        slotId: binding.value.slotId,
        program: "refutation-panel",
        role: "review-verifier-agent",
        attempt,
        modelProfile: "refutation",
        harnessBinding: panelBindings,
        requiredSkill: null,
        contextDigest: contextDigest.value,
        outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
      });
      return authority.ok ? authority.value : null;
    });
    if (attempts[0] === null || attempts[1] === null) return preparationFailure(`failed to derive verifier authority for lens ${lens}`);
    const slot = parseAgentRosterSlot(attempts[0], attempts[1]);
    if (!slot.ok) return preparationFailure(`derived verifier slot for lens ${lens} is invalid`);
    slots.push(slot.value);
  }
  return canonicalRecord({ ok: true, value: Object.freeze(slots) as NonEmpty<AgentRosterSlot> });
}

/** Findings, lens order, and verifier slots come only from the canonical Wave
 * snapshot. Caller claims can reject drift but never select authority. */
export function prepareWaveRefutationPanel(
  snapshot: WaveReadinessSnapshot,
  claims: WaveRefutationAuthorityClaims = {},
): DomainResult<WaveRefutationPreparation, WavePreparationError> {
  const plan = deriveWaveRefutationPlan(snapshot);
  if (!plan.ok) return plan;
  const verifierSlots = deriveWaveRefutationVerifierSlots(plan.value);
  if (!verifierSlots.ok) return verifierSlots;
  if (claims.verifierSlots !== undefined && JSON.stringify(claims.verifierSlots) !== JSON.stringify(verifierSlots.value)) {
    return preparationFailure("caller verifier slot claim drifted from canonical Finding/lens authority");
  }
  const authority = parseRefutationPanelAuthority({
    runId: plan.value.runId,
    findings: plan.value.findings,
    lenses: plan.value.lenses,
    verifierSlots: verifierSlots.value,
  });
  if (!authority.ok) return preparationFailure(authority.error.message);
  return canonicalRecord({ ok: true, value: canonicalRecord({
    runId: plan.value.runId,
    findings: plan.value.findings,
    lenses: plan.value.lenses,
    authority: authority.value,
  }) });
}

// ---------------------------------------------------------------------------
// LC-1 projection: the run's stage, reduced from durable evidence
// ---------------------------------------------------------------------------

/**
 * The durable facts a Wave Gate run's stage is a function of.
 *
 * The shell reads them; LC-1 decides what they mean. Every field is derivable
 * from the protected graph except `advisoryApproved`, which lives in the run's
 * event log — so the shell supplies it, exactly as it supplies
 * `ActiveRunDirectoryObservation`. Core performs no I/O.
 */
export type WaveGateLifecycleEvidence = Readonly<{
  /** The wave's review batch has been published (a Review Run exists). */
  batchPublished: boolean;
  /** Reviewer results durably accepted so far, none of them completing the roster. */
  acceptedResults: number;
  /** A semantic attempt was durably rejected, and which one. */
  rejectedAttempt: 1 | 2 | null;
  /** Every expected reviewer slot has landed evidence. */
  rosterComplete: boolean;
  /** Blocking criticals the wave still carries. */
  activeCritical: number;
  /** Advisory Findings awaiting user triage. */
  advisoryCount: number;
  /** The user approved this run's exact advisory request. */
  advisoryApproved: boolean;
  /** The protected completion receipt, once committed. */
  committed: ProtectedWaveStateCommitted | null;
}>;

export type WaveGateProjectionError = Readonly<{
  kind: "wave-gate-projection-rejected";
  message: string;
}>;

const projectionFailure = (message: string): DomainResult<WaveGateState, WaveGateProjectionError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-gate-projection-rejected", message }) });

/**
 * Reduce LC-1 forward over one run's durable evidence and return the stage it
 * reaches.
 *
 * The Wave Gate façade is already a replay — every drive reconstructs the run
 * from durable evidence rather than resuming an in-memory position — so LC-1
 * does not need a serialized checkpoint to be executable. It needs the events
 * that evidence implies. This is the seam where the two meet: one small
 * interface, the whole stage decision behind it, callable by the façade and by
 * `status` alike.
 *
 * Every transition goes through the reducer's union replay entry point, so a
 * combination of facts that no declared transition admits is a rejection rather
 * than a stage nobody checked. The order below IS the wave's order: publish,
 * collect, adjudicate
 * criticals, triage advisories, complete.
 */
export function projectWaveGateLifecycle(
  snapshot: WaveReadinessSnapshot,
  evidence: WaveGateLifecycleEvidence,
): DomainResult<WaveGateState, WaveGateProjectionError> {
  if (!Number.isSafeInteger(evidence.acceptedResults) || evidence.acceptedResults < 0) {
    return projectionFailure("acceptedResults must be a non-negative safe integer");
  }
  const initial = createWaveGateState(snapshot);
  if (!initial.ok) return projectionFailure(initial.error.message);

  let state: WaveGateState = initial.value;
  let rejection: WaveGateTransitionError | null = null;
  const step = (event: WaveGateEvent): boolean => {
    const next = replayWaveGateTransition(state, event);
    if (!next.ok) {
      rejection = next.error;
      return false;
    }
    state = next.value;
    return true;
  };
  const settled = (): DomainResult<WaveGateState, WaveGateProjectionError> =>
    rejection === null
      ? canonicalRecord({ ok: true, value: state })
      : projectionFailure(`${rejection.state} rejects ${rejection.event}: ${rejection.message}`);

  if (!evidence.batchPublished) return settled();
  if (!step({ kind: "preparation-published" })) return settled();

  // A rejected attempt 2 is terminal and outranks everything after it.
  if (evidence.rejectedAttempt === 2) {
    step({ kind: "result-rejected", attempt: 2 });
    return settled();
  }
  for (let accepted = 0; accepted < evidence.acceptedResults; accepted++) {
    if (!step({ kind: "result-accepted", completeness: "incomplete" })) return settled();
  }
  if (evidence.rejectedAttempt === 1 && !step({ kind: "result-rejected", attempt: 1 })) return settled();

  if (!evidence.rosterComplete) return settled();
  if (evidence.activeCritical > 0) {
    step({ kind: "complete-roster-with-criticals" });
    return settled();
  }
  if (evidence.advisoryCount > 0) {
    if (!step({ kind: "complete-roster-with-advisories" })) return settled();
    if (!evidence.advisoryApproved) return settled();
    if (!step({ kind: "advisory-decision-accepted" })) return settled();
  } else if (!step({ kind: "complete-roster-clean" })) {
    return settled();
  }

  if (evidence.committed !== null) {
    step({ kind: "completion-committed", readiness: snapshot, receipt: evidence.committed });
  }
  return settled();
}

export type WaveAdvisoryArtifactMaterial = Readonly<{
  reference: ArtifactRef;
  bytes: readonly number[];
}>;

export type WaveAdvisoryDecisionRequest = Readonly<{
  requestId: RequestId;
  decisionDigest: import("./orchestration-contract").ContextDigest;
  context: Readonly<{
    digest: import("./orchestration-contract").ContextDigest;
    slot: Readonly<{ kind: "fixed-artifact-slot"; path: string }>;
    bytes: readonly number[];
  }>;
  advisories: NonEmpty<WaveAdvisoryArtifactMaterial>;
}>;

const waveAdvisoryDecisionMaterialProofs = new WeakSet<object>();

/** Strip publication bytes only from the exact material set derived by core. */
export function waveAdvisoryDecisionActionRequest(
  material: WaveAdvisoryDecisionRequest,
): DomainResult<Readonly<{
  kind: "advisory-triage";
  requestId: RequestId;
  runId: OrchestrationRunId;
  context: Readonly<{
    digest: import("./orchestration-contract").ContextDigest;
    slot: Readonly<{ kind: "fixed-artifact-slot"; path: string }>;
  }>;
  advisories: NonEmpty<ArtifactRef>;
}>, WavePreparationError> {
  if (!waveAdvisoryDecisionMaterialProofs.has(material) || material.decisionDigest !== material.context.digest) {
    return preparationFailure("advisory action requires one exact core-derived decision material set");
  }
  return canonicalRecord({ ok: true, value: canonicalRecord({
    kind: "advisory-triage" as const,
    requestId: material.requestId,
    runId: material.advisories[0].reference.runId,
    context: canonicalRecord({ digest: material.context.digest, slot: material.context.slot }),
    advisories: Object.freeze(material.advisories.map(({ reference }) => reference)) as NonEmpty<ArtifactRef>,
  }) });
}

/** One pure source for advisory bytes, references, and request identity. */
export function deriveWaveAdvisoryDecisionRequest(
  rawRunId: string,
  tasks: readonly Task[],
): DomainResult<WaveAdvisoryDecisionRequest, WavePreparationError> {
  const runId = parseOrchestrationRunId(rawRunId);
  if (!runId.ok) return preparationFailure(runId.error.message);
  const canonicalAdvisories = tasks.flatMap((task) => {
    if (task.findings !== undefined) {
      return task.findings.filter((finding) => finding.severity === "advisory").map((finding) => ({
        identity: `${task.id}:${finding.id}`,
        bytes: Object.freeze([...new TextEncoder().encode(JSON.stringify({ taskId: task.id, finding }))]),
      }));
    }
    return (task.advisory_findings ?? []).filter((claim) => claim.trim() !== "").map((claim, index) => ({
      identity: `${task.id}:legacy-advisory-${index + 1}`,
      bytes: Object.freeze([...new TextEncoder().encode(JSON.stringify({ taskId: task.id, claim }))]),
    }));
  });
  if (canonicalAdvisories.length === 0) return preparationFailure("no canonical advisories require user triage");

  const advisories: WaveAdvisoryArtifactMaterial[] = [];
  for (const { identity, bytes } of canonicalAdvisories) {
    const byteLength = parseArtifactByteLength(bytes.length);
    const digest = parseArtifactDigest(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
    if (!byteLength.ok) return preparationFailure(byteLength.error.message);
    if (!digest.ok) return preparationFailure(digest.error.message);
    const reference = parseArtifactRef({
      runId: runId.value,
      slot: canonicalRecord({
        kind: "fixed-artifact-slot",
        path: `artifacts/advisories/${identity.replace(/[^A-Za-z0-9_.-]+/g, "-")}.json`,
      }),
      digest: digest.value,
      byteLength: byteLength.value,
    });
    if (!reference.ok) return preparationFailure(reference.error.message);
    advisories.push(canonicalRecord({ reference: reference.value, bytes }));
  }

  const contextBytes = Object.freeze([...new TextEncoder().encode(JSON.stringify(canonicalRecord({
    schemaVersion: 1,
    kind: "wave-advisory-decision-context",
    runId: runId.value,
    advisories: advisories.map(({ reference }) => reference),
  })))]);
  const contextDigest = parseContextDigest(createHash("sha256")
    .update(Uint8Array.from(contextBytes)).digest("hex"));
  if (!contextDigest.ok) return preparationFailure(contextDigest.error.message);
  const requestId = parseRequestId(`advisory-decision:${contextDigest.value.slice(0, 32)}`);
  if (!requestId.ok) return preparationFailure(requestId.error.message);
  const material = canonicalRecord({
    requestId: requestId.value,
    decisionDigest: contextDigest.value,
    context: canonicalRecord({
      digest: contextDigest.value,
      slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `contexts/${contextDigest.value}.json` }),
      bytes: contextBytes,
    }),
    advisories: Object.freeze(advisories) as NonEmpty<WaveAdvisoryArtifactMaterial>,
  });
  waveAdvisoryDecisionMaterialProofs.add(material);
  return canonicalRecord({ ok: true, value: material });
}

export type WaveGateDriveStep =
  | Readonly<{
      kind: "await-advisory-decision";
      material: WaveAdvisoryDecisionRequest;
      state: Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>;
    }>
  | Readonly<{
      kind: "ready-to-complete";
      state: Extract<WaveGateState, { kind: "ready-to-complete" }>;
    }>
  | Readonly<{ kind: "blocked"; message: string; state: WaveGateState }>;

/**
 * Pure driver intent for the post-review Wave Gate seam.
 *
 * The shell supplies only the durable user-decision observation. Canonical
 * Finding counts, stage transitions, advisory material, and completion
 * eligibility all stay behind LC-1, so status and resume cannot grow separate
 * advisory-stage predicates.
 */
export function deriveWaveGateDriveStep(
  snapshot: WaveReadinessSnapshot,
  advisoryApproved: boolean,
): DomainResult<WaveGateDriveStep, WavePreparationError> {
  if (!waveReadinessProofs.has(snapshot)) {
    return preparationFailure("Wave Gate drive requires canonical readiness");
  }
  const counts = snapshot.facts.findingCounts;
  if (counts.kind !== "known") return preparationFailure("Wave Gate drive lacks canonical Finding counts");
  const projected = projectWaveGateLifecycle(snapshot, canonicalRecord({
    batchPublished: true,
    acceptedResults: 0,
    rejectedAttempt: null,
    rosterComplete: true,
    activeCritical: counts.value.activeCritical,
    advisoryCount: counts.value.advisory,
    advisoryApproved,
    committed: null,
  }));
  if (!projected.ok) return preparationFailure(projected.error.message);
  const state = projected.value;
  if (state.kind === "awaiting-advisory-decision") {
    const material = deriveWaveAdvisoryDecisionRequest(snapshot.registration.runId, snapshot.waveTasks);
    return material.ok
      ? canonicalRecord({ ok: true, value: canonicalRecord({ kind: "await-advisory-decision", material: material.value, state }) })
      : material;
  }
  if (state.kind === "ready-to-complete" && snapshot.gateDecision.verdict.kind === "pass") {
    return canonicalRecord({ ok: true, value: canonicalRecord({ kind: "ready-to-complete", state }) });
  }
  const message = snapshot.gateDecision.verdict.kind === "fail"
    ? snapshot.gateDecision.verdict.reason
    : `Wave Gate lifecycle reached ${state.kind}, not a post-review drive state`;
  return canonicalRecord({ ok: true, value: canonicalRecord({ kind: "blocked", message, state }) });
}

/** Advisory policy remains user-owned. The engine derives whether the action
 * exists from canonical advisory counts and only accepts the exact Wave/run-
 * scoped advisory request. */
export function deriveWaveAdvisoryNextAction(
  snapshot: WaveReadinessSnapshot,
  state: Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>,
): DomainResult<WaveGateNextAction, WavePreparationError> {
  if (!waveReadinessProofs.has(snapshot) || state.runId !== snapshot.registration.runId) {
    return preparationFailure("advisory action requires canonical readiness for this lifecycle run");
  }
  const request = deriveWaveAdvisoryDecisionRequest(snapshot.registration.runId, snapshot.waveTasks);
  if (!request.ok) return request;
  const actionRequest = waveAdvisoryDecisionActionRequest(request.value);
  if (!actionRequest.ok) return actionRequest;
  const built = awaitUserAction(actionRequest.value);
  if (!built.ok) return preparationFailure(built.error.message);
  const proven = proveWaveGateNextAction(snapshot, state, built.value);
  return proven.ok ? canonicalRecord({ ok: true, value: proven.value }) : preparationFailure(proven.error.message);
}

const statusRunId = (() => {
  const parsed = parseOrchestrationRunId("loom-status-authority");
  if (!parsed.ok) throw new Error("internal status authority id is invalid");
  return parsed.value;
})();

function invalidAuthorityBlockedAction(runId: OrchestrationRunId, message: string): ExternalAction {
  const diagnostic = terminalBlockedDiagnostic({ category: "invalid-authority", runId, message });
  if (!diagnostic.ok) throw new Error(`internal blocked diagnostic construction failed: ${diagnostic.error.message}`);
  const action = blockedAction(diagnostic.value);
  if (!action.ok) throw new Error(`internal blocked action construction failed: ${action.error.message}`);
  return action.value;
}

/** Status-only projection for a healthy execute Wave that has not registered a
 * Wave Gate run yet. No run exists to name, so the read carries the status
 * authority id rather than inventing a run identity. */
function waveImplementationAction(
  message: string,
  recovery: WaveImplementationRecovery,
): WaveImplementationAction {
  const common = canonicalRecord({ runId: statusRunId, message });
  const diagnostic: WaveImplementationAction["diagnostic"] = recovery.kind === "escalate-wave-implementation"
    ? canonicalRecord({
        kind: "implementation-escalation-required",
        category: "semantic-attempts-exhausted",
        ...common,
        retry: canonicalRecord({
          kind: "advance-wave-lifecycle",
          eligible: false,
          consumesSemanticAttempt: false,
        }),
        recovery,
      })
    : canonicalRecord({
        kind: "wave-gate-not-started",
        category: "healthy-wave-unstarted",
        ...common,
        retry: canonicalRecord({
          kind: "advance-wave-lifecycle",
          eligible: true,
          consumesSemanticAttempt: false,
        }),
        recovery,
      });
  return canonicalRecord({ kind: "blocked", runId: statusRunId, diagnostic });
}

/** Status-only recovery projection for a registered run whose durable lifecycle
 * must be replayed before its semantic external action is known. Directory
 * health is established separately by the shell observation. */
function engineResumeAction(runId: OrchestrationRunId): EngineResumeAction {
  return canonicalRecord({
    kind: "blocked",
    runId,
    diagnostic: canonicalRecord({
      kind: "engine-resume-required",
      category: "registered-run-suspended",
      runId,
      message: `Wave Gate run ${runId} is registered and requires engine resume to derive its next external action`,
      retry: canonicalRecord({
        kind: "engine-resume",
        eligible: true,
        consumesSemanticAttempt: false,
      }),
      recovery: canonicalRecord({
        kind: "resume-orchestration",
        runId,
      }),
    }),
  });
}

function snapshotActionProofIsExact(snapshot: WaveReadinessSnapshot): boolean {
  const proof = snapshot.nextActionAuthority;
  if (proof === null) return snapshot.lifecycleCheckpointDigest === null;
  return waveReadinessProofs.has(snapshot) &&
    snapshot.graph.active_wave_gate === snapshot.registration &&
    proof.kind !== "completed" &&
    snapshot.lifecycleCheckpointDigest !== null &&
    nextActionProofIdentityIsExact(
      proof,
      snapshot.registration,
      snapshot.readinessDigest,
      proof.lifecycle,
      snapshot.lifecycleCheckpointDigest,
    );
}

/** Why the proven authority selected this action. One arm per authority kind. */
function nextActionReason(
  authority: WaveGateNextAction,
  action: NextActionDecision["action"],
): StatusReason {
  if (authority.kind === "advisory-decision") {
    return reason(
      "advisory-decision-required",
      `${action.kind === "await-user" ? action.request.advisories.length : 0} advisory artifact(s) require a user decision`,
    );
  }
  if (authority.kind === "review-batch") {
    return reason(
      "review-spawn-required",
      `${action.kind === "spawn-batch" ? action.requests.length : 0} exact review request(s) are ready to spawn`,
    );
  }
  if (authority.kind === "blocked") {
    return reason("blocked-diagnostic", action.kind === "blocked" ? action.diagnostic.message : "Wave Gate is blocked");
  }
  return reason("run-complete", `Wave Gate run ${action.runId} is complete`);
}

/** Exactly one action, selected only from the shared readiness snapshot. A
 * copied/stale proof fails closed even if a caller bypasses deriveWaveReadiness. */
export function deriveNextAction(snapshot: WaveReadinessSnapshot): NextActionDecision {
  let action: NextActionDecision["action"];
  let actionReason: StatusReason;
  if (!waveReadinessProofs.has(snapshot) || !snapshotActionProofIsExact(snapshot)) {
    const message = "Wave next action proof is stale or disconnected from the exact protected snapshot";
    action = invalidAuthorityBlockedAction(snapshot.registration.runId, message);
    actionReason = reason("authority-contradiction", message);
  } else if (snapshot.nextActionAuthority !== null) {
    action = snapshot.nextActionAuthority.action;
    actionReason = nextActionReason(snapshot.nextActionAuthority, action);
  } else {
    action = engineResumeAction(snapshot.registration.runId);
    actionReason = reason(
      "engine-resume-required",
      `Resume Wave Gate run ${snapshot.registration.runId}; this recovery is retry eligible and consumes no semantic attempt`,
    );
  }
  return canonicalRecord({
    action,
    reasons: Object.freeze([...snapshot.reasons, actionReason]) as NonEmpty<StatusReason>,
  });
}

export function deriveLoomStatus(snapshot: WaveReadinessSnapshot): LoomStatus {
  return canonicalRecord({ schemaVersion: 1, facts: snapshot.facts, next: deriveNextAction(snapshot) });
}

/** Fail-closed status retains the complete fact inventory; no zero/ready value is fabricated. */
export function deriveUnavailableLoomStatus(rawReasons: NonEmpty<StatusReason>): LoomStatus {
  const reasons = Object.freeze([...rawReasons]) as NonEmpty<StatusReason>;
  const unavailable = (): Readonly<{ kind: "unavailable"; reasons: NonEmpty<StatusReason> }> =>
    canonicalRecord({ kind: "unavailable", reasons });
  return canonicalRecord({
    schemaVersion: 1,
    facts: canonicalRecord({
      location: unavailable(),
      tasks: unavailable(),
      failedProofObligations: unavailable(),
      testReadiness: unavailable(),
      reviewRuns: unavailable(),
      findingCounts: unavailable(),
      refutationPanelNeed: unavailable(),
      waveCompletionSuiteReadiness: unavailable(),
      waveGateCompletionEligibility: unavailable(),
    }),
    next: canonicalRecord({
      action: invalidAuthorityBlockedAction(statusRunId, reasons.map((entry) => entry.message).join("; ")),
      reasons,
    }),
  });
}

export function unavailableStatusReason(message: string): StatusReason {
  return reason("authority-unavailable", message);
}

function deriveNonExecuteLoomStatus(
  graph: TaskGraph,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
): LoomStatus {
  const noWaveReason = reason(
    "completion-prerequisite-failed",
    `Wave Gate completion is unavailable while the active Phase is ${graph.current_phase}`,
  );
  const reviews = reviewFacts(graph);
  const facts: CanonicalStatusFacts = canonicalRecord({
    location: canonicalRecord({
      kind: "known",
      value: canonicalRecord({ activePhase: graph.current_phase, activeWave: null }),
    }),
    tasks: canonicalRecord({
      kind: "known",
      value: canonicalRecord({ counts: taskCounts(graph) }),
    }),
    failedProofObligations: canonicalRecord({ kind: "known", value: failedProofs(graph) }),
    testReadiness: canonicalRecord({ kind: "known", value: deriveTestReadinessForTasks(graph.tasks) }),
    reviewRuns: canonicalRecord({ kind: "known", value: reviews }),
    findingCounts: canonicalRecord({ kind: "known", value: deriveFindingCounts(graph.tasks) }),
    refutationPanelNeed: canonicalRecord({
      kind: "known",
      value: canonicalRecord({
        kind: "not-needed",
        findingIds: Object.freeze([]) as readonly [],
        reasons: Object.freeze(["there is no active execute Wave"]) as NonEmpty<string>,
      }),
    }),
    waveCompletionSuiteReadiness: canonicalRecord({
      kind: "known",
      value: deriveWaveCompletionSuiteReadiness(graph, null, currentWorkspace, currentResult),
    }),
    waveGateCompletionEligibility: canonicalRecord({
      kind: "known",
      value: canonicalRecord({
        kind: "ineligible",
        failedPrerequisites: Object.freeze([noWaveReason.message]) as NonEmpty<string>,
      }),
    }),
  });
  return canonicalRecord({
    schemaVersion: 1,
    facts,
    next: canonicalRecord({
      action: invalidAuthorityBlockedAction(statusRunId, noWaveReason.message),
      reasons: Object.freeze([noWaveReason]) as NonEmpty<StatusReason>,
    }),
  });
}

/** Wave-scoped fact inventory. Every helper it calls reads only the parsed
 * graph, so this is derivable with or without an active Wave Gate
 * registration — which is what lets an unstarted Wave report real facts
 * instead of a blanket `unavailable`. */
function waveScopedStatusFacts(
  graph: TaskGraph,
  wave: number,
  eligibility: WaveGateCompletionEligibility,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
): CanonicalStatusFacts {
  const reviews = reviewFacts(graph);
  return canonicalRecord({
    location: canonicalRecord({ kind: "known", value: canonicalRecord({ activePhase: graph.current_phase, activeWave: wave }) }),
    tasks: canonicalRecord({ kind: "known", value: canonicalRecord({ counts: taskCounts(graph) }) }),
    failedProofObligations: canonicalRecord({ kind: "known", value: failedProofs(graph) }),
    testReadiness: canonicalRecord({ kind: "known", value: deriveTestReadiness(graph, wave) }),
    reviewRuns: canonicalRecord({ kind: "known", value: reviews }),
    findingCounts: canonicalRecord({
      kind: "known",
      value: deriveFindingCounts(graph.tasks.filter((task) => task.wave === wave)),
    }),
    refutationPanelNeed: canonicalRecord({ kind: "known", value: panelNeed(graph, wave) }),
    waveCompletionSuiteReadiness: canonicalRecord({
      kind: "known",
      value: deriveWaveCompletionSuiteReadiness(graph, wave, currentWorkspace, currentResult),
    }),
    waveGateCompletionEligibility: canonicalRecord({ kind: "known", value: eligibility }),
  });
}

function persistedTerminalBlockedStatus(
  graph: TaskGraph,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
): LoomStatus | null {
  const registration = graph.active_wave_gate;
  if (registration?.terminalOutcome?.kind !== "terminal-blocked") return null;
  const built = blockedAction(registration.terminalOutcome.diagnostic);
  if (!built.ok) {
    return deriveUnavailableLoomStatus(Object.freeze([
      unavailableStatusReason(`cannot construct persisted terminal-blocked action: ${built.error.message}`),
    ]) as NonEmpty<StatusReason>);
  }
  const blockedReason = reason("blocked-diagnostic", registration.terminalOutcome.diagnostic.message);
  return canonicalRecord({
    schemaVersion: 1,
    facts: waveScopedStatusFacts(graph, registration.wave, canonicalRecord({
      kind: "ineligible",
      failedPrerequisites: Object.freeze([registration.terminalOutcome.diagnostic.message]) as NonEmpty<string>,
    }), currentWorkspace, currentResult),
    next: canonicalRecord({
      action: built.value,
      reasons: Object.freeze([blockedReason]) as NonEmpty<StatusReason>,
    }),
  });
}

function committedTerminalStatus(
  graph: TaskGraph,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
): LoomStatus | null {
  if (graph.active_wave_gate !== undefined || graph.current_wave === undefined) return null;
  const wave = graph.current_wave;
  const terminal = (graph.wave_gate_history ?? []).find((entry) => entry.wave === wave);
  if (terminal === undefined) return null;
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  const gate = graph.wave_gates[String(wave)];
  const exactTerminalGraph = waveTasks.length > 0 &&
    !graph.tasks.some((task) => task.wave > wave) &&
    waveTasks.every((task) => task.status === "completed") &&
    gate !== undefined && gate.impl_complete && gate.tests_passed === true && gate.reviews_complete && !gate.blocked;
  if (!exactTerminalGraph) return null;
  const receiptBytes = new TextEncoder().encode(JSON.stringify(terminal.completionReceipt));
  const receiptDigest = createHash("sha256").update(receiptBytes).digest("hex");
  const done = doneAction(terminal.runId, {
    runId: terminal.runId,
    slot: `receipts/${terminal.completionReceipt.effectId}.json`,
    digest: receiptDigest,
    byteLength: receiptBytes.byteLength,
  });
  if (!done.ok) {
    return deriveUnavailableLoomStatus(Object.freeze([
      unavailableStatusReason(`cannot construct committed terminal action: ${done.error.message}`),
    ]) as NonEmpty<StatusReason>);
  }
  const completeReason = reason("run-complete", `Wave Gate run ${terminal.runId} completed with committed revision ${terminal.revision}`);
  return canonicalRecord({
    schemaVersion: 1,
    facts: waveScopedStatusFacts(
      graph,
      wave,
      canonicalRecord({ kind: "eligible", failedPrerequisites: Object.freeze([]) as readonly [] }),
      currentWorkspace,
      currentResult,
    ),
    next: canonicalRecord({
      action: done.value,
      reasons: Object.freeze([completeReason]) as NonEmpty<StatusReason>,
    }),
  });
}

/**
 * The implementation window: an execute Wave whose Wave Gate has not been
 * registered yet.
 *
 * Completion retires the outgoing registration in the same commit that
 * advances `current_wave`, and the next registration only appears when the
 * gate is started — so every Wave spends its whole implementation span with
 * `active_wave_gate === undefined`. Routing that through the readiness path
 * reported a healthy graph as terminal invalid authority and blanked all
 * fact categories. Here the facts are derivable and the owed move is known, so
 * both are reported.
 *
 * Returns null for anything that is NOT this state, so genuinely contradictory
 * authority (absent `current_wave`, a Wave with no tasks, terminal history that
 * disagrees with the graph) still falls through and fails closed.
 */
function unstartedWaveStatus(
  graph: TaskGraph,
  deps: GateDeps,
): LoomStatus | null {
  if (graph.active_wave_gate !== undefined || graph.current_wave === undefined) return null;
  const wave = graph.current_wave;
  // A terminal receipt for the current Wave means this is not an unstarted
  // Wave. committedTerminalStatus already accepted the exact terminal graph;
  // reaching here with one is a contradiction, not an implementation window.
  if ((graph.wave_gate_history ?? []).some((entry) => entry.wave === wave)) return null;
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  if (waveTasks.length === 0) return null;

  const executing = new Set(graph.executing_tasks ?? []);
  const outstanding = waveTasks.filter((task) =>
    (task.status !== "implemented" && task.status !== "completed") ||
    executing.has(task.id) || task.active_implementation_attempt !== undefined);
  const observation = deps.implementationReservations;
  const reservationCandidates = outstanding.filter((task) =>
    executing.has(task.id) || task.active_implementation_attempt !== undefined);
  if (reservationCandidates.length > 0 && observation?.kind === "unavailable") {
    return deriveUnavailableLoomStatus(Object.freeze([
      unavailableStatusReason(
        `cannot determine implementation reservation liveness: ${observation.reason}`,
      ),
    ]) as NonEmpty<StatusReason>);
  }
  const reclaimable = observation?.kind === "observed"
    ? staleReservationsForRosterObservation(
        graph,
        { kind: "at-registration", anyActiveForGraph: observation.anyActiveForGraph },
        observation.observedAtMs,
      )
    : new Set<string>();
  const active = outstanding.filter((task) =>
    !reclaimable.has(task.id) &&
    (executing.has(task.id) || task.active_implementation_attempt !== undefined));
  const activeTaskIds = new Set(active.map((task) => task.id));
  const dispositions = outstanding.map((task) => ({
    task,
    disposition: deriveImplementationRetryDisposition(task),
  }));
  const invalid = dispositions.find(({ disposition }) => disposition.kind === "invalid");
  if (invalid?.disposition.kind === "invalid") {
    return deriveUnavailableLoomStatus(Object.freeze([
      reason(
        "authority-contradiction",
        `${invalid.task.id} has invalid implementation retry authority: ${invalid.disposition.errors.join("; ")}`,
        invalid.task.id,
      ),
    ]) as NonEmpty<StatusReason>);
  }
  const escalated = dispositions.flatMap(({ task, disposition }) =>
    disposition.kind === "escalated"
      ? [canonicalRecord({
          taskId: task.id,
          receiptId: disposition.receiptId,
          failureKinds: disposition.failureKinds as NonEmpty<string>,
        })]
      : []);
  const dispatches = dispositions.flatMap(({ task, disposition }): readonly WaveImplementationDispatch[] => {
    if (activeTaskIds.has(task.id)) return [];
    if (disposition.kind === "initial") {
      return [canonicalRecord({
        kind: "initial-implementation",
        taskId: task.id,
        semanticAttempt: 1,
        promptAppendix: null,
      })];
    }
    if (disposition.kind === "retry") {
      return [canonicalRecord({
        kind: "retry-implementation",
        taskId: task.id,
        semanticAttempt: 2,
        promptAppendix: disposition.promptAppendix,
      })];
    }
    return [];
  });
  let recovery: WaveImplementationRecovery;
  let message: string;
  if (outstanding.length === 0) {
    recovery = canonicalRecord({ kind: "start-wave-gate", wave });
    message = `Wave ${wave} implementation is complete and no Wave Gate run is registered; start the Wave Gate`;
  } else if (escalated.length > 0) {
    recovery = canonicalRecord({
      kind: "escalate-wave-implementation",
      wave,
      tasks: Object.freeze(escalated) as NonEmpty<(typeof escalated)[number]>,
    });
    message = `Wave ${wave} requires implementation escalation; ${escalated.length} task(s) exhausted semantic attempt 2`;
  } else if (dispatches.length > 0) {
    recovery = canonicalRecord({
      kind: "spawn-wave-implementation",
      wave,
      dispatches: Object.freeze(dispatches) as NonEmpty<WaveImplementationDispatch>,
    });
    message = `Wave ${wave} implementation is in progress; ${dispatches.length} task(s) are ready to dispatch` +
      (active.length === 0 ? "" : ` and ${active.length} task(s) remain active`);
  } else if (active.length > 0) {
    recovery = canonicalRecord({
      kind: "await-wave-implementation",
      wave,
      activeTaskIds: Object.freeze(active.map((task) => task.id)) as NonEmpty<string>,
    });
    message = `Wave ${wave} implementation is in progress; wait for ${active.length} active task(s)`;
  } else {
    return deriveUnavailableLoomStatus(Object.freeze([
      reason("authority-contradiction", `Wave ${wave} has outstanding Tasks but no legal implementation recovery`),
    ]) as NonEmpty<StatusReason>);
  }
  const reasons: StatusReason[] = outstanding.map((task) =>
    reason("wave-implementation-pending", `${task.id} has not reached implemented`, task.id));
  for (const task of active) {
    reasons.push(reason("task-running", `${task.id} already has active implementation authority`, task.id));
  }
  for (const task of escalated) {
    reasons.push(reason(
      "implementation-escalation-required",
      `${task.taskId} exhausted attempt 2: ${task.failureKinds.join(", ")}`,
      task.taskId,
    ));
  }
  reasons.push(reason("wave-gate-not-started", message));

  return canonicalRecord({
    schemaVersion: 1,
    facts: waveScopedStatusFacts(graph, wave, canonicalRecord({
      kind: "ineligible",
      failedPrerequisites: Object.freeze([message]) as NonEmpty<string>,
    }), deps.currentWaveWorkspace, deps.currentWaveCompletionResult),
    next: canonicalRecord({
      action: waveImplementationAction(message, recovery),
      reasons: Object.freeze(reasons) as NonEmpty<StatusReason>,
    }),
  });
}

/**
 * Status's own LC-1 pass, for the one stage where "resume the engine" is wrong.
 *
 * Of the four actions LC-1 can prove, three resolve to engine work: a review
 * batch, a blocked diagnostic, and a completed run are all things the engine
 * drives or that the terminal branches above already answer. The exception is
 * `awaiting-advisory-decision`, which is waiting on a PERSON. Reporting
 * "resume the engine" there tells the operator to do the one thing that cannot
 * unblock the run, and hides the decision that can.
 *
 * So status reduces LC-1 over the run's durable evidence and, only when the
 * stage is the advisory one, proves and reports the real await-user action.
 * Every other successfully projected stage falls through to the ordinary
 * readiness path — where "resume the engine" is the correct answer, not a
 * placeholder. A failed projection or proof returns explicit unavailable
 * status; `null` is reserved for a successfully proven non-advisory stage.
 */
function unavailableAdvisoryProjection(message: string): LoomStatus {
  return deriveUnavailableLoomStatus(Object.freeze([
    unavailableStatusReason(message),
  ]) as NonEmpty<StatusReason>);
}

function projectedAdvisoryStatus(
  graph: TaskGraph,
  deps: GateDeps,
  runDirectory: ActiveRunDirectoryObservation,
): LoomStatus | null {
  const snapshot = deriveWaveReadiness(graph, deps);
  if (!snapshot.ok) return deriveUnavailableLoomStatus(snapshot.error.reasons);
  const counts = snapshot.value.facts.findingCounts;
  const runs = snapshot.value.facts.reviewRuns;
  if (counts.kind !== "known" || runs.kind !== "known") {
    return unavailableAdvisoryProjection(
      "LC-1 advisory projection requires canonical Finding and Review Run facts",
    );
  }

  const rosterComplete = runs.value.rosterGaps.length === 0 && runs.value.evidenceFailures.length === 0;
  const evidence: WaveGateLifecycleEvidence = canonicalRecord({
    // A complete roster necessarily implies the batch was published, so an
    // active Review Run is sufficient evidence but not required — a wave whose
    // reviews already landed must not read as still `preparing`.
    batchPublished: rosterComplete || snapshot.value.waveTasks.some((task) => task.review_run !== undefined),
    acceptedResults: 0,
    rejectedAttempt: null,
    rosterComplete,
    activeCritical: counts.value.activeCritical,
    advisoryCount: counts.value.advisory,
    advisoryApproved: runDirectory.kind === "present" && runDirectory.advisoryApproval?.kind === "approved",
    committed: null,
  });

  const state = projectWaveGateLifecycle(snapshot.value, evidence);
  if (!state.ok) {
    return unavailableAdvisoryProjection(`cannot project LC-1 advisory lifecycle: ${state.error.message}`);
  }
  if (state.value.kind !== "awaiting-advisory-decision") return null;
  const proven = deriveWaveAdvisoryNextAction(snapshot.value, state.value);
  if (!proven.ok) {
    return unavailableAdvisoryProjection(`cannot prove LC-1 advisory action: ${proven.error.message}`);
  }

  const bound = deriveWaveReadiness(graph, deps, canonicalRecord({
    nextActionAuthority: proven.value,
    lifecycleCheckpoint: state.value,
  }));
  return bound.ok
    ? deriveLoomStatus(bound.value)
    : unavailableAdvisoryProjection(
        `cannot bind LC-1 advisory action to protected readiness: ${bound.error.reasons.map(({ message }) => message).join("; ")}`,
      );
}

/** Anti-corruption adapter from the protected-state parser into the canonical status contract. */
export function deriveLoomStatusFromParsedGraph(
  parsed: Readonly<{ ok: true; value: TaskGraph }> | Readonly<{ ok: false; error: string }>,
  deps: GateDeps,
  lifecycleProof: WaveLifecycleProof | null = null,
  runDirectory: ActiveRunDirectoryObservation = canonicalRecord({ kind: "unverified" }),
): LoomStatus {
  if (!parsed.ok) {
    return deriveUnavailableLoomStatus(Object.freeze([
      unavailableStatusReason(`protected authority is malformed: ${parsed.error}`),
    ]) as NonEmpty<StatusReason>);
  }
  if (parsed.value.current_phase !== "execute") {
    return deriveNonExecuteLoomStatus(
      parsed.value,
      deps.currentWaveWorkspace,
      deps.currentWaveCompletionResult,
    );
  }
  const active = parsed.value.active_wave_gate;
  if (active?.terminalOutcome === null && runDirectory.kind !== "unverified") {
    if (runDirectory.runId !== active.runId) {
      return deriveUnavailableLoomStatus(Object.freeze([
        unavailableStatusReason(`Run Directory observation belongs to ${runDirectory.runId}, not active run ${active.runId}`),
      ]) as NonEmpty<StatusReason>);
    }
    if (runDirectory.kind === "absent") {
      return deriveUnavailableLoomStatus(Object.freeze([
        unavailableStatusReason(
          `orphaned active Wave Gate run ${active.runId}: authoritative Run Directory does not exist at ${runDirectory.path}; ` +
          `recover with exact wave ${active.wave} and authority digest ${active.authorityDigest}`,
        ),
      ]) as NonEmpty<StatusReason>);
    }
    if (runDirectory.kind === "invalid") {
      return deriveUnavailableLoomStatus(Object.freeze([
        unavailableStatusReason(`cannot verify authoritative Run Directory ${runDirectory.path}: ${runDirectory.message}`),
      ]) as NonEmpty<StatusReason>);
    }
    if (runDirectory.kind === "present" && runDirectory.advisoryApproval?.kind === "unavailable") {
      return deriveUnavailableLoomStatus(Object.freeze([
        unavailableStatusReason(
          `cannot determine advisory approval for Wave Gate run ${active.runId}: ${runDirectory.advisoryApproval.reason}`,
        ),
      ]) as NonEmpty<StatusReason>);
    }
  }
  const persistedBlocked = persistedTerminalBlockedStatus(
    parsed.value,
    deps.currentWaveWorkspace,
    deps.currentWaveCompletionResult,
  );
  if (persistedBlocked !== null) return persistedBlocked;
  const committed = committedTerminalStatus(
    parsed.value,
    deps.currentWaveWorkspace,
    deps.currentWaveCompletionResult,
  );
  if (committed !== null) return committed;
  // Before the readiness path, which requires a registration: an execute Wave
  // legitimately has none for its whole implementation span.
  const unstarted = unstartedWaveStatus(parsed.value, deps);
  if (unstarted !== null) return unstarted;
  if (lifecycleProof === null) {
    const projected = projectedAdvisoryStatus(parsed.value, deps, runDirectory);
    if (projected !== null) return projected;
  }
  const readiness = deriveWaveReadiness(parsed.value, deps, lifecycleProof);
  return readiness.ok
    ? deriveLoomStatus(readiness.value)
    : deriveUnavailableLoomStatus(readiness.error.reasons);
}

/** Versioned machine renderer. It serializes the canonical read model and
 * contains no readiness or action policy. */
export function renderLoomStatusJson(status: LoomStatus): string {
  return JSON.stringify(status, null, 2);
}

/** Versioned human renderer over the same value used by the JSON renderer. */
export function renderLoomStatusHuman(status: LoomStatus): string {
  const fact = (name: keyof CanonicalStatusFacts): string => {
    const value = status.facts[name];
    return value.kind === "known"
      ? `- ${name}: ${JSON.stringify(value.value)}`
      : `- ${name}: unavailable (${value.reasons.map(({ message }) => message).join("; ")})`;
  };
  const categories: readonly (keyof CanonicalStatusFacts)[] = [
    "location",
    "tasks",
    "failedProofObligations",
    "testReadiness",
    "reviewRuns",
    "findingCounts",
    "refutationPanelNeed",
    "waveCompletionSuiteReadiness",
    "waveGateCompletionEligibility",
  ];
  return [
    `Loom Status v${status.schemaVersion}`,
    ...categories.map(fact),
    `- nextAction: ${status.next.action.kind}`,
    `- nextActionPayload: ${JSON.stringify(status.next.action)}`,
    "- reasons:",
    ...status.next.reasons.map((entry) => `  - [${entry.kind}] ${entry.message}`),
  ].join("\n");
}
