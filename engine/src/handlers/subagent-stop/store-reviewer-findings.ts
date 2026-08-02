/**
 * Auto-store findings when review sub-agents complete — the Claude Code half.
 *
 * All parsing, reconciliation, and state transformation lives in
 * `core/review-output.ts`. This file is the imperative shell: read the
 * transcript, find the task, write, log. `pi/extension.ts` is the same shell
 * over the same core, which is what keeps the two harnesses from drifting.
 *
 * Every early return logs. A reviewer whose output is discarded silently is
 * indistinguishable from one that found nothing — the exact confusion the
 * `evidence_capture_failed` status exists to prevent.
 */

import type { HookHandler, SubagentStopInput } from "../../types";
import {
  applyReviewResolution,
  isReviewAgent,
  resolveReviewFindings,
  reviewResolutionLog,
} from "../../core/review-output";
import { StateManager } from "../../state-manager";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";

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

  const rawPath = input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*\d+/);
  if (!transcript) {
    warn(`empty transcript for ${agentType} (path=${rawPath || "<unset>"}) — findings NOT stored`);
    return { kind: "passthrough" };
  }

  const taskId = extractTaskId(transcript);
  if (!taskId) {
    warn(`${agentType} review completed without an extractable task ID — findings NOT stored`);
    return { kind: "passthrough" };
  }

  const resolution = resolveReviewFindings(transcript, agentType);

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? applyReviewResolution(t, resolution) : t)),
  }));

  process.stderr.write(reviewResolutionLog(taskId, resolution) + "\n");
  return { kind: "passthrough" };
};

export default handler;
