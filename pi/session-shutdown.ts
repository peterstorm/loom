/**
 * Pi session shutdown: release every capability one session still holds.
 *
 * Capabilities are the security boundary: this session's staged emission
 * launches and every outstanding write-grant revocation are scheduled before
 * fallible roster/pointer housekeeping, then every action runs regardless of
 * individual failures.
 * Each successfully released capability retires independently; whatever
 * failed stays as cleanup debt, and other sessions are untouched.
 */

import {
  fsSessionRegistry,
  parseSessionId,
  rollbackSessionTaskGraphPointer,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { revokePiWriteGrant } from "./write-grant";
import { runPiCleanupActions, type PiCleanupAction } from "./cleanup-actions";
import type { PiParentSessions } from "./spawn-reservation";
import { retainedChildWriteGrant, type PiChildWriteGrants } from "./child-write-grant";
import type { TrustedReviewWitnesses } from "./trusted-review-witness";
import type { PiEmissionLaunchBridge } from "./emission-launch-bridge";

export type PiSessionShutdownPorts = Readonly<{
  parentSessions: PiParentSessions;
  childWriteGrants: PiChildWriteGrants;
  emissionLaunchBridge: PiEmissionLaunchBridge;
  reviewWitnesses: TrustedReviewWitnesses;
}>;

/** Release the session's capabilities; throws one aggregate naming every
 *  cleanup that failed, after all of them were attempted. */
export async function shutdownPiSession(rawSessionId: string, ports: PiSessionShutdownPorts): Promise<void> {
  const { parentSessions, childWriteGrants, emissionLaunchBridge, reviewWitnesses } = ports;
  reviewWitnesses.forget(rawSessionId);
  const sessionId = parseSessionId(rawSessionId);
  const binding = childWriteGrants.active.get(rawSessionId);
  // Staged emission launches are capabilities too: their removal is one more
  // action, so a failing bridge cannot skip the revocations scheduled below.
  const actions: PiCleanupAction[] = sessionId === null ? [] : [{
    label: `remove staged emission launches for ${sessionId}`,
    run: () => emissionLaunchBridge.removeSession(sessionId),
  }];
  const revokedTokens = new Set<string>();
  const removedRosterIds = new Set<AgentId>();
  const releasedPointers = new Set<SessionTaskGraphPointerBinding>();

  // Capabilities are the security boundary: schedule this session's every
  // revocation before fallible roster/pointer housekeeping, then execute all
  // actions regardless of individual failures. Other sessions are untouched.
  const parentRuntime = sessionId ? parentSessions.get(sessionId) : undefined;
  let grantOrdinal = 0;
  for (const grants of parentRuntime?.issuedWriteGrants.values() ?? []) {
    for (const { token } of grants) {
      grantOrdinal++;
      actions.push({
        label: `revoke outstanding write grant ${grantOrdinal}`,
        run: () => {
          revokePiWriteGrant(token);
          revokedTokens.add(token);
        },
      });
    }
  }
  const childAgentId = binding?.agentId ?? null;
  if (sessionId && childAgentId !== null) {
    actions.push({
      label: `remove child roster entry ${childAgentId}`,
      run: async () => {
        await fsSessionRegistry.removeActive(sessionId, childAgentId);
        removedRosterIds.add(childAgentId);
      },
    });
  }
  const childPointer = binding?.pointerBinding ?? null;
  if (sessionId && childPointer !== null) {
    actions.push({
      label: `roll back child task-graph pointer for ${sessionId}`,
      run: async () => {
        const result = await rollbackSessionTaskGraphPointer(childPointer);
        if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
        releasedPointers.add(childPointer);
      },
    });
  }
  for (const reservation of parentRuntime?.spawnReservations.values() ?? []) {
    for (const item of reservation.items) {
      actions.push({
        label: `remove shutdown roster entry for ${item.agentType}`,
        run: async () => {
          await fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId);
          removedRosterIds.add(item.rosterId);
        },
      });
    }
    if (reservation.pointerBinding !== null) {
      const pointerBinding = reservation.pointerBinding;
      actions.push({
        label: `release shutdown task-graph pointer lease for ${reservation.sessionId}`,
        run: async () => {
          const result = await rollbackSessionTaskGraphPointer(pointerBinding);
          if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
          releasedPointers.add(pointerBinding);
        },
      });
    }
  }

  const cleanupErrors = await runPiCleanupActions(actions);
  // Retire each successfully released capability independently. Retaining an
  // entire aggregate after one failure retries already-released pointer
  // leases as `not-owned`, turning a recoverable cleanup debt permanent.
  if (sessionId && parentRuntime !== undefined) {
    // Snapshot before retaining: each retain may forget an entry, and the last
    // one forgets the session runtime itself once it owes nothing.
    for (const [toolCallId, grants] of [...parentRuntime.issuedWriteGrants]) {
      parentSessions.retainWriteGrantDebt(sessionId, toolCallId, grants.filter(({ token }) => !revokedTokens.has(token)));
    }
    for (const [toolCallId, reservation] of [...parentRuntime.spawnReservations]) {
      const items = reservation.items.filter((item) => !removedRosterIds.has(item.rosterId));
      const pointerBinding = reservation.pointerBinding !== null && releasedPointers.has(reservation.pointerBinding)
        ? null
        : reservation.pointerBinding;
      parentSessions.retainSpawnCleanupDebt(sessionId, toolCallId, {
        ...reservation,
        items: Object.freeze(items),
        pointerBinding,
      });
    }
  }
  if (binding !== undefined) {
    const retained = retainedChildWriteGrant(binding, removedRosterIds, releasedPointers);
    if (retained === null) childWriteGrants.active.delete(rawSessionId);
    else childWriteGrants.active.set(rawSessionId, retained);
  }
  const parentCleanupComplete = sessionId === null || parentSessions.get(sessionId) === undefined;
  if (!childWriteGrants.active.has(rawSessionId) && parentCleanupComplete) {
    childWriteGrants.rejectedSessions.delete(rawSessionId);
  }
  for (const cleanupError of cleanupErrors) {
    process.stderr.write(`loom(pi): shutdown cleanup failed: ${cleanupError}\n`);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors.map((error) => new Error(error)),
      `Loom Pi session shutdown cleanup failed: ${cleanupErrors.join("; ")}`,
    );
  }
}
