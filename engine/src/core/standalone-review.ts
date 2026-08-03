import { attributeFindings, findingsUnionError, parseStoredFindings, type Finding, type RefutedFinding } from "./findings";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { resolveReviewFindings } from "./review-output";

export const STANDALONE_REVIEW_SCHEMA_VERSION = 1;
export const STANDALONE_REVIEW_SUBJECT = "standalone-review";

export interface StandaloneReviewTranscript {
  readonly agent: string;
  readonly output: string;
}

export interface StandaloneReviewAggregate {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly subjectId: typeof STANDALONE_REVIEW_SUBJECT;
  readonly scope: readonly string[];
  readonly findings: readonly Finding[];
}

export type StandaloneReviewState =
  | Readonly<{ kind: "clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{
      kind: "requires-refutation";
      aggregate: StandaloneReviewAggregate;
      criticals: readonly [Finding, ...Finding[]];
    }>;

export interface SerializedPanelOutcome {
  readonly findingId: string;
  readonly claim: string;
  readonly survives: boolean;
  readonly refutedBy: readonly string[];
  readonly reasoning: readonly string[];
  readonly upheldBy: readonly string[];
  readonly uncertainFrom: readonly string[];
}

export interface ParsedPanelOutcomes {
  readonly lenses: readonly string[];
  readonly threshold: number;
  readonly outcomes: readonly SerializedPanelOutcome[];
}

export interface AdjudicatedStandaloneReview {
  readonly runId: string;
  readonly scope: readonly string[];
  readonly survivingCriticals: readonly Finding[];
  readonly advisories: readonly Finding[];
  readonly refutedCriticals: readonly RefutedFinding[];
  readonly panel: ParsedPanelOutcomes | null;
}

const nonEmptyStrings = (raw: unknown): raw is string[] =>
  Array.isArray(raw) && raw.length > 0 && raw.every((entry) => typeof entry === "string" && entry.trim() !== "");

function repoRelativePathError(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return `review scope path must be repo-relative: ${path}`;
  if (normalized.split("/").includes("..")) return `review scope path must not escape the repository: ${path}`;
  if (/[\r\n\0]/.test(path)) return `review scope path must be a single line without NUL: ${JSON.stringify(path)}`;
  return null;
}

function uniqueNonEmpty(values: readonly string[], label: string): readonly string[] {
  const errors: string[] = [];
  if (values.length === 0) errors.push(`${label} must be non-empty`);
  if (values.some((value) => value.trim() === "")) errors.push(`${label} must not contain empty values`);
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  return errors;
}

/** Pure transcript boundary: parse, reconcile, attribute, and preserve every finding. */
export function aggregateStandaloneReview(input: {
  readonly runId: string;
  readonly scope: readonly string[];
  readonly transcripts: readonly StandaloneReviewTranscript[];
}): ParseResult<StandaloneReviewState> {
  const runId = input.runId.trim();
  const scope = input.scope.map((path) => path.trim());
  const transcripts = input.transcripts.map((transcript) => ({
    agent: transcript.agent.trim(),
    output: transcript.output,
  }));
  const errors = [
    ...(runId === "" ? ["run id must be non-empty"] : []),
    ...uniqueNonEmpty(scope, "review scope"),
    ...scope.flatMap((path) => {
      const error = repoRelativePathError(path);
      return error === null ? [] : [error];
    }),
    ...uniqueNonEmpty(transcripts.map(({ agent }) => agent), "review agents"),
  ];
  if (transcripts.length === 0) errors.push("review transcripts must be non-empty");
  if (errors.length > 0) return fail(errors);

  const findings: Finding[] = [];
  for (const transcript of transcripts) {
    const resolution = resolveReviewFindings(transcript.output, transcript.agent);
    if (resolution.kind === "evidence-failed") {
      errors.push(`${transcript.agent}: ${resolution.message}`);
      continue;
    }
    findings.push(...attributeFindings(resolution.findings.drafts, transcript.agent));
  }
  if (errors.length > 0) return fail(errors);

  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    return fail(["attributed standalone finding ids must be distinct across review agents"]);
  }

  const aggregate: StandaloneReviewAggregate = Object.freeze({
    schemaVersion: STANDALONE_REVIEW_SCHEMA_VERSION,
    runId,
    subjectId: STANDALONE_REVIEW_SUBJECT,
    scope: Object.freeze(scope),
    findings: Object.freeze(findings),
  });
  const criticals = findings.filter((finding) => finding.severity === "critical");
  const [head, ...tail] = criticals;
  return head === undefined
    ? ok({ kind: "clean", aggregate })
    : ok({ kind: "requires-refutation", aggregate, criticals: [head, ...tail] });
}

export function serializeStandaloneAggregate(aggregate: StandaloneReviewAggregate): string {
  return JSON.stringify({
    schema_version: aggregate.schemaVersion,
    run_id: aggregate.runId,
    subject_id: aggregate.subjectId,
    scope: aggregate.scope,
    findings: aggregate.findings,
  }, null, 2);
}

export function parseStandaloneAggregate(raw: unknown): ParseResult<StandaloneReviewAggregate> {
  if (!isRecord(raw)) return fail(["standalone review aggregate must be an object"]);
  const errors: string[] = [];
  if (raw.schema_version !== STANDALONE_REVIEW_SCHEMA_VERSION) errors.push("aggregate.schema_version must be 1");
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  if (runId === "") errors.push("aggregate.run_id must be non-empty");
  if (raw.subject_id !== STANDALONE_REVIEW_SUBJECT) errors.push(`aggregate.subject_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
  const scope = nonEmptyStrings(raw.scope) ? raw.scope.map((path) => path.trim()) : [];
  if (scope.length === 0) errors.push("aggregate.scope must be a non-empty string array");
  if (new Set(scope).size !== scope.length) errors.push("aggregate.scope must be distinct");
  for (const path of scope) {
    const error = repoRelativePathError(path);
    if (error !== null) errors.push(error);
  }
  if (!Array.isArray(raw.findings)) errors.push("aggregate.findings must be an array");
  const findingError = findingsUnionError(raw.findings, "aggregate.findings");
  if (findingError !== null) errors.push(findingError);
  const findings = parseStoredFindings(raw.findings);
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) errors.push("aggregate finding ids must be distinct");
  return errors.length > 0
    ? fail(errors)
    : ok({ schemaVersion: 1, runId, subjectId: STANDALONE_REVIEW_SUBJECT, scope, findings });
}

function parseStringArray(raw: unknown, path: string, errors: string[]): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${path} must be an array containing only non-empty strings`);
    return [];
  }
  return raw.map((entry) => (entry as string).trim());
}

/** Parse the review-panel's serialized tally and prove exact critical coverage. */
export function parseStandalonePanelOutcomes(
  raw: unknown,
  criticals: readonly Finding[],
  expectedLenses: readonly string[],
): ParseResult<ParsedPanelOutcomes> {
  if (!isRecord(raw)) return fail(["standalone panel outcomes must be an object"]);
  const errors: string[] = [];
  const lenses = parseStringArray(raw.lenses, "outcomes.lenses", errors);
  if (new Set(lenses).size !== lenses.length) errors.push("outcomes.lenses must be distinct");
  if (lenses.length !== expectedLenses.length
    || lenses.some((lens, index) => lens !== expectedLenses[index])) {
    errors.push("outcomes.lenses must exactly match the validated manifest lenses in order");
  }
  const threshold = Number.isInteger(raw.threshold) ? raw.threshold as number : 0;
  const majority = Math.floor(lenses.length / 2) + 1;
  if (threshold < majority || threshold > lenses.length) {
    errors.push("outcomes.threshold must be at least a strict majority and no greater than the lens count");
  }
  if (!Array.isArray(raw.outcomes)) return fail([...errors, "outcomes.outcomes must be an array"]);

  const expected = new Map<string, Finding>(
    criticals.map((finding) => [`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`, finding]),
  );
  const outcomes: SerializedPanelOutcome[] = [];
  for (const [index, entry] of raw.outcomes.entries()) {
    const path = `outcomes.outcomes[${index}]`;
    if (!isRecord(entry)) { errors.push(`${path} must be an object`); continue; }
    const findingId = typeof entry.finding_id === "string" ? entry.finding_id.trim() : "";
    const finding = expected.get(findingId);
    if (entry.task_id !== STANDALONE_REVIEW_SUBJECT) {
      errors.push(`${path}.task_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
    }
    if (!finding) errors.push(`${path}.finding_id is not an expected critical: ${findingId || "<empty>"}`);
    const claim = typeof entry.claim === "string" ? entry.claim.trim() : "";
    if (finding && claim !== finding.claim) errors.push(`${path}.claim does not match aggregate finding ${findingId}`);
    if (typeof entry.survives !== "boolean") errors.push(`${path}.survives must be boolean`);
    const refutedBy = parseStringArray(entry.refuted_by, `${path}.refuted_by`, errors);
    const reasoning = parseStringArray(entry.reasoning, `${path}.reasoning`, errors);
    const upheldBy = parseStringArray(entry.upheld_by, `${path}.upheld_by`, errors);
    const uncertainFrom = parseStringArray(entry.uncertain_from, `${path}.uncertain_from`, errors);
    if (refutedBy.length !== reasoning.length) errors.push(`${path} refuted_by/reasoning lengths must match`);
    const votes = [...refutedBy, ...upheldBy, ...uncertainFrom];
    if (new Set(votes).size !== votes.length) errors.push(`${path} lens votes must be distinct across all verdict kinds`);
    if (votes.length !== lenses.length || votes.some((lens) => !lenses.includes(lens))) {
      errors.push(`${path} must account for every panel lens exactly once`);
    }
    if (entry.survives === false && refutedBy.length < threshold) errors.push(`${path} refuted finding must meet threshold`);
    if (entry.survives === true && refutedBy.length >= threshold) errors.push(`${path} surviving finding must be below threshold`);
    outcomes.push({ findingId, claim, survives: entry.survives === true, refutedBy, reasoning, upheldBy, uncertainFrom });
  }
  const ids = outcomes.map(({ findingId }) => findingId);
  if (new Set(ids).size !== ids.length) errors.push("panel outcome finding ids must be distinct");
  for (const id of expected.keys()) if (!ids.includes(id)) errors.push(`panel outcomes are missing critical finding: ${id}`);
  if (outcomes.length !== expected.size) errors.push(`panel outcomes must contain exactly ${expected.size} critical findings`);
  const surviving = outcomes.filter((outcome) => outcome.survives).length;
  const refuted = outcomes.length - surviving;
  if (raw.surviving !== surviving) errors.push(`outcomes.surviving must equal derived count ${surviving}`);
  if (raw.refuted !== refuted) errors.push(`outcomes.refuted must equal derived count ${refuted}`);
  return errors.length > 0 ? fail(errors) : ok({ lenses, threshold, outcomes });
}

/** Pure finalization: a critical can only be surviving or audibly refuted. */
export function finalizeStandaloneReview(
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): ParseResult<AdjudicatedStandaloneReview> {
  const criticals = aggregate.findings.filter((finding) => finding.severity === "critical");
  const advisories = aggregate.findings.filter((finding) => finding.severity === "advisory");
  if (criticals.length === 0) {
    return panel === null
      ? ok({ runId: aggregate.runId, scope: aggregate.scope, survivingCriticals: [], advisories, refutedCriticals: [], panel: null })
      : fail(["a clean standalone review must not carry panel outcomes"]);
  }
  if (panel === null) return fail(["standalone review has unadjudicated critical findings"]);

  const byId = new Map(panel.outcomes.map((outcome) => [outcome.findingId, outcome] as const));
  const survivingCriticals: Finding[] = [];
  const refutedCriticals: RefutedFinding[] = [];
  for (const finding of criticals) {
    const outcome = byId.get(`${STANDALONE_REVIEW_SUBJECT}:${finding.id}`);
    if (!outcome) return fail([`missing adjudication for critical finding ${finding.id}`]);
    if (outcome.survives) {
      survivingCriticals.push(finding);
      continue;
    }
    const pairs = outcome.refutedBy.map((lens, index) => ({ lens, reason: outcome.reasoning[index]! }));
    const [head, ...tail] = pairs;
    if (!head) return fail([`refuted finding ${finding.id} has no refutation evidence`]);
    refutedCriticals.push({ finding, refutations: [head, ...tail] });
  }
  return ok({ runId: aggregate.runId, scope: aggregate.scope, survivingCriticals, advisories, refutedCriticals, panel });
}

export function serializeAdjudicatedStandaloneReview(result: AdjudicatedStandaloneReview): string {
  return JSON.stringify({
    run_id: result.runId,
    scope: result.scope,
    surviving_critical_findings: result.survivingCriticals,
    advisory_findings: result.advisories,
    refuted_critical_findings: result.refutedCriticals,
    panel: result.panel === null ? null : {
      lenses: result.panel.lenses,
      threshold: result.panel.threshold,
      outcomes: result.panel.outcomes.map((outcome) => ({
        finding_id: outcome.findingId,
        claim: outcome.claim,
        survives: outcome.survives,
        refuted_by: outcome.refutedBy,
        reasoning: outcome.reasoning,
        upheld_by: outcome.upheldBy,
        uncertain_from: outcome.uncertainFrom,
      })),
    },
  }, null, 2);
}
