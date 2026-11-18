/**
 * The registered Wave Gate program: the durable registration a Wave Gate Run
 * Directory carries, and the reviewer-protocol arm every registered review
 * program shares. Pure data — the program volume parses stored bytes into
 * these shapes; the core transitions and membership checks consume them.
 */
import type { WaveReviewRunRetirement } from "../types";
import type { NarrowedWaveReviewRoster, WaveReviewRoster } from "./agent-catalog-projections";
import type { NarrowingChangeClass } from "./findings-shape";
import type { NonEmpty } from "./orchestration-contract";
import type { ReviewBasisAuthority } from "./review-narrowing";
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";

/** Archived schema-1 review programs carry no issued descriptor; current
 *  schema-2 programs freeze the exact reviewer protocol they issued. The
 *  descriptor parameter is the program's admitted set: a Wave Gate admits v2
 *  or v4, a standalone review v2 only (ADR-0084). */
export type RegisteredReviewerProtocol<Descriptor extends ReviewerProtocolDescriptor = ReviewerProtocolDescriptor> =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: Descriptor }>;

/**
 * One Wave Gate run on a carry lineage, named by its run and authority digest:
 * a restart's exhausted predecessor (ADR-0089) or the retired run a fresh
 * start succeeded (ADR-0091), and every run those carried from in turn.
 */
export type CarriedReviewAuthority = Readonly<{ runId: string; authorityDigest: string }>;

/**
 * What one reviewed Task carries into a run from an earlier run on its lineage:
 * - `accepted-task`: every slot of `roster` was accepted along the lineage, by
 *   the run `acceptance` names. The Task is not reissued. A restart (ADR-0089)
 *   and a fresh start's Successor Carry (ADR-0091) both record it.
 * - `accepted-slots`: the `agents` slots were accepted; only the rest of the
 *   Task's roster is reissued. Only a restart records it.
 */
export type WaveReviewCarry = AcceptedTaskCarry | Readonly<{ kind: "accepted-slots"; taskId: string; agents: readonly [string, ...string[]] }>;

/** A Task whose whole roster was accepted along the lineage: it is not reissued. */
export type AcceptedTaskCarry = Readonly<{
  kind: "accepted-task";
  taskId: string;
  roster: readonly [string, ...string[]];
  acceptance: CarriedReviewAuthority;
}>;

/**
 * The carry plan a restart or a fresh start froze into its registration.
 * `lineage` is every run along the unbroken chain of carrying runs that led
 * here, oldest first: a predecessor that itself carried nothing starts the
 * chain afresh. `carried` lists the reviewed Tasks that carry, in registration
 * order. Absent when nothing carries, so such a registration is byte-identical
 * to one written before carry existed. `Entry` narrows what may carry: a
 * Successor Carry (ADR-0091) carries whole-roster acceptances only.
 */
export type WaveReviewCarryAudit<Entry extends WaveReviewCarry = WaveReviewCarry> = Readonly<{
  lineage: readonly [CarriedReviewAuthority, ...CarriedReviewAuthority[]];
  carried: readonly [Entry, ...Entry[]];
}>;

/**
 * Audit of a fresh start that succeeded a retired run of its Wave (ADR-0091):
 * the abandoned or completed-and-reopened run it succeeded, and the accepted
 * reviews it carries from that run's lineage. Recorded only when something
 * carries, so a fresh start that carries nothing registers exactly as before.
 */
export type WaveGateSuccessionAudit = Readonly<{
  previousRunId: string;
  previousAuthorityDigest: string;
  kind: WaveReviewRunRetirement;
  carry: WaveReviewCarryAudit<AcceptedTaskCarry>;
}>;

/** Audit of a replacement run that superseded an exhausted predecessor. */
export type WaveGateRestartAudit = Readonly<{
  previousRunId: string;
  exhaustedSlots: readonly string[];
  carry?: WaveReviewCarryAudit;
}>;

/** Audit of a replacement run that retired a predecessor whose Run Directory vanished. */
export type OrphanedWaveGateRecoveryAudit = Readonly<{
  previousRunId: string;
  previousAuthorityDigest: string;
}>;

/**
 * How a Wave Gate run came to be registered, as the registration records it:
 * a fresh start that carries nothing (no audit), a restart of an exhausted run,
 * an orphan recovery, or a fresh start's Succession. The arms are exclusive by
 * type, so no registration holds two audits; the persisted JSON keeps each
 * audit under its own key exactly as before. Read the tagged form through
 * `waveGateOriginOf`.
 */
export type WaveGateOriginAudit =
  | Readonly<{ restart?: never; orphanRecovery?: never; succession?: never }>
  | Readonly<{ restart: WaveGateRestartAudit; orphanRecovery?: never; succession?: never }>
  | Readonly<{ restart?: never; orphanRecovery: OrphanedWaveGateRecoveryAudit; succession?: never }>
  | Readonly<{ restart?: never; orphanRecovery?: never; succession: WaveGateSuccessionAudit }>;

/** The origin a registration records, tagged. */
export type WaveGateOrigin =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "restart"; audit: WaveGateRestartAudit }>
  | Readonly<{ kind: "orphan-recovery"; audit: OrphanedWaveGateRecoveryAudit }>
  | Readonly<{ kind: "succession"; audit: WaveGateSuccessionAudit }>;

const FRESH: WaveGateOrigin = Object.freeze({ kind: "fresh" });

/** The tagged origin of a registration. */
export function waveGateOriginOf(registration: WaveGateOriginAudit): WaveGateOrigin {
  if (registration.restart !== undefined) return Object.freeze({ kind: "restart", audit: registration.restart });
  if (registration.orphanRecovery !== undefined) return Object.freeze({ kind: "orphan-recovery", audit: registration.orphanRecovery });
  if (registration.succession !== undefined) return Object.freeze({ kind: "succession", audit: registration.succession });
  return FRESH;
}

/**
 * One reviewed Task a start issued only part of its derived roster
 * (ADR-0094): the roles it issues, in roster order, the derived roster they
 * were chosen from, the change classes that chose them, and the basis the
 * change was measured against.
 */
export type NarrowedTaskReview = Readonly<{
  taskId: string;
  roster: NarrowedWaveReviewRoster;
  from: WaveReviewRoster;
  change: NonEmpty<NarrowingChangeClass>;
  basis: ReviewBasisAuthority;
}>;

/**
 * The narrowed reviews a registration froze (ADR-0094), in registration
 * order. Absent when every reviewed Task is issued its whole roster, so such
 * a registration is byte-identical to one written before narrowing existed.
 */
export type WaveReviewNarrowingAudit = Readonly<{ narrowedReviews?: NonEmpty<NarrowedTaskReview> }>;

/** What a registration freezes about which roles its batch issues: its origin's carry and its narrowing. */
export type WaveReviewIssuancePlan = WaveGateOriginAudit & WaveReviewNarrowingAudit;

export type RegisteredWaveGateProgram = RegisteredReviewerProtocol & WaveReviewIssuancePlan & Readonly<{
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
}>;
