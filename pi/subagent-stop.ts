/**
 * SubagentStop dispatch for Pi: the spawn tools' `tool_result` handler.
 *
 * When a subagent batch completes, this settles it against the reservation
 * its `tool_call` recorded (recovering that reservation from the Run
 * Directory when the in-memory copy is gone): it releases the batch's write
 * grants, roster entries and pointer lease, finalizes reserved implementation
 * attempts, reconciles missing gate-owned results, captures request-bound
 * results, and hands each remaining result to its named applier in
 * `pi/subagent-result` — the equivalent of Claude Code's SubagentStop hooks.
 * This dispatcher owns stderr and decides which diagnostics count as
 * orchestration processing errors; one failing result never aborts its
 * siblings.
 */

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { settleSpecCheck } from "../engine/src/core/spec-check";
import { settleUnavailableImplementation } from "../engine/src/core/implementation-application";
import {
  applyReviewResolution,
  hasStandaloneReviewContext,
} from "../engine/src/core/review-output";
import { isRecord } from "../engine/src/core/plain-record";
// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the
// review-output helpers: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook, not just review capture. `engine/tests/pi-imports.test.ts`
// resolves every engine import in `pi/` against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, PHASE_AGENT_MAP, IMPL_AGENTS, observeTaskGraphProjectBoundary } from "../engine/src/config";
import { StateManager } from "../engine/src/state-manager";
import type { Task, TaskGraph } from "../engine/src/types";
import {
  fsSessionRegistry,
  parseSessionId,
  rollbackSessionTaskGraphPointer,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { runtimeBaselineRestoreForTasks } from "../engine/src/utils/runtime-baseline-restore";
import {
  RUN_DIR_ENV,
  describeCaptureFailure,
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
} from "./reserved-slot";
import {
  retireCompletedOrMissingImplementation,
  type PiResultOutcome,
} from "./subagent-settlement";
import {
  classifyMissingReservedResults,
  unrecordableMissingEvidenceDiagnostic,
} from "./reserved-results";
import { revokePiWriteGrant } from "./write-grant";
import { piSpawnRosterId } from "./tool-input";
import type { PiEmissionLaunchBridge } from "./emission-launch-bridge";
import {
  orchestrationMarkers,
  piResultAuthorityProblem,
  recordPiRequestCaptureRejection,
  rememberTrustedReviewCapture,
  sessionRunBinding,
} from "./review-run-authority";
import { capturePiSubagentResult, classifyPiEmissionStartupRefusal } from "./review-capture";
import { runPiCleanupActions, type PiCleanupAction } from "./cleanup-actions";
import {
  recoverPiSpawnReservation,
  reservedImplementationFailure,
  retainSpawnCleanupDebt,
  spawnedWithoutTaskGraph,
  type PiParentSessions,
  type PiSpawnReservation,
} from "./spawn-reservation";

const isLoomOwnedResultAgent = (agentType: string): boolean =>
  PHASE_AGENT_MAP[agentType] !== undefined ||
  IMPL_AGENTS.has(agentType) ||
  isReviewAgent(agentType) ||
  agentType === "spec-check-invoker";

/**
 * The runtime-baseline restoration map for the implementation settlements this
 * batch finalizes: the whole runtime revision domain, provably clean at the
 * in-flight attempts' start, hashed at those attempt-start bytes by the write
 * boundary's revision comparison. An implementation attempt's writes live
 * inside the runtime revision domain (`engine/src`, `pi`) and are NOT bounded
 * by its declared artifact list — the attempt writing those files is the
 * product — so without this restoration the settlement reads its own
 * authorized writes as runtime drift and refuses the state update that records
 * its outcome. Any proven-unrestorable input yields an empty map, which keeps
 * the strict full-domain comparison in force (fail closed).
 */
function implementationBaselineRestoreFor(
  manager: StateManager,
  taskIds: readonly string[],
): ReadonlyMap<string, string | null> {
  if (taskIds.length === 0) return new Map();
  try {
    const state = manager.load();
    const tasks = state.tasks.filter((task) => taskIds.includes(task.id));
    if (tasks.length === 0) return new Map();
    const boundary = observeTaskGraphProjectBoundary(manager.getPath());
    if (boundary.kind !== "git-repository") return new Map();
    return runtimeBaselineRestoreForTasks(boundary.root, tasks);
  } catch (error) {
    process.stderr.write(
      `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return new Map();
  }
}

/** The processing-error result Pi shows the parent in place of the batch's. */
export type PiSubagentStopResponse = { content: { type: "text"; text: string }[]; isError: true };

export type PiSubagentStopPorts = Readonly<{
  parentSessions: PiParentSessions;
  emissionLaunchBridge: PiEmissionLaunchBridge;
}>;

/** Settle one completed spawn batch. Resolves the processing-error response
 *  Pi shows the parent, or `undefined` when every result was processed. */
export async function dispatchPiSubagentStop(
  event: ToolResultEvent,
  ctx: Readonly<{ sessionManager: Readonly<{ getSessionId: () => string | undefined }> }>,
  ports: PiSubagentStopPorts,
): Promise<PiSubagentStopResponse | undefined> {
  const { parentSessions, emissionLaunchBridge } = ports;
  const processingErrors: string[] = [];
  const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
  const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
  if (typeof toolCallId === "string") emissionLaunchBridge.removeToolCall(rawSessionId, toolCallId);
  const resultSessionId = parseSessionId(rawSessionId);
  let sessionRuntime = resultSessionId === null
    ? undefined
    : parentSessions.get(resultSessionId);
  const inMemoryReservation = typeof toolCallId === "string"
    ? sessionRuntime?.spawnReservations.get(toolCallId)
    : undefined;
  let reservation = inMemoryReservation;
  let reservationRecoveryFailed = false;
  if (reservation === undefined && typeof toolCallId === "string" && resultSessionId !== null) {
    try {
      reservation = recoverPiSpawnReservation(resultSessionId, toolCallId) ?? undefined;
      if (reservation !== undefined) {
        sessionRuntime = parentSessions.runtimeFor(resultSessionId);
        sessionRuntime.spawnReservations.set(toolCallId, reservation);
      }
    } catch (error) {
      reservationRecoveryFailed = true;
      const diagnostic = `durable Pi orchestration reservation recovery failed: ${error instanceof Error ? error.message : String(error)}`;
      processingErrors.push(diagnostic);
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
    }
  }
  const grantTokens = typeof toolCallId === "string"
    ? sessionRuntime?.issuedWriteGrants.get(toolCallId) ?? []
    : [];

  // Retire successful grant, roster, and pointer cleanup independently. The
  // session aggregate keeps only failed authority so shutdown can retry a
  // transient result-time failure without replaying released capabilities.
  const revokedGrantTokens = new Set<string>();
  const removedRosterIds = new Set<AgentId>();
  const cleanupActions: PiCleanupAction[] = grantTokens.map((token, index) => ({
    label: `revoke write grant ${index + 1}`,
    run: () => {
      revokePiWriteGrant(token);
      revokedGrantTokens.add(token);
    },
  }));
  // Same reason as the write-grant cleanup above: `reservation` is a mutable
  // `let`, so the optional-chain guard on the loop header does not narrow it
  // inside the deferred `run`. Capture the checked value.
  const cleanedReservation = reservation;
  if (cleanedReservation !== undefined) {
    const { sessionId: reservedSessionId } = cleanedReservation;
    for (const item of cleanedReservation.items) {
      cleanupActions.push({
        label: `remove reserved roster entry for ${item.agentType}`,
        run: async () => {
          await fsSessionRegistry.removeActive(reservedSessionId, item.rosterId);
          removedRosterIds.add(item.rosterId);
        },
      });
    }
  }
  const cleanupErrors = await runPiCleanupActions(cleanupActions);
  processingErrors.push(...cleanupErrors);
  for (const cleanupError of cleanupErrors) {
    process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${cleanupError}\n`);
  }
  if (typeof toolCallId === "string" && sessionRuntime) {
    const remainingGrantTokens = grantTokens.filter((token) => !revokedGrantTokens.has(token));
    if (remainingGrantTokens.length === 0) sessionRuntime.issuedWriteGrants.delete(toolCallId);
    else sessionRuntime.issuedWriteGrants.set(toolCallId, Object.freeze(remainingGrantTokens));

    const storedReservation = sessionRuntime.spawnReservations.get(toolCallId);
    if (storedReservation !== undefined) {
      const remainingItems = storedReservation.items.filter((item) => !removedRosterIds.has(item.rosterId));
      retainSpawnCleanupDebt(sessionRuntime, toolCallId, {
        ...storedReservation,
        items: Object.freeze(remainingItems),
      });
    }
  }
  if (resultSessionId && sessionRuntime) parentSessions.prune(resultSessionId, sessionRuntime);
  const processingErrorResponse = (): PiSubagentStopResponse | undefined => processingErrors.length === 0
    ? undefined
    : {
        content: [{
          type: "text" as const,
          text: `Loom Pi subagent evidence processing failed:\n- ${processingErrors.join("\n- ")}`,
        }],
        isError: true,
      };
  const persistCaptureRejection = async (
    runBinding: SessionRunBinding,
    resultIndex: number,
    agentType: string,
    diagnostic: string,
  ): Promise<void> => {
    const failure = await recordPiRequestCaptureRejection(
      runBinding,
      toolCallId,
      resultIndex,
      agentType,
      diagnostic,
    );
    if (failure === null) return;
    processingErrors.push(failure);
    process.stderr.write(`loom(pi): ${failure}\n`);
  };
  if (reservationRecoveryFailed) return processingErrorResponse();
  let parentPointerCleanupAttempted = false;
  const cleanupParentTaskGraphPointer = async (): Promise<void> => {
    if (parentPointerCleanupAttempted || !resultSessionId || reservation?.pointerBinding === null ||
        reservation?.pointerBinding === undefined) return;
    parentPointerCleanupAttempted = true;
    const pointerBinding = reservation.pointerBinding;
    const errors = await runPiCleanupActions([{
      label: `release parent task-graph pointer lease for ${resultSessionId}`,
      run: async () => {
        const result = await rollbackSessionTaskGraphPointer(pointerBinding);
        if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
      },
    }]);
    processingErrors.push(...errors);
    for (const error of errors) process.stderr.write(`loom(pi): reserved subagent cleanup failed: ${error}\n`);
    if (errors.length === 0 && typeof toolCallId === "string" && sessionRuntime) {
      const storedReservation = sessionRuntime.spawnReservations.get(toolCallId);
      if (storedReservation !== undefined) {
        retainSpawnCleanupDebt(sessionRuntime, toolCallId, {
          ...storedReservation,
          pointerBinding: null,
        });
      }
    }
    if (sessionRuntime) parentSessions.prune(resultSessionId, sessionRuntime);
  };

  const settleReservedImplementationCrash = async (
    item: PiSpawnReservation["items"][number] | undefined,
    diagnostic: string,
  ): Promise<readonly string[]> => {
    if (item?.kind !== "implementation" || item.implementationAuthority === null) return [];
    const finalizedAt = parseIsoInstant(new Date().toISOString(), "Pi crash-settlement instant");
    if (!finalizedAt.ok) return [finalizedAt.error.errors.join("; ")];
    try {
      const plainManager = StateManager.fromLocalSession(reservation?.sessionId ?? "");
      if (plainManager === null) return [`cannot settle crashed reserved implementation ${item.taskId ?? "unknown"}: task graph unavailable`];
      // The crashed attempt may have written engine/src/pi artifacts (declared
      // or not) before failing: restore the whole in-flight batch's baseline
      // domain for the write boundary's revision comparison, exactly like the
      // finalize path below. Unprovable inputs yield an empty map: strict stays.
      const crashRestore = implementationBaselineRestoreFor(
        plainManager,
        (reservation?.items ?? []).flatMap((reserved) =>
          reserved.kind === "implementation" && reserved.taskId !== null ? [reserved.taskId] : []),
      );
      const manager = crashRestore.size > 0
        ? StateManager.fromLocalSession(reservation?.sessionId ?? "", crashRestore) ?? plainManager
        : plainManager;
      const applied = await manager.updateAndReturn((state) => {
        const settlement = settleUnavailableImplementation(
          state,
          item.implementationAuthority!,
          finalizedAt.value,
          diagnostic,
        );
        if (settlement.kind === "error") throw new Error(JSON.stringify(settlement.error));
        return { state: settlement.state, value: settlement };
      });
      if (applied.kind === "ignored") {
        process.stderr.write(
          `loom(pi): crashed result for ${item.taskId ?? "unknown"} was ${applied.reason}; current authority preserved\n`,
        );
      }
      return [];
    } catch (error) {
      return [
        `cannot settle crashed reserved implementation ${item.taskId ?? "unknown"}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  };

  const finalizeReservedImplementations = async (
    entries: readonly PiSubagentResultEntry[],
  ): Promise<readonly string[]> => {
    if (!reservation || !reservation.items.some((item) => item.kind === "implementation")) return [];
    let manager: StateManager | null;
    try {
      manager = StateManager.fromLocalSession(reservation.sessionId);
    } catch (error) {
      // Guarded like the sibling `manager.update` below. This handler has no
      // top-level try/catch, so an unguarded throw here — resolveTaskGraph
      // REFUSES its local fallback and throws for any non-ENOENT read of the
      // session pointer (EACCES/EIO/ELOOP/ENOTDIR) — would escape the whole
      // `tool_result` handler: no finalization, no per-result evidence loop,
      // no capture terminalization, zero diagnostics, tasks stuck
      // `executing`. The throw becomes a diagnostic and the batch continues.
      const diagnostic = `cannot finalize reserved implementation attempts for session ${reservation.sessionId} ` +
        `— task graph pointer unreadable: ${error instanceof Error ? error.message : String(error)}`;
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
    // as runtime drift. Unprovable inputs yield an empty map: strict stays.
    const finalizeRestore = implementationBaselineRestoreFor(
      manager,
      reservation.items.flatMap((item) =>
        item.kind === "implementation" && item.taskId !== null ? [item.taskId] : []),
    );
    if (finalizeRestore.size > 0) {
      try {
        manager = StateManager.fromLocalSession(reservation.sessionId, finalizeRestore) ?? manager;
      } catch (error) {
        process.stderr.write(
          `loom(pi): baseline-restored manager construction failed; strict comparison stays: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
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
          if (item.implementationAuthority === null) {
            logs.push(
              `implementation slot ${index + 1}/${item.taskId} has no exact attempt authority — current reservation preserved`,
            );
            continue;
          }
          const retired = retireCompletedOrMissingImplementation(state, item.taskId, item);
          if (retired.retired) {
            state = retired.state;
            logs.push(`retired completed/missing implementation reservation for ${item.taskId}`);
            continue;
          }
          const failure = reservedImplementationFailure(
            item.agentType,
            item.taskId,
            item.implementationAuthority.taskId,
            entries[index],
          );
          if (failure === null) continue;

          const applied = settleUnavailableImplementation(
            state,
            item.implementationAuthority,
            finalizedAt.value,
            failure,
          );
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
      const diagnostic = `reserved implementation finalization failed: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
      return [diagnostic];
    }
  };

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
    processingErrors.push(...await finalizeReservedImplementations(entries));
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

  // A reservation is the authoritative expected batch. Pi may return a
  // shorter or reordered results array after a child disappears. Reconcile
  // every gate-owned slot before any malformed-details early return so stale
  // review/spec evidence cannot remain authoritative.
  if (reservation) {
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
        await persistCaptureRejection(runBinding, index, item.agentType, captureDiagnostic);
      }
    }
    // An ad-hoc batch has no State File to mark, so the persistence arm below
    // cannot run — which used to skip the whole reporting block, and a reserved
    // reviewer that died without returning left no trace anywhere. There is no
    // protected state to record an evidence failure against, so this stays
    // operator-visible rather than an orchestration failure; what must not
    // happen is silence.
    const missingGateOwned = missingReviews.length > 0 || missingSpecChecks.length > 0;
    if (missingGateOwned && spawnedWithoutTaskGraph(reservation)) {
      const diagnostic = unrecordableMissingEvidenceDiagnostic({
        sessionId: reservation.sessionId,
        reviews: missingReviews.length,
        specChecks: missingSpecChecks.length,
      });
      process.stderr.write(`loom(pi): ${diagnostic}\n`);
    }
    if (missingGateOwned && !spawnedWithoutTaskGraph(reservation)) {
      let manager: StateManager | null = null;
      let pointerReadFailed = false;
      try {
        manager = StateManager.fromLocalSession(reservation.sessionId);
      } catch (error) {
        // Guarded exactly like the sibling `manager.update` below. This
        // handler has no top-level try/catch, so an unguarded throw here —
        // resolveTaskGraph refuses its local fallback and throws for any
        // non-ENOENT read of the session pointer (EACCES/EIO/ELOOP/ENOTDIR)
        // — would escape the whole `tool_result` handler, skipping the
        // per-result evidence loop below and leaving tasks stuck
        // `executing` with zero diagnostics. The throw becomes a
        // processing error and the batch continues.
        pointerReadFailed = true;
        const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
          `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId} ` +
          `— task graph pointer unreadable: ${error instanceof Error ? error.message : String(error)}`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
      }
      if (pointerReadFailed) {
        // The diagnostic was already recorded above: the pointer is
        // present-but-unreadable, not absent, so the ad-hoc and
        // "task graph unavailable" arms do not apply. The batch continues
        // to the per-result evidence loop below.
      } else if (!manager) {
        const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
          `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId} — task graph unavailable`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}\n`);
      } else {
        const runAt = new Date().toISOString();
        // Guarded exactly like the sibling `manager.update` in
        // `finalizeReservedImplementations` above. This handler has no
        // top-level try/catch, so an unguarded throw here (corrupt state
        // JSON, lock contention, disk failure) escaped the whole
        // `tool_result` handler — skipping the per-result evidence loop
        // below, whose own comment demands that one failure must not abort
        // the rest of the batch — and left tasks stuck `executing` with zero
        // `processingErrors` and zero stderr. The throw now becomes a
        // diagnostic and the batch continues.
        try {
          const settled = await manager.updateAndReturn((state) => {
            const appliedReviewIndexes: number[] = [];
            const tasks = state.tasks.map<Task>((task) => {
              const failures = missingReviews.filter(({ item }) => item.taskId === task.id);
              return failures.reduce<Task>((current, { item, index }) => {
                if (piReviewAuthorityProblem(current, item.agentType, item.reviewAuthority) !== null) {
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
              const authority = missing.item.specCheckAuthority;
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
        } catch (error) {
          // The per-item lines above stay inside the `try`: they announce
          // evidence that was RECORDED, and printing them after a failed
          // write would report a state change that never happened.
          const diagnostic = `cannot persist ${missingReviews.length} missing reserved review result(s) and ` +
            `${missingSpecChecks.length} missing reserved spec-check result(s) for session ${reservation.sessionId}: ` +
            `${error instanceof Error ? error.message : String(error)}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        }
      }
    }
  }

  if (!hasResults) {
    const diagnostic = "subagent tool_result is missing details.results — successful evidence was not applied";
    processingErrors.push(diagnostic);
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    await cleanupParentTaskGraphPointer();
    return processingErrorResponse();
  }

  // Shape guard: a pi version drifting details.results away from an array
  // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
  if (!Array.isArray(details.results)) {
    const diagnostic =
      `subagent tool_result has unrecognized details.results shape (${typeof details.results}) — successful evidence was not applied`;
    processingErrors.push(diagnostic);
    process.stderr.write(`loom(pi): ${diagnostic}\n`);
    await cleanupParentTaskGraphPointer();
    return processingErrorResponse();
  }
  // Per-element parse, not a cast: the array-shape guard above says nothing
  // about any individual element, and `agent`/`task`/`exitCode` are read as
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
    // it, and is reported as loudly as the array-level shape drift above.
    if (!entry.ok) {
      processingErrors.push(entry.problem);
      process.stderr.write(`loom(pi): ${entry.problem}\n`);
      continue;
    }
    const result = entry.result;
    // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
    // while processing result #1 must not abort results #2..N — that
    // leaves tasks stuck "executing" with zero diagnostics.
    try {
      const agentType = stripNamespace(result.agent);
      const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
      const reservedItem = reservation?.items[resultIndex];
      const markers = orchestrationMarkers(
        result.task,
        `Pi result ${resultIndex + 1}/${agentType}`,
      );
      const durableRunBinding = reservation?.orchestrationRunBinding ??
        (markers !== null && resultSessionId !== null
          ? sessionRunBinding(resultSessionId, [markers])
          : null);
      const runBound = durableRunBinding !== null ||
        process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
      if (reservedItem && agentType !== reservedItem.agentType) {
        const diagnostic =
          `result ${resultIndex + 1} agent ${JSON.stringify(agentType)} does not match reserved ${JSON.stringify(reservedItem.agentType)}`;
        if (runBound) processingErrors.push(`request-bound ${diagnostic}`);
        process.stderr.write(`loom(pi): ${diagnostic} — evidence ignored\n`);
        continue;
      }
      if (durableRunBinding !== null) {
        const authorityProblem = markers === null
          ? `request-bound result ${resultIndex + 1}/${agentType} has no request/context markers`
          : piResultAuthorityProblem(durableRunBinding, toolCallId, resultIndex, agentType, markers);
        if (authorityProblem !== null) {
          const diagnostic = `request-bound result authority rejected for ${agentType}: ${authorityProblem}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}; transcript was not captured\n`);
          await persistCaptureRejection(durableRunBinding, resultIndex, agentType, diagnostic);
          continue;
        }
      }

      // Cleanup subagent flag. Parse the session id before interpolating it
      // into the SUBAGENT_DIR path (path-traversal guard); an unsafe id could
      // never have named a tracking file, so there is nothing to clean up.
      const safeSessionId = parseSessionId(sessionId);
      if (safeSessionId === null) {
        process.stderr.write(
          `loom: invalid session id ${JSON.stringify(sessionId)} — subagent flag cleanup skipped\n`,
        );
      } else if (!reservedItem) {
        // Compatibility for a result emitted by an older Pi call that predates
        // reservation capture. New calls always release above from authority.
        try {
          const rosterId = piSpawnRosterId(toolCallId, resultIndex, agentType);
          await fsSessionRegistry.removeActive(safeSessionId, rosterId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const diagnostic = `subagent flag cleanup failed for ${agentType}/${safeSessionId}: ${message}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom: ${diagnostic}\n`);
        }
      }

      const startupClassification = durableRunBinding !== null && reservation !== undefined && reservedItem !== undefined
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
        : Object.freeze({ kind: "ordinary" as const });
      if (startupClassification.kind === "untrusted-marker") {
        const diagnostic = `untrusted emission launch outcome for ${agentType}[${resultIndex}]: ${startupClassification.reason}`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}; applying the ordinary failed-result lifecycle\n`);
      }
      if (startupClassification.kind === "proven-startup-refusal") {
        const marker = startupClassification.marker;
        const diagnostic =
          `Emission startup refused before the Task prompt for issued request ${marker.requestId} ` +
          `(${agentType}, ${marker.toolName}): ${marker.reason}. ` +
          "Correct the launcher/readiness infrastructure and retry this same issued request with a new subagent tool call.";
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic} Semantic capture authority was retained.\n`);
        continue;
      }

      // Request-bound capture runs BEFORE the standalone short-circuit and
      // before any StateManager resolution — the same two orderings dispatch.ts
      // documents as load-bearing on the Claude side. Standalone results are
      // precisely the ones a run directory exists to collect, so capturing
      // after that `continue` would capture nothing for exactly the flows this
      // path serves; and capture must record evidence before any handler acts
      // on it. It reads only the run directory it is pointed at, never a State
      // File, so a run beside an active wave cannot cross into it.
      const agentFailure = piSubagentResultFailed(result) && runBound
        ? terminalCaptureRefusal(
            "agent-failed",
            `${agentType} exited without a successful result (${piSubagentFailureSignals(result)})`,
          )
        : null;
      const captureOutcome = await capturePiSubagentResult(
        toolCallId,
        resultIndex,
        agentType,
        result.messages,
        durableRunBinding,
        agentFailure,
      );
      if (captureOutcome.kind === "captured" && durableRunBinding !== null && resultSessionId !== null) {
        try {
          rememberTrustedReviewCapture(resultSessionId, durableRunBinding, agentType, result.task, captureOutcome);
        } catch (error) {
          const diagnostic = `cannot retain process-local review authority for ${agentType}: ${error instanceof Error ? error.message : String(error)}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        }
      }

      // Standalone review/refutation results are run artifacts. Short-circuit
      // before StateManager resolution so an unrelated local graph is neither
      // read nor mutated merely because it exists. When a run directory is
      // active, however, capture is mandatory evidence: a rejection or missing
      // correlator must be surfaced rather than disguised as a harmless
      // task-state short-circuit.
      if (runBound || reservedItem?.kind === "standalone" || hasStandaloneReviewContext(result.task)) {
        if (runBound && captureOutcome.kind !== "captured") {
          const detail = describeCaptureFailure(captureOutcome);
          const diagnostic = `standalone request-bound capture failed for ${agentType}: ${detail}`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}; task state untouched\n`);
        } else {
          process.stderr.write(
            piSubagentResultFailed(result)
              ? `loom(pi): failed standalone ${agentType} result ignored — task state untouched\n`
              : `loom(pi): ${agentType} belongs to a standalone review run — task state untouched\n`,
          );
        }
        continue;
      }

      // Any Loom-owned result under explicit run authority must have exact
      // request-bound evidence before protected state can change. Only truly
      // unrelated legacy agents may retain the no-reservation compatibility
      // path.
      if (captureOutcome.kind === "terminal-rejection" ||
          captureOutcome.kind === "retriable-failure" ||
          (runBound && isLoomOwnedResultAgent(agentType) && captureOutcome.kind !== "captured")) {
        const detail = describeCaptureFailure(captureOutcome);
        const diagnostic = `request-bound capture rejected for ${agentType}: ${detail}`;
        processingErrors.push(diagnostic);
        process.stderr.write(`loom(pi): ${diagnostic}; protected state unchanged\n`);
        continue;
      }

      if (spawnedWithoutTaskGraph(reservation)) {
        process.stderr.write(
          `loom(pi): ad-hoc ${agentType} completion — no TaskGraph existed at spawn, protected state untouched\n`,
        );
        continue;
      }

      const mgr = StateManager.fromLocalSession(sessionId);
      if (!mgr) {
        if (isLoomOwnedResultAgent(agentType)) {
          const diagnostic = `no task graph for session ${JSON.stringify(sessionId)}; ${agentType} completion was NOT applied`;
          processingErrors.push(diagnostic);
          process.stderr.write(`loom(pi): ${diagnostic}\n`);
        }
        continue;
      }

      // Each concern below is one named applier in `pi/subagent-result`, taking
      // the state store and the repository as ports. They decide and persist;
      // this dispatcher owns stderr and owns which of their diagnostics count as
      // orchestration processing errors.
      // Implementation settlement in this batch may have written declared
      // engine/src/pi artifacts: restore those attempts' declared, clean-at-spawn
      // artifacts to their attempt-start bytes for the write boundary's revision
      // comparison (see implementationBaselineRestoreFor). Unprovable inputs yield
      // an empty map and the strict full-domain comparison stays.
      let settlementMgr = mgr;
      try {
        const state = mgr.load();
        const settleTaskIds = [
          ...new Set([
            ...(state.executing_tasks ?? []),
            ...(reservation?.items ?? []).flatMap((item) => item.taskId === null ? [] : [item.taskId]),
          ]),
        ];
        const settleRestore = implementationBaselineRestoreFor(mgr, settleTaskIds);
        if (settleRestore.size > 0) {
          settlementMgr = StateManager.fromLocalSession(sessionId, settleRestore) ?? mgr;
        }
      } catch (error) {
        process.stderr.write(
          `loom(pi): implementation runtime-baseline restore unavailable, strict revision comparison stays: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      const store = settlementMgr;
      // One observation owns both Pi adapters. A Git failure throws and the
      // per-result shell records infrastructure failure; it never substitutes
      // the runtime checkout or cwd for the TaskGraph's project boundary.
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

      // A failed process may retain valid-looking assistant text. Never parse
      // that text as completion/review/spec evidence. Persist gate-owned
      // failure only under exact current reserved authority, so stale evidence
      // cannot overwrite a newer slot while a healthy sibling remains visible.
      if (piSubagentResultFailed(result)) {
        emit(await applyFailedPiResult({
          store,
          agentType,
          result,
          reservedSlot: reservedItem,
          now: new Date().toISOString(),
          projectBoundary,
        }));
        continue;
      }

      // --- Phase agent → advance phase ---
      const completedPhase = PHASE_AGENT_MAP[agentType];
      if (completedPhase) {
        emit(await applyPhaseAgentPiResult({
          store,
          agentType,
          completedPhase,
          result,
          now: new Date().toISOString(),
          // Phase artifacts and implementation settlement consume the same
          // TaskGraph Project Boundary observed above.
          phaseArtifactBaseDir: projectBoundary.root,
        }));
        continue;
      }

      // --- Impl agent → update task status ---
      if (IMPL_AGENTS.has(agentType)) {
        emit(await applyImplementationPiResult({
          store,
          repository,
          authoritativeStatePath: mgr.getPath(),
          agentType,
          result,
          reservedSlot: reservedItem,
          parentPrompt,
        }));
        continue;
      }

      // --- Review agent → store findings ---
      if (isReviewAgent(agentType)) {
        emit(await applyReviewPiResult({
          store,
          agentType,
          result,
          reservedSlot: reservedItem,
          parentPrompt,
        }));
        continue;
      }

      // --- Spec-check invoker → store spec-check findings ---
      if (agentType === "spec-check-invoker") {
        emit(await applySpecCheckPiResult({
          store,
          result,
          reservedSlot: reservedItem,
          now: new Date().toISOString(),
          projectBoundary,
        }));
        continue;
      }
    } catch (err) {
      // Loud + isolated: name the agent, the task (best effort), and the
      // cause, then continue with the next result.
      let taskIdForLog = "<unknown>";
      let taskIdFailure = "";
      try {
        taskIdForLog = extractTaskId(result?.task ?? "") ?? "<unknown>";
      } catch (error) {
        taskIdFailure = `; task-id extraction failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const diagnostic = `result ${resultIndex + 1} for agent ${String(result?.agent ?? "<unknown>")} (task ${taskIdForLog}${taskIdFailure}): ${err instanceof Error ? err.message : String(err)}`;
      const settlementErrors = await settleReservedImplementationCrash(
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

  await cleanupParentTaskGraphPointer();
  return processingErrorResponse();
}
