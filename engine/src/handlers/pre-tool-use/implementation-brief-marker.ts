/**
 * Claude Code expansion of implementation brief markers (G4 pilot F5).
 *
 * An orchestrator dispatches an owed implementation by spawning the Task's
 * agent with the one-line prompt `LOOM_IMPLEMENTATION_BRIEF: T5`, exactly as on
 * Pi, so the roughly 51 KB engine-rendered brief never passes through the
 * parent model's tool call or its context. Claude Code has no extension seam,
 * but a PreToolUse hook can replace the call's input (`updatedInput`; probed on
 * 2.1.286: the subagent receives the replacement, the parent transcript keeps
 * the marker).
 *
 * Hooks on one matcher run in parallel on the ORIGINAL input. So:
 * - `validate-task-execution` expands the marker, runs every spawn veto and
 *   the reservation on the expanded bytes, and is the one hook that rewrites
 *   the call;
 * - every sibling spawn veto expands the marker itself
 *   (`withBriefMarkerExpanded`), so it judges the brief rather than the marker,
 *   and refuses a marker it cannot expand. A test drives every `SPAWN_VETOES`
 *   entry, so a new veto that forgets the wrap fails the suite.
 *
 * Every refusal blocks: a marker that cannot render, or whose spawn names
 * another agent than the Task's, never reaches the child as a bare marker.
 */

import type { ImplementationBrief } from "../../core/implementation-brief";
import { parseImplementationBriefMarker } from "../../core/implementation-brief";
import type { DomainResult } from "../../core/orchestration-contract";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { taskGraphPath } from "../../config";
import { renderTaskImplementationBrief } from "../../orchestration/implementation-brief";
import { blockResult, type HookHandler, type PreToolUseInput } from "../../types";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { stripNamespace } from "../../utils/strip-namespace";
import { parsePreToolUseInput } from "./pre-tool-use-input";

/** Port: render one Task's brief against the governing TaskGraph. */
export type RenderTaskBrief = (taskId: string) => DomainResult<ImplementationBrief, string>;

/** What a spawn's prompt asks for: nothing, its expanded brief, or a refusal. */
export type BriefMarkerExpansion =
  | Readonly<{ kind: "no-marker" }>
  | Readonly<{
      kind: "expanded";
      /** The call's input with `prompt` replaced by the rendered brief. */
      toolInput: Readonly<Record<string, unknown>>;
      /** The hook payload the gates judge: the original with `toolInput`. */
      stdin: string;
    }>
  | Readonly<{ kind: "refused"; message: string }>;

const NO_MARKER: BriefMarkerExpansion = Object.freeze({ kind: "no-marker" });

const refused = (message: string): BriefMarkerExpansion => Object.freeze({ kind: "refused", message });

/** Expand `input`'s brief marker, if its prompt is exactly one. Pure over `render`. */
export function expandBriefMarker(input: PreToolUseInput, render: RenderTaskBrief): BriefMarkerExpansion {
  const prompt = input.tool_input.prompt;
  const taskId = typeof prompt === "string" ? parseImplementationBriefMarker(prompt) : null;
  if (taskId === null) return NO_MARKER;
  const rendered = render(taskId);
  if (!rendered.ok) {
    return refused(`BLOCKED: the implementation brief marker for ${taskId} cannot expand: ${rendered.error}`);
  }
  const requested = input.tool_input.subagent_type;
  const agent = typeof requested === "string" ? stripNamespace(requested) : "";
  if (agent !== rendered.value.agent) {
    return refused(`BLOCKED: the brief marker spawns ${JSON.stringify(requested ?? null)} but ${taskId} is assigned to ${rendered.value.agent}`);
  }
  const toolInput = Object.freeze({ ...input.tool_input, prompt: rendered.value.prompt });
  return Object.freeze({ kind: "expanded", toolInput, stdin: JSON.stringify({ ...input, tool_input: toolInput }) });
}

/** The production renderer: the active TaskGraph and this Loom package's rules. */
export const renderActiveTaskBrief: RenderTaskBrief = (taskId) =>
  renderTaskImplementationBrief(taskGraphPath(), LOOM_PACKAGE_ROOT, taskId);

/**
 * `handler` judging the expanded brief instead of a marker. A payload that is
 * not a spawn, or not parseable, reaches `handler` unchanged, which keeps its
 * own fail-closed parse.
 */
export function withBriefMarkerExpanded(
  gate: string,
  handler: HookHandler,
  render: RenderTaskBrief = renderActiveTaskBrief,
): HookHandler {
  return async (stdin, args) => {
    const input = parsePreToolUseInput(stdin);
    if (input instanceof Error || !SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return handler(stdin, args);
    const expansion = expandBriefMarker(input, render);
    switch (expansion.kind) {
      case "no-marker":
        return handler(stdin, args);
      case "refused":
        return blockResult(`${gate}: ${expansion.message}`);
      case "expanded":
        return handler(expansion.stdin, args);
    }
  };
}
