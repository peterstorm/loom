/**
 * Pi session shutdown: release every capability one session still holds.
 *
 * Capabilities are the security boundary: this session's staged emission
 * launches and every outstanding write-grant revocation run before fallible
 * roster/pointer housekeeping, and every release runs regardless of earlier
 * failures. Each tool call's grants, roster entries and pointer lease are
 * released through the claims ledger's one settlement path
 * (`releaseHeldSpawnClaims`, `pi/spawn-claims.ts`) — the plan, release order,
 * ports and remaining-debt rule `tool_result` settlement uses — with every
 * stored reservation parsed against the shutting-down session first: one
 * naming another session is left as debt and reported, never released under
 * the wrong session. Capabilities failed admission compensations orphaned are
 * retried the same way. Each successfully released capability retires
 * independently; whatever failed stays as cleanup debt, and other sessions
 * are untouched.
 */

import { parseSessionId, type SessionTaskGraphPointerBinding } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { runPiCleanupActions, type PiCleanupAction } from "./cleanup-actions";
import type { PiParentSessions, PiSessionId } from "./spawn-reservation";
import {
  grantsOnly,
  releaseExactPointerLease,
  releaseHeldSpawnClaims,
  releaseOrphanedSpawnClaims,
  spawnShutdownStepLabel,
  withoutGrants,
  type DurableClaimReleasePorts,
  type DurableSpawnClaims,
} from "./spawn-claims";
import { retainedChildWriteGrant, type ActiveChildWriteGrant, type PiChildWriteGrants } from "./child-write-grant";
import type { TrustedReviewWitnesses } from "./trusted-review-witness";
import type { PiEmissionLaunchBridge } from "./emission-launch-bridge";

export type PiSessionShutdownPorts = Readonly<{
  parentSessions: PiParentSessions;
  childWriteGrants: PiChildWriteGrants;
  emissionLaunchBridge: PiEmissionLaunchBridge;
  reviewWitnesses: TrustedReviewWitnesses;
  /** The durable release ports (`piDurableClaimReleasePorts` in production)
   *  shared with admission rollback and settlement. */
  durableClaimReleases: (sessionId: PiSessionId) => DurableClaimReleasePorts;
}>;

/**
 * Release `select`'s part of every tool call's held claims on the session,
 * in tool-call order: the failed steps, and each reservation left as debt
 * because it names another session.
 */
async function releaseEveryHeldClaim(
  sessionId: PiSessionId,
  parentSessions: PiParentSessions,
  select: (held: DurableSpawnClaims) => DurableSpawnClaims,
  ports: DurableClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; foreignReservations: readonly string[] }>> {
  const runtime = parentSessions.get(sessionId);
  // Snapshot before releasing: each retain may forget a tool call, and the
  // last one forgets the session runtime itself once it owes nothing.
  const toolCallIds = [...new Set([...runtime?.issuedWriteGrants.keys() ?? [], ...runtime?.spawnReservations.keys() ?? []])];
  const errors: string[] = [];
  const foreignReservations: string[] = [];
  for (const toolCallId of toolCallIds) {
    const holder = Object.freeze({ sessionId, toolCallId });
    const released = await releaseHeldSpawnClaims(
      holder,
      parentSessions,
      select,
      (step) => spawnShutdownStepLabel(step, holder),
      ports,
    );
    errors.push(...released.errors);
    if (released.foreignReservation !== null) {
      foreignReservations.push(`leave spawn reservation ${toolCallId} as cleanup debt: ${released.foreignReservation}`);
    }
  }
  return Object.freeze({ errors, foreignReservations });
}

/** Release the child binding's roster entry and pointer lease through the
 *  durable ports; the binding still owed, or `null` once it owes nothing. */
async function releaseChildBinding(
  sessionId: PiSessionId,
  binding: ActiveChildWriteGrant,
  ports: DurableClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; retained: ActiveChildWriteGrant | null }>> {
  const removedRosterIds = new Set<AgentId>();
  const releasedPointers = new Set<SessionTaskGraphPointerBinding>();
  const { agentId, pointerBinding } = binding;
  const actions: PiCleanupAction[] = [
    ...(agentId === null ? [] : [{
      label: `remove child roster entry ${agentId}`,
      run: async () => {
        await ports.removeRosterEntry(agentId);
        removedRosterIds.add(agentId);
      },
    }]),
    ...(pointerBinding === null ? [] : [{
      label: `roll back child task-graph pointer for ${sessionId}`,
      run: async () => {
        await releaseExactPointerLease(ports.releasePointer, pointerBinding);
        releasedPointers.add(pointerBinding);
      },
    }]),
  ];
  const errors = await runPiCleanupActions(actions);
  return Object.freeze({ errors, retained: retainedChildWriteGrant(binding, removedRosterIds, releasedPointers) });
}

/** Release the session's capabilities; throws one aggregate naming every
 *  cleanup that failed (and every foreign reservation left as debt), after
 *  all of them were attempted. */
export async function shutdownPiSession(rawSessionId: string, ports: PiSessionShutdownPorts): Promise<void> {
  const { parentSessions, childWriteGrants, emissionLaunchBridge, reviewWitnesses, durableClaimReleases } = ports;
  reviewWitnesses.forget(rawSessionId);
  const sessionId = parseSessionId(rawSessionId);
  const binding = childWriteGrants.active.get(rawSessionId);
  const cleanupErrors: string[] = [];
  if (sessionId !== null) {
    const releasePorts = durableClaimReleases(sessionId);
    // Staged emission launches are capabilities too: their removal is one more
    // release, so a failing bridge cannot skip the revocations after it.
    cleanupErrors.push(...await runPiCleanupActions([{
      label: `remove staged emission launches for ${sessionId}`,
      run: () => emissionLaunchBridge.removeSession(sessionId),
    }]));
    // Every revocation precedes any housekeeping: each tool call's grants,
    // then the orphans (grants before pointer leases).
    cleanupErrors.push(...(await releaseEveryHeldClaim(sessionId, parentSessions, grantsOnly, releasePorts)).errors);
    cleanupErrors.push(...await releaseOrphanedSpawnClaims(sessionId, parentSessions, releasePorts));
    if (binding !== undefined) {
      const child = await releaseChildBinding(sessionId, binding, releasePorts);
      cleanupErrors.push(...child.errors);
      if (child.retained === null) childWriteGrants.active.delete(rawSessionId);
      else childWriteGrants.active.set(rawSessionId, child.retained);
    }
    // The housekeeping pass is the one that reads reservations, so it alone
    // reports the ones left as debt.
    const housekeeping = await releaseEveryHeldClaim(sessionId, parentSessions, withoutGrants, releasePorts);
    cleanupErrors.push(...housekeeping.errors, ...housekeeping.foreignReservations);
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
