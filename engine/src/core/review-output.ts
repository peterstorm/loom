/**
 * Reviewer transcript → findings. The pure half of storing a review.
 *
 * A reviewer emits three overlapping descriptions of what it found: a
 * `CRITICAL_COUNT` marker (its own tally), `CRITICAL:` / `ADVISORY:` marker
 * lines (the claims as text), and — optionally — a fenced ```findings block
 * (the same claims with file/line). They can disagree, and which one wins
 * decides whether a critical reaches the wave gate at all.
 *
 * The rule, in one sentence: **the block wins only when it accounts for every
 * finding — of either severity — that the reviewer's own count and marker lines
 * claim.** A short block is a truncated or mislabeled emission, and its
 * locations are not worth the claims it would discard. Whatever wins, `reconcileFindings` backstops the
 * remaining shortfall against `CRITICAL_COUNT` with a self-describing entry, so
 * a parse that lost findings blocks the gate instead of reading green.
 *
 * `resolveReviewFindings` + `applyReviewResolution` are the SINGLE path from a
 * review transcript to a task update. Claude Code reaches them through the
 * `store-reviewer-findings` SubagentStop handler; Pi reaches them through
 * `pi/extension.ts`'s subagent-result interception. The two harnesses used to
 * re-run the same parse → reconcile → merge sequence independently, which is how
 * the review findings on one harness could drift from the other's. There is now
 * one decision function and one state transform; the harnesses supply only the
 * transcript, the task id, and the write.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import type { ReviewStatus, Task } from "../types";
import { REVIEW_SUB_AGENTS } from "../config";
import {
  claimsOfSeverity,
  draftsFromClaims,
  hasFindingsBlock,
  mergeFindings,
  parseFindingsBlock,
  type DraftFinding,
} from "./findings";

/**
 * What became of the optional structured block. Reported to the operator,
 * because every value but `used` means the findings carry no file/line and
 * verification quality is degraded — a difference that was previously invisible.
 */
export type FindingsBlockStatus =
  /** The reviewer emitted no block. The marker lines are the whole contract. */
  | "absent"
  /** The block parsed and accounted for every critical. It is the source. */
  | "used"
  /** A block was present but malformed. The marker lines were parsed instead. */
  | "rejected"
  /** The block parsed but under-reported findings. The marker lines won. */
  | "superseded";

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
  readonly blockStatus: FindingsBlockStatus;
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
  blockStatus?: FindingsBlockStatus;
}): ParsedFindings {
  const drafts = input.drafts ?? draftsFromClaims(input.critical ?? [], input.advisory ?? []);
  return Object.freeze({
    drafts: Object.freeze([...drafts]),
    critical: Object.freeze([...claimsOfSeverity(drafts, "critical")]),
    advisory: Object.freeze([...claimsOfSeverity(drafts, "advisory")]),
    criticalCount: input.criticalCount ?? null,
    blockStatus: input.blockStatus ?? "absent",
  });
}

export const EMPTY_FINDINGS: ParsedFindings = makeParsedFindings({});

/** Pure: is this agent type one whose output carries review findings? */
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
function parseFailureClaim(missing: number, total: number): string {
  return missing === total
    ? `Review output parsing failed - ${total} findings not captured`
    : `Review output parsing failed - ${missing} of ${total} critical findings not captured`;
}

/**
 * Pure: reconcile a `CRITICAL_COUNT` the captured criticals fall short of into a
 * self-describing entry, so a broken parse cannot pass the wave gate silently.
 *
 * The shortfall case, not just the total-loss case: `CRITICAL_COUNT` is the
 * reviewer's own tally and the contract names it the authority, so capturing 1
 * of 3 is the same class of failure as capturing 0 of 3 — and strictly more
 * dangerous, because the survivor makes the gate look like it saw everything.
 */
export function reconcileFindings(findings: ParsedFindings): ParsedFindings {
  const count = findings.criticalCount;
  if (count === null || count <= 0 || findings.critical.length >= count) {
    return findings;
  }
  // An authored claim, not agent output — a plain literal rather than
  // makeDraftFinding, whose sentinel/empty filter exists to reject UNTRUSTED
  // text and must never be able to silently drop this reconciliation.
  const synthetic: DraftFinding = {
    severity: "critical",
    file: null,
    line: null,
    claim: parseFailureClaim(count - findings.critical.length, count),
  };
  return makeParsedFindings({
    drafts: [synthetic, ...findings.drafts],
    criticalCount: count,
    blockStatus: findings.blockStatus,
  });
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

  return chooseSource(extractFindings(block), block);
}

/**
 * Decide between the structured block and the scraped marker lines.
 *
 * The block carries file/line the scraper cannot recover, so it is preferred —
 * but only when it accounts for at least as many findings OF EACH SEVERITY as
 * the marker lines do (and, for criticals, as the reviewer's own
 * `CRITICAL_COUNT`). Below that bar the block is discarding claims the reviewer
 * demonstrably made, and no amount of location metadata is worth a lost finding.
 *
 * The advisory half of that bar is not decoration. Gating on criticals alone
 * let a criticals-only block — a plausible emission, since the reviewer prompt
 * scopes its mandatory block accounting to criticals — win outright and delete
 * every `ADVISORY:` marker line, while `blockStatus` still reported `used` so
 * no degradation note was printed. `/wave-gate` Step 4b must triage every
 * advisory to fixed/deferred/dismissed; it cannot triage what it never sees.
 *
 * `CRITICAL_COUNT` always comes from the markers: the count is the reviewer's
 * own tally and is what distinguishes "zero findings" from "the parse failed".
 */
function chooseSource(scraped: ParsedFindings, block: string): ParsedFindings {
  const structured = parseFindingsBlock(block);
  if (structured === null) {
    return makeParsedFindings({
      drafts: scraped.drafts,
      criticalCount: scraped.criticalCount,
      blockStatus: hasFindingsBlock(block) ? "rejected" : "absent",
    });
  }
  const fromBlock = makeParsedFindings({
    drafts: structured,
    criticalCount: scraped.criticalCount,
    blockStatus: "used",
  });
  const claimedCritical = Math.max(scraped.criticalCount ?? 0, scraped.critical.length);
  const accountsForAll =
    fromBlock.critical.length >= claimedCritical &&
    fromBlock.advisory.length >= scraped.advisory.length;
  return accountsForAll
    ? fromBlock
    : makeParsedFindings({
        drafts: scraped.drafts,
        criticalCount: scraped.criticalCount,
        blockStatus: "superseded",
      });
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

/** The operator-facing note a degraded structured block earns. Empty when the
 *  block was used or never offered — only a LOSS is worth a line of output. */
function blockStatusNote(status: FindingsBlockStatus): string {
  return match(status)
    .with("absent", () => "")
    .with("used", () => "")
    .with(
      "rejected",
      () => " [findings block was malformed — fell back to marker lines, findings carry no file/line]",
    )
    .with(
      "superseded",
      () =>
        " [findings block under-reported findings — used marker lines instead, findings carry no file/line]",
    )
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
      // The larger of the reviewer's tally and what was actually captured —
      // the same disjunction `mergeFindings` blocks on. Reporting the tally
      // alone logged "passed (0 critical)" for a task the very next line
      // recorded as blocked with a real critical in it.
      const count = Math.max(r.findings.criticalCount ?? 0, r.findings.critical.length);
      return (
        `Task ${taskId} review: ${count > 0 ? "blocked" : "passed"} (${count} critical)` +
        blockStatusNote(r.findings.blockStatus)
      );
    })
    .exhaustive();
}
