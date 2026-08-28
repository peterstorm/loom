/**
 * Production SessionRegistry adapter — the port (evidence.ts) implemented
 * by the ledger's fs code. Behavior-identical to calling the ledger
 * functions directly; the port exists so the sole-active and
 * snapshot-before-unbind invariants are testable against an in-memory fake
 * (see tests/machine/fake-session-registry.ts) as properties over
 * interleavings, with this adapter checked for conformance.
 */

import type { SessionRegistry } from "./evidence";
import {
  appendEvidence,
  bindMachineAgent,
  callStartFor,
  countActiveAgents,
  markAgentActive,
  readBindings,
  readEvidence,
  recordCallStart,
  refreshBindingActivity,
  removeActiveAgent,
  soleActiveBinding,
  unbindMachineAgent,
} from "./ledger";

export const fsSessionRegistry: SessionRegistry = {
  bind: async (sessionId, agentType, agentId) => {
    await bindMachineAgent(sessionId, agentType, agentId);
  },
  unbind: unbindMachineAgent,
  markActive: async (sessionId, agentId) => {
    await markAgentActive(sessionId, agentId);
  },
  removeActive: removeActiveAgent,
  countActiveAgents,
  soleActiveBinding: (sessionId) => soleActiveBinding(sessionId),
  refreshBindingActivity: (sessionId) => refreshBindingActivity(sessionId),
  readBindings: (sessionId) => readBindings(sessionId),
  appendEvidence,
  readEvidence,
  recordCallStart,
  callStartFor,
};
