/**
 * The parent session's spawn reservations.
 *
 * A reservation is what the `tool_call` admission recorded about one spawn
 * batch — its slots, their authorities, its run and pointer bindings, and
 * whether a task graph was active at spawn — and is the authoritative
 * expectation the `tool_result` side settles against. This module owns that
 * aggregate and the one constructor of its items (`reservationItemOf`, with
 * the authority-free `legacyReservationItem` for cleanup debt and recovery),
 * its durable recovery from Run Directory correlators after the in-memory
 * copy is lost, and the per-session runtime that retains cleanup debt until
 * every capability it names is released.
 *
 * The reservation itself is in-memory only: recovery rebuilds it from the Run
 * Directory's correlators, never from a persisted reservation record, so the
 * item shape is free to be the typed `ReservedSlot` union.
 */

import type { TaskExecutionSpawn } from "../engine/src/core/validate-task-execution";
import { MAX_PI_ORCHESTRATION_BATCH_SIZE } from "../engine/src/core/spawn-admission";
import { subagentDir } from "../engine/src/config";
import {
  parseSessionId,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import { openRegisteredRunDirectory } from "../engine/src/orchestration/run-directory-handle";
import {
  readSessionRunBindings,
  type SessionRunBinding,
} from "../engine/src/orchestration/session-run-bindings";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import {
  piSubagentResultFailed,
  type PiSubagentResultEntry,
} from "./subagent-result-batch";
import {
  legacyReservedSlot,
  type ImplementationReservedSlot,
  type LegacyReservedSlot,
  type ReservedSlot,
  type ReviewReservedSlot,
  type SpecCheckReservedSlot,
} from "./reserved-slot";
import { parsePiMessages } from "./transcript-adapter";
import type { PiReservedEmissionLaunch } from "./emission-launch-bridge";
import { piSpawnRosterId } from "./tool-input";

export type PiSessionId = NonNullable<ReturnType<typeof parseSessionId>>;

/** The identity every reserved item carries beside its slot. */
type PiReservedItemIdentity = Readonly<{
  rosterId: AgentId;
  emissionLaunch: PiReservedEmissionLaunch | null;
}>;

/**
 * One reserved spawn item: its lifecycle kind and the `ReservedSlot` it
 * answers for, joined so each kind admits only the role authorities it can
 * carry. An implementation spawn holds implementation authority (or none);
 * a non-implementation spawn holds review or spec-check authority (or none);
 * a standalone spawn never holds Task-state authority. `kind` is the closed
 * lifecycle union, not an independent boolean pair: two booleans admitted the
 * impossible {implementation: true, standalone: true} and left the third
 * lifecycle state nameless.
 */
export type PiSpawnReservationItem =
  | (PiReservedItemIdentity & Readonly<{ kind: "implementation" }> & (ImplementationReservedSlot | LegacyReservedSlot))
  | (PiReservedItemIdentity & Readonly<{ kind: "non-implementation" }> &
      (ReviewReservedSlot | SpecCheckReservedSlot | LegacyReservedSlot))
  | (PiReservedItemIdentity & Readonly<{ kind: "standalone" }> & LegacyReservedSlot);

type PiReservedItemShape = PiReservedItemIdentity & Readonly<{ kind: TaskExecutionSpawn["kind"] }>;

/**
 * The one constructor of a reserved item from a parsed slot. Refuses a role
 * authority the item's lifecycle kind cannot carry, so the per-kind invariant
 * is checked at the producer, before dispatch.
 */
export function reservationItemOf(
  shape: PiReservedItemShape,
  slot: ReservedSlot,
): DomainResult<PiSpawnReservationItem, string> {
  const identity = { rosterId: shape.rosterId, emissionLaunch: shape.emissionLaunch };
  const refuse = (): DomainResult<PiSpawnReservationItem, string> =>
    failure(`reserved ${shape.kind} spawn item for ${slot.agentType} cannot carry ${slot.role} authority`);
  switch (shape.kind) {
    case "implementation":
      return slot.role === "implementation" || slot.role === "legacy"
        ? success(Object.freeze({ ...identity, kind: shape.kind, ...slot }))
        : refuse();
    case "non-implementation":
      return slot.role === "review" || slot.role === "spec-check" || slot.role === "legacy"
        ? success(Object.freeze({ ...identity, kind: shape.kind, ...slot }))
        : refuse();
    case "standalone":
      return slot.role === "legacy"
        ? success(Object.freeze({ ...identity, kind: shape.kind, ...slot }))
        : refuse();
  }
}

/**
 * A reserved item that keeps no role authority — total, because every
 * lifecycle kind admits the legacy slot. Admission cleanup debt (whose
 * authorities were never committed) and durably recovered reservations (whose
 * Task identity the Run Directory does not record) are built only this way.
 */
export function legacyReservationItem(
  shape: PiReservedItemShape,
  agentType: string,
  taskId: string | null,
): PiSpawnReservationItem {
  const slot = legacyReservedSlot(agentType, taskId);
  return Object.freeze({ rosterId: shape.rosterId, emissionLaunch: shape.emissionLaunch, kind: shape.kind, ...slot });
}

export type PiSpawnReservation = Readonly<{
  sessionId: PiSessionId;
  needsTaskGraphLifecycle: boolean;
  /**
   * Was a Loom task graph active for this session when the batch was spawned?
   *
   * Recorded at spawn because the RESULT side cannot infer it: "no task graph
   * now" is both the ad-hoc case (there was never one, so there is nothing to
   * apply) and the corruption case (one existed and vanished mid-run, so real
   * completion evidence is being dropped). Collapsing them made every ad-hoc
   * spawn report `completion was NOT applied` as a failure. Keeping the spawn
   * instant's answer lets the result side stay silent for the first and keep
   * failing loudly for the second.
   */
  graphActiveAtSpawn: boolean;
  orchestrationRunBinding: SessionRunBinding | null;
  pointerBinding: SessionTaskGraphPointerBinding | null;
  items: readonly PiSpawnReservationItem[];
}>;

/**
 * Did this batch run outside orchestration entirely?
 *
 * True only when a reservation PROVES no task graph was active at spawn. An
 * absent reservation (unknown provenance, legacy call, recovery failure)
 * answers false, so every existing missing-state diagnostic keeps firing —
 * this predicate can only silence a case it can positively account for.
 */
export function spawnedWithoutTaskGraph(reservation: PiSpawnReservation | undefined): boolean {
  return reservation !== undefined && !reservation.graphActiveAtSpawn;
}

export function reservedImplementationFailure(
  expectedAgent: string,
  expectedTaskId: string,
  authorityTaskId: string,
  entry: PiSubagentResultEntry | undefined,
): string | null {
  if (entry === undefined) return "reserved implementation result was missing";
  if (!entry.ok) return `reserved implementation result was malformed: ${entry.problem}`;
  const resultAgent = stripNamespace(entry.result.agent);
  if (resultAgent !== expectedAgent) {
    return `reserved ${expectedAgent} result was returned as ${resultAgent}`;
  }
  const parsedMessages = parsePiMessages(entry.result.messages);
  if (!parsedMessages.ok) {
    return `reserved implementation transcript was malformed: ${parsedMessages.errors.join("; ")}`;
  }
  const returnedTaskId = extractTaskId(entry.result.task);
  if (returnedTaskId === null || returnedTaskId !== expectedTaskId || returnedTaskId !== authorityTaskId) {
    return `reserved implementation result Task identity mismatch: returned=${returnedTaskId ?? "missing"}, ` +
      `reserved=${expectedTaskId}, authority=${authorityTaskId}`;
  }
  return piSubagentResultFailed(entry.result)
    ? `${expectedAgent} failed before implementation evidence completed`
    : null;
}

export function recoverPiSpawnReservation(
  rawSessionId: string,
  toolCallId: string,
): PiSpawnReservation | null {
  const sessionId = parseSessionId(rawSessionId);
  if (sessionId === null) throw new Error(`invalid Pi result session id ${JSON.stringify(rawSessionId)}`);
  const bindings = readSessionRunBindings(subagentDir(), sessionId, "pi");
  if (!bindings.ok) throw new Error(bindings.message);
  const recovered: PiSpawnReservation[] = [];
  const inaccessibleBindings: string[] = [];

  for (const binding of bindings.value) {
    const opened = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
    if (!opened.ok) {
      inaccessibleBindings.push(`${binding.runId}: ${opened.error.message}`);
      continue;
    }
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok) {
      inaccessibleBindings.push(`${binding.runId}: ${issued.error.message}`);
      continue;
    }
    const eligible = issued.value.filter((request) =>
      binding.requestIds.some((requestId) => requestId === request.requestId));
    const byIndex = new Map<number, { agentType: string; rosterId: AgentId }>();
    let correlatorFailure: string | null = null;
    for (const request of eligible) {
      for (let index = 0; index < MAX_PI_ORCHESTRATION_BATCH_SIZE; index += 1) {
        const nativeId = piSpawnRosterId(toolCallId, index, request.role);
        const correlator = opened.value.readHarnessCorrelator("pi", nativeId);
        if (!correlator.ok) {
          correlatorFailure = correlator.error.message;
          break;
        }
        if (correlator.value?.requestId !== request.requestId) continue;
        const previous = byIndex.get(index);
        if (previous !== undefined && previous.rosterId !== nativeId) {
          throw new Error(`Pi tool call ${toolCallId} has conflicting durable correlators at result index ${index}`);
        }
        byIndex.set(index, { agentType: request.role, rosterId: nativeId });
      }
      if (correlatorFailure !== null) break;
    }
    if (correlatorFailure !== null) {
      inaccessibleBindings.push(`${binding.runId}: ${correlatorFailure}`);
      continue;
    }
    if (byIndex.size === 0) continue;
    const indexes = [...byIndex.keys()].sort((left, right) => left - right);
    if (indexes.some((index, ordinal) => index !== ordinal)) {
      throw new Error(`Pi tool call ${toolCallId} durable correlators do not form a contiguous result roster`);
    }
    recovered.push(Object.freeze({
      sessionId,
      needsTaskGraphLifecycle: false,
      // A durably recovered reservation exists because a run directory issued
      // it, so it is orchestration work by construction. The spawn instant is
      // unrecoverable here, and `true` is the fail-closed answer: it keeps
      // every missing-state diagnostic loud rather than silencing one on a
      // guess.
      graphActiveAtSpawn: true,
      orchestrationRunBinding: binding,
      pointerBinding: null,
      // The Run Directory records request identity, not Task identity or
      // lifecycle kind: a recovered item is a standalone legacy slot.
      items: Object.freeze(indexes.map((index) => {
        const item = byIndex.get(index)!;
        return legacyReservationItem(
          { rosterId: item.rosterId, emissionLaunch: null, kind: "standalone" },
          item.agentType,
          null,
        );
      })),
    }));
  }
  if (recovered.length > 1) {
    throw new Error(`Pi tool call ${toolCallId} is bound to multiple orchestration runs`);
  }
  if (inaccessibleBindings.length > 0) {
    throw new Error(
      `Pi tool call ${toolCallId} could not be recovered unambiguously; inaccessible session bindings: ${inaccessibleBindings.join("; ")}`,
    );
  }
  return recovered[0] ?? null;
}

export interface PiParentSessionRuntime {
  readonly issuedWriteGrants: Map<string, readonly string[]>;
  readonly spawnReservations: Map<string, PiSpawnReservation>;
}

const emptyParentSessionRuntime = (): PiParentSessionRuntime => ({
  issuedWriteGrants: new Map(),
  spawnReservations: new Map(),
});

/** Does this reservation still name a capability someone must release? */
const holdsCleanupDebt = (reservation: PiSpawnReservation): boolean =>
  reservation.items.length > 0 || reservation.pointerBinding !== null;

/**
 * Every parent session's runtime in one Pi process. A Pi process may host
 * overlapping sessions, so reservations and capabilities are aggregates owned
 * by one parsed session, never process-global maps whose shutdown can consume
 * another session's state. A runtime exists only while it holds debt: the two
 * retain operations record what a tool call still owes and forget the session's
 * runtime in the same step once it owes nothing, so no caller can retain debt
 * and forget to prune (or prune before retaining).
 */
export type PiParentSessions = Readonly<{
  get: (sessionId: PiSessionId) => PiParentSessionRuntime | undefined;
  /** The session's runtime, created empty on first use. */
  runtimeFor: (sessionId: PiSessionId) => PiParentSessionRuntime;
  /** Retain exactly these unrevoked write-grant tokens for the tool call
   *  (none: forget its grants), then prune the session if it owes nothing. */
  retainWriteGrantDebt: (sessionId: PiSessionId, toolCallId: string, tokens: readonly string[]) => void;
  /** Retain the reservation while it still names a roster entry or pointer
   *  lease (otherwise forget it), then prune the session if it owes nothing. */
  retainSpawnCleanupDebt: (sessionId: PiSessionId, toolCallId: string, reservation: PiSpawnReservation) => void;
}>;

export function createPiParentSessions(): PiParentSessions {
  const runtimes = new Map<PiSessionId, PiParentSessionRuntime>();
  const runtimeFor = (sessionId: PiSessionId): PiParentSessionRuntime => {
    const existing = runtimes.get(sessionId);
    if (existing) return existing;
    const created = emptyParentSessionRuntime();
    runtimes.set(sessionId, created);
    return created;
  };
  const pruneIfIdle = (sessionId: PiSessionId): void => {
    const runtime = runtimes.get(sessionId);
    if (runtime !== undefined && runtime.issuedWriteGrants.size === 0 && runtime.spawnReservations.size === 0) {
      runtimes.delete(sessionId);
    }
  };
  return Object.freeze({
    get: (sessionId: PiSessionId) => runtimes.get(sessionId),
    runtimeFor,
    retainWriteGrantDebt: (sessionId: PiSessionId, toolCallId: string, tokens: readonly string[]) => {
      if (tokens.length > 0) runtimeFor(sessionId).issuedWriteGrants.set(toolCallId, Object.freeze([...tokens]));
      else runtimes.get(sessionId)?.issuedWriteGrants.delete(toolCallId);
      pruneIfIdle(sessionId);
    },
    retainSpawnCleanupDebt: (sessionId: PiSessionId, toolCallId: string, reservation: PiSpawnReservation) => {
      if (holdsCleanupDebt(reservation)) runtimeFor(sessionId).spawnReservations.set(toolCallId, Object.freeze(reservation));
      else runtimes.get(sessionId)?.spawnReservations.delete(toolCallId);
      pruneIfIdle(sessionId);
    },
  });
}
