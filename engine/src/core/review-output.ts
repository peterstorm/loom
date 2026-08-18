/**
 * Reviewer transcript → findings. The pure half of storing a review.
 *
 * A reviewer emits three overlapping descriptions of what it found: a
 * `CRITICAL_COUNT` marker (its own tally), `CRITICAL:` / `ADVISORY:` marker
 * lines (the claims as text), and — optionally — a fenced ```findings block
 * (the same claims with file/line). They can disagree; arbitration chooses
 * the primary location-bearing representation, while unmatched claims from
 * the other source are preserved and critical-count shortfalls fail closed.
 *
 * The rule, in one sentence: **marker lines settle the severity of claims they
 * name, then the block wins only when it accounts for at least as many findings
 * of each severity as the marker lines name — and, for criticals only, as the
 * reviewer's own `CRITICAL_COUNT` — and any marker claim it does not NAME is
 * carried over beside it.** The asymmetry is deliberate and
 * `chooseSource` states why: `advisoryCount` is not part of the bar, because an
 * advisory shortfall against a self-reported tally degrades triage while a
 * critical shortfall opens a gate. A
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
import {
  FINDING_SEVERITIES,
  PRIOR_FINDING_VERDICTS,
  type FindingSeverity,
  type PriorFindingAssessment,
  type ReviewRun,
  type ReviewStatus,
  type Task,
} from "../types";
import {
  claimsOfSeverity,
  draftsFromClaims,
  hasFindingsBlock,
  mergeFindings,
  parseFindingsBlock,
  recordReviewRunEvidence,
  type DraftFinding,
} from "./findings";
import { parseReviewPath } from "./review-packet";

/** Marker placed in standalone reviewer prompts so harness lifecycle hooks know
 * the transcript belongs to a run artifact, not to an orchestration Task. */
export const STANDALONE_REVIEW_CONTEXT_MARKER = "LOOM_REVIEW_CONTEXT: standalone";

export function hasStandaloneReviewContext(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === STANDALONE_REVIEW_CONTEXT_MARKER);
}

/**
 * What became of the optional structured block. Reported to the operator,
 * because every arm but `used` means the findings carry no file/line and
 * verification quality is degraded — a difference that was previously invisible.
 *
 * A discriminated union, not a string beside an independent `carriedOver`
 * count. The count is meaningful for exactly the two arms that carry claims
 * across, and the flat pair made `{ blockStatus: "absent", carriedOver: 5 }`
 * representable — a state whose own doc comment ("non-zero only for `partial`")
 * was already contradicted by the `superseded` arm that sets it. Attaching the
 * number to the arms that own it removes both the illegal state and the
 * question of which comment to believe.
 */
export type FindingsBlockStatus =
  /** The reviewer emitted no block. The marker lines are the whole contract. */
  | { readonly kind: "absent" }
  /** The block parsed and named every claim the markers made. It is the source. */
  | { readonly kind: "used" }
  /** A block was present but malformed. The marker lines were parsed instead. */
  | { readonly kind: "rejected" }
  /** The block parsed but under-reported findings. The marker lines won, and the
   *  block's unnamed entries came across beside them with file/line intact. */
  | { readonly kind: "superseded"; readonly carriedOver: number }
  /**
   * The block was long enough to win but did not NAME every marker claim. It
   * is the source, with the unnamed marker claims carried over beside it —
   * so the block's file/line survives and no claim is lost.
   */
  | { readonly kind: "partial"; readonly carriedOver: number };

/** How many claims an arbitration carried across. Zero for the arms that carry
 *  none, which is now a fact about the union rather than a convention. */
export function carriedOverCount(status: FindingsBlockStatus): number {
  return status.kind === "superseded" || status.kind === "partial" ? status.carriedOver : 0;
}

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
   * triage. Both count markers are mandatory evidence: omitting either means the
   * transcript may be truncated and must fail closed.
   */
  readonly advisoryCount: number | null;
  /** What became of the block, and — on the two arms that carry claims across —
   *  how many. Reported so the operator can see the duplication that arbitration
   *  deliberately prefers over a lost finding. */
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
  advisoryCount?: number | null;
  blockStatus?: FindingsBlockStatus;
}): ParsedFindings {
  const drafts = input.drafts ?? draftsFromClaims(input.critical ?? [], input.advisory ?? []);
  const parsed: ParsedFindings = {
    drafts: Object.freeze([...drafts]),
    critical: Object.freeze([...claimsOfSeverity(drafts, "critical")]),
    advisory: Object.freeze([...claimsOfSeverity(drafts, "advisory")]),
    criticalCount: input.criticalCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    blockStatus: input.blockStatus ?? { kind: "absent" },
  };
  return Object.freeze(parsed);
}

/** Pure: Build evidence_capture_failed error message, surfacing partial findings if any. */
export function buildEvidenceFailureMessage(findings: ParsedFindings): string {
  const missing = [
    ...(findings.criticalCount === null ? ["CRITICAL_COUNT marker not found"] : []),
    ...(findings.advisoryCount === null ? ["ADVISORY_COUNT marker not found"] : []),
  ].join("; ");
  const reason = missing === "" ? "review count markers are inconsistent" : missing;
  const partial = findings.critical.length + findings.advisory.length;
  return partial > 0
    ? `${reason} — partial findings extracted (${findings.critical.length} critical, ${findings.advisory.length} advisory)`
    : `${reason} in agent output`;
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
      });
}

/** Extract CRITICAL/ADVISORY lines and CRITICAL_COUNT from a text block.
 *  Strips code fences and handles bold/starred markers. */
function extractFindings(block: string): ParsedFindings {
  const cleaned = block.replace(/^\`\`\`\w*$/gm, "");

  const critical: string[] = [];
  const advisory: string[] = [];

  // The marker must END at the keyword — `(?![A-Z0-9_])` — not merely "not be
  // followed by _COUNT". The old `(?!_COUNT)` lookahead excluded exactly one
  // continuation, so any line opening with a LONGER word on the same stem
  // (`CRITICALITY: high`, `ADVISORYNOTES: …`) matched as a genuine finding
  // marker and pushed a garbled claim (`ITY: high`) straight into adjudication.
  // A reviewer's prose becomes a critical finding that nothing wrote.
  for (const line of cleaned.split("\n")) {
    const critMatch = line.match(/^[\s\-*]*\*{0,2}CRITICAL(?![A-Z0-9_]):?\*{0,2}\s*(.*)/);
    if (critMatch) critical.push(critMatch[1].trim());
    const advMatch = line.match(/^[\s\-*]*\*{0,2}ADVISORY(?![A-Z0-9_]):?\*{0,2}\s*(.*)/);
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
 *  Tolerates the same list-marker and bold decoration the claim scraper does.
 *
 *  Takes the LAST match, for the same reason `parseMachineSummary` and
 *  `lastMarker` do: agents echo the skill template before their real output, so
 *  a first-match read lets a templated `CRITICAL_COUNT: 0` outrank the
 *  reviewer's real later count. The legacy scraper applies this to a WHOLE
 *  transcript, where that echo is most likely, and `reconcileFindings`'s
 *  shortfall backstop is gated on `count > 0` — so a first-match zero would
 *  erase real criticals with nothing left to notice it. */
function declaredCount(text: string, severity: "CRITICAL" | "ADVISORY"): number | null {
  const pattern = new RegExp(String.raw`^[ \t\-*]*\*{0,2}${severity}_COUNT:?\*{0,2}\s*(\d+)`, "gm");
  let declared: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) declared = match[1]!;
  return declared === null ? null : Number(declared);
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
  // Trim at the next level-2..4 heading, whatever its level relative to the
  // Machine Summary's own — the pattern does not compare depths. Any \n##..####
  // heading ends the block, which is the conservative reading: a deeper
  // subsection under the summary would end it early rather than swallow a
  // sibling section's prose into the findings.
  const nextHeading = block.match(/\n#{2,4}\s+[^#]/);
  if (nextHeading && nextHeading.index! > 0) block = block.slice(0, nextHeading.index!);

  return chooseSource(extractFindings(block), block);
}

/**
 * Take one occurrence of `claim` out of `pool`, reporting whether it was there.
 * Mutates, because the pool is a multiset being drawn down across a whole
 * arbitration: a claim the block names twice must consume two marker slots, not
 * match the same one twice.
 */
function consumeClaim(pool: string[], claim: string): boolean {
  const at = pool.indexOf(claim);
  if (at < 0) return false;
  pool.splice(at, 1);
  return true;
}

/** The claims `pool` does not account for, drawing `pool` down as it goes. */
function unconsumedClaims(claims: readonly string[], pool: string[]): readonly string[] {
  return claims.filter((claim) => !consumeClaim(pool, claim));
}

/**
 * Enrich marker claims with structured locations without letting the optional
 * block change their severity. Claim text remains the cross-source identity,
 * but each occurrence consumes exactly one marker slot, preferring a
 * same-severity slot when duplicate wording appears at both severities.
 */
function alignStructuredSeverity(
  structured: readonly DraftFinding[],
  markers: readonly DraftFinding[],
): readonly DraftFinding[] {
  const remaining = [...markers];
  return structured.map((draft) => {
    const sameSeverity = remaining.findIndex(
      (marker) => marker.claim === draft.claim && marker.severity === draft.severity,
    );
    const match = sameSeverity >= 0
      ? sameSeverity
      : remaining.findIndex((marker) => marker.claim === draft.claim);
    if (match < 0) return draft;
    const [marker] = remaining.splice(match, 1);
    return marker!.severity === draft.severity
      ? draft
      : Object.freeze({ ...draft, severity: marker!.severity });
  });
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
  const parsedBlock = parseFindingsBlock(block);
  if (parsedBlock === null) {
    return makeParsedFindings({
      drafts: scraped.drafts,
      ...counts,
      blockStatus: hasFindingsBlock(block) ? { kind: "rejected" } : { kind: "absent" },
    });
  }
  const structured = alignStructuredSeverity(parsedBlock, scraped.drafts);
  const fromBlock = makeParsedFindings({ drafts: structured, ...counts, blockStatus: { kind: "used" } });
  const claimedCritical = Math.max(scraped.criticalCount ?? 0, scraped.critical.length);
  const accountsForAll =
    fromBlock.critical.length >= claimedCritical &&
    fromBlock.advisory.length >= scraped.advisory.length;

  // Multiset, not set: two reviewers can legitimately word a claim identically,
  // and a block naming it once when the markers named it twice has dropped one.
  // Both sides are `collapseWhitespace`-normalized (every claim reaching either
  // view is built by makeDraftFinding), so comparison by value is exact.
  //
  // After alignment, severity is authoritative identity too. Separate pools
  // prevent a structured advisory from consuming a same-text CRITICAL marker
  // merely because critical carry-over is evaluated first. A block entry that
  // mislabeled its only marker was already moved to that marker's severity by
  // alignStructuredSeverity, so separate pools do not reintroduce duplicates.
  const criticalBlockPool = structured
    .filter((draft) => draft.severity === "critical")
    .map((draft) => draft.claim);
  const advisoryBlockPool = structured
    .filter((draft) => draft.severity === "advisory")
    .map((draft) => draft.claim);
  const unnamedByBlock = draftsFromClaims(
    unconsumedClaims(scraped.critical, criticalBlockPool),
    unconsumedClaims(scraped.advisory, advisoryBlockPool),
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
    // against markers naming it once contributes exactly one carry-over. One
    // pool per severity for the same reason as the winning side. Alignment has
    // already moved a mislabeled block entry onto its marker's severity, while
    // genuinely separate same-text critical/advisory markers retain two slots.
    const criticalMarkerPool = [...scraped.critical];
    const advisoryMarkerPool = [...scraped.advisory];
    const recovered = structured.filter((draft) => !consumeClaim(
      draft.severity === "critical" ? criticalMarkerPool : advisoryMarkerPool,
      draft.claim,
    ));
    return makeParsedFindings({
      drafts: [...scraped.drafts, ...recovered],
      ...counts,
      blockStatus: { kind: "superseded", carriedOver: recovered.length },
    });
  }

  return unnamedByBlock.length === 0
    ? fromBlock
    : makeParsedFindings({
        // The block's entries first, so its file/line-bearing findings keep
        // their order; the recovered marker claims follow, location-less.
        drafts: [...structured, ...unnamedByBlock],
        ...counts,
        blockStatus: { kind: "partial", carriedOver: unnamedByBlock.length },
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
export interface BoundReviewEvidence {
  readonly packetId: string;
  readonly generation: number;
  readonly priorAssessments: readonly PriorFindingAssessment[];
}

export type ReviewResolution =
  | { readonly kind: "evidence-failed"; readonly agent: string; readonly message: string }
  | { readonly kind: "ignored-stale"; readonly agent: string; readonly message: string }
  | {
      readonly kind: "findings";
      readonly agent: string;
      readonly findings: ParsedFindings;
      readonly bound?: BoundReviewEvidence;
    };

export type UnboundReviewResolution = Exclude<ReviewResolution, { readonly kind: "ignored-stale" }>;

/** Pure: parse → reconcile, in one place, for every harness. */
export function resolveReviewFindings(transcript: string, agent: string): UnboundReviewResolution {
  const findings = parseMachineSummary(transcript) ?? parseLegacyFindings(transcript);
  return findings.criticalCount === null || findings.advisoryCount === null
    ? { kind: "evidence-failed", agent, message: buildEvidenceFailureMessage(findings) }
    : { kind: "findings", agent, findings: reconcileFindings(findings) };
}

const REVIEW_LIFECYCLE_BLOCK =
  /^[ \t]*```[ \t]*review_lifecycle[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

function lastMarker(text: string, name: string): string | null {
  const pattern = new RegExp(`^[ \\t\\-*]*\\*{0,2}${name}:?\\*{0,2}\\s*(\\S+)`, "gim");
  let value: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) value = match[1]!;
  return value;
}

function parsePriorAssessments(
  transcript: string,
  priorIds: readonly string[],
): { readonly ok: true; readonly value: readonly PriorFindingAssessment[] } |
   { readonly ok: false; readonly error: string } {
  REVIEW_LIFECYCLE_BLOCK.lastIndex = 0;
  const bodies: string[] = [];
  for (let match = REVIEW_LIFECYCLE_BLOCK.exec(transcript); match !== null;
       match = REVIEW_LIFECYCLE_BLOCK.exec(transcript)) bodies.push(match[1]!);
  if (bodies.length === 0) {
    return { ok: false, error: "review_lifecycle block missing for packet-bound review" };
  }
  if (bodies.length > 1) {
    return { ok: false, error: "packet-bound review must contain exactly one review_lifecycle block" };
  }
  const body = bodies[0]!;
  let raw: unknown;
  try { raw = JSON.parse(body); }
  catch { return { ok: false, error: "review_lifecycle block is not valid JSON" }; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "review_lifecycle block must be a JSON object" };
  }
  const entries = (raw as Record<string, unknown>).prior_findings;
  if (!Array.isArray(entries)) return { ok: false, error: "review_lifecycle.prior_findings must be an array" };
  const assessments: PriorFindingAssessment[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `review_lifecycle.prior_findings[${index}] must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const findingId = typeof record.finding_id === "string" ? record.finding_id.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (findingId === "" || reason === "" ||
        !(PRIOR_FINDING_VERDICTS as readonly unknown[]).includes(record.verdict)) {
      return { ok: false, error: `review_lifecycle.prior_findings[${index}] is malformed` };
    }
    assessments.push({
      finding_id: findingId,
      verdict: record.verdict as PriorFindingAssessment["verdict"],
      reason,
    });
  }
  const ids = assessments.map((assessment) => assessment.finding_id);
  if (ids.length !== priorIds.length || ids.some((id, index) => id !== priorIds[index])) {
    return { ok: false, error: "review_lifecycle must assess every prior finding exactly once in packet order" };
  }
  return { ok: true, value: assessments };
}

/** Parse a reviewer result against the immutable run that authorized it. */
export function resolveBoundReviewFindings(
  transcript: string,
  agent: string,
  run: ReviewRun,
): ReviewResolution {
  const packetId = lastMarker(transcript, "REVIEW_PACKET_ID");
  const generationRaw = lastMarker(transcript, "REVIEW_GENERATION");
  if (packetId === null || generationRaw === null) {
    return {
      kind: "evidence-failed",
      agent,
      message: "review output omitted REVIEW_PACKET_ID or REVIEW_GENERATION",
    };
  }
  if (packetId !== run.packet_id || generationRaw !== String(run.generation)) {
    return {
      kind: "ignored-stale",
      agent,
      message: `review output is not bound to current packet ${run.packet_id} generation ${run.generation}`,
    };
  }
  const base = resolveReviewFindings(transcript, agent);
  if (base.kind !== "findings") return base;
  const assessments = parsePriorAssessments(transcript, run.prior_finding_ids);
  if (!assessments.ok) {
    return { kind: "evidence-failed", agent, message: assessments.error };
  }
  return {
    ...base,
    bound: {
      packetId: run.packet_id,
      generation: run.generation,
      priorAssessments: assessments.value,
    },
  };
}

/**
 * Select the bound or legacy parser from current task authority. A transcript
 * carrying packet markers can never fall back to legacy merge merely because
 * implementation invalidation or an override cleared its now-stale run first.
 */
export function resolveTaskReviewFindings(
  transcript: string,
  agent: string,
  run: ReviewRun | undefined,
  reviewGeneration: number | undefined,
): ReviewResolution {
  if (run !== undefined) return resolveBoundReviewFindings(transcript, agent, run);
  if (reviewGeneration !== undefined ||
      lastMarker(transcript, "REVIEW_PACKET_ID") !== null ||
      lastMarker(transcript, "REVIEW_GENERATION") !== null) {
    return {
      kind: "ignored-stale",
      agent,
      message: "review output has no matching active review run for this generation-aware task",
    };
  }
  return resolveReviewFindings(transcript, agent);
}

/**
 * Bind located wave findings to the task's Review Packet scope. A null location
 * is honest for cross-cutting claims and remains valid; a supplied path must be
 * one of the task's declared or observed files.
 */
export function constrainReviewResolutionToScope(
  resolution: ReviewResolution,
  scope: readonly string[],
): ReviewResolution {
  if (resolution.kind !== "findings") return resolution;
  const allowed = new Set(scope.flatMap((path) => {
    const parsed = parseReviewPath(path, "review scope path");
    return parsed.ok ? [parsed.value] : [];
  }));
  const outside = resolution.findings.drafts
    .map((finding) => finding.file)
    .filter((file): file is string => {
      if (file === null) return false;
      const parsed = parseReviewPath(file, "review finding path");
      return !parsed.ok || !allowed.has(parsed.value);
    });
  if (outside.length === 0) return resolution;
  return {
    kind: "evidence-failed",
    agent: resolution.agent,
    message: `review finding location(s) outside Review Packet scope: ${[...new Set(outside)].join(", ")}`,
  };
}

/**
 * Pure review invalidation for any transition that records implementation writes.
 * A pending review cannot simultaneously carry outstanding evidence-capture
 * failures: that pairing is reserved for `evidence_capture_failed` and is enforced
 * at the task-graph load boundary.
 */
export function invalidateTaskReview(task: Task): Task {
  return {
    ...task,
    review_status: "pending",
    review_generation: (task.review_generation ?? 0) + 1,
    review_run: undefined,
    review_error: undefined,
    review_evidence_failures: undefined,
  };
}

/** Pure: the complete task transform a resolution implies. */
export function applyReviewResolution(task: Task, resolution: ReviewResolution): Task {
  return match(resolution)
    .with({ kind: "ignored-stale" }, (): Task => task)
    .with({ kind: "evidence-failed" }, (r): Task => {
      // One immutable slot per expected reviewer. A duplicate process failure
      // arriving after that slot succeeded is stale noise, not grounds to poison
      // an otherwise completeable run.
      if (task.review_run !== undefined && !task.review_run.expected_agents.includes(r.agent)) return task;
      if (task.review_run?.evidence.some((evidence) => evidence.agent === r.agent)) return task;
      return {
        ...task,
        review_status: "evidence_capture_failed" as ReviewStatus,
        review_error: r.message,
        // Named, not just counted. The status is per-task and the failure is
        // per-agent, so recording WHICH reviewer could not be parsed is what lets
        // a clean retry clear exactly its own failed evidence.
        review_evidence_failures: [
          ...(task.review_evidence_failures ?? []).filter((failed) => failed !== r.agent),
          r.agent,
        ],
      };
    })
    .with({ kind: "findings" }, (r): Task => {
      if (r.bound === undefined) return mergeFindings(task, r.findings, r.agent);
      const transition = recordReviewRunEvidence(
        task,
        r.bound.packetId,
        r.bound.generation,
        {
          agent: r.agent,
          prior_assessments: r.bound.priorAssessments,
          new_findings: r.findings.drafts,
        },
      );
      if (transition.ok) return transition.task;

      // A result resolved against an older snapshot must not poison the current
      // packet. For the still-active matching packet, however, losing the
      // transition error would let the shell report evidence as staged when no
      // state was written. Preserve that failure in the same typed review
      // record used for transcript parse failures.
      const currentRun = task.review_run;
      if (currentRun === undefined ||
          currentRun.packet_id !== r.bound.packetId ||
          currentRun.generation !== r.bound.generation ||
          currentRun.evidence.some((evidence) => evidence.agent === r.agent)) return task;
      return {
        ...task,
        review_status: "evidence_capture_failed" as ReviewStatus,
        review_error: transition.error,
        review_evidence_failures: [
          ...(task.review_evidence_failures ?? []).filter((agent) => agent !== r.agent),
          r.agent,
        ],
      };
    })
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
function blockStatusNote(status: FindingsBlockStatus): string {
  const carried = (count: number) => `${count} claim(s) carried over`;
  return match(status)
    .with({ kind: "absent" }, () => "")
    .with({ kind: "used" }, () => "")
    .with(
      { kind: "rejected" },
      () => " [findings block was malformed — fell back to marker lines, findings carry no file/line]",
    )
    .with(
      { kind: "superseded" },
      (s) =>
        ` [findings block under-reported findings — used marker lines, ${carried(s.carriedOver)} ` +
        `from the block; the rest carry no file/line]`,
    )
    .with(
      { kind: "partial" },
      (s) =>
        ` [findings block did not name every marker claim — ${carried(s.carriedOver)} without ` +
        `file/line, so a reworded claim is adjudicated twice]`,
    )
    .exhaustive();
}

/** Pure: the operator-facing line a harness writes to stderr for a resolution. */
export function reviewResolutionLog(
  taskId: string,
  resolution: ReviewResolution,
  appliedTask?: Task,
  applicationChanged?: boolean,
): string {
  return match(resolution)
    .with(
      { kind: "evidence-failed" },
      (r) => `WARNING: ${r.message} for ${taskId} — marking evidence_capture_failed`,
    )
    .with(
      { kind: "ignored-stale" },
      (r) => `WARNING: ${r.message} for ${taskId} — evidence ignored`,
    )
    .with({ kind: "findings" }, (r) => {
      if (r.bound !== undefined && appliedTask?.review_evidence_failures?.includes(r.agent)) {
        return `WARNING: ${appliedTask.review_error ?? "review evidence was rejected"} for ${taskId} — marking evidence_capture_failed`;
      }
      if (r.bound !== undefined && applicationChanged === false) {
        return `WARNING: review evidence did not apply to current task state for ${taskId} — evidence ignored`;
      }
      if (r.bound !== undefined && appliedTask !== undefined &&
          appliedTask.review_generation !== r.bound.generation) {
        return `WARNING: review output is stale for ${taskId} — evidence ignored`;
      }
      // The larger of the reviewer's tally and what was actually captured —
      // the same disjunction `mergeFindings` blocks on. Reporting the tally
      // alone logged "passed (0 critical)" for a task the very next line
      // recorded as blocked with a real critical in it.
      const count = Math.max(r.findings.criticalCount ?? 0, r.findings.critical.length);
      return (
        (r.bound === undefined
          ? `Task ${taskId} review: ${count > 0 ? "blocked" : "passed"} (${count} critical)`
          : `Task ${taskId} review evidence staged for packet ${r.bound.packetId} (${count} new critical)`) +
        blockStatusNote(r.findings.blockStatus)
      );
    })
    .exhaustive();
}
