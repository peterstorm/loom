/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 *
 * Claude Code wrapper — delegates to core/.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, PreToolUseInput, TaskGraph } from "../../types";
import {
  validatePhaseOrder,
  type ArtifactProbe,
  type PhaseOrderDeps,
} from "../../core/validate-phase-order";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { pathExistsFailClosed, taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { findFile } from "../../utils/find-file";
import { stripNamespace } from "../../utils/strip-namespace";

/**
 * The real phase-artifact reads. Artifact absence only ever ADDS a block
 * reason, so a false "missing" here cannot open the gate — plain `existsSync`
 * is the correct probe for this direction, unlike the protected-state read
 * below.
 */
export const realArtifactProbe: ArtifactProbe = {
  exists: existsSync,
  readText: (path: string): string => readFileSync(path, "utf-8"),
  findFile,
};

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
 * guard-state-file) stayed armed on the same file. `StateManager.fromPath` is
 * deliberately bypassed for the same reason: its own bare `existsSync` would
 * re-introduce the fail-open one call down. A present-but-unreadable graph now
 * raises out of `load()`, and `pre-tool-use/validate-phase-order` is a
 * FAIL_CLOSED_ROUTE, so the crash exits 2 (block).
 */
export const realPhaseOrderDeps: PhaseOrderDeps = {
  loadState: (): TaskGraph | null => {
    const statePath = taskGraphPath();
    if (!pathExistsFailClosed(statePath)) return null;
    return new StateManager(statePath).load();
  },
  artifacts: realArtifactProbe,
};

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a spawn-gate route: fail CLOSED. Returning
    // allow here would exit 0 and let a Task spawn out of phase order.
    return {
      kind: "block",
      message: `validate-phase-order: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  return validatePhaseOrder({
    agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string) ?? ""),
    prompt: (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "",
  }, realPhaseOrderDeps);
};

export default handler;

// Re-export for tests that import from handler path
export { detectPhase, checkArtifacts, isPanelAgent, canRunPanelAgent } from "../../core/validate-phase-order";
export type { ArtifactProbe, ArtifactState } from "../../core/validate-phase-order";
