/**
 * The Wave Gate lifecycle machine (LC-1) and the proof-carrying authority it
 * is connected to.
 *
 * Four values here are unforgeable: a canonical readiness snapshot
 * (`deriveWaveReadiness`), a lifecycle checkpoint (`createWaveGateState` and
 * the reducer), a proven next action (`proveWaveGateNextAction`) and the
 * completion commit derived from a readiness snapshot. Each is minted only in
 * this module and recognised by identity, and they cross-check one another —
 * the completion transition needs the readiness proof, readiness binds a
 * lifecycle checkpoint and next-action proof — so they share one module rather
 * than an import cycle or an exported minting door. Other modules recognise
 * the proofs through the read-only predicates `isCanonicalWaveReadiness` and
 * `snapshotActionProofIsExact`; none can mint one.
 *
 * Gate evaluation lives in `wave-gate-checks`, post-review action preparation
 * in `wave-gate-preparation`, and the status read model in `loom-status`.
 */

import type {
  ActiveWaveGateRegistration,
  CanonicalStatusFacts,
  CompletedWaveGateRegistration,
  StatusReason,
  Task,
  TaskGraph,
  WaveGateNextAction,
  WaveGateProtectedSnapshotBinding,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../types";
import { sha256Hex } from "./digest";
import {
  canonicalRecord,
  parseArtifactDigest,
  parseEffectId,
  reconcileEffectReceipt,
  type ArtifactDigest,
  type CommitProtectedWaveState,
  type DomainResult,
  type EffectIntent,
  type EffectReceipt,
  type ExternalAction,
  type InfrastructureRetryDiagnostic,
  type NonEmpty,
  type OrchestrationRunId,
  type ProtectedWaveStateCommitted,
} from "./orchestration-contract";
import { applyGateDecision, evaluateWaveGate, type GateDecision, type GateDeps } from "./wave-gate-checks";
import { deriveWaveCompletionSuiteReadiness } from "./wave-completion-suite-readiness";
import {
  completionEligibility,
  deriveFindingCounts,
  deriveTestReadiness,
  failedProofs,
  nonEmptyReasons,
  panelNeed,
  readinessReasons,
  reviewFacts,
  statusReason,
  taskCounts,
} from "./wave-status-facts";

// ---------------------------------------------------------------------------
// LC-1: closed Wave Gate lifecycle reducer
// ---------------------------------------------------------------------------

const waveReadinessProofs = new WeakSet<object>();

type WaveGateLifecycleCheckpoint = Readonly<{
  runId: OrchestrationRunId;
  registrationRevision: number;
  authorityDigest: ArtifactDigest;
  readinessDigest: ArtifactDigest;
  checkpointDigest: ArtifactDigest;
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

function parseLifecycleDigest(value: string): ArtifactDigest {
  const parsed = parseArtifactDigest(sha256Hex(value));
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
function replayWaveGateTransition(
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
// Canonical readiness snapshot, next-action proof and completion commit
// ---------------------------------------------------------------------------

export type WaveReadinessSnapshot = Readonly<{
  graph: TaskGraph;
  registration: ActiveWaveGateRegistration;
  wave: number;
  waveTasks: readonly Task[];
  gateDecision: GateDecision;
  facts: CanonicalStatusFacts;
  readinessDigest: ArtifactDigest;
  completionIntent: CommitProtectedWaveState;
  nextActionAuthority: WaveGateNextAction | null;
  lifecycleCheckpointDigest: ArtifactDigest | null;
  currentWaveWorkspaceObservation: WaveWorkspaceObservation | null;
  currentWaveCompletionResultObservation: WaveCompletionResultObservation | null;
  reasons: NonEmpty<StatusReason>;
}>;

const waveNextActionProofs = new WeakSet<object>();

export type WaveGateNextActionError = Readonly<{
  kind: "wave-gate-next-action-rejected";
  message: string;
}>;

const nextActionFailure = (message: string): DomainResult<WaveGateNextAction, WaveGateNextActionError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-gate-next-action-rejected", message }) });

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
    return nextActionFailure("next action lifecycle is disconnected from the exact protected Wave readiness snapshot");
  }
  if (action.runId !== state.runId) {
    return nextActionFailure("next action belongs to a different Wave Gate run");
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
    return nextActionFailure(`${action.kind} is not authorized from Wave Gate lifecycle state ${state.kind}`);
  }
  waveNextActionProofs.add(proven);
  return canonicalRecord({ ok: true, value: proven });
}

function completionAuthority(
  graph: TaskGraph,
  registration: ActiveWaveGateRegistration,
  decision: GateDecision,
  currentWaveWorkspaceObservation: WaveWorkspaceObservation | null,
  currentWaveCompletionResultObservation: WaveCompletionResultObservation | null,
): Readonly<{
  readinessDigest: ArtifactDigest;
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
  const rawDigest = sha256Hex(serialized);
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
    failures.push(statusReason("authority-unavailable", "execute Phase requires current_wave authority"));
  }
  if (registration === undefined) failures.push(statusReason("authority-unavailable", "active Wave Gate registration is missing"));
  if (registration !== undefined && registration.wave !== graph.current_wave) {
    failures.push(statusReason("authority-contradiction", `active Wave Gate wave ${registration.wave} does not match current wave ${graph.current_wave ?? "missing"}`));
  }
  if (registration?.terminalOutcome !== null && registration !== undefined) {
    failures.push(statusReason("authority-contradiction", "terminal Wave Gate history cannot serve as active current-Wave authority"));
  }
  if (failures.length > 0 || registration === undefined) {
    return canonicalRecord({
      ok: false,
      error: canonicalRecord({
        kind: "wave-readiness-unavailable",
        reasons: nonEmptyReasons(failures, statusReason("authority-unavailable", "Wave Gate authority is unavailable")),
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
          reasons: Object.freeze([statusReason(
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
          reasons: Object.freeze([statusReason(
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

const commitFailure = (message: string): DomainResult<WaveCompletionCommit, WaveCompletionCommitError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-completion-commit-rejected", message }) });

/** Pure atomic payload: shell persists this graph and returns this receipt in
 * one StateManager transaction. No task/wave mutation is exposed separately. */
export function commitWaveGateCompletion(
  snapshot: WaveReadinessSnapshot,
): DomainResult<WaveCompletionCommit, WaveCompletionCommitError> {
  if (!waveReadinessProofs.has(snapshot)) {
    return commitFailure("completion requires a parser-derived canonical readiness proof");
  }
  if (snapshot.graph.active_wave_gate !== snapshot.registration) {
    return commitFailure("snapshot graph active_wave_gate is not the exact readiness registration");
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
    return commitFailure("completion readiness authority drifted after proof derivation");
  }
  if (snapshot.gateDecision.verdict.kind !== "pass") {
    const eligibility = snapshot.facts.waveGateCompletionEligibility;
    const failures = eligibility.kind === "known" && eligibility.value.kind === "ineligible"
      ? eligibility.value.failedPrerequisites
      : [snapshot.gateDecision.verdict.reason];
    return commitFailure(`completion readiness is ineligible: ${failures.join("; ")}`);
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
    return commitFailure(reconciled.ok ? "completion produced the wrong receipt kind" : reconciled.error.message);
  }
  const advanced = applyGateDecision(snapshot.graph, snapshot.gateDecision);
  if (advanced === snapshot.graph) {
    return commitFailure("locked active/current Wave authority drifted before completion");
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
    return commitFailure(`Wave Gate run ${completedRegistration.runId} is already terminal in history`);
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

/** Read-only recognition of a canonical readiness snapshot. Only
 * `deriveWaveReadiness` mints one; a copied or hand-built value is never
 * recognised. */
export function isCanonicalWaveReadiness(snapshot: WaveReadinessSnapshot): boolean {
  return waveReadinessProofs.has(snapshot);
}

/** Whether the snapshot's embedded next-action proof is still the exact one
 * bound to its registration, readiness digest and lifecycle checkpoint. */
export function snapshotActionProofIsExact(snapshot: WaveReadinessSnapshot): boolean {
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
