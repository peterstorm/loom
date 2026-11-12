/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { TaskGraph } from "../../types";
import { failClosedGuard } from "./pre-tool-use-input";
import {
  validatePhaseOrder,
  type PhaseOrderDeps,
} from "../../core/validate-phase-order";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { pathExistsFailClosed, taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { realArtifactProbe } from "../../orchestration/artifact-probe";
import { stripNamespace } from "../../utils/strip-namespace";
import { withBriefMarkerExpanded } from "./implementation-brief-marker";

/**
 * The real protected-state read. It lives HERE rather than in the gate core
 * because `StateManager` is the sole writer of the task graph: keeping the
 * import in the shell means the gate cannot, even accidentally, write the
 * state it exists to judge.
 *
 * ENOENT is the ONLY absent answer. Bare `existsSync` returns `false` for ANY
 * error — EACCES, ELOOP, ENOTDIR, EIO all read as "no graph" — and `null` here
 * means "no active plan", which `validatePhaseOrder` answers with `allow`. An
 * unreadable task graph would therefore have disarmed this spawn gate while
 * its siblings (block-direct-edits, validate-template-substitution,
 * guard-state-file) stayed armed on the same file. `StateManager.fromPath`
 * now uses the same fail-closed probe; this shell keeps the probe explicit so
 * the gate's sole absent answer is visible here without performing that probe
 * twice. A present-but-unreadable graph raises out of `load()`, and
 * `pre-tool-use/validate-phase-order` is a FAIL_CLOSED_ROUTE, so the crash
 * exits 2 (block).
 */
export const realPhaseOrderDeps: PhaseOrderDeps = {
  loadState: (): TaskGraph | null => {
    const statePath = taskGraphPath();
    if (!pathExistsFailClosed(statePath)) return null;
    return new StateManager(statePath).load();
  },
  artifacts: realArtifactProbe,
};

// Malformed hook input on a spawn-gate route: fail CLOSED. Returning
// allow here would exit 0 and let a Task spawn out of phase order.
const handler = failClosedGuard("validate-phase-order", (input) => {
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  return validatePhaseOrder({
    agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string) ?? ""),
    prompt: (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "",
  }, realPhaseOrderDeps);
});

// A brief marker is judged as the brief it expands to.
export default withBriefMarkerExpanded("validate-phase-order", handler);

// Re-export for tests that import from handler path
export { detectPhase, checkArtifacts, isPanelAgent, canRunPanelAgent } from "../../core/validate-phase-order";
export type { ArtifactProbe, ArtifactState } from "../../core/validate-phase-order";
