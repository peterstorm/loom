/**
 * The canonical Loom status read model and its renderers.
 *
 * `deriveLoomStatusFromParsedGraph` is the one entry point: it routes a parsed
 * protected graph to exactly one status branch (non-execute, terminal,
 * implementation window, advisory decision, or the ordinary readiness path)
 * and never repeats gate policy — every fact comes from `wave-status-facts`,
 * every gate verdict from `wave-gate-checks`, and every proven action from the
 * proof-carrying snapshot in `wave-gate-machine`. The renderers serialize the
 * value and contain no readiness or action policy.
 */

import { match, P } from "ts-pattern";
import type {
  CanonicalStatusFacts,
  EngineResumeAction,
  LoomStatus,
  NextActionDecision,
  StatusReason,
  TaskGraph,
  WaveGateCompletionEligibility,
  WaveGateNextAction,
  WaveImplementationAction,
  WaveImplementationDispatch,
  WaveImplementationRecovery,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../types";
import { sha256Bytes } from "./digest";
import { staleReservationsForRosterObservation } from "./validate-task-execution";
import { renderProjectVerificationCoverage } from "./verification-manifest";
import {
  blockedAction,
  canonicalRecord,
  doneAction,
  parseOrchestrationRunId,
  terminalBlockedDiagnostic,
  type ExternalAction,
  type NonEmpty,
  type OrchestrationRunId,
} from "./orchestration-contract";
import { deriveWaveStartReadiness, type GateDeps } from "./wave-gate-checks";
import { deriveWaveCompletionSuiteReadiness } from "./wave-completion-suite-readiness";
import {
  deriveWaveReadiness,
  isCanonicalWaveReadiness,
  projectWaveGateLifecycle,
  snapshotActionProofIsExact,
  type WaveGateLifecycleEvidence,
  type WaveLifecycleProof,
  type WaveReadinessSnapshot,
} from "./wave-gate-machine";
import { deriveWaveAdvisoryNextAction } from "./wave-gate-preparation";
import {
  deriveFindingCounts,
  deriveTestReadiness,
  deriveTestReadinessForTasks,
  failedProofs,
  panelNeed,
  reviewFacts,
  statusReason,
  taskCounts,
} from "./wave-status-facts";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";

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
  const terminalRetry = canonicalRecord({
    kind: "advance-wave-lifecycle" as const,
    eligible: false as const,
    consumesSemanticAttempt: false as const,
  });
  const diagnostic: WaveImplementationAction["diagnostic"] = match(recovery)
    .with({ kind: "escalate-wave-implementation" }, (escalation) => canonicalRecord({
      kind: "implementation-escalation-required" as const,
      category: "semantic-attempts-exhausted" as const,
      ...common,
      retry: terminalRetry,
      recovery: escalation,
    }))
    .with({ kind: "repair-wave-start-readiness" }, (repair) => canonicalRecord({
      kind: "wave-start-not-ready" as const,
      category: "wave-start-prerequisites-unmet" as const,
      ...common,
      retry: terminalRetry,
      recovery: repair,
    }))
    .with(
      { kind: P.union("spawn-wave-implementation", "await-wave-implementation", "start-wave-gate") },
      (healthy) => canonicalRecord({
        kind: "wave-gate-not-started" as const,
        category: "healthy-wave-unstarted" as const,
        ...common,
        retry: canonicalRecord({
          kind: "advance-wave-lifecycle" as const,
          eligible: true as const,
          consumesSemanticAttempt: false as const,
        }),
        recovery: healthy,
      }),
    )
    .exhaustive();
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


/** Why the proven authority selected this action. One arm per authority kind. */
function nextActionReason(
  authority: WaveGateNextAction,
  action: NextActionDecision["action"],
): StatusReason {
  if (authority.kind === "advisory-decision") {
    return statusReason(
      "advisory-decision-required",
      `${action.kind === "await-user" ? action.request.advisories.length : 0} advisory artifact(s) require a user decision`,
    );
  }
  if (authority.kind === "review-batch") {
    return statusReason(
      "review-spawn-required",
      `${action.kind === "spawn-batch" ? action.requests.length : 0} exact review request(s) are ready to spawn`,
    );
  }
  if (authority.kind === "blocked") {
    return statusReason("blocked-diagnostic", action.kind === "blocked" ? action.diagnostic.message : "Wave Gate is blocked");
  }
  return statusReason("run-complete", `Wave Gate run ${action.runId} is complete`);
}

/** Exactly one action, selected only from the shared readiness snapshot. A
 * copied/stale proof fails closed even if a caller bypasses deriveWaveReadiness. */
export function deriveNextAction(snapshot: WaveReadinessSnapshot): NextActionDecision {
  let action: NextActionDecision["action"];
  let actionReason: StatusReason;
  if (!isCanonicalWaveReadiness(snapshot) || !snapshotActionProofIsExact(snapshot)) {
    const message = "Wave next action proof is stale or disconnected from the exact protected snapshot";
    action = invalidAuthorityBlockedAction(snapshot.registration.runId, message);
    actionReason = statusReason("authority-contradiction", message);
  } else if (snapshot.nextActionAuthority !== null) {
    action = snapshot.nextActionAuthority.action;
    actionReason = nextActionReason(snapshot.nextActionAuthority, action);
  } else {
    action = engineResumeAction(snapshot.registration.runId);
    actionReason = statusReason(
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

/** Fail-closed status for one unavailable reason. */
function unavailableStatus(message: string): LoomStatus {
  return deriveUnavailableLoomStatus([unavailableStatusReason(message)]);
}

/** Fail-closed status retains the complete fact inventory; no zero/ready value is fabricated. */
function deriveUnavailableLoomStatus(rawReasons: NonEmpty<StatusReason>): LoomStatus {
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

function unavailableStatusReason(message: string): StatusReason {
  return statusReason("authority-unavailable", message);
}

function deriveNonExecuteLoomStatus(
  graph: TaskGraph,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
): LoomStatus {
  const noWaveReason = statusReason(
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
    return unavailableStatus(`cannot construct persisted terminal-blocked action: ${built.error.message}`);
  }
  const blockedReason = statusReason("blocked-diagnostic", registration.terminalOutcome.diagnostic.message);
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
  const receiptDigest = sha256Bytes(receiptBytes);
  const done = doneAction(terminal.runId, {
    runId: terminal.runId,
    slot: `receipts/${terminal.completionReceipt.effectId}.json`,
    digest: receiptDigest,
    byteLength: receiptBytes.byteLength,
  });
  if (!done.ok) {
    return unavailableStatus(`cannot construct committed terminal action: ${done.error.message}`);
  }
  const completeReason = statusReason("run-complete", `Wave Gate run ${terminal.runId} completed with committed revision ${terminal.revision}`);
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
 * The implementation window: an execute Wave without a live Wave Gate.
 *
 * Completion retires the outgoing registration in the same commit that
 * advances `current_wave`, and the next registration only appears when the
 * gate is started — so every Wave spends its whole implementation span with
 * `active_wave_gate === undefined`. A terminal-abandoned Run without a named
 * successor also leaves the Wave in this window: its protected tombstone is
 * retained, but cannot authorize review or block a Task retry. Routing either
 * case through the readiness path reported invalid authority and blanked all
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
  if (graph.current_wave === undefined) return null;
  const registration = graph.active_wave_gate;
  if (registration !== undefined &&
      (registration.wave !== graph.current_wave || registration.terminalOutcome?.kind !== "terminal-abandoned" ||
        registration.terminalOutcome.supersededBy !== null)) return null;
  const wave = graph.current_wave;
  // A terminal receipt for the current Wave means this is not an unstarted
  // Wave. committedTerminalStatus already accepted the exact terminal graph;
  // reaching here with one is a contradiction, not an implementation window.
  if ((graph.wave_gate_history ?? []).some((entry) => entry.wave === wave)) return null;
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  if (waveTasks.length === 0) return null;

  const executing = new Set(graph.executing_tasks ?? []);
  const completedReservation = waveTasks.find((task) =>
    task.status === "completed" &&
    (executing.has(task.id) || task.active_implementation_attempt !== undefined));
  if (completedReservation !== undefined) {
    return deriveUnavailableLoomStatus([
      statusReason(
        "authority-contradiction",
        `${completedReservation.id} is completed but retains implementation reservation authority; repair the Task Graph`,
        completedReservation.id,
      ),
    ]);
  }
  const outstanding = waveTasks.filter((task) =>
    (task.status !== "implemented" && task.status !== "completed") ||
    executing.has(task.id) || task.active_implementation_attempt !== undefined);
  const observation = deps.implementationReservations;
  const reservationCandidates = outstanding.filter((task) =>
    executing.has(task.id) || task.active_implementation_attempt !== undefined);
  const nonCurrentReservation = reservationCandidates.find((task) =>
    task.reserved_at === undefined || Number.isNaN(Date.parse(task.reserved_at)));
  if (nonCurrentReservation !== undefined) {
    return deriveUnavailableLoomStatus([
      statusReason(
        "authority-contradiction",
        `${nonCurrentReservation.id} has timestamp-less legacy implementation authority that canonical status cannot reclaim; repair or migrate the Task Graph`,
        nonCurrentReservation.id,
      ),
    ]);
  }
  if (reservationCandidates.length > 0 && observation?.kind === "unavailable") {
    return unavailableStatus(
      `cannot determine implementation reservation liveness: ${observation.reason}`,
    );
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
  const derivations = outstanding.map((task) => ({ task, derivation: deriveTaskImplementationDispatch(task) }));
  const invalidRetry = derivations.find(({ derivation }) => derivation.kind === "invalid-retry");
  if (invalidRetry?.derivation.kind === "invalid-retry") {
    return deriveUnavailableLoomStatus([
      statusReason(
        "authority-contradiction",
        `${invalidRetry.task.id} has invalid implementation retry authority: ${invalidRetry.derivation.errors.join("; ")}`,
        invalidRetry.task.id,
      ),
    ]);
  }
  const escalated = derivations.flatMap(({ task, derivation }) =>
    derivation.kind === "escalated"
      ? [canonicalRecord({ taskId: task.id, receiptId: derivation.receiptId, failureKinds: derivation.failureKinds })]
      : []);
  const invalidAttestation = derivations.find(({ derivation }) => derivation.kind === "invalid-attestation");
  if (invalidAttestation?.derivation.kind === "invalid-attestation") {
    return deriveUnavailableLoomStatus([
      statusReason(
        "authority-contradiction",
        `${invalidAttestation.task.id} attestation mode could not derive its attestation context: ${invalidAttestation.derivation.error}`,
        invalidAttestation.task.id,
      ),
    ]);
  }
  const dispatches = derivations.flatMap(({ task, derivation }): readonly WaveImplementationDispatch[] =>
    derivation.kind === "dispatch" && !activeTaskIds.has(task.id) ? [derivation.dispatch] : []);
  let recovery: WaveImplementationRecovery;
  let message: string;
  const startReadiness = outstanding.length === 0 ? deriveWaveStartReadiness(graph, waveTasks) : null;
  if (startReadiness?.kind === "not-ready") {
    recovery = canonicalRecord({ kind: "repair-wave-start-readiness", wave, failures: startReadiness.failures });
    message = `Wave ${wave} implementation stopped but the Wave Gate cannot start: ${startReadiness.failures.join("; ")}`;
  } else if (startReadiness?.kind === "ready") {
    recovery = canonicalRecord({ kind: "start-wave-gate", wave });
    message = `Wave ${wave} implementation is complete and no Wave Gate run is registered; start the Wave Gate`;
  } else if (escalated.length > 0) {
    recovery = canonicalRecord({
      kind: "escalate-wave-implementation",
      wave,
      tasks: Object.freeze(escalated) as NonEmpty<(typeof escalated)[number]>,
    });
    message = `Wave ${wave} requires implementation escalation; ${escalated.length} task(s) reached a terminal implementation failure`;
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
    return deriveUnavailableLoomStatus([
      statusReason("authority-contradiction", `Wave ${wave} has outstanding Tasks but no legal implementation recovery`),
    ]);
  }
  const reasons: StatusReason[] = outstanding.flatMap((task) =>
    task.status === "implemented"
      ? []
      : [statusReason("wave-implementation-pending", `${task.id} has not reached implemented`, task.id)]);
  for (const task of active) {
    reasons.push(statusReason("task-running", `${task.id} already has active implementation authority`, task.id));
  }
  for (const task of escalated) {
    reasons.push(statusReason(
      "implementation-escalation-required",
      `${task.taskId} reached terminal implementation failure: ${task.failureKinds.join(", ")}`,
      task.taskId,
    ));
  }
  reasons.push(statusReason(recovery.kind === "repair-wave-start-readiness" ? "wave-start-not-ready" : "wave-gate-not-started", message));

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
    return unavailableStatus(
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
    return unavailableStatus(`cannot project LC-1 advisory lifecycle: ${state.error.message}`);
  }
  if (state.value.kind !== "awaiting-advisory-decision") return null;
  const proven = deriveWaveAdvisoryNextAction(snapshot.value, state.value);
  if (!proven.ok) {
    return unavailableStatus(`cannot prove LC-1 advisory action: ${proven.error.message}`);
  }

  const bound = deriveWaveReadiness(graph, deps, canonicalRecord({
    nextActionAuthority: proven.value,
    lifecycleCheckpoint: state.value,
  }));
  return bound.ok
    ? deriveLoomStatus(bound.value)
    : unavailableStatus(
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
    return unavailableStatus(`protected authority is malformed: ${parsed.error}`);
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
      return unavailableStatus(`Run Directory observation belongs to ${runDirectory.runId}, not active run ${active.runId}`);
    }
    if (runDirectory.kind === "absent") {
      return unavailableStatus(
        `orphaned active Wave Gate run ${active.runId}: authoritative Run Directory does not exist at ${runDirectory.path}; ` +
        `recover with exact wave ${active.wave} and authority digest ${active.authorityDigest}`,
      );
    }
    if (runDirectory.kind === "invalid") {
      return unavailableStatus(`cannot verify authoritative Run Directory ${runDirectory.path}: ${runDirectory.message}`);
    }
    if (runDirectory.kind === "present" && runDirectory.advisoryApproval?.kind === "unavailable") {
      return unavailableStatus(
        `cannot determine advisory approval for Wave Gate run ${active.runId}: ${runDirectory.advisoryApproval.reason}`,
      );
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
  // Before the readiness path, which requires a live registration: an execute
  // Wave may have no registration or only an abandoned Run tombstone.
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

function projectCoverageDiagnostic(status: LoomStatus): readonly string[] {
  const fact = status.facts.waveCompletionSuiteReadiness;
  if (fact.kind === "unavailable" || fact.value.kind === "legacy-unavailable") return [];
  return [`- ${renderProjectVerificationCoverage(fact.value.projectVerificationCoverage)}`];
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
    ...projectCoverageDiagnostic(status),
    `- nextAction: ${status.next.action.kind}`,
    `- nextActionPayload: ${JSON.stringify(status.next.action)}`,
    "- reasons:",
    ...status.next.reasons.map((entry) => `  - [${entry.kind}] ${entry.message}`),
  ].join("\n");
}
