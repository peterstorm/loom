/**
 * Pure deterministic scoring for historical model calibration.
 *
 * Corpus and prediction files are untrusted JSON boundaries. Matching is a
 * deterministic maximum-cardinality one-to-one assignment. On fixed snapshots
 * only predictions matching a committed known finding are classified as known
 * false positives; unmatched novel predictions remain explicitly unclassified.
 */

import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";

export const CALIBRATION_SCHEMA_VERSION = 1 as const;
export const CALIBRATION_CASE_STATES = ["vulnerable", "fixed"] as const;
export type CalibrationCaseState = (typeof CALIBRATION_CASE_STATES)[number];

export interface FindingMatchRule {
  readonly allOf: readonly string[];
  readonly anyOf: readonly string[];
}

export interface CalibrationExpectation {
  readonly id: string;
  readonly claim: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly aliases: readonly string[];
  readonly match: FindingMatchRule | null;
}

export interface CalibrationCase {
  readonly id: string;
  readonly state: CalibrationCaseState;
  readonly revision: string;
  readonly expectedCriticals: readonly CalibrationExpectation[];
  readonly context: Readonly<Record<string, unknown>>;
}

export interface CalibrationCorpus {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly cases: readonly CalibrationCase[];
}

export interface CalibrationPrediction {
  readonly claim: string;
  readonly file: string | null;
  readonly line: number | null;
}

export type CalibrationPredictionCase =
  | {
      readonly caseId: string;
      readonly status: "executed";
      readonly predictions: readonly CalibrationPrediction[];
    }
  | {
      readonly caseId: string;
      readonly status: "not-executed";
      readonly reason: string;
    };

export interface CalibrationPredictions {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly profileId: string;
  readonly cases: readonly CalibrationPredictionCase[];
}

export interface FindingMatch {
  readonly expectation: CalibrationExpectation;
  readonly prediction: CalibrationPrediction;
}

export interface FindingMatching {
  readonly matches: readonly FindingMatch[];
  readonly missedExpectations: readonly CalibrationExpectation[];
  /** Unclassified; notably, this is not a false-positive collection. */
  readonly novelPredictions: readonly CalibrationPrediction[];
}

export type CalibrationCaseScore =
  | {
      readonly caseId: string;
      readonly state: CalibrationCaseState;
      readonly execution: "not-executed";
      readonly reason: string;
    }
  | {
      readonly caseId: string;
      readonly state: "vulnerable";
      readonly execution: "executed";
      readonly expectedCount: number;
      readonly detectedCount: number;
      readonly missedExpectations: readonly CalibrationExpectation[];
      readonly novelPredictions: readonly CalibrationPrediction[];
      readonly recall: number | null;
    }
  | {
      readonly caseId: string;
      readonly state: "fixed";
      readonly execution: "executed";
      readonly knownFindingCount: number;
      readonly knownFalsePositiveCount: number;
      readonly avoidedKnownFindingCount: number;
      readonly knownFalsePositives: readonly FindingMatch[];
      readonly novelPredictions: readonly CalibrationPrediction[];
      readonly avoidanceRate: number | null;
    };

export interface VulnerableCalibrationScore {
  readonly caseCount: number;
  readonly executedCaseCount: number;
  readonly expectedCount: number;
  readonly detectedCount: number;
  readonly missedCount: number;
  readonly recall: number | null;
}

export interface FixedCalibrationScore {
  readonly caseCount: number;
  readonly executedCaseCount: number;
  readonly knownFindingCount: number;
  readonly knownFalsePositiveCount: number;
  readonly avoidedKnownFindingCount: number;
  readonly avoidanceRate: number | null;
}

export interface CalibrationScore {
  readonly profileId: string;
  /** Incomplete can never be interpreted as a passed calibration. */
  readonly execution: "complete" | "incomplete";
  readonly vulnerable: VulnerableCalibrationScore;
  readonly fixed: FixedCalibrationScore;
  readonly novelPredictionCount: number;
  readonly cases: readonly CalibrationCaseScore[];
}

const GIT_REVISION = /^[0-9a-f]{7,64}$/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseRawJson(raw: unknown, label: string): ParseResult<Record<string, unknown>> {
  if (typeof raw !== "string") return isRecord(raw) ? ok(raw) : fail([`${label} must be a JSON object`]);
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? ok(parsed) : fail([`${label} JSON must contain an object`]);
  } catch (error) {
    return fail([`${label} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`]);
  }
}

function nonEmptyString(raw: unknown, label: string): ParseResult<string> {
  return typeof raw === "string" && raw.trim() !== ""
    ? ok(raw.trim())
    : fail([`${label} must be a non-empty string`]);
}

function nullableFile(raw: unknown, label: string): ParseResult<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string" || raw.trim() === "" || /[\r\n\0]/.test(raw)) {
    return fail([`${label} must be a non-empty single-line string or null`]);
  }
  return ok(raw.trim());
}

function nullableLine(raw: unknown, label: string): ParseResult<number | null> {
  if (raw === undefined || raw === null) return ok(null);
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? ok(raw)
    : fail([`${label} must be a positive integer or null`]);
}

function stringSet(raw: unknown, label: string, optional: boolean): ParseResult<readonly string[]> {
  if (raw === undefined && optional) return ok([]);
  if (!Array.isArray(raw)) return fail([`${label} must be an array of non-empty strings`]);
  const values: string[] = [];
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = nonEmptyString(entry, `${label}[${index}]`);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  const normalized = values.map(normalizeFindingText);
  const duplicate = normalized.findIndex((value, index) => normalized.indexOf(value) !== index);
  if (duplicate >= 0) errors.push(`${label} contains a duplicate term '${values[duplicate]}'`);
  return errors.length === 0 ? ok(values) : fail(errors);
}

function parseMatchRule(raw: unknown, label: string): ParseResult<FindingMatchRule | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (!isRecord(raw)) return fail([`${label} must be an object or null`]);
  const allOf = stringSet(raw.all_of, `${label}.all_of`, true);
  const anyOf = stringSet(raw.any_of, `${label}.any_of`, true);
  if (!allOf.ok || !anyOf.ok) {
    return fail([
      ...(allOf.ok ? [] : allOf.errors),
      ...(anyOf.ok ? [] : anyOf.errors),
    ]);
  }
  if (allOf.value.length === 0 && anyOf.value.length === 0) {
    return fail([`${label} must contain at least one all_of or any_of term`]);
  }
  return ok({ allOf: allOf.value, anyOf: anyOf.value });
}

function parseExpectation(raw: unknown, label: string): ParseResult<CalibrationExpectation> {
  if (!isRecord(raw)) return fail([`${label} must be an object`]);
  const id = nonEmptyString(raw.id, `${label}.id`);
  const claim = nonEmptyString(raw.claim, `${label}.claim`);
  const file = nullableFile(raw.file, `${label}.file`);
  const line = nullableLine(raw.line, `${label}.line`);
  const aliases = stringSet(raw.aliases, `${label}.aliases`, true);
  const match = parseMatchRule(raw.match, `${label}.match`);
  const parsed = [id, claim, file, line, aliases, match];
  const errors = parsed.flatMap((entry) => entry.ok ? [] : entry.errors);
  if (errors.length > 0 || !id.ok || !claim.ok || !file.ok || !line.ok || !aliases.ok || !match.ok) {
    return fail(errors);
  }
  return ok({
    id: id.value,
    claim: claim.value,
    file: file.value,
    line: line.value,
    aliases: aliases.value,
    match: match.value,
  });
}

function parseCorpusCase(raw: unknown, label: string): ParseResult<CalibrationCase> {
  if (!isRecord(raw)) return fail([`${label} must be an object`]);
  const id = nonEmptyString(raw.id, `${label}.id`);
  const revision = nonEmptyString(raw.revision, `${label}.revision`);
  const state = typeof raw.state === "string" && (CALIBRATION_CASE_STATES as readonly string[]).includes(raw.state)
    ? raw.state as CalibrationCaseState
    : null;
  const errors: string[] = [];
  if (!id.ok) errors.push(...id.errors);
  if (!revision.ok) errors.push(...revision.errors);
  else if (!GIT_REVISION.test(revision.value)) errors.push(`${label}.revision must be a 7- to 64-character lowercase hexadecimal git revision`);
  if (state === null) errors.push(`${label}.state must be vulnerable or fixed`);
  if (!Array.isArray(raw.expected_criticals) || raw.expected_criticals.length === 0) {
    errors.push(`${label}.expected_criticals must be a non-empty array`);
  }
  const expectations: CalibrationExpectation[] = [];
  if (Array.isArray(raw.expected_criticals)) {
    raw.expected_criticals.forEach((entry, index) => {
      const parsed = parseExpectation(entry, `${label}.expected_criticals[${index}]`);
      if (parsed.ok) expectations.push(parsed.value);
      else errors.push(...parsed.errors);
    });
  }
  const ids = expectations.map((expectation) => expectation.id);
  const duplicate = ids.findIndex((value, index) => ids.indexOf(value) !== index);
  if (duplicate >= 0) errors.push(`${label}.expected_criticals repeats id '${ids[duplicate]}'`);
  if (errors.length > 0 || !id.ok || !revision.ok || state === null) return fail(errors);

  const context = isRecord(raw.context) ? { ...raw.context } : {};
  return ok({
    id: id.value,
    state,
    revision: revision.value,
    expectedCriticals: [...expectations].sort((left, right) => compareStrings(left.id, right.id)),
    context,
  });
}

/** Parse and canonicalize a calibration corpus. */
export function parseCalibrationCorpus(raw: unknown): ParseResult<CalibrationCorpus> {
  const object = parseRawJson(raw, "calibration corpus");
  if (!object.ok) return object;
  const errors: string[] = [];
  if (object.value.schema_version !== CALIBRATION_SCHEMA_VERSION) {
    errors.push(`calibration corpus.schema_version must equal ${CALIBRATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(object.value.cases) || object.value.cases.length === 0) {
    errors.push("calibration corpus.cases must be a non-empty array");
  }
  const cases: CalibrationCase[] = [];
  if (Array.isArray(object.value.cases)) {
    object.value.cases.forEach((entry, index) => {
      const parsed = parseCorpusCase(entry, `calibration corpus.cases[${index}]`);
      if (parsed.ok) cases.push(parsed.value);
      else errors.push(...parsed.errors);
    });
  }
  const ids = cases.map((entry) => entry.id);
  const duplicate = ids.findIndex((value, index) => ids.indexOf(value) !== index);
  if (duplicate >= 0) errors.push(`calibration corpus repeats case id '${ids[duplicate]}'`);
  return errors.length === 0
    ? ok({ schemaVersion: CALIBRATION_SCHEMA_VERSION, cases: [...cases].sort((a, b) => compareStrings(a.id, b.id)) })
    : fail(errors);
}

function parsePrediction(raw: unknown, label: string): ParseResult<CalibrationPrediction> {
  if (!isRecord(raw)) return fail([`${label} must be an object`]);
  if (raw.severity !== "critical") return fail([`${label}.severity must equal critical`]);
  const claim = nonEmptyString(raw.claim, `${label}.claim`);
  const file = nullableFile(raw.file, `${label}.file`);
  const line = nullableLine(raw.line, `${label}.line`);
  const errors = [claim, file, line].flatMap((entry) => entry.ok ? [] : entry.errors);
  return errors.length === 0 && claim.ok && file.ok && line.ok
    ? ok({ claim: claim.value, file: file.value, line: line.value })
    : fail(errors);
}

function predictionKey(prediction: CalibrationPrediction): string {
  return `${normalizeFindingText(prediction.claim)}\0${prediction.file ?? ""}\0${prediction.line ?? 0}`;
}

function parsePredictionCase(raw: unknown, label: string): ParseResult<CalibrationPredictionCase> {
  if (!isRecord(raw)) return fail([`${label} must be an object`]);
  const caseId = nonEmptyString(raw.case_id, `${label}.case_id`);
  if (!caseId.ok) return caseId;
  if (raw.status === "not-executed") {
    const reason = nonEmptyString(raw.reason, `${label}.reason`);
    return reason.ok
      ? ok({ caseId: caseId.value, status: "not-executed", reason: reason.value })
      : reason;
  }
  if (raw.status !== "executed") return fail([`${label}.status must be executed or not-executed`]);
  if (!Array.isArray(raw.findings)) return fail([`${label}.findings must be an array`]);
  const errors: string[] = [];
  const predictions: CalibrationPrediction[] = [];
  raw.findings.forEach((entry, index) => {
    const parsed = parsePrediction(entry, `${label}.findings[${index}]`);
    if (parsed.ok) predictions.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  return errors.length === 0
    ? ok({
        caseId: caseId.value,
        status: "executed",
        predictions: [...predictions].sort((left, right) => compareStrings(predictionKey(left), predictionKey(right))),
      })
    : fail(errors);
}

/** Parse canonical prediction output, retaining unexecuted cases as data. */
export function parseCalibrationPredictions(raw: unknown): ParseResult<CalibrationPredictions> {
  const object = parseRawJson(raw, "calibration predictions");
  if (!object.ok) return object;
  const errors: string[] = [];
  if (object.value.schema_version !== CALIBRATION_SCHEMA_VERSION) {
    errors.push(`calibration predictions.schema_version must equal ${CALIBRATION_SCHEMA_VERSION}`);
  }
  const profileId = nonEmptyString(object.value.profile_id, "calibration predictions.profile_id");
  if (!profileId.ok) errors.push(...profileId.errors);
  if (!Array.isArray(object.value.cases) || object.value.cases.length === 0) {
    errors.push("calibration predictions.cases must be a non-empty array");
  }
  const cases: CalibrationPredictionCase[] = [];
  if (Array.isArray(object.value.cases)) {
    object.value.cases.forEach((entry, index) => {
      const parsed = parsePredictionCase(entry, `calibration predictions.cases[${index}]`);
      if (parsed.ok) cases.push(parsed.value);
      else errors.push(...parsed.errors);
    });
  }
  const ids = cases.map((entry) => entry.caseId);
  const duplicate = ids.findIndex((value, index) => ids.indexOf(value) !== index);
  if (duplicate >= 0) errors.push(`calibration predictions repeats case id '${ids[duplicate]}'`);
  return errors.length === 0 && profileId.ok
    ? ok({
        schemaVersion: CALIBRATION_SCHEMA_VERSION,
        profileId: profileId.value,
        cases: [...cases].sort((a, b) => compareStrings(a.caseId, b.caseId)),
      })
    : fail(errors);
}

/** Normalize only for matching; original prose is retained in every report. */
export function normalizeFindingText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function matchQuality(expectation: CalibrationExpectation, prediction: CalibrationPrediction): number {
  if (expectation.file !== null && prediction.file !== null && expectation.file !== prediction.file) return 0;
  const claim = normalizeFindingText(prediction.claim);
  const expectedClaims = [expectation.claim, ...expectation.aliases].map(normalizeFindingText);
  const exactIndex = expectedClaims.indexOf(claim);
  let quality = exactIndex === 0 ? 100 : exactIndex > 0 ? 95 : 0;

  if (expectation.match !== null) {
    const all = expectation.match.allOf.map(normalizeFindingText);
    const any = expectation.match.anyOf.map(normalizeFindingText);
    const allMatch = all.every((term) => claim.includes(term));
    const anyMatch = any.length === 0 || any.some((term) => claim.includes(term));
    if (allMatch && anyMatch) quality = Math.max(quality, 80);
  }
  if (quality === 0) return 0;
  if (expectation.file !== null && prediction.file === expectation.file) quality += 10;
  if (expectation.line !== null && prediction.line === expectation.line) quality += 2;
  return quality;
}

/**
 * Maximum-cardinality deterministic bipartite matching. Expectations and
 * predictions are canonically ordered before augmenting, and higher-quality
 * edges are attempted first. A prediction can occupy at most one slot.
 */
export function matchCalibrationFindings(
  expectations: readonly CalibrationExpectation[],
  predictions: readonly CalibrationPrediction[],
): FindingMatching {
  const orderedExpectations = [...expectations].sort((a, b) => compareStrings(a.id, b.id));
  const orderedPredictions = [...predictions].sort((a, b) => compareStrings(predictionKey(a), predictionKey(b)));
  const candidates = orderedExpectations.map((expectation) =>
    orderedPredictions
      .map((prediction, index) => ({ index, quality: matchQuality(expectation, prediction) }))
      .filter((edge) => edge.quality > 0)
      .sort((left, right) => right.quality - left.quality || left.index - right.index),
  );
  const expectationOrder = orderedExpectations
    .map((_, index) => index)
    .sort((left, right) => candidates[left]!.length - candidates[right]!.length || compareStrings(orderedExpectations[left]!.id, orderedExpectations[right]!.id));
  const predictionOwner = new Map<number, number>();

  const assign = (expectationIndex: number, visited: Set<number>): boolean => {
    for (const edge of candidates[expectationIndex]!) {
      if (visited.has(edge.index)) continue;
      visited.add(edge.index);
      const owner = predictionOwner.get(edge.index);
      if (owner === undefined || assign(owner, visited)) {
        predictionOwner.set(edge.index, expectationIndex);
        return true;
      }
    }
    return false;
  };
  for (const expectationIndex of expectationOrder) assign(expectationIndex, new Set<number>());

  const predictionByExpectation = new Map<number, number>();
  for (const [predictionIndex, expectationIndex] of predictionOwner) {
    predictionByExpectation.set(expectationIndex, predictionIndex);
  }
  const matches = orderedExpectations.flatMap((expectation, expectationIndex): readonly FindingMatch[] => {
    const predictionIndex = predictionByExpectation.get(expectationIndex);
    return predictionIndex === undefined
      ? []
      : [{ expectation, prediction: orderedPredictions[predictionIndex]! }];
  });
  const matchedExpectationIds = new Set(matches.map((match) => match.expectation.id));
  const matchedPredictions = new Set(predictionOwner.keys());
  return {
    matches,
    missedExpectations: orderedExpectations.filter((expectation) => !matchedExpectationIds.has(expectation.id)),
    novelPredictions: orderedPredictions.filter((_, index) => !matchedPredictions.has(index)),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Score one profile run against the exact corpus case set. */
export function scoreCalibration(
  corpus: CalibrationCorpus,
  predictions: CalibrationPredictions,
): ParseResult<CalibrationScore> {
  const expectedIds = corpus.cases.map((entry) => entry.id);
  const actualIds = predictions.cases.map((entry) => entry.caseId);
  const errors: string[] = [];
  for (const id of expectedIds) if (!actualIds.includes(id)) errors.push(`predictions are missing corpus case '${id}'`);
  for (const id of actualIds) if (!expectedIds.includes(id)) errors.push(`predictions contain foreign case '${id}'`);
  if (new Set(expectedIds).size !== expectedIds.length) errors.push("corpus case ids must be distinct");
  if (new Set(actualIds).size !== actualIds.length) errors.push("prediction case ids must be distinct");
  if (errors.length > 0) return fail(errors);

  const predictionByCase = new Map(predictions.cases.map((entry) => [entry.caseId, entry]));
  const cases: CalibrationCaseScore[] = corpus.cases.map((corpusCase): CalibrationCaseScore => {
    const predictionCase = predictionByCase.get(corpusCase.id)!;
    if (predictionCase.status === "not-executed") {
      return { caseId: corpusCase.id, state: corpusCase.state, execution: "not-executed", reason: predictionCase.reason };
    }
    const matching = matchCalibrationFindings(corpusCase.expectedCriticals, predictionCase.predictions);
    if (corpusCase.state === "vulnerable") {
      return {
        caseId: corpusCase.id,
        state: "vulnerable",
        execution: "executed",
        expectedCount: corpusCase.expectedCriticals.length,
        detectedCount: matching.matches.length,
        missedExpectations: matching.missedExpectations,
        novelPredictions: matching.novelPredictions,
        recall: ratio(matching.matches.length, corpusCase.expectedCriticals.length),
      };
    }
    const avoided = corpusCase.expectedCriticals.length - matching.matches.length;
    return {
      caseId: corpusCase.id,
      state: "fixed",
      execution: "executed",
      knownFindingCount: corpusCase.expectedCriticals.length,
      knownFalsePositiveCount: matching.matches.length,
      avoidedKnownFindingCount: avoided,
      knownFalsePositives: matching.matches,
      novelPredictions: matching.novelPredictions,
      avoidanceRate: ratio(avoided, corpusCase.expectedCriticals.length),
    };
  });

  const vulnerableCases = cases.filter((entry): entry is Extract<CalibrationCaseScore, { state: "vulnerable" }> => entry.state === "vulnerable");
  const fixedCases = cases.filter((entry): entry is Extract<CalibrationCaseScore, { state: "fixed" }> => entry.state === "fixed");
  const vulnerableExecuted = vulnerableCases.filter((entry): entry is Extract<typeof entry, { execution: "executed" }> => entry.execution === "executed");
  const fixedExecuted = fixedCases.filter((entry): entry is Extract<typeof entry, { execution: "executed" }> => entry.execution === "executed");
  const expectedCount = vulnerableExecuted.reduce((sum, entry) => sum + entry.expectedCount, 0);
  const detectedCount = vulnerableExecuted.reduce((sum, entry) => sum + entry.detectedCount, 0);
  const knownFindingCount = fixedExecuted.reduce((sum, entry) => sum + entry.knownFindingCount, 0);
  const knownFalsePositiveCount = fixedExecuted.reduce((sum, entry) => sum + entry.knownFalsePositiveCount, 0);
  const avoidedKnownFindingCount = knownFindingCount - knownFalsePositiveCount;
  const novelPredictionCount = cases.reduce((sum, entry) =>
    entry.execution === "executed" ? sum + entry.novelPredictions.length : sum, 0);

  return ok({
    profileId: predictions.profileId,
    execution: cases.every((entry) => entry.execution === "executed") ? "complete" : "incomplete",
    vulnerable: {
      caseCount: vulnerableCases.length,
      executedCaseCount: vulnerableExecuted.length,
      expectedCount,
      detectedCount,
      missedCount: expectedCount - detectedCount,
      recall: ratio(detectedCount, expectedCount),
    },
    fixed: {
      caseCount: fixedCases.length,
      executedCaseCount: fixedExecuted.length,
      knownFindingCount,
      knownFalsePositiveCount,
      avoidedKnownFindingCount,
      avoidanceRate: ratio(avoidedKnownFindingCount, knownFindingCount),
    },
    novelPredictionCount,
    cases,
  });
}

/** Canonical presentation; serializing a parsed score is a fixed point. */
export function serializeCalibrationScore(score: CalibrationScore): string {
  return `${JSON.stringify(score, null, 2)}\n`;
}

export const parseCorpus = parseCalibrationCorpus;
export const parsePredictions = parseCalibrationPredictions;
export const matchFindings = matchCalibrationFindings;
export const scoreModelCalibration = scoreCalibration;
