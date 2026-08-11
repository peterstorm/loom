/**
 * Measured benchmark fixtures.
 *
 * These are the ACTUAL command sequences the two approaches emit, transcribed
 * from the runbooks rather than estimated. The plan is explicit that Agent
 * prose is never measurement evidence, so the counters are derived from these
 * strings at test time instead of being written down as numbers someone could
 * update without re-measuring.
 *
 * SCOPE: this measures the deterministic *status and observability* path — the
 * one the orchestration façade replaced in T10. It is not a full five-scenario
 * lifecycle replay; the remaining scenarios need the start/spawn side, which
 * still runs through the legacy helpers. Reporting it as more than it is would
 * make the threshold meaningless.
 */

/** Every deterministic parent call the legacy runbooks documented for status. */
export const LEGACY_STATUS_COMMANDS: readonly string[] = Object.freeze([
  `jq '.' .claude/state/active_task_graph.json`,
  `jq '.tasks[] | {id, status, test_result, review_status}' .claude/state/active_task_graph.json`,
  `jq '.wave_gates' .claude/state/active_task_graph.json`,
  `jq -r '.current_wave' .claude/state/active_task_graph.json`,
  `jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | .id' .claude/state/active_task_graph.json`,
  `jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | select(.review_status == "pending" or .review_status == "blocked" or .review_status == "evidence_capture_failed") | .id' .claude/state/active_task_graph.json`,
  `jq -r '[.current_wave as $w | .tasks[] | select(.wave == $w) | (.critical_findings // []) | length] | add // 0' .claude/state/active_task_graph.json`,
  `jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | select((.advisory_findings // []) | length > 0) | {id, advisory_findings}' .claude/state/active_task_graph.json`,
]);

/** What the façade replaced them with. */
export const FACADE_STATUS_COMMANDS: readonly string[] = Object.freeze([
  `bun engine/src/cli.ts helper orchestration status --json`,
]);

/** Thresholds the plan mandates. */
export const REQUIRED_CALL_REDUCTION = 0.70;
export const REQUIRED_CHARACTER_REDUCTION = 0.80;

export const characterCount = (commands: readonly string[]): number =>
  commands.reduce((total, command) => total + command.length, 0);

export const reduction = (before: number, after: number): number =>
  before === 0 ? 0 : 1 - after / before;
