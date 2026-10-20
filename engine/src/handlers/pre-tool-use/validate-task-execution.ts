/**
 * Validate wave order, dependencies, and review gates before task execution.
 *
 * Claude Code wrapper — delegates to core/. It is the one spawn gate that
 * writes state (the execution reservation), so it first runs every read-only
 * spawn veto and reserves only when all of them admit the spawn.
 *
 * It is also the one hook that expands an implementation brief marker
 * (`implementation-brief-marker.ts`): the vetoes and the reservation judge the
 * rendered brief, and the admitted call is rewritten to carry it, so the child
 * receives exactly the bytes every gate judged.
 */

import { preToolUseRewriteResult, type HookHandler, type HookResult, type PreToolUseInput } from "../../types";
import { validateTaskExecution } from "../task-execution";
import { claudeAgentTypeRefusal } from "../../core/model-profiles";
import { CLAUDE_SPAWN_TOOLS, SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { firstSpawnVeto, SPAWN_VETOES, type SpawnVetoEntry } from "./spawn-vetoes";
import type { RenderTaskBrief } from "../../core/implementation-brief";
import { expandBriefMarker, renderActiveTaskBrief } from "./implementation-brief-marker";

/** An admitted marker spawn proceeds with the brief as its prompt; every other result stands. */
function rewrittenToBrief(result: HookResult, toolInput: Readonly<Record<string, unknown>>): HookResult {
  return result.kind === "allow" || result.kind === "passthrough"
    ? preToolUseRewriteResult(toolInput, result.systemMessage)
    : result;
}

export function createValidateTaskExecutionHandler(
  vetoes: readonly SpawnVetoEntry[] = SPAWN_VETOES,
  render: RenderTaskBrief = renderActiveTaskBrief,
): HookHandler {
  return async (stdin) => {
    let input: PreToolUseInput;
    try {
      input = JSON.parse(stdin);
    } catch (e) {
      // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
      // parse crash exits 1 (NON-blocking for PreToolUse), waving the Task
      // spawn past wave-order/dependency/review-gate enforcement.
      return {
        kind: "block",
        message: `validate-task-execution: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };
    // Before anything reserves: Claude Code rejects a Loom Agent named other
    // than `loom:<agent>` only after admission, which would strand the reservation.
    const unresolvable = CLAUDE_SPAWN_TOOLS.has(input.tool_name) ? claudeAgentTypeRefusal(input.tool_input.subagent_type) : null;
    if (unresolvable !== null) return { kind: "block", message: `validate-task-execution: BLOCKED: ${unresolvable}` };

    const expansion = expandBriefMarker(input, render);
    if (expansion.kind === "refused") return { kind: "block", message: `validate-task-execution: ${expansion.message}` };
    const expanded = expansion.kind === "expanded" ? expansion : null;
    const toolInput = expanded?.toolInput ?? input.tool_input;

    const veto = await firstSpawnVeto(expanded?.stdin ?? stdin, vetoes);
    if (veto !== null) return veto;

    const result = await validateTaskExecution({
      agentType: (toolInput.subagent_type as string) ?? (toolInput.agent as string) ?? "",
      prompt: (toolInput.prompt as string) ?? (toolInput.task as string) ?? "",
      description: (toolInput.description as string) ?? "",
    });
    return expanded === null ? result : rewrittenToBrief(result, expanded.toolInput);
  };
}

export default createValidateTaskExecutionHandler();
