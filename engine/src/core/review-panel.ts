/**
 * The adversarial review panel — consumer 2 of the panel kernel.
 *
 * Wave-gate and standalone review runs spawn specialized reviewers. Each
 * produces findings; nothing adjudicates them. A plausible-but-wrong finding costs a real remediation
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

// `posix.join`, not the platform default — the same rule, and the same reason,
// as `panel-kernel.ts`. The paths this module SERIALIZES into `manifest.json`
// are the ones `parseRunManifest` compares for exact string equality after
// building its own with `posix.join`. Using the platform separator here meant
// the engine wrote, on win32, a manifest its own validator rejects: one half of
// a round trip disagreeing with the other about what "the same path" is, inside
// a module that declares itself pure.
import { posix } from "node:path";
import { parseFindingSeverity } from "./findings";

const { join } = posix;
import type {
  AdjudicatedFinding,
  Finding,
  FindingSeverity,
  NonEmptyRefutations,
  Refutation,
} from "./findings";
import {
  coverageErrors,
  exactOrderedSetErrors,
  fail,
  isRecord,
  ok,
  parseCriteriaSet,
  parseRunManifest,
  parseVerdictEnvelope,
  requireEntry,
  sanitizeProse,
  selectLenses,
  type ParseResult,
  type RunLayout,
  type VerdictEnvelope,
} from "./panel-kernel";
import { STANDALONE_REVIEW_SUBJECT } from "./standalone-review";

// ---------------------------------------------------------------------------
// Lenses
// ---------------------------------------------------------------------------

/**
 * Order matters twice. `selectLenses` fills a panel with the BASELINES first,
 * then the lenses this run's signals pulled up, then this table order for
 * whatever slots remain — so this array decides the unsignalled panel and the
 * tail of every signalled one. (Baselines before signals, not the reverse: the
 * kernel flags that as the arguable call, because a minimum-size panel drops a
 * signalled lens even when its signal fired.)
 *
 * The first three are therefore the default unsignalled panel — cause, intent,
 * consequence — which is the smallest set that covers the three ways a finding
 * is wrong on its own terms. `security` and `test-coverage` sit below them
 * because an unsignalled finding set has no security or test surface for them
 * to judge; when it does, the signals pull them up ahead of this order.
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

/**
 * Default panel size — the two baselines plus one more: signal-selected when a
 * signal fires, otherwise the next lens in table order (`blast-radius`), which
 * is the common unsignalled case.
 */
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
/**
 * Reads a bare path AND a sentence that quotes one, because both signals below
 * are matched against `claim` as well as `file` — and `file` is NULL for every
 * finding the line scraper produced, which is every finding on a review whose
 * block was absent, rejected, or superseded, all first-class states. With the
 * extension alternatives anchored at `$` and the directory alternative anchored
 * at `/`, `touchesTests` was unconditionally false on exactly those reviews, so
 * a wave whose findings were entirely test-coverage claims could never pull in
 * the `test-coverage` lens to judge them.
 *
 * So the trailing `$`s became `\b`, and the leading `/` became a boundary class
 * that also admits whitespace and the quoting characters a claim wraps a path
 * in. Neither loosening costs anything on the file side: a path has no leading
 * whitespace, and `foo.test.ts.bak` matching is the right answer for a lens
 * SIGNAL — a heuristic that decides which perspective judges a finding, not a
 * gate that decides whether one survives.
 */
const TEST_PATH = /(^|[\s"'`([/])(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?\b|Test\.(java|kt)\b|_test\.(go|py|rs)\b/i;

/** Signals a finding set carries, mirroring the architecture panel's
 *  interview-driven lens selection — derived from data, never chosen by hand. */
export interface ReviewSignals {
  readonly touchesSensitiveBoundary: boolean;
  readonly touchesTests: boolean;
}

export function reviewSignals(findings: readonly BriefFinding[]): ReviewSignals {
  // Both signals read file AND claim. The asymmetry that used to exist here —
  // sensitive boundaries from either, tests from the path alone — silently
  // disabled the test-coverage lens for every scraper-sourced finding set, where
  // `file` is always null. See the note on TEST_PATH.
  return {
    touchesSensitiveBoundary: findings.some(
      (f) => SENSITIVE_PATH.test(f.file ?? "") || SENSITIVE_PATH.test(f.claim),
    ),
    touchesTests: findings.some((f) => TEST_PATH.test(f.file ?? "") || TEST_PATH.test(f.claim)),
  };
}

/**
 * Derive the exact ordered lens set from the finding set and N. The selection
 * ALGORITHM is the kernel's (`selectLenses`), shared with the architecture
 * panel; only the vocabulary and the signal mapping are review-specific.
 */
export function selectReviewLenses(
  signals: ReviewSignals,
  lensCount: number,
): ParseResult<readonly ReviewLens[]> {
  return selectLenses<ReviewLens>({
    baseline: BASELINE_LENSES,
    signalled: [
      signals.touchesSensitiveBoundary ? "security" : null,
      signals.touchesTests ? "test-coverage" : null,
    ],
    table: REVIEW_LENSES,
    count: lensCount,
    countLabel: "lens count",
  });
}

// ---------------------------------------------------------------------------
// The finding brief — the panel's context artifact
// ---------------------------------------------------------------------------

declare const WAVE_SCOPED: unique symbol;

/**
 * A finding id re-scoped to the wave: `${taskId}:${finding.id}`.
 *
 * A `Finding.id` is unique within ONE task (`${agent}-${ordinal}`). The brief
 * spans a whole wave, where two tasks can each hold a `code-reviewer-1`, so the
 * panel re-scopes the id by task. Without this the envelope's coverage check
 * would silently collapse two distinct findings into one item.
 *
 * Branded because the two id spaces are both strings and mixing them is
 * silent: hand `briefFindingFilename` a task-local `code-reviewer-1` and it
 * returns a filename two tasks in the same wave would both claim — exactly the
 * collision the scoping exists to prevent. `waveFindingId`,
 * `parseWaveFindingId`, and `parseBriefFindingEntry` are the only constructors.
 */
export type WaveFindingId = string & { readonly [WAVE_SCOPED]: true };

/** Parse the external `task-id:finding-id` spelling into its wave-scoped brand. */
export function parseWaveFindingId(raw: unknown): WaveFindingId | null {
  return typeof raw === "string" && /^[^:\s]+:[^:\s]+$/.test(raw)
    ? raw as WaveFindingId
    : null;
}

/** A finding as the panel sees it: wave-scoped id, plus its task. */
export interface BriefFinding {
  readonly id: WaveFindingId;
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

export function waveFindingId(taskId: string, finding: Finding): WaveFindingId {
  return `${taskId}:${finding.id}` as WaveFindingId;
}

/** Run-scoped artifact filename for one brief finding. Colons are not portable
 *  in filenames; the manifest asserts these are unique, so the substitution
 *  cannot silently merge two findings. */
export function briefFindingFilename(id: WaveFindingId): string {
  return `finding-${id.replace(/[^A-Za-z0-9_.-]+/g, "-")}.json`;
}

interface FindingBriefBase {
  readonly wave: number;
  readonly severity: FindingSeverity;
  readonly taskIds: readonly string[];
  readonly findings: readonly BriefFinding[];
}

export type FindingBrief =
  | Readonly<FindingBriefBase & { readonly source?: never }>
  | Readonly<FindingBriefBase & {
      readonly source: "standalone";
      readonly wave: 1;
      readonly taskIds: readonly [typeof STANDALONE_REVIEW_SUBJECT];
    }>;

/**
 * The five task fields this panel reads.
 *
 * Declared structurally rather than importing the whole `Task` aggregate, the
 * same narrowing `AdjudicatedFinding` already uses in the other direction. The
 * panel core does not need — and should not be able to see — `test_result`,
 * `wave_gates`, `spec_anchors` or the rest of the schema to decide which
 * findings a wave puts up for refutation, and a `Task` parameter says otherwise
 * to every reader. `Task` satisfies this structurally, so callers pass one
 * unchanged.
 */
export interface BriefSourceTask {
  readonly id: string;
  readonly wave: number;
  readonly findings?: readonly Finding[];
  readonly critical_findings?: readonly string[];
  readonly advisory_findings?: readonly string[];
}

/** Collect the wave's verifiable findings from the task graph. Pure.
 *
 *  `severity` is a real parameter, not dead configurability: the brief round-
 *  trips through `parseFindingBriefJson`, which accepts an advisory brief from
 *  disk, so every downstream proof has to follow `brief.severity` rather than
 *  assume the default. It is also the seam `VERIFIED_SEVERITY`'s own "revisit
 *  once the false-positive rate is measured" note anticipates. */
export function buildFindingBrief(
  wave: number,
  tasks: readonly BriefSourceTask[],
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

/** Adapt an identified standalone finding set to the panel's scoped item model.
 *  The subject id is run-local and never becomes an orchestration Task. */
export function buildStandaloneFindingBrief(source: {
  readonly subjectId: typeof STANDALONE_REVIEW_SUBJECT;
  readonly findings: readonly Finding[];
}): FindingBrief {
  const task = {
    id: STANDALONE_REVIEW_SUBJECT,
    wave: 1,
    findings: source.findings,
    critical_findings: source.findings
      .filter((finding) => finding.severity === VERIFIED_SEVERITY)
      .map((finding) => finding.claim),
  };
  const built = buildFindingBrief(1, [task]);
  return {
    wave: 1,
    severity: built.severity,
    taskIds: [STANDALONE_REVIEW_SUBJECT],
    findings: built.findings,
    source: "standalone",
  };
}

/** The external snake_case contract for the brief. */
export function serializeFindingBrief(brief: FindingBrief): string {
  return JSON.stringify({
    wave: brief.wave,
    ...(brief.source === "standalone" ? { source_kind: "standalone" } : {}),
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
  briefSeverity: FindingSeverity | null,
): { readonly finding: BriefFinding | null; readonly errors: readonly string[] } {
  if (!isRecord(entry)) return { finding: null, errors: [`${path} must be an object`] };

  const errors: string[] = [];
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const parsedId = parseWaveFindingId(id);
  const taskId = typeof entry.task_id === "string" ? entry.task_id.trim() : "";
  const agent = typeof entry.agent === "string" ? entry.agent.trim() : "";
  const claim = typeof entry.claim === "string" ? sanitizeProse(entry.claim) : "";
  const severity = parseFindingSeverity(entry.severity);

  if (id === "") errors.push(`${path}.id must be a non-empty string`);
  else if (parsedId === null) errors.push(`${path}.id must match task-id:finding-id without whitespace or extra colons`);
  if (taskId === "") errors.push(`${path}.task_id must be a non-empty string`);
  if (agent === "") errors.push(`${path}.agent must be a non-empty string`);
  if (claim === "") errors.push(`${path}.claim must be non-empty after sanitization`);
  if (severity === null) errors.push(`${path}.severity is unknown`);
  // VERIFIED_SEVERITY is a policy invariant — advisories skip the panel because
  // refuting one saves nothing and the agent quota it burns is real. The brief
  // filters on it; without this the re-parse that exists to stop the disk and
  // the panel diverging would wave through the one divergence that matters,
  // and a refuted advisory would be stripped from advisory_findings.
  if (severity !== null && briefSeverity !== null && severity !== briefSeverity) {
    errors.push(`${path}.severity must equal brief.severity (${briefSeverity}); received: ${severity}`);
  }
  if (taskIds !== null && taskId !== "" && !taskIds.includes(taskId)) {
    errors.push(`${path}.task_id is not one of brief.task_ids: ${taskId}`);
  }
  if (id !== "" && taskId !== "" && !id.startsWith(`${taskId}:`)) {
    errors.push(`${path}.id must be scoped by its task: ${taskId}:<finding id>`);
  }

  const file = typeof entry.file === "string" && entry.file.trim() !== "" ? sanitizeProse(entry.file) : "";
  const line = Number.isInteger(entry.line) && (entry.line as number) > 0 ? (entry.line as number) : null;

  return {
    // Both the external grammar and the `${taskId}:` cross-field invariant are
    // proven above; only the smart constructor's value earns the brand.
    finding: errors.length === 0 && severity !== null && parsedId !== null
      ? { id: parsedId, taskId, agent, severity, file: file || null, line, claim }
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

  const severity = parseFindingSeverity(raw.severity);
  if (severity === null) {
    errors.push("brief.severity must be 'critical' or 'advisory'");
  }
  const source = raw.source_kind === undefined || raw.source_kind === "wave"
    ? undefined
    : raw.source_kind === "standalone" ? "standalone" as const : null;
  if (source === null) errors.push("brief.source_kind must be 'wave' or 'standalone' when present");

  const taskIds = Array.isArray(raw.task_ids) && raw.task_ids.every((id) => typeof id === "string" && id.trim() !== "")
    ? (raw.task_ids as string[]).map((id) => id.trim())
    : null;
  if (taskIds === null) errors.push("brief.task_ids must be an array of non-empty strings");

  if (!Array.isArray(raw.findings)) {
    return fail([...errors, "brief.findings must be an array"]);
  }

  const findings: BriefFinding[] = [];
  for (const [index, entry] of raw.findings.entries()) {
    const parsed = parseBriefFindingEntry(entry, `brief.findings[${index}]`, taskIds, severity);
    errors.push(...parsed.errors);
    if (parsed.finding) findings.push(parsed.finding);
  }

  if (source === "standalone") {
    if (wave !== 1) errors.push("standalone brief.wave must be 1");
    if (taskIds === null || taskIds.length !== 1 || taskIds[0] !== STANDALONE_REVIEW_SUBJECT) {
      errors.push(`standalone brief.task_ids must be exactly ['${STANDALONE_REVIEW_SUBJECT}']`);
    }
  }

  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) errors.push("brief finding ids must be unique");
  const filenames = ids.map(briefFindingFilename);
  if (new Set(filenames).size !== filenames.length) {
    errors.push("brief finding ids must remain unique once mapped to filenames");
  }

  if (errors.length > 0) return fail(errors);
  return source === "standalone"
    ? ok({
        wave: 1,
        severity: severity as FindingSeverity,
        taskIds: [STANDALONE_REVIEW_SUBJECT],
        findings,
        source,
      })
    : ok({
        wave: wave as number,
        severity: severity as FindingSeverity,
        taskIds: taskIds ?? [],
        findings,
      });
}

/** Does this brief hold anything the panel can adjudicate? */
export function briefIsEmpty(brief: FindingBrief): boolean {
  return brief.findings.length === 0;
}

/** The repair a graph whose views outrun its findings needs, named in the
 *  diagnostic itself — the same hint core/findings gives at the load boundary. */
const BRIEF_REPAIR_HINT =
  "Re-run the reviewers so every critical is emitted through the findings block, " +
  "or repair and install the graph with: helper repair-task-graph";

/**
 * `buildFindingBrief`'s postcondition: the brief accounts for every finding the
 * wave gate will count.
 *
 * If the brief is short, every later stage still SUCCEEDS — an empty item set
 * satisfies every length and coverage rule vacuously — and the run reports
 * "0 survived, 0 refuted", which is indistinguishable from a panel that
 * adjudicated the wave and upheld nothing. So the brief proves its own
 * completeness against the view the wave gate actually counts, and refuses to
 * be built otherwise.
 *
 * PER TASK, not summed across the wave. A wave-wide total let one task's surplus
 * offset another's orphans: the totals matched, the check passed, and the second
 * task's critical entered no brief, could never be refuted, and blocked the wave
 * permanently. Offending task ids are named because "the wave is short by one"
 * does not tell an operator which reviewer to re-run.
 */
export function briefCompletenessErrors(
  brief: FindingBrief,
  tasks: readonly BriefSourceTask[],
): readonly string[] {
  // The wave is taken from the BRIEF and the filter is applied HERE, rather than
  // trusting the caller to re-derive both. This function is documented as
  // `buildFindingBrief`'s postcondition, and the shell was re-running
  // `tasks.filter(t => t.wave === wave)` — the same predicate, written a second
  // time, against a `wave` passed separately. Two copies of the subject a proof
  // is about can drift, and if they do the proof holds over a different task set
  // than the one the brief was built from, which proves nothing.
  const wave = brief.wave;
  const waveTasks = tasks.filter((task) => task.wave === wave);
  if (waveTasks.length === 0) {
    return [`no tasks in wave ${wave} — check --wave against .current_wave`];
  }

  const briefedPerTask = new Map<string, number>();
  for (const finding of brief.findings) {
    briefedPerTask.set(finding.taskId, (briefedPerTask.get(finding.taskId) ?? 0) + 1);
  }

  // The view that corresponds to THIS brief's severity. Hardcoding the critical
  // view made the check wrong in both directions for any other severity: it
  // rejected a complete advisory brief whenever the task also held criticals,
  // and passed a short one whenever it held none — while the diagnostic below
  // interpolated `brief.severity` and read as though it had checked that view
  // all along. `buildFindingBrief` takes the severity as a parameter, so the
  // proof of its postcondition has to follow it.
  const viewOf = (task: BriefSourceTask): readonly string[] =>
    (brief.severity === "critical" ? task.critical_findings : task.advisory_findings) ?? [];

  const short = waveTasks.flatMap((task) => {
    const counted = viewOf(task).length;
    const briefed = briefedPerTask.get(task.id) ?? 0;
    return counted > briefed ? [{ id: task.id, counted, briefed }] : [];
  });

  if (short.length > 0) {
    return [
      `wave ${wave}: ${short
        .map((t) => `${t.id} has ${t.counted} ${brief.severity}_findings but only ${t.briefed} carry structured identity`)
        .join("; ")} — ` +
        `the panel cannot adjudicate the remainder, and a partial brief would report the rest as upheld. ` +
        BRIEF_REPAIR_HINT,
    ];
  }

  return briefIsEmpty(brief)
    ? [
        `wave ${wave} has no ${brief.severity} findings — ` +
          `skip the refutation panel, there is nothing to adjudicate`,
      ]
    : [];
}

/** Operator-facing rendering of the brief. Not parsed by anything — the JSON is. */
export function renderFindingBriefMarkdown(brief: FindingBrief): string {
  const lines = [
    brief.source === "standalone"
      ? `# Standalone review — ${brief.severity} findings up for refutation`
      : `# Wave ${brief.wave} — ${brief.severity} findings up for refutation`,
    "",
    brief.source === "standalone"
      ? `**Review subject:** ${brief.taskIds.join(", ") || "(none)"}`
      : `**Tasks:** ${brief.taskIds.join(", ") || "(none)"}`,
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
  readonly id: WaveFindingId;
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
 * ENGINE-authored, unlike the architecture panel's manifest, which the
 * orchestrator writes because the designers' candidates do not exist until they
 * run. The asymmetry is about WHEN the item set is knowable, not about how much
 * either orchestrator is trusted: `parsePanelManifest` validates the candidate
 * manifest against `expectedLenses`, derived in-engine from the validated
 * digest, under exact length / membership / order / uniqueness rules — so an
 * orchestrator there can no more omit a candidate than one here could omit a
 * critical. (`runArtifactErrors`' surplus check closes the remaining gap: files
 * on disk the manifest does not name.) Here the findings already exist in the
 * task graph when the manifest is written, so there is no reason to route them
 * through the model at all.
 */
export function serializeReviewManifest(
  runId: string,
  runDir: string,
  layout: RunLayout<"review">,
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

/**
 * Parse the exact finding-set handoff and bind every path to one run root.
 *
 * The path/id/coverage rules are the kernel's (`parseRunManifest`) — the
 * architecture panel enforces the identical set over its candidate manifest.
 * Review-specific here: the item vocabulary is an open set of wave-scoped
 * finding ids rather than a closed enum, and the manifest carries an extra
 * `lenses` field (architecture derives its lens set from the candidates
 * themselves, so it has nothing equivalent to validate).
 */
export function parseReviewManifest(
  raw: unknown,
  expectedRunDir: string,
  layout: RunLayout<"review">,
  expectedLenses: readonly ReviewLens[],
  expectedFindingIds: readonly WaveFindingId[],
): ParseResult<ReviewManifest> {
  const parsed = parseRunManifest(raw, expectedRunDir, layout, {
    label: "review manifest",
    contextMdKey: "brief_file",
    contextJsonKey: "brief_json",
    itemsKey: "findings",
    itemIdKey: "id",
    itemNoun: ["finding", "findings"],
    expectedIds: expectedFindingIds,
    filenameOf: briefFindingFilename,
  });

  const errors: string[] = parsed.ok ? [] : [...parsed.errors];

  const lenses: ReviewLens[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.lenses) || raw.lenses.length !== expectedLenses.length) {
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
    // The same four rules `parseRunManifest` applies to the finding array, from
    // the same function. They were hand-rolled here — twenty lines from the call
    // that could not carry them, because `RunManifestSpec` has no slot for a
    // second validated id array — which is exactly the two-copies-of-one-rule
    // setup the kernel exists to end.
    errors.push(
      ...exactOrderedSetErrors(lenses, expectedLenses, {
        subject: "manifest lenses",
        missing: "manifest is missing lens",
        ordered: "manifest lenses",
      }),
    );
  }

  if (errors.length > 0 || !parsed.ok) return fail(errors);

  return ok({
    runId: parsed.value.runId,
    briefFile: parsed.value.contextMd,
    briefJson: parsed.value.contextJson,
    lenses,
    findings: parsed.value.entries,
  });
}

// ---------------------------------------------------------------------------
// Refutation verdicts
// ---------------------------------------------------------------------------

export const REFUTATION_VERDICTS = ["refuted", "upheld", "uncertain"] as const;
export type RefutationKind = (typeof REFUTATION_VERDICTS)[number];

export interface RefutationVerdict {
  /** Wave-scoped, because the envelope RESOLVED it against the brief's finding
   *  set rather than re-reading the raw string. A task-local `code-reviewer-1`
   *  no longer type-checks here. */
  readonly findingId: WaveFindingId;
  readonly verdict: RefutationKind;
  /** Sanitized — it is substituted into the gate summary and stored in state. */
  readonly reasoning: string;
}

function parseRefutationEntry(
  raw: Record<string, unknown>,
  path: string,
  findingId: WaveFindingId,
): ParseResult<RefutationVerdict> {
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
    : ok({ findingId, verdict: verdict as RefutationKind, reasoning });
}

/**
 * Parse one verifier's untrusted output. Sibling of parseJudgeVerdict: the same
 * kernel envelope, a different payload, and NO crossCheck — findings have no
 * meaningful order, so there is no cross-entry rule to enforce.
 */
function containsCompetingVerdictObject(text: string): boolean {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const candidate = JSON.parse(text.slice(start, index + 1)) as unknown;
          if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) &&
              (Object.hasOwn(candidate, "criterion") || Object.hasOwn(candidate, "verdicts"))) return true;
        } catch { /* code/prose braces are not a competing JSON payload */ }
        break;
      }
    }
  }
  return false;
}

export function refutationVerdictJson(raw: string): ParseResult<string> {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return ok(trimmed);
  } catch {
    // Harnesses occasionally return analysis prose plus the exact requested
    // JSON in a single fenced block. Preserve the immutable raw transcript,
    // but normalize this one unambiguous transport wrapper before semantic
    // validation. Multiple JSON fences remain ambiguous and fail closed.
    const fenced = [...trimmed.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
    if (fenced.length !== 1) {
      return fail([fenced.length === 0
        ? "refutation verdict is not valid JSON and contains no single json fence"
        : "refutation verdict contains multiple json fences"]);
    }
    const candidate = fenced[0]![1]!.trim();
    const outside = `${trimmed.slice(0, fenced[0]!.index)}\n${trimmed.slice(fenced[0]!.index! + fenced[0]![0].length)}`;
    // Ordinary analysis/code prose (including `{ strict: true }`) is tolerated.
    // A structurally valid outside JSON object claiming decoded `criterion` or
    // `verdicts` authority is a competing payload, including Unicode-escaped
    // key spellings. Do not guess which object was final.
    if (containsCompetingVerdictObject(outside)) {
      return fail(["refutation verdict contains competing JSON-looking payload outside the json fence"]);
    }
    try {
      JSON.parse(candidate);
      return ok(candidate);
    } catch {
      return fail(["refutation verdict json fence is not valid JSON"]);
    }
  }
}

export function parseRefutationVerdict(
  rawJson: string,
  expectedLens: ReviewLens,
  expectedFindingIds: readonly WaveFindingId[],
): ParseResult<VerdictEnvelope<RefutationVerdict>> {
  const normalized = refutationVerdictJson(rawJson);
  if (!normalized.ok) return normalized;
  return parseVerdictEnvelope<RefutationVerdict, WaveFindingId>(normalized.value, expectedLens, expectedFindingIds, {
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

/** The part of an adjudication that does not depend on which way it went. */
interface FindingOutcomeVotes {
  readonly finding: BriefFinding;
  /** Lenses that upheld, in lens order. */
  readonly upheldBy: readonly ReviewLens[];
  /** Lenses that could not decide. Counts toward neither side. */
  readonly uncertainFrom: readonly ReviewLens[];
}

/**
 * One finding's adjudication. Structurally satisfies `AdjudicatedFinding`
 * (core/findings), which is what `applyFindingOutcomes` consumes.
 *
 * A union for the same reason `AdjudicatedFinding` is one: a killed finding
 * always carries the reasoning that killed it, and that is a fact about the
 * data, not a rule a downstream reader has to remember to check.
 */
export type FindingOutcome =
  | (FindingOutcomeVotes & {
      readonly survives: true;
      /** Lenses that refuted, with their reasoning, in lens order. Fewer than
       *  the threshold, so possibly none. */
      readonly refutations: readonly Refutation[];
    })
  | (FindingOutcomeVotes & {
      readonly survives: false;
      /** The lenses that killed it, with their reasoning, in lens order. */
      readonly refutations: NonEmptyRefutations;
    });

/** Compile-time proof that `applyFindingOutcomes` (core/findings) can consume a
 *  `FindingOutcome`. Without it the structural match is a coincidence the two
 *  modules could drift out of independently, with no signal until runtime. */
const _outcomeIsAdjudicated: (outcome: FindingOutcome) => AdjudicatedFinding = (outcome) => outcome;
void _outcomeIsAdjudicated;

/**
 * A strict majority of the panel must refute. With 2 lenses that means
 * unanimity; with 3, two of three; with 5, three of five. Any split short of
 * the threshold — including a 1-1 tie, and including a panel that mostly said
 * `uncertain` — keeps the finding.
 */
export function defaultRefutationThreshold(lensCount: number): number {
  return Math.floor(lensCount / 2) + 1;
}

// ---------------------------------------------------------------------------
// Run policy — the rules that decide whether a brief or a tally may proceed
// ---------------------------------------------------------------------------
//
// These lived in `handlers/helpers/review-panel.ts`, inline in the I/O
// function. Each one is a pure comparison over already-parsed values — two
// integers, two integers, a set difference — and each carries a long comment
// naming a real bug it prevents: a shrunken panel adjudicating under a lower
// absolute bar, one lens killing a critical alone, a re-tally re-adjudicating a
// closed decision, a brief for a wave the graph has closed. Rules that
// consequential deserve direct unit tests, and inside the shell the only way to
// reach them was to spawn the CLI against a temp filesystem. The equivalents
// that were already in the core (`selectLenses`' bounds, `tallyRefutations`'
// threshold range) each have one.

/**
 * A brief may only be built for the wave the graph is actually on.
 *
 * `wave-gate.md` asked the operator to check this with `jq`, but the engine has
 * the graph in hand: a stale `--wave` produces a fully adjudicable brief whose
 * `tally` then writes `refuted_findings` and can promote a PAST wave's tasks
 * blocked → passed. `checkCriticalFindings` is wave-scoped, so the blast radius
 * is a corrupted audit record rather than an opened gate — still not a thing to
 * leave to a prose reminder.
 *
 * Fails CLOSED on a graph with no `current_wave`. The guard used to skip
 * entirely in that case, which is the state a graph is in before
 * `populate-task-graph` has run and exactly when "which wave is this?" has no
 * answer — so every `--wave` was accepted and the rule above did not apply at
 * all. An unknown current wave is not a licence to adjudicate an arbitrary one.
 */
export function staleWaveError(requested: number, current: number | undefined): string | null {
  if (current === undefined) {
    return (
      `the task graph records no current wave, so --wave ${requested} cannot be proven against ` +
      `it — run the wave through /loom before briefing a review panel for it`
    );
  }
  return current === requested
    ? null
    : `--wave ${requested} is not the graph's current wave (${current}) — a brief for a closed ` +
      `wave re-adjudicates decisions that are already recorded`;
}

/**
 * The panel size is fixed for the LIFE of a run, not per invocation.
 *
 * A `--lenses` that disagrees with the size the manifest recorded is a re-sized
 * panel running under a name whose verdicts were cast by a different one.
 * Re-running `manifest` without `--lenses` used to rewrite a recorded 5-lens
 * panel to the 3-lens default; `readVerdicts` then iterated only the shrunken
 * list, verdict-4 and verdict-5 were silently ignored, the absolute refutation
 * bar fell from 3 to 2, and a finding the full panel had UPHELD came out refuted
 * — promoting the task blocked → passed at exit 0 with nothing on stderr.
 * Re-deriving the lens SET does not catch it: `selectReviewLenses` returns
 * nested prefixes, so a truncated list reproduces its own derivation exactly.
 */
export function panelSizeConflict(requested: number | null, recorded: number | null): string | null {
  if (requested === null || recorded === null || requested === recorded) return null;
  return (
    `this run's panel size is already fixed at ${recorded} lens(es); ` +
    `--lenses ${requested} would re-size a panel whose verdicts were cast by the ` +
    `recorded one — start a new run directory instead`
  );
}

/**
 * A strict majority is the FLOOR, not merely the default.
 *
 * `--threshold 1` let one lens kill a critical on its own, inverting the
 * documented "ties favour keeping the finding" rule and promoting
 * blocked → passed when it was the wave's last critical, with nothing in the
 * runbook gating it. Raising the bar is always safe; lowering it is a weaker
 * panel wearing the same name.
 */
export function thresholdError(threshold: number, lensCount: number): string | null {
  const floor = defaultRefutationThreshold(lensCount);
  return threshold >= floor
    ? null
    : `threshold ${threshold} is below the strict majority of ${lensCount} lenses (${floor}) — ` +
      `a weaker panel must not run under the same name`;
}

/**
 * Outcomes this run would re-adjudicate, given what the graph already records.
 *
 * A tally already applied would send `applyFindingOutcomes` looking for findings
 * it has itself moved into `refuted_findings`, where the invariant throw blames
 * "the task graph changed between brief and tally" — true of a
 * `store-review-findings` override landing mid-run, and wrong about the far
 * likelier cause: the operator re-ran `tally`. (A broken pipe on the canonical
 * output AFTER the state write lands is enough to invite that.) Named before the
 * write, so the diagnostic matches what happened.
 *
 * `alreadyRefuted` is wave-scoped to match the brief's id space, since
 * `applyFindingOutcomes` strips the `${taskId}:` prefix back off when it applies
 * an outcome.
 *
 * The test is overlap with the brief, NOT "refuted twice". Filtering on
 * `!survives` too made this a partial guard that a second tally could walk
 * straight past: tally 1 refutes F1 and upholds F2; the operator rewrites
 * `verdicts/` and re-runs; now F1 is upheld and F2 refuted, the two sets are
 * disjoint, nothing fires. The tally then ran against a brief the graph had
 * already moved on from — refuting F2 off a stale item set, promoting
 * `blocked → passed` if F2 was the last live critical, and serializing F1 as
 * `surviving` while the graph holds it refuted. Overlap alone is the honest
 * test and admits no false positive: a fresh brief is built from
 * `task.findings`, which excludes refuted findings, and `nextOrdinal` reads the
 * refuted set as a high-water mark so a new finding can never reuse a retired
 * id. Any overlap therefore means this brief predates an adjudication.
 */
export function replayedOutcomes(
  outcomes: readonly FindingOutcome[],
  alreadyRefuted: ReadonlySet<string>,
): readonly WaveFindingId[] {
  return outcomes
    .filter((outcome) => alreadyRefuted.has(outcome.finding.id))
    .map((outcome) => outcome.finding.id);
}

/** The wave-scoped ids a graph already holds as refuted. */
export function refutedIdsOf(
  tasks: readonly { readonly id: string; readonly refuted_findings?: readonly { readonly finding: { readonly id: string } }[] }[],
): ReadonlySet<string> {
  return new Set(
    tasks.flatMap((task) =>
      (task.refuted_findings ?? []).map((record) => `${task.id}:${record.finding.id}`),
    ),
  );
}

/** The operator-facing diagnostic for a replayed tally. */
export function replayError(replays: readonly WaveFindingId[]): string {
  return (
    `this run has already been tallied — ${replays.length} finding(s) are already recorded as ` +
    `refuted on their task (${replays.join(", ")}). Re-tallying would re-adjudicate a closed ` +
    `decision; start a new run directory to re-verify these findings.`
  );
}

/** The panel size a written manifest records. Null when the file says nothing
 *  usable — `parseReviewManifest` is what rejects it, with a real diagnostic. */
export function manifestLensCount(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const lenses = raw.lenses;
  return Array.isArray(lenses) && lenses.length > 0 ? lenses.length : null;
}

/**
 * Sibling to aggregateVerdicts, not a generalization of it: same input shape,
 * different decision. Architecture aggregation produces a TOTAL ORDER over
 * candidates; this produces a PER-ITEM verdict, and no amount of parameterizing
 * would make one function honestly express both.
 */
export function tallyRefutations(
  verdicts: readonly VerdictEnvelope<RefutationVerdict>[],
  lensesInOrder: readonly ReviewLens[],
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

  errors.push(
    ...coverageErrors(
      byLens,
      lensesInOrder,
      findingIds,
      (entry) => entry.findingId,
      "must judge each finding exactly once",
    ),
  );

  if (errors.length > 0) return fail(errors);

  const outcomes = findings.map((finding): FindingOutcome => {
    const refutations: Refutation[] = [];
    const upheldBy: ReviewLens[] = [];
    const uncertainFrom: ReviewLens[] = [];

    for (const lens of lensesInOrder) {
      // No `if (!entry) continue`: coverage above proves every lens judged
      // every finding, and skipping a missing entry would silently score it as
      // an abstention — the one default that changes whether a finding lives.
      const entry = requireEntry(byLens, lens, finding.id, (e) => e.findingId);
      if (entry.verdict === "refuted") {
        refutations.push({ lens, reason: entry.reasoning });
      } else if (entry.verdict === "upheld") {
        upheldBy.push(lens);
      } else {
        uncertainFrom.push(lens);
      }
    }

    // `head !== undefined` is redundant with `length >= threshold` — the
    // threshold is validated to be >= 1 above, so a finding that met the bar
    // has at least one refutation. It is written out anyway because that is
    // what PROVES the non-empty tuple to the compiler, turning the invariant
    // `applyFindingOutcomes` used to assert at runtime into one established
    // here, once, where the votes are actually counted.
    const [head, ...tail] = refutations;
    return head !== undefined && refutations.length >= threshold
      ? { finding, upheldBy, uncertainFrom, survives: false, refutations: [head, ...tail] }
      : { finding, upheldBy, uncertainFrom, survives: true, refutations };
  });

  return ok(outcomes);
}

/** Serialize the tally for the gate summary and the operator. The external
 *  contract keeps `refuted_by` and `reasoning` as two aligned arrays — they are
 *  derived from one pair list here, so they cannot fall out of step. */
export function serializeOutcomes(
  outcomes: readonly FindingOutcome[],
  lensesInOrder: readonly ReviewLens[],
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
      refuted_by: outcome.refutations.map((refutation) => refutation.lens),
      upheld_by: outcome.upheldBy,
      uncertain_from: outcome.uncertainFrom,
      reasoning: outcome.refutations.map((refutation) => refutation.reason),
    })),
  }, null, 2);
}

