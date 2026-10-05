/**
 * Curated Public Surface for parent-facing program drivers.
 *
 * Owning volumes may export internal pure helpers for sibling volumes and
 * focused tests. That does not make those helpers part of this caller seam.
 */

export {
  parseRegisteredFacadeProgram,
  parseRemediationStartInput,
  parseStandaloneStartInput,
  parseWaveGateStartInput,
  type RegisteredStandaloneProgram,
} from './registration';
export type { RegisteredRemediationProgram, RemediationStartInputV2 } from './remediation-registration';
export type { FacadeDriveResult, ProgramParse } from './program-result';
// Parent-side spawn admission must prove publication, not trust prompt markers.
export { publishedReviewerRequest } from './durable-requests';
export { reviewerProtocolResolver } from './reviewer-protocol-resolution';
// `renderSpawnTask` is the durable-compatibility/extraction-only render: it
// never carries an issued emission descriptor. The program-path emission
// seam (`renderReviewProgramSpawnTask`/`publishReviewInitialBatch` and their
// required `RegisteredReviewProgram` authority) is deliberately NOT on this
// surface — descriptor/route projection is internal to the programs volume,
// and publication without an explicit route decision is unrepresentable for
// callers (FR-001/FR-020; the curated surface stays parent-caller operations).
export { renderSpawnTask } from './spawn-task';
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
export { resumeWaveGateFacade } from './wave-gate';
export { prepareWaveGateFacadeStart, startWaveGateFacade } from './wave-gate-start';
export { recoverOrphanedWaveGateFacade, restartWaveGateFacade } from './wave-gate-replacement';
export { applyWaveFacadeSubmission } from './wave-gate-submission';
export { handleWaveReviewContext } from './wave-review-context';
export { waveAdvisoryDecisionRequestId } from './wave-advisory-decision';
export {
  inspectRemediationFacade,
  prepareRemediationFacadeStart,
  resumeRemediationFacade,
  startRemediationFacade,
  type PreparedRemediationFacadeStart,
} from './remediation';
