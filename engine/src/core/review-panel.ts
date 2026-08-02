/**
 * The adversarial review panel — consumer 2 of the panel kernel.
 *
 * The wave gate spawns five reviewers per task. Each produces findings; nothing
 * adjudicates them. A plausible-but-wrong finding costs a real remediation
 * cycle, and loom has been working around that with prompt patches — the
 * delta-review strategy for multi-pass PRs, the architectural-intent briefing
 * that tells agents never-throw / fail-closed / ADT patterns are deliberate.
 * Both are bandages over a missing verification stage.
 *
 * This panel is that stage. N verifiers, each with a DISTINCT LENS, each
 * covering ALL of the wave's critical findings, try to REFUTE them. A finding
 * survives unless a threshold of verifiers refutes it.
 *
 * Two choices are load-bearing:
 *
 *   - **N verifiers over all findings, not N per finding.** That makes a
 *     refutation verdict structurally identical to an architecture judge's
 *     verdict — one verdict per criterion, covering every item exactly once —
 *     so the kernel's envelope validator is shared verbatim. It also costs N
 *     agents instead of N×findings, and gives each verifier enough context to
 *     spot duplicate or contradictory findings across the set.
 *   - **Ties favor keeping the finding.** A false positive costs a cycle; a
 *     false negative ships a bug. `uncertain` counts toward neither side.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { basename, join, normalize } from "node:path";
import type { Finding, FindingSeverity, RefutedFinding } from "./findings";
import type { Task } from "../types";
import {
  fail,
  isRecord,
  ok,
  parseCriteriaSet,
  parseVerdictEnvelope,
  sanitizeProse,
  type ParseResult,
  type VerdictEnvelope,
} from "./panel-kernel";

// ---------------------------------------------------------------------------
// Lenses
// ---------------------------------------------------------------------------

/**
 * Order matters twice: signal-selected lenses come first (see
 * selectReviewLenses), then this order fills the remaining slots. The first
 * three are therefore the default unsignalled panel — cause, intent,
 * consequence — which is the smallest set that covers the three ways a finding
 * is wrong on its own terms. `security` and `test-coverage` sit below them
 * because an unsignalled finding set has no security or test surface for them
 * to judge; when it does, the signals pull them up regardless of this order.
 */
export const REVIEW_LENSES = [
  /** Can the failure actually be triggered? */
  "reproduction",
  /** Is this deliberate architecture — never-throw, fail-closed, ADTs? */
  "intent",
  /** Does the claimed consequence follow from the claimed cause? */
  "blast-radius",
  /** Does the claimed security consequence hold? */
  "security",
  /** Is the testing claim about real risk or academic completeness? */
  "test-coverage",
] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

/**
 * `intent` exists specifically to kill the false positives the
 * architectural-intent briefing currently hand-patches — as a lens with a vote,
 * not a prompt preamble. `reproduction` is the other baseline: a finding whose
 * failure cannot be triggered is not a finding.
 */
const BASELINE_LENSES: readonly ReviewLens[] = ["reproduction", "intent"];

/** Minimum viable panel: the two baseline lenses. */
export const REVIEW_LENSES_MIN = BASELINE_LENSES.length;

/** Default panel size — the two baselines plus one signal-selected lens. */
export const REVIEW_LENSES_DEFAULT = 3;

export function parseReviewLens(raw: unknown): ReviewLens | null {
  return typeof raw === "string" && (REVIEW_LENSES as readonly string[]).includes(raw)
    ? (raw as ReviewLens)
    : null;
}

/**
 * Only CRITICAL findings are verified. Advisories skip the panel: they do not
 * block the gate, so refuting one saves nothing and the quota it burns is real
 * (N extra agents per wave against a subscription rate-limit window).
 * Revisit once the false-positive rate is measured.
 */
export const VERIFIED_SEVERITY: FindingSeverity = "critical";

const SENSITIVE_PATH =
  /auth|crypt|secret|token|password|credential|jwt|oauth|session|security|sanitiz|escap|injection/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.(java|kt)$|_test\.(go|py|rs)$/i;

/** Signals a finding set carries, mirroring the architecture panel's
 *  interview-driven lens selection — derived from data, never chosen by hand. */
export interface ReviewSignals {
  readonly touchesSensitiveBoundary: boolean;
  readonly touchesTests: boolean;
}

export function reviewSignals(findings: readonly BriefFinding[]): ReviewSignals {
  return {
    touchesSensitiveBoundary: findings.some(
      (f) => SENSITIVE_PATH.test(f.file ?? "") || SENSITIVE_PATH.test(f.claim),
    ),
    touchesTests: findings.some((f) => TEST_PATH.test(f.file ?? "")),
  };
}

/**
 * Derive the exact ordered lens set from the finding set and N. Same shape as
 * the architecture panel's selectPanelLenses: baselines first, then
 * signal-driven lenses in priority order, then the table order fills the rest.
 */
export function selectReviewLenses(
  signals: ReviewSignals,
  lensCount: number,
): ParseResult<readonly ReviewLens[]> {
  if (!Number.isInteger(lensCount) || lensCount < REVIEW_LENSES_MIN || lensCount > REVIEW_LENSES.length) {
    return fail([`lens count must be an integer from ${REVIEW_LENSES_MIN} to ${REVIEW_LENSES.length}`]);
  }
  const selected: ReviewLens[] = [...BASELINE_LENSES];
  const signalLenses: readonly (ReviewLens | null)[] = [
    signals.touchesSensitiveBoundary ? "security" : null,
    signals.touchesTests ? "test-coverage" : null,
  ];
  for (const lens of [...signalLenses, ...REVIEW_LENSES]) {
    if (lens && !selected.includes(lens)) selected.push(lens);
  }
  return ok(selected.slice(0, lensCount));
}

// ---------------------------------------------------------------------------
// The finding brief — the panel's context artifact
// ---------------------------------------------------------------------------

/**
 * A finding as the panel sees it: wave-scoped id, plus its task.
 *
 * A `Finding.id` is unique within ONE task (`${agent}-${ordinal}`). The brief
 * spans a whole wave, where two tasks can each hold a `code-reviewer-1`, so the
 * panel re-scopes the id by task. Without this the envelope's coverage check
 * would silently collapse two distinct findings into one item.
 */
export interface BriefFinding {
  /** `${taskId}:${finding.id}` — unique across the wave. */
  readonly id: string;
  readonly taskId: string;
  readonly agent: string;
  readonly severity: FindingSeverity;
  readonly file: string | null;
  readonly line: number | null;
  /** Sanitized: the brief is substituted into verifier prompts. */
  readonly claim: string;
}

/** Claim text that survives sanitization as nothing. Vanishingly unlikely from
 *  a real reviewer, but dropping the finding would silently lose a critical, so
 *  the entry survives with its identity and a pointer to the raw record. */
const UNUSABLE_CLAIM = "(finding text was unusable after sanitization — see the task's critical_findings)";

export function waveFindingId(taskId: string, finding: Finding): string {
  return `${taskId}:${finding.id}`;
}

/** Run-scoped artifact filename for one brief finding. Colons are not portable
 *  in filenames; the manifest asserts these are unique, so the substitution
 *  cannot silently merge two findings. */
export function briefFindingFilename(id: string): string {
  return `finding-${id.replace(/[^A-Za-z0-9_.-]+/g, "-")}.json`;
}

export interface FindingBrief {
  readonly wave: number;
  readonly severity: FindingSeverity;
  readonly taskIds: readonly string[];
  readonly findings: readonly BriefFinding[];
}

/** Collect the wave's verifiable findings from the task graph. Pure. */
export function buildFindingBrief(
  wave: number,
  tasks: readonly Task[],
  severity: FindingSeverity = VERIFIED_SEVERITY,
): FindingBrief {
  const waveTasks = tasks.filter((task) => task.wave === wave);
  const findings = waveTasks.flatMap((task) =>
    (task.findings ?? [])
      .filter((finding) => finding.severity === severity)
      .map((finding): BriefFinding => ({
        id: waveFindingId(task.id, finding),
        taskId: task.id,
        agent: finding.agent,
        severity: finding.severity,
        file: finding.file === null ? null : sanitizeProse(finding.file) || null,
        line: finding.line,
        claim: sanitizeProse(finding.claim) || UNUSABLE_CLAIM,
      })),
  );
  return { wave, severity, taskIds: waveTasks.map((task) => task.id), findings };
}

/** The external snake_case contract for the brief. */
export function serializeFindingBrief(brief: FindingBrief): string {
  return JSON.stringify({
    wave: brief.wave,
    severity: brief.severity,
    task_ids: brief.taskIds,
    findings: brief.findings.map((finding) => ({
      id: finding.id,
      task_id: finding.taskId,
      agent: finding.agent,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      claim: finding.claim,
    })),
  }, null, 2);
}

/** One finding's standalone run-scoped artifact. */
export function serializeBriefFinding(finding: BriefFinding): string {
  return JSON.stringify({
    id: finding.id,
    task_id: finding.taskId,
    agent: finding.agent,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    claim: finding.claim,
  }, null, 2);
}

/** One brief entry, parsed. Only a fully-valid entry yields a finding; the
 *  errors are collected either way so a re-run learns all of them at once. */
function parseBriefFindingEntry(
  entry: unknown,
  path: string,
  taskIds: readonly string[] | null,
): { readonly finding: BriefFinding | null; readonly errors: readonly string[] } {
  if (!isRecord(entry)) return { finding: null, errors: [`${path} must be an object`] };

  const errors: string[] = [];
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const taskId = typeof entry.task_id === "string" ? entry.task_id.trim() : "";
  const agent = typeof entry.agent === "string" ? entry.agent.trim() : "";
  const claim = typeof entry.claim === "string" ? sanitizeProse(entry.claim) : "";
  const severity = entry.severity === "critical" || entry.severity === "advisory" ? entry.severity : null;

  if (id === "") errors.push(`${path}.id must be a non-empty string`);
  if (taskId === "") errors.push(`${path}.task_id must be a non-empty string`);
  if (agent === "") errors.push(`${path}.agent must be a non-empty string`);
  if (claim === "") errors.push(`${path}.claim must be non-empty after sanitization`);
  if (severity === null) errors.push(`${path}.severity is unknown`);
  if (taskIds !== null && taskId !== "" && !taskIds.includes(taskId)) {
    errors.push(`${path}.task_id is not one of brief.task_ids: ${taskId}`);
  }
  if (id !== "" && taskId !== "" && !id.startsWith(`${taskId}:`)) {
    errors.push(`${path}.id must be scoped by its task: ${taskId}:<finding id>`);
  }

  const file = typeof entry.file === "string" && entry.file.trim() !== "" ? sanitizeProse(entry.file) : "";
  const line = Number.isInteger(entry.line) && (entry.line as number) > 0 ? (entry.line as number) : null;

  return {
    finding: errors.length === 0 && severity !== null
      ? { id, taskId, agent, severity, file: file || null, line, claim }
      : null,
    errors,
  };
}

/**
 * Re-parse the canonical brief rather than trusting the write that produced it,
 * the same discipline parseInterviewDigestJson applies: everything downstream
 * (lens selection, the manifest, the verdict envelopes) consumes only the
 * re-validated form, so the brief on disk and the panel's idea of the finding
 * set cannot diverge.
 */
export function parseFindingBriefJson(raw: unknown): ParseResult<FindingBrief> {
  if (!isRecord(raw)) return fail(["finding brief must be a JSON object"]);

  const errors: string[] = [];
  const wave = raw.wave;
  if (!Number.isInteger(wave) || (wave as number) < 1) errors.push("brief.wave must be a positive integer");

  const severity = raw.severity;
  if (severity !== "critical" && severity !== "advisory") {
    errors.push("brief.severity must be 'critical' or 'advisory'");
  }

  const taskIds = Array.isArray(raw.task_ids) && raw.task_ids.every((id) => typeof id === "string" && id.trim() !== "")
    ? (raw.task_ids as string[]).map((id) => id.trim())
    : null;
  if (taskIds === null) errors.push("brief.task_ids must be an array of non-empty strings");

  if (!Array.isArray(raw.findings)) {
    return fail([...errors, "brief.findings must be an array"]);
  }

  const findings: BriefFinding[] = [];
  for (const [index, entry] of raw.findings.entries()) {
    const parsed = parseBriefFindingEntry(entry, `brief.findings[${index}]`, taskIds);
    errors.push(...parsed.errors);
    if (parsed.finding) findings.push(parsed.finding);
  }

  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) errors.push("brief finding ids must be unique");
  const filenames = ids.map(briefFindingFilename);
  if (new Set(filenames).size !== filenames.length) {
    errors.push("brief finding ids must remain unique once mapped to filenames");
  }

  return errors.length > 0
    ? fail(errors)
    : ok({ wave: wave as number, severity: severity as FindingSeverity, taskIds: taskIds ?? [], findings });
}

/** Operator-facing rendering of the brief. Not parsed by anything — the JSON is. */
export function renderFindingBriefMarkdown(brief: FindingBrief): string {
  const lines = [
    `# Wave ${brief.wave} — ${brief.severity} findings up for refutation`,
    "",
    `**Tasks:** ${brief.taskIds.join(", ") || "(none)"}`,
    `**Findings:** ${brief.findings.length}`,
    "",
  ];
  if (brief.findings.length === 0) {
    lines.push("No findings of this severity — the panel has nothing to adjudicate.");
    return lines.join("\n") + "\n";
  }
  for (const finding of brief.findings) {
    const where = finding.file ? `${finding.file}${finding.line === null ? "" : `:${finding.line}`}` : "location not given";
    lines.push(`## ${finding.id}`, "", `- **Task:** ${finding.taskId}`, `- **Reported by:** ${finding.agent}`, `- **Where:** ${where}`, `- **Claim:** ${finding.claim}`, "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The finding manifest — the panel's item-set authority
// ---------------------------------------------------------------------------

export interface ReviewManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly filename: string;
}

export interface ReviewManifest {
  readonly runId: string;
  readonly briefFile: string;
  readonly briefJson: string;
  readonly lenses: readonly ReviewLens[];
  readonly findings: readonly ReviewManifestEntry[];
}

/**
 * The manifest fixes the finding set before verifiers spawn, so a verifier can
 * neither invent a finding nor skip one.
 *
 * Unlike the architecture panel's manifest — which the orchestrator writes,
 * because the designers' candidates do not exist until they run — this one is
 * ENGINE-authored: the findings already exist in the task graph, and the engine
 * is their only honest source. An orchestrator-built finding manifest could
 * quietly omit an inconvenient critical.
 */
export function serializeReviewManifest(
  runId: string,
  runDir: string,
  layout: { readonly contextMd: string; readonly contextJson: string; readonly itemDir: string },
  lenses: readonly ReviewLens[],
  findings: readonly BriefFinding[],
): string {
  return JSON.stringify({
    run_id: runId,
    brief_file: join(runDir, layout.contextMd),
    brief_json: join(runDir, layout.contextJson),
    lenses,
    findings: findings.map((finding) => ({
      id: finding.id,
      filename: briefFindingFilename(finding.id),
      path: join(runDir, layout.itemDir, briefFindingFilename(finding.id)),
    })),
  }, null, 2);
}

/** Parse the exact finding-set handoff and bind every path to one run root. */
export function parseReviewManifest(
  raw: unknown,
  expectedRunDir: string,
  layout: { readonly contextMd: string; readonly contextJson: string; readonly itemDir: string },
  expectedLenses: readonly ReviewLens[],
  expectedFindingIds: readonly string[],
): ParseResult<ReviewManifest> {
  if (!isRecord(raw)) return fail(["review manifest must be a JSON object"]);

  const errors: string[] = [];
  const runDir = normalize(expectedRunDir);
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  const briefFile = typeof raw.brief_file === "string" ? raw.brief_file.trim() : "";
  const briefJson = typeof raw.brief_json === "string" ? raw.brief_json.trim() : "";
  if (runId !== basename(runDir)) errors.push("manifest.run_id must equal the run directory basename");
  if (briefFile !== join(runDir, layout.contextMd)) {
    errors.push(`manifest.brief_file must exactly equal <run-dir>/${layout.contextMd}`);
  }
  if (briefJson !== join(runDir, layout.contextJson)) {
    errors.push(`manifest.brief_json must exactly equal <run-dir>/${layout.contextJson}`);
  }

  const lenses: ReviewLens[] = [];
  if (!Array.isArray(raw.lenses) || raw.lenses.length !== expectedLenses.length) {
    errors.push(`manifest.lenses must contain exactly ${expectedLenses.length} lenses`);
  } else {
    for (const [index, rawLens] of raw.lenses.entries()) {
      const lens = parseReviewLens(rawLens);
      if (lens === null) {
        errors.push(`manifest.lenses[${index}] is unknown: ${String(rawLens) || "<empty>"}`);
        continue;
      }
      lenses.push(lens);
    }
    if (new Set(lenses).size !== lenses.length) errors.push("manifest lenses must be unique");
    if (lenses.length === expectedLenses.length && lenses.some((lens, index) => lens !== expectedLenses[index])) {
      errors.push(`manifest lenses must exactly match: ${expectedLenses.join(", ")}`);
    }
  }

  if (!Array.isArray(raw.findings) || raw.findings.length !== expectedFindingIds.length) {
    errors.push(`manifest.findings must contain exactly ${expectedFindingIds.length} findings`);
  }

  const findings: ReviewManifestEntry[] = [];
  if (Array.isArray(raw.findings)) {
    for (const [index, entry] of raw.findings.entries()) {
      if (!isRecord(entry)) {
        errors.push(`manifest.findings[${index}] must be an object`);
        continue;
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
      if (!expectedFindingIds.includes(id)) {
        errors.push(`manifest.findings[${index}].id is not in the brief: ${id || "<empty>"}`);
        continue;
      }
      const expectedFilename = briefFindingFilename(id);
      if (filename !== expectedFilename) {
        errors.push(`manifest.findings[${index}].filename must equal ${expectedFilename}`);
      }
      if (path !== join(runDir, layout.itemDir, expectedFilename)) {
        errors.push(`manifest.findings[${index}].path must exactly equal its run-scoped finding path`);
      }
      findings.push({ id, path, filename });
    }
  }

  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) errors.push("manifest finding ids must be unique");
  for (const expectedId of expectedFindingIds) {
    if (!ids.includes(expectedId)) errors.push(`manifest is missing finding: ${expectedId}`);
  }
  const paths = findings.map((finding) => finding.path);
  if (new Set(paths).size !== paths.length) errors.push("manifest finding paths must be unique");

  return errors.length > 0
    ? fail(errors)
    : ok({ runId, briefFile, briefJson, lenses, findings });
}

// ---------------------------------------------------------------------------
// Refutation verdicts
// ---------------------------------------------------------------------------

export const REFUTATION_VERDICTS = ["refuted", "upheld", "uncertain"] as const;
export type RefutationKind = (typeof REFUTATION_VERDICTS)[number];

export interface RefutationVerdict {
  readonly findingId: string;
  readonly verdict: RefutationKind;
  /** Sanitized — it is substituted into the gate summary and stored in state. */
  readonly reasoning: string;
}

function parseRefutationEntry(raw: Record<string, unknown>, path: string): ParseResult<RefutationVerdict> {
  const errors: string[] = [];

  const verdict = typeof raw.verdict === "string" && (REFUTATION_VERDICTS as readonly string[]).includes(raw.verdict)
    ? (raw.verdict as RefutationKind)
    : null;
  if (verdict === null) {
    errors.push(`${path}.verdict must be one of: ${REFUTATION_VERDICTS.join(", ")}`);
  }

  const reasoning = typeof raw.reasoning === "string" ? sanitizeProse(raw.reasoning) : "";
  if (!reasoning) errors.push(`${path}.reasoning must be non-empty after sanitization`);

  return errors.length > 0
    ? fail(errors)
    : ok({
        findingId: typeof raw.finding_id === "string" ? raw.finding_id : "",
        verdict: verdict as RefutationKind,
        reasoning,
      });
}

/**
 * Parse one verifier's untrusted output. Sibling of parseJudgeVerdict: the same
 * kernel envelope, a different payload, and NO crossCheck — findings have no
 * meaningful order, so there is no cross-entry rule to enforce.
 */
export function parseRefutationVerdict(
  rawJson: string,
  expectedLens: string,
  expectedFindingIds: readonly string[],
): ParseResult<VerdictEnvelope<RefutationVerdict>> {
  return parseVerdictEnvelope<RefutationVerdict>(rawJson, expectedLens, expectedFindingIds, {
    label: "refutation verdict",
    entriesKey: "verdicts",
    itemIdKey: "finding_id",
    itemNoun: ["finding", "findings"],
    parseEntry: parseRefutationEntry,
  });
}

/** Serialize a validated verdict using the external snake_case contract. */
export function serializeRefutationVerdict(envelope: VerdictEnvelope<RefutationVerdict>): string {
  return JSON.stringify({
    criterion: envelope.criterion,
    verdicts: envelope.entries.map((entry) => ({
      finding_id: entry.findingId,
      verdict: entry.verdict,
      reasoning: entry.reasoning,
    })),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// The tally — the deterministic k-of-n decision
// ---------------------------------------------------------------------------

export interface FindingOutcome {
  readonly finding: BriefFinding;
  /** Lenses that refuted, in lens order. */
  readonly refutedBy: readonly string[];
  /** Lenses that upheld, in lens order. */
  readonly upheldBy: readonly string[];
  /** Lenses that could not decide. Counts toward neither side. */
  readonly uncertainFrom: readonly string[];
  /** One reason per refuting lens, positionally aligned with `refutedBy`. */
  readonly reasoning: readonly string[];
  readonly survives: boolean;
}

/**
 * A strict majority of the panel must refute. With 2 lenses that means
 * unanimity; with 3, two of three; with 5, three of five. Any split short of
 * the threshold — including a 1-1 tie, and including a panel that mostly said
 * `uncertain` — keeps the finding.
 */
export function defaultRefutationThreshold(lensCount: number): number {
  return Math.floor(lensCount / 2) + 1;
}

/**
 * Sibling to aggregateVerdicts, not a generalization of it: same input shape,
 * different decision. Architecture aggregation produces a TOTAL ORDER over
 * candidates; this produces a PER-ITEM verdict, and no amount of parameterizing
 * would make one function honestly express both.
 */
export function tallyRefutations(
  verdicts: readonly VerdictEnvelope<RefutationVerdict>[],
  lensesInOrder: readonly string[],
  findings: readonly BriefFinding[],
  threshold: number,
): ParseResult<readonly FindingOutcome[]> {
  const errors: string[] = [];

  // The lens set plays exactly the role the criteria set plays in the
  // architecture panel — same kernel rule, so a duplicated or missing verifier
  // is a hard error rather than a quietly weaker vote.
  const lensSet = parseCriteriaSet(verdicts.map((verdict) => verdict.criterion), lensesInOrder);
  if (!lensSet.ok) errors.push(...lensSet.errors);

  const findingIds = findings.map((finding) => finding.id);
  if (new Set(findingIds).size !== findingIds.length) errors.push("findings must be distinct");

  if (!Number.isInteger(threshold) || threshold < 1 || threshold > lensesInOrder.length) {
    errors.push(`threshold must be an integer from 1 to ${lensesInOrder.length}`);
  }

  if (errors.length > 0) return fail(errors);

  const byLens = new Map(verdicts.map((verdict) => [verdict.criterion, verdict] as const));

  // Re-check per-verdict coverage so this is safe to call standalone, not only
  // downstream of parseRefutationVerdict.
  const expected = new Set(findingIds);
  for (const lens of lensesInOrder) {
    const verdict = byLens.get(lens);
    if (!verdict) continue;
    const seen = new Set(verdict.entries.map((entry) => entry.findingId));
    const covers =
      verdict.entries.length === findingIds.length &&
      seen.size === verdict.entries.length &&
      [...seen].every((id) => expected.has(id));
    if (!covers) errors.push(`verdict for '${lens}' must judge each finding exactly once`);
  }

  if (errors.length > 0) return fail(errors);

  const outcomes = findings.map((finding): FindingOutcome => {
    const refutedBy: string[] = [];
    const upheldBy: string[] = [];
    const uncertainFrom: string[] = [];
    const reasoning: string[] = [];

    for (const lens of lensesInOrder) {
      const entry = byLens.get(lens)?.entries.find((e) => e.findingId === finding.id);
      if (!entry) continue;
      if (entry.verdict === "refuted") {
        refutedBy.push(lens);
        reasoning.push(entry.reasoning);
      } else if (entry.verdict === "upheld") {
        upheldBy.push(lens);
      } else {
        uncertainFrom.push(lens);
      }
    }

    return {
      finding,
      refutedBy,
      upheldBy,
      uncertainFrom,
      reasoning,
      survives: refutedBy.length < threshold,
    };
  });

  return ok(outcomes);
}

/** Serialize the tally for the gate summary and the operator. */
export function serializeOutcomes(
  outcomes: readonly FindingOutcome[],
  lensesInOrder: readonly string[],
  threshold: number,
): string {
  return JSON.stringify({
    lenses: lensesInOrder,
    threshold,
    surviving: outcomes.filter((outcome) => outcome.survives).length,
    refuted: outcomes.filter((outcome) => !outcome.survives).length,
    outcomes: outcomes.map((outcome) => ({
      finding_id: outcome.finding.id,
      task_id: outcome.finding.taskId,
      claim: outcome.finding.claim,
      survives: outcome.survives,
      refuted_by: outcome.refutedBy,
      upheld_by: outcome.upheldBy,
      uncertain_from: outcome.uncertainFrom,
      reasoning: outcome.reasoning,
    })),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Applying the tally to the task graph
// ---------------------------------------------------------------------------

/** Remove ONE occurrence of each claim, by value. The derived `string[]` views
 *  can legitimately hold the same claim twice (two reviewers, same wording), so
 *  a set-difference would delete a finding nobody refuted. */
function removeOnce(claims: readonly string[], toRemove: readonly string[]): string[] {
  const remaining = [...claims];
  for (const claim of toRemove) {
    const index = remaining.indexOf(claim);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/**
 * Move this task's refuted findings out of the active set and into
 * `refuted_findings`, keeping the authoritative array and its derived views in
 * lockstep.
 *
 * This is the ONE legitimate demotion of `review_status` from `blocked` to
 * `passed`. mergeFindings never demotes because a reviewer finishing second
 * must not erase the first one's block — a concurrency rule. The panel is a
 * different actor: it runs after every reviewer, adjudicates the accumulated
 * set, and deciding whether the block stands is its entire purpose. A task
 * whose criticals were all refuted IS passed. `evidence_capture_failed` is
 * never promoted — nothing was adjudicated there.
 */
export function applyFindingOutcomes(task: Task, outcomes: readonly FindingOutcome[]): Task {
  const mine = outcomes.filter((outcome) => outcome.finding.taskId === task.id && !outcome.survives);
  if (mine.length === 0) return task;

  const refutedLocalIds = new Set(mine.map((outcome) => localFindingId(outcome.finding.id, task.id)));
  const kept = (task.findings ?? []).filter((finding) => !refutedLocalIds.has(finding.id));
  const removed = (task.findings ?? []).filter((finding) => refutedLocalIds.has(finding.id));

  const refutedRecords: RefutedFinding[] = mine.flatMap((outcome) => {
    const finding = removed.find((f) => f.id === localFindingId(outcome.finding.id, task.id));
    return finding
      ? [{ finding, refutedBy: outcome.refutedBy, reasoning: outcome.reasoning }]
      : [];
  });

  const removedCritical = removed.filter((f) => f.severity === "critical").map((f) => f.claim);
  const removedAdvisory = removed.filter((f) => f.severity === "advisory").map((f) => f.claim);
  const criticalFindings = removeOnce(task.critical_findings ?? [], removedCritical);

  const reviewStatus =
    task.review_status === "blocked" && criticalFindings.length === 0 ? "passed" : task.review_status;

  return {
    ...task,
    ...(reviewStatus ? { review_status: reviewStatus } : {}),
    findings: kept,
    critical_findings: criticalFindings,
    advisory_findings: removeOnce(task.advisory_findings ?? [], removedAdvisory),
    refuted_findings: [...(task.refuted_findings ?? []), ...refutedRecords],
  };
}

/** Strip the wave scoping a brief added, recovering the task-local finding id. */
function localFindingId(briefId: string, taskId: string): string {
  return briefId.startsWith(`${taskId}:`) ? briefId.slice(taskId.length + 1) : briefId;
}
