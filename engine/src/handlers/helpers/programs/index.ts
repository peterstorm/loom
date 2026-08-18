/**
 * Façade program drivers — facade (A14). The single 2,900-line module is
 * split into per-program driver volumes (standalone, wave-gate, remediation)
 * plus shared recovery/git/scope helpers; this index re-exports the full
 * public surface so all import sites (orchestration.ts, tests) are unchanged.
 */

export { classifyScope, parseRegisteredFacadeProgram, parseRemediationStartInput, parseStandaloneStartInput, parseWaveGateStartInput, renderSpawnTask, type FacadeDriveResult, type FacadeRegistrationParse, type ProgramParse, type RegisteredFacadeProgram, type RegisteredRemediationProgram, type RegisteredStandaloneProgram, type RegisteredWaveGateProgram } from './helpers';
export { resumeStandaloneFacade, startStandaloneFacade } from './standalone';
export { applyWaveFacadeSubmission, parseWaveRetryDiagnosticSection, persistedWaveAttemptTwoCompatibilityProblem, prepareOrphanedWaveGateRecovery, recoverOrphanedWaveGateFacade, restartWaveGateFacade, resumeWaveGateFacade, startWaveGateFacade, waveAdvisoryDecisionRequestId } from './wave-gate';
export { remediationAuditBlockMessage, resumeRemediationFacade, startRemediationFacade } from './remediation';
