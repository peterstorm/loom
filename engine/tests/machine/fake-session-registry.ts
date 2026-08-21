/**
 * In-memory SessionRegistry fake — the port's test double. Mirrors the fs
 * adapter's nominal semantics exactly:
 *   - bind appends; it never truncates the ledger (see bindMachineAgent)
 *   - unbind removes every binding matching (agentId, agentType)
 *   - soleActiveBinding: the SHARED pure decision (resolveSoleActiveBinding)
 *     — exactly one binding AND the roster is exactly the bound agent
 *   - appendEvidence stamps records with the given epoch; readEvidence
 *     returns an immutable snapshot
 *
 * No staleness/TTL: the fake models live sessions; liveness is an fs-layer
 * concern covered by binding-liveness.test.ts.
 */

import type {
  AgentId,
  AgentType,
  MachineBinding,
  SessionRegistry,
} from "../../src/machine/evidence";
import {
  type CallStartEntry,
  CALL_START_CAP,
  callStartOf,
  epochOf,
  pruneCallStarts,
  resolveSoleActiveBinding,
} from "../../src/machine/evidence";
import type { Epoch, Evidence, EvidenceRecord } from "../../src/machine/types";

export function inMemorySessionRegistry(): SessionRegistry {
  const bindings = new Map<string, MachineBinding[]>();
  const active = new Map<string, AgentId[]>();
  const ledger = new Map<string, EvidenceRecord[]>();
  // Recency-ordered array (oldest first), mirroring the fs adapter's wire
  // format exactly: remove-then-append on stamp, prune by slicing.
  const callStarts = new Map<string, readonly CallStartEntry[]>();

  return {
    bind: async (sessionId: string, agentType: AgentType, agentId: AgentId): Promise<void> => {
      const current = bindings.get(sessionId) ?? [];
      // Idempotent on (agentId, agentType), mirroring bindMachineAgent: a
      // duplicated SubagentStart must not create a contended-looking session.
      if (current.some((b) => b.agentId === agentId && b.agentType === agentType)) return;
      bindings.set(sessionId, [
        ...current,
        { agentId, agentType, epoch: epochOf(agentId, agentType) },
      ]);
    },

    unbind: async (sessionId: string, agentType: AgentType, agentId: AgentId): Promise<void> => {
      bindings.set(
        sessionId,
        (bindings.get(sessionId) ?? []).filter(
          (b) => !(b.agentId === agentId && b.agentType === agentType),
        ),
      );
    },

    markActive: async (sessionId: string, agentId: AgentId): Promise<void> => {
      const roster = active.get(sessionId) ?? [];
      // Set semantics keyed by agentId, mirroring markAgentActive.
      if (roster.includes(agentId)) return;
      active.set(sessionId, [...roster, agentId]);
    },

    removeActive: async (sessionId: string, agentId: AgentId): Promise<void> => {
      active.set(sessionId, (active.get(sessionId) ?? []).filter((a) => a !== agentId));
    },

    countActiveAgents: (sessionId: string): number => (active.get(sessionId) ?? []).length,

    soleActiveBinding: (sessionId: string): MachineBinding | null =>
      resolveSoleActiveBinding(bindings.get(sessionId) ?? [], active.get(sessionId) ?? []),

    // The fake models live sessions with no TTL, so refreshing the activity
    // anchor is a no-op — liveness is an fs-layer concern (binding-liveness).
    refreshBindingActivity: async (): Promise<void> => {},

    readBindings: (sessionId: string): readonly MachineBinding[] => bindings.get(sessionId) ?? [],

    appendEvidence: (
      sessionId: string,
      epoch: Epoch,
      events: readonly Evidence[],
      callId?: string,
    ): void => {
      if (events.length === 0) return;
      ledger.set(sessionId, [
        ...(ledger.get(sessionId) ?? []),
        ...events.map((event) => (callId !== undefined ? { epoch, event, callId } : { epoch, event })),
      ]);
    },

    readEvidence: (sessionId: string): readonly EvidenceRecord[] => [...(ledger.get(sessionId) ?? [])],

    recordCallStart: async (sessionId: string, toolUseId: string, startMs: number): Promise<void> => {
      const current = callStarts.get(sessionId) ?? [];
      const reinserted: CallStartEntry[] = [
        ...current.filter((e) => e.id !== toolUseId),
        { id: toolUseId, startMs },
      ];
      callStarts.set(sessionId, pruneCallStarts(reinserted, CALL_START_CAP));
    },

    callStartFor: (sessionId: string, toolUseId: string): number | null =>
      callStartOf(callStarts.get(sessionId) ?? [], toolUseId),
  };
}
