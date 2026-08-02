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

  return ok({
    ...(values as InterviewValues),
    primaryAxis: primaryAxis as PrimaryAxis,
    testabilityBar: testabilityBar as TestabilityBar,
    codebaseMaturity: codebaseMaturity as CodebaseMaturity,
    sensitiveBoundaries: sensitiveBoundaries!.replace(/^(flagged|none)/i, sensitiveStatus!),
  });
}

/** Re-parse the canonical JSON artifact instead of trusting prior validation. */
export function parseInterviewDigestJson(raw: unknown): ParseResult<InterviewDigest> {
  if (!isRecord(raw)) return fail(["canonical interview digest must be a JSON object"]);
  const markdown = INTERVIEW_FIELDS.map(([key, label]) => {
    const value = raw[key];
    return `${label} ${typeof value === "string" ? value : ""}`;
  }).join("\n");
  return parseInterviewDigest(markdown);
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
    if (!expected.has(candidate)) errors.push(`rankings[${index}] has unknown candidate: ${candidate || "<empty>"}`);
    if (seen.has(candidate)) errors.push(`rankings contains duplicate candidate: ${candidate}`);
    seen.add(candidate);

    const score = ranking.score;
    if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 10) {
      errors.push(`rankings[${index}].score must be an integer from 0 to 10`);
    }

    const fatalFlaw = ranking.fatal_flaw;
    if (fatalFlaw !== null && typeof fatalFlaw !== "string") {
      errors.push(`rankings[${index}].fatal_flaw must be a string or null`);
    }
    const sanitizedFatalFlaw = typeof fatalFlaw === "string" ? sanitizeProse(fatalFlaw) : null;
    if (typeof fatalFlaw === "string" && !sanitizedFatalFlaw) {
      errors.push(`rankings[${index}].fatal_flaw must be non-empty after sanitization or null`);
    }
    const strongestIdea = typeof ranking.strongest_idea === "string"
      ? sanitizeProse(ranking.strongest_idea)
      : "";
    if (!strongestIdea) errors.push(`rankings[${index}].strongest_idea must be non-empty`);

    rankings.push({
      candidate,
      score: typeof score === "number" ? score : Number.NaN,
      fatalFlaw: sanitizedFatalFlaw,
      strongestIdea,
    });
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
