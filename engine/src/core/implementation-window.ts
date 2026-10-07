/**
 * The implementation window's policy: an execute Wave without a live Wave
 * Gate, classified into exactly one closed outcome.
 *
 * Completion retires the outgoing registration in the same commit that
 * advances `current_wave`, and the next registration only appears when the
 * gate is started, so every Wave spends its whole implementation span with
 * `active_wave_gate === undefined`. A terminal-abandoned Run without a named
 * successor also leaves the Wave in this window: its protected tombstone is
 * retained, but cannot authorize review or block a Task retry.
 *
 * Every policy decision of the window lives here: which outstanding Tasks hold
 * active implementation authority, which reservations are reclaimable, which
 * Tasks escalated or are dispatchable, and which one recovery follows. The
 * status projection (`loom-status.ts`) only renders the outcome. Pure: the
 * shell supplies the reservation-liveness observation.
 */
import type { StatusReason, TaskGraph, WaveImplementationDispatch, WaveImplementationRecovery } from "../types";
import { canonicalRecord, type NonEmpty } from "./orchestration-contract";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";
import { staleReservationsForRosterObservation } from "./validate-task-execution";
import { deriveWaveStartReadiness } from "./wave-gate-checks";
import { statusReason } from "./wave-status-facts";

/** Shell observation used only to make policy-expired reservations
 * dispatchable again. Absence or unavailability keeps them active, fail-closed. */
export type ImplementationReservationStatusObservation =
  | Readonly<{ kind: "observed"; observedAtMs: number; anyActiveForGraph: boolean }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** One Task that reached a terminal implementation failure. */
export type EscalatedImplementation = Readonly<{
  taskId: string;
  receiptId: string;
  failureKinds: NonEmpty<string>;
}>;

export type ImplementationWindow =
  /** The graph is not in the implementation window; status takes another branch. */
  | Readonly<{ kind: "not-in-window" }>
  /** Protected authority contradicts itself, so status is unavailable for this reason. */
  | Readonly<{ kind: "contradiction"; reason: StatusReason }>
  /** An observation the window depends on is unavailable. */
  | Readonly<{ kind: "unavailable"; message: string }>
  /** The window and its one legal recovery, with the Tasks the recovery is about. */
  | Readonly<{
      kind: "window";
      wave: number;
      recovery: WaveImplementationRecovery;
      message: string;
      /** Outstanding Tasks that have not reached `implemented`, in graph order. */
      pendingTaskIds: readonly string[];
      /** Outstanding Tasks still holding unreclaimable implementation authority. */
      activeTaskIds: readonly string[];
      escalated: readonly EscalatedImplementation[];
    }>;

const notInWindow: ImplementationWindow = Object.freeze({ kind: "not-in-window" });

const contradiction = (message: string, taskId: string | null = null): ImplementationWindow =>
  canonicalRecord({ kind: "contradiction", reason: statusReason("authority-contradiction", message, taskId) });

/**
 * Classify a parsed protected graph against the implementation window.
 *
 * `not-in-window` covers everything that is NOT this state, so genuinely
 * contradictory authority (absent `current_wave`, a Wave with no Tasks,
 * terminal history that disagrees with the graph) falls through and fails
 * closed elsewhere.
 */
export function classifyImplementationWindow(
  graph: TaskGraph,
  observation: ImplementationReservationStatusObservation | undefined,
): ImplementationWindow {
  if (graph.current_wave === undefined) return notInWindow;
  const registration = graph.active_wave_gate;
  if (registration !== undefined &&
      (registration.wave !== graph.current_wave || registration.terminalOutcome?.kind !== "terminal-abandoned" ||
        registration.terminalOutcome.supersededBy !== null)) return notInWindow;
  const wave = graph.current_wave;
  // A terminal receipt for the current Wave means this is not an unstarted
  // Wave. The committed-terminal branch already accepted the exact terminal
  // graph; reaching here with one is a contradiction, not an implementation window.
  if ((graph.wave_gate_history ?? []).some((entry) => entry.wave === wave)) return notInWindow;
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  if (waveTasks.length === 0) return notInWindow;

  const executing = new Set(graph.executing_tasks ?? []);
  const holdsReservation = (task: TaskGraph["tasks"][number]): boolean =>
    executing.has(task.id) || task.active_implementation_attempt !== undefined;
  const completedReservation = waveTasks.find((task) => task.status === "completed" && holdsReservation(task));
  if (completedReservation !== undefined) {
    return contradiction(
      `${completedReservation.id} is completed but retains implementation reservation authority; repair the Task Graph`,
      completedReservation.id,
    );
  }
  const outstanding = waveTasks.filter((task) =>
    (task.status !== "implemented" && task.status !== "completed") || holdsReservation(task));
  const reservationCandidates = outstanding.filter(holdsReservation);
  const nonCurrentReservation = reservationCandidates.find((task) =>
    task.reserved_at === undefined || Number.isNaN(Date.parse(task.reserved_at)));
  if (nonCurrentReservation !== undefined) {
    return contradiction(
      `${nonCurrentReservation.id} has timestamp-less legacy implementation authority that canonical status cannot reclaim; repair or migrate the Task Graph`,
      nonCurrentReservation.id,
    );
  }
  if (reservationCandidates.length > 0 && observation?.kind === "unavailable") {
    return canonicalRecord({
      kind: "unavailable",
      message: `cannot determine implementation reservation liveness: ${observation.reason}`,
    });
  }
  const reclaimable = observation?.kind === "observed"
    ? staleReservationsForRosterObservation(
        graph,
        { kind: "at-registration", anyActiveForGraph: observation.anyActiveForGraph },
        observation.observedAtMs,
      )
    : new Set<string>();
  const active = outstanding.filter((task) => !reclaimable.has(task.id) && holdsReservation(task));
  const activeIds = Object.freeze(active.map((task) => task.id));
  const activeTaskIds = new Set(activeIds);
  const derivations = outstanding.map((task) => ({ task, derivation: deriveTaskImplementationDispatch(task) }));
  // `flatMap` narrows the derivation in the arm that keeps it, so the first
  // match of each kind arrives already typed — graph order, first one wins.
  const invalidRetry = derivations.flatMap(({ task, derivation }) =>
    derivation.kind === "invalid-retry" ? [{ task, derivation }] : []).at(0);
  if (invalidRetry !== undefined) {
    return contradiction(
      `${invalidRetry.task.id} has invalid implementation retry authority: ${invalidRetry.derivation.errors.join("; ")}`,
      invalidRetry.task.id,
    );
  }
  const escalated = derivations.flatMap(({ task, derivation }): readonly EscalatedImplementation[] =>
    derivation.kind === "escalated"
      ? [canonicalRecord({ taskId: task.id, receiptId: derivation.receiptId, failureKinds: derivation.failureKinds })]
      : []);
  const invalidAttestation = derivations.flatMap(({ task, derivation }) =>
    derivation.kind === "invalid-attestation" ? [{ task, derivation }] : []).at(0);
  if (invalidAttestation !== undefined) {
    return contradiction(
      `${invalidAttestation.task.id} attestation mode could not derive its attestation context: ${invalidAttestation.derivation.error}`,
      invalidAttestation.task.id,
    );
  }
  const dispatches = derivations.flatMap(({ task, derivation }): readonly WaveImplementationDispatch[] =>
    derivation.kind === "dispatch" && !activeTaskIds.has(task.id) ? [derivation.dispatch] : []);

  const window = (recovery: WaveImplementationRecovery, message: string): ImplementationWindow => canonicalRecord({
    kind: "window",
    wave,
    recovery,
    message,
    pendingTaskIds: Object.freeze(outstanding.filter((task) => task.status !== "implemented").map((task) => task.id)),
    activeTaskIds: activeIds,
    escalated: Object.freeze(escalated),
  });
  const startReadiness = outstanding.length === 0 ? deriveWaveStartReadiness(graph, waveTasks) : null;
  if (startReadiness?.kind === "not-ready") {
    return window(
      canonicalRecord({ kind: "repair-wave-start-readiness", wave, failures: startReadiness.failures }),
      `Wave ${wave} implementation stopped but the Wave Gate cannot start: ${startReadiness.failures.join("; ")}`,
    );
  }
  if (startReadiness?.kind === "ready") {
    return window(
      canonicalRecord({ kind: "start-wave-gate", wave }),
      `Wave ${wave} implementation is complete and no Wave Gate run is registered; start the Wave Gate`,
    );
  }
  if (escalated.length > 0) {
    return window(
      canonicalRecord({
        kind: "escalate-wave-implementation",
        wave,
        tasks: Object.freeze(escalated) as NonEmpty<EscalatedImplementation>,
      }),
      `Wave ${wave} requires implementation escalation; ${escalated.length} task(s) reached a terminal implementation failure`,
    );
  }
  if (dispatches.length > 0) {
    return window(
      canonicalRecord({
        kind: "spawn-wave-implementation",
        wave,
        dispatches: Object.freeze(dispatches) as NonEmpty<WaveImplementationDispatch>,
      }),
      `Wave ${wave} implementation is in progress; ${dispatches.length} task(s) are ready to dispatch` +
        (active.length === 0 ? "" : ` and ${active.length} task(s) remain active`),
    );
  }
  if (active.length > 0) {
    return window(
      canonicalRecord({
        kind: "await-wave-implementation",
        wave,
        activeTaskIds: activeIds as NonEmpty<string>,
      }),
      `Wave ${wave} implementation is in progress; wait for ${active.length} active task(s)`,
    );
  }
  return contradiction(`Wave ${wave} has outstanding Tasks but no legal implementation recovery`);
}
