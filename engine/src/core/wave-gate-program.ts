/**
 * The registered Wave Gate program: the durable registration a Wave Gate Run
 * Directory carries, and the reviewer-protocol arm every registered review
 * program shares. Pure data — the program volume parses stored bytes into
 * these shapes; the core transitions and membership checks consume them.
 */
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";

/** Archived schema-1 review programs carry no issued descriptor; current
 *  schema-2 programs freeze the exact reviewer protocol they issued. The
 *  descriptor parameter is the program's admitted set: a Wave Gate admits v2
 *  or v4, a standalone review v2 only (ADR-0084). */
export type RegisteredReviewerProtocol<Descriptor extends ReviewerProtocolDescriptor = ReviewerProtocolDescriptor> =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: Descriptor }>;

/** One Wave Gate run on a restart lineage, named by its run and authority digest. */
export type CarriedReviewAuthority = Readonly<{ runId: string; authorityDigest: string }>;

/**
 * What one reviewed Task carries into a replacement run (ADR-0088):
 * - `accepted-task`: every slot of `roster` was accepted along the lineage, by
 *   the run `acceptance` names. The Task is not reissued.
 * - `accepted-slots`: the `agents` slots were accepted; only the rest of the
 *   Task's roster is reissued.
 */
export type WaveReviewCarry =
  | Readonly<{
      kind: "accepted-task";
      taskId: string;
      roster: readonly [string, ...string[]];
      acceptance: CarriedReviewAuthority;
    }>
  | Readonly<{ kind: "accepted-slots"; taskId: string; agents: readonly [string, ...string[]] }>;

/**
 * The carry plan a restart froze into its replacement's registration.
 * `lineage` is every run along the unbroken chain of carrying restarts that led
 * here, oldest first: a predecessor that itself carried nothing starts the
 * chain afresh. `carried` lists the reviewed Tasks that carry, in registration
 * order. Absent when nothing carries, so such a registration is byte-identical
 * to one written before carry existed.
 */
export type WaveReviewCarryAudit = Readonly<{
  lineage: readonly [CarriedReviewAuthority, ...CarriedReviewAuthority[]];
  carried: readonly [WaveReviewCarry, ...WaveReviewCarry[]];
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

export type RegisteredWaveGateProgram = RegisteredReviewerProtocol & Readonly<{
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: WaveGateRestartAudit;
  orphanRecovery?: OrphanedWaveGateRecoveryAudit;
}>;
