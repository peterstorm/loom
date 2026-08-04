/**
 * Auto-store findings when review sub-agents complete — the Claude Code half.
 *
 * All parsing, reconciliation, and state transformation lives in
 * `core/review-output.ts`. This file is the imperative shell: read the
 * transcript, find the task, write, log. `pi/extension.ts` is the same shell
 * over the same core, which is what keeps the two harnesses from drifting.
 *
 * Every early return that DISCARDS a reviewer's output logs. A reviewer whose
 * findings vanish silently is indistinguishable from one that found nothing —
 * the exact confusion the `evidence_capture_failed` status exists to prevent.
 * The one silent return is the `!isReviewAgent` passthrough, which discards
 * nothing: this handler fires on every SubagentStop, and a non-reviewer has no
 * findings for it to lose.
 */

import { readFileSync } from "node:fs";
import type { HookHandler, SubagentStopInput } from "../../types";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  hasStandaloneReviewContext,
  resolveReviewFindings,
  reviewResolutionLog,
} from "../../core/review-output";
import { isReviewAgent } from "../../config";
import { StateManager } from "../../state-manager";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import { parseFirstUserPrompt } from "../../parsers/parse-transcript";

const warn = (message: string): void => {
  process.stderr.write(`[loom] store-reviewer-findings: ${message}\n`);
};

const handler: HookHandler = async (stdin) => {
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return {
      kind: "error",
      message: `[loom] store-reviewer-findings: invalid JSON on stdin: ${(e as Error).message}`,
    };
  }

  const agentType = (input.agent_type ?? "").replace(/^[^:]+:/, "");
  if (!isReviewAgent(agentType)) {
    return { kind: "passthrough" };
  }

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) {
    warn(`no task graph for session ${input.session_id ?? "<unset>"} — ${agentType} findings NOT stored`);
    return { kind: "passthrough" };
  }

  // Resolved, not read off the payload: a harness that sends no
  // `agent_transcript_path` would otherwise lose every reviewer's findings —
  // the wave gate would then read a clean review that never happened. Read the
  // trusted first-user prompt BEFORE requiring reviewer output: it carries the
  // task binding even when the assistant transcript is empty or malformed.
  const rawPath = resolveAgentTranscriptPath(input) ?? input.agent_transcript_path ?? "";
  let trustedPrompt: string;
  try {
    const path = rawPath.replace(/^~/, process.env.HOME ?? "~");
    trustedPrompt = parseFirstUserPrompt(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = `cannot read trusted ${agentType} prompt (${error instanceof Error ? error.message : String(error)}) — review evidence cannot be attributed`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }
  if (hasStandaloneReviewContext(trustedPrompt)) {
    process.stderr.write(`[loom] store-reviewer-findings: ${agentType} belongs to a standalone review run — task state untouched\n`);
    return { kind: "passthrough" };
  }

  const taskId = extractTaskId(trustedPrompt);
  if (!taskId) {
    const message = `trusted ${agentType} prompt has no extractable task ID — review evidence cannot be attributed`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }

  // `tasks.map` over an id no task holds is a total no-op, and the log line
  // below asserts the findings were stored regardless. `extractTaskId` falls
  // back to any standalone `T\d+` in the transcript, so a reviewer quoting an
  // unrelated task id resolves to a task the graph does not have — and that
  // reviewer's criticals were discarded while stderr reported them recorded.
  // The sibling helper (helpers/store-review-findings.ts) guards exactly this;
  // the SubagentStop path did not.
  let targetTask: ReturnType<typeof mgr.load>["tasks"][number] | undefined;
  try {
    targetTask = mgr.load().tasks.find((t) => t.id === taskId);
  } catch (error) {
    // `mgr.update` below loads too, so an unloadable graph fails either way —
    // but it fails as an unhandled throw from inside the hook rather than as a
    // line naming the reviewer whose findings were lost.
    warn(`cannot load task graph for ${agentType} (${error instanceof Error ? error.message : String(error)}) — findings NOT stored`);
    return { kind: "passthrough" };
  }
  if (!targetTask) {
    warn(`${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored`);
    return { kind: "passthrough" };
  }

  const transcript = await readTranscriptWithRetry(rawPath, /\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*\d+/);
  const resolution = transcript
    ? constrainReviewResolutionToScope(
        resolveReviewFindings(transcript, agentType),
        [...(targetTask.file_list ?? []), ...(targetTask.files_modified ?? [])],
      )
    : {
        kind: "evidence-failed" as const,
        agent: agentType,
        message: `review transcript empty or unreadable at ${rawPath || "<unset>"}`,
      };

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? applyReviewResolution(t, resolution) : t)),
  }));

  process.stderr.write(reviewResolutionLog(taskId, resolution) + "\n");
  return { kind: "passthrough" };
};

export default handler;
