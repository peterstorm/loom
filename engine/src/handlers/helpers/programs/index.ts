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
  renderSpawnTask,
  type FacadeDriveResult,
  type ProgramParse,
  type RegisteredRemediationProgram,
  type RegisteredStandaloneProgram,
  type RegisteredWaveGateProgram,
} from './helpers';
export {
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
export { resumeRemediationFacade, startRemediationFacade } from './remediation';
