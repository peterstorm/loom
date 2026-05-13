/**
 * Core business logic — pure functions, no Claude Code stdin parsing.
 * Both Claude Code handlers and pi extension import from here.
 */

export { shouldBlockDirectEdit } from "./block-direct-edits";
export { guardStateFile } from "./guard-state-file";
export { validatePhaseOrder, detectPhase, checkArtifacts } from "./validate-phase-order";
export type { ValidatePhaseOrderInput, ArtifactState } from "./validate-phase-order";
export { validateTaskExecution } from "./validate-task-execution";
export type { ValidateTaskExecutionInput } from "./validate-task-execution";
export { validateTemplateSubstitution } from "./validate-template-substitution";
