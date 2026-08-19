/**
 * Orchestration shared kernel — facade, and the kernel's PUBLIC SURFACE.
 *
 * The kernel is split into pure sub-domain volumes (identity, bytes, errors,
 * artifacts, roster, publication, completion, diagnostics, actions, effects),
 * which form an acyclic layering — see
 * `tests/core/orchestration-contract-acyclic.test.ts`, which fails if a volume
 * ever imports one above it.
 *
 * This list is CURATED, not the union of what the volumes export. A volume
 * exports a symbol so that volumes above it can use it; that is an internal
 * relationship and says nothing about whether callers outside the kernel need
 * it. This module used to re-export the union — 142 symbols, of which 52 were
 * imported by nothing outside the kernel — and the blanket re-export is what
 * made an unused export indistinguishable from a public one.
 *
 * Adding a symbol here means committing to it as kernel API. If a caller needs
 * something not listed, add it deliberately rather than widening the surface
 * by reflex.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export { MAX_DIAGNOSTIC_MESSAGE_LENGTH, canonicalRecord, canonicalStructuralEquals, parseArtifactByteLength, parseArtifactDigest, parseContextDigest, parseEffectId, parseOrchestrationRunId, parseRequestId, parseSlotId, type ArtifactByteLength, type ArtifactDigest, type ContextDigest, type DomainResult, type EffectId, type NonEmpty, type OrchestrationRunId, type RequestId, type SemanticAttempt, type SlotId } from './identity';
export { MAX_DENSE_DATA_ARRAY_LENGTH, MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH, digestRawTranscriptBytes } from './bytes';
export { AGENT_REQUIRED_SKILLS, parseFixedArtifactSlot } from './artifacts';
export { sameAgentRequestAuthority, parseAgentRequestAuthority, parseStoredAgentRequestAuthority, parseAgentRosterSlot, parseArtifactRef, parseExactRoster, type AgentRequestAuthority, type AgentRosterSlot, type ArtifactRef, type ExactRoster, type RosterViolation } from './roster';
export { createAtomicInitialPublicationClaimPort, createInitialBatchPublicationReconciler, createInitialPublicationEffectPort, createPublicationAuthorityResolver, parseBatchPublishedReceipt, parseIssuedSpawnRequest, prepareInitialBatchPublicationIntent, type AtomicInitialPublicationClaim, type BatchPublicationIdentity, type BatchPublishedReceipt, type InitialBatchPublicationIntent, type InitialPublicationEffectExecutor, type InitialPublicationEffectPort, type InitialPublicationIssuanceAuthority, type InitialSpawnRequestInput, type PublicationAuthorityResolver, type RegisteredBatchPublicationAuthority, type SpawnRequest, type TrustedPublicationRegistrationLoader } from './publication';
export { acceptedAgentResult, parseCompleteRoster, type AcceptedAgentResult, type CompleteRoster, type CompleteRosterError, type SemanticPayloadParseError, type SemanticPayloadParser } from './completion';
export { infrastructureRetryDiagnostic, semanticRetryDiagnostic, terminalBlockedDiagnostic, type BlockedDiagnostic, type InfrastructureRetryDiagnostic, type TerminalBlockedDiagnostic } from './diagnostics';
export { awaitUserAction, blockedAction, doneAction, issueInitialSpawnRequests, parseBlockedDiagnostic, rehydrateIssuedSpawnRequests, spawnBatchAction, type AwaitUserAction, type BlockedAction, type DoneAction, type ExternalAction, type SpawnBatchAction } from './actions';
export { parseEffectReceipt, parseVerifiedIndexInstalled, reconcileEffectReceipt, type ArtifactSetPublished, type CaptureRawTranscript, type CommitProtectedWaveState, type EffectIntent, type EffectReceipt, type InstallVerifiedIndex, type ProtectedWaveStateCommitted, type PublishArtifactSet, type RawTranscriptCaptured, type VerifiedIndexInstalled } from './effects';
