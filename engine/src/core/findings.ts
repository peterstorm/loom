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
 * place identity is MINTED, so an un-attributed draft cannot be mistaken for an
 * identified one at a type level. (`parseStoredFinding` also produces a
 * `Finding`, but it reads back identity already on disk rather than deriving a
 * new one — which is exactly why `findingsUnionError` has to re-prove
 * uniqueness for a file the minting path never touched.)
 *
 * This module owns the `Task.findings` aggregate: minting identity, reading it
 * back out of an untrusted state file, proving the lockstep invariant at the
 * load boundary, and the three REVIEW-path writers that must keep the
 * authoritative array and its two derived `string[]` views in step —
 * `mergeFindings` (legacy review), `finalizeReviewRun` (packet-bound review),
 * and `applyFindingOutcomes` (the panel adjudicated). They live together because the invariant is one invariant;
 * splitting them across modules is how it drifted before.
 *
 * Three further lockstep writers live in handlers because none of them is a
 * review step: `updateTaskFindings` (the manual operator override),
 * `fixTaskFindings` (`--fix`), and `sanitizeDecomposedTask` (the decomposition
 * that first admits a task to the graph). All three derive their views through
 * `claimsOfSeverity` here, and all three are held to the same invariant by
 * `findingsLockstepError` at the load boundary — the enumeration of all six
 * writers lives on `Task.findings` in types.ts.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import {
  FINDING_SEVERITIES,
  PRIOR_FINDING_VERDICTS,
  type ReviewStatus,
  type Task,
} from "../types";
import type {
  DraftFinding,
  Finding,
  FindingResolutionAssessment,
  FindingSeverity,
  NonEmptyRefutations,
  PriorFindingAssessment,
  Refutation,
  RefutedFinding,
  ResolvedFinding,
  ReviewRun,
  ReviewRunEvidence,
} from "../types";
import type { HeadSha, PacketId } from "./review-packet";
import { isNoFindingSentinel } from "../utils/no-finding-sentinel";

// The shapes live in types.ts (the schema root, with `Task`); this module owns
// their BEHAVIOUR. Re-exported so every existing import site keeps working and
// so "where findings come from" stays one answer.
export { FINDING_SEVERITIES };
export type {
  DraftFinding,
  Finding,
  FindingResolutionAssessment,
  FindingSeverity,
  NonEmptyRefutations,
  PriorFindingAssessment,
  Refutation,
  RefutedFinding,
  ResolvedFinding,
  ReviewRun,
  ReviewRunEvidence,
};

/** Smart constructor: null when `raw` is not a known severity. */
export function parseFindingSeverity(raw: unknown): FindingSeverity | null {
  return typeof raw === "string" && (FINDING_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as FindingSeverity)
    : null;
}

/** Parse the task-local identity that can be safely composed into a
 * `task-id:finding-id` panel identity. Colons and whitespace would make that
 * composition ambiguous or unparsable, so they are rejected at the boundary. */
export function parseFindingId(raw: unknown): string | null {
  return typeof raw === "string" && /^[^:\s]+$/.test(raw) ? raw : null;
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
 *
 * `resolved` holds the same retired-ordinal invariant for the demotion {
 * `applyFindingOutcomes`-style remediation side: a resolved (remediated)
 * finding is also moved OUT of `task.findings` (into `resolved_findings`), so
 * its id must keep counting toward the high-water mark exactly like a refuted
 * one — otherwise a later re-review could remint an ordinal still held by a
 * resolved record, re-attaching remediation history to a different claim. Every
 * caller passes it; dropping it from the comment would invite the 'equivalent
 * simplification' that reintroduces the duplicate-ordinal defect.
 */
export function nextOrdinal(
  existing: readonly Finding[],
  refuted: readonly RefutedFinding[],
  agent: string,
  resolved: readonly ResolvedFinding[] = [],
): number {
  const safe = idSafeAgent(agent);
  const minted = [
    ...existing,
    ...refuted.map((record) => record.finding),
    ...resolved.map((record) => record.finding),
  ].map((finding) => ordinalOf(finding.id, safe));
  return Math.max(0, ...minted) + 1;
}

/** Derive identity for a reviewer's drafts. The ONLY place Finding identity is
 *  MINTED. (`parseStoredFinding` also produces `Finding`s, but it reads back
 *  identity already on disk rather than deriving a new one — the module header
 *  draws the same distinction.) */
export function attributeFindings(
  drafts: readonly DraftFinding[],
  agent: string,
  startOrdinal = 1,
  provenance?: { readonly generation: number; readonly packetId: string },
): readonly Finding[] {
  const safe = idSafeAgent(agent);
  return drafts.map((draft, index) => {
    const id = parseFindingId(`${safe}-${startOrdinal + index}`);
    if (id === null) throw new Error("finding identity minting produced an invalid id");
    return {
      ...draft,
      id,
      agent,
      ...(provenance === undefined
        ? {}
        : {
            review_generation: provenance.generation,
            review_packet_id: provenance.packetId,
          }),
    };
  });
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
  const id = typeof record.id === "string" && record.id === record.id.trim()
    ? parseFindingId(record.id)
    : null;
  if (id === null) return null;
  if (typeof record.agent !== "string" || record.agent.trim() === "") return null;
  const draft = makeDraftFinding({
    severity,
    claim: record.claim,
    file: record.file,
    line: record.line,
  });
  const reviewGeneration = record.review_generation;
  if (reviewGeneration !== undefined && (
    typeof reviewGeneration !== "number" || !Number.isInteger(reviewGeneration) || reviewGeneration < 0
  )) return null;
  const packetId = record.review_packet_id;
  if (packetId !== undefined && (typeof packetId !== "string" || !/^[0-9a-f]{64}$/.test(packetId))) {
    return null;
  }
  if ((reviewGeneration === undefined) !== (packetId === undefined)) return null;
  return draft === null
    ? null
    : {
        ...draft,
        id,
        agent: record.agent.trim(),
        ...(reviewGeneration === undefined
          ? {}
          : { review_generation: reviewGeneration, review_packet_id: packetId as string }),
      };
}

function parseStoredAssessment(raw: unknown): PriorFindingAssessment | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const findingId = typeof record.finding_id === "string" ? record.finding_id.trim() : "";
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (findingId === "" || reason === "") return null;
  if (!(PRIOR_FINDING_VERDICTS as readonly unknown[]).includes(record.verdict)) return null;
  return {
    finding_id: findingId,
    verdict: record.verdict as PriorFindingAssessment["verdict"],
    reason,
  };
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
  // Destructured rather than cast: this is the READ boundary, and the check
  // above is what makes the non-emptiness true. Narrowing it here is how the
  // proof reaches the type instead of being re-asserted by every caller.
  const [head, ...tail] = refutations;
  if (head === undefined) return null;
  const nonEmpty: NonEmptyRefutations = [head, ...tail];
  return { finding, refutations: nonEmpty };
}

function parseStoredResolution(raw: unknown): ResolvedFinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const finding = parseStoredFinding(record.finding);
  if (finding === null || typeof record.resolution !== "object" || record.resolution === null ||
      Array.isArray(record.resolution)) return null;
  const resolution = record.resolution as Record<string, unknown>;
  if (resolution.kind !== "resolved_by_remediation") return null;
  if (typeof resolution.generation !== "number" || !Number.isInteger(resolution.generation) ||
      resolution.generation < 0) return null;
  if (finding.review_generation !== undefined && resolution.generation <= finding.review_generation) return null;
  if (typeof resolution.packet_id !== "string" || !/^[0-9a-f]{64}$/.test(resolution.packet_id)) return null;
  if (typeof resolution.head_sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(resolution.head_sha)) return null;
  if (!Array.isArray(resolution.expected_agents) || resolution.expected_agents.length === 0 ||
      resolution.expected_agents.some((agent) => typeof agent !== "string" || agent.trim() === "") ||
      new Set(resolution.expected_agents).size !== resolution.expected_agents.length) return null;
  const [firstExpectedAgent, ...remainingExpectedAgents] = resolution.expected_agents as string[];
  if (firstExpectedAgent === undefined) return null;
  const expectedAgents = [firstExpectedAgent, ...remainingExpectedAgents];
  if (!Array.isArray(resolution.assessments) || resolution.assessments.length === 0) return null;
  const assessments = resolution.assessments.map((raw) => {
    const assessment = parseStoredAssessment(raw);
    if (assessment === null || typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const agent = typeof (raw as Record<string, unknown>).agent === "string"
      ? ((raw as Record<string, unknown>).agent as string).trim()
      : "";
    return agent === "" ? null : { ...assessment, agent };
  });
  if (assessments.some((assessment) => assessment === null)) return null;
  const parsed = assessments as FindingResolutionAssessment[];
  if (parsed.some((assessment) => assessment.finding_id !== finding.id ||
      assessment.verdict !== "resolved_by_remediation")) return null;
  if (new Set(parsed.map((assessment) => assessment.agent)).size !== parsed.length) return null;
  if (parsed.length !== expectedAgents.length ||
      parsed.some((assessment, index) => assessment.agent !== expectedAgents[index])) return null;
  const [first, ...rest] = parsed;
  if (first === undefined) return null;
  return {
    finding,
    resolution: {
      kind: "resolved_by_remediation",
      generation: resolution.generation,
      packet_id: resolution.packet_id,
      head_sha: resolution.head_sha,
      expected_agents: [firstExpectedAgent, ...remainingExpectedAgents],
      assessments: [first, ...rest],
    },
  };
}

/**
 * Repair-path parse of `Task.findings`: malformed entries are DROPPED.
 *
 * Only a `fixFull` repair caller should reach this. The LOAD path fails loudly
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

/** Repair-path parse of `Task.resolved_findings`. */
export function parseStoredResolutions(raw: unknown): ResolvedFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseStoredResolution)
    .filter((record): record is ResolvedFinding => record !== null);
}

/**
 * Recover a valid nested finding from a malformed remediation record. The
 * remediation audit is unusable, so the finding returns to the active set
 * rather than disappearing with the broken envelope.
 */
export function salvageFindingsFromMalformedResolutions(raw: unknown): readonly Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (parseStoredResolution(entry) !== null) return [];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const finding = parseStoredFinding((entry as Record<string, unknown>).finding);
    return finding === null ? [] : [finding];
  });
}

/**
 * Recover a valid nested finding from a malformed refutation record. The audit
 * decision is unusable, so the finding returns to the active set rather than
 * disappearing with the broken envelope.
 */
export function salvageFindingsFromMalformedRefutations(raw: unknown): readonly Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (parseStoredRefutation(entry) !== null) return [];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const finding = parseStoredFinding((entry as Record<string, unknown>).finding);
    return finding === null ? [] : [finding];
  });
}

/** The repair a rejected task graph needs, named in the diagnostic itself. */
const REPAIR_HINT = "repair and install atomically with: helper repair-task-graph";

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
 * Load-boundary check that a derived view is what its type claims: absent, or
 * an array of strings.
 *
 * Split out because the lockstep comparison below used to FILTER non-strings
 * out before comparing, which reported a malformed view as in step. The graph
 * then loaded, `types.ts`' `readonly string[]` was a lie, and
 * `complete-wave-gate`'s `checkCriticalFindings` threw `f.trim is not a
 * function` from inside the gate — an unhandled TypeError, which is the precise
 * failure mode the load boundary exists to convert into a diagnostic.
 */
export function findingsViewError(raw: unknown, label: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return `${label} must be an array of strings when present`;
  const index = raw.findIndex((claim) => typeof claim !== "string");
  return index < 0
    ? null
    : `${label}[${index}] must be a string, got ${JSON.stringify(raw[index])} (${REPAIR_HINT})`;
}

/**
 * Load-boundary check that `findings` and its two `string[]` views agree.
 *
 * `types.ts` calls the views DERIVED, six writers keep them so, and both the
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
    // Shape FIRST, and as an error rather than a filter: a non-string in the
    // view is not something to quietly skip past on the way to a multiset
    // comparison — it is the defect. Checked here rather than only in
    // `taskUnionError` so both entry points are covered by one rule.
    const shapeError = findingsViewError(view, `${label}: ${severity}_findings`);
    if (shapeError !== null) return shapeError;
    const claims = (view ?? []) as readonly string[];
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
  if (index >= 0) {
    return `${label}[${index}] is not a well-formed refutation record (${REPAIR_HINT})`;
  }
  // Within `refuted_findings`, for the reason `findingsUnionError` proves it
  // within `findings`: two records under one id attach two different verdicts
  // to the same claim, and the audit trail can no longer say which was applied.
  const ids = raw.map((entry) => parseStoredRefutation(entry)!.finding.id);
  const duplicate = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  return duplicate < 0
    ? null
    : `${label}[${duplicate}] repeats refuted finding id '${ids[duplicate]}' (${REPAIR_HINT})`;
}

/** Load-boundary check for findings retired because a later implementation fixed them. */
export function resolutionsUnionError(raw: unknown, label: string): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return `${label} must be an array when present`;
  const index = raw.findIndex((entry) => parseStoredResolution(entry) === null);
  if (index >= 0) return `${label}[${index}] is not a well-formed resolution record (${REPAIR_HINT})`;
  const ids = raw.map((entry) => parseStoredResolution(entry)!.finding.id);
  const duplicate = ids.findIndex((id, at) => ids.indexOf(id) !== at);
  return duplicate < 0
    ? null
    : `${label}[${duplicate}] repeats resolved finding id '${ids[duplicate]}' (${REPAIR_HINT})`;
}

function parseStoredDraft(raw: unknown): DraftFinding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const severity = parseFindingSeverity(record.severity);
  return severity === null || typeof record.claim !== "string"
    ? null
    : makeDraftFinding({ severity, claim: record.claim, file: record.file, line: record.line });
}

/** Prove the packet-bound in-progress review run before the Task cast. */
export function reviewRunError(
  raw: unknown,
  taskGeneration: unknown,
  rawFindings: unknown,
  label: string,
): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${label} must be an object`;
  const run = raw as Record<string, unknown>;
  if (typeof run.generation !== "number" || !Number.isInteger(run.generation) || run.generation < 0) {
    return `${label}.generation must be a non-negative integer`;
  }
  if (run.generation !== taskGeneration) return `${label}.generation must equal task review_generation`;
  if (typeof run.packet_id !== "string" || !/^[0-9a-f]{64}$/.test(run.packet_id)) {
    return `${label}.packet_id must be a lowercase SHA-256 digest`;
  }
  if (typeof run.head_sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(run.head_sha)) {
    return `${label}.head_sha must be an exact Git SHA`;
  }
  if (!Array.isArray(run.expected_agents) || run.expected_agents.length === 0 ||
      run.expected_agents.some((agent) => typeof agent !== "string" || agent.trim() === "")) {
    return `${label}.expected_agents must be a non-empty array of non-empty strings`;
  }
  if (new Set(run.expected_agents).size !== run.expected_agents.length) return `${label}.expected_agents must be unique`;
  const expectedAgents = run.expected_agents as string[];
  if (!Array.isArray(run.prior_finding_ids) || run.prior_finding_ids.some((id) => typeof id !== "string" || id.trim() === "")) {
    return `${label}.prior_finding_ids must be an array of non-empty strings`;
  }
  if (new Set(run.prior_finding_ids).size !== run.prior_finding_ids.length) return `${label}.prior_finding_ids must be unique`;
  const priorIds = run.prior_finding_ids as string[];
  const activeIds = Array.isArray(rawFindings)
    ? rawFindings.flatMap((entry) => {
        const finding = parseStoredFinding(entry);
        return finding === null ? [] : [finding.id];
      })
    : [];
  if (priorIds.length !== activeIds.length || priorIds.some((id, index) => id !== activeIds[index])) {
    return `${label}.prior_finding_ids must exactly snapshot the active findings in order`;
  }
  if (!Array.isArray(run.evidence)) return `${label}.evidence must be an array`;
  const evidenceAgents: string[] = [];
  for (const [index, rawEvidence] of run.evidence.entries()) {
    const evidenceLabel = `${label}.evidence[${index}]`;
    if (typeof rawEvidence !== "object" || rawEvidence === null || Array.isArray(rawEvidence)) {
      return `${evidenceLabel} must be an object`;
    }
    const evidence = rawEvidence as Record<string, unknown>;
    if (typeof evidence.agent !== "string" || !expectedAgents.includes(evidence.agent)) {
      return `${evidenceLabel}.agent must be expected by this run`;
    }
    evidenceAgents.push(evidence.agent);
    if (!Array.isArray(evidence.prior_assessments)) return `${evidenceLabel}.prior_assessments must be an array`;
    const assessments = evidence.prior_assessments.map(parseStoredAssessment);
    if (assessments.some((assessment) => assessment === null)) return `${evidenceLabel}.prior_assessments is malformed`;
    const ids = (assessments as PriorFindingAssessment[]).map((assessment) => assessment.finding_id);
    if (ids.length !== priorIds.length || ids.some((id, at) => id !== priorIds[at])) {
      return `${evidenceLabel}.prior_assessments must cover every prior finding exactly once in order`;
    }
    if (!Array.isArray(evidence.new_findings) || evidence.new_findings.some((draft) => parseStoredDraft(draft) === null)) {
      return `${evidenceLabel}.new_findings must be well-formed draft findings`;
    }
  }
  if (new Set(evidenceAgents).size !== evidenceAgents.length) return `${label}.evidence repeats a reviewer`;
  return null;
}

/**
 * Load-boundary proof of the review record's biconditional:
 * `review_status === "evidence_capture_failed"` iff `review_evidence_failures`
 * names at least one reviewer. `review_error`, when present, belongs only to
 * that failed state and must carry a non-empty diagnostic.
 *
 * Both directions matter and both are silent when broken. A status with no named
 * agent is UNCLEARABLE — `mergeFindings` drops the merging agent from the set
 * and only leaves the failed status once the set empties, so an empty set beside
 * the status would either stick forever or be read as "no outstanding failures"
 * and demote the task to `passed`, which is the data loss the field was added to
 * close. Named agents under any OTHER status is the same defect wearing a
 * passing record: a reviewer whose transcript nobody could parse, on a task the
 * gate is about to advance.
 *
 * A named failure must also be retryable: packet-bound failures belong to that
 * run's expected batch, while legacy failures belong to the configured reviewer
 * roster supplied by the state boundary.
 *
 * Lives here, with the other aggregate rules, so `taskUnionError` and
 * `validate-task-graph` enforce it from one definition.
 */
export function evidenceFailureError(
  t: Record<string, unknown>,
  label: string,
  configuredReviewers: ReadonlySet<string>,
): string | null {
  const raw = t.review_evidence_failures;
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.some((agent) => typeof agent !== "string" || agent.trim() === "")) {
      return `${label}: review_evidence_failures must be an array of non-empty strings when present`;
    }
    const duplicate = raw.findIndex((agent, at) => raw.indexOf(agent) !== at);
    if (duplicate >= 0) return `${label}: review_evidence_failures repeats '${raw[duplicate]}'`;
    const run = typeof t.review_run === "object" && t.review_run !== null && !Array.isArray(t.review_run)
      ? t.review_run as Record<string, unknown>
      : null;
    const expected = Array.isArray(run?.expected_agents) &&
      run.expected_agents.every((agent) => typeof agent === "string")
      ? new Set(run.expected_agents as string[])
      : null;
    const allowed = expected ?? configuredReviewers;
    const unknown = raw.find((agent) => typeof agent === "string" && !allowed.has(agent));
    if (unknown !== undefined) {
      return expected === null
        ? `${label}: review_evidence_failures names unconfigured reviewer '${unknown}'`
        : `${label}: review_evidence_failures names reviewer '${unknown}' outside the active review run`;
    }
  }
  const outstanding = Array.isArray(raw) ? raw.length : 0;
  const failed = t.review_status === "evidence_capture_failed";
  const reviewError = t.review_error;
  if (reviewError !== undefined && (typeof reviewError !== "string" || reviewError.trim() === "")) {
    return `${label}: review_error must be a non-empty string when present`;
  }
  if (!failed && reviewError !== undefined) {
    return (
      `${label}: review_error is meaningful only when review_status is evidence_capture_failed, ` +
      `not ${JSON.stringify(t.review_status ?? null)} (${REPAIR_HINT})`
    );
  }
  if (failed && outstanding === 0) {
    return (
      `${label}: review_status is evidence_capture_failed but review_evidence_failures names ` +
      `no reviewer — nothing can clear it (${REPAIR_HINT})`
    );
  }
  if (!failed && outstanding > 0) {
    return (
      `${label}: review_evidence_failures names ${outstanding} reviewer(s) whose evidence was never ` +
      `captured, but review_status is ${JSON.stringify(t.review_status ?? null)} (${REPAIR_HINT})`
    );
  }
  return null;
}

/**
 * Load-boundary check that no id is live and refuted at the same time.
 *
 * `findingsUnionError` proves uniqueness within `findings` and
 * `refutationsUnionError` within `refuted_findings`; neither can see the other
 * array, and the ACROSS case is the one with a terminal consequence. The tally's
 * replay guard builds `alreadyRefuted` from `refuted_findings` and refuses to
 * adjudicate any brief item whose id is in it — so a live finding sharing an id
 * with a refuted one can never be voted on, and the guard's own advice ("start a
 * new run directory") can never clear it. `nextOrdinal` forecloses this on the
 * minting side; a hand-edited or drifted file is not minted.
 */
export function findingIdCollisionError(
  rawFindings: unknown,
  rawRefuted: unknown,
  label: string,
  rawResolved?: unknown,
): string | null {
  const groups: ReadonlyArray<readonly [string, unknown, (entry: unknown) => Finding | null]> = [
    ["findings", rawFindings, parseStoredFinding],
    ["refuted_findings", rawRefuted, (entry) => parseStoredRefutation(entry)?.finding ?? null],
    ["resolved_findings", rawResolved, (entry) => parseStoredResolution(entry)?.finding ?? null],
  ];
  const owner = new Map<string, string>();
  for (const [group, raw, parse] of groups) {
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      const finding = parse(entry);
      if (finding === null) continue;
      const prior = owner.get(finding.id);
      if (prior !== undefined && prior !== group) {
        return prior === "findings" && group === "refuted_findings"
          ? `${label}: finding id '${finding.id}' is live but refuted_findings already holds it (${REPAIR_HINT})`
          : `${label}: finding id '${finding.id}' is present in both ${prior} and ${group} (${REPAIR_HINT})`;
      }
      owner.set(finding.id, group);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The two writers that must keep `findings` and its derived views in lockstep
// ---------------------------------------------------------------------------

// `NonEmptyRefutations` is defined in `types` and re-exported at the top of
// this module with the other shapes: the STORED shape (`RefutedFinding`) uses
// it too, so the in-flight and at-rest forms cannot disagree about whether a
// refuted finding may have zero refutations.

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
 * the narrow shape here rather than importing the wide one is what lets the
 * lockstep review writers live in the module
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
/**
 * The two `string[]` views a task carries, as a LABELLED PAIR.
 *
 * They were adjacent same-typed positional parameters, and a transposed call at
 * any of the four production sites compiled cleanly while reattributing every
 * recovered claim to the wrong severity — silently turning a critical that
 * blocks the wave gate into an advisory that does not. `CriterionScore` in
 * `panel-contract` is a pair for exactly this reason.
 */
export type SeverityViews = Readonly<{
  critical: readonly string[] | undefined;
  advisory: readonly string[] | undefined;
}>;

export function recoverViewOnlyClaims(
  findings: readonly Finding[],
  refuted: readonly RefutedFinding[],
  views: SeverityViews,
  resolved: readonly ResolvedFinding[] = [],
): readonly Finding[] {
  const { critical, advisory } = viewOnlyClaims(findings, views.critical, views.advisory);
  const drafts = draftsFromClaims(critical, advisory);
  return drafts.length === 0
    ? []
    : attributeFindings(
        drafts,
        RECOVERED_AGENT,
        nextOrdinal(findings, refuted, RECOVERED_AGENT, resolved),
      );
}

/** The view claims no structured finding accounts for, by severity. */
function viewOnlyClaims(
  findings: readonly Finding[],
  criticalView: readonly string[] | undefined,
  advisoryView: readonly string[] | undefined,
): { readonly critical: readonly string[]; readonly advisory: readonly string[] } {
  // Normalized before comparison, because the view is RAW disk text while every
  // claim in `findings` went through `makeDraftFinding`. Without this a view
  // claim differing only by an internal whitespace run read as an orphan, and
  // `--fix` minted a SECOND finding for a claim that was already identified —
  // turning one critical the panel must refute into two. `collapseWhitespace` is
  // idempotent, so a view that is already normalized is unaffected.
  return {
    critical: removeOnce(
      (criticalView ?? []).map(collapseWhitespace),
      claimsOfSeverity(findings, "critical"),
    ),
    advisory: removeOnce(
      (advisoryView ?? []).map(collapseWhitespace),
      claimsOfSeverity(findings, "advisory"),
    ),
  };
}

/**
 * The view-only claims `recoverViewOnlyClaims` cannot mint identity for.
 *
 * `makeDraftFinding` returns null for an empty claim and for a no-findings
 * sentinel ("none", "n/a", …), so those orphans are dropped rather than
 * recovered — and `fixTaskFindings` computed its `dropped` count purely from
 * the `findings` array, so it stayed 0 and nothing was said. That silence
 * mattered: `checkCriticalFindings` filters only on non-empty text, NOT on
 * sentinels, so a pre-identity task holding `critical_findings: ["none"]`
 * BLOCKS the wave gate before `--fix` and PASSES it after, with nothing on
 * stdout or stderr connecting the two. The removal is right; the silence was
 * the defect. Counted here so the repair can report it like every other lossy
 * path it owns.
 */
export function unrecoverableViewClaims(
  findings: readonly Finding[],
  criticalView: readonly string[] | undefined,
  advisoryView: readonly string[] | undefined,
): readonly string[] {
  const { critical, advisory } = viewOnlyClaims(findings, criticalView, advisoryView);
  return [...critical, ...advisory].filter(
    (claim) => makeDraftFinding({ severity: "critical", claim }) === null,
  );
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
  resolved: readonly ResolvedFinding[] = [],
): readonly Finding[] {
  // Seeded with every retired id, not just the ones seen so far in this array:
  // retired identities are audit records and can never be reissued.
  const taken = new Set([
    ...refuted.map((record) => record.finding.id),
    ...resolved.map((record) => record.finding.id),
  ]);
  const kept: Finding[] = [];
  for (const finding of findings) {
    if (!taken.has(finding.id)) {
      taken.add(finding.id);
      kept.push(finding);
      continue;
    }
    // `nextOrdinal` reads only `kept` and `refuted`, so on its own it can hand
    // back an ordinal a LATER, still-unprocessed finding already holds:
    // ["x-1","x-1","x-2"] re-minted the second x-1 as x-2 and produced a graph
    // `findingsUnionError` still rejects — pointing the operator at THIS repair.
    // Advancing past every id already taken is what makes the repair actually
    // clear the rejection, in one pass, for any input.
    let ordinal = nextOrdinal(kept, refuted, finding.agent, resolved);
    let reminted = attributeFindings([finding], finding.agent, ordinal)[0]!;
    while (taken.has(reminted.id)) {
      ordinal += 1;
      reminted = attributeFindings([finding], finding.agent, ordinal)[0]!;
    }
    taken.add(reminted.id);
    kept.push(reminted);
  }
  return kept;
}

export type ReviewRunTransition =
  | { readonly ok: true; readonly task: Task; readonly completed: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * What binds one reviewer batch to the packet it must assess.
 *
 * `packetId` and `headSha` keep the nominal brands their smart constructors
 * mint. They were plain `string` here, which discarded — at exactly the
 * boundary where a run is created — the separation `review-packet.ts` exists
 * to provide: two adjacent hex strings that a transposed call would have
 * type-checked straight through. The brands mean the format is now proven by
 * construction rather than re-asserted with a regex that could drift from the
 * parsers'.
 */
export interface ReviewRunBinding {
  readonly generation: number;
  readonly packetId: PacketId;
  readonly headSha: HeadSha;
  readonly expectedAgents: readonly string[];
}

/**
 * Authoritative finding snapshot for a packet-bound review. Legacy view-only
 * claims receive identity before packet serialization and run creation so the
 * reviewer sees exactly the ids the run later requires it to assess.
 */
export function reviewRunPriorFindings(task: Task): readonly Finding[] {
  const stored = task.findings ?? [];
  return [
    ...stored,
    ...recoverViewOnlyClaims(
      stored,
      task.refuted_findings ?? [],
      { critical: task.critical_findings, advisory: task.advisory_findings },
      task.resolved_findings ?? [],
    ),
  ];
}

/** Begin one immutable-packet reviewer batch, snapshotting every active finding. */
export function startReviewRun(task: Task, binding: ReviewRunBinding): ReviewRunTransition {
  const existing = task.review_run;
  if (existing !== undefined) {
    return existing.packet_id === binding.packetId && existing.generation === binding.generation
      ? { ok: true, task, completed: false }
      : { ok: false, error: `task ${task.id} already has review packet ${existing.packet_id} in progress` };
  }
  if ((task.review_generation ?? 0) !== binding.generation) {
    return {
      ok: false,
      error: `task ${task.id} review generation changed from ${binding.generation} to ${task.review_generation ?? 0}`,
    };
  }
  // The brands make a TRANSPOSITION a compile error; these checks remain for
  // the one thing a compile-time brand cannot cover — a value smuggled in by
  // an `as` cast rather than through `parsePacketId`/`parseHeadSha`.
  if (!/^[0-9a-f]{64}$/.test(binding.packetId)) return { ok: false, error: "review packet id is invalid" };
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(binding.headSha)) return { ok: false, error: "review head SHA is invalid" };
  if (binding.expectedAgents.length === 0 || new Set(binding.expectedAgents).size !== binding.expectedAgents.length ||
      binding.expectedAgents.some((agent) => agent.trim() === "")) {
    return { ok: false, error: "review run expected agents must be non-empty and unique" };
  }
  const [firstAgent, ...remainingAgents] = binding.expectedAgents;
  if (firstAgent === undefined) return { ok: false, error: "review run expected agents must be non-empty" };
  const findings = [...reviewRunPriorFindings(task)];
  return {
    ok: true,
    completed: false,
    task: {
      ...task,
      review_status: "pending",
      review_generation: binding.generation,
      review_error: undefined,
      review_evidence_failures: undefined,
      findings,
      critical_findings: [...claimsOfSeverity(findings, "critical")],
      advisory_findings: [...claimsOfSeverity(findings, "advisory")],
      review_run: {
        generation: binding.generation,
        packet_id: binding.packetId,
        head_sha: binding.headSha,
        expected_agents: [firstAgent, ...remainingAgents],
        prior_finding_ids: findings.map((finding) => finding.id),
        evidence: [],
      },
    },
  };
}

function sameFindingContent(left: DraftFinding, right: DraftFinding): boolean {
  return left.severity === right.severity &&
    left.claim === right.claim &&
    left.file === right.file &&
    left.line === right.line;
}

/**
 * Attribute each expected agent's genuinely-new findings onto the active list.
 *
 * "Genuinely new" is judged against `priorFindings` — the list as it stood
 * BEFORE this run — not against the accumulating result, so two agents
 * reporting the same defect each get their own attributed finding rather than
 * the second silently vanishing into the first. Ordinals continue from the
 * active list plus the refuted and resolved sets, so an id is never reused.
 *
 * Shared by `preserveAcceptedReviewRunFindings` (incomplete packet retired)
 * and `finalizeReviewRun` (complete roster landed); they differ only in
 * whether missing evidence is tolerated and in which resolved set the ordinal
 * counts against.
 */
function appendAttributedNewFindings(
  task: Task,
  run: ReviewRun,
  active: readonly Finding[],
  priorFindings: readonly Finding[],
  resolved: readonly ResolvedFinding[],
  requireEvidence: boolean,
): Finding[] {
  let next = [...active];
  for (const agent of run.expected_agents) {
    const evidence = run.evidence.find((candidate) => candidate.agent === agent);
    if (evidence === undefined) {
      if (requireEvidence) throw new Error(`review run for task ${task.id} is missing evidence from ${agent}`);
      continue;
    }
    const genuinelyNew = evidence.new_findings.filter((draft) =>
      !priorFindings.some((finding) => sameFindingContent(finding, draft))
    );
    next = [...next, ...attributeFindings(
      genuinelyNew,
      agent,
      nextOrdinal(next, task.refuted_findings ?? [], agent, resolved),
      { generation: run.generation, packetId: run.packet_id },
    )];
  }
  return next;
}

/**
 * Materialize only the NEW findings from reviewer evidence already accepted by
 * an incomplete packet. Prior-finding resolution still requires the complete
 * roster and is therefore deliberately not applied here. Used when an
 * exhausted packet is retired so accepted criticals remain auditable instead
 * of disappearing with `review_run`.
 */
export function preserveAcceptedReviewRunFindings(task: Task): Task {
  const run = task.review_run;
  if (run === undefined || run.evidence.length === 0) return task;
  const priorFindings = task.findings ?? [];
  const active = appendAttributedNewFindings(
    task,
    run,
    priorFindings,
    priorFindings,
    task.resolved_findings ?? [],
    false,
  );
  return {
    ...task,
    findings: active,
    critical_findings: [...claimsOfSeverity(active, "critical")],
    advisory_findings: [...claimsOfSeverity(active, "advisory")],
  };
}

function finalizeReviewRun(task: Task, run: ReviewRun): Task {
  const prior = new Map((task.findings ?? []).map((finding) => [finding.id, finding]));
  const resolvedIds = new Set(run.prior_finding_ids.filter((id) => {
    const finding = prior.get(id);
    return finding !== undefined &&
      (finding.review_generation === undefined || run.generation > finding.review_generation) &&
      run.evidence.every((evidence) =>
        evidence.prior_assessments.find((assessment) => assessment.finding_id === id)?.verdict ===
          "resolved_by_remediation"
      );
  }));
  const retired: ResolvedFinding[] = run.prior_finding_ids.flatMap((id) => {
    const finding = prior.get(id);
    if (finding === undefined || !resolvedIds.has(id)) return [];
    const assessments = run.expected_agents.map((agent) => {
      const evidence = run.evidence.find((candidate) => candidate.agent === agent)!;
      return {
        ...evidence.prior_assessments.find((assessment) => assessment.finding_id === id)!,
        agent,
      };
    });
    const [firstAssessment, ...remainingAssessments] = assessments;
    if (firstAssessment === undefined) return [];
    return [{
      finding,
      resolution: {
        kind: "resolved_by_remediation" as const,
        generation: run.generation,
        packet_id: run.packet_id,
        head_sha: run.head_sha,
        expected_agents: run.expected_agents,
        assessments: [firstAssessment, ...remainingAssessments],
      },
    }];
  });
  const resolved = [...(task.resolved_findings ?? []), ...retired];
  const priorFindings = task.findings ?? [];
  const active = appendAttributedNewFindings(
    task,
    run,
    priorFindings.filter((finding) => !resolvedIds.has(finding.id)),
    priorFindings,
    resolved,
    true,
  );
  return {
    ...task,
    review_status: active.some((finding) => finding.severity === "critical") ? "blocked" : "passed",
    review_error: undefined,
    review_evidence_failures: undefined,
    review_run: undefined,
    findings: active,
    critical_findings: [...claimsOfSeverity(active, "critical")],
    advisory_findings: [...claimsOfSeverity(active, "advisory")],
    resolved_findings: resolved,
  };
}

/** Stage one reviewer atomically; activate changes only after the full roster lands. */
export function recordReviewRunEvidence(
  task: Task,
  packetId: string,
  generation: number,
  evidence: ReviewRunEvidence,
): ReviewRunTransition {
  const run = task.review_run;
  if (run === undefined) return { ok: false, error: `task ${task.id} has no review run in progress` };
  if (run.packet_id !== packetId || run.generation !== generation) {
    return { ok: false, error: `stale review evidence for task ${task.id} was ignored` };
  }
  if (!run.expected_agents.includes(evidence.agent)) {
    return { ok: false, error: `${evidence.agent} is not expected by review packet ${packetId}` };
  }
  if (run.evidence.some((stored) => stored.agent === evidence.agent)) {
    return { ok: false, error: `${evidence.agent} already supplied evidence for review packet ${packetId}` };
  }
  const assessmentIds = evidence.prior_assessments.map((assessment) => assessment.finding_id);
  if (assessmentIds.length !== run.prior_finding_ids.length ||
      assessmentIds.some((id, index) => id !== run.prior_finding_ids[index])) {
    return {
      ok: false,
      error: `${evidence.agent} must assess every prior finding exactly once in packet order`,
    };
  }
  const prior = new Map((task.findings ?? []).map((finding) => [finding.id, finding]));
  const contradictory = evidence.prior_assessments.find((assessment) => {
    if (assessment.verdict !== "resolved_by_remediation") return false;
    const finding = prior.get(assessment.finding_id);
    return finding !== undefined && evidence.new_findings.some((draft) => sameFindingContent(finding, draft));
  });
  if (contradictory !== undefined) {
    return {
      ok: false,
      error: (
        `${evidence.agent} cannot mark prior finding ${contradictory.finding_id} resolved_by_remediation ` +
        "and re-emit the identical finding"
      ),
    };
  }
  const nextRun: ReviewRun = { ...run, evidence: [...run.evidence, evidence] };
  const complete = nextRun.expected_agents.every((agent) =>
    nextRun.evidence.some((stored) => stored.agent === agent)
  );
  const outstanding = (task.review_evidence_failures ?? []).filter((agent) => agent !== evidence.agent);
  const staged: Task = {
    ...task,
    review_status: outstanding.length > 0 ? "evidence_capture_failed" : "pending",
    ...(outstanding.length > 0
      ? { review_evidence_failures: outstanding }
      : { review_error: undefined, review_evidence_failures: undefined }),
    review_run: nextRun,
  };
  return complete
    ? { ok: true, task: finalizeReviewRun(staged, nextRun), completed: true }
    : { ok: true, task: staged, completed: false };
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
  if (task.review_run !== undefined) {
    throw new Error(
      `findings invariant: unbound merge cannot mutate active packet ${task.review_run.packet_id}`,
    );
  }
  const refuted = task.refuted_findings ?? [];
  // A pre-identity task's claims live only in the views. Appending beside them
  // without migrating would leave `findings` holding strictly less than the
  // views claim — the drift the load boundary now rejects outright.
  const existing = [
    ...(task.findings ?? []),
    ...recoverViewOnlyClaims(
      task.findings ?? [],
      refuted,
      { critical: task.critical_findings, advisory: task.advisory_findings },
      task.resolved_findings ?? [],
    ),
  ];
  const attributed = attributeFindings(
    findings.drafts,
    agent,
    nextOrdinal(existing, refuted, agent, task.resolved_findings ?? []),
  );
  const merged = [...existing, ...attributed];

  // THIS reviewer's evidence landed, so it is no longer outstanding. Any other
  // reviewer's still is: `evidence_capture_failed` records a transcript nobody
  // could parse, and a sibling's clean pass is not evidence about it. Erasing
  // the status here — which is what happened while it was a bare per-task
  // value — made the gate outcome depend on which reviewer finished last.
  const outstanding = (task.review_evidence_failures ?? []).filter((failed) => failed !== agent);

  // Either source may say "blocked": `criticalCount` is the reviewer's own
  // tally, and the captured criticals are what the gate will actually count.
  // Trusting the tally alone let `CRITICAL_COUNT: 0` beside a real `CRITICAL:`
  // line record `passed` — and a task pinned at `passed` is one that
  // `applyFindingOutcomes`' promotion guard can never adjudicate.
  //
  // Counted over the MERGED set rather than this reviewer's drafts alone. While
  // the count came from the incoming drafts, clearing the last outstanding
  // evidence failure with a clean re-run demoted a task straight to `passed`
  // over criticals a different reviewer had already recorded — the status had
  // been masked by `evidence_capture_failed`, so the `blocked` branch below
  // could not see them.
  const hasCritical =
    (findings.criticalCount ?? 0) > 0 || merged.some((finding) => finding.severity === "critical");
  const reviewStatus: ReviewStatus =
    outstanding.length > 0
      ? "evidence_capture_failed"
      : task.review_status === "blocked" || hasCritical
        ? "blocked"
        : "passed";

  return {
    ...task,
    review_status: reviewStatus,
    // `review_error` describes an evidence-capture failure and nothing else.
    // A reviewer that DID emit its evidence supersedes that record — but only
    // once NO reviewer's evidence is outstanding, or the surviving failure
    // would sit at `evidence_capture_failed` with nothing saying why.
    ...(outstanding.length > 0
      ? { review_evidence_failures: outstanding }
      : { review_error: undefined, review_evidence_failures: undefined }),
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
  // A type PREDICATE, not a bare boolean filter: `AdjudicatedFinding` is a
  // union whose `survives: false` arm carries `NonEmptyRefutations`, and only a
  // predicate carries that narrowing through to the records built below. With a
  // plain filter the compiler kept the widened `readonly Refutation[]` and the
  // stored record's non-emptiness had to be re-asserted by hand — which is how
  // the invariant went missing from `RefutedFinding` in the first place.
  const refutedHere = (
    outcome: AdjudicatedFinding,
  ): outcome is Extract<AdjudicatedFinding, { survives: false }> =>
    outcome.finding.taskId === task.id && !outcome.survives;

  const mine = outcomes.filter(refutedHere);
  if (mine.length === 0) return task;
  if (task.review_run !== undefined) {
    throw new Error(
      `findings invariant: cannot adjudicate ${task.id} while review packet ${task.review_run.packet_id} is still collecting evidence`,
    );
  }

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
    critical_findings: viewAfterRemoval(task.critical_findings, kept, removed, "critical"),
    advisory_findings: viewAfterRemoval(task.advisory_findings, kept, removed, "advisory"),
    refuted_findings: [...(task.refuted_findings ?? []), ...refutedRecords],
  };
}

/**
 * The derived view after a refutation: `kept`'s claims, plus anything the old
 * view held that no live finding accounts for.
 *
 * Not `removeOnce(oldView, removedClaims)`. That conserved the right COUNT and
 * silently reordered: `removeOnce` deletes the FIRST occurrence of a claim while
 * `kept` deletes the one at the refuted index, so two findings wording a claim
 * identically — which the multiset comparison exists precisely because reviewers
 * do — left the view in a different order than the array it summarizes. Given
 * findings `[!, B, !, B]` and a refutation of the SECOND `B`, the array became
 * `[!, B, !]` and the view `[!, !, B]`.
 *
 * `findingsLockstepError` compares as a multiset, so the load boundary accepted
 * it and nothing failed — but `--fix` re-derives the views from `findings`, so
 * the next repair rewrote the file to no purpose, and any reader pairing the two
 * by position reads one finding's claim against another's identity.
 *
 * Deriving from `kept` makes the order right by construction. The leftover term
 * is what `removeOnce` was really buying: a pre-identity task can hold view
 * claims no structured finding accounts for, and dropping those would delete a
 * critical the wave gate counts. They are conserved, after the derived claims,
 * exactly as `recoverViewOnlyClaims` would later find them.
 */
function viewAfterRemoval(
  oldView: readonly string[] | undefined,
  kept: readonly Finding[],
  removed: readonly Finding[],
  severity: FindingSeverity,
): readonly string[] {
  const derived = claimsOfSeverity(kept, severity);
  const survivingView = removeOnce(oldView ?? [], claimsOfSeverity(removed, severity));
  const orphans = removeOnce(survivingView, derived);
  return orphans.length === 0 ? derived : [...derived, ...orphans];
}
