/**
 * Auto-store findings when review-invoker completes.
 * Parses Machine Summary block (primary) or legacy free-text (fallback).
 * Sets review_status per task.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, SubagentStopInput, TaskGraph, ReviewStatus } from "../../types";
import { StateManager } from "../../state-manager";
import { parseTranscript } from "../../parsers/parse-transcript";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";

interface ParsedFindings {
  critical: string[];
  advisory: string[];
  criticalCount: number | null;
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
    const critMatch = line.match(/^CRITICAL:\s*(.*)/);
    if (critMatch) {
      const text = critMatch[1].trim();
      if (text !== '') critical.push(text);
    }
    const advMatch = line.match(/^ADVISORY:\s*(.*)/);
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

  const critSection = output.match(/### Critical Findings[\s\S]*?(?=### )/);
  if (critSection) {
    for (const m of critSection[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)) {
      if (m[1] !== "None") critical.push(m[1]);
    }
  }

  const advSection = output.match(/### Advisory Findings[\s\S]*?(?=### )/);
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
  if (agentType !== "review-invoker") {
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

  // Determine review_status
  const reviewStatus: ReviewStatus = findings.criticalCount > 0 ? "blocked" : "passed";

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            review_status: reviewStatus,
            critical_findings: findings.critical,
            advisory_findings: findings.advisory,
          }
        : t
    ),
  }));

  process.stderr.write(`Task ${taskId} review: ${reviewStatus} (${findings.criticalCount} critical)\n`);
  return { kind: "passthrough" };
};

export default handler;
