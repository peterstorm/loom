/**
 * The claims ledger of one Pi spawn batch under admission: every capability
 * `reservePiSpawnLifecycle` has taken before Pi may dispatch — staged emission
 * launches, issued write grants (and whether their prompt was rewritten), the
 * roster entries reserved, the task-graph pointer lease — as immutable data.
 *
 * Recording a claim, planning its rollback, and deriving what a failed
 * rollback still owes are pure. Executing the plan is one function over an
 * injected `SpawnClaimReleasePorts`, so the rollback-and-debt state machine
 * runs against in-memory fakes and the lifecycle shell only supplies the
 * production adapter. The plan's order is the security order: capability
 * releases (launches, grants) first, then roster entries newest-first, then
 * the pointer lease; every step runs even when an earlier one fails.
 */

import type { SessionTaskGraphPointerBinding } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { runPiCleanupActions } from "./cleanup-actions";
import type { PiSpawnReservation, PiSpawnReservationItem } from "./spawn-reservation";

/** One write grant the batch issued, at the spawn slot it was issued for. */
export type SpawnGrantClaim = Readonly<{
  slot: number;
  token: string;
  /** The child prompt before injection, restored on rollback once injected. */
  originalTask: string;
  injected: boolean;
}>;

export type SpawnClaims = Readonly<{
  emissionLaunchesStaged: boolean;
  /** In issuance (slot) order. */
  grants: readonly SpawnGrantClaim[];
  /** The authority-free reservation item of every roster entry reserved, in
   *  reservation order — the shape cleanup debt keeps for an entry. */
  roster: readonly PiSpawnReservationItem[];
  pointer: SessionTaskGraphPointerBinding | null;
}>;

export const NO_SPAWN_CLAIMS: SpawnClaims = Object.freeze({
  emissionLaunchesStaged: false,
  grants: Object.freeze([]),
  roster: Object.freeze([]),
  pointer: null,
});

export const claimRosterEntry = (claims: SpawnClaims, item: PiSpawnReservationItem): SpawnClaims =>
  Object.freeze({ ...claims, roster: Object.freeze([...claims.roster, item]) });

export const claimPointerLease = (claims: SpawnClaims, pointer: SessionTaskGraphPointerBinding): SpawnClaims =>
  Object.freeze({ ...claims, pointer });

export const claimWriteGrant = (
  claims: SpawnClaims,
  grant: Readonly<{ slot: number; token: string; originalTask: string }>,
): SpawnClaims =>
  Object.freeze({
    ...claims,
    grants: Object.freeze([...claims.grants, Object.freeze({ ...grant, injected: false })]),
  });

/** Record that the slot's child prompt now carries its grant marker. */
export const claimGrantInjection = (claims: SpawnClaims, slot: number): SpawnClaims =>
  Object.freeze({
    ...claims,
    grants: Object.freeze(claims.grants.map((grant) =>
      grant.slot === slot ? Object.freeze({ ...grant, injected: true }) : grant)),
  });

export const claimEmissionLaunches = (claims: SpawnClaims): SpawnClaims =>
  Object.freeze({ ...claims, emissionLaunchesStaged: true });

export type SpawnRollbackStep =
  | Readonly<{ kind: "remove-emission-launches" }>
  | Readonly<{ kind: "revoke-grant"; slot: number; token: string }>
  | Readonly<{ kind: "restore-prompt"; slot: number; originalTask: string }>
  | Readonly<{ kind: "remove-roster-entry"; agentId: AgentId }>
  | Readonly<{ kind: "release-pointer"; pointer: SessionTaskGraphPointerBinding }>;

/** Every release the claims owe, in the order they must be attempted. */
export function planSpawnRollback(claims: SpawnClaims): readonly SpawnRollbackStep[] {
  return Object.freeze([
    ...(claims.emissionLaunchesStaged ? [Object.freeze({ kind: "remove-emission-launches" as const })] : []),
    ...claims.grants.flatMap((grant): readonly SpawnRollbackStep[] => [
      Object.freeze({ kind: "revoke-grant" as const, slot: grant.slot, token: grant.token }),
      ...(grant.injected
        ? [Object.freeze({ kind: "restore-prompt" as const, slot: grant.slot, originalTask: grant.originalTask })]
        : []),
    ]),
    ...[...claims.roster].reverse().map((item) =>
      Object.freeze({ kind: "remove-roster-entry" as const, agentId: item.rosterId })),
    ...(claims.pointer === null ? [] : [Object.freeze({ kind: "release-pointer" as const, pointer: claims.pointer })]),
  ]);
}

export function spawnRollbackStepLabel(step: SpawnRollbackStep, toolCallId: string): string {
  switch (step.kind) {
    case "remove-emission-launches":
      return `remove emission launch capabilities for ${toolCallId}`;
    case "revoke-grant":
      return `revoke write grant for spawn item ${step.slot + 1}`;
    case "restore-prompt":
      return `restore child prompt for spawn item ${step.slot + 1}`;
    case "remove-roster-entry":
      return `remove active roster entry ${step.agentId}`;
    case "release-pointer":
      return "roll back task-graph pointer";
  }
}

/** The capabilities one rollback attempt actually released. */
export type SpawnClaimReleases = Readonly<{
  revokedTokens: ReadonlySet<string>;
  removedRosterIds: ReadonlySet<AgentId>;
  pointerReleased: boolean;
}>;

/** The reservation fields a debt record carries beyond its claims. */
export type SpawnDebtContext = Pick<
  PiSpawnReservation,
  "sessionId" | "needsTaskGraphLifecycle" | "graphActiveAtSpawn" | "orchestrationRunBinding"
>;

/**
 * What a rolled-back batch still owes: the grant tokens not revoked, and a
 * reservation naming exactly the roster entries not removed and the pointer
 * lease if it was not released. Nothing remaining yields no tokens and an
 * empty reservation, which the parent session forgets.
 */
export function remainingSpawnDebt(
  claims: SpawnClaims,
  releases: SpawnClaimReleases,
  context: SpawnDebtContext,
): Readonly<{ grantTokens: readonly string[]; reservation: PiSpawnReservation }> {
  return Object.freeze({
    grantTokens: Object.freeze(claims.grants.map(({ token }) => token).filter((token) => !releases.revokedTokens.has(token))),
    reservation: Object.freeze({
      ...context,
      pointerBinding: releases.pointerReleased ? null : claims.pointer,
      items: Object.freeze(claims.roster.filter((item) => !releases.removedRosterIds.has(item.rosterId))),
    }),
  });
}

/** The I/O each rollback step performs. A port throws when its release failed. */
export type SpawnClaimReleasePorts = Readonly<{
  removeEmissionLaunches: () => void;
  revokeGrant: (token: string) => void;
  restorePrompt: (slot: number, originalTask: string) => void;
  removeRosterEntry: (agentId: AgentId) => Promise<void>;
  /** Resolves `"rolled-back"` only when this exact lease was released. */
  releasePointer: (pointer: SessionTaskGraphPointerBinding) => Promise<string>;
}>;

/**
 * Attempt every planned release, never stopping at a failure, and report the
 * failures together with what was actually released — the input
 * `remainingSpawnDebt` turns into the debt the session keeps.
 */
export async function releaseSpawnClaims(
  claims: SpawnClaims,
  toolCallId: string,
  ports: SpawnClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; releases: SpawnClaimReleases }>> {
  const revokedTokens = new Set<string>();
  const removedRosterIds = new Set<AgentId>();
  let pointerReleased = false;
  const run = async (step: SpawnRollbackStep): Promise<void> => {
    switch (step.kind) {
      case "remove-emission-launches":
        ports.removeEmissionLaunches();
        return;
      case "revoke-grant":
        ports.revokeGrant(step.token);
        revokedTokens.add(step.token);
        return;
      case "restore-prompt":
        ports.restorePrompt(step.slot, step.originalTask);
        return;
      case "remove-roster-entry":
        await ports.removeRosterEntry(step.agentId);
        removedRosterIds.add(step.agentId);
        return;
      case "release-pointer": {
        const result = await ports.releasePointer(step.pointer);
        if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
        pointerReleased = true;
        return;
      }
    }
  };
  const errors = await runPiCleanupActions(planSpawnRollback(claims).map((step) => ({
    label: spawnRollbackStepLabel(step, toolCallId),
    run: () => run(step),
  })));
  return Object.freeze({
    errors,
    releases: Object.freeze({ revokedTokens, removedRosterIds, pointerReleased }),
  });
}
