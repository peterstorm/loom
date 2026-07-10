/**
 * Known handler routes — the single routing table cli.ts validates against
 * before dynamic import. Extracted from cli.ts so it can be imported by
 * tests (importing cli.ts would run main()): hooks-sync pins that every
 * `cli.ts <hook-type> <handler>` route the hooks/scripts shims invoke is a
 * subset of this table.
 */
export const KNOWN_HANDLERS: Readonly<Record<string, ReadonlySet<string>>> = {
  "pre-tool-use": new Set([
    "block-direct-edits", "guard-state-file", "validate-phase-order",
    "validate-task-execution", "validate-template-substitution",
    "validate-agent-model", "validate-agent-skill", "enforce-phase-tools",
  ]),
  "subagent-stop": new Set([
    "dispatch", "advance-phase", "update-task-status",
    "store-reviewer-findings", "store-spec-check-findings",
    "cleanup-subagent-flag",
  ]),
  "post-tool-use": new Set(["lint-file", "record-evidence"]),
  "subagent-start": new Set(["mark-subagent-active"]),
  "session-start": new Set(["cleanup-stale-subagents", "resume-after-clear"]),
  "helper": new Set([
    "complete-wave-gate", "populate-task-graph", "validate-task-graph",
    "store-review-findings", "store-spec-check", "mark-tests-passed",
    "suggest-spec-anchors", "extract-task-id", "store-test-evidence",
    "set-phase", "cleanup-state", "lint-wave-gate", "validate-lint-rules",
  ]),
};

/**
 * Routes whose top-level crash must BLOCK (exit 2). Exit 1 is NON-blocking
 * for PreToolUse hooks, so a crash outside the handler (dynamic-import
 * failure, stdin error) on a gate route would fail the gate OPEN. Modeled
 * as route metadata next to the routing table — the polarity decision lives
 * with the routes, not as a string comparison buried in cli.ts.
 */
export const FAIL_CLOSED_ROUTES: ReadonlySet<string> = new Set([
  "pre-tool-use/enforce-phase-tools",
  "pre-tool-use/guard-state-file",
  "pre-tool-use/block-direct-edits",
  // Task-spawn gates: a crash outside the handler (corrupt task graph on
  // mgr.load(), stdin error) would exit 1 — NON-blocking — and let a Task
  // spawn skip wave-order, dependency, review-gate, phase-order, and
  // template-substitution enforcement. These gate orchestration, so they
  // block on crash like the state-file guards.
  "pre-tool-use/validate-task-execution",
  "pre-tool-use/validate-phase-order",
  "pre-tool-use/validate-template-substitution",
]);

/** Exit code for a crash outside the handler, derived from the route. */
export function failureExitCode(hookType: string | undefined, handlerName: string | undefined): 1 | 2 {
  return FAIL_CLOSED_ROUTES.has(`${hookType}/${handlerName}`) ? 2 : 1;
}
