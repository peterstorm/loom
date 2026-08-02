/**
 * Finding identity — the prerequisite for adversarial verification.
 *
 * Review findings used to exist only as regex-scraped free text in two parallel
 * `string[]` fields. Nothing tied a line in `critical_findings` to the reviewer
 * that produced it, the file it concerns, or the same line on a later run. That
 * is fine for counting and printing, and useless for anything that must AGREE
 * about which finding is under discussion — which is exactly what a k-of-n
 * refutation vote needs.
 *
 * The identity split here is deliberate and load-bearing:
 *
 *   DraftFinding — what a reviewer emitted. No id, no attribution.
 *   Finding      — a draft plus an id DERIVED from (agent, ordinal).
 *
 * Ids are never agent-chosen. Agents renumber between runs, collide with each
 * other, and reuse ids for different claims; a derived id needs no trust and is
 * stable for the life of the array it lives in. `attributeFindings` is the only
 * constructor of `Finding`, so an un-attributed draft cannot be mistaken for an
 * identified one at a type level.
 *
 * This module owns the `Task.findings` aggregate: minting identity, reading it
 * back out of an untrusted state file, proving the lockstep invariant at the
 * load boundary, and the two REVIEW-path writers that must keep the
 * authoritative array and its two derived `string[]` views in step —
 * `mergeFindings` (a reviewer finished) and `applyFindingOutcomes` (the panel
 * adjudicated). They live together because the invariant is one invariant;
 * splitting them across modules is how it drifted before.
 *
 * Two further lockstep writers live in handlers because they are operator
 * entry points, not review steps: `updateTaskFindings` (the manual override) and
 * `fixTaskFindings` (`--fix`). Both derive their views through
 * `claimsOfSeverity` here, and both are held to the same invariant by
 * `findingsLockstepError` at the load boundary — the enumeration of all five
 * writers lives on `Task.findings` in types.ts.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { ReviewStatus, Task } from "../types";
import { isNoFindingSentinel } from "../utils/no-finding-sentinel";

export const FINDING_SEVERITIES = ["critical", "advisory"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Smart constructor: null when `raw` is not a known severity. */
export function parseFindingSeverity(raw: unknown): FindingSeverity | null {
  return typeof raw === "string" && (FINDING_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as FindingSeverity)
    : null;
}

/**
 * A finding exactly as a reviewer emitted it: a claim, a severity, and an
 * optional location. Deliberately carries NO identity — see the module note.
 */
export interface DraftFinding {
  readonly severity: FindingSeverity;
  /** Repo-relative path the claim concerns, or null when the reviewer gave none. */
  readonly file: string | null;
  /** 1-based line, or null. */
  readonly line: number | null;
  /** The single assertion a verifier will try to refute. */
  readonly claim: string;
}

/** A draft plus derived identity. Only `attributeFindings` produces these. */
export interface Finding extends DraftFinding {
  /** `${agent}-${ordinal}`, derived — never agent-chosen. */
  readonly id: string;
  /** The review agent that emitted the claim (namespace already stripped). */
  readonly agent: string;
}

/**
 * Claims reach prompt templates (the verifier brief) and JSON manifests, so a
 * claim carrying a raw line terminator would break the one-finding-per-line
 * reading the legacy `string[]` views still rely on. Collapsed rather than
 * rejected: a multi-line claim from the JSON block is still a real finding.
 *
 * With respect to LINE TERMINATORS this is a no-op on every legacy path — the
 * line scraper splits on `\n`, so a scraped claim can never contain one. It does
 * also collapse internal space/tab runs (`"foo    bar"` → `"foo bar"`), which is
 * safe because every comparison against the derived views goes through claims
 * normalized here identically — see `removeOnce` and `recoverViewOnlyClaims`.
 */
function collapseWhitespace(claim: string): string {
  return claim.replace(/\s+/g, " ").trim();
}

/**
 * Smart constructor. Returns null for anything that is not a real finding:
 * an empty claim, or a "no findings" sentinel (`none`, `n/a`, …) — the same
 * filter the `string[]` views have always applied, moved to the single place
 * that builds findings so the authoritative array and its derived views cannot
 * disagree about what counts.
 */
export function makeDraftFinding(input: {
  readonly severity: FindingSeverity;
  readonly claim: string;
  readonly file?: unknown;
  readonly line?: unknown;
}): DraftFinding | null {
  const claim = collapseWhitespace(input.claim);
  if (claim === "" || isNoFindingSentinel(claim)) return null;
  return {
    severity: input.severity,
    file: parseFindingFile(input.file),
    line: parseFindingLine(input.line),
    claim,
  };
}

/**
 * A file reference is kept only when it is a non-empty single-LINE string.
 *
 * Line terminators are rejected because the claim/file pair is substituted into
 * verifier prompts and the legacy `string[]` views are read one-finding-per-line.
 * Path SHAPE is deliberately not validated — the reviewer's repo-relative path
 * (`src/core/findings.ts`) is taken as given, because the engine has no way to
 * tell a wrong path from an unfamiliar one and a rejected location is strictly
 * worse than an unverified one.
 */
function parseFindingFile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const file = raw.trim();
  return file === "" || /[\r\n]/.test(file) ? null : file;
}

/** A line reference is kept only when it is a positive integer. */
function parseFindingLine(raw: unknown): number | null {
  const line = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}

/** Build drafts from the legacy severity-grouped claim lists, dropping non-findings. */
export function draftsFromClaims(
  critical: readonly string[],
  advisory: readonly string[],
): readonly DraftFinding[] {
  return [
    ...critical.map((claim) => makeDraftFinding({ severity: "critical", claim })),
    ...advisory.map((claim) => makeDraftFinding({ severity: "advisory", claim })),
  ].filter((finding): finding is DraftFinding => finding !== null);
}

/** The derived view the legacy `critical_findings` / `advisory_findings` arrays hold. */
export function claimsOfSeverity(
  findings: readonly DraftFinding[],
  severity: FindingSeverity,
): readonly string[] {
  return findings.filter((finding) => finding.severity === severity).map((finding) => finding.claim);
}

/**
 * Remove ONE occurrence of each claim, by value — a multiset difference.
 *
 * The derived `string[]` views can legitimately hold the same claim twice (two
 * reviewers, same wording), so a set-difference would delete a finding nobody
 * refuted, and a set-comparison would reject a graph the writers are allowed to
 * produce. Used three ways: adjudication (`applyFindingOutcomes` retires only
 * the claims it removed), the load-boundary lockstep proof, and the repair path
 * (`fixTaskFindings` recovers exactly the claims no finding accounts for).
 */
export function removeOnce(claims: readonly string[], toRemove: readonly string[]): string[] {
  const remaining = [...claims];
  for (const claim of toRemove) {
    const index = remaining.indexOf(claim);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/** Id-safe form of an agent name: the id is parsed back apart nowhere, but it
 *  is substituted into prompts and used as a JSON key-like token, so anything
 *  outside `[A-Za-z0-9_-]` is collapsed. */
function idSafeAgent(agent: string): string {
  const safe = agent.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "agent" : safe;
}

/** The ordinal encoded in `id`, or 0 when `id` was not minted for `safeAgent`.
 *  Reading the ordinal back is what makes minting independent of how many
 *  findings currently sit in the array (see nextOrdinal). */
function ordinalOf(id: string, safeAgent: string): number {
  const match = /^(.*)-(\d+)$/.exec(id);
  return match && match[1] === safeAgent ? Number(match[2]) : 0;
}

/**
 * The next ordinal for `agent`, given every id this task has EVER minted.
 *
 * Re-review is the reason this exists: `/wave-gate` re-spawns the same reviewer
 * for a blocked task and the merge APPENDS, so restarting at 1 would mint a
 * second `code-reviewer-1` naming a different claim.
 *
 * `refuted` is not optional and not a nicety. `applyFindingOutcomes` MOVES a
 * refuted finding out of `task.findings` and into `task.refuted_findings`, so
 * the active array's length is not a high-water mark. Counting it — which this
 * function used to do — remints an ordinal a refutation record still holds; the
 * duplicate then makes `applyFindingOutcomes`' id filter delete two findings
 * where one was adjudicated, and attaches the panel's reasoning to the wrong
 * claim. Ids must come from a source that removal cannot rewind.
 */
export function nextOrdinal(
  existing: readonly Finding[],
  refuted: readonly RefutedFinding[],
  agent: string,
): number {
  const safe = idSafeAgent(agent);
  const minted = [...existing, ...refuted.map((record) => record.finding)].map((finding) =>
    ordinalOf(finding.id, safe),
  );
  return Math.max(0, ...minted) + 1;
}

/** Derive identity for a reviewer's drafts. The ONLY constructor of `Finding`. */
export function attributeFindings(
  drafts: readonly DraftFinding[],
  agent: string,
  startOrdinal = 1,
): readonly Finding[] {
  const safe = idSafeAgent(agent);
  return drafts.map((draft, index) => ({
    ...draft,
    id: `${safe}-${startOrdinal + index}`,
    agent,
  }));
}

// ---------------------------------------------------------------------------
// The optional structured Machine Summary block
// ---------------------------------------------------------------------------

/**
 * A fenced ```findings block, if the reviewer emitted one:
 *
 * ```findings
 * [{ "severity": "critical", "file": "src/x.ts", "line": 42, "claim": "..." }]
 * ```
 *
 * Optional by design. The `CRITICAL_COUNT` / `CRITICAL:` / `ADVISORY:` lines
 * remain the contract every reviewer must satisfy; this block only ADDS
 * location and per-claim structure when the reviewer can produce it.
 * Verification quality degrades without file/line — it does not break.
 */
const FINDINGS_BLOCK = /^[ \t]*```[ \t]*findings[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/**
 * Parse the LAST fenced findings block in `output`, or null when there is none
 * or it is unusable. Last-match for the same reason parseMachineSummary uses
 * it: agents echo the template before emitting their real output.
 *
 * Null (not an empty array) on a malformed block, so the caller falls back to
 * the line scraper instead of silently recording zero findings. An empty JSON
 * array IS meaningful — it means "I found nothing" — and parses to `[]`.
 * The caller reports which of those happened; see FindingsBlockStatus.
 */
export function parseFindingsBlock(output: string): readonly DraftFinding[] | null {
  FINDINGS_BLOCK.lastIndex = 0;
  let body: string | null = null;
  for (let m = FINDINGS_BLOCK.exec(output); m !== null; m = FINDINGS_BLOCK.exec(output)) {
    body = m[1]!;
  }
  if (body === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const drafts: DraftFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const severity = parseFindingSeverity(record.severity);
    if (severity === null || typeof record.claim !== "string") return null;
    const draft = makeDraftFinding({
      severity,
      claim: record.claim,
      file: record.file,
      line: record.line,
    });
    // A dropped entry is a sentinel or an empty claim, not a malformed block —
    // the reviewer said "none" in structured form. Skip it, keep the block.
    if (draft) drafts.push(draft);
  }
  return drafts;
}

/** Whether a fenced findings block was present in the output at all. */
export function hasFindingsBlock(output: string): boolean {
  FINDINGS_BLOCK.lastIndex = 0;
  return FINDINGS_BLOCK.test(output);
}

// ---------------------------------------------------------------------------
// Adjudicated findings
// ---------------------------------------------------------------------------

/**
 * One verifier's refutation: the lens that voted to kill a finding, and why.
 *
 * A pair, not two positionally-aligned arrays. The parallel-array form let a
 * lens list and a reason list disagree in length, which no reader could detect
 * and only a runtime check in the parser could reject; here the misalignment is
 * unrepresentable.
 *
 * `lens` is the open string form on purpose: a refutation record OUTLIVES the
 * lens table that produced it, and a stored audit trail must not become
 * unreadable because a lens was later renamed or retired.
 */
export interface Refutation {
  readonly lens: string;
  readonly reason: string;
}

/**
 * A finding a refutation panel killed, together with why.
 *
 * Recorded, never deleted: a wrong refutation is a shipped bug, and a silently
 * dropped critical finding is indistinguishable from one that was never found.
 */
export interface RefutedFinding {
  readonly finding: Finding;
  /** The lenses that refuted it, with their reasoning, in lens order. Never empty. */
  readonly refutations: readonly Refutation[];
}

// ---------------------------------------------------------------------------
// Reading findings back out of the (untrusted) state file
// ---------------------------------------------------------------------------

/**
 * The ONE definition of a well-formed stored finding.
 *
 * `parseStoredFindings` drops what this rejects; `findingsUnionError` refuses to
 * load it. Sharing the predicate is what keeps "what the load boundary rejects"
 * and "what --fix repairs" the same set — otherwise a graph could be
 * simultaneously unloadable and unrepairable.
 */
function parseStoredFinding(raw: unknown): Finding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const severity = parseFindingSeverity(record.severity);
  if (severity === null || typeof record.claim !== "string") return null;
  if (typeof record.id !== "string" || record.id.trim() === "") return null;
  if (typeof record.agent !== "string" || record.agent.trim() === "") return null;
  const draft = makeDraftFinding({
    severity,
    claim: record.claim,
    file: record.file,
    line: record.line,
  });
  return draft === null ? null : { ...draft, id: record.id.trim(), agent: record.agent.trim() };
}

/** The one definition of a well-formed stored refutation record. */
function parseStoredRefutation(raw: unknown): RefutedFinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const finding = parseStoredFinding(record.finding);
  if (finding === null) return null;
  if (!Array.isArray(record.refutations) || record.refutations.length === 0) return null;
  const refutations: Refutation[] = [];
  for (const entry of record.refutations) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const pair = entry as Record<string, unknown>;
    const lens = typeof pair.lens === "string" ? pair.lens.trim() : "";
    const reason = typeof pair.reason === "string" ? pair.reason.trim() : "";
    if (lens === "" || reason === "") return null;
    refutations.push({ lens, reason });
  }
  return { finding, refutations };
}

/**
 * Repair-path parse of `Task.findings`: malformed entries are DROPPED.
 *
 * Only `validate-task-graph --fix` should reach this. The LOAD path fails loudly
 * instead (findingsUnionError) — dropping on every read would silently lose a
 * critical, and the repair is only safe because `fixFull` re-derives the two
 * `string[]` views from whatever survives, restoring lockstep rather than
 * leaving an orphaned claim no panel can adjudicate.
 */
export function parseStoredFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseStoredFinding).filter((finding): finding is Finding => finding !== null);
}

/**
 * The claims a malformed `findings` entry still carries, as drafts.
 *
 * `parseStoredFindings` drops what it cannot fully parse — a missing `id`, a
 * blank `agent`, anything the load boundary rejects. The repair then leaned on
 * `recoverViewOnlyClaims` to restore those claims from the `string[]` views,
 * which works only while the views still hold them. When they do not, the claim
 * was DELETED by the very command the load-boundary diagnostic tells the
 * operator to run, and `complete-wave-gate` then counted zero criticals on a
 * task whose reviewer found a blocker.
 *
 * So identity is re-minted rather than the claim discarded, for the same reason
 * `recoverViewOnlyClaims` mints rather than deletes: a defective id is a naming
 * defect, and a claim nobody can adjudicate is strictly better than a claim
 * nobody can see. Only entries that survive `makeDraftFinding` come back — an
 * entry with no usable severity or an empty/sentinel claim carries nothing to
 * salvage, and the caller reports those as dropped.
 */
export function salvageMalformedFindings(raw: unknown): readonly DraftFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (parseStoredFinding(entry) !== null) return [];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const severity = parseFindingSeverity(record.severity);
    if (severity === null || typeof record.claim !== "string") return [];
    const draft = makeDraftFinding({
      severity,
      claim: record.claim,
      file: record.file,
      line: record.line,
    });
    return draft === null ? [] : [draft];
  });
}

/** Repair-path parse of `Task.refuted_findings`. Same rationale as above. */
export function parseStoredRefutations(raw: unknown): RefutedFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseStoredRefutation)
    .filter((record): record is RefutedFinding => record !== null);
}

/** The repair a rejected task graph needs, named in the diagnostic itself. */
const REPAIR_HINT = "repair with: helper validate-task-graph --fix";

/**
 * Load-boundary check for `Task.findings`. Returns the first error, or null.
 *
 * `Task.findings?: readonly Finding[]` is a type-level claim that disk data has
 * to earn, exactly like `status` and `test_result.verdict` earn theirs in
 * `taskUnionError`. Without this the cast is a lie and a hand-edited entry
 * surfaces as an unhandled TypeError from inside a panel helper rather than as
 * a contract diagnostic.
 */
export function findingsUnionError(raw: unknown, label: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return `${label} must be an array when present`;
  const index = raw.findIndex((entry) => parseStoredFinding(entry) === null);
  if (index >= 0) return `${label}[${index}] is not a well-formed finding (${REPAIR_HINT})`;

  // Ids must be distinct, and this is the only place that can prove it. Two
  // findings sharing an id make `applyFindingOutcomes`' id filter delete BOTH
  // where one was adjudicated, and attach the panel's reasoning to the wrong
  // claim — the exact failure `nextOrdinal` is built to foreclose on the
  // minting side. Minting is guarded; a hand-edited or drifted file is not.
  const ids = raw.map((entry) => (entry as Record<string, unknown>).id as string);
  const duplicate = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  return duplicate < 0
    ? null
    : `${label}[${duplicate}] repeats finding id '${ids[duplicate]}' (${REPAIR_HINT})`;
}

/**
 * Load-boundary check that `findings` and its two `string[]` views agree.
 *
 * `types.ts` calls the views DERIVED, five writers keep them so, and both the
 * wave gate and the GH comment read the views rather than the array. Nothing
 * proved it. Shape validation alone leaves both drift directions open, and the
 * dangerous one is silent: a critical present in `findings` but missing from
 * `critical_findings` never blocks the wave, and a claim in the view with no
 * counterpart in the array can never enter a brief, so no panel can adjudicate
 * it and the task stays blocked with nothing able to clear it.
 *
 * A MULTISET comparison, not a set one: two reviewers can legitimately word the
 * same claim identically, and collapsing that to one would reject a graph the
 * writers are allowed to produce.
 */
export function findingsLockstepError(
  raw: unknown,
  criticalView: unknown,
  advisoryView: unknown,
  label: string,
): string | null {
  if (raw === undefined) return null;
  const findings = parseStoredFindings(raw);
  for (const severity of FINDING_SEVERITIES) {
    const view = severity === "critical" ? criticalView : advisoryView;
    const claims = Array.isArray(view) ? view.filter((c): c is string => typeof c === "string") : [];
    const derived = claimsOfSeverity(findings, severity);
    const leftover = removeOnce(claims, derived);
    const missing = removeOnce(derived, claims);
    if (leftover.length > 0 || missing.length > 0) {
      return (
        `${label}: ${severity}_findings is not the derived view of findings — ` +
        `${leftover.length} claim(s) present only in the view, ` +
        `${missing.length} present only in findings (${REPAIR_HINT})`
      );
    }
  }
  return null;
}

/** Load-boundary check for `Task.refuted_findings`. */
export function refutationsUnionError(raw: unknown, label: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return `${label} must be an array when present`;
  const index = raw.findIndex((entry) => parseStoredRefutation(entry) === null);
  return index < 0
    ? null
    : `${label}[${index}] is not a well-formed refutation record (${REPAIR_HINT})`;
}

// ---------------------------------------------------------------------------
// The two writers that must keep `findings` and its derived views in lockstep
// ---------------------------------------------------------------------------

/** One or more refutations. A refuted finding always has at least one — the
 *  reader (`parseStoredRefutation`) rejects an empty list, so writing one
 *  produces state this module's own load path refuses. */
export type NonEmptyRefutations = readonly [Refutation, ...Refutation[]];

/**
 * What applying a panel decision needs to know about one finding.
 *
 * A UNION rather than a record with a `boolean` beside an independently-sized
 * array: `survives: false` with no refutations was representable, and the
 * coupling was enforced by a throw in `applyFindingOutcomes` — at the consumer,
 * after the decision had already been made upstream. The panel knows which
 * branch it is building at the moment it counts the votes, so it says so.
 *
 * `FindingOutcome` (core/review-panel) satisfies this structurally. Declaring
 * the narrow shape here rather than importing the wide one is what lets the two
 * lockstep writers — mergeFindings and applyFindingOutcomes — live in the module
 * that owns the invariant: review-panel imports findings, so findings cannot
 * import review-panel back.
 */
export type AdjudicatedFinding =
  | {
      readonly finding: { readonly id: string; readonly taskId: string };
      readonly refutations: readonly Refutation[];
      readonly survives: true;
    }
  | {
      readonly finding: { readonly id: string; readonly taskId: string };
      readonly refutations: NonEmptyRefutations;
      readonly survives: false;
    };

/**
 * The agent a claim recovered from a legacy `string[]` view is attributed to.
 *
 * Honest attribution: nobody knows which reviewer emitted a pre-identity claim,
 * and guessing would put a real reviewer's name on a claim it may not have made.
 * Distinct from OVERRIDE_AGENT because an operator DECIDED that one.
 */
export const RECOVERED_AGENT = "recovered-view";

/**
 * Mint identity for claims the `string[]` views hold that no structured finding
 * accounts for. Returns only the recovered findings; empty when already in step.
 *
 * Recovery, not deletion, is the only safe repair. A claim in the view with no
 * counterpart in `findings` can never enter a brief, so it can never be refuted,
 * so the task stays blocked with nothing able to adjudicate it — but DROPPING it
 * deletes a critical the wave gate counts, which is strictly worse: the gate
 * then passes a task whose reviewer found a blocker. Minting makes the claim
 * refutable, which is what both callers actually want.
 *
 * Shared by all THREE writers that can meet a pre-identity task —
 * `mergeFindings` (a reviewer finished), `fixTaskFindings` (`--fix`), and
 * `updateTaskFindings` (the manual override, in
 * handlers/helpers/store-review-findings) — so none of them can disagree about
 * what recovery means. Changing the semantics here changes all three.
 */
export function recoverViewOnlyClaims(
  findings: readonly Finding[],
  refuted: readonly RefutedFinding[],
  criticalView: readonly string[] | undefined,
  advisoryView: readonly string[] | undefined,
): readonly Finding[] {
  const orphanCritical = removeOnce(criticalView ?? [], claimsOfSeverity(findings, "critical"));
  const orphanAdvisory = removeOnce(advisoryView ?? [], claimsOfSeverity(findings, "advisory"));
  const drafts = draftsFromClaims(orphanCritical, orphanAdvisory);
  return drafts.length === 0
    ? []
    : attributeFindings(drafts, RECOVERED_AGENT, nextOrdinal(findings, refuted, RECOVERED_AGENT));
}

/**
 * Re-mint any id that collides with one already seen. The repair counterpart of
 * `findingsUnionError`'s uniqueness check — rejection needs a repair that can
 * actually clear it, or the operator is dead-ended on an unloadable graph.
 *
 * Re-minted rather than dropped, for the reason recovery exists at all: the
 * second claim under a duplicated id is a real finding, and the collision is a
 * naming defect, not a reason to lose it.
 */
export function deduplicateFindingIds(
  findings: readonly Finding[],
  refuted: readonly RefutedFinding[],
): readonly Finding[] {
  const kept: Finding[] = [];
  for (const finding of findings) {
    if (!kept.some((seen) => seen.id === finding.id)) {
      kept.push(finding);
      continue;
    }
    kept.push(
      ...attributeFindings([finding], finding.agent, nextOrdinal(kept, refuted, finding.agent)),
    );
  }
  return kept;
}

/**
 * Merge one reviewer's findings into a task, accumulating rather than
 * overwriting. Never demotes review_status from "blocked" to "passed".
 *
 * `findings` (structured, identified) and the two `string[]` fields (derived
 * views) are appended in lockstep, so every claim added through this function
 * appears in exactly one place in each. Ids continue past every ordinal `agent`
 * has ever been issued on this task, including ones now sitting in
 * `refuted_findings` (see nextOrdinal).
 */
export function mergeFindings(
  task: Task,
  findings: { readonly drafts: readonly DraftFinding[]; readonly criticalCount: number | null },
  agent: string,
): Task {
  // Either source may say "blocked": `criticalCount` is the reviewer's own
  // tally, and the captured criticals are what the gate will actually count.
  // Trusting the tally alone let `CRITICAL_COUNT: 0` beside a real `CRITICAL:`
  // line record `passed` — and a task pinned at `passed` is one that
  // `applyFindingOutcomes`' promotion guard can never adjudicate.
  const captured = claimsOfSeverity(findings.drafts, "critical").length;
  const newStatus: ReviewStatus =
    (findings.criticalCount ?? 0) > 0 || captured > 0 ? "blocked" : "passed";
  const reviewStatus: ReviewStatus = task.review_status === "blocked" ? "blocked" : newStatus;

  const refuted = task.refuted_findings ?? [];
  // A pre-identity task's claims live only in the views. Appending beside them
  // without migrating would leave `findings` holding strictly less than the
  // views claim — the drift the load boundary now rejects outright.
  const existing = [
    ...(task.findings ?? []),
    ...recoverViewOnlyClaims(
      task.findings ?? [],
      refuted,
      task.critical_findings,
      task.advisory_findings,
    ),
  ];
  const attributed = attributeFindings(
    findings.drafts,
    agent,
    nextOrdinal(existing, refuted, agent),
  );
  const merged = [...existing, ...attributed];

  return {
    ...task,
    review_status: reviewStatus,
    // `review_error` describes an evidence-capture failure and nothing else.
    // A reviewer that DID emit its evidence supersedes that record; leaving it
    // in place left `passed` tasks carrying a stale parse-failure message.
    review_error: undefined,
    findings: merged,
    critical_findings: [...claimsOfSeverity(merged, "critical")],
    advisory_findings: [...claimsOfSeverity(merged, "advisory")],
  };
}

/** Strip the wave scoping a brief added, recovering the task-local finding id. */
function localFindingId(briefId: string, taskId: string): string {
  return briefId.startsWith(`${taskId}:`) ? briefId.slice(taskId.length + 1) : briefId;
}

/**
 * Move this task's refuted findings out of the active set and into
 * `refuted_findings`, keeping the authoritative array and its derived views in
 * lockstep.
 *
 * This is the only demotion of `review_status` from `blocked` to `passed` that
 * ADJUDICATES anything. mergeFindings never demotes, because a reviewer
 * finishing second must not erase the first one's block — a concurrency rule.
 * The panel is a different actor: it runs after every reviewer, adjudicates the
 * accumulated set, and deciding whether the block stands is its entire purpose.
 * A task whose criticals were all refuted IS passed. `evidence_capture_failed`
 * is never promoted — nothing was adjudicated there.
 *
 * (`store-review-findings` — the manual operator override — and
 * `complete-wave-gate`'s advancement also write `passed`. Neither adjudicates a
 * finding; they replace the review record and close out a verified wave.)
 */
export function applyFindingOutcomes(
  task: Task,
  outcomes: readonly AdjudicatedFinding[],
): Task {
  const mine = outcomes.filter(
    (outcome) => outcome.finding.taskId === task.id && !outcome.survives,
  );
  if (mine.length === 0) return task;

  const refutedLocalIds = new Set(
    mine.map((outcome) => localFindingId(outcome.finding.id, task.id)),
  );
  const kept = (task.findings ?? []).filter((finding) => !refutedLocalIds.has(finding.id));
  const removed = (task.findings ?? []).filter((finding) => refutedLocalIds.has(finding.id));

  const refutedRecords: RefutedFinding[] = mine.map((outcome) => {
    const localId = localFindingId(outcome.finding.id, task.id);
    const finding = removed.find((f) => f.id === localId);
    // Throw rather than skip, for the reason `requireEntry` throws: the brief
    // is built from `task.findings` and the load boundary proves lockstep, so a
    // miss here is a broken invariant, not a degraded input. Skipping it wrote
    // no audit record while `serializeOutcomes` and the operator line both
    // still reported the finding as refuted — and dropping the last critical
    // that way promotes `blocked → passed` with nothing to show for it. The
    // reachable window is a `store-review-findings` override landing between
    // `brief` and `tally`, which invalidates every brief id for that task.
    if (finding === undefined) {
      throw new Error(
        `findings invariant: ${task.id} has no finding '${localId}' the panel adjudicated — ` +
          `the task graph changed between brief and tally; re-run the brief`,
      );
    }
    // No emptiness check: `mine` is filtered on `!survives`, which narrows
    // `outcome.refutations` to NonEmptyRefutations. The runtime throw this
    // replaces guarded a state the type now cannot express.
    return { finding, refutations: outcome.refutations };
  });

  // Derived from `kept`, the authority, rather than inferred from the view a
  // few lines below it — the promotion must not depend on the lockstep holding.
  const reviewStatus =
    task.review_status === "blocked" && kept.every((finding) => finding.severity !== "critical")
      ? "passed"
      : task.review_status;

  return {
    ...task,
    ...(reviewStatus ? { review_status: reviewStatus } : {}),
    findings: kept,
    critical_findings: removeOnce(
      task.critical_findings ?? [],
      claimsOfSeverity(removed, "critical"),
    ),
    advisory_findings: removeOnce(
      task.advisory_findings ?? [],
      claimsOfSeverity(removed, "advisory"),
    ),
    refuted_findings: [...(task.refuted_findings ?? []), ...refutedRecords],
  };
}
