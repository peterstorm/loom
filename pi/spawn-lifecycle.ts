/**
 * Spawn lifecycle reservation: everything one admitted Pi spawn batch claims
 * before Pi may dispatch it.
 *
 * After `prepareSpawnBatch` admits a batch, this orchestrator reserves its
 * roster identities, task-graph pointer lease, request correlators, review
 * and spec-check authorities and write grants, injects the grants into the
 * child prompts, stages emission launches, registers task execution, and
 * records the reservation the `tool_result` side settles against. Every
 * capability it takes — the standalone review run it binds as current
 * included — is recorded in the batch's claims ledger (`pi/spawn-claims.ts`)
 * no later than the step that takes it; a refusal releases the ledger in its
 * one planned order, and whatever cannot be released stays on the parent
 * session as cleanup debt that shutdown retries. Role-bearing items are built
 * only by `reservationItemOf` and debt items only by `legacyReservationItem`
 * (`pi/spawn-reservation.ts`), so a contradictory slot refuses the spawn here
 * rather than reaching settlement.
 *
 * Pi dispatches the live argument object it handed the `tool_call` handler,
 * so the injected prompts are written into `event.input` in place. The
 * orchestrator names each lifecycle stage through `enterGuard` before its
 * I/O, so a crash that escapes it fails closed under that stage's name.
 */

import { mkdirSync } from "node:fs";
import type { SpawnAdmission } from "../engine/src/core/spawn-admission";
import {
  type TaskExecutionRosterObservation,
  type TaskExecutionSpawn,
} from "../engine/src/core/validate-task-execution";
import {
  registerTaskExecutionBatch,
  rollbackTaskExecutionRegistration,
} from "../engine/src/handlers/task-execution";
import { isRecord } from "../engine/src/core/plain-record";
import { hasStandaloneReviewContext } from "../engine/src/core/review-output";
import { subagentDir } from "../engine/src/config";
import { isReviewAgent } from "../engine/src/core/agent-catalog-projections";
import { StateManager } from "../engine/src/state-manager";
import {
  anyActiveSubagent,
  bindSessionTaskGraphPointer,
  fsSessionRegistry,
  rollbackSessionTaskGraphPointer,
} from "../engine/src/machine";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import type { ImplementationAttemptAuthority } from "../engine/src/core/implementation-completion";
import { planPiWriteGrants } from "../engine/src/core/pi-write-grant-plan";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import {
  currentPiReviewAuthority,
  currentPiSpecCheckAuthority,
  parseReservedSlot,
  type PiReviewAttemptAuthority,
  type PiSpecCheckAttemptAuthority,
} from "./reserved-slot";
import { alignPiImplementationAuthorities } from "./reserved-results";
import { issuePiWriteGrant, revokePiWriteGrant } from "./write-grant";
import { LOOM_INTERACTIVE_SUBAGENT_TOOL } from "./interactive-subagent";
import {
  associatePiSpawnLifecycle,
  piSpawnCwd,
  piSpawnItem,
  replacePiSpawnTask,
  type PiSpawnLifecycleAssociation,
} from "./tool-input";
import {
  piSubagentLaunchSlot,
  reservedReviewerEmissionLaunch,
  type PiEmissionLaunchBridge,
  type PiEmissionLaunchExpectation,
} from "./emission-launch-bridge";
import { recordPiSpawnCorrelators } from "./review-run-authority";
import type { TrustedReviewWitnesses } from "./trusted-review-witness";
import {
  cleanupFailureSuffix,
  describeCause,
  directReleaseFailureSuffix,
  injectPiWriteGrantWithRevocation,
  type PiCleanupAction,
} from "./cleanup-actions";
import {
  claimEmissionLaunches,
  claimGrantInjection,
  claimPointerLease,
  claimRosterEntry,
  claimWitnessRun,
  claimWriteGrant,
  NO_SPAWN_CLAIMS,
  releaseExactPointerLease,
  releaseSpawnClaims,
  remainingSpawnDebt,
  spawnRollbackStepLabel,
  type SpawnClaims,
} from "./spawn-claims";
import {
  legacyReservationItem,
  reservationItemOf,
  type PiParentSessions,
  type PiSessionId,
  type PiSpawnReservationItem,
} from "./spawn-reservation";
import type { SpawnBatchGraphAuthority } from "./spawn-preparation";
import type { DomainResult } from "../engine/src/core/orchestration-contract/identity";

/**
 * The ledger after a claim; when the ledger refuses it, the capability just
 * taken is owed by no rollback, so it is released directly and the refusal
 * thrown (carrying that release's failure, if any).
 */
async function claimOrReleaseUnclaimed(
  claimed: DomainResult<SpawnClaims, string>,
  releaseUnclaimed: PiCleanupAction,
): Promise<SpawnClaims> {
  if (claimed.ok) return claimed.value;
  throw new Error(`${claimed.error}${await directReleaseFailureSuffix(releaseUnclaimed)}`);
}

/** A `tool_call` refusal in the shape Pi reads. */
export type PiSpawnRefusal = Readonly<{ block: true; reason: string }>;

export type PiSpawnLifecycleRequest = Readonly<{
  /** The live tool call; its `input` is the argument object Pi dispatches. */
  event: Readonly<{ toolName: string; input: unknown; toolCallId?: unknown }>;
  /** The parent's cwd, the base every spawn cwd resolves against. */
  cwd: string;
  /** The raw session id, named verbatim in the invalid-session refusal. */
  sessionId: string;
  safeSessionId: PiSessionId | null;
  admission: Extract<SpawnAdmission, { kind: "admit" }>;
  graph: SpawnBatchGraphAuthority;
}>;

export type PiSpawnLifecyclePorts = Readonly<{
  parentSessions: PiParentSessions;
  emissionLaunchBridge: PiEmissionLaunchBridge;
  /** The witness aggregate a standalone review's first exact spawn binds. */
  reviewWitnesses: TrustedReviewWitnesses;
  /** The content-addressed runtime revision staged emission launches carry. */
  runtimeRevision: string;
  /** Fail-closed existence probe for the governing task graph. */
  graphExists: (path: string) => boolean;
  /** Names the lifecycle stage about to run, for fail-closed attribution. */
  enterGuard: (guard: string) => void;
}>;

/** Reserve one admitted batch's lifecycle, or refuse it with every claim it
 *  made rolled back (or retained as cleanup debt). Resolves `undefined` when
 *  the batch may dispatch. */
export async function reservePiSpawnLifecycle(
  request: PiSpawnLifecycleRequest,
  ports: PiSpawnLifecyclePorts,
): Promise<PiSpawnRefusal | undefined> {
  const { event, cwd, sessionId, safeSessionId, admission } = request;
  const { parentSessions, emissionLaunchBridge, reviewWitnesses, runtimeRevision, graphExists, enterGuard } = ports;
  const {
    active: orchestrationGraphActive,
    path: orchestrationGraphPath,
    spawnGraphPath,
  } = request.graph;
  const emissionEnabledItems = admission.itemAdmissions.filter(
    ({ emissionExpectation }) => emissionExpectation.kind === "emission-enabled",
  );
  if (emissionEnabledItems.length > 0) {
    enterGuard("emission-launcher-capability");
    if (event.toolName !== "subagent") {
      return {
        block: true,
        reason: "Emission-enabled requests require the installed normal subagent launcher; interactive transport cannot provision the readiness barrier.",
      };
    }
    const launcherCapability = emissionLaunchBridge.probe();
    if (launcherCapability.kind === "unavailable") {
      return {
        block: true,
        reason: `Emission-enabled spawn refused: ${launcherCapability.reason}. ` +
          "Inspect/install/reload the shared launcher before retrying; Loom will not silently send a JSON-only prompt.",
      };
    }
  }
  const needsTaskGraphLifecycle = admission.needsTaskGraphLifecycle;

  // Reserve every lifecycle identity before task-state mutation. A roster
  // failure can now refuse the spawn without leaving executing_tasks or
  // artifact baselines claiming work began. The ids hash the tool call,
  // the batch ordinal, and the agent type — task text is deliberately
  // excluded (see `piSpawnRosterId`) — so repeated verifier/designer types in
  // one batch remain distinct without the id moving when the prompt does.
  enterGuard("subagent-tracking");
  if (safeSessionId === null) {
    return {
      block: true,
      reason: `Cannot record Loom subagent lifecycle evidence for invalid session id ${JSON.stringify(sessionId)}; refusing spawn.`,
    };
  }
  const toolCallId = event.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId === "") {
    return {
      block: true,
      reason: "Cannot bind Loom subagent lifecycle cleanup without a subagent toolCallId; refusing spawn.",
    };
  }
  const existingRuntime = parentSessions.get(safeSessionId);
  if (existingRuntime?.spawnReservations.has(toolCallId) ||
      existingRuntime?.issuedWriteGrants.has(toolCallId)) {
    return {
      block: true,
      reason: `Duplicate Pi subagent toolCallId ${JSON.stringify(toolCallId)} in session ${safeSessionId}; refusing spawn.`,
    };
  }
  type SpawnLifecycleState = PiSpawnLifecycleAssociation & Readonly<{
    dispatchTaskExecutionSpawn: TaskExecutionSpawn;
    /** The child prompt carrying this slot's write grant, once injected. */
    grantedTask: string | null;
    reviewAuthority: PiReviewAttemptAuthority | null;
  }>;
  let spawnLifecycle: readonly SpawnLifecycleState[] = Object.freeze(
    associatePiSpawnLifecycle(admission.itemAdmissions, toolCallId).map((association) => Object.freeze({
      ...association,
      dispatchTaskExecutionSpawn: association.admission.taskExecutionSpawn,
      grantedTask: null,
      reviewAuthority: null,
    })),
  );
  const replaceLifecycleState = (replacement: SpawnLifecycleState): void => {
    spawnLifecycle = Object.freeze(spawnLifecycle.map((state) =>
      state.slot === replacement.slot ? replacement : state));
  };
  const emissionLaunchOf = (state: SpawnLifecycleState) =>
    reservedReviewerEmissionLaunch(state.admission.emissionExpectation, event.input, state.slot);
  // Every capability taken so far, and the run binding a debt record names.
  let claims: SpawnClaims = NO_SPAWN_CLAIMS;
  let orchestrationRunBinding: SessionRunBinding | null = null;
  let specCheckAuthority: PiSpecCheckAttemptAuthority | null = null;
  const rollbackLifecycle = async (): Promise<readonly string[]> => {
    const { errors, releases } = await releaseSpawnClaims(claims, (step) => spawnRollbackStepLabel(step, toolCallId), {
      removeEmissionLaunches: () => emissionLaunchBridge.removeToolCall(safeSessionId, toolCallId),
      revokeGrant: revokePiWriteGrant,
      restorePrompt: (slot, originalTask) => replacePiSpawnTask(event.input, slot, originalTask),
      retractWitnessRun: (binding) => reviewWitnesses.retract(safeSessionId, binding),
      removeRosterEntry: (agentId) => fsSessionRegistry.removeActive(safeSessionId, agentId),
      releasePointer: rollbackSessionTaskGraphPointer,
    });
    const debt = remainingSpawnDebt(claims, releases, {
      sessionId: safeSessionId,
      needsTaskGraphLifecycle,
      graphActiveAtSpawn: orchestrationGraphActive,
      orchestrationRunBinding,
    });
    parentSessions.retainWriteGrantDebt(safeSessionId, toolCallId, debt.grants);
    parentSessions.retainSpawnCleanupDebt(safeSessionId, toolCallId, debt.reservation);
    return errors;
  };
  // Observe graph activity before this prospective batch writes its own
  // roster rows. Those rows prove only that admission is in progress;
  // treating them as an older reservation's liveness makes a timestamped
  // reservation stranded by process death unrecoverable forever. Keep the
  // observation typed so the registration core can limit this ordering
  // exception to current-protocol (timestamped) reservations.
  const rosterObservation: TaskExecutionRosterObservation | undefined =
    orchestrationGraphActive && spawnLifecycle.some(({ admission }) =>
      admission.taskExecutionSpawn.kind === "implementation")
      ? {
          kind: "pre-roster-current-protocol",
          anyActiveForGraph: anyActiveSubagent(orchestrationGraphPath),
        }
      : undefined;
  try {
    mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
    for (const state of spawnLifecycle) {
      // Claim before acquiring: the entry is owed from the moment markActive
      // may write it, so neither markActive's own failure nor building the
      // item can leave an active entry the rollback does not know. Removing
      // an entry that was never written is a no-op. The debt shape of a
      // roster entry carries no role authority: none is committed until the
      // whole reservation is.
      claims = claimRosterEntry(claims, legacyReservationItem(
        { rosterId: state.rosterId, emissionLaunch: emissionLaunchOf(state), kind: state.dispatchTaskExecutionSpawn.kind },
        state.admission.item.agent,
        extractTaskId(state.admission.item.task),
      ));
      await fsSessionRegistry.markActive(safeSessionId, state.rosterId);
    }
    if (needsTaskGraphLifecycle && graphExists(orchestrationGraphPath)) {
      const lease = await bindSessionTaskGraphPointer(safeSessionId, orchestrationGraphPath);
      claims = await claimOrReleaseUnclaimed(claimPointerLease(claims, lease), {
        label: "roll back unclaimed task-graph pointer",
        run: () => releaseExactPointerLease(rollbackSessionTaskGraphPointer, lease),
      });
    }
    // Bind every Loom-owned Pi native spawn identity to the exact issued
    // request before the harness can dispatch the batch. The durable run
    // directory, not the in-memory lifecycle map below, owns capture
    // authority for both Pi and Claude.
    orchestrationRunBinding = await recordPiSpawnCorrelators(
      spawnLifecycle.map(({ admission }) => admission),
      spawnLifecycle.map(({ rosterId }) => rosterId),
      safeSessionId,
      event.input,
    );
    // The first exact standalone spawn makes its run current for the root;
    // a retry of the same run never reorders it. A run this spawn newly made
    // current is a claim: a later refusal retracts it, so the root's current
    // run is never one no dispatched spawn can witness.
    if (orchestrationRunBinding !== null &&
        spawnLifecycle.some(({ admission }) => hasStandaloneReviewContext(admission.item.task)) &&
        reviewWitnesses.touch(safeSessionId, orchestrationRunBinding) === "bound") {
      const bound = orchestrationRunBinding;
      claims = await claimOrReleaseUnclaimed(claimWitnessRun(claims, bound), {
        label: `retract unclaimed review run ${bound.runId}`,
        run: () => reviewWitnesses.retract(safeSessionId, bound),
      });
    }
    const unboundSpecChecks = orchestrationRunBinding === null
      ? spawnLifecycle.filter(({ admission }) => admission.item.agent === "spec-check-invoker")
      : [];
    if (orchestrationGraphActive && unboundSpecChecks.length > 0) {
      if (unboundSpecChecks.length !== 1) {
        throw new Error("a protected Pi spawn may reserve exactly one unbound spec-check slot");
      }
      const manager = StateManager.fromLocalSession(safeSessionId);
      if (manager === null) throw new Error("protected Pi spec-check spawn has no TaskGraph authority");
      specCheckAuthority = currentPiSpecCheckAuthority(manager.load());
      if (specCheckAuthority === null) {
        throw new Error("protected Pi spec-check spawn lacks exact current Wave slot/attempt authority");
      }
    }
    const unboundReviewers = orchestrationRunBinding === null
      ? spawnLifecycle.filter(({ admission }) =>
          isReviewAgent(admission.item.agent) && admission.taskExecutionSpawn.kind !== "standalone")
      : [];
    if (orchestrationGraphActive && unboundReviewers.length > 0) {
      const manager = StateManager.fromLocalSession(safeSessionId);
      if (manager === null) throw new Error("protected Pi reviewer spawn has no TaskGraph authority");
      const reviewGraph = manager.load();
      spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => {
        const { item, taskExecutionSpawn } = state.admission;
        if (!isReviewAgent(item.agent) || taskExecutionSpawn.kind === "standalone") return state;
        const taskId = extractTaskId(item.task);
        const authority = taskId === null ? null : currentPiReviewAuthority(reviewGraph, item.agent, taskId);
        if (authority === null) {
          throw new Error(`protected Pi reviewer ${item.agent} lacks exact current Task/Review Run authority`);
        }
        return Object.freeze({ ...state, reviewAuthority: authority });
      }));
    }
    // Implementation items get the classic whole-session capability bound
    // to their task-graph Task ID. Phase/panel agents (non-implementation)
    // get a SCOPED capability bound to their prompt-derived artifact dirs
    // (".claude/specs/{slug}/", ".claude/plans/", panel candidate dirs) —
    // the Pi analogue of the phase-agent write exemption Claude Code gets
    // via subagent PIDs, and the capability the phase templates promise.
    // Read-only spawns (standalone reviews, verifiers, panel judges,
    // decompose, spec-check) get nothing even when their prompts NAME
    // artifact paths — a judge's candidate paths are reads, not write
    // scope. And OUTSIDE orchestration nobody gets one at all:
    // block-direct-edits allows every edit when no task graph exists, so
    // a grant would authorize nothing that was not already permitted,
    // while its Task ID requirement refused the spawn outright.
    const grantPlan = planPiWriteGrants(
      spawnLifecycle.map(({ admission }) => admission.item),
      spawnLifecycle.map(({ admission }) => admission.taskExecutionSpawn),
      orchestrationGraphActive,
    );
    if (!grantPlan.ok) throw new Error(grantPlan.error);
    if (grantPlan.requirements.length !== spawnLifecycle.length) {
      throw new Error("Pi write-grant plan lost its structural spawn association");
    }
    for (const [slot, requirement] of grantPlan.requirements.entries()) {
      if (requirement.kind === "none") continue;
      const state = spawnLifecycle[slot];
      if (state === undefined || state.slot !== slot) {
        throw new Error(`Pi write-grant slot ${slot + 1} lost its admitted spawn association`);
      }
      const item = state.admission.item;
      const grant = issuePiWriteGrant({
        agent: item.agent,
        taskId: requirement.taskId,
        cwd: piSpawnCwd(event.input, slot, cwd),
        taskGraphPath: orchestrationGraphPath,
        ...(requirement.kind === "scoped" ? { scopeDirs: requirement.scopeDirs } : {}),
      });
      // Claim the issued token for its slot before prompt injection can
      // fail. If immediate revocation also fails, the rollback retries this
      // exact grant instead of orphaning a sibling's. A slot the ledger
      // refuses (one already holding a grant) leaves this token unowed by
      // the rollback, so it is revoked here before the refusal propagates.
      claims = await claimOrReleaseUnclaimed(claimWriteGrant(claims, { slot, token: grant.token }), {
        label: `revoke unclaimed write grant for spawn item ${slot + 1}`,
        run: () => revokePiWriteGrant(grant.token),
      });
      const task = await injectPiWriteGrantWithRevocation(item.task, grant, slot);
      replaceLifecycleState(Object.freeze({ ...state, grantedTask: task }));
    }
    // Mutate before task-state validation. Rollback restores prompts and
    // revokes grants, leaving no post-validation operation that can fail
    // after executing_tasks/baselines have committed. Each rewrite is claimed
    // before the prompt changes, so a refusal or a failed write still plans
    // its restore.
    for (const state of spawnLifecycle) {
      if (state.grantedTask === null) continue;
      const claimed = claimGrantInjection(claims, { slot: state.slot, originalTask: state.admission.item.task });
      if (!claimed.ok) throw new Error(claimed.error);
      claims = claimed.value;
      replacePiSpawnTask(event.input, state.slot, state.grantedTask);
    }
    spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => {
      const spawn = state.admission.taskExecutionSpawn;
      if (spawn.kind !== "implementation") return state;
      if (!isRecord(event.input)) {
        throw new Error("Pi implementation input became malformed before dispatch registration");
      }
      const prompt = piSpawnItem(event.input, state.slot).task;
      if (typeof prompt !== "string") {
        throw new Error(`Pi implementation spawn item ${state.slot + 1} lost its child-visible prompt`);
      }
      return Object.freeze({
        ...state,
        dispatchTaskExecutionSpawn: Object.freeze({ ...spawn, prompt }),
      });
    }));

    const launchExpectations = spawnLifecycle.flatMap((state): readonly PiEmissionLaunchExpectation[] => {
      const expectation = state.admission.emissionExpectation;
      if (expectation.kind !== "emission-enabled") return [];
      if (!isRecord(event.input)) {
        throw new Error("Pi emission input became malformed before launcher provisioning");
      }
      const finalTask = piSpawnItem(event.input, state.slot).task;
      if (typeof finalTask !== "string") {
        throw new Error(`Pi emission spawn item ${state.slot + 1} lost its final child task`);
      }
      return [Object.freeze({
        sessionId: safeSessionId,
        toolCallId,
        slot: piSubagentLaunchSlot(event.input, state.slot),
        agent: state.admission.item.agent,
        task: finalTask,
        cwd: piSpawnCwd(event.input, state.slot, cwd),
        expectation,
        revision: runtimeRevision,
      })];
    });
    if (launchExpectations.length > 0) {
      const staged = emissionLaunchBridge.stage(launchExpectations);
      if (!staged.ok) throw new Error(staged.reason);
      claims = claimEmissionLaunches(claims);
    }
  } catch (error) {
    const cleanupErrors = await rollbackLifecycle();
    return {
      block: true,
      reason: `Cannot record Loom subagent lifecycle evidence; refusing spawn: ${describeCause(error)}${cleanupFailureSuffix(cleanupErrors)}`,
    };
  }

  enterGuard("validate-task-execution");
  let taskRegistration;
  try {
    const executionMode = event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL ||
        Array.isArray((event.input as { chain?: unknown }).chain)
      ? "sequential" as const
      : "parallel" as const;
    taskRegistration = orchestrationGraphActive
      ? await registerTaskExecutionBatch(
          spawnLifecycle.map(({ dispatchTaskExecutionSpawn }) => dispatchTaskExecutionSpawn),
          executionMode,
          rosterObservation,
          spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, cwd),
        )
      : { kind: "registered" as const, authorities: Object.freeze([]) };
  } catch (error) {
    const cleanupErrors = await rollbackLifecycle();
    throw new Error(
      `${describeCause(error)}${cleanupFailureSuffix(cleanupErrors)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (taskRegistration.kind === "block") {
    const cleanupErrors = await rollbackLifecycle();
    return { block: true, reason: `${taskRegistration.message}${cleanupFailureSuffix(cleanupErrors)}` };
  }
  const alignment = orchestrationGraphActive
    ? alignPiImplementationAuthorities(
        spawnLifecycle.map(({ admission }) => admission.item),
        spawnLifecycle.map(({ dispatchTaskExecutionSpawn }) => dispatchTaskExecutionSpawn),
        taskRegistration.authorities,
      )
    : {
        ok: true as const,
        authoritiesBySlot: Object.freeze(spawnLifecycle.map(() => null)),
      };
  // A registered batch that cannot be aligned unwinds in one fixed order:
  // the task-state registration first, then every lifecycle claim.
  const refuseRegisteredBatch = async (
    authorities: readonly ImplementationAttemptAuthority[],
    problem: string,
  ): Promise<PiSpawnRefusal> => {
    const registrationRollback = await rollbackTaskExecutionRegistration(
      authorities,
      spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, cwd),
    );
    const cleanupErrors = await rollbackLifecycle();
    return {
      block: true,
      reason: `BLOCKED: ${problem}${cleanupFailureSuffix([
        ...(registrationRollback.kind === "block" ? [registrationRollback.message] : []),
        ...cleanupErrors,
      ])}`,
    };
  };
  if (!alignment.ok) return refuseRegisteredBatch(taskRegistration.authorities, alignment.error);
  if (alignment.authoritiesBySlot.length !== spawnLifecycle.length) {
    return refuseRegisteredBatch(
      taskRegistration.authorities,
      "implementation authority alignment lost its structural spawn association",
    );
  }
  // Parse every slot's role claims at the producer: a contradictory slot
  // refuses the registered batch here, never at settlement.
  const reservedItem = (state: SpawnLifecycleState): DomainResult<PiSpawnReservationItem, string> => {
    const slot = parseReservedSlot({
      agentType: state.admission.item.agent,
      taskId: extractTaskId(state.admission.item.task),
      implementationAuthority: alignment.authoritiesBySlot[state.slot] ?? null,
      reviewAuthority: state.reviewAuthority,
      specCheckAuthority: state.admission.item.agent === "spec-check-invoker" ? specCheckAuthority : null,
    });
    if (!slot.ok) return slot;
    return reservationItemOf(
      { rosterId: state.rosterId, emissionLaunch: emissionLaunchOf(state), kind: state.dispatchTaskExecutionSpawn.kind },
      slot.value,
    );
  };
  const items: PiSpawnReservationItem[] = [];
  for (const state of spawnLifecycle) {
    const item = reservedItem(state);
    if (!item.ok) return refuseRegisteredBatch(taskRegistration.authorities, item.error);
    items.push(item.value);
  }
  const sessionRuntime = parentSessions.runtimeFor(safeSessionId);
  if (claims.grants.length > 0) {
    sessionRuntime.issuedWriteGrants.set(toolCallId, claims.grants);
  }
  sessionRuntime.spawnReservations.set(toolCallId, Object.freeze({
    sessionId: safeSessionId,
    needsTaskGraphLifecycle,
    graphActiveAtSpawn: orchestrationGraphActive,
    orchestrationRunBinding,
    pointerBinding: claims.pointer,
    items: Object.freeze(items),
  }));
  return undefined;
}
