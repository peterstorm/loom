/**
 * Core business logic — harness-agnostic decision functions, no Claude Code
 * stdin parsing. Not all pure: some read the filesystem or write to stderr.
 * Both Claude Code handlers and pi extension import from here.
 */

export { shouldBlockDirectEdit } from "./block-direct-edits";
export { guardStateFile } from "./guard-state-file";
export { validatePhaseOrder, detectPhase, checkArtifacts } from "./validate-phase-order";
export type { ValidatePhaseOrderInput, ArtifactState } from "./validate-phase-order";
export type { ValidateTaskExecutionInput } from "./validate-task-execution";
export { validateTemplateSubstitution } from "./validate-template-substitution";
export { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "./tool-vocabulary";
