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
  countActiveAgents,
  markAgentActive,
  readEvidence,
  removeActiveAgent,
  soleActiveBinding,
  unbindMachineAgent,
} from "./ledger";

export const fsSessionRegistry: SessionRegistry = {
  bind: bindMachineAgent,
  unbind: unbindMachineAgent,
  markActive: markAgentActive,
  removeActive: removeActiveAgent,
  countActiveAgents,
  soleActiveBinding,
  appendEvidence,
  readEvidence,
};
