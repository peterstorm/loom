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
  readonly critical: readonly string[];
  readonly advisory: readonly string[];
  readonly criticalCount: number | null;
}

/** Smart constructor: filter empty strings and freeze arrays. */
export function makeParsedFindings(input: {
  critical?: readonly string[];
  advisory?: readonly string[];
  criticalCount?: number | null;
}): ParsedFindings {
  const filter = (xs: readonly string[] | undefined): readonly string[] =>
    Object.freeze((xs ?? []).filter((s) => s.trim() !== ""));
  return Object.freeze({
    critical: filter(input.critical),
    advisory: filter(input.advisory),
    criticalCount: input.criticalCount ?? null,
  });
}

export const EMPTY_FINDINGS: ParsedFindings = makeParsedFindings({});

/** Pure: Check if an agent type is a recognized review agent */
export function isReviewAgent(agentType: string): boolean {
  return REVIEW_SUB_AGENTS.has(agentType);
}

/** Pure: Build evidence_capture_failed error message, surfacing partial findings if any. */
export function buildEvidenceFailureMessage(findings: ParsedFindings): string {
  const partial = findings.critical.length + findings.advisory.length;
  return partial > 0
    ? `CRITICAL_COUNT marker not found — partial findings extracted (${findings.critical.length} critical, ${findings.advisory.length} advisory)`
    : "CRITICAL_COUNT marker not found in agent output";
}

/** Pure: Reconcile a count > 0 but empty-criticals findings into a self-describing entry,
 *  so a broken parse cannot pass the wave gate silently. */
export function reconcileFindings(findings: ParsedFindings): ParsedFindings {
  if (findings.criticalCount !== null && findings.criticalCount > 0 && findings.critical.length === 0) {
    return makeParsedFindings({
      ...findings,
      critical: [`Review output parsing failed - ${findings.criticalCount} findings not captured`],
    });
  }
  return findings;
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

/** Extract CRITICAL/ADVISORY lines and CRITICAL_COUNT from a text block.
 *  Strips code fences and handles bold/starred markers. */
function extractFindings(block: string): ParsedFindings {
  const cleaned = block.replace(/^\`\`\`\w*$/gm, "");

  const critical: string[] = [];
  const advisory: string[] = [];

  for (const line of cleaned.split("\n")) {
    const critMatch = line.match(/^[\s\-*]*\*{0,2}CRITICAL(?!_COUNT):?\*{0,2}\s*(.*)/);
    if (critMatch) critical.push(critMatch[1].trim());
    const advMatch = line.match(/^[\s\-*]*\*{0,2}ADVISORY(?!_COUNT):?\*{0,2}\s*(.*)/);
    if (advMatch) advisory.push(advMatch[1].trim());
  }

  const countMatch = cleaned.match(/^\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*(\d+)/m);
  const criticalCount = countMatch ? Number(countMatch[1]) : null;

  return makeParsedFindings({ critical, advisory, criticalCount });
}

/** Parse Machine Summary block for structured findings.
 *  Matches heading variants: ## / ### / #### (with optional bold), MACHINE_SUMMARY, etc.
 *  Uses the LAST match to skip skill-template echoes that precede real output. */
export function parseMachineSummary(output: string): ParsedFindings | null {
  // Match various heading formats agents produce
  const headingPattern = /^(?:#{2,4}\s*\*{0,2}Machine Summary\*{0,2}|MACHINE[_ ]SUMMARY)/gim;

  // Find the last match (agents often echo the template before their real summary)
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(output)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;

  let block = output.slice(lastMatch.index);
  // Trim at next heading of same or higher level (if any)
  const nextHeading = block.match(/\n#{2,4}\s+[^#]/);
  if (nextHeading && nextHeading.index! > 0) block = block.slice(0, nextHeading.index!);

  return extractFindings(block);
}

/** Legacy fallback: section-headed Critical/Advisory blocks first;
 *  fall back to whole-output line scan if no sections matched. */
export function parseLegacyFindings(output: string): ParsedFindings {
  const critical: string[] = [];
  const advisory: string[] = [];

  const critSection = output.match(/###?\s*Critical(?:\s+Findings)?[\s\S]*?(?=###? |$)/);
  if (critSection) {
    for (const m of critSection[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)) {
      if (m[1] !== "None") critical.push(m[1]);
    }
  }

  const advSection = output.match(/###?\s*Advisory(?:\s+Findings)?[\s\S]*?(?=###? |$)/);
  if (advSection) {
    for (const m of advSection[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)) {
      if (m[1] !== "None") advisory.push(m[1]);
    }
  }

  if (critical.length === 0 && advisory.length === 0) {
    return extractFindings(output);
  }

  const countMatch = output.match(/\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*(\d+)/);
  const criticalCount = countMatch ? Number(countMatch[1]) : null;

  return makeParsedFindings({ critical, advisory, criticalCount });
}

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
    return { kind: "passthrough" };
  }

  const rawPath = input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /\*{0,2}CRITICAL_COUNT:?\*{0,2}\s*\d+/);
  if (!transcript) {
    process.stderr.write(`[loom] store-reviewer-findings: empty transcript for ${agentType} (path=${rawPath || "<unset>"})\n`);
    return { kind: "passthrough" };
  }

  const taskId = extractTaskId(transcript);
  if (!taskId) {
    return { kind: "passthrough" };
  }

  const findings = parseMachineSummary(transcript) ?? parseLegacyFindings(transcript);

  if (findings.criticalCount === null) {
    const errorMsg = buildEvidenceFailureMessage(findings);
    process.stderr.write(`WARNING: ${errorMsg} for ${taskId} — marking evidence_capture_failed\n`);
    await mgr.update((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, review_status: "evidence_capture_failed" as ReviewStatus, review_error: errorMsg }
          : t
      ),
    }));
    return { kind: "passthrough" };
  }

  const reconciled = reconcileFindings(findings);

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => t.id === taskId ? mergeFindings(t, reconciled) : t),
  }));

  const status: ReviewStatus = reconciled.criticalCount! > 0 ? "blocked" : "passed";
  process.stderr.write(`Task ${taskId} review: ${status} (${reconciled.criticalCount} critical)\n`);
  return { kind: "passthrough" };
};

export default handler;
