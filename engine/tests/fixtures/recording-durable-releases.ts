/**
 * The production durable claim release ports (`piDurableClaimReleasePorts`),
 * wrapped to record each release as `port:subject` — the one fake admission
 * rollback, `tool_result` settlement and session shutdown suites cross, so a
 * test can compare the release sequences the three shells produce.
 */

import type { SessionTaskGraphPointerBinding } from "../../src/machine";
import type { DurableClaimReleasePorts } from "../../../pi/spawn-claims";
import { piDurableClaimReleasePorts } from "../../../pi/spawn-claim-shell";
import type { PiSessionId } from "../../../pi/spawn-reservation";

export type RecordingDurableReleases = Readonly<{
  /** Every release attempted, in order, as `port:subject`. */
  calls: string[];
  durableClaimReleases: (sessionId: PiSessionId) => DurableClaimReleasePorts;
}>;

/**
 * A release `fails` names throws `<port> unavailable` instead of running. A
 * pointer in `offDiskPointers` was never written, so its release resolves
 * `rolled-back` without I/O; every other release runs for real.
 */
export function recordingDurableReleases(
  fails: (call: string) => boolean = () => false,
  offDiskPointers: ReadonlySet<SessionTaskGraphPointerBinding> = new Set(),
): RecordingDurableReleases {
  const calls: string[] = [];
  const record = (call: string): void => {
    calls.push(call);
    if (fails(call)) throw new Error(`${call.slice(0, call.indexOf(":"))} unavailable`);
  };
  const durableClaimReleases = (sessionId: PiSessionId): DurableClaimReleasePorts => {
    const production = piDurableClaimReleasePorts(sessionId);
    return {
      revokeGrant: (token) => {
        record(`revokeGrant:${token}`);
        production.revokeGrant(token);
      },
      removeRosterEntry: async (agentId) => {
        record(`removeRosterEntry:${agentId}`);
        await production.removeRosterEntry(agentId);
      },
      releasePointer: async (pointer) => {
        record(`releasePointer:${pointer.leaseId}`);
        return offDiskPointers.has(pointer) ? "rolled-back" : production.releasePointer(pointer);
      },
    };
  };
  return { calls, durableClaimReleases };
}
