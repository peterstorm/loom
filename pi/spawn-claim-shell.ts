/**
 * The imperative shell around the spawn claims ledger (`pi/spawn-claims.ts`):
 * the production durable release ports, and the two release orchestrators
 * that read and retain debt on a `PiParentSessions`.
 *
 * Settlement (`pi/subagent-stop.ts`) and session shutdown
 * (`pi/session-shutdown.ts`) release what one tool call still holds through
 * `releaseHeldSpawnClaims`, and both retry orphaned claims through
 * `releaseOrphanedSpawnClaims`. Each orchestrator only loads from the parent
 * session, calls the ledger's pure plan and its port-injected executor
 * (`releaseDurableSpawnClaims`, the release path admission's
 * `releaseSpawnClaims` shares step for step), and stores what the ledger's
 * one remaining-debt rule says is still owed. No release decision lives here.
 */

import { fsSessionRegistry, rollbackSessionTaskGraphPointer } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { revokePiWriteGrant } from "./write-grant";
import {
  ORPHANED_CLAIM_RELEASE_PHRASING,
  orphanedOnRelease,
  releaseDurableSpawnClaims,
  remainingDurableClaims,
  settledSpawnClaims,
  spawnDebtOf,
  unownedOnRefusal,
  type DurableClaimReleasePorts,
  type DurableReleasePhrasing,
  type DurableSpawnClaims,
  type SpawnClaimHolder,
} from "./spawn-claims";
import { ownPiSpawnReservation, type PiParentSessions, type PiSessionId } from "./spawn-reservation";

/** The production durable release ports of one parent session: roster
 *  entries are removed under that session alone. */
export const piDurableClaimReleasePorts = (sessionId: PiSessionId): DurableClaimReleasePorts =>
  Object.freeze({
    revokeGrant: revokePiWriteGrant,
    removeRosterEntry: (agentId: AgentId) => fsSessionRegistry.removeActive(sessionId, agentId),
    releasePointer: rollbackSessionTaskGraphPointer,
  });

/**
 * Retry every orphaned claim the session keeps — revocations before pointer
 * releases, the security order — through the ledger's own planned release of
 * that one capability, discharging each one released. An orphan that still
 * fails stays as debt; its failures are returned, labelled.
 */
export async function releaseOrphanedSpawnClaims(
  sessionId: PiSessionId,
  parentSessions: PiParentSessions,
  ports: DurableClaimReleasePorts,
): Promise<readonly string[]> {
  const orphans = [...parentSessions.get(sessionId)?.orphanedClaims ?? []];
  const errors: string[] = [];
  for (const orphan of [
    ...orphans.filter(({ kind }) => kind === "write-grant"),
    ...orphans.filter(({ kind }) => kind === "pointer-lease"),
  ]) {
    const attempt = await releaseDurableSpawnClaims(unownedOnRefusal(orphan), ORPHANED_CLAIM_RELEASE_PHRASING, ports);
    if (orphanedOnRelease(orphan, attempt.releases) === null) parentSessions.dischargeOrphanedClaim(sessionId, orphan);
    errors.push(...attempt.errors);
  }
  return errors;
}

/** What releasing one tool call's held claims did. */
export type HeldSpawnClaimsRelease = Readonly<{
  /** The failed release steps, labelled. */
  errors: readonly string[];
  /** Why the tool call's stored reservation was left untouched as debt: it
   *  names another session (`ownPiSpawnReservation`'s refusal), or `null`. */
  foreignReservation: string | null;
}>;

/**
 * Release the part `select` picks of the durable ledger one tool call still
 * holds on its parent session — its committed grants, and the roster entries
 * and pointer lease of its stored reservation once that is parsed against the
 * holder's session — then retain exactly what is still owed. Settlement and
 * shutdown both release through here, so they share one plan, one release
 * order and one remaining-debt rule. A stored reservation naming another
 * session is never released under the holder: it stays as debt, reported as
 * data. The reservation is re-read from the session on every call, where the
 * previous release retained it, so a retry never replays a released capability.
 */
export async function releaseHeldSpawnClaims(
  holder: SpawnClaimHolder,
  parentSessions: PiParentSessions,
  select: (held: DurableSpawnClaims) => DurableSpawnClaims,
  phrasing: DurableReleasePhrasing,
  ports: DurableClaimReleasePorts,
): Promise<HeldSpawnClaimsRelease> {
  const { sessionId, toolCallId } = holder;
  const runtime = parentSessions.get(sessionId);
  const stored = runtime?.spawnReservations.get(toolCallId);
  const owned = stored === undefined ? undefined : ownPiSpawnReservation(sessionId, stored);
  const reservation = owned?.ok === true ? owned.value : undefined;
  const held = settledSpawnClaims(runtime?.issuedWriteGrants.get(toolCallId) ?? [], reservation);
  const { errors, releases } = await releaseDurableSpawnClaims(select(held), phrasing, ports);
  const owed = remainingDurableClaims(held, releases);
  parentSessions.retainWriteGrantDebt(sessionId, toolCallId, owed.grants);
  if (reservation !== undefined) {
    parentSessions.retainSpawnCleanupDebt(sessionId, toolCallId, spawnDebtOf(owed, reservation).reservation);
  }
  return Object.freeze({ errors, foreignReservation: owned?.ok === false ? owned.error : null });
}
