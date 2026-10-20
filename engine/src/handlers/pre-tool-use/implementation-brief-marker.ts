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

import { triageBriefMarker, type RenderTaskBrief } from "../../core/implementation-brief";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { taskGraphPath } from "../../config";
import { renderTaskImplementationBrief } from "../../orchestration/implementation-brief";
import { blockResult, type HookHandler, type PreToolUseInput } from "../../types";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { stripNamespace } from "../../utils/strip-namespace";
import { parsePreToolUseInput } from "./pre-tool-use-input";

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

/** Expand `input`'s brief marker and its operator notes, if its prompt is one. Pure over `render`. */
export function expandBriefMarker(input: PreToolUseInput, render: RenderTaskBrief): BriefMarkerExpansion {
  const prompt = input.tool_input.prompt;
  if (typeof prompt !== "string") return NO_MARKER;
  const triage = triageBriefMarker(prompt, render);
  switch (triage.kind) {
    case "none":
      return NO_MARKER;
    case "malformed":
      return refused(`BLOCKED: the implementation brief marker is malformed: ${triage.reason}`);
    case "unrenderable":
      return refused(`BLOCKED: the implementation brief marker for ${triage.taskId} cannot expand: ${triage.error}`);
    case "expanded":
      break;
  }
  const { brief, request } = triage;
  const requested = input.tool_input.subagent_type;
  const agent = typeof requested === "string" ? stripNamespace(requested) : "";
  if (agent !== brief.agent) {
    return refused(`BLOCKED: the brief marker spawns ${JSON.stringify(requested ?? null)} but ${request.taskId} is assigned to ${brief.agent}`);
  }
  const toolInput = Object.freeze({ ...input.tool_input, prompt: brief.prompt });
  return Object.freeze({ kind: "expanded", toolInput, stdin: JSON.stringify({ ...input, tool_input: toolInput }) });
}

/** The production renderer: the active TaskGraph and this Loom package's rules. */
export const renderActiveTaskBrief: RenderTaskBrief = (request) =>
  renderTaskImplementationBrief(taskGraphPath(), LOOM_PACKAGE_ROOT, request);

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
