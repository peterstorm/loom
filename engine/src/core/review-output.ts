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
 * claim, and any marker claim it does not NAME is carried over beside it.** A
 * short block is a truncated or mislabeled emission, and its locations are not
 * worth the claims it would discard; a block that is long enough but names
 * different claims is the same loss wearing a passing count. Whatever wins,
 * `reconcileFindings` backstops the remaining shortfall against
 * `CRITICAL_COUNT` with a self-describing entry, so a parse that lost findings
 * blocks the gate instead of reading green.
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
import { FINDING_SEVERITIES, type FindingSeverity, type ReviewStatus, type Task } from "../types";
import {
  claimsOfSeverity,
  draftsFromClaims,
  hasFindingsBlock,
  mergeFindings,
  parseFindingsBlock,
  removeOnce,
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
  /** The block parsed and named every claim the markers made. It is the source. */
  | "used"
  /** A block was present but malformed. The marker lines were parsed instead. */
  | "rejected"
  /** The block parsed but under-reported findings. The marker lines won. */
  | "superseded"
  /**
   * The block was long enough to win but did not NAME every marker claim. It
   * is the source, with the unnamed marker claims carried over beside it —
   * so the block's file/line survives and no claim is lost.
   */
  | "partial";

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
  /**
   * The reviewer's own advisory tally, or null when it emitted none.
   *
   * Parsed for the same reason `criticalCount` is. `ADVISORY_COUNT` is required
   * by every reviewer agent contract and was read by nothing, so a reviewer that
   * declared four advisories whose `ADVISORY:` lines failed to scrape — wrapped,
   * re-indented, reformatted — recorded zero with nothing reporting the
   * shortfall, and `/wave-gate` Step 4b (a MUST-level constraint) had nothing to
   * triage. Unlike `criticalCount`, a missing value is NOT an evidence failure:
   * the contract has always made `CRITICAL_COUNT` the one marker whose absence
   * means "the parse failed".
   */
  readonly advisoryCount: number | null;
  readonly blockStatus: FindingsBlockStatus;
  /** How many marker claims the winning block did not name and were carried over
   *  beside it. Non-zero only for `partial`; reported so the operator can see the
   *  duplication that arbitration deliberately prefers over a lost finding. */
  readonly carriedOver: number;
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
  advisoryCount?: number | null;
  blockStatus?: FindingsBlockStatus;
  carriedOver?: number;
}): ParsedFindings {
  const drafts = input.drafts ?? draftsFromClaims(input.critical ?? [], input.advisory ?? []);
  return Object.freeze({
    drafts: Object.freeze([...drafts]),
    critical: Object.freeze([...claimsOfSeverity(drafts, "critical")]),
    advisory: Object.freeze([...claimsOfSeverity(drafts, "advisory")]),
    criticalCount: input.criticalCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    blockStatus: input.blockStatus ?? "absent",
    carriedOver: input.carriedOver ?? 0,
  });
}

export const EMPTY_FINDINGS: ParsedFindings = makeParsedFindings({});

/** Pure: Build evidence_capture_failed error message, surfacing partial findings if any. */
export function buildEvidenceFailureMessage(findings: ParsedFindings): string {
  const partial = findings.critical.length + findings.advisory.length;
  return partial > 0
    ? `CRITICAL_COUNT marker not found — partial findings extracted (${findings.critical.length} critical, ${findings.advisory.length} advisory)`
    : "CRITICAL_COUNT marker not found in agent output";
}

/** The self-describing claim a broken parse leaves behind. */
function parseFailureClaim(severity: FindingSeverity, missing: number, total: number): string {
  return missing === total
    ? `Review output parsing failed - ${total} ${severity} findings not captured`
    : `Review output parsing failed - ${missing} of ${total} ${severity} findings not captured`;
}

/**
 * Pure: reconcile a declared count the captured claims fall short of into a
 * self-describing entry, so a broken parse cannot pass the wave gate silently.
 *
 * The shortfall case, not just the total-loss case: the count is the reviewer's
 * own tally and the contract names it the authority, so capturing 1 of 3 is the
 * same class of failure as capturing 0 of 3 — and strictly more dangerous,
 * because the survivor makes the gate look like it saw everything.
 *
 * BOTH severities. `ADVISORY_COUNT` is mandated by every reviewer agent file and
 * used to be parsed by nothing, so advisory marker lines that failed to scrape
 * vanished with no backstop — the mirror image of the critical loss this
 * function was written for, on the severity `/wave-gate` Step 4b must triage
 * item by item. The synthetic entry keeps its own severity, so a lost advisory
 * does not fabricate a blocker.
 */
export function reconcileFindings(findings: ParsedFindings): ParsedFindings {
  const shortfalls = FINDING_SEVERITIES.flatMap((severity) => {
    const count = severity === "critical" ? findings.criticalCount : findings.advisoryCount;
    const captured = severity === "critical" ? findings.critical : findings.advisory;
    if (count === null || count <= 0 || captured.length >= count) return [];
    // An authored claim, not agent output — a plain literal rather than
    // makeDraftFinding, whose sentinel/empty filter exists to reject UNTRUSTED
    // text and must never be able to silently drop this reconciliation.
    const synthetic: DraftFinding = {
      severity,
      file: null,
      line: null,
      claim: parseFailureClaim(severity, count - captured.length, count),
    };
    return [synthetic];
  });

  return shortfalls.length === 0
    ? findings
    : makeParsedFindings({
        drafts: [...shortfalls, ...findings.drafts],
        criticalCount: findings.criticalCount,
        advisoryCount: findings.advisoryCount,
        blockStatus: findings.blockStatus,
        carriedOver: findings.carriedOver,
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

  return makeParsedFindings({
    critical,
    advisory,
    criticalCount: declaredCount(cleaned, "CRITICAL"),
    advisoryCount: declaredCount(cleaned, "ADVISORY"),
  });
}

/** The `<SEVERITY>_COUNT` marker a reviewer declared, or null when absent.
 *  Tolerates the same list-marker and bold decoration the claim scraper does. */
function declaredCount(text: string, severity: "CRITICAL" | "ADVISORY"): number | null {
  const match = text.match(
    new RegExp(String.raw`^[ \t\-*]*\*{0,2}${severity}_COUNT:?\*{0,2}\s*(\d+)`, "m"),
  );
  return match ? Number(match[1]) : null;
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
 * let a criticals-only block win outright and delete every `ADVISORY:` marker
 * line, while `blockStatus` still reported `used` so no degradation note was
 * printed. `/wave-gate` Step 4b must triage every advisory to
 * fixed/deferred/dismissed; it cannot triage what it never sees. (Every agent
 * file in `REVIEW_SUB_AGENTS` requires the block to account for advisories too
 * — `tests/review-agent-contract.test.ts` proves that claim rather than
 * asserting it — but the arbitration must hold for output that does not honour
 * its prompt, which is the only output worth arbitrating.)
 *
 * Counting is necessary and NOT sufficient. Arbitration stays cardinal on
 * purpose — demanding that the block reproduce marker text verbatim would
 * reject every reworded block and permanently cost the file/line the block
 * exists to carry — so a block that names two claims can clear a bar of two
 * while naming neither of the reviewer's actual claims. That is the one path
 * here that DESTROYED a finding rather than degrading it: the count matched, so
 * `reconcileFindings` stayed quiet; `blockStatus` said `used`, so no note was
 * printed; and the views were internally consistent, so the lockstep check
 * passed. The winner is therefore reconciled by VALUE as well: any marker claim
 * the block does not name is carried over beside it as a location-less draft,
 * and the operator is told through `partial`. Nothing is lost, and nothing the
 * reviewer did not say is invented.
 *
 * `CRITICAL_COUNT` always comes from the markers: the count is the reviewer's
 * own tally and is what distinguishes "zero findings" from "the parse failed".
 */
function chooseSource(scraped: ParsedFindings, block: string): ParsedFindings {
  const counts = { criticalCount: scraped.criticalCount, advisoryCount: scraped.advisoryCount };
  const structured = parseFindingsBlock(block);
  if (structured === null) {
    return makeParsedFindings({
      drafts: scraped.drafts,
      ...counts,
      blockStatus: hasFindingsBlock(block) ? "rejected" : "absent",
    });
  }
  const fromBlock = makeParsedFindings({ drafts: structured, ...counts, blockStatus: "used" });
  const claimedCritical = Math.max(scraped.criticalCount ?? 0, scraped.critical.length);
  const accountsForAll =
    fromBlock.critical.length >= claimedCritical &&
    fromBlock.advisory.length >= scraped.advisory.length;

  // Multiset, not set: two reviewers can legitimately word a claim identically,
  // and a block naming it once when the markers named it twice has dropped one.
  // Both sides are `collapseWhitespace`-normalized (every claim reaching either
  // view is built by makeDraftFinding), so comparison by value is exact.
  const unnamedByBlock = draftsFromClaims(
    removeOnce(scraped.critical, fromBlock.critical),
    removeOnce(scraped.advisory, fromBlock.advisory),
  );

  if (!accountsForAll) {
    // The block LOST, and losing must not mean being deleted. Returning the
    // scraped drafts alone threw away every claim the block named that the
    // marker lines did not — and a reviewer that emits `CRITICAL_COUNT` plus a
    // block but no `CRITICAL:` lines has an empty scraped set, so the whole
    // finding text vanished and `reconcileFindings` replaced real, located
    // claims with a synthetic "N findings not captured" no verifier can
    // adjudicate. The union is the same rule the winning side already applies,
    // in the other direction: the markers lead (they set the count the block
    // failed to meet), and the block's unnamed entries follow with their
    // file/line intact.
    // Consumed multiset-wise, like `removeOnce`: a block naming a claim twice
    // against markers naming it once contributes exactly one carry-over.
    const unclaimed = new Map(
      FINDING_SEVERITIES.map((severity) => [
        severity,
        [...(severity === "critical" ? scraped.critical : scraped.advisory)],
      ]),
    );
    const recovered = structured.filter((draft) => {
      const pool = unclaimed.get(draft.severity)!;
      const at = pool.indexOf(draft.claim);
      if (at < 0) return true;
      pool.splice(at, 1);
      return false;
    });
    return makeParsedFindings({
      drafts: [...scraped.drafts, ...recovered],
      ...counts,
      blockStatus: "superseded",
      carriedOver: recovered.length,
    });
  }

  return unnamedByBlock.length === 0
    ? fromBlock
    : makeParsedFindings({
        // The block's entries first, so its file/line-bearing findings keep
        // their order; the recovered marker claims follow, location-less.
        drafts: [...structured, ...unnamedByBlock],
        ...counts,
        blockStatus: "partial",
        carriedOver: unnamedByBlock.length,
      });
}

/**
 * Legacy fallback: section-headed Critical/Advisory blocks first; fall back to
 * whole-output line scan if no sections matched.
 *
 * Arbitrated through `chooseSource` exactly like the Machine Summary path. It
 * used to return the scraped claims directly, so a reviewer that emitted a
 * perfectly good ```findings block under a heading `parseMachineSummary` does
 * not match (`**Machine Summary**`, bold with no hashes) had its file/line
 * silently discarded AND was reported as `blockStatus: "absent"` — the one value
 * documented to mean "the reviewer emitted no block", so `blockStatusNote`
 * printed nothing about a real degradation.
 */
export function parseLegacyFindings(output: string): ParsedFindings {
  return chooseSource(scrapeLegacyFindings(output), output);
}

function scrapeLegacyFindings(output: string): ParsedFindings {
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

  return makeParsedFindings({
    critical,
    advisory,
    criticalCount: declaredCount(output, "CRITICAL"),
    advisoryCount: declaredCount(output, "ADVISORY"),
  });
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
      // Named, not just counted. The status is per-task and the failure is
      // per-agent, so recording WHICH reviewer could not be parsed is what lets
      // `mergeFindings` keep the block alive across a sibling's clean pass and
      // still clear it when that reviewer itself re-runs successfully.
      review_evidence_failures: [
        ...(task.review_evidence_failures ?? []).filter((failed) => failed !== r.agent),
        r.agent,
      ],
    }))
    .with({ kind: "findings" }, (r): Task => mergeFindings(task, r.findings, r.agent))
    .exhaustive();
}

/**
 * The operator-facing note a degraded structured block earns. Empty when the
 * block was used or never offered — only a LOSS is worth a line of output.
 *
 * `carriedOver` is reported because arbitration deliberately prefers a
 * DUPLICATED finding to a lost one: a block that rewords the marker claims
 * clears the cardinal bar and then names none of them, so every marker claim
 * comes across beside it and the same defect is adjudicated twice. That is the
 * right trade — the alternative, capping the carry-over, deletes real claims
 * whenever the block names different ones — but it costs a verifier vote per
 * duplicate, and an operator who cannot see the count cannot tell an inflated
 * finding set from a genuinely large one.
 */
function blockStatusNote(status: FindingsBlockStatus, carriedOver: number): string {
  const carried = `${carriedOver} claim(s) carried over`;
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
        ` [findings block under-reported findings — used marker lines, ${carried} from the block; ` +
        `the rest carry no file/line]`,
    )
    .with(
      "partial",
      () =>
        ` [findings block did not name every marker claim — ${carried} without file/line, ` +
        `so a reworded claim is adjudicated twice]`,
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
        blockStatusNote(r.findings.blockStatus, r.findings.carriedOver)
      );
    })
    .exhaustive();
}
