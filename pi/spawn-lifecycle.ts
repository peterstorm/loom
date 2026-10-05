/**
 * Spawn lifecycle reservation: everything one admitted Pi spawn batch claims
 * before Pi may dispatch it.
 *
 * After `prepareSpawnBatch` admits a batch, this orchestrator reserves its
 * roster identities, task-graph pointer lease, request correlators, review
 * and spec-check authorities and write grants, injects the grants into the
 * child prompts, stages emission launches, registers task execution, and
 * records the reservation the `tool_result` side settles against. Every claim
 * made before a refusal is rolled back; whatever cannot be rolled back stays
 * on the parent session as cleanup debt that shutdown retries.
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
import { isReviewAgent, subagentDir } from "../engine/src/config";
import { StateManager } from "../engine/src/state-manager";
import {
  anyActiveSubagent,
  bindSessionTaskGraphPointer,
  fsSessionRegistry,
  rollbackSessionTaskGraphPointer,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import type { ImplementationAttemptAuthority } from "../engine/src/core/implementation-completion";
import { planPiWriteGrants } from "../engine/src/core/pi-write-grant-plan";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import {
  currentPiReviewAuthority,
  currentPiSpecCheckAuthority,
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
import {
  cleanupFailureSuffix,
  injectPiWriteGrantWithRevocation,
  runPiCleanupActions,
  type PiCleanupAction,
} from "./cleanup-actions";
import {
  retainSpawnCleanupDebt,
  type PiParentSessions,
  type PiSessionId,
} from "./spawn-reservation";
import type { SpawnBatchGraphAuthority } from "./spawn-preparation";

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
  const { parentSessions, emissionLaunchBridge, runtimeRevision, graphExists, enterGuard } = ports;
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
  const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
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
  type LifecycleWriteGrant = Readonly<{
    token: string;
    task: string;
    originalTask: string;
    injected: boolean;
  }>;
  type SpawnLifecycleState = PiSpawnLifecycleAssociation & Readonly<{
    dispatchTaskExecutionSpawn: TaskExecutionSpawn;
    writeGrant: LifecycleWriteGrant | null;
    reviewAuthority: PiReviewAttemptAuthority | null;
    implementationAuthority: ImplementationAttemptAuthority | null;
  }>;
  let spawnLifecycle: readonly SpawnLifecycleState[] = Object.freeze(
    associatePiSpawnLifecycle(admission.itemAdmissions, toolCallId).map((association) => Object.freeze({
      ...association,
      dispatchTaskExecutionSpawn: association.admission.taskExecutionSpawn,
      writeGrant: null,
      reviewAuthority: null,
      implementationAuthority: null,
    })),
  );
  const replaceLifecycleState = (replacement: SpawnLifecycleState): void => {
    spawnLifecycle = Object.freeze(spawnLifecycle.map((state) =>
      state.slot === replacement.slot ? replacement : state));
  };
  const reserved: AgentId[] = [];
  let taskGraphPointerBinding: SessionTaskGraphPointerBinding | null = null;
  let orchestrationRunBinding: SessionRunBinding | null = null;
  let specCheckAuthority: PiSpecCheckAttemptAuthority | null = null;
  let emissionLaunchStaged = false;
  const grantRollbackActions = (revoked: Set<string>): readonly PiCleanupAction[] =>
    spawnLifecycle.flatMap(({ slot, writeGrant }): readonly PiCleanupAction[] => writeGrant === null ? [] : [
      {
        label: `revoke write grant for spawn item ${slot + 1}`,
        run: () => {
          revokePiWriteGrant(writeGrant.token);
          revoked.add(writeGrant.token);
        },
      },
      ...(writeGrant.injected ? [{
        label: `restore child prompt for spawn item ${slot + 1}`,
        run: () => replacePiSpawnTask(event.input, slot, writeGrant.originalTask),
      }] : []),
    ]);
  const rosterRollbackActions = (removed: Set<AgentId>): readonly PiCleanupAction[] =>
    [...reserved].reverse().map((agentId) => ({
      label: `remove active roster entry ${agentId}`,
      run: async () => {
        await fsSessionRegistry.removeActive(safeSessionId, agentId);
        removed.add(agentId);
      },
    }));
  const retainAdmissionCleanupDebt = (
    revoked: ReadonlySet<string>,
    removed: ReadonlySet<AgentId>,
    pointerReleased: boolean,
  ): void => {
    const remainingGrantTokens = spawnLifecycle
      .flatMap(({ writeGrant }) => writeGrant === null ? [] : [writeGrant.token])
      .filter((token) => !revoked.has(token));
    const remainingRosterIds = new Set(reserved.filter((agentId) => !removed.has(agentId)));
    const remainingPointerBinding = pointerReleased ? null : taskGraphPointerBinding;
    if (remainingGrantTokens.length === 0 && remainingRosterIds.size === 0 && remainingPointerBinding === null) return;
    const runtime = parentSessions.runtimeFor(safeSessionId);
    if (remainingGrantTokens.length > 0) {
      runtime.issuedWriteGrants.set(toolCallId, Object.freeze(remainingGrantTokens));
    }
    retainSpawnCleanupDebt(runtime, toolCallId, {
      sessionId: safeSessionId,
      needsTaskGraphLifecycle,
      graphActiveAtSpawn: orchestrationGraphActive,
      orchestrationRunBinding,
      pointerBinding: remainingPointerBinding,
      items: Object.freeze(spawnLifecycle.flatMap((state) =>
        remainingRosterIds.has(state.rosterId)
          ? [Object.freeze({
              agentType: state.admission.item.agent,
              rosterId: state.rosterId,
              taskId: extractTaskId(state.admission.item.task),
              implementationAuthority: null,
              reviewAuthority: null,
              specCheckAuthority: null,
              emissionLaunch: reservedReviewerEmissionLaunch(
                state.admission.emissionExpectation,
                event.input,
                state.slot,
              ),
              kind: state.dispatchTaskExecutionSpawn.kind,
            })]
          : [])),
    });
  };
  const rollbackLifecycle = async (): Promise<readonly string[]> => {
    const revokedGrantTokens = new Set<string>();
    const removedRosterIds = new Set<AgentId>();
    let pointerReleased = false;
    const pointerActions: PiCleanupAction[] = [];
    if (taskGraphPointerBinding !== null) {
      const ownedPointer = taskGraphPointerBinding;
      pointerActions.push({
        label: "roll back task-graph pointer",
        run: async () => {
          const result = await rollbackSessionTaskGraphPointer(ownedPointer);
          if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
          pointerReleased = true;
        },
      });
    }
    const errors = await runPiCleanupActions([
      ...(emissionLaunchStaged ? [{
        label: `remove emission launch capabilities for ${toolCallId}`,
        run: () => {
          emissionLaunchBridge.removeToolCall(safeSessionId, toolCallId);
          emissionLaunchStaged = false;
        },
      }] : []),
      ...grantRollbackActions(revokedGrantTokens),
      ...rosterRollbackActions(removedRosterIds),
      ...pointerActions,
    ]);
    retainAdmissionCleanupDebt(revokedGrantTokens, removedRosterIds, pointerReleased);
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
    for (const { rosterId } of spawnLifecycle) {
      await fsSessionRegistry.markActive(safeSessionId, rosterId);
      reserved.push(rosterId);
    }
    if (needsTaskGraphLifecycle && graphExists(orchestrationGraphPath)) {
      taskGraphPointerBinding = await bindSessionTaskGraphPointer(
        safeSessionId,
        orchestrationGraphPath,
      );
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
      // Track the issued token on the paired item before prompt injection
      // can fail. If immediate revocation also fails, outer rollback
      // retries this exact association instead of orphaning a sibling's
      // grant.
      replaceLifecycleState(Object.freeze({
        ...state,
        writeGrant: Object.freeze({
          token: grant.token,
          task: item.task,
          originalTask: item.task,
          injected: false,
        }),
      }));
      const task = await injectPiWriteGrantWithRevocation(item.task, grant, slot);
      const tracked = spawnLifecycle[slot];
      if (tracked === undefined || tracked.writeGrant === null) {
        throw new Error(`Pi write-grant slot ${slot + 1} lost its issued grant association`);
      }
      replaceLifecycleState(Object.freeze({
        ...tracked,
        writeGrant: Object.freeze({ ...tracked.writeGrant, task }),
      }));
    }
    // Mutate before task-state validation. Rollback restores prompts and
    // revokes grants, leaving no post-validation operation that can fail
    // after executing_tasks/baselines have committed.
    for (const state of spawnLifecycle) {
      if (state.writeGrant === null) continue;
      replacePiSpawnTask(event.input, state.slot, state.writeGrant.task);
      replaceLifecycleState(Object.freeze({
        ...state,
        writeGrant: Object.freeze({ ...state.writeGrant, injected: true }),
      }));
    }
    spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => {
      const spawn = state.admission.taskExecutionSpawn;
      if (spawn.kind !== "implementation") return state;
      if (!isRecord(event.input)) {
        throw new Error("Pi implementation input became malformed before dispatch registration");
      }
      const prompt = piSpawnItem(event.input as Record<string, unknown>, state.slot).task;
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
      const finalTask = piSpawnItem(event.input as Record<string, unknown>, state.slot).task;
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
      emissionLaunchStaged = true;
    }
  } catch (error) {
    const cleanupErrors = await rollbackLifecycle();
    return {
      block: true,
      reason: `Cannot record Loom subagent lifecycle evidence; refusing spawn: ${error instanceof Error ? error.message : String(error)}${cleanupFailureSuffix(cleanupErrors)}`,
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
      `${error instanceof Error ? error.message : String(error)}${cleanupFailureSuffix(cleanupErrors)}`,
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
  if (!alignment.ok) {
    const registrationRollback = await rollbackTaskExecutionRegistration(
      taskRegistration.authorities,
      spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, cwd),
    );
    const cleanupErrors = await rollbackLifecycle();
    const rollbackErrors = [
      ...(registrationRollback.kind === "block" ? [registrationRollback.message] : []),
      ...cleanupErrors,
    ];
    return {
      block: true,
      reason: `BLOCKED: ${alignment.error}${cleanupFailureSuffix(rollbackErrors)}`,
    };
  }
  if (alignment.authoritiesBySlot.length !== spawnLifecycle.length) {
    const registrationRollback = await rollbackTaskExecutionRegistration(
      taskRegistration.authorities,
      spawnGraphPath === null ? undefined : piSpawnCwd(event.input, 0, cwd),
    );
    const cleanupErrors = await rollbackLifecycle();
    return {
      block: true,
      reason: `BLOCKED: implementation authority alignment lost its structural spawn association${cleanupFailureSuffix([
        ...(registrationRollback.kind === "block" ? [registrationRollback.message] : []),
        ...cleanupErrors,
      ])}`,
    };
  }
  spawnLifecycle = Object.freeze(spawnLifecycle.map((state) => Object.freeze({
    ...state,
    implementationAuthority: alignment.authoritiesBySlot[state.slot] ?? null,
  })));
  const sessionRuntime = parentSessions.runtimeFor(safeSessionId);
  const issuedGrantTokens = spawnLifecycle.flatMap(({ writeGrant }) =>
    writeGrant === null ? [] : [writeGrant.token]);
  if (issuedGrantTokens.length > 0) {
    sessionRuntime.issuedWriteGrants.set(toolCallId, Object.freeze(issuedGrantTokens));
  }
  sessionRuntime.spawnReservations.set(toolCallId, {
    sessionId: safeSessionId,
    needsTaskGraphLifecycle,
    graphActiveAtSpawn: orchestrationGraphActive,
    orchestrationRunBinding,
    pointerBinding: taskGraphPointerBinding,
    items: Object.freeze(spawnLifecycle.map((state) => ({
      agentType: state.admission.item.agent,
      rosterId: state.rosterId,
      taskId: extractTaskId(state.admission.item.task),
      implementationAuthority: state.implementationAuthority,
      reviewAuthority: state.reviewAuthority,
      specCheckAuthority: state.admission.item.agent === "spec-check-invoker" ? specCheckAuthority : null,
      emissionLaunch: reservedReviewerEmissionLaunch(
        state.admission.emissionExpectation,
        event.input,
        state.slot,
      ),
      kind: state.dispatchTaskExecutionSpawn.kind,
    }))),
  });
  return undefined;
}
