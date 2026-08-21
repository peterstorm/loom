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
    "cleanup-subagent-flag", "capture-orchestration-result",
  ]),
  "post-tool-use": new Set(["lint-file", "record-evidence", "record-orchestration-spawn"]),
  "subagent-start": new Set(["mark-subagent-active"]),
  "session-start": new Set(["cleanup-stale-subagents", "resume-after-clear"]),
  "helper": new Set([
    "complete-wave-gate", "populate-task-graph", "validate-task-graph", "repair-task-graph",
    "store-review-findings", "store-spec-check", "mark-tests-passed",
    "suggest-spec-anchors", "extract-task-id", "store-test-evidence",
    "reconcile-implementation-proof", "set-phase", "cleanup-state", "lint-wave-gate", "validate-lint-rules",
    "panel-contract", "review-panel", "model-profiles", "review-packet",
    "model-calibration", "panel-program", "standalone-review", "orchestration",
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
  // validate-agent-model / validate-agent-skill are enforcing Task-spawn gates
  // too (they return block): a crash escaping the handler must exit 2
  // (blocking) or a Task spawns with the wrong model / a missing skill.
  "pre-tool-use/validate-agent-model",
  "pre-tool-use/validate-agent-skill",
]);

/**
 * CLI routes that can mutate protected TaskGraph, lifecycle, evidence, or Run
 * Directory state. A Pi-launched fresh process must prove it matches the
 * extension runtime before importing or executing one of these routes.
 *
 * Package-maintenance routes such as model-profiles/render-pi are deliberately
 * absent: operators must be able to regenerate Agents before `/reload`.
 */
export const PI_RUNTIME_HANDSHAKE_ROUTES: ReadonlySet<string> = new Set([
  "pre-tool-use/validate-task-execution",
  "subagent-stop/dispatch",
  "subagent-stop/advance-phase",
  "subagent-stop/update-task-status",
  "subagent-stop/store-reviewer-findings",
  "subagent-stop/store-spec-check-findings",
  "subagent-stop/cleanup-subagent-flag",
  "subagent-stop/capture-orchestration-result",
  "post-tool-use/record-evidence",
  "post-tool-use/record-orchestration-spawn",
  "subagent-start/mark-subagent-active",
  "session-start/cleanup-stale-subagents",
  "helper/complete-wave-gate",
  "helper/populate-task-graph",
  "helper/repair-task-graph",
  "helper/store-review-findings",
  "helper/store-spec-check",
  "helper/mark-tests-passed",
  "helper/store-test-evidence",
  "helper/reconcile-implementation-proof",
  "helper/set-phase",
  "helper/cleanup-state",
  "helper/review-packet",
  "helper/review-panel",
  "helper/standalone-review",
  "helper/orchestration",
]);

/**
 * The orchestration reads that stay available during runtime skew.
 *
 * Both are pure projections that mutate nothing, and both are what an operator
 * needs precisely WHILE recovering from skew: `status` answers "where is the
 * graph", `inspect` answers "what state is this run in, and is it recoverable".
 * Gating them would make the handshake failure undiagnosable from inside the
 * session that hit it. Every other orchestration operation — `abandon`
 * included, since its marker is durable and terminal — stays behind the
 * handshake.
 */
const SKEW_SAFE_ORCHESTRATION_READS: ReadonlySet<string> = new Set(["status", "inspect"]);

export function piRuntimeHandshakeRequired(
  hookType: string | undefined,
  handlerName: string | undefined,
  extraArgs: readonly string[] = [],
): boolean {
  if (hookType === "init-state") return true;
  if (!PI_RUNTIME_HANDSHAKE_ROUTES.has(`${hookType}/${handlerName}`)) return false;
  return !(hookType === "helper" && handlerName === "orchestration" &&
    extraArgs[0] !== undefined && SKEW_SAFE_ORCHESTRATION_READS.has(extraArgs[0]));
}

/** Exit code for a crash outside the handler, derived from the route. */
export function failureExitCode(hookType: string | undefined, handlerName: string | undefined): 1 | 2 {
  return FAIL_CLOSED_ROUTES.has(`${hookType}/${handlerName}`) ? 2 : 1;
}
