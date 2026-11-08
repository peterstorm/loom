/**
 * Grandfathered `switch-totality` sites: switches written before the rule
 * existed, each keyed `path::scrutinee` with multiplicity.
 *
 * Every entry is debt with a reason, not a permission. Nothing here may grow: a
 * new switch either proves totality (`match(...).exhaustive()`, or a `default`
 * arm binding the scrutinee to `never`) or is a violation. Delete an entry when
 * its switch is converted or removed — `scripts/lint-project.ts` reports entries
 * no switch consumes.
 *
 * Generated from the tree at the rule's introduction (46 sites across 40
 * keys); ordering is by path so a review diff shows exactly which file changed.
 * The security-audit volumes are NOT here: they converted at the rule's
 * introduction and are the shape new code should copy.
 */
export const SWITCH_TOTALITY_BASELINE: readonly string[] = Object.freeze([
  "engine/src/core/acceptance-contract/gate.ts::contract.freeze.state",
  "engine/src/core/acceptance-contract/gate.ts::failure.kind",
  "engine/src/core/acceptance-contract/stop-check.ts::outcome.kind",
  "engine/src/core/claude-transcript-integrity.ts::block.type",
  "engine/src/core/context-packet-projection.ts::selection.kind",
  "engine/src/core/context-packets.ts::violation.rule",
  "engine/src/core/emission-ingestion.ts::decision.kind",
  "engine/src/core/emission-ingestion.ts::decision.kind",
  "engine/src/core/emission-ingestion.ts::observation.kind",
  "engine/src/core/emission-ingestion.ts::observation.kind",
  "engine/src/core/emission-tool.ts::type",
  "engine/src/core/family-sites.ts::entry.kind",
  "engine/src/core/harness-tool-call.ts::tool",
  "engine/src/core/implementation-application.ts::failure.kind",
  "engine/src/core/implementation-application.ts::transition.kind",
  "engine/src/core/implementation-brief.ts::duty.kind",
  "engine/src/core/implementation-brief.ts::role.kind",
  "engine/src/core/implementation-completion.ts::failure.kind",
  "engine/src/core/implementation-retry.ts::disposition.kind",
  "engine/src/core/orchestration-contract/effects.ts::envelope.value.kind",
  "engine/src/core/orchestration-contract/effects.ts::envelope.value.kind",
  "engine/src/core/orchestration-contract/roster.ts::entry.kind",
  "engine/src/core/panel-program.ts::state.stage",
  "engine/src/core/panel-program.ts::state.stage",
  "engine/src/core/panel-verdict-source.ts::accepted.kind",
  "engine/src/core/persistent-panel.ts::envelope.type",
  "engine/src/core/persistent-panel.ts::event.type",
  "engine/src/core/persistent-panel.ts::state.stage",
  "engine/src/core/proof-obligations.ts::obligation.kind",
  "engine/src/core/proof-obligations.ts::raw.kind",
  "engine/src/core/proof-obligations.ts::raw.kind",
  "engine/src/core/proof-obligations.ts::result.obligation.kind",
  "engine/src/core/refutation-verifiers.ts::record.kind",
  "engine/src/core/remediation-machine.ts::state.state",
  "engine/src/core/remediation-machine.ts::state.state",
  "engine/src/core/rules-gate.ts::r.kind",
  "engine/src/core/runtime-baseline-restore.ts::refusal.kind",
  "engine/src/core/skeleton/problems.ts::problem.kind",
  "engine/src/core/standalone-review.ts::event.kind",
  "engine/src/core/standalone-review.ts::state.kind",
  "engine/src/core/task-attribution.ts::attribution",
  "engine/src/core/wave-gate-checks.ts::failure.kind",
  "engine/src/core/wave-gate-machine.ts::event.kind",
  "engine/src/core/wave-gate-machine.ts::state.kind",
  "engine/src/core/wave-gate-registration.ts::admitted.kind",
  "engine/src/machine/ledger.ts::read.kind",
] as const);
