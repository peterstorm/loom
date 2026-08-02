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
 * Pure module: no I/O, no clock, no randomness.
 */

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
 * This is a no-op for every legacy path — the line scraper splits on `\n`, so
 * a scraped claim can never contain one. That is what keeps A2's parser change
 * from altering any existing `critical_findings` content.
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

/** A file reference is kept only when it is a plausible single-segment path. */
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

/** Id-safe form of an agent name: the id is parsed back apart nowhere, but it
 *  is substituted into prompts and used as a JSON key-like token, so anything
 *  outside `[A-Za-z0-9_-]` is collapsed. */
function idSafeAgent(agent: string): string {
  const safe = agent.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "agent" : safe;
}

/**
 * The next ordinal for `agent` given the findings already stored on a task.
 *
 * Re-review is the reason this exists: `/wave-gate` re-spawns the same reviewer
 * for a blocked task and the merge APPENDS, so restarting at 1 would mint a
 * second `code-reviewer-1` naming a different claim. Continuing past the
 * agent's existing count keeps ids unique within the array that holds them.
 */
export function nextOrdinal(existing: readonly Finding[], agent: string): number {
  const safe = idSafeAgent(agent);
  return existing.filter((finding) => idSafeAgent(finding.agent) === safe).length + 1;
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

// ---------------------------------------------------------------------------
// Adjudicated findings
// ---------------------------------------------------------------------------

/**
 * A finding a refutation panel killed, together with why.
 *
 * Recorded, never deleted: a wrong refutation is a shipped bug, and a silently
 * dropped critical finding is indistinguishable from one that was never found.
 * The reasoning is the verifiers' own, joined in lens order.
 */
export interface RefutedFinding {
  readonly finding: Finding;
  /** The lenses whose verifier voted "refuted". Never empty. */
  readonly refutedBy: readonly string[];
  /** One sanitized reason per refuting lens, positionally aligned with `refutedBy`. */
  readonly reasoning: readonly string[];
}

/**
 * Parse `Task.refuted_findings` from a state file nobody validated. Malformed
 * entries are dropped, same rationale as parseStoredFindings.
 */
export function parseStoredRefutations(raw: unknown): RefutedFinding[] {
  if (!Array.isArray(raw)) return [];
  const refuted: RefutedFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const [finding] = parseStoredFindings([record.finding]);
    if (!finding) continue;
    const refutedBy = asStringArray(record.refutedBy);
    const reasoning = asStringArray(record.reasoning);
    if (refutedBy.length === 0 || reasoning.length !== refutedBy.length) continue;
    refuted.push({ finding, refutedBy, reasoning });
  }
  return refuted;
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) && raw.every((v): v is string => typeof v === "string" && v.trim() !== "")
    ? raw.map((v) => v.trim())
    : [];
}

// ---------------------------------------------------------------------------
// Reading findings back out of the (untrusted) state file
// ---------------------------------------------------------------------------

/**
 * Parse `Task.findings` from a state file nobody validated. Malformed entries
 * are DROPPED rather than failing the whole task: the derived `string[]` views
 * are what gate the wave, so a corrupt structured record must never be able to
 * make a blocked task unreadable. Returns `[]` for a missing or non-array field.
 */
export function parseStoredFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const findings: Finding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const severity = parseFindingSeverity(record.severity);
    if (severity === null || typeof record.claim !== "string") continue;
    if (typeof record.id !== "string" || record.id.trim() === "") continue;
    if (typeof record.agent !== "string" || record.agent.trim() === "") continue;
    const draft = makeDraftFinding({
      severity,
      claim: record.claim,
      file: record.file,
      line: record.line,
    });
    if (!draft) continue;
    findings.push({ ...draft, id: record.id.trim(), agent: record.agent.trim() });
  }
  return findings;
}
