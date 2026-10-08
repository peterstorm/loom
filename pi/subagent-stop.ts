/**
 * SubagentStop dispatch for Pi: the spawn tools' `tool_result` handler.
 *
 * When a subagent batch completes, this settles it against the reservation
 * its `tool_call` recorded (recovering that reservation from the Run
 * Directory when the in-memory copy is gone, and parsing either against the
 * session that owns the batch): it releases the batch's write grants and
 * roster entries, finalizes reserved implementation attempts, reconciles
 * missing gate-owned results, captures request-bound results,
 * hands each remaining result to its named applier in `pi/subagent-result`,
 * and releases the pointer lease last — the equivalent of Claude Code's
 * SubagentStop hooks. Both releases run the batch's claims ledger
 * (`pi/spawn-claims.ts`) through the same plan and remaining-debt rule as an
 * admission rollback.
 *
 * Each stage is one function at one altitude that takes the reservation
 * explicitly and returns the processing errors it raised; the dispatcher
 * concatenates them in stage order. Every routing decision between a result's
 * I/O observations is pure in `pi/subagent-result-route.ts`; the stages here
 * observe, execute that decision, and write stderr. One failing result never
 * aborts its siblings.
 */

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { settleSpecCheck } from "../engine/src/core/spec-check";
import { settleUnavailableImplementation } from "../engine/src/core/implementation-application";
import {
  applyReviewResolution,
  hasStandaloneReviewContext,
} from "../engine/src/core/review-output";
import { isRecord } from "../engine/src/core/plain-record";
import { observeTaskGraphProjectBoundary } from "../engine/src/config";
import { StateManager } from "../engine/src/state-manager";
import type { Task, TaskGraph } from "../engine/src/types";
import { fsSessionRegistry, parseSessionId } from "../engine/src/machine";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { runtimeWriteBoundaryForTasks } from "../engine/src/utils/runtime-baseline-restore";
import { STRICT_RUNTIME_WRITE_BOUNDARY, type RuntimeWriteBoundary } from "../engine/src/runtime-compatibility";
import {
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  terminalCaptureRefusal,
} from "../engine/src/orchestration/harness-capture-runtime";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { parseIsoInstant } from "../engine/src/core/implementation-completion";
import {
  applyFailedPiResult,
  applyImplementationPiResult,
  applyPhaseAgentPiResult,
  applyReviewPiResult,
  applySpecCheckPiResult,
  type RepositoryProbe,
} from "./subagent-result";
import {
  piAllSlotsFailedNote,
  piSilentStopNote,
  parsePiSubagentResults,
  piSubagentFailureSignals,
  piSubagentResultFailed,
  type PiSubagentResultEntry,
} from "./subagent-result-batch";
import {
  piReviewAuthorityProblem,
  piSpecCheckAuthorityProblem,
  reviewAuthorityOf,
  specCheckAuthorityOf,
} from "./reserved-slot";
import {
  retireCompletedOrMissingImplementation,
  type PiResultOutcome,
} from "./subagent-settlement";
import {
  classifyMissingReservedResults,
  unrecordableMissingEvidenceDiagnostic,
} from "./reserved-results";
import { piSpawnRosterId } from "./tool-input";
import type { PiEmissionLaunchBridge } from "./emission-launch-bridge";
import {
  orchestrationMarkers,
  piResultAuthorityProblem,
  recordPiRequestCaptureRejection,
  sessionRunBinding,
} from "./review-run-authority";
import type { TrustedReviewWitnesses } from "./trusted-review-witness";
import { capturePiSubagentResult, classifyPiEmissionStartupRefusal } from "./review-capture";
import { describeCause } from "./cleanup-actions";
import {
  piDurableClaimReleasePorts,
  pointerLeaseOnly,
  releaseDurableSpawnClaims,
  remainingDurableClaims,
  settledSpawnClaims,
  spawnDebtOf,
  spawnSettlementStepLabel,
  withoutPointerLease,
  type DurableSpawnClaims,
} from "./spawn-claims";
import {
  missingResultMarkersProblem,
  missingTaskGraphNotice,
  reservedAgentMismatch,
  resultAuthorityRejection,
  routeCapturedPiResult,
  routeEmissionStartup,
  type PiResultNotice,
} from "./subagent-result-route";
import {
  ownPiSpawnReservation,
  recoverPiSpawnReservation,
  reservedImplementationFailure,
  spawnedWithoutTaskGraph,
  type OwnedPiSpawnReservation,
  type PiParentSessions,
  type PiSessionId,
  type PiSpawnReservation,
  type PiSpawnReservationItem,
} from "./spawn-reservation";

/**
 * The `RuntimeWriteBoundary` for the implementation settlements this batch
 * finalizes: a restoring boundary over the whole runtime revision domain,
 * provably clean at the in-flight attempts' start and hashed at those
 * attempt-start bytes by the boundary's revision comparison, or the strict
 * boundary.
 *
 * An implementation attempt's writes live inside the runtime revision domain
 * (`engine/src`, `pi`) and are NOT bounded by its declared artifact list — the
 * attempt writing those files is the product — so under the strict boundary
 * the settlement reads its own authorized writes as runtime drift and refuses
 * the state update that records its outcome. Any proven-unrestorable input
 * yields the strict boundary, which keeps the full-domain live comparison in
 * force (fail closed).
 */
function implementationWriteBoundaryFor(
  manager: StateManager,
  taskIds: readonly string[],
): RuntimeWriteBoundary {
  if (taskIds.length === 0) return STRICT_RUNTIME_WRITE_BOUNDARY;
  try {
    const state = manager.load();
    const tasks = state.tasks.filter((task) => taskIds.includes(task.id));
    if (tasks.length === 0) return STRICT_RUNTIME_WRITE_BOUNDARY;
    const boundary = observeTaskGraphProjectBoundary(manager.getPath());
    if (boundary.kind !== "git-repository") return STRICT_RUNTIME_WRITE_BOUNDARY;
    return runtimeWriteBoundaryForTasks(boundary.root, tasks);
  } catch (error) {
    process.stderr.write(
      `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
      `${describeCause(error)}\n`,
    );
    return STRICT_RUNTIME_WRITE_BOUNDARY;
  }
}

/** The Task ids of a reservation's implementation slots that name one. */
const reservedImplementationTaskIds = (reservation: PiSpawnReservation | undefined): readonly string[] =>
  (reservation?.items ?? []).flatMap((item) =>
    item.kind === "implementation" && item.taskId !== null ? [item.taskId] : []);

/** Write a notice's stderr line and return the processing error it raises. */
const emitNotice = (notice: PiResultNotice): readonly string[] => {
  process.stderr.write(`${notice.stderr}\n`);
  return notice.processingError === null ? [] : [notice.processingError];
};

/** The processing-error result Pi shows the parent in place of the batch's. */
export type PiSubagentStopResponse = { content: { type: "text"; text: string }[]; isError: true };

export type PiSubagentStopPorts = Readonly<{
  parentSessions: PiParentSessions;
  emissionLaunchBridge: PiEmissionLaunchBridge;
  /** The witness aggregate exactly captured standalone transcripts join. */
  reviewWitnesses: TrustedReviewWitnesses;
}>;

/** The parsed session and tool call one batch's capabilities and debt are
 *  filed under on the parent session. */
type PiSettlementOwner = Readonly<{ sessionId: PiSessionId; toolCallId: string }>;

/** What every stage of one batch's settlement reads. */
type PiStopBatch = Readonly<{
  /** The raw tool call id, as the per-result capture authority reads it. */
  toolCallId: unknown;
  resultSessionId: PiSessionId | null;
  /** Both identities parsed, once; `null` when either is missing, so the
   *  batch owns no session debt to settle. */
  owner: PiSettlementOwner | null;
  /** The reservation the batch settles against, proven to name the owner's
   *  session; `undefined` when none exists or none resolved. */
  reservation: OwnedPiSpawnReservation | undefined;
  parentSessions: PiParentSessions;
}>;

/** How one batch's reservation resolved against its owner. */
type PiStopReservationResolution = Readonly<{
  reservation: OwnedPiSpawnReservation | undefined;
  /** Why no reservation could be settled against, a processing error. */
  resolutionFailure: string | null;
}>;

/**
 * The reservation in memory, else its durable Run Directory recovery (stored
 * back on the session), parsed against the owner's session either way. A
 * failed recovery, or a reservation naming another session, is a processing
 * error and leaves the batch nothing to settle against.
 */
function resolveStopReservation(
  owner: PiSettlementOwner | null,
  parentSessions: PiParentSessions,
): PiStopReservationResolution {
  if (owner === null) return { reservation: undefined, resolutionFailure: null };
  const { sessionId, toolCallId } = owner;
  const refuse = (diagnostic: string): PiStopReservationResolution => {
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return { reservation: undefined, resolutionFailure: diagnostic };
  };
  const owned = (reservation: PiSpawnReservation): PiStopReservationResolution => {
    const parsed = ownPiSpawnReservation(sessionId, reservation);
    return parsed.ok ? { reservation: parsed.value, resolutionFailure: null } : refuse(parsed.error);
  };
  const inMemory = parentSessions.get(sessionId)?.spawnReservations.get(toolCallId);
  if (inMemory !== undefined) return owned(inMemory);
  let recovered: PiSpawnReservation | null;
  try {
    recovered = recoverPiSpawnReservation(sessionId, toolCallId);
  } catch (error) {
    return refuse(`durable Pi orchestration reservation recovery failed: ${describeCause(error)}`);
  }
  if (recovered === null) return { reservation: undefined, resolutionFailure: null };
  const resolution = owned(recovered);
  if (resolution.reservation !== undefined) {
    parentSessions.runtimeFor(sessionId).spawnReservations.set(toolCallId, resolution.reservation);
  }
  return resolution;
}

/**
 * Release the part `select` picks of the durable claims ledger the batch
 * still holds (`settledSpawnClaims`: its committed grants, reservation roster
 * and pointer lease) through the same plan and remaining-debt rule admission
 * rollback uses — and through durable release ports only, because a
 * dispatched batch holds no launch, prompt rewrite or witness claim. Every
 * step runs; the session keeps exactly what failed, so shutdown can retry a
 * transient result-time failure without replaying released capabilities.
 *
 * Roster entries are removed under the owner's session, which the batch's
 * owned reservation is proven to name (`ownPiSpawnReservation`). A batch
 * whose reservation did not resolve holds only its grants here; a stored
 * reservation naming another session stays on the parent session as debt for
 * shutdown rather than being released under the wrong session. What the
 * reservation still owes is re-read from the session, where the previous
 * release (or shutdown) retained it.
 */
async function releaseSettledClaims(
  batch: PiStopBatch,
  select: (held: DurableSpawnClaims) => DurableSpawnClaims,
): Promise<readonly string[]> {
  const { owner, reservation, parentSessions } = batch;
  if (owner === null) return [];
  const runtime = parentSessions.get(owner.sessionId);
  const stored = reservation === undefined ? undefined : runtime?.spawnReservations.get(owner.toolCallId);
  const held = settledSpawnClaims(runtime?.issuedWriteGrants.get(owner.toolCallId) ?? [], stored);
  const { errors, releases } = await releaseDurableSpawnClaims(
    select(held),
    (step) => spawnSettlementStepLabel(step, owner),
    piDurableClaimReleasePorts(owner.sessionId),
  );
  for (const error of errors) process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${error}\n`);
  const owed = remainingDurableClaims(held, releases);
  parentSessions.retainWriteGrantDebt(owner.sessionId, owner.toolCallId, owed.grants);
  if (stored !== undefined) {
    parentSessions.retainSpawnCleanupDebt(owner.sessionId, owner.toolCallId, spawnDebtOf(owed, stored).reservation);
  }
  return errors;
}

/** Terminalise one request-bound result's capture slot; returns the failure
 *  to record when the rejection itself could not be recorded cleanly. */
async function persistCaptureRejection(
  runBinding: SessionRunBinding,
  toolCallId: unknown,
  resultIndex: number,
  agentType: string,
  diagnostic: string,
): Promise<readonly string[]> {
  const failure = await recordPiRequestCaptureRejection(runBinding, toolCallId, resultIndex, agentType, diagnostic);
  if (failure === null) return [];
  process.stderr.write(`loom(pi): ${failure}\n`);
  return [failure];
}

/** Settle a reserved implementation slot whose result processing crashed. */
async function settleReservedImplementationCrash(
  reservation: OwnedPiSpawnReservation | undefined,
  item: PiSpawnReservationItem | undefined,
  diagnostic: string,
): Promise<readonly string[]> {
  if (item?.role !== "implementation") return [];
  const finalizedAt = parseIsoInstant(new Date().toISOString(), "Pi crash-settlement instant");
  if (!finalizedAt.ok) return [finalizedAt.error.errors.join("; ")];
  try {
    const plainManager = StateManager.fromLocalSession(reservation?.sessionId ?? "");
    if (plainManager === null) return [`cannot settle crashed reserved implementation ${item.taskId}: task graph unavailable`];
    // The crashed attempt may have written engine/src/pi artifacts (declared
    // or not) before failing: restore the whole in-flight batch's baseline
    // domain for the write boundary's revision comparison, exactly like the
    // finalize path below. Unprovable inputs yield the strict boundary.
    const crashBoundary = implementationWriteBoundaryFor(plainManager, reservedImplementationTaskIds(reservation));
    const manager = crashBoundary.kind === "restoring"
      ? StateManager.fromLocalSession(reservation?.sessionId ?? "", crashBoundary) ?? plainManager
      : plainManager;
    const applied = await manager.updateAndReturn((state) => {
      const settlement = settleUnavailableImplementation(state, item.authority, finalizedAt.value, diagnostic);
      if (settlement.kind === "error") throw new Error(JSON.stringify(settlement.error));
      return { state: settlement.state, value: settlement };
    });
    if (applied.kind === "ignored") {
      process.stderr.write(
        `loom(pi): crashed result for ${item.taskId} was ${applied.reason}; current authority preserved\n`,
      );
    }
    return [];
  } catch (error) {
    return [
      `cannot settle crashed reserved implementation ${item.taskId}: ` +
      `${describeCause(error)}`,
    ];
  }
}

/** Finalize every reserved implementation attempt the batch settles. */
async function finalizeReservedImplementations(
  reservation: OwnedPiSpawnReservation | undefined,
  entries: readonly PiSubagentResultEntry[],
): Promise<readonly string[]> {
  if (!reservation || !reservation.items.some((item) => item.kind === "implementation")) return [];
  let manager: StateManager | null;
  try {
    manager = StateManager.fromLocalSession(reservation.sessionId);
  } catch (error) {
    // Guarded like the sibling `manager.update` below. An unguarded throw here
    // — resolveTaskGraph REFUSES its local fallback and throws for any
    // non-ENOENT read of the session pointer (EACCES/EIO/ELOOP/ENOTDIR) —
    // would escape the whole `tool_result` handler: no finalization, no
    // per-result evidence loop, no capture terminalization, zero
    // diagnostics, tasks stuck `executing`. The throw becomes a diagnostic
    // and the batch continues.
    const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} ` +
      `— task graph pointer unreadable: ${describeCause(error)}`;
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return [diagnostic];
  }
  if (!manager) {
    // Ad-hoc: no graph existed at spawn, so there is no attempt record to
    // finalize and nothing was lost.
    if (spawnedWithoutTaskGraph(reservation)) {
      process.stderr.write(
        `loom(pi): ad-hoc implementation spawn for session ${reservation.sessionId} — no task graph to finalize\n`,
      );
      return [];
    }
    const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} — task graph unavailable`;
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return [diagnostic];
  }
  const finalizedAt = parseIsoInstant(new Date().toISOString(), "Pi finalization instant");
  if (!finalizedAt.ok) return [finalizedAt.error.errors.join("; ")];
  // Restore the reserved attempts' declared artifacts to their attempt-start
  // bytes for the write boundary's revision comparison, so the settlement of
  // an attempt that (correctly) wrote engine/src or pi files is not refused
  // as runtime drift. Unprovable inputs yield the strict boundary.
  const finalizeBoundary = implementationWriteBoundaryFor(manager, reservedImplementationTaskIds(reservation));
  if (finalizeBoundary.kind === "restoring") {
    try {
      manager = StateManager.fromLocalSession(reservation.sessionId, finalizeBoundary) ?? manager;
    } catch (error) {
      process.stderr.write(
        `loom(pi): baseline-restored manager construction failed; strict comparison stays: ` +
        `${describeCause(error)}\n`,
      );
    }
  }
  try {
    const committed = await manager.updateAndReturn((initial) => {
      let state: TaskGraph = initial;
      const diagnostics: string[] = [];
      const logs: string[] = [];
      for (const [index, item] of reservation.items.entries()) {
        if (item.kind !== "implementation" || item.taskId === null) continue;
        if (item.role !== "implementation") {
          logs.push(
            `implementation slot ${index + 1}/${item.taskId} has no exact attempt authority — current reservation preserved`,
          );
          continue;
        }
        const retired = retireCompletedOrMissingImplementation(state, item.taskId, item.authority);
        if (retired.retired) {
          state = retired.state;
          logs.push(`retired completed/missing implementation reservation for ${item.taskId}`);
          continue;
        }
        const failure = reservedImplementationFailure(
          item.agentType,
          item.taskId,
          item.authority.taskId,
          entries[index],
        );
        if (failure === null) continue;

        const applied = settleUnavailableImplementation(state, item.authority, finalizedAt.value, failure);
        if (applied.kind === "error") {
          const diagnostic = `Oracle could not finalize ${item.taskId}: ${JSON.stringify(applied.error)}`;
          diagnostics.push(diagnostic);
          logs.push(`${diagnostic}; current attempt preserved`);
          continue;
        }
        state = applied.state;
        if (applied.kind === "ignored" && applied.reason === "stale") {
          logs.push(`late result for ${item.taskId} does not match its current attempt authority — replacement preserved`);
        }
      }
      return {
        state,
        value: Object.freeze({
          diagnostics: Object.freeze(diagnostics),
          logs: Object.freeze(logs),
        }),
      };
    });
    // The callback may accumulate in-memory diagnostics, but performs no
    // external I/O. Emit only after the protected-state commit proves they
    // describe durable state.
    for (const line of committed.logs) process.stderr.write(`loom(pi): ${line}\n`);
    return committed.diagnostics;
  } catch (error) {
    const diagnostic = `reserved implementation finalization failed: ${describeCause(error)}`;
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return [diagnostic];
  }
}

/**
 * A reservation is the authoritative expected batch. Pi may return a shorter
 * or reordered results array after a child disappears. Reconcile every
 * gate-owned slot before any malformed-details early return so stale
 * review/spec evidence cannot remain authoritative.
 */
async function reconcileMissingReservedResults(
  reservation: OwnedPiSpawnReservation,
  rawResults: readonly unknown[],
  toolCallId: unknown,
): Promise<readonly string[]> {
  const processingErrors: string[] = [];
  const { reviews: missingReviews, specChecks: missingSpecChecks, runResults: missingRunResults } =
    classifyMissingReservedResults(
      reservation.items,
      rawResults,
      reservation.orchestrationRunBinding !== null,
    );
  for (const { item, index } of missingRunResults) {
    const diagnostic = "no typed pre-prompt outcome exists; terminal capture rejection";
    const resultDiagnostic =
      `request-bound result ${index + 1} for ${item.agentType} was absent or unusable; ${diagnostic}`;
    const captureDiagnostic =
      `request-bound result ${index + 1} for ${item.agentType} was missing or mismatched; ${diagnostic}`;
    processingErrors.push(resultDiagnostic);
    process.stderr.write(`loom(pi): ${resultDiagnostic}\n`);
    const runBinding = reservation.orchestrationRunBinding;
    if (runBinding === null) {
      const failure = `cannot terminalize absent or unusable ${item.agentType}[${index}]: reservation lost its run binding`;
      processingErrors.push(failure);
      process.stderr.write(`loom(pi): ${failure}\n`);
    } else {
      processingErrors.push(...await persistCaptureRejection(runBinding, toolCallId, index, item.agentType, captureDiagnostic));
    }
  }
  // An ad-hoc batch has no State File to mark, so the persistence arm below
  // cannot run — which used to skip the whole reporting block, and a reserved
  // reviewer that died without returning left no trace anywhere. There is no
  // protected state to record an evidence failure against, so this stays
  // operator-visible rather than an orchestration failure; what must not
  // happen is silence.
  const missingGateOwned = missingReviews.length > 0 || missingSpecChecks.length > 0;
  if (!missingGateOwned) return processingErrors;
  if (spawnedWithoutTaskGraph(reservation)) {
    const diagnostic = unrecordableMissingEvidenceDiagnostic({
      sessionId: reservation.sessionId,
      reviews: missingReviews.length,
      specChecks: missingSpecChecks.length,
    });
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return processingErrors;
  }
  const unpersisted = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
    `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId}`;
  const fail = (diagnostic: string): readonly string[] => {
    processingErrors.push(diagnostic);
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    return processingErrors;
  };
  let manager: StateManager | null;
  try {
    manager = StateManager.fromLocalSession(reservation.sessionId);
  } catch (error) {
    // Guarded exactly like the sibling `manager.update` below: resolveTaskGraph
    // refuses its local fallback and throws for any non-ENOENT read of the
    // session pointer (EACCES/EIO/ELOOP/ENOTDIR). The pointer is
    // present-but-unreadable, not absent, so the ad-hoc and "task graph
    // unavailable" arms do not apply; the batch continues to the per-result
    // evidence loop.
    return fail(`${unpersisted} — task graph pointer unreadable: ${describeCause(error)}`);
  }
  if (!manager) return fail(`${unpersisted} — task graph unavailable`);
  const runAt = new Date().toISOString();
  // Guarded so an unguarded throw (corrupt state JSON, lock contention, disk
  // failure) cannot escape the whole `tool_result` handler — skipping the
  // per-result evidence loop, whose contract is that one failure must not
  // abort the rest of the batch — and leave tasks stuck `executing` with zero
  // `processingErrors` and zero stderr. The throw becomes a diagnostic and the
  // batch continues.
  try {
    const settled = await manager.updateAndReturn((state) => {
      const appliedReviewIndexes: number[] = [];
      const tasks = state.tasks.map<Task>((task) => {
        const failures = missingReviews.filter(({ item }) => item.taskId === task.id);
        return failures.reduce<Task>((current, { item, index }) => {
          if (piReviewAuthorityProblem(current, item.agentType, reviewAuthorityOf(item)) !== null) {
            return current;
          }
          const next = applyReviewResolution(current, {
            kind: "evidence-failed" as const,
            agent: item.agentType,
            message: `reserved reviewer result ${index + 1} for ${item.agentType} was missing or mismatched`,
          });
          if (next !== current) appliedReviewIndexes.push(index);
          return next;
        }, task);
      });
      const reviewedState: TaskGraph = { ...state, tasks };
      const specAuthorityProblems: string[] = [];
      let settledState = reviewedState;
      if (missingSpecChecks.length > 1) {
        specAuthorityProblems.push("multiple reserved spec-check slots were missing; no unique authority exists");
      } else if (missingSpecChecks.length === 1) {
        const missing = missingSpecChecks[0]!;
        const authority = specCheckAuthorityOf(missing.item);
        const problem = piSpecCheckAuthorityProblem(state, authority);
        if (problem !== null || authority === null) {
          specAuthorityProblems.push(problem ?? "reserved spec-check authority is absent");
        } else {
          settledState = settleSpecCheck(reviewedState, {
            kind: "capture-failure",
            wave: authority.wave,
            runAt,
            error: `reserved spec-check result ${missing.index + 1} for spec-check-invoker was missing or mismatched`,
          }).state;
        }
      }
      return {
        state: settledState,
        value: Object.freeze({
          appliedReviewIndexes: Object.freeze(appliedReviewIndexes),
          specAuthorityProblems: Object.freeze(specAuthorityProblems),
        }),
      };
    });
    // These lines announce evidence that was RECORDED, so they stay inside the
    // `try`: printing them after a failed write would report a state change
    // that never happened.
    for (const { item, index } of missingReviews) {
      if (settled.appliedReviewIndexes.includes(index)) {
        process.stderr.write(
          `loom(pi): reserved reviewer result ${index + 1} for ${item.agentType}/${item.taskId} was missing or mismatched — marking evidence_capture_failed\n`,
        );
      } else {
        const diagnostic = `reserved reviewer result ${index + 1} for ${item.agentType}/${item.taskId} was not applied under locked current review authority`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
      }
    }
    for (const { index } of missingSpecChecks) {
      process.stderr.write(
        settled.specAuthorityProblems.length === 0
          ? `loom(pi): reserved spec-check result ${index + 1} for spec-check-invoker was missing or mismatched — marking evidence_capture_failed\n`
          : `loom(pi): reserved spec-check result ${index + 1} was not applied: ${settled.specAuthorityProblems.join("; ")}\n`,
      );
    }
    processingErrors.push(...settled.specAuthorityProblems);
    return processingErrors;
  } catch (error) {
    return fail(`${unpersisted}: ${describeCause(error)}`);
  }
}

/** The per-result facts every stage of one result's processing reads. */
type PiResultContext = Readonly<{
  batch: PiStopBatch;
  /** The one port result processing crosses: exact captures are witnessed. */
  reviewWitnesses: TrustedReviewWitnesses;
  event: ToolResultEvent;
  sessionId: string;
  rawResults: readonly unknown[];
  resultIndex: number;
  result: Extract<PiSubagentResultEntry, { ok: true }>["result"];
}>;

/**
 * Process one parsed result: authority, startup outcome, capture, routing,
 * then — only on a settle route — the TaskGraph applier. Appends the
 * processing errors it raises to `processingErrors` as it goes, so the ones
 * raised before a throw survive it; the caller isolates the throw.
 */
async function processPiResult(
  context: PiResultContext,
  processingErrors: string[],
): Promise<void> {
  const { batch, reviewWitnesses, event, sessionId, rawResults, resultIndex, result } = context;
  const { toolCallId, resultSessionId, reservation } = batch;
  const record = (notice: PiResultNotice | null): void => {
    if (notice !== null) processingErrors.push(...emitNotice(notice));
  };
  const agentType = stripNamespace(result.agent);
  const reservedItem = reservation?.items[resultIndex];
  const markers = orchestrationMarkers(result.task, `Pi result ${resultIndex + 1}/${agentType}`);
  const durableRunBinding = reservation?.orchestrationRunBinding ??
    (markers !== null && resultSessionId !== null
      ? sessionRunBinding(resultSessionId, [markers])
      : null);
  const runBound = durableRunBinding !== null ||
    process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
  const mismatch = reservedAgentMismatch({
    agentType,
    reservedAgentType: reservedItem?.agentType,
    resultIndex,
    runBound,
  });
  if (mismatch !== null) return record(mismatch);
  if (durableRunBinding !== null) {
    const authorityProblem = markers === null
      ? missingResultMarkersProblem(resultIndex, agentType)
      : piResultAuthorityProblem(durableRunBinding, toolCallId, resultIndex, agentType, markers);
    if (authorityProblem !== null) {
      const rejection = resultAuthorityRejection(agentType, authorityProblem);
      record(rejection.notice);
      processingErrors.push(...await persistCaptureRejection(
        durableRunBinding,
        toolCallId,
        resultIndex,
        agentType,
        rejection.captureRejection,
      ));
      return;
    }
  }

  // Cleanup subagent flag. Parse the session id before interpolating it into
  // the SUBAGENT_DIR path (path-traversal guard); an unsafe id could never
  // have named a tracking file, so there is nothing to clean up.
  const safeSessionId = parseSessionId(sessionId);
  if (safeSessionId === null) {
    process.stderr.write(`loom: invalid session id ${JSON.stringify(sessionId)} — subagent flag cleanup skipped\n`);
  } else if (!reservedItem) {
    // Compatibility for a result emitted by an older Pi call that predates
    // reservation capture. New calls release their roster entry in
    // releaseSettledClaims, from reservation authority, before any result
    // is processed.
    try {
      await fsSessionRegistry.removeActive(safeSessionId, piSpawnRosterId(toolCallId, resultIndex, agentType));
    } catch (err) {
      const diagnostic = `subagent flag cleanup failed for ${agentType}/${safeSessionId}: ${describeCause(err)}`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom: ${diagnostic}\n`);
    }
  }

  const startup = routeEmissionStartup(
    durableRunBinding !== null && reservation !== undefined && reservedItem !== undefined
      ? classifyPiEmissionStartupRefusal({
          rawResult: rawResults[resultIndex],
          result,
          reservation,
          reservedItem,
          runBinding: durableRunBinding,
          toolCallId,
          resultIndex,
          agentType,
        })
      : Object.freeze({ kind: "ordinary" as const }),
    agentType,
    resultIndex,
  );
  record(startup.notice);
  if (startup.kind === "retain-authority") return;

  // Request-bound capture runs BEFORE the standalone short-circuit and before
  // any StateManager resolution — the same two orderings dispatch.ts documents
  // as load-bearing on the Claude side. It reads only the run directory it is
  // pointed at, never a State File, so a run beside an active wave cannot
  // cross into it.
  const resultFailed = piSubagentResultFailed(result);
  const captureOutcome = await capturePiSubagentResult(
    toolCallId,
    resultIndex,
    agentType,
    result.messages,
    durableRunBinding,
    resultFailed && runBound
      ? terminalCaptureRefusal(
          "agent-failed",
          `${agentType} exited without a successful result (${piSubagentFailureSignals(result)})`,
        )
      : null,
  );
  if (captureOutcome.kind === "captured" && durableRunBinding !== null && resultSessionId !== null) {
    try {
      reviewWitnesses.remember(resultSessionId, durableRunBinding, agentType, result.task, captureOutcome);
    } catch (error) {
      const diagnostic = `cannot retain process-local review authority for ${agentType}: ${describeCause(error)}`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
    }
  }

  const route = routeCapturedPiResult({
    agentType,
    reservedKind: reservedItem?.kind,
    runBound,
    standaloneContext: hasStandaloneReviewContext(result.task),
    resultFailed,
    spawnedWithoutTaskGraph: spawnedWithoutTaskGraph(reservation),
    capture: captureOutcome,
  });
  if (route.kind === "skip") return record(route.notice);

  const mgr = StateManager.fromLocalSession(sessionId);
  if (!mgr) return record(missingTaskGraphNotice(agentType, sessionId));

  // Implementation settlement in this batch may have written declared
  // engine/src/pi artifacts: restore those attempts' declared, clean-at-spawn
  // artifacts to their attempt-start bytes for the write boundary's revision
  // comparison (see implementationWriteBoundaryFor). Unprovable inputs yield
  // the strict boundary, so the full-domain live comparison stays.
  let settlementMgr = mgr;
  try {
    const state = mgr.load();
    const settleTaskIds = [
      ...new Set([
        ...(state.executing_tasks ?? []),
        ...(reservation?.items ?? []).flatMap((item) => item.taskId === null ? [] : [item.taskId]),
      ]),
    ];
    const settleBoundary = implementationWriteBoundaryFor(mgr, settleTaskIds);
    if (settleBoundary.kind === "restoring") {
      settlementMgr = StateManager.fromLocalSession(sessionId, settleBoundary) ?? mgr;
    }
  } catch (error) {
    process.stderr.write(
      `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
      `${describeCause(error)}\n`,
    );
  }
  const store = settlementMgr;
  // One observation owns both Pi adapters. A Git failure throws and the
  // per-result shell records infrastructure failure; it never substitutes the
  // runtime checkout or cwd for the TaskGraph's project boundary.
  const projectBoundary = observeTaskGraphProjectBoundary(mgr.getPath());
  const repository: RepositoryProbe = {
    root: () => projectBoundary.root,
    isRepo: () => projectBoundary.kind === "git-repository",
  };
  const parentPrompt = event.content
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { type: string; text?: string }) => c.text ?? "")
    .join("\n");
  const emit = (applied: PiResultOutcome): void => {
    processingErrors.push(...applied.processingErrors);
    for (const line of applied.log) process.stderr.write(`${line}\n`);
  };

  // Each applier is one named concern in `pi/subagent-result`, taking the
  // state store and the repository as ports. They decide and persist; this
  // dispatcher owns stderr and which of their diagnostics count as
  // orchestration processing errors. A failed process may retain
  // valid-looking assistant text: it is settled as a failure, persisted only
  // under exact current reserved authority, so stale evidence cannot
  // overwrite a newer slot while a healthy sibling remains visible.
  switch (route.applier.kind) {
    case "failed":
      return emit(await applyFailedPiResult({
        store,
        agentType,
        result,
        reservedSlot: reservedItem,
        now: new Date().toISOString(),
        projectBoundary,
      }));
    case "phase":
      return emit(await applyPhaseAgentPiResult({
        store,
        agentType,
        completedPhase: route.applier.phase,
        result,
        now: new Date().toISOString(),
        // Phase artifacts and implementation settlement consume the same
        // TaskGraph Project Boundary observed above.
        phaseArtifactBaseDir: projectBoundary.root,
      }));
    case "implementation":
      return emit(await applyImplementationPiResult({
        store,
        repository,
        authoritativeStatePath: mgr.getPath(),
        agentType,
        result,
        reservedSlot: reservedItem,
        parentPrompt,
      }));
    case "review":
      return emit(await applyReviewPiResult({
        store,
        agentType,
        result,
        reservedSlot: reservedItem,
        parentPrompt,
      }));
    case "spec-check":
      return emit(await applySpecCheckPiResult({
        store,
        result,
        reservedSlot: reservedItem,
        now: new Date().toISOString(),
        projectBoundary,
      }));
    case "none":
      return;
  }
}

/** Settle every authorized result, isolating each one's failure. */
async function settleBatchResults(
  batch: PiStopBatch,
  reviewWitnesses: TrustedReviewWitnesses,
  event: ToolResultEvent,
  sessionId: string,
  rawResults: readonly unknown[],
  entries: readonly PiSubagentResultEntry[],
): Promise<readonly string[]> {
  const { reservation } = batch;
  const processingErrors: string[] = [];
  // Per-element parse, not a cast: the array-shape guard says nothing about
  // any individual element, and `agent`/`task`/`exitCode` are read as
  // guaranteed strings and numbers downstream.
  if (reservation && entries.length > reservation.items.length) {
    const diagnostic =
      `subagent tool_result returned ${entries.length} result(s) for ${reservation.items.length} reserved slot(s) — surplus evidence ignored`;
    processingErrors.push(diagnostic);
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
  }
  const authorizedEntries = reservation ? entries.slice(0, reservation.items.length) : entries;
  const allSlotsFailed = piAllSlotsFailedNote(
    authorizedEntries.flatMap((entry) => (entry.ok ? [entry.result] : [])),
  );
  if (allSlotsFailed !== null) process.stderr.write(`loom(pi): ${allSlotsFailed}\n`);
  for (const [resultIndex, entry] of authorizedEntries.entries()) {
    // A malformed element keeps its slot rather than shifting the ones after
    // it, and is reported as loudly as the array-level shape drift.
    if (!entry.ok) {
      processingErrors.push(entry.problem);
      process.stderr.write(`loom(pi): ${entry.problem}\n`);
      continue;
    }
    const result = entry.result;
    // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
    // while processing result #1 must not abort results #2..N — that leaves
    // tasks stuck "executing" with zero diagnostics.
    try {
      await processPiResult({ batch, reviewWitnesses, event, sessionId, rawResults, resultIndex, result }, processingErrors);
    } catch (err) {
      // Loud + isolated: name the agent, the task (best effort), and the
      // cause, then continue with the next result.
      let taskIdForLog = "<unknown>";
      let taskIdFailure = "";
      try {
        taskIdForLog = extractTaskId(result?.task ?? "") ?? "<unknown>";
      } catch (error) {
        taskIdFailure = `; task-id extraction failed: ${describeCause(error)}`;
      }
      const diagnostic = `result ${resultIndex + 1} for agent ${String(result?.agent ?? "<unknown>")} (task ${taskIdForLog}${taskIdFailure}): ${describeCause(err)}`;
      const settlementErrors = await settleReservedImplementationCrash(
        reservation,
        reservation?.items[resultIndex],
        diagnostic,
      );
      processingErrors.push(diagnostic, ...settlementErrors);
      process.stderr.write(
        `loom(pi): subagent-stop processing failed for ${diagnostic} — continuing with remaining results\n`,
      );
      for (const settlementError of settlementErrors) {
        process.stderr.write(`loom(pi): ${settlementError}\n`);
      }
    }
  }
  return processingErrors;
}

const processingErrorResponse = (processingErrors: readonly string[]): PiSubagentStopResponse | undefined =>
  processingErrors.length === 0
    ? undefined
    : {
        content: [{
          type: "text" as const,
          text: `Loom Pi subagent evidence processing failed:\n- ${processingErrors.join("\n- ")}`,
        }],
        isError: true,
      };

/** Settle one completed spawn batch. Resolves the processing-error response
 *  Pi shows the parent, or `undefined` when every result was processed. */
export async function dispatchPiSubagentStop(
  event: ToolResultEvent,
  ctx: Readonly<{ sessionManager: Readonly<{ getSessionId: () => string | undefined }> }>,
  ports: PiSubagentStopPorts,
): Promise<PiSubagentStopResponse | undefined> {
  const { parentSessions, emissionLaunchBridge, reviewWitnesses } = ports;
  const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
  const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
  if (typeof toolCallId === "string") emissionLaunchBridge.removeToolCall(rawSessionId, toolCallId);
  const resultSessionId = parseSessionId(rawSessionId);
  const owner = typeof toolCallId === "string" && resultSessionId !== null
    ? Object.freeze({ sessionId: resultSessionId, toolCallId })
    : null;
  const resolved = resolveStopReservation(owner, parentSessions);
  const batch: PiStopBatch = Object.freeze({
    toolCallId,
    resultSessionId,
    owner,
    reservation: resolved.reservation,
    parentSessions,
  });
  const processingErrors: string[] = [
    ...(resolved.resolutionFailure === null ? [] : [resolved.resolutionFailure]),
    ...await releaseSettledClaims(batch, withoutPointerLease),
  ];
  if (resolved.resolutionFailure !== null) return processingErrorResponse(processingErrors);
  const { reservation } = batch;

  const rawDetails: unknown = event.details;
  const details = isRecord(rawDetails)
    ? rawDetails as Record<string, unknown>
    : null;
  const hasResults = details !== null && Object.hasOwn(details, "results");
  const rawResults = hasResults && Array.isArray(details.results) ? details.results : [];
  // Exact per-entry parsing precedes finalization. A matching-agent/exit-0
  // shell is not a successful implementation envelope until transcript shape
  // and exact returned Task identity have both parsed.
  const entries = parsePiSubagentResults(rawResults);
  if (!spawnedWithoutTaskGraph(reservation)) {
    processingErrors.push(...await finalizeReservedImplementations(reservation, entries));
  }
  // Silent-stop observability: an exit-0 result with no assistant text is the
  // failure mode the appliers cannot name — they parse the empty transcript
  // and report "not ready"/"no structured evidence" without the stopReason
  // that discriminates it. The note is stderr-only: the state side above
  // already settled or preserved what it owns, and a processing error here
  // would turn a settled batch into an orchestration failure.
  for (const entry of entries) {
    if (!entry.ok) continue;
    const note = piSilentStopNote(entry.result);
    if (note !== null) process.stderr.write(`loom(pi): ${note}\n`);
  }

  if (reservation) {
    processingErrors.push(...await reconcileMissingReservedResults(reservation, rawResults, toolCallId));
  }

  // Shape guard: a pi version drifting details.results away from an array
  // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
  const shapeDiagnostic = !hasResults
    ? "subagent tool_result is missing details.results — successful evidence was not applied"
    : !Array.isArray(details.results)
      ? `subagent tool_result has unrecognized details.results shape (${typeof details.results}) — successful evidence was not applied`
      : null;
  if (shapeDiagnostic !== null) {
    processingErrors.push(shapeDiagnostic);
    process.stderr.write(`loom(pi): ${shapeDiagnostic}\n`);
  } else {
    const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
    processingErrors.push(...await settleBatchResults(batch, reviewWitnesses, event, sessionId, rawResults, entries));
  }
  // The pointer lease is released once, last, after every result settled.
  processingErrors.push(...await releaseSettledClaims(batch, pointerLeaseOnly));
  return processingErrorResponse(processingErrors);
}
