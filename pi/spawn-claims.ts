/**
 * The claims ledger of one Pi spawn batch: every capability the batch holds —
 * staged emission launches, issued write grants and the child prompts they
 * rewrote, the review run its standalone spawn bound as current, the roster
 * entries reserved, the task-graph pointer lease — as immutable data.
 *
 * The ledger has two layers. Its durable claims (`DurableSpawnClaims`: grants,
 * roster entries, the pointer lease) outlive the `tool_call` that took them and
 * are what cleanup debt records. Its process-local claims (launches, prompt
 * rewrites, the witness binding) exist only while admission runs.
 *
 * Three shells release a ledger. Admission (`reservePiSpawnLifecycle`) records
 * each claim as it takes the capability and, on a refusal, releases the whole
 * ledger (`releaseSpawnClaims`). Settlement (`pi/subagent-stop.ts`) and session
 * shutdown (`pi/session-shutdown.ts`) both release what one tool call still
 * holds on its parent session through `pi/spawn-claim-shell.ts`, which parses
 * the durable ledger of its committed grants and its stored reservation
 * against the holder's session (`settledSpawnClaims`) and releases it through
 * durable ports only (`releaseDurableSpawnClaims`), since a dispatched batch
 * can hold nothing else. Shutdown releases a child's write-grant binding —
 * its roster entry and pointer lease — as a durable ledger too. Every release
 * runs one plan and derives what is still owed by one rule
 * (`remainingSpawnClaims` over `remainingDurableClaims`, `spawnDebtOf`), so a
 * new capability kind changes one place. Each shell names a failed step in
 * its own words through one label function (`durableReleaseStepLabel`) and a
 * phrasing record per shell.
 *
 * This module is the functional core: it imports no production port and
 * mutates no session. Recording a claim, planning its release, and deriving
 * what a failed release still owes are pure and total; the release executors
 * cross only the ports they are handed. Every claim kind obeys one refusal rule
 * (`recordSpawnClaim`): a claim is refused as data exactly when recording it
 * would let the ledger owe less than was taken — a duplicate roster id or
 * grant slot, an injection for a slot with no grant, a second witness run or
 * pointer lease — rather than silently dropped or overwritten. Admission takes
 * every claim through `claimOrCompensate`, which releases whatever a refused
 * claim left unowned through the same plan, so no call site pairs a claim with
 * a hand-written release. A durable capability whose compensation fails is
 * owned by no ledger — the refusal is that the ledger already holds one of its
 * kind — so it is returned as an `OrphanedSpawnClaim`, kept on the parent
 * session, and retried by the shell's `releaseOrphanedSpawnClaims` at every
 * settlement and at shutdown until it is released. Executing a plan is one
 * function over injected release ports, so the release-and-debt state machine
 * runs against in-memory fakes.
 * The plan's order is the security order: capability releases (launches,
 * grants, prompt restores) first, then the witness binding, then roster
 * entries newest-first, then the pointer lease; every step runs even when an
 * earlier one fails.
 */

import type { SessionTaskGraphPointerBinding } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { failure, success, type DomainResult } from "../engine/src/core/orchestration-contract/identity";
import { cleanupFailureSuffix, runPiCleanupActions } from "./cleanup-actions";
import type {
  PiIssuedWriteGrant,
  PiSessionId,
  PiSpawnReservation,
  PiSpawnReservationItem,
} from "./spawn-reservation";

/** One child prompt rewritten to carry its slot's write grant, with the
 *  prompt a release restores. */
export type SpawnPromptRewrite = Readonly<{ slot: number; originalTask: string }>;

/** The least a claimed roster entry carries: the id its removal names. */
export type RosterClaim = Readonly<{ rosterId: AgentId }>;

/** The claims that outlive the `tool_call` taking them: what a dispatched
 *  batch holds at settlement and what cleanup debt records. A spawn batch's
 *  roster entries are reservation items; a child binding's is its bare id. */
export type DurableSpawnClaims<R extends RosterClaim = PiSpawnReservationItem> = Readonly<{
  /** In issuance (slot) order; at most one per slot. */
  grants: readonly PiIssuedWriteGrant[];
  /** Every roster entry reserved, in reservation order — for a batch, the
   *  authority-free reservation item cleanup debt keeps for an entry. */
  roster: readonly R[];
  pointer: SessionTaskGraphPointerBinding | null;
}>;

export type SpawnClaims = DurableSpawnClaims & Readonly<{
  emissionLaunchesStaged: boolean;
  /** Each names, at most once, the slot of a grant claimed when the prompt
   *  was rewritten (that grant may since have been revoked). */
  promptRewrites: readonly SpawnPromptRewrite[];
  /** The review run this batch's first exact standalone spawn bound as
   *  current, while that binding is still the batch's to retract. */
  witnessRun: SessionRunBinding | null;
}>;

export const NO_DURABLE_SPAWN_CLAIMS: DurableSpawnClaims = Object.freeze({
  grants: Object.freeze([]),
  roster: Object.freeze([]),
  pointer: null,
});

export const NO_SPAWN_CLAIMS: SpawnClaims = Object.freeze({
  ...NO_DURABLE_SPAWN_CLAIMS,
  emissionLaunchesStaged: false,
  promptRewrites: Object.freeze([]),
  witnessRun: null,
});

/** Record a roster entry the batch is about to mark active; an entry already
 *  claimed is refused, because releases are logged by roster id and one
 *  removal would then discharge both claims. */
export function claimRosterEntry(claims: SpawnClaims, item: PiSpawnReservationItem): DomainResult<SpawnClaims, string> {
  if (claims.roster.some(({ rosterId }) => rosterId === item.rosterId)) {
    return failure(`spawn batch already holds claimed roster entry ${item.rosterId}`);
  }
  return success(Object.freeze({ ...claims, roster: Object.freeze([...claims.roster, item]) }));
}

/** Record the batch's task-graph pointer lease; a second lease is refused,
 *  because the release would then owe only the later one. */
export function claimPointerLease(
  claims: SpawnClaims,
  pointer: SessionTaskGraphPointerBinding,
): DomainResult<SpawnClaims, string> {
  if (claims.pointer !== null) return failure("spawn batch already holds a claimed task-graph pointer lease");
  return success(Object.freeze({ ...claims, pointer }));
}

/** Record the run a standalone spawn newly bound as current for its root; a
 *  second run is refused, because the release would then retract only the
 *  later binding and leave the earlier one current. */
export function claimWitnessRun(claims: SpawnClaims, binding: SessionRunBinding): DomainResult<SpawnClaims, string> {
  if (claims.witnessRun !== null) {
    return failure(`spawn batch already holds claimed review run ${claims.witnessRun.runId}`);
  }
  return success(Object.freeze({ ...claims, witnessRun: binding }));
}

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

/** Staging is one fact per batch: its one release removes every launch the
 *  tool call staged, however often it staged, so the ledger can never owe less
 *  than was taken and recording it again is never refused and changes nothing. */
export const claimEmissionLaunches = (claims: SpawnClaims): SpawnClaims =>
  Object.freeze({ ...claims, emissionLaunchesStaged: true });

/**
 * One capability a batch claims. Admission records a roster entry before it
 * marks it active and a prompt rewrite before it writes the prompt; every
 * other capability is recorded just after it is taken.
 */
export type SpawnClaim =
  | Readonly<{ kind: "roster-entry"; item: PiSpawnReservationItem }>
  | Readonly<{ kind: "pointer-lease"; pointer: SessionTaskGraphPointerBinding }>
  | Readonly<{ kind: "witness-run"; binding: SessionRunBinding }>
  | Readonly<{ kind: "write-grant"; grant: PiIssuedWriteGrant }>
  | Readonly<{ kind: "grant-injection"; rewrite: SpawnPromptRewrite }>
  | Readonly<{ kind: "emission-launches" }>;

/** Record any claim under the ledger's one refusal rule: a claim is refused
 *  exactly when recording it would let the ledger owe less than was taken. */
export function recordSpawnClaim(claims: SpawnClaims, claim: SpawnClaim): DomainResult<SpawnClaims, string> {
  switch (claim.kind) {
    case "roster-entry":
      return claimRosterEntry(claims, claim.item);
    case "pointer-lease":
      return claimPointerLease(claims, claim.pointer);
    case "witness-run":
      return claimWitnessRun(claims, claim.binding);
    case "write-grant":
      return claimWriteGrant(claims, claim.grant);
    case "grant-injection":
      return claimGrantInjection(claims, claim.rewrite);
    case "emission-launches":
      return success(claimEmissionLaunches(claims));
  }
}

/**
 * What a refused claim leaves taken but owned by no rollback, as a ledger of
 * its own: the capability itself when it was taken before being recorded, and
 * nothing when the claim precedes the taking (a roster entry not yet marked, a
 * prompt not yet rewritten).
 */
export function unownedOnRefusal(claim: SpawnClaim): SpawnClaims {
  switch (claim.kind) {
    case "roster-entry":
    case "grant-injection":
      return NO_SPAWN_CLAIMS;
    case "pointer-lease":
      return Object.freeze({ ...NO_SPAWN_CLAIMS, pointer: claim.pointer });
    case "witness-run":
      return Object.freeze({ ...NO_SPAWN_CLAIMS, witnessRun: claim.binding });
    case "write-grant":
      return Object.freeze({ ...NO_SPAWN_CLAIMS, grants: Object.freeze([Object.freeze({ ...claim.grant })]) });
    case "emission-launches":
      return Object.freeze({ ...NO_SPAWN_CLAIMS, emissionLaunchesStaged: true });
  }
}

/**
 * The durable ledger a dispatched batch still holds at settlement: its
 * committed grants and its reservation's roster entries and pointer lease.
 * Launch removal is the dispatcher's first act and prompt rewrites end at
 * dispatch, so neither is owed here; nor is the witness binding, which
 * settlement enriches rather than retracts.
 */
export const settledSpawnClaims = (
  grants: readonly PiIssuedWriteGrant[],
  reservation: PiSpawnReservation | undefined,
): DurableSpawnClaims =>
  Object.freeze({
    grants: Object.freeze([...grants]),
    roster: reservation?.items ?? NO_DURABLE_SPAWN_CLAIMS.roster,
    pointer: reservation?.pointerBinding ?? null,
  });

/** Only the grants: what shutdown revokes for every tool call before any
 *  roster or pointer housekeeping. */
export const grantsOnly = (claims: DurableSpawnClaims): DurableSpawnClaims =>
  Object.freeze({ ...NO_DURABLE_SPAWN_CLAIMS, grants: claims.grants });

/** Everything but the grants: shutdown's housekeeping after every revocation. */
export const withoutGrants = (claims: DurableSpawnClaims): DurableSpawnClaims =>
  Object.freeze({ ...claims, grants: NO_DURABLE_SPAWN_CLAIMS.grants });

/** Everything but the pointer lease: what settlement releases before it
 *  processes the batch's results. */
export const withoutPointerLease = (claims: DurableSpawnClaims): DurableSpawnClaims =>
  Object.freeze({ ...claims, pointer: null });

/** Only the pointer lease: what settlement releases last. */
export const pointerLeaseOnly = (claims: DurableSpawnClaims): DurableSpawnClaims =>
  Object.freeze({ ...NO_DURABLE_SPAWN_CLAIMS, pointer: claims.pointer });

type RevokeGrantStep = Readonly<{ kind: "revoke-grant"; slot: number; token: string }>;

/** A release step for a durable claim — the only steps settlement plans. */
export type DurableReleaseStep<R extends RosterClaim = PiSpawnReservationItem> =
  | RevokeGrantStep
  | Readonly<{ kind: "remove-roster-entry"; item: R }>
  | Readonly<{ kind: "release-pointer"; pointer: SessionTaskGraphPointerBinding }>;

export type SpawnRollbackStep =
  | Readonly<{ kind: "remove-emission-launches" }>
  | Readonly<{ kind: "restore-prompt"; slot: number; originalTask: string }>
  | Readonly<{ kind: "retract-witness-run"; binding: SessionRunBinding }>
  | DurableReleaseStep;

const revokeStep = ({ slot, token }: PiIssuedWriteGrant): RevokeGrantStep =>
  Object.freeze({ kind: "revoke-grant" as const, slot, token });

const restoreStep = (rewrite: SpawnPromptRewrite): SpawnRollbackStep =>
  Object.freeze({ kind: "restore-prompt" as const, ...rewrite });

/** Each grant's revoke, followed by the restore of the prompt it rewrote. */
const grantReleaseSteps = (claims: SpawnClaims): readonly SpawnRollbackStep[] =>
  claims.grants.flatMap((grant) => [
    revokeStep(grant),
    ...claims.promptRewrites.filter(({ slot }) => slot === grant.slot).map(restoreStep),
  ]);

/** The restore still owed by a rewrite whose grant an earlier release already
 *  revoked. */
const orphanRestoreSteps = (claims: SpawnClaims): readonly SpawnRollbackStep[] =>
  claims.promptRewrites.filter(({ slot }) => !claims.grants.some((grant) => grant.slot === slot)).map(restoreStep);

/** Roster entries newest-first, then the pointer lease. */
const rosterAndPointerSteps = <R extends RosterClaim>(claims: DurableSpawnClaims<R>): readonly DurableReleaseStep<R>[] => [
  ...[...claims.roster].reverse().map((item) => Object.freeze({ kind: "remove-roster-entry" as const, item })),
  ...(claims.pointer === null ? [] : [Object.freeze({ kind: "release-pointer" as const, pointer: claims.pointer })]),
];

/** Every release the claims owe, in the order they must be attempted. */
export function planSpawnRollback(claims: SpawnClaims): readonly SpawnRollbackStep[] {
  return Object.freeze([
    ...(claims.emissionLaunchesStaged ? [Object.freeze({ kind: "remove-emission-launches" as const })] : []),
    ...grantReleaseSteps(claims),
    ...orphanRestoreSteps(claims),
    ...(claims.witnessRun === null ? [] : [Object.freeze({ kind: "retract-witness-run" as const, binding: claims.witnessRun })]),
    ...rosterAndPointerSteps(claims),
  ]);
}

/** The durable claims' releases, in the order `planSpawnRollback` gives them. */
const planDurableRelease = <R extends RosterClaim>(claims: DurableSpawnClaims<R>): readonly DurableReleaseStep<R>[] =>
  Object.freeze([...claims.grants.map(revokeStep), ...rosterAndPointerSteps(claims)]);

/** How one shell names each durable release step it reports a failure under. */
export type DurableReleasePhrasing<R extends RosterClaim = PiSpawnReservationItem> = Readonly<{
  /** Given the 1-based spawn item whose grant is revoked. */
  revokeGrant: (item: number) => string;
  removeRosterEntry: (entry: R) => string;
  releasePointer: string;
}>;

/** The label a failed durable release step is reported under, in a shell's
 *  own phrasing. */
function durableReleaseStepLabel<R extends RosterClaim>(
  step: DurableReleaseStep<R>,
  phrasing: DurableReleasePhrasing<R>,
): string {
  switch (step.kind) {
    case "revoke-grant":
      return phrasing.revokeGrant(step.slot + 1);
    case "remove-roster-entry":
      return phrasing.removeRosterEntry(step.item);
    case "release-pointer":
      return phrasing.releasePointer;
  }
}

const revokeGrantPhrase = (item: number): string => `revoke write grant for spawn item ${item}`;

const ADMISSION_RELEASE_PHRASING: DurableReleasePhrasing = Object.freeze({
  revokeGrant: revokeGrantPhrase,
  removeRosterEntry: ({ rosterId }: PiSpawnReservationItem) => `remove active roster entry ${rosterId}`,
  releasePointer: "roll back task-graph pointer",
});

/** The label an admission rollback reports a failed step under. */
export function spawnRollbackStepLabel(step: SpawnRollbackStep, toolCallId: string): string {
  switch (step.kind) {
    case "remove-emission-launches":
      return `remove emission launch capabilities for ${toolCallId}`;
    case "restore-prompt":
      return `restore child prompt for spawn item ${step.slot + 1}`;
    case "retract-witness-run":
      return `retract unwitnessed review run ${step.binding.runId}`;
    default:
      return durableReleaseStepLabel(step, ADMISSION_RELEASE_PHRASING);
  }
}

/** The parsed session and tool call one batch's durable claims and cleanup
 *  debt are filed under on the parent session. */
export type SpawnClaimHolder = Readonly<{ sessionId: PiSessionId; toolCallId: string }>;

/** How a `tool_result` settlement names a failed step. */
export const settlementReleasePhrasing = (owner: Readonly<{ sessionId: string }>): DurableReleasePhrasing =>
  Object.freeze({
    revokeGrant: revokeGrantPhrase,
    removeRosterEntry: ({ agentType }: PiSpawnReservationItem) => `remove reserved roster entry for ${agentType}`,
    releasePointer: `release parent task-graph pointer lease for ${owner.sessionId}`,
  });

/** How a session shutdown names a failed step of one tool call's release. */
export const shutdownReleasePhrasing = (holder: SpawnClaimHolder): DurableReleasePhrasing =>
  Object.freeze({
    revokeGrant: (item: number) => `revoke outstanding write grant for spawn item ${item} of ${holder.toolCallId}`,
    removeRosterEntry: ({ agentType }: PiSpawnReservationItem) => `remove shutdown roster entry for ${agentType}`,
    releasePointer: `release shutdown task-graph pointer lease for ${holder.sessionId}`,
  });

/** How a retried orphaned claim names a failed step. */
export const ORPHANED_CLAIM_RELEASE_PHRASING: DurableReleasePhrasing = Object.freeze({
  revokeGrant: (item: number) => `revoke orphaned write grant for spawn item ${item}`,
  removeRosterEntry: ({ rosterId }: PiSpawnReservationItem) => `remove orphaned roster entry ${rosterId}`,
  releasePointer: "release orphaned task-graph pointer lease",
});

/** The durable capabilities one release attempt actually released. */
export type DurableClaimReleases = Readonly<{
  revokedTokens: ReadonlySet<string>;
  removedRosterIds: ReadonlySet<AgentId>;
  pointerReleased: boolean;
}>;

/** The capabilities one admission release attempt actually released. */
export type SpawnClaimReleases = DurableClaimReleases & Readonly<{
  launchesRemoved: boolean;
  restoredSlots: ReadonlySet<number>;
  witnessRetracted: boolean;
}>;

/** The durable claims still owed after a release attempt: exactly those whose
 *  release failed or was never attempted. */
export function remainingDurableClaims<R extends RosterClaim>(
  claims: DurableSpawnClaims<R>,
  releases: DurableClaimReleases,
): DurableSpawnClaims<R> {
  return Object.freeze({
    grants: Object.freeze(claims.grants.filter(({ token }) => !releases.revokedTokens.has(token))),
    roster: Object.freeze(claims.roster.filter((item) => !releases.removedRosterIds.has(item.rosterId))),
    pointer: releases.pointerReleased ? null : claims.pointer,
  });
}

/** The claims still owed after a release attempt: the durable rule, plus the
 *  process-local claims whose release failed or was never attempted. */
export function remainingSpawnClaims(claims: SpawnClaims, releases: SpawnClaimReleases): SpawnClaims {
  return Object.freeze({
    ...remainingDurableClaims(claims, releases),
    emissionLaunchesStaged: claims.emissionLaunchesStaged && !releases.launchesRemoved,
    promptRewrites: Object.freeze(claims.promptRewrites.filter(({ slot }) => !releases.restoredSlots.has(slot))),
    witnessRun: releases.witnessRetracted ? null : claims.witnessRun,
  });
}

/** The reservation fields a debt record carries beyond its claims. */
export type SpawnDebtContext = Pick<
  PiSpawnReservation,
  "sessionId" | "needsTaskGraphLifecycle" | "graphActiveAtSpawn" | "orchestrationRunBinding"
>;

/**
 * The cleanup debt owed claims become on the parent session: the grants, and a
 * reservation naming exactly the roster entries and pointer lease. Only
 * durable claims become debt — launches, prompt rewrites and the witness
 * binding are process-local and released in the same step that took them.
 * Owing nothing yields no grants and an empty reservation, which the parent
 * session forgets.
 */
export function spawnDebtOf(
  claims: DurableSpawnClaims,
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

/** The I/O each durable release step performs. A port throws when its release
 *  failed. */
export type DurableClaimReleasePorts = Readonly<{
  revokeGrant: (token: string) => void;
  removeRosterEntry: (agentId: AgentId) => Promise<void>;
  /** Resolves `"rolled-back"` only when this exact lease was released. */
  releasePointer: (pointer: SessionTaskGraphPointerBinding) => Promise<string>;
}>;

/** The I/O every admission release step performs: the durable ports plus the
 *  process-local ones only an admission rollback can need. */
export type SpawnClaimReleasePorts = DurableClaimReleasePorts & Readonly<{
  removeEmissionLaunches: () => void;
  restorePrompt: (slot: number, originalTask: string) => void;
  retractWitnessRun: (binding: SessionRunBinding) => void;
}>;

/** Release exactly this pointer lease, or throw naming the ownership lost. */
async function releaseExactPointerLease(
  releasePointer: DurableClaimReleasePorts["releasePointer"],
  pointer: SessionTaskGraphPointerBinding,
): Promise<void> {
  const result = await releasePointer(pointer);
  if (result !== "rolled-back") throw new Error(`exact pointer ownership lost (${result})`);
}

/** What the executor records as each durable release succeeds. */
type DurableReleaseLog = { revokedTokens: Set<string>; removedRosterIds: Set<AgentId>; pointerReleased: boolean };

const emptyDurableReleaseLog = (): DurableReleaseLog =>
  ({ revokedTokens: new Set(), removedRosterIds: new Set(), pointerReleased: false });

async function releaseDurableStep<R extends RosterClaim>(
  step: DurableReleaseStep<R>,
  ports: DurableClaimReleasePorts,
  log: DurableReleaseLog,
): Promise<void> {
  switch (step.kind) {
    case "revoke-grant":
      ports.revokeGrant(step.token);
      log.revokedTokens.add(step.token);
      return;
    case "remove-roster-entry":
      await ports.removeRosterEntry(step.item.rosterId);
      log.removedRosterIds.add(step.item.rosterId);
      return;
    case "release-pointer":
      await releaseExactPointerLease(ports.releasePointer, step.pointer);
      log.pointerReleased = true;
      return;
  }
}

/** Attempt every step, never stopping at a failure; the failures, labelled. */
const attemptEvery = <S>(
  steps: readonly S[],
  labelOf: (step: S) => string,
  run: (step: S) => Promise<void>,
): Promise<readonly string[]> =>
  runPiCleanupActions(steps.map((step) => ({ label: labelOf(step), run: () => run(step) })));

/**
 * Attempt every planned release of a durable ledger — settlement's,
 * shutdown's, an orphan's or a child binding's — and report the failures (in
 * `phrasing`'s words) together with what was actually released: the input
 * `remainingDurableClaims` turns into what is still owed.
 */
export async function releaseDurableSpawnClaims<R extends RosterClaim>(
  claims: DurableSpawnClaims<R>,
  phrasing: DurableReleasePhrasing<R>,
  ports: DurableClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; releases: DurableClaimReleases }>> {
  const log = emptyDurableReleaseLog();
  const errors = await attemptEvery(
    planDurableRelease(claims),
    (step) => durableReleaseStepLabel(step, phrasing),
    (step) => releaseDurableStep(step, ports, log),
  );
  return Object.freeze({ errors, releases: Object.freeze({ ...log }) });
}

/**
 * Attempt every planned release of a whole ledger — an admission rollback's —
 * and report the failures together with what was actually released: the
 * input `remainingSpawnClaims` turns into what is still owed.
 */
export async function releaseSpawnClaims(
  claims: SpawnClaims,
  labelOf: (step: SpawnRollbackStep) => string,
  ports: SpawnClaimReleasePorts,
): Promise<Readonly<{ errors: readonly string[]; releases: SpawnClaimReleases }>> {
  const durable = emptyDurableReleaseLog();
  const local = { launchesRemoved: false, restoredSlots: new Set<number>(), witnessRetracted: false };
  const errors = await attemptEvery(planSpawnRollback(claims), labelOf, async (step) => {
    switch (step.kind) {
      case "remove-emission-launches":
        ports.removeEmissionLaunches();
        local.launchesRemoved = true;
        return;
      case "restore-prompt":
        ports.restorePrompt(step.slot, step.originalTask);
        local.restoredSlots.add(step.slot);
        return;
      case "retract-witness-run":
        ports.retractWitnessRun(step.binding);
        local.witnessRetracted = true;
        return;
      default:
        return releaseDurableStep(step, ports, durable);
    }
  });
  return Object.freeze({ errors, releases: Object.freeze({ ...durable, ...local }) });
}

/**
 * A durable capability a refused claim took whose compensating release
 * failed. No ledger can own it — the refusal is precisely that the ledger
 * already holds one of its kind — so the parent session keeps it as cleanup
 * debt of its own, which settlement and shutdown retry
 * (`releaseOrphanedSpawnClaims`). Only durable kinds can be orphaned: a failed
 * launch removal or witness retraction is process-local and is discharged by
 * shutdown's session-wide launch removal and witness forget.
 */
export type OrphanedSpawnClaim = Extract<SpawnClaim, { kind: "write-grant" | "pointer-lease" }>;

/** Why a claim was refused, and the capability its failed compensation left
 *  orphaned, if any. */
export type SpawnClaimRefusal = Readonly<{
  /** The refusal, with the compensation's failures appended. */
  reason: string;
  orphaned: OrphanedSpawnClaim | null;
}>;

/** What a release of a claim's capability (a compensation, or an orphan's
 *  retry) left orphaned: the claim itself when it is durable and its
 *  capability was not released, otherwise nothing. */
export function orphanedOnRelease(claim: SpawnClaim, releases: DurableClaimReleases): OrphanedSpawnClaim | null {
  switch (claim.kind) {
    case "write-grant":
      return releases.revokedTokens.has(claim.grant.token) ? null : claim;
    case "pointer-lease":
      return releases.pointerReleased ? null : claim;
    case "roster-entry":
    case "grant-injection":
    case "witness-run":
    case "emission-launches":
      return null;
  }
}

/**
 * Record a claim, or refuse it with what it left unowned already released.
 * A refused claim's capability is owed by no later rollback, so its
 * compensation is the ledger's own planned release of exactly that capability
 * (`unownedOnRefusal`): a claim kind cannot exist without the release that
 * compensates it. The refusal carries the compensation's failures, if any,
 * and the durable capability that failure orphaned, for the caller to keep as
 * session debt.
 */
export async function claimOrCompensate(
  claims: SpawnClaims,
  claim: SpawnClaim,
  labelOf: (step: SpawnRollbackStep) => string,
  ports: SpawnClaimReleasePorts,
): Promise<DomainResult<SpawnClaims, SpawnClaimRefusal>> {
  const recorded = recordSpawnClaim(claims, claim);
  if (recorded.ok) return recorded;
  const { errors, releases } = await releaseSpawnClaims(unownedOnRefusal(claim), labelOf, ports);
  return failure(Object.freeze({
    reason: `${recorded.error}${cleanupFailureSuffix(errors)}`,
    orphaned: orphanedOnRelease(claim, releases),
  }));
}
