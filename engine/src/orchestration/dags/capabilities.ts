/**
 * The three narrow capabilities operation DAGs may hold.
 *
 * A node declares what it needs through `requires`, and Fugue only exposes a
 * declared capability on its context. That is the whole point of keeping this
 * list short: no node ever receives arbitrary filesystem, process, or State
 * File access, so the blast radius of a node is exactly the ports named here.
 *
 * Validation, set algebra, and routing nodes require NOTHING — they are pure
 * transforms. Only the genuine edge effects reach for a capability, and only
 * `protectedStateCommit` is allowed to delegate to `StateManager`.
 */

import type {
  ArtifactDigest,
  DomainResult,
  EffectId,
  OrchestrationRunId,
} from "../../core/orchestration-contract";
import type { StagedArtifact } from "../run-directory-handle";

/** Publish artifacts into the already-anchored run directory. */
export type RunArtifactsCapability = Readonly<{
  publishArtifactSet: (
    staged: readonly StagedArtifact[],
  ) => Promise<DomainResult<readonly unknown[], Readonly<{ message: string }>>>;
}>;

/** The single seam permitted to write the protected task graph. */
export type ProtectedStateCommitCapability = Readonly<{
  commit: (input: Readonly<{
    runId: OrchestrationRunId;
    effectId: EffectId;
    expectedRevision: number;
    stateDigest: ArtifactDigest;
  }>) => Promise<DomainResult<Readonly<{ committedRevision: number }>, Readonly<{ message: string }>>>;
}>;

/** Read-only Git witnesses plus the verified-index installation seam. */
export type GitIndexCapability = Readonly<{
  observeDirtyPaths: () => Promise<readonly string[]>;
  snapshotWitness: () => Promise<Readonly<{ indexDigest: string; worktreeDigest: string }>>;
  installVerifiedIndex: (input: Readonly<{
    indexDigest: ArtifactDigest;
    witnessDigest: ArtifactDigest;
  }>) => Promise<DomainResult<Readonly<{ installed: true }>, Readonly<{ message: string }>>>;
}>;

declare module "@fuguejs/framework" {
  interface CapabilityRegistry {
    readonly runArtifacts: RunArtifactsCapability;
    readonly protectedStateCommit: ProtectedStateCommitCapability;
    readonly gitIndex: GitIndexCapability;
  }
}

/** Every capability an operation DAG is permitted to require. */
export const ORCHESTRATION_CAPABILITIES = Object.freeze([
  "runArtifacts",
  "protectedStateCommit",
  "gitIndex",
] as const);

export type OrchestrationCapability = (typeof ORCHESTRATION_CAPABILITIES)[number];
