/**
 * Auto-store findings when review sub-agents complete.
 * Parses Machine Summary block (primary) or legacy free-text (fallback).
 * Merges findings from multiple agents per task, never demoting review_status.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, SubagentStopInput, TaskGraph, Task, ReviewStatus } from "../../types";
import { REVIEW_SUB_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { parseTranscript } from "../../parsers/parse-transcript";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";

export interface ParsedFindings {
  critical: string[];
  advisory: string[];
  criticalCount: number | null;
}

/** Pure: Check if an agent type is a recognized review agent */
export function isReviewAgent(agentType: string): boolean {
  return REVIEW_SUB_AGENTS.has(agentType);
}

/** Pure: Merge new findings into a task, accumulating rather than overwriting.
 *  Never demotes review_status from "blocked" to "passed". */
export function mergeFindings(task: Task, findings: ParsedFindings): Task {
  const newStatus: ReviewStatus = (findings.criticalCount ?? 0) > 0 ? "blocked" : "passed";
  const reviewStatus: ReviewStatus = task.review_status === "blocked" ? "blocked" : newStatus;

  return {
    ...task,
    review_status: reviewStatus,
    critical_findings: [...(task.critical_findings ?? []), ...findings.critical],
    advisory_findings: [...(task.advisory_findings ?? []), ...findings.advisory],
  };
}

/** Parse Machine Summary block for structured findings */
export function parseMachineSummary(output: string): ParsedFindings | null {
  const idx = output.lastIndexOf("### Machine Summary");
  if (idx === -1) return null;

  let block = output.slice(idx);
  // Trim at next ### heading (if any)
  const nextHeading = block.indexOf("\n###", 1);
  if (nextHeading >= 0) block = block.slice(0, nextHeading);

  const critical: string[] = [];
  const advisory: string[] = [];

  for (const line of block.split("\n")) {
    const critMatch = line.match(/^[\s\-*]*\*{0,2}CRITICAL:?\*{0,2}\s*(.*)/);
    if (critMatch) {
      const text = critMatch[1].trim();
      if (text !== '') critical.push(text);
    }
    const advMatch = line.match(/^[\s\-*]*\*{0,2}ADVISORY:?\*{0,2}\s*(.*)/);
    if (advMatch) {
      const text = advMatch[1].trim();
      if (text !== '') advisory.push(text);
    }
  }

  const countMatch = block.match(/^CRITICAL_COUNT:\s*(\d+)/m);
  const criticalCount = countMatch ? Number(countMatch[1]) : null;

  return { critical, advisory, criticalCount };
}

/** Legacy fallback: parse free-text sections */
export function parseLegacyFindings(output: string): ParsedFindings {
  const critical: string[] = [];
  const advisory: string[] = [];

  const critSection = output.match(/### Critical Findings[\s\S]*?(?=### |$)/);
  if (critSection) {
    for (const m of critSection[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)) {
      if (m[1] !== "None") critical.push(m[1]);
    }
  }

  const advSection = output.match(/### Advisory Findings[\s\S]*?(?=### |$)/);
  if (advSection) {
    for (const m of advSection[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)) {
      if (m[1] !== "None") advisory.push(m[1]);
    }
  }

  const countMatch = output.match(/CRITICAL_COUNT:\s*(\d+)/);
  const criticalCount = countMatch ? Number(countMatch[1]) : null;

  return { critical, advisory, criticalCount };
}

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);

  const agentType = (input.agent_type ?? "").replace(/^[^:]+:/, "");
  if (!isReviewAgent(agentType)) {
    return { kind: "passthrough" };
  }

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) {
    return { kind: "passthrough" };
  }

  const rawPath = input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /CRITICAL_COUNT:\s*\d+/);
  if (!transcript) {
    return { kind: "passthrough" };
  }

  const taskId = extractTaskId(transcript);
  if (!taskId) {
    return { kind: "passthrough" };
  }

  // Try structured, then legacy
  const findings = parseMachineSummary(transcript) ?? parseLegacyFindings(transcript);

  // Safety: no CRITICAL_COUNT → evidence_capture_failed
  if (findings.criticalCount === null) {
    process.stderr.write(`WARNING: No CRITICAL_COUNT for ${taskId} — marking evidence_capture_failed\n`);
    await mgr.update((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, review_status: "evidence_capture_failed" as ReviewStatus,
              review_error: "CRITICAL_COUNT marker not found in agent output" }
          : t
      ),
    }));
    return { kind: "passthrough" };
  }

  // Safety: criticalCount > 0 but no findings parsed → synthesize error
  if (findings.criticalCount > 0 && findings.critical.length === 0) {
    findings.critical.push(`Review output parsing failed - ${findings.criticalCount} findings not captured`);
  }

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => t.id === taskId ? mergeFindings(t, findings) : t),
  }));

  const status: ReviewStatus = findings.criticalCount > 0 ? "blocked" : "passed";
  process.stderr.write(`Task ${taskId} review: ${status} (${findings.criticalCount} critical)\n`);
  return { kind: "passthrough" };
};

export default handler;
