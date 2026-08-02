import {
  coverageErrors,
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

// The architecture panel is consumer 1 of the kernel. Everything below is what
// is genuinely architecture-specific: the interview digest, lens selection, the
// candidate manifest, the criteria derivation, and the total-order aggregate.
// Re-exported so existing importers of this module need not know the split.
export type { ParseResult };

export const PRIMARY_AXES = [
  "simplicity",
  "performance",
  "extensibility",
  "shipping speed",
  "operational cost",
] as const;
export type PrimaryAxis = (typeof PRIMARY_AXES)[number];

export const TESTABILITY_BARS = [
  "pure functional core",
  "pragmatic mix",
  "integration-first",
] as const;
export type TestabilityBar = (typeof TESTABILITY_BARS)[number];

export const CODEBASE_MATURITIES = ["greenfield", "brownfield", "rewrite"] as const;
export type CodebaseMaturity = (typeof CODEBASE_MATURITIES)[number];

export const PANEL_LENSES = [
  "simplicity-first",
  "type-driven-fp",
  "risk-security-first",
  "performance-first",
  "codebase-conventionist",
] as const;
export type PanelLens = (typeof PANEL_LENSES)[number];

const INTERVIEW_FIELDS = [
  ["primaryAxis", "**Primary axis:**"],
  ["testabilityBar", "**Testability bar:**"],
  ["sensitiveBoundaries", "**Sensitive boundaries:**"],
  ["codebaseMaturity", "**Codebase maturity:**"],
  ["codebaseConstraints", "**Codebase constraints:**"],
  ["errorHandlingPhilosophy", "**Error-handling philosophy:**"],
  ["concurrencyAndState", "**Concurrency & state:**"],
  ["dataAndPersistence", "**Data & persistence:**"],
  ["techPreferences", "**Tech preferences:**"],
  ["observability", "**Observability:**"],
  ["backwardsCompatibility", "**Backwards compatibility:**"],
  ["deployment", "**Deployment:**"],
  ["outOfScope", "**Out-of-scope:**"],
  ["executableModelSignal", "**Executable-model signal:**"],
] as const;

type InterviewField = (typeof INTERVIEW_FIELDS)[number][0];

type InterviewValues = Readonly<Record<InterviewField, string>>;

export type InterviewDigest = Omit<
  InterviewValues,
  "primaryAxis" | "testabilityBar" | "codebaseMaturity"
> & {
  readonly primaryAxis: PrimaryAxis;
  readonly testabilityBar: TestabilityBar;
  readonly codebaseMaturity: CodebaseMaturity;
};

function enumError(label: string, value: string, allowed: readonly string[]): string {
  return `${label} must be one of: ${allowed.join(", ")}; received: ${value || "<empty>"}`;
}

/** Parse the interviewer markdown boundary into a complete, typed digest. */
export function parseInterviewDigest(markdown: string): ParseResult<InterviewDigest> {
  const lines = markdown.split(/\r?\n/);
  const values: Partial<Record<InterviewField, string>> = {};
  const errors: string[] = [];

  for (const [key, label] of INTERVIEW_FIELDS) {
    const matching = lines.filter((line) => line.startsWith(label));
    if (matching.length !== 1) {
      errors.push(`${label} must appear exactly once at column 0; found ${matching.length}`);
      continue;
    }
    const value = matching[0]!.slice(label.length).trim();
    if (value.length === 0) {
      errors.push(`${label} must have a non-empty value`);
      continue;
    }
    values[key] = value;
  }

  const primaryAxis = values.primaryAxis?.toLowerCase();
  if (primaryAxis && !(PRIMARY_AXES as readonly string[]).includes(primaryAxis)) {
    errors.push(enumError("Primary axis", values.primaryAxis!, PRIMARY_AXES));
  }

  const testabilityBar = values.testabilityBar?.toLowerCase();
  if (testabilityBar && !(TESTABILITY_BARS as readonly string[]).includes(testabilityBar)) {
    errors.push(enumError("Testability bar", values.testabilityBar!, TESTABILITY_BARS));
  }

  const codebaseMaturity = values.codebaseMaturity?.toLowerCase();
  if (codebaseMaturity && !(CODEBASE_MATURITIES as readonly string[]).includes(codebaseMaturity)) {
    errors.push(enumError("Codebase maturity", values.codebaseMaturity!, CODEBASE_MATURITIES));
  }

  const sensitiveBoundaries = values.sensitiveBoundaries;
  const sensitiveStatus = sensitiveBoundaries?.match(/^(flagged|none)(?:\b|\s|[-—:])/i)?.[1]?.toLowerCase();
  if (sensitiveBoundaries && !sensitiveStatus) {
    errors.push("Sensitive boundaries must begin with 'flagged' or 'none'");
  }

  if (errors.length > 0) return fail(errors);

  // Every local below is guaranteed present on this path: a missing, empty, or
  // invalid field pushed an error above and we would already have returned.
  // The compiler cannot see that, so an explicit guard carries the invariant
  // instead of a non-null assertion — an unreachable Err beats a silent cast.
  if (
    primaryAxis === undefined ||
    testabilityBar === undefined ||
    codebaseMaturity === undefined ||
    sensitiveBoundaries === undefined ||
    sensitiveStatus === undefined
  ) {
    return fail(["interview digest failed its internal completeness check"]);
  }

  return ok({
    ...(values as InterviewValues),
    primaryAxis: primaryAxis as PrimaryAxis,
    testabilityBar: testabilityBar as TestabilityBar,
    codebaseMaturity: codebaseMaturity as CodebaseMaturity,
    sensitiveBoundaries: sensitiveBoundaries.replace(/^(flagged|none)/i, sensitiveStatus),
  });
}

/** Any JS line terminator. A digest VALUE can never contain one when it came
 *  through parseInterviewDigest (which splits the markdown on newlines), so a
 *  value carrying one in the JSON artifact means the file was edited outside
 *  the contract. Rejected explicitly: without this check the reconstruction
 *  below would splice the value into line position and surface as a confusing
 *  "must appear exactly once" / "must have a non-empty value" error about some
 *  OTHER field. Still fail-closed either way — this only makes the diagnostic
 *  name the real culprit. */
const LINE_TERMINATOR = /[\r\n\u2028\u2029]/;

/** Re-parse the canonical JSON artifact instead of trusting prior validation.
 *  Reconstructs the labeled markdown and routes it back through
 *  parseInterviewDigest so the JSON and markdown directions can never diverge
 *  on what a valid digest is — there is exactly one set of field rules. */
export function parseInterviewDigestJson(raw: unknown): ParseResult<InterviewDigest> {
  if (!isRecord(raw)) return fail(["canonical interview digest must be a JSON object"]);

  const newlineErrors = INTERVIEW_FIELDS.flatMap(([key, label]) => {
    const value = raw[key];
    return typeof value === "string" && LINE_TERMINATOR.test(value)
      ? [`${label} must not contain a line terminator`]
      : [];
  });
  if (newlineErrors.length > 0) return fail(newlineErrors);

  const markdown = INTERVIEW_FIELDS.map(([key, label]) => {
    const value = raw[key];
    return `${label} ${typeof value === "string" ? value : ""}`;
  }).join("\n");
  return parseInterviewDigest(markdown);
}

/** The third judge criterion — a fixed literal, unlike criteria 1 and 2 which
 *  are verbatim interview values. */
export const CODEBASE_FIT_CRITERION = "codebase fit + effort";

/**
 * The exact ordered judge criteria for a run, derived from the validated
 * digest. Previously this derivation lived only in commands/loom.md prose, so
 * the orchestrator's criteria and the finalizer's positional tie-break had to
 * agree by convention. Deriving it here makes the criteria set data that both
 * the verdict and aggregate operations validate against.
 *
 * Always distinct: PRIMARY_AXES, TESTABILITY_BARS, and CODEBASE_FIT_CRITERION
 * are pairwise disjoint vocabularies (asserted in panel-contract.test.ts), so
 * aggregateVerdicts' distinctness precondition holds for every valid digest.
 */
export function deriveJudgeCriteria(digest: InterviewDigest): readonly string[] {
  return [digest.primaryAxis, digest.testabilityBar, CODEBASE_FIT_CRITERION];
}

/** Always designed, whatever the interview said. Also the minimum panel size —
 *  the mandatory approach gate needs at least two options to choose between. */
const BASELINE_LENSES: readonly PanelLens[] = ["simplicity-first", "type-driven-fp"];

/**
 * Derive the exact ordered lens set from validated interview signals and N. The
 * selection ALGORITHM is the kernel's (`selectLenses`), shared with the review
 * panel; only the vocabulary and the signal mapping are architecture-specific.
 */
export function selectPanelLenses(
  digest: InterviewDigest,
  designerCount: number,
): ParseResult<readonly PanelLens[]> {
  return selectLenses<PanelLens>({
    baseline: BASELINE_LENSES,
    signalled: [
      digest.sensitiveBoundaries.startsWith("flagged") ? "risk-security-first" : null,
      digest.primaryAxis === "performance" ? "performance-first" : null,
      digest.codebaseMaturity === "brownfield" ? "codebase-conventionist" : null,
    ],
    table: PANEL_LENSES,
    count: designerCount,
    countLabel: "designer count",
  });
}

export type PanelCandidate = Readonly<{
  lens: PanelLens;
  path: string;
  filename: string;
}>;

export type PanelManifest = Readonly<{
  runId: string;
  interviewFile: string;
  interviewJson: string;
  candidates: readonly PanelCandidate[];
}>;

/** Run-scoped artifact filename for one lens's candidate. */
export function candidateFilename(lens: string): string {
  return `candidate-${lens}.md`;
}

/**
 * Parse the exact candidate-set handoff and bind every path to one run root.
 *
 * The rules are the kernel's (`parseRunManifest`) — the review panel enforces
 * the identical set over its finding manifest. Architecture-specific here: the
 * item vocabulary is the closed, ORDER-SIGNIFICANT lens enum, so the parsed
 * entries are narrowed back to `PanelLens` on the way out.
 */
export function parsePanelManifest(
  raw: unknown,
  expectedRunDir: string,
  layout: RunLayout<"architecture">,
  expectedLenses: readonly PanelLens[],
): ParseResult<PanelManifest> {
  const parsed = parseRunManifest(raw, expectedRunDir, layout, {
    label: "panel manifest",
    contextMdKey: "interview_file",
    contextJsonKey: "interview_json",
    itemsKey: "candidates",
    itemIdKey: "lens",
    itemNoun: ["candidate", "candidates"],
    expectedIds: expectedLenses,
    filenameOf: candidateFilename,
  });
  if (!parsed.ok) return fail(parsed.errors);

  // `entry.id` is a proven `PanelLens`, not a cast one: `parseRunManifest`
  // resolves each raw id against `expectedLenses` and returns that element.
  const candidates: PanelCandidate[] = parsed.value.entries.map((entry) => ({
    lens: entry.id,
    path: entry.path,
    filename: entry.filename,
  }));

  return ok({
    runId: parsed.value.runId,
    interviewFile: parsed.value.contextMd,
    interviewJson: parsed.value.contextJson,
    candidates,
  });
}

export type JudgeRanking = Readonly<{
  candidate: string;
  score: number;
  fatalFlaw: string | null;
  strongestIdea: string;
}>;

export type JudgeVerdict = Readonly<{
  criterion: string;
  rankings: readonly JudgeRanking[];
}>;

/** Payload parser for one ranking — the only architecture-specific part of the
 *  judge envelope. The candidate id, coverage, and duplicate rules all live in
 *  the kernel; this handles score/fatal_flaw/strongest_idea and nothing else. */
function parseJudgeRanking(
  raw: Record<string, unknown>,
  path: string,
  candidate: string,
): ParseResult<JudgeRanking> {
  const errors: string[] = [];

  const score = raw.score;
  const scoreValid = Number.isInteger(score) && (score as number) >= 0 && (score as number) <= 10;
  if (!scoreValid) errors.push(`${path}.score must be an integer from 0 to 10`);

  const fatalFlaw = raw.fatal_flaw;
  const fatalFlawTyped = fatalFlaw === null || typeof fatalFlaw === "string";
  if (!fatalFlawTyped) errors.push(`${path}.fatal_flaw must be a string or null`);
  const sanitizedFatalFlaw = typeof fatalFlaw === "string" ? sanitizeProse(fatalFlaw) : null;
  if (typeof fatalFlaw === "string" && !sanitizedFatalFlaw) {
    errors.push(`${path}.fatal_flaw must be non-empty after sanitization or null`);
  }

  const strongestIdea = typeof raw.strongest_idea === "string" ? sanitizeProse(raw.strongest_idea) : "";
  if (!strongestIdea) errors.push(`${path}.strongest_idea must be non-empty`);

  return errors.length > 0
    ? fail(errors)
    : ok({
        // The envelope resolved this against the expected candidate set; taking
        // it from there rather than re-reading `raw.candidate` is what stops the
        // proven value being replaced by an unproven one that merely compares
        // equal.
        candidate,
        score: score as number,
        fatalFlaw: sanitizedFatalFlaw,
        strongestIdea,
      });
}

/** The architecture panel's cross-entry rule: a judge ranks best-to-worst, so
 *  scores must not increase down the list. The review panel passes no
 *  crossCheck — its findings have no meaningful order. */
function requireNonIncreasingScores(rankings: readonly JudgeRanking[]): readonly string[] {
  for (let index = 1; index < rankings.length; index++) {
    if (rankings[index - 1]!.score < rankings[index]!.score) {
      return ["rankings must be ordered by non-increasing score"];
    }
  }
  return [];
}

/** Parse untrusted judge output and return canonical, substitution-safe data. */
export function parseJudgeVerdict(
  rawJson: string,
  expectedCriterion: string,
  expectedCandidates: readonly string[],
): ParseResult<JudgeVerdict> {
  const envelope = parseVerdictEnvelope<JudgeRanking>(rawJson, expectedCriterion, expectedCandidates, {
    label: "judge verdict",
    entriesKey: "rankings",
    itemIdKey: "candidate",
    itemNoun: ["candidate", "candidates"],
    parseEntry: parseJudgeRanking,
    crossCheck: requireNonIncreasingScores,
  });
  return envelope.ok
    ? ok({ criterion: envelope.value.criterion, rankings: envelope.value.entries })
    : fail(envelope.errors);
}

/** Serialize a validated verdict using the external snake_case contract. */
export function serializeJudgeVerdict(verdict: JudgeVerdict): string {
  return JSON.stringify({
    criterion: verdict.criterion,
    rankings: verdict.rankings.map((ranking) => ({
      candidate: ranking.candidate,
      score: ranking.score,
      fatal_flaw: ranking.fatalFlaw,
      strongest_idea: ranking.strongestIdea,
    })),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Aggregation — the deterministic cross-verdict ranking
// ---------------------------------------------------------------------------

/** One criterion's score for one candidate. A PAIR, not a positional slot in a
 *  `number[]` aligned to the criteria order by comment: `serializeRankings`
 *  re-zips the scores against a criteria array it takes as a SEPARATE
 *  parameter, so a caller passing the criteria in a different order than the
 *  one aggregation used would silently mislabel every score in the artifact
 *  that decides which architecture ships. Same reason `Refutation` is a pair. */
export type CriterionScore = Readonly<{ criterion: string; score: number }>;

export type CandidateRanking = Readonly<{
  candidate: string;
  totalScore: number;
  /** Per-criterion score, in the criteria order aggregation was given. */
  scores: readonly CriterionScore[];
}>;

/**
 * Total order over candidates: highest total, then each criterion in order,
 * then lexicographically smallest filename.
 *
 * With the total tied, walking the criteria in order reproduces the documented
 * primary-axis-then-testability tie-break exactly: if the total and every
 * earlier criterion tie, the remaining criterion is forced to tie too (the
 * total is their sum), so no later criterion can ever change the outcome. The
 * generalized form has no positional special cases and works for any K.
 *
 * Lexicographic comparison is done with `<` / `>` rather than localeCompare —
 * localeCompare's ordering is locale-dependent, and this must produce the same
 * ranking on every machine.
 */
function compareRankings(a: CandidateRanking, b: CandidateRanking): number {
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  for (let index = 0; index < a.scores.length; index++) {
    const delta = (b.scores[index]?.score ?? 0) - (a.scores[index]?.score ?? 0);
    if (delta !== 0) return delta;
  }
  return a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0;
}

/**
 * Rank candidates across all judge verdicts, deterministically.
 *
 * This computation used to live only as prose in phase-arch-finalize.md, which
 * meant the step that decides WHICH CANDIDATE WINS was the one step in the
 * panel pipeline an LLM performed by hand — every input to it was schema
 * validated, but the arithmetic and tie-break were not. Two specific hazards
 * came with that:
 *
 *   - the tie-break referred to verdicts POSITIONALLY ("the first verdict",
 *     "the second verdict"), coupling the finalize template to the criteria
 *     order in commands/loom.md with nothing enforcing the two agreed; and
 *   - nothing validated the verdict SET — the same per-item coverage rule
 *     parseJudgeVerdict enforces inside one verdict (every candidate exactly
 *     once, no foreign, no duplicates) had no analogue one level up, so two
 *     verdicts sharing a criterion would silently produce a wrong tie-break.
 *
 * Verdicts are matched to criteria BY NAME here, so their argument order is
 * irrelevant and a duplicated or missing criterion is a hard error.
 */
export function aggregateVerdicts(
  verdicts: readonly JudgeVerdict[],
  criteriaInOrder: readonly string[],
  expectedCandidates: readonly string[],
): ParseResult<readonly CandidateRanking[]> {
  const errors: string[] = [];

  // The criteria-set rule is the kernel's (parseCriteriaSet) — the review panel
  // enforces the identical rule over its own verdicts.
  const criteriaSet = parseCriteriaSet(verdicts.map((verdict) => verdict.criterion), criteriaInOrder);
  if (!criteriaSet.ok) errors.push(...criteriaSet.errors);

  if (expectedCandidates.length === 0) errors.push("expected candidates must be non-empty");
  if (new Set(expectedCandidates).size !== expectedCandidates.length) {
    errors.push("expected candidates must be distinct");
  }

  // `JudgeVerdict` is the kernel's envelope with `entries` renamed to
  // `rankings` for readability at the agent contract; re-widened here so the
  // shared coverage rule applies to it verbatim.
  const envelopes = new Map<string, VerdictEnvelope<JudgeRanking>>();
  for (const verdict of verdicts) {
    if (!envelopes.has(verdict.criterion)) {
      envelopes.set(verdict.criterion, { criterion: verdict.criterion, entries: verdict.rankings });
    }
  }

  if (errors.length > 0) return fail(errors);

  errors.push(
    ...coverageErrors(
      envelopes,
      criteriaInOrder,
      expectedCandidates,
      (ranking) => ranking.candidate,
      "must rank each expected candidate exactly once",
    ),
  );

  if (errors.length > 0) return fail(errors);

  const ranked = expectedCandidates.map((candidate): CandidateRanking => {
    // No `?? 0`: coverage above proves every (criterion, candidate) pair has a
    // ranking, and a defaulted zero would silently change which architecture
    // wins if that proof ever stopped holding.
    const scores = criteriaInOrder.map((criterion): CriterionScore => ({
      criterion,
      score: requireEntry(envelopes, criterion, candidate, (r) => r.candidate).score,
    }));
    return {
      candidate,
      totalScore: scores.reduce((sum, entry) => sum + entry.score, 0),
      scores,
    };
  });

  return ok([...ranked].sort(compareRankings));
}

/**
 * Serialize the aggregate ranking for substitution into the finalize prompt.
 *
 * `criteriaInOrder` names the criteria SET for the reader; it no longer re-zips
 * the scores, which now carry their own criterion. Re-zipping meant this
 * function and `aggregateVerdicts` had to be handed the same array in the same
 * order or every score in the output was silently mislabeled.
 */
export function serializeRankings(
  rankings: readonly CandidateRanking[],
  criteriaInOrder: readonly string[],
): string {
  return JSON.stringify({
    criteria: criteriaInOrder,
    ranking: rankings.map((entry, index) => ({
      rank: index + 1,
      candidate: entry.candidate,
      total_score: entry.totalScore,
      // An array, not an object keyed by criterion: criteria are free text and
      // would become untrusted object keys.
      scores: entry.scores.map((score) => ({ criterion: score.criterion, score: score.score })),
    })),
  }, null, 2);
}
