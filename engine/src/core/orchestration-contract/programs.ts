/**
 * The Orchestration Program vocabulary: the leaf both the Agent Catalog
 * (`core/model-profiles.ts`, whose one profile-eligibility rule is keyed by
 * program) and the orchestration contract's request authority parse against.
 * It imports nothing, so neither side can close an import cycle through it.
 * Pure module: no I/O, no clock, no randomness.
 */

export const ORCHESTRATION_PROGRAMS = Object.freeze([
  "architecture-panel",
  "refutation-panel",
  "wave-gate",
  "standalone-review",
] as const);
export type OrchestrationProgram = (typeof ORCHESTRATION_PROGRAMS)[number];
