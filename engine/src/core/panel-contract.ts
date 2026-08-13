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

export const SENSITIVE_BOUNDARY_STATUSES = ["flagged", "none"] as const;
export type SensitiveBoundaryStatus = (typeof SENSITIVE_BOUNDARY_STATUSES)[number];

/**
 * Free prose that PROVABLY begins with `flagged` or `none`.
 *
 * The status drives lens selection — a `flagged` digest pulls the
 * security-first lens into the panel — and it is read by prefix. As a bare
 * `string` the field admitted any text, so `{ ...digest, sensitiveBoundaries:
 * "lorem ipsum" }` type-checked as a legal digest and silently selected the
 * panel WITHOUT its security lens rather than being rejected. Branding it makes
 * `parseInterviewDigest`, which normalises the prefix, the only way to obtain
 * one — the same treatment `CandidateFilename` already gets in this file, and
 * the same narrowing its two sibling enum fields get from the same parser.
 */
declare const SENSITIVE_BOUNDARIES: unique symbol;
export type SensitiveBoundaries = string & { readonly [SENSITIVE_BOUNDARIES]: true };

/** The proven status, read from a value only the parser can have produced. */
export function sensitiveBoundaryStatus(value: SensitiveBoundaries): SensitiveBoundaryStatus {
  return value.startsWith("flagged") ? "flagged" : "none";
}

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
  "primaryAxis" | "testabilityBar" | "codebaseMaturity" | "sensitiveBoundaries"
> & {
  readonly primaryAxis: PrimaryAxis;
  readonly testabilityBar: TestabilityBar;
  readonly codebaseMaturity: CodebaseMaturity;
  readonly sensitiveBoundaries: SensitiveBoundaries;
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
    // The single mint: the prefix is normalised to the exact status here, which
    // is what the brand asserts everywhere downstream.
    sensitiveBoundaries: sensitiveBoundaries.replace(/^(flagged|none)/i, sensitiveStatus) as SensitiveBoundaries,
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
 * The closed judge-criterion vocabulary: exactly what deriveJudgeCriteria can
 *  produce — the primary axes, the testability bars, and the fixed
 *  codebase-fit literal. The three vocabularies are pairwise disjoint
 *  (asserted in panel-contract.test.ts), so no two criteria can collide and
 *  aggregateVerdicts' distinctness precondition holds for every valid digest.
 *  A checkpoint file's criteria were produced by the same derivation when
 *  written, so lookup is the mint: a criterion outside this set cannot come
 *  from a validated digest and is rejected rather than asserted into the
 *  brand.
 */
const ARCHITECTURE_CRITERIA_VOCAB: readonly string[] = [
  ...PRIMARY_AXES,
  ...TESTABILITY_BARS,
  CODEBASE_FIT_CRITERION,
];

declare const ARCHITECTURE_CRITERION: unique symbol;
export type ArchitectureCriterion = string & { readonly [ARCHITECTURE_CRITERION]: true };

/** The ONLY constructor of `ArchitectureCriterion` — membership in the closed
 *  vocabulary. A free-text string is not a criterion; checkpoints are
 *  untrusted input and were produced by the same derivation when written. */
export function architectureCriterion(raw: string): ArchitectureCriterion | null {
  return ARCHITECTURE_CRITERIA_VOCAB.includes(raw) ? raw as ArchitectureCriterion : null;
}

/** Total on the validated enum union: every primary axis, testability bar,
 *  and the fixed literal is a vocabulary member by construction, so the brand
 *  is claimed from the ARGUMENT TYPE rather than an unproven assertion.
 *  Untrusted strings must go through `architectureCriterion` (nullable). */
export function criterionOf(
  value: PrimaryAxis | TestabilityBar | typeof CODEBASE_FIT_CRITERION,
): ArchitectureCriterion {
  return value as ArchitectureCriterion;
}

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
export function deriveJudgeCriteria(digest: InterviewDigest): readonly ArchitectureCriterion[] {
  return [
    criterionOf(digest.primaryAxis),
    criterionOf(digest.testabilityBar),
    criterionOf(CODEBASE_FIT_CRITERION),
  ];
}

/** Always designed, whatever the interview said. Also the minimum panel size —
 *  the mandatory approach gate needs at least two options to choose between.
 *  EXPORTED because `config.PANEL_DESIGNERS_MIN` derives its value from this
 *  array's length rather than restating it, mirroring the review panel's
 *  `REVIEW_LENSES_MIN`. Adding a baseline lens must move the minimum with it. */
export const PANEL_BASELINE_LENSES: readonly PanelLens[] = ["simplicity-first", "type-driven-fp"];

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
    baseline: PANEL_BASELINE_LENSES,
    signalled: [
      sensitiveBoundaryStatus(digest.sensitiveBoundaries) === "flagged" ? "risk-security-first" : null,
      digest.primaryAxis === "performance" ? "performance-first" : null,
      digest.codebaseMaturity === "brownfield" ? "codebase-conventionist" : null,
    ],
    table: PANEL_LENSES,
    count: designerCount,
    countLabel: "designer count",
  });
}

declare const CANDIDATE_FILENAME: unique symbol;

/**
 * A candidate's run-scoped artifact filename — the architecture panel's item id.
 *
 * Branded for the reason `WaveFindingId` is. Every id the panel threads through
 * `parseJudgeVerdict` / `aggregateVerdicts` was a bare `string`, so a lens name
 * and a candidate filename were interchangeable at every call site: the handler
 * passing `candidates.map(c => c.lens)` where `candidates.map(c => c.filename)`
 * belonged type-checked, and the two differ by exactly the `candidate-` prefix
 * and `.md` suffix that make the id unique per run. The kernel's `Id extends
 * string` parameter was built to carry a brand and the architecture consumer
 * had not taken it. `candidateFilename` is the only constructor.
 */
export type CandidateFilename = string & { readonly [CANDIDATE_FILENAME]: true };

export type PanelCandidate = Readonly<{
  lens: PanelLens;
  path: string;
  filename: CandidateFilename;
}>;

export type PanelManifest = Readonly<{
  runId: string;
  interviewFile: string;
  interviewJson: string;
  candidates: readonly PanelCandidate[];
}>;

/** Run-scoped artifact filename for one lens's candidate. The ONLY constructor
 *  of `CandidateFilename` — mint here or the compiler will not accept it as a
 *  candidate id, which is what keeps a lens name out of that position. */
export function candidateFilename(lens: PanelLens): CandidateFilename {
  return `candidate-${lens}.md` as CandidateFilename;
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
  //
  // The filename is re-MINTED through `candidateFilename` rather than branded by
  // assertion. `parseRunManifest` has just proved `entry.filename` equals
  // `spec.filenameOf(entry.id)`, so the two are the same string — and going
  // through the constructor means the brand is never claimed for a value the
  // constructor did not produce.
  const candidates: PanelCandidate[] = parsed.value.entries.map((entry) => ({
    lens: entry.id,
    path: entry.path,
    filename: candidateFilename(entry.id),
  }));

  return ok({
    runId: parsed.value.runId,
    interviewFile: parsed.value.contextMd,
    interviewJson: parsed.value.contextJson,
    candidates,
  });
}

export type JudgeRanking = Readonly<{
  candidate: CandidateFilename;
  score: number;
  fatalFlaw: string | null;
  strongestIdea: string;
}>;

/**
 * One judge's verdict IS the kernel's envelope — there is no architecture-
 * specific shape here.
 *
 * It used to be a distinct `{ criterion, rankings }` record that
 * `aggregateVerdicts` immediately un-renamed back into
 * `VerdictEnvelope<JudgeRanking>` so the shared coverage rule could apply. A
 * type whose only consumer reverses it is a rename layer, not an abstraction;
 * its review-panel sibling `parseRefutationVerdict` returns the envelope
 * directly and needs none. The external `rankings` field name is owned by
 * `serializeJudgeVerdict` and the envelope spec's `entriesKey`, which is where
 * the agent contract actually lives.
 */
export type JudgeVerdict = VerdictEnvelope<JudgeRanking>;

/** Payload parser for one ranking — the only architecture-specific part of the
 *  judge envelope. The candidate id, coverage, and duplicate rules all live in
 *  the kernel; this handles score/fatal_flaw/strongest_idea and nothing else. */
function parseJudgeRanking(
  raw: Record<string, unknown>,
  path: string,
  candidate: CandidateFilename,
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
  expectedCandidates: readonly CandidateFilename[],
): ParseResult<JudgeVerdict> {
  return parseVerdictEnvelope<JudgeRanking, CandidateFilename>(
    rawJson,
    expectedCriterion,
    expectedCandidates,
    {
      label: "judge verdict",
      entriesKey: "rankings",
      itemIdKey: "candidate",
      itemNoun: ["candidate", "candidates"],
      parseEntry: parseJudgeRanking,
      crossCheck: requireNonIncreasingScores,
    },
  );
}

/** Serialize a validated verdict using the external snake_case contract. */
export function serializeJudgeVerdict(verdict: JudgeVerdict): string {
  return JSON.stringify({
    criterion: verdict.criterion,
    rankings: verdict.entries.map((ranking) => ({
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
  candidate: CandidateFilename;
  totalScore: number;
  /** Per-criterion score, in the criteria order aggregation was given. */
  scores: readonly CriterionScore[];
}>;

/** The score domain one ranking may carry. Judges score 0–10 per criterion. */
const SCORE_MIN = 0;
const SCORE_MAX = 10;

/**
 * Total order over candidates: highest total, then each criterion in order,
 * then lexicographically smallest filename.
 *
 * With the total tied, walking the criteria in order reproduces the documented
 * primary-axis-then-testability tie-break exactly. At K=3 the last criterion is
 * forced (the total is their sum), but the loop is written for any K and every
 * position is load-bearing: it is what makes the CRITERIA ORDER the tie-break
 * order, so `aggregateVerdicts` and its caller must agree on that order or a
 * different architecture ships on a tie. Pinned by a property test over ≥3
 * criteria — while only index 0 was asserted, capping the loop at one criterion
 * left the whole suite green.
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
  expectedCandidates: readonly CandidateFilename[],
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

  // The score domain, re-proven here rather than assumed from parseJudgeRanking.
  // `panel-kernel` documents both aggregators as "exported and safe to call
  // standalone" — that is the stated reason `coverageErrors` is deliberately
  // redundant — and standalone this accepted anything: a NaN score made the
  // comparator return NaN, which `Array.prototype.sort` treats as 0, so the
  // candidate came out RANK 1 with a `total_score` of null in the artifact that
  // decides which architecture ships.
  for (const verdict of verdicts) {
    for (const ranking of verdict.entries) {
      if (
        !Number.isInteger(ranking.score) ||
        ranking.score < SCORE_MIN ||
        ranking.score > SCORE_MAX
      ) {
        errors.push(
          `verdict for '${verdict.criterion}': score for ${ranking.candidate} must be an integer ` +
            `from ${SCORE_MIN} to ${SCORE_MAX}, got ${JSON.stringify(ranking.score)}`,
        );
      }
    }
  }

  const envelopes = new Map<string, VerdictEnvelope<JudgeRanking>>();
  for (const verdict of verdicts) {
    if (!envelopes.has(verdict.criterion)) envelopes.set(verdict.criterion, verdict);
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
