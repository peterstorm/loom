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
