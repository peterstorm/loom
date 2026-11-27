/**
 * Validate that subagent-spawn prompts have no unfilled Loom template variables.
 *
 * Claude Code wrapper — delegates to core/. It judges the spawn request as the
 * parent wrote it. A brief marker is expanded only to prove it renders (a
 * marker that cannot render is refused, as by every sibling veto); the brief
 * itself is engine-rendered, so it is not re-judged for template variables.
 * The veto composition in `validate-task-execution` therefore hands this gate
 * the request, not the expanded brief (`spawn-vetoes.ts`).
 */

import { failClosedGuard } from "./pre-tool-use-input";
import {
  ENGINE_RENDERED_BRIEF,
  parentAssembled,
  validateTemplateSubstitution,
  type SpawnPrompt,
} from "../../core/validate-template-substitution";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { pathExistsFailClosed, taskGraphPath } from "../../config";
import type { RenderTaskBrief } from "../../core/implementation-brief";
import { blockResult, type HookHandler } from "../../types";
import { expandBriefMarker, renderActiveTaskBrief } from "./implementation-brief-marker";

const GATE = "validate-template-substitution";

export function createValidateTemplateSubstitutionHandler(render: RenderTaskBrief = renderActiveTaskBrief): HookHandler {
  // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
  // parse crash exits 1 (NON-blocking for PreToolUse), letting a Task with
  // unsubstituted template variables spawn.
  return failClosedGuard(GATE, (input) => {
    if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

    const judge = (prompt: SpawnPrompt) => validateTemplateSubstitution(prompt, pathExistsFailClosed(taskGraphPath()));
    const expansion = expandBriefMarker(input, render);
    switch (expansion.kind) {
      case "refused":
        return blockResult(`${GATE}: ${expansion.message}`);
      case "expanded":
        return judge(ENGINE_RENDERED_BRIEF);
      case "no-marker":
        return judge(parentAssembled((input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? ""));
      default: {
        const unreachable: never = expansion;
        return unreachable;
      }
    }
  });
}

export default createValidateTemplateSubstitutionHandler();
