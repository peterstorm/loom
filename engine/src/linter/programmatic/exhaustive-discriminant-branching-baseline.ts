/**
 * Grandfathered `exhaustive-discriminant-branching` sites — if-chains that
 * branch three or more times on one discriminant with no totality proof.
 *
 * The rule used to exempt a WHOLE FILE whenever any `match(...).exhaustive()`
 * appeared in it, so these chains sat under a green lint. This list is that
 * debt, written down: a new chain must prove totality, and converting one of
 * these means deleting its entry (`scripts/lint-project.ts` reports entries no
 * chain consumes, and the rule's test asserts this list against the live
 * repository).
 *
 * Keys are `path::discriminant`, one entry per offending chain.
 */
export const EXHAUSTIVE_BRANCHING_BASELINE: readonly string[] = Object.freeze([
  "engine/src/core/loom-status.ts::runDirectory.kind",
  "engine/src/core/loom-status.ts::window.kind",
  "engine/src/core/proof-obligations.ts::raw.kind",
  "engine/src/core/standalone-review.ts::event.kind",
  "engine/src/core/wave-gate-machine.ts::action.kind",
  "engine/src/handlers/helpers/orchestration.ts::observation.kind",
  "engine/src/handlers/helpers/orchestration.ts::parsed.kind",
  "engine/src/handlers/pre-tool-use/enforce-phase-tools.ts::target.kind",
  "engine/src/handlers/type-diagnostics-runner.ts::ended.kind",
  "pi/implementation-brief-expansion.ts::triage.kind",
] as const);
