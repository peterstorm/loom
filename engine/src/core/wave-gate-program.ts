/**
 * The registered Wave Gate program: the durable registration a Wave Gate Run
 * Directory carries, and the reviewer-protocol arm every registered review
 * program shares. Pure data — the program volume parses stored bytes into
 * these shapes; the core transitions and membership checks consume them.
 */
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";

/** Archived schema-1 review programs carry no issued descriptor; current
 *  schema-2 programs freeze the exact reviewer protocol they issued. */
export type RegisteredReviewerProtocol =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>;

/** Audit of a replacement run that superseded an exhausted predecessor. */
export type WaveGateRestartAudit = Readonly<{
  previousRunId: string;
  exhaustedSlots: readonly string[];
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
