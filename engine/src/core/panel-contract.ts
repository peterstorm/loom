import { basename, join, normalize } from "node:path";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(errors: readonly string[]): ParseResult<T> => ({ ok: false, errors });

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

/** Derive the exact ordered lens set from validated interview signals and N. */
export function selectPanelLenses(
  digest: InterviewDigest,
  designerCount: number,
): ParseResult<readonly PanelLens[]> {
  if (!Number.isInteger(designerCount) || designerCount < 2 || designerCount > PANEL_LENSES.length) {
    return fail([`designer count must be an integer from 2 to ${PANEL_LENSES.length}`]);
  }

  const selected: PanelLens[] = ["simplicity-first", "type-driven-fp"];
  const signalLenses: readonly (PanelLens | null)[] = [
    digest.sensitiveBoundaries.startsWith("flagged") ? "risk-security-first" : null,
    digest.primaryAxis === "performance" ? "performance-first" : null,
    digest.codebaseMaturity === "brownfield" ? "codebase-conventionist" : null,
  ];
  for (const lens of [...signalLenses, ...PANEL_LENSES]) {
    if (lens && !selected.includes(lens)) selected.push(lens);
  }
  return ok(selected.slice(0, designerCount));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the exact candidate-set handoff and bind every path to one run root. */
export function parsePanelManifest(
  raw: unknown,
  expectedRunDir: string,
  expectedLenses: readonly PanelLens[],
): ParseResult<PanelManifest> {
  if (!isRecord(raw)) return fail(["panel manifest must be a JSON object"]);

  const errors: string[] = [];
  const runDir = normalize(expectedRunDir);
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  const interviewFile = typeof raw.interview_file === "string" ? raw.interview_file.trim() : "";
  const interviewJson = typeof raw.interview_json === "string" ? raw.interview_json.trim() : "";
  if (runId !== basename(runDir)) errors.push("manifest.run_id must equal the run directory basename");
  if (interviewFile !== join(runDir, "interview.md")) {
    errors.push("manifest.interview_file must exactly equal <run-dir>/interview.md");
  }
  if (interviewJson !== join(runDir, "interview.json")) {
    errors.push("manifest.interview_json must exactly equal <run-dir>/interview.json");
  }

  if (!Array.isArray(raw.candidates) || raw.candidates.length !== expectedLenses.length) {
    errors.push(`manifest.candidates must contain exactly ${expectedLenses.length} candidates`);
  }

  const candidates: PanelCandidate[] = [];
  if (Array.isArray(raw.candidates)) {
    for (const [index, candidate] of raw.candidates.entries()) {
      if (!isRecord(candidate)) {
        errors.push(`manifest.candidates[${index}] must be an object`);
        continue;
      }
      const lens = typeof candidate.lens === "string" ? candidate.lens.trim() : "";
      const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
      const filename = typeof candidate.filename === "string" ? candidate.filename.trim() : "";
      if (!(PANEL_LENSES as readonly string[]).includes(lens)) {
        errors.push(`manifest.candidates[${index}].lens is unknown: ${lens || "<empty>"}`);
      }
      const expectedFilename = `candidate-${lens}.md`;
      if (filename !== expectedFilename) {
        errors.push(`manifest.candidates[${index}].filename must equal ${expectedFilename}`);
      }
      if (path !== join(runDir, "candidates", expectedFilename)) {
        errors.push(`manifest.candidates[${index}].path must exactly equal its run-scoped candidate path`);
      }
      if ((PANEL_LENSES as readonly string[]).includes(lens)) {
        candidates.push({ lens: lens as PanelLens, path, filename });
      }
    }
  }

  const lenses = candidates.map((candidate) => candidate.lens);
  if (new Set(lenses).size !== lenses.length) errors.push("manifest candidate lenses must be unique");
  if (lenses.length === expectedLenses.length && lenses.some((lens, index) => lens !== expectedLenses[index])) {
    errors.push(`manifest candidate lenses must exactly match: ${expectedLenses.join(", ")}`);
  }
  const filenames = candidates.map((candidate) => candidate.filename);
  if (new Set(filenames).size !== filenames.length) errors.push("manifest candidate filenames must be unique");
  const paths = candidates.map((candidate) => candidate.path);
  if (new Set(paths).size !== paths.length) errors.push("manifest candidate paths must be unique");

  return errors.length > 0
    ? fail(errors)
    : ok({ runId, interviewFile, interviewJson, candidates });
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

const sanitizeProse = (value: string): string => value.replace(/[{}]/g, "").trim();

/** Parse untrusted judge output and return canonical, substitution-safe data. */
export function parseJudgeVerdict(
  rawJson: string,
  expectedCriterion: string,
  expectedCandidates: readonly string[],
): ParseResult<JudgeVerdict> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch (error) {
    return fail([`judge verdict is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!isRecord(raw)) return fail(["judge verdict must be a JSON object"]);

  const errors: string[] = [];
  if (raw.criterion !== expectedCriterion) {
    errors.push(`criterion must equal ${JSON.stringify(expectedCriterion)}`);
  }
  if (!Array.isArray(raw.rankings)) {
    return fail([...errors, "rankings must be an array"]);
  }
  if (raw.rankings.length !== expectedCandidates.length) {
    errors.push(`rankings must contain exactly ${expectedCandidates.length} candidates`);
  }

  const expected = new Set(expectedCandidates);
  const seen = new Set<string>();
  const rankings: JudgeRanking[] = [];

  for (const [index, ranking] of raw.rankings.entries()) {
    if (!isRecord(ranking)) {
      errors.push(`rankings[${index}] must be an object`);
      continue;
    }
    const candidate = typeof ranking.candidate === "string" ? ranking.candidate : "";
    const candidateValid = expected.has(candidate) && !seen.has(candidate);
    if (!expected.has(candidate)) errors.push(`rankings[${index}] has unknown candidate: ${candidate || "<empty>"}`);
    if (seen.has(candidate)) errors.push(`rankings contains duplicate candidate: ${candidate}`);
    seen.add(candidate);

    const score = ranking.score;
    const scoreValid =
      Number.isInteger(score) && (score as number) >= 0 && (score as number) <= 10;
    if (!scoreValid) {
      errors.push(`rankings[${index}].score must be an integer from 0 to 10`);
    }

    const fatalFlaw = ranking.fatal_flaw;
    const fatalFlawTyped = fatalFlaw === null || typeof fatalFlaw === "string";
    if (!fatalFlawTyped) {
      errors.push(`rankings[${index}].fatal_flaw must be a string or null`);
    }
    const sanitizedFatalFlaw = typeof fatalFlaw === "string" ? sanitizeProse(fatalFlaw) : null;
    const fatalFlawValid =
      fatalFlawTyped && !(typeof fatalFlaw === "string" && !sanitizedFatalFlaw);
    if (typeof fatalFlaw === "string" && !sanitizedFatalFlaw) {
      errors.push(`rankings[${index}].fatal_flaw must be non-empty after sanitization or null`);
    }
    const strongestIdea = typeof ranking.strongest_idea === "string"
      ? sanitizeProse(ranking.strongest_idea)
      : "";
    if (!strongestIdea) errors.push(`rankings[${index}].strongest_idea must be non-empty`);

    // Only fully-valid entries enter `rankings`. Previously every entry was
    // pushed, with an invalid score becoming Number.NaN purely to satisfy the
    // type — unreachable on the ok path (errors is non-empty, so we return
    // fail), but it left a NaN in a `score: number` field, and the ordering
    // scan below compares with `<`, which is ALWAYS false against NaN. Any
    // future reuse of this loop without the error guard would silently skip
    // the ordering check. Keeping the array free of NaN removes that trap.
    if (candidateValid && scoreValid && fatalFlawValid && strongestIdea) {
      rankings.push({
        candidate,
        score: score as number,
        fatalFlaw: sanitizedFatalFlaw,
        strongestIdea,
      });
    }
  }

  for (const candidate of expectedCandidates) {
    if (!seen.has(candidate)) errors.push(`rankings is missing candidate: ${candidate}`);
  }
  for (let index = 1; index < rankings.length; index++) {
    if (rankings[index - 1]!.score < rankings[index]!.score) {
      errors.push("rankings must be ordered by non-increasing score");
      break;
    }
  }

  return errors.length > 0
    ? fail(errors)
    : ok({ criterion: expectedCriterion, rankings });
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

export type CandidateRanking = Readonly<{
  candidate: string;
  totalScore: number;
  /** Per-criterion score, positionally aligned with the criteria order. */
  scores: readonly number[];
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
    const delta = (b.scores[index] ?? 0) - (a.scores[index] ?? 0);
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

  if (criteriaInOrder.length === 0) errors.push("criteria must be non-empty");
  if (new Set(criteriaInOrder).size !== criteriaInOrder.length) {
    errors.push("criteria must be distinct");
  }
  if (expectedCandidates.length === 0) errors.push("expected candidates must be non-empty");
  if (new Set(expectedCandidates).size !== expectedCandidates.length) {
    errors.push("expected candidates must be distinct");
  }
  if (verdicts.length !== criteriaInOrder.length) {
    errors.push(`expected exactly ${criteriaInOrder.length} verdict(s); received ${verdicts.length}`);
  }

  const byCriterion = new Map<string, JudgeVerdict>();
  for (const verdict of verdicts) {
    if (byCriterion.has(verdict.criterion)) {
      errors.push(`duplicate verdict for criterion: ${verdict.criterion}`);
      continue;
    }
    if (!criteriaInOrder.includes(verdict.criterion)) {
      errors.push(`unexpected verdict criterion: ${verdict.criterion}`);
      continue;
    }
    byCriterion.set(verdict.criterion, verdict);
  }
  for (const criterion of criteriaInOrder) {
    if (!byCriterion.has(criterion)) errors.push(`missing verdict for criterion: ${criterion}`);
  }

  if (errors.length > 0) return fail(errors);

  // Re-check candidate coverage per verdict so this function is safe to call
  // standalone, not only downstream of parseJudgeVerdict.
  const expected = new Set(expectedCandidates);
  for (const criterion of criteriaInOrder) {
    const verdict = byCriterion.get(criterion);
    if (!verdict) continue;
    const seen = new Set(verdict.rankings.map((ranking) => ranking.candidate));
    const covers =
      verdict.rankings.length === expectedCandidates.length &&
      seen.size === verdict.rankings.length &&
      [...seen].every((candidate) => expected.has(candidate));
    if (!covers) {
      errors.push(`verdict for '${criterion}' must rank each expected candidate exactly once`);
    }
  }

  if (errors.length > 0) return fail(errors);

  const ranked = expectedCandidates.map((candidate): CandidateRanking => {
    const scores = criteriaInOrder.map((criterion) => {
      const verdict = byCriterion.get(criterion);
      return verdict?.rankings.find((ranking) => ranking.candidate === candidate)?.score ?? 0;
    });
    return {
      candidate,
      totalScore: scores.reduce((sum, score) => sum + score, 0),
      scores,
    };
  });

  return ok([...ranked].sort(compareRankings));
}

/** Serialize the aggregate ranking for substitution into the finalize prompt. */
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
      scores: criteriaInOrder.map((criterion, position) => ({
        criterion,
        score: entry.scores[position] ?? 0,
      })),
    })),
  }, null, 2);
}
