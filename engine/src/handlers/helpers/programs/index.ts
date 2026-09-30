/**
 * Curated Public Surface for parent-facing program drivers.
 *
 * Owning volumes may export internal pure helpers for sibling volumes and
 * focused tests. That does not make those helpers part of this caller seam.
 */

export {
  parseRegisteredFacadeProgram,
  // Parent-side spawn admission must prove publication, not trust prompt markers.
  publishedReviewerRequest,
  parseRemediationStartInput,
  parseStandaloneStartInput,
  parseWaveGateStartInput,
  // `renderSpawnTask` is the durable-compatibility/extraction-only render: it
  // never carries an issued emission descriptor. The program-path emission
  // seam (`renderReviewProgramSpawnTask`/`publishReviewInitialBatch` and their
  // required `RegisteredReviewProgram` authority) is deliberately NOT on this
  // surface — descriptor/route projection is internal to the programs volume,
  // and publication without an explicit route decision is unrepresentable for
  // callers (FR-001/FR-020; the curated surface stays parent-caller operations).
  renderSpawnTask,
  reviewerProtocolResolver,
  type FacadeDriveResult,
  type ProgramParse,
  type RegisteredRemediationProgram,
  type RemediationStartInputV2,
  type RegisteredStandaloneProgram,
  type RegisteredWaveGateProgram,
} from './helpers';
export {
  inspectStandaloneFacade,
  prepareStandaloneSuccessorFacadeStart,
  startPreparedStandaloneSuccessor,
  replayStandaloneCapturedEvidence,
  readStandaloneReviewedSource,
  replayStandaloneResultFromEvidence,
  resumeStandaloneFacade,
  type StandaloneReviewedSource,
  startStandaloneFacade,
} from './standalone';
export {
  applyWaveFacadeSubmission,
  handleWaveReviewContext,
  recoverOrphanedWaveGateFacade,
  restartWaveGateFacade,
  resumeWaveGateFacade,
  startWaveGateFacade,
  waveAdvisoryDecisionRequestId,
  waveGateDecisionMismatch,
  type WaveReviewContextAuthority,
} from './wave-gate';
export {
  inspectRemediationFacade,
  prepareRemediationFacadeStart,
  resumeRemediationFacade,
  startRemediationFacade,
  type PreparedRemediationFacadeStart,
} from './remediation';
