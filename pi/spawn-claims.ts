/**
 * The claims ledger of one Pi spawn batch: every capability the batch holds —
 * staged emission launches, issued write grants and the child prompts they
 * rewrote, the review run its standalone spawn bound as current, the roster
 * entries reserved, the task-graph pointer lease — as immutable data.
 *
 * Two shells release a ledger. Admission (`reservePiSpawnLifecycle`) records
 * each claim as it takes the capability and, on a refusal, releases the whole
 * ledger. Settlement (`pi/subagent-stop.ts`) derives the ledger a dispatched
 * batch still holds from its committed grants and reservation
 * (`settledSpawnClaims`) and releases it at `tool_result`. Both run the one
 * plan and derive what is still owed by the one rule (`remainingSpawnClaims`,
 * `spawnDebtOf`), so a new capability kind changes one place.
 *
 * Recording a claim, planning its release, and deriving what a failed release
 * still owes are pure and total: a claim the ledger cannot honour (a duplicate
 * grant slot, an injection for a slot with no grant) is refused as data rather
 * than silently dropped. Executing the plan is one function over an injected
 * `SpawnClaimReleasePorts`, so the release-and-debt state machine runs against
 * in-memory fakes. The plan's order is the security order: capability releases
 * (launches, grants, prompt restores) first, then the witness binding, then
 * roster entries newest-first, then the pointer lease; every step runs even
 * when an earlier one fails.
 */

import type { SessionTaskGraphPointerBinding } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import { runPiCleanupActions } from "./cleanup-actions";
import type { PiIssuedWriteGrant, PiSpawnReservation, PiSpawnReservationItem } from "./spawn-reservation";

/** One child prompt rewritten to carry its slot's write grant, with the
 *  prompt a release restores. */
export type SpawnPromptRewrite = Readonly<{ slot: number; originalTask: string }>;

export type SpawnClaims = Readonly<{
  emissionLaunchesStaged: boolean;
  /** In issuance (slot) order; at most one per slot. */
  grants: readonly PiIssuedWriteGrant[];
  /** Each names, at most once, the slot of a grant claimed when the prompt
   *  was rewritten (that grant may since have been revoked). */
  promptRewrites: readonly SpawnPromptRewrite[];
  /** The review run this batch's first exact standalone spawn bound as
   *  current, while that binding is still the batch's to retract. */
  witnessRun: SessionRunBinding | null;
  /** The authority-free reservation item of every roster entry reserved, in
   *  reservation order — the shape cleanup debt keeps for an entry. */
  roster: readonly PiSpawnReservationItem[];
  pointer: SessionTaskGraphPointerBinding | null;
}>;

export const NO_SPAWN_CLAIMS: SpawnClaims = Object.freeze({
  emissionLaunchesStaged: false,
  grants: Object.freeze([]),
  promptRewrites: Object.freeze([]),
  witnessRun: null,
  roster: Object.freeze([]),
  pointer: null,
});

export const claimRosterEntry = (claims: SpawnClaims, item: PiSpawnReservationItem): SpawnClaims =>
  Object.freeze({ ...claims, roster: Object.freeze([...claims.roster, item]) });

export const claimPointerLease = (claims: SpawnClaims, pointer: SessionTaskGraphPointerBinding): SpawnClaims =>
  Object.freeze({ ...claims, pointer });

/** Record the run a standalone spawn newly bound as current for its root. */
export const claimWitnessRun = (claims: SpawnClaims, binding: SessionRunBinding): SpawnClaims =>
  Object.freeze({ ...claims, witnessRun: binding });

/** Record an issued grant for its slot; a slot already holding one is refused,
 *  because the ledger could then owe only one of the two tokens. */
export function claimWriteGrant(claims: SpawnClaims, grant: PiIssuedWriteGrant): DomainResult<SpawnClaims, string> {
  if (claims.grants.some(({ slot }) => slot === grant.slot)) {
    return failure(`spawn item ${grant.slot + 1} already holds a claimed write grant`);
  }
  return success(Object.freeze({
    ...claims,
    grants: Object.freeze([...claims.grants, Object.freeze({ slot: grant.slot, token: grant.token })]),
  }));
}

/** Record that the slot's child prompt is about to carry its grant marker.
 *  Refused for a slot with no claimed grant, or one already rewritten: the
 *  release would otherwise restore a prompt no grant explains, or none. */
export function claimGrantInjection(claims: SpawnClaims, rewrite: SpawnPromptRewrite): DomainResult<SpawnClaims, string> {
  if (!claims.grants.some(({ slot }) => slot === rewrite.slot)) {
    return failure(`spawn item ${rewrite.slot + 1} has no claimed write grant to inject`);
  }
  if (claims.promptRewrites.some(({ slot }) => slot === rewrite.slot)) {
    return failure(`spawn item ${rewrite.slot + 1} already carries its injected write grant`);
  }
  return success(Object.freeze({
    ...claims,
    promptRewrites: Object.freeze([...claims.promptRewrites, Object.freeze({ ...rewrite })]),
  }));
}

export const claimEmissionLaunches = (claims: SpawnClaims): SpawnClaims =>
  Object.freeze({ ...claims, emissionLaunchesStaged: true });

/**
 * The ledger a dispatched batch still holds at settlement: its committed
 * grants and its reservation's roster entries and pointer lease. Launch
 * removal is the dispatcher's first act and prompt rewrites end at dispatch,
 * so neither is owed here; nor is the witness binding, which settlement
 * enriches rather than retracts.
 */
export const settledSpawnClaims = (
  grants: readonly PiIssuedWriteGrant[],
  reservation: PiSpawnReservation | undefined,
): SpawnClaims =>
  Object.freeze({
    ...NO_SPAWN_CLAIMS,
    grants: Object.freeze([...grants]),
    roster: reservation?.items ?? NO_SPAWN_CLAIMS.roster,
    pointer: reservation?.pointerBinding ?? null,
  });

/** Everything but the pointer lease: what settlement releases before it
 *  processes the batch's results. */
export const withoutPointerLease = (claims: SpawnClaims): SpawnClaims =>
  Object.freeze({ ...claims, pointer: null });

/** Only the pointer lease: what settlement releases last. */
export const pointerLeaseOnly = (claims: SpawnClaims): SpawnClaims =>
  Object.freeze({ ...NO_SPAWN_CLAIMS, pointer: claims.pointer });

export type SpawnRollbackStep =
  | Readonly<{ kind: "remove-emission-launches" }>
  | Readonly<{ kind: "revoke-grant"; slot: number; token: string }>
  | Readonly<{ kind: "restore-prompt"; slot: number; originalTask: string }>
  | Readonly<{ kind: "retract-witness-run"; binding: SessionRunBinding }>
  | Readonly<{ kind: "remove-roster-entry"; item: PiSpawnReservationItem }>
  | Readonly<{ kind: "release-pointer"; pointer: SessionTaskGraphPointerBinding }>;

/** Every release the claims owe, in the order they must be attempted. */
export function planSpawnRollback(claims: SpawnClaims): readonly SpawnRollbackStep[] {
  const restore = (rewrite: SpawnPromptRewrite): SpawnRollbackStep =>
    Object.freeze({ kind: "restore-prompt" as const, slot: rewrite.slot, originalTask: rewrite.originalTask });
  return Object.freeze([
    ...(claims.emissionLaunchesStaged ? [Object.freeze({ kind: "remove-emission-launches" as const })] : []),
    ...claims.grants.flatMap((grant): readonly SpawnRollbackStep[] => [
      Object.freeze({ kind: "revoke-grant" as const, slot: grant.slot, token: grant.token }),
      ...claims.promptRewrites.filter(({ slot }) => slot === grant.slot).map(restore),
    ]),
    // A rewrite whose grant an earlier release already revoked is still owed
    // its restore.
    ...claims.promptRewrites
      .filter(({ slot }) => !claims.grants.some((grant) => grant.slot === slot))
      .map(restore),
    ...(claims.witnessRun === null ? [] : [Object.freeze({ kind: "retract-witness-run" as const, binding: claims.witnessRun })]),
    ...[...claims.roster].reverse().map((item) => Object.freeze({ kind: "remove-roster-entry" as const, item })),
    ...(claims.pointer === null ? [] : [Object.freeze({ kind: "release-pointer" as const, pointer: claims.pointer })]),
  ]);
}

/** The label an admission rollback reports a failed step under. */
export function spawnRollbackStepLabel(step: SpawnRollbackStep, toolCallId: string): string {
  switch (step.kind) {
    case "remove-emission-launches":
      return `remove emission launch capabilities for ${toolCallId}`;
    case "revoke-grant":
      return `revoke write grant for spawn item ${step.slot + 1}`;
    case "restore-prompt":
      return `restore child prompt for spawn item ${step.slot + 1}`;
    case "retract-witness-run":
      return `retract unwitnessed review run ${step.binding.runId}`;
    case "remove-roster-entry":
      return `remove active roster entry ${step.item.rosterId}`;
    case "release-pointer":
      return "roll back task-graph pointer";
  }
}

/** The label a `tool_result` settlement reports a failed step under. */
export function spawnSettlementStepLabel(
  step: SpawnRollbackStep,
  owner: Readonly<{ sessionId: string; toolCallId: string }>,
): string {
  switch (step.kind) {
    case "remove-roster-entry":
      return `remove reserved roster entry for ${step.item.agentType}`;
    case "release-pointer":
      return `release parent task-graph pointer lease for ${owner.sessionId}`;
    default:
      return spawnRollbackStepLabel(step, owner.toolCallId);
  }
}

/** The capabilities one release attempt actually released. */
export type SpawnClaimReleases = Readonly<{
  launchesRemoved: boolean;
  revokedTokens: ReadonlySet<string>;
  restoredSlots: ReadonlySet<number>;
  witnessRetracted: boolean;
  removedRosterIds: ReadonlySet<AgentId>;
  pointerReleased: boolean;
}>;

/** The claims still owed after a release attempt: exactly those whose release
 *  failed or was never attempted. */
export function remainingSpawnClaims(claims: SpawnClaims, releases: SpawnClaimReleases): SpawnClaims {
  return Object.freeze({
    emissionLaunchesStaged: claims.emissionLaunchesStaged && !releases.launchesRemoved,
    grants: Object.freeze(claims.grants.filter(({ token }) => !releases.revokedTokens.has(token))),
    promptRewrites: Object.freeze(claims.promptRewrites.filter(({ slot }) => !releases.restoredSlots.has(slot))),
    witnessRun: releases.witnessRetracted ? null : claims.witnessRun,
    roster: Object.freeze(claims.roster.filter((item) => !releases.removedRosterIds.has(item.rosterId))),
    pointer: releases.pointerReleased ? null : claims.pointer,
  });
}

/** The reservation fields a debt record carries beyond its claims. */
export type SpawnDebtContext = Pick<
  PiSpawnReservation,
  "sessionId" | "needsTaskGraphLifecycle" | "graphActiveAtSpawn" | "orchestrationRunBinding"
>;

/**
 * The cleanup debt owed claims become on the parent session: the grants, and a
 * reservation naming exactly the roster entries and pointer lease. Launches,
 * prompt rewrites and the witness binding are process-local and released in
 * the same step that took them, so no debt record carries them. Owing nothing
 * yields no grants and an empty reservation, which the parent session forgets.
 */
export function spawnDebtOf(
  claims: SpawnClaims,
  context: SpawnDebtContext,
): Readonly<{ grants: readonly PiIssuedWriteGrant[]; reservation: PiSpawnReservation }> {
  return Object.freeze({
    grants: claims.grants,
    reservation: Object.freeze({
      sessionId: context.sessionId,
      needsTaskGraphLifecycle: context.needsTaskGraphLifecycle,
      graphActiveAtSpawn: context.graphActiveAtSpawn,
      orchestrationRunBinding: context.orchestrationRunBinding,
      pointerBinding: claims.pointer,
      items: claims.roster,
    }),
  });
}

/** What a rolled-back batch still owes, as the debt its session keeps. */
export const remainingSpawnDebt = (
  claims: SpawnClaims,
  releases: SpawnClaimReleases,
  context: SpawnDebtContext,
): ReturnType<typeof spawnDebtOf> => spawnDebtOf(remainingSpawnClaims(claims, releases), context);

/** The I/O each release step performs. A port throws when its release failed. */
export type SpawnClaimReleasePorts = Readonly<{
  removeEmissionLaunches: () => void;
  revokeGrant: (token: string) => void;
  restorePrompt: (slot: number, originalTask: string) => void;
  retractWitnessRun: (binding: SessionRunBinding) => void;
  removeRosterEntry: (agentId: AgentId) => Promise<void>;
  /** Resolves `"rolled-back"` only when this exact lease was released. */
  releasePointer: (pointer: SessionTaskGraphPointerBinding) => Promise<string>;
}>;

/**
 * Attempt every planned release, never stopping at a failure, and report the
 * failures (under `labelOf`'s names) together with what was actually released
 * — the input `remainingSpawnClaims` turns into what is still owed.
 */
export async function releaseSpawnClaims(
  claims: SpawnClaims,
  labelOf: (step: SpawnRollbackStep) => string,
  ports: SpawnClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; releases: SpawnClaimReleases }>> {
  let launchesRemoved = false;
  const revokedTokens = new Set<string>();
  const restoredSlots = new Set<number>();
  let witnessRetracted = false;
  const removedRosterIds = new Set<AgentId>();
  let pointerReleased = false;
  const run = async (step: SpawnRollbackStep): Promise<void> => {
    switch (step.kind) {
      case "remove-emission-launches":
        ports.removeEmissionLaunches();
        launchesRemoved = true;
        return;
      case "revoke-grant":
        ports.revokeGrant(step.token);
        revokedTokens.add(step.token);
        return;
      case "restore-prompt":
        ports.restorePrompt(step.slot, step.originalTask);
        restoredSlots.add(step.slot);
        return;
      case "retract-witness-run":
        ports.retractWitnessRun(step.binding);
        witnessRetracted = true;
        return;
      case "remove-roster-entry":
        await ports.removeRosterEntry(step.item.rosterId);
        removedRosterIds.add(step.item.rosterId);
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
    label: labelOf(step),
    run: () => run(step),
  })));
  return Object.freeze({
    errors,
    releases: Object.freeze({
      launchesRemoved,
      revokedTokens,
      restoredSlots,
      witnessRetracted,
      removedRosterIds,
      pointerReleased,
    }),
  });
}
