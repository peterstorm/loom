/**
 * Auto-store findings when review sub-agents complete — the Claude Code half.
 *
 * All parsing, reconciliation, and state transformation lives in
 * `core/review-output.ts`. This file is the imperative shell: read the
 * transcript, find the task, write, log. `pi/extension.ts` is the same shell
 * over the same core, which is what keeps the two harnesses from drifting.
 *
 * Every early return that DISCARDS a reviewer's output logs and fails the hook.
 * A reviewer whose findings vanish behind exit 0 is indistinguishable from one
 * that found nothing — the exact confusion `evidence_capture_failed` prevents.
 * The one silent return is the `!isReviewAgent` passthrough, which discards
 * nothing: this handler fires on every SubagentStop, and a non-reviewer has no
 * findings for it to lose.
 */

import { readFileSync } from "node:fs";
import type { HookHandler, HookResult, Task, TaskGraph } from "../../types";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  hasStandaloneReviewContext,
  resolveTaskReviewFindings,
  reviewResolutionLog,
  type ReviewResolution,
} from "../../core/review-output";
import { isReviewAgent } from "../../config";
import { StateManager } from "../../state-manager";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { parseFirstUserPrompt } from "../../parsers/parse-transcript";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { stripNamespace } from "../../utils/strip-namespace";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";

/** A reviewer's output was discarded: report it and fail the evidence command. */
const discarded = (message: string): HookResult => {
  const diagnostic = `[loom] store-reviewer-findings: ${message}`;
  process.stderr.write(`${diagnostic}\n`);
  return { kind: "error", message: diagnostic };
};

/**
 * The same line for the paths that then FAIL the hook. `error` exits non-zero
 * and its message is surfaced by the CLI, but these handlers are also called
 * directly (pi, tests), where stderr is the only channel either way.
 */
const warn = (message: string): void => {
  process.stderr.write(`[loom] store-reviewer-findings: ${message}\n`);
};

const handler: HookHandler = async (stdin) => {
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    return {
      kind: "error",
      message: `[loom] store-reviewer-findings: invalid SubagentStop input — findings NOT stored: ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;

  const agentType = stripNamespace(resolveAgentType(input));
  if (agentType === "") {
    return {
      kind: "error",
      message: "[loom] store-reviewer-findings: SubagentStop Agent identity is unavailable — findings NOT stored",
    };
  }
  if (!isReviewAgent(agentType)) {
    return { kind: "passthrough" };
  }

  let mgr: StateManager | null;
  try {
    mgr = StateManager.fromSession(input.session_id);
  } catch (error) {
    const message = `no task graph for session ${input.session_id ?? "<unset>"}: ` +
      `${error instanceof Error ? error.message : String(error)} — ${agentType} findings NOT stored`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }
  if (!mgr) {
    const message = `no task graph for session ${input.session_id ?? "<unset>"} — ${agentType} findings NOT stored`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
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
    const parsedPrompt = parseFirstUserPrompt(readFileSync(path, "utf-8"));
    if (!parsedPrompt.ok) throw new Error(parsedPrompt.error);
    trustedPrompt = parsedPrompt.prompt;
  } catch (error) {
    const message = `cannot read trusted ${agentType} prompt (${error instanceof Error ? error.message : String(error)}) — review evidence cannot be attributed`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }
  if (hasStandaloneReviewContext(trustedPrompt)) {
    return passthroughDiagnostic(`[loom] store-reviewer-findings: ${agentType} belongs to a standalone review run — task state untouched\n`);
  }

  const taskId = extractTaskId(trustedPrompt);
  if (!taskId) {
    const message = `trusted ${agentType} prompt has no extractable task ID — review evidence cannot be attributed`;
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }

  // Guard: reject findings for task IDs not present in the graph.
  // `extractTaskId` falls back to any standalone `T\d+` in the transcript,
  // so a reviewer quoting an unrelated task id resolves to one the graph
  // does not have — this lookup rejects that case explicitly rather than
  // silently discarding the findings via a no-op map.
  let targetTask: ReturnType<typeof mgr.load>["tasks"][number] | undefined;
  try {
    targetTask = mgr.load().tasks.find((t) => t.id === taskId);
  } catch (error) {
    const message = (
      `cannot load task graph for ${agentType} ` +
      `(${error instanceof Error ? error.message : String(error)}) — findings NOT stored`
    );
    warn(message);
    return { kind: "error", message: `[loom] store-reviewer-findings: ${message}` };
  }
  if (!targetTask) {
    return discarded(`${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored`);
  }

  const transcript = await readTranscriptWithRetry(rawPath, /\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*\d+/);
  let resolution: ReviewResolution = {
    kind: "evidence-failed",
    agent: agentType,
    message: `review transcript empty or unreadable at ${rawPath || "<unset>"}`,
  };
  let appliedTask: Task = targetTask;
  let applicationChanged = false;
  let taskFound = false;
  await mgr.update((s): TaskGraph => ({
    ...s,
    tasks: s.tasks.map((t) => {
      if (t.id !== taskId) return t;
      taskFound = true;
      resolution = transcript
        ? constrainReviewResolutionToScope(
            resolveTaskReviewFindings(
              transcript,
              agentType,
              t.review_run,
              t.review_generation,
            ),
            [...(t.file_list ?? []), ...(t.files_modified ?? [])],
          )
        : resolution;
      appliedTask = applyReviewResolution(t, resolution);
      applicationChanged = appliedTask !== t;
      return appliedTask;
    }),
  }));

  if (!taskFound) {
    return discarded(`${agentType} review task ${taskId} disappeared before evidence application — findings NOT stored`);
  }
  return passthroughDiagnostic(reviewResolutionLog(taskId, resolution, appliedTask, applicationChanged) + "\n");
};

export default handler;
