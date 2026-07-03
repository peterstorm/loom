/**
 * In-memory SessionRegistry fake — the port's test double. Mirrors the fs
 * adapter's nominal semantics exactly:
 *   - bind appends; a bind when NO binding is live truncates the ledger
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
import { epochOf, resolveSoleActiveBinding } from "../../src/machine/evidence";
import type { Epoch, Evidence, EvidenceRecord } from "../../src/machine/types";

export function inMemorySessionRegistry(): SessionRegistry {
  const bindings = new Map<string, MachineBinding[]>();
  const active = new Map<string, string[]>();
  const ledger = new Map<string, EvidenceRecord[]>();

  return {
    bind: async (sessionId: string, agentType: AgentType, agentId: AgentId): Promise<void> => {
      const current = bindings.get(sessionId) ?? [];
      if (current.length === 0) ledger.set(sessionId, []); // truncate previous run
      bindings.set(sessionId, [
        ...current,
        { agentId, agentType, epoch: epochOf(agentId, agentType) },
      ]);
    },

    unbind: async (sessionId: string, agentType: string, agentId: string): Promise<void> => {
      bindings.set(
        sessionId,
        (bindings.get(sessionId) ?? []).filter(
          (b) => !(b.agentId === agentId && b.agentType === agentType),
        ),
      );
    },

    markActive: async (sessionId: string, agentId: AgentId): Promise<void> => {
      active.set(sessionId, [...(active.get(sessionId) ?? []), agentId]);
    },

    removeActive: async (sessionId: string, agentId: string): Promise<void> => {
      active.set(sessionId, (active.get(sessionId) ?? []).filter((a) => a !== agentId));
    },

    countActiveAgents: (sessionId: string): number => (active.get(sessionId) ?? []).length,

    soleActiveBinding: (sessionId: string): MachineBinding | null =>
      resolveSoleActiveBinding(bindings.get(sessionId) ?? [], active.get(sessionId) ?? []),

    // The fake models live sessions with no TTL, so refreshing the activity
    // anchor is a no-op — liveness is an fs-layer concern (binding-liveness).
    refreshBindingActivity: async (): Promise<void> => {},

    readBindings: (sessionId: string): readonly MachineBinding[] => bindings.get(sessionId) ?? [],

    appendEvidence: (sessionId: string, epoch: Epoch, events: readonly Evidence[]): void => {
      if (events.length === 0) return;
      ledger.set(sessionId, [
        ...(ledger.get(sessionId) ?? []),
        ...events.map((event) => ({ epoch, event })),
      ]);
    },

    readEvidence: (sessionId: string): EvidenceRecord[] => [...(ledger.get(sessionId) ?? [])],
  };
}
