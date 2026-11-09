/**
 * The Orchestration Program vocabulary: the leaf both the Agent Catalog
 * (`core/model-profiles.ts`, whose one profile-eligibility rule is keyed by
 * program) and the orchestration contract's request authority parse against.
 * It imports nothing, so neither side can close an import cycle through it.
 * Pure module: no I/O, no clock, no randomness.
 */

/** ADR-0067: the program that issues the security audit's verifier spawns, one
 *  per verification brief. Its literal is written ONCE, here, and is a member of
 *  `ORCHESTRATION_PROGRAMS` by construction — so it is an `OrchestrationProgram`
 *  while keeping its literal type, which the ballot binding, the capture
 *  attestation and the verification wire narrow their `program` field to. */
export const SECURITY_VERIFICATION_PROGRAM = "security-verification" as const;

export const ORCHESTRATION_PROGRAMS = Object.freeze([
  "architecture-panel",
  "refutation-panel",
  "wave-gate",
  "standalone-review",
  SECURITY_VERIFICATION_PROGRAM,
] as const);
export type OrchestrationProgram = (typeof ORCHESTRATION_PROGRAMS)[number];
