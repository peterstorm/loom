/**
 * Validate wave order, dependencies, and review gates before task execution.
 *
 * Claude Code wrapper — delegates to core/. It is the one spawn gate that
 * writes state (the execution reservation), so it first runs every read-only
 * spawn veto and reserves only when all of them admit the spawn.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validateTaskExecution } from "../task-execution";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { firstSpawnVeto, SPAWN_VETOES, type SpawnVetoEntry } from "./spawn-vetoes";

export function createValidateTaskExecutionHandler(vetoes: readonly SpawnVetoEntry[] = SPAWN_VETOES): HookHandler {
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

    const veto = await firstSpawnVeto(stdin, vetoes);
    if (veto !== null) return veto;

    return validateTaskExecution({
      agentType: (input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string) ?? "",
      prompt: (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "",
      description: (input.tool_input?.description as string) ?? "",
    });
  };
}

export default createValidateTaskExecutionHandler();
