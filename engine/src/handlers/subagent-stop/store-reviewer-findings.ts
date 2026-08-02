/**
 * Auto-store findings when review sub-agents complete.
 *
 * Parses the structured findings block (primary), the Machine Summary line
 * markers (fallback), or legacy free-text sections (last resort). Merges
 * findings from multiple agents per task, never demoting review_status.
 *
 * `resolveReviewFindings` + `applyReviewResolution` are the SINGLE path from a
 * review transcript to a task update. Claude Code reaches them through this
 * hook's SubagentStop handler; Pi reaches them through `pi/extension.ts`'s
 * subagent-result interception. The two harnesses used to re-run the same
 * parse → reconcile → merge sequence independently, which is how the review
 * findings on one harness could drift from the other's. There is now one
 * decision function and one state transform; the harnesses supply only the
 * transcript, the task id, and the write.
 */

import { match } from "ts-pattern";
import type { HookHandler, SubagentStopInput, Task, ReviewStatus } from "../../types";
import { REVIEW_SUB_AGENTS } from "../../config";
import {
  attributeFindings,
  claimsOfSeverity,
  draftsFromClaims,
  nextOrdinal,
  parseFindingsBlock,
  type DraftFinding,
} from "../../core/findings";
import { StateManager } from "../../state-manager";
import { extractTaskId } from "../../utils/extract-task-id";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";

/**
 * One reviewer's output, parsed. `drafts` is authoritative; `critical` and
 * `advisory` are DERIVED views over it, materialized here so the ~10 existing
 * consumers of the two `string[]` task fields keep working unchanged.
 */
export interface ParsedFindings {
  readonly drafts: readonly DraftFinding[];
  readonly critical: readonly string[];
  readonly advisory: readonly string[];
  readonly criticalCount: number | null;
}

/**
 * Smart constructor. Accepts either the authoritative drafts (structured
 * block) or the legacy severity-grouped claim strings, and always derives the
 * two views from the drafts — so the views cannot disagree with the record
 * they summarize, whichever input built it.
 */
export function makeParsedFindings(input: {
  critical?: readonly string[];
  advisory?: readonly string[];
  drafts?: readonly DraftFinding[];
  criticalCount?: number | null;
}): ParsedFindings {
  const drafts = input.drafts ?? draftsFromClaims(input.critical ?? [], input.advisory ?? []);
  return Object.freeze({
    drafts: Object.freeze([...drafts]),
    critical: Object.freeze([...claimsOfSeverity(drafts, "critical")]),
    advisory: Object.freeze([...claimsOfSeverity(drafts, "advisory")]),
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

/** The self-describing claim a broken parse leaves behind. */
const parseFailureClaim = (count: number): string =>
  `Review output parsing failed - ${count} findings not captured`;

/** Pure: Reconcile a count > 0 but empty-criticals findings into a self-describing entry,
 *  so a broken parse cannot pass the wave gate silently. */
export function reconcileFindings(findings: ParsedFindings): ParsedFindings {
  if (findings.criticalCount === null || findings.criticalCount <= 0 || findings.critical.length > 0) {
    return findings;
  }
  // An authored claim, not agent output — a plain literal rather than
  // makeDraftFinding, whose sentinel/empty filter exists to reject UNTRUSTED
  // text and must never be able to silently drop this reconciliation.
  const synthetic: DraftFinding = {
    severity: "critical",
    file: null,
    line: null,
    claim: parseFailureClaim(findings.criticalCount),
  };
  // `critical` is empty on this branch, so every existing draft is advisory —
  // they are carried through with their locations intact.
  return makeParsedFindings({
    drafts: [synthetic, ...findings.drafts],
    criticalCount: findings.criticalCount,
  });
}

/** Pure: Merge new findings into a task, accumulating rather than overwriting.
 *  Never demotes review_status from "blocked" to "passed".
 *
 *  `findings` (structured, identified) and the two `string[]` fields (derived
 *  views) are appended in lockstep, so every claim added through this function
 *  appears in exactly one place in each. Ids continue past `agent`'s existing
 *  ordinals, which is what keeps a re-review of a blocked task from minting a
 *  duplicate id (see nextOrdinal). */
export function mergeFindings(task: Task, findings: ParsedFindings, agent: string): Task {
  const newStatus: ReviewStatus = (findings.criticalCount ?? 0) > 0 ? "blocked" : "passed";
  const reviewStatus: ReviewStatus = task.review_status === "blocked" ? "blocked" : newStatus;

  const existing = task.findings ?? [];
  const attributed = attributeFindings(findings.drafts, agent, nextOrdinal(existing, agent));

  return {
    ...task,
    review_status: reviewStatus,
    findings: [...existing, ...attributed],
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
 *  Uses the LAST match to skip skill-template echoes that precede real output.
 *
 *  The fenced ```findings JSON block wins when present — it carries file/line
 *  the line scraper cannot recover. `CRITICAL_COUNT` still comes from the
 *  markers either way: the count is the reviewer's own tally and is what
 *  distinguishes "zero findings" from "the parse failed". */
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

  const scraped = extractFindings(block);
  const structured = parseFindingsBlock(block);
  return structured === null
    ? scraped
    : makeParsedFindings({ drafts: structured, criticalCount: scraped.criticalCount });
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

// ---------------------------------------------------------------------------
// The one path both harnesses take
// ---------------------------------------------------------------------------

/**
 * What a review transcript resolves to. Closed union: a reviewer either failed
 * to emit its evidence marker (the wave must not silently pass) or produced a
 * reconciled finding set. There is no third state, and no "maybe" shape a
 * caller could forget to handle.
 */
export type ReviewResolution =
  | { readonly kind: "evidence-failed"; readonly agent: string; readonly message: string }
  | { readonly kind: "findings"; readonly agent: string; readonly findings: ParsedFindings };

/** Pure: parse → reconcile, in one place, for every harness. */
export function resolveReviewFindings(transcript: string, agent: string): ReviewResolution {
  const findings = parseMachineSummary(transcript) ?? parseLegacyFindings(transcript);
  return findings.criticalCount === null
    ? { kind: "evidence-failed", agent, message: buildEvidenceFailureMessage(findings) }
    : { kind: "findings", agent, findings: reconcileFindings(findings) };
}

/** Pure: the complete task transform a resolution implies. */
export function applyReviewResolution(task: Task, resolution: ReviewResolution): Task {
  return match(resolution)
    .with({ kind: "evidence-failed" }, (r): Task => ({
      ...task,
      review_status: "evidence_capture_failed" as ReviewStatus,
      review_error: r.message,
    }))
    .with({ kind: "findings" }, (r): Task => mergeFindings(task, r.findings, r.agent))
    .exhaustive();
}

/** Pure: the operator-facing line a harness writes to stderr for a resolution. */
export function reviewResolutionLog(taskId: string, resolution: ReviewResolution): string {
  return match(resolution)
    .with(
      { kind: "evidence-failed" },
      (r) => `WARNING: ${r.message} for ${taskId} — marking evidence_capture_failed`,
    )
    .with({ kind: "findings" }, (r) => {
      const count = r.findings.criticalCount ?? 0;
      return `Task ${taskId} review: ${count > 0 ? "blocked" : "passed"} (${count} critical)`;
    })
    .exhaustive();
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

  const resolution = resolveReviewFindings(transcript, agentType);

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? applyReviewResolution(t, resolution) : t)),
  }));

  process.stderr.write(reviewResolutionLog(taskId, resolution) + "\n");
  return { kind: "passthrough" };
};

export default handler;
