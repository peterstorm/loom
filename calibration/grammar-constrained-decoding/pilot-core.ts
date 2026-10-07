/**
 * Grammar-constrained decoding calibration pilot — the release decision
 * (Plan AD-11; AS-004, AS-015, AS-016, AS-017). PURE.
 *
 * `evaluatePilot(PilotEvidence)` is the pilot's one decision entry point: it
 * folds a window's observations into per-route/schema cell measurements,
 * evaluates every guardrail and derives the release decision. Its inputs are
 * parsed by their own seams — the preregistration and schedule
 * (`pilot-preregistration.ts`), the observations and their per-sample
 * derivations (`pilot-observation.ts`), the preflight (`pilot-preflight.ts`)
 * and the blinded quality inputs (`pilot-quality.ts`) — over the shared
 * vocabulary (`pilot-vocabulary.ts`) and statistics (`pilot-statistics.ts`).
 * No clock, no filesystem, no network, no process: the runner
 * (`scripts/run-model-calibration.ts --pilot`) is the imperative shell that
 * gathers facts, dispatches, and persists what this module returns.
 *
 * Honesty invariants encoded in the types:
 *
 * - A release decision of `done-allowed` can only carry cells whose every
 *   guardrail verdict is `pass` (or `not-applicable` for a guardrail the
 *   preregistration declares inapplicable to that cell's qualification). A
 *   `violated`, `inconclusive` or `not-measured` guardrail is unrepresentable
 *   inside it.
 * - Per-route/schema cells are never aggregated away: every preregistered
 *   cell yields exactly one CellOutcome — measured, qualification-only
 *   (explicit extraction-only qualification, no fabricated samples) or
 *   not-measured (with the blocking reason and the partial observation count).
 * - Terminal failures and timeouts are retained as their own series and enter
 *   the latency distribution as unbounded (+∞) samples: successful samples
 *   alone can never make p95 look better than the operation was.
 * - Provider-enforced structural failures and engine-only refusals are
 *   separate series; on a route that enforces nothing, schema violations are
 *   reported as unenforced, never as provider guarantees.
 * - Raw generated argument bytes are not observable through Pi; the duplicate
 *   key measurement is reported as not claimed, never as zero.
 */

import { match } from "ts-pattern";
import { err, including, nonEmpty, ok, type NonEmpty, type Result } from "../kernel";
import {
  RETRY_CAUSES,
  sampleRetries,
  sampleTerminal,
  type ObservedPair,
  type RejectionCause,
  type RetryCause,
  type SampleObservation,
} from "./pilot-observation";
import type { PreflightBlock, PreflightDecision } from "./pilot-preflight";
import {
  buildPairSchedule,
  type CellPreregistration,
  type EmissionRouteQualification,
  type Preregistration,
  type RouteQualification,
  type ScheduledPair,
} from "./pilot-preregistration";
import { compareQuality, type QualityComparison, type QualityInputs } from "./pilot-quality";
import {
  bootstrapInterval,
  finiteOrNull,
  jsonInterval,
  mean,
  median,
  nearestRankQuantile,
  quantileRecord,
  type Interval,
  type JsonInterval,
  type LatencyQuantile,
} from "./pilot-statistics";
import {
  GUARDRAIL_IDS,
  GUARDRAIL_REQUIREMENT,
  guardrailOutcome,
  type CellKey,
  type GuardrailId,
  type GuardrailOutcome,
  type GuardrailRecord,
  type GuardrailVerdict,
  type PassingVerdict,
  type PilotArm,
} from "./pilot-vocabulary";

// ---------------------------------------------------------------------------
// Cell measurements and outcomes
// ---------------------------------------------------------------------------

export type ArmSummary = Readonly<{
  samples: number;
  accepted: number;
  terminalFailures: Readonly<Record<"semantic-exhausted" | "startup-refused" | "infrastructure" | "timeout", number>>;
  /** Over ALL samples, terminal failures ranked +∞. */
  p50: LatencyQuantile;
  p95: LatencyQuantile;
  /** Descriptive only: accepted samples (never the guardrail basis). */
  acceptedOnlyP50: LatencyQuantile;
  acceptedOnlyP95: LatencyQuantile;
  semanticRetries: number;
  inChildReprompts: number;
  retryCauses: Readonly<Record<RetryCause, number>>;
  modelRequestsPerSampleMean: number | null;
  followUpTurnsAfterAckTotal: number;
}>;

export type EmissionArmRates = Readonly<{
  /** Samples with ≥1 emission call in any attempt. */
  toolUseRate: number | null;
  /** Samples with zero emission calls in every attempt. */
  nonEmissionRate: number | null;
  /** Accepted via extraction (fallback) over all emission-arm samples. */
  fallbackRate: number | null;
  /** Of those, extraction selected over exactly one engine-refused call. */
  fallbackOverRefusalRate: number | null;
  duplicateCallRate: number | null;
  acceptedViaEmissionRate: number | null;
}>;

export type StructuralSeries = Readonly<{
  qualification: RouteQualification["kind"];
  /** Retries attributed to constraints the route was VERIFIED to enforce;
   *  not-applicable on a route that enforces nothing. */
  providerEnforcedStructuralRetries: number | "not-applicable";
  unenforcedSchemaViolationRetries: number;
  engineOnlyRefusalRetries: number;
  unclassifiedToolErrorRetries: number;
  extractionFailures: number;
  nonEmissionSamples: number;
  duplicateCallRejections: number;
  observationRefusals: number;
  rawArgumentObservation: Readonly<{
    emissionCallsWithUnavailableRawBytes: number;
    duplicateKeyMeasurement: "not-claimed";
  }>;
}>;

export type CellMeasurement = Readonly<{
  scheduledPairs: number;
  observedPairs: number;
  arms: Readonly<Record<PilotArm, ArmSummary>>;
  latency: Readonly<{
    p95Ratio: number | null;
    p95RatioInterval: JsonInterval;
    bound: number;
    /** Effect size: median paired difference (emission − extraction) over
     *  pairs where both arms reached accepted ingestion. */
    medianPairedDifferenceMs: number | null;
    medianPairedDifferenceInterval: JsonInterval;
    bothAcceptedPairs: number;
  }>;
  terminal: Readonly<{
    rate: Readonly<Record<PilotArm, number>>;
    difference: number;
    interval: JsonInterval;
  }>;
  emissionRates: EmissionArmRates;
  structural: StructuralSeries;
  byDifficulty: Readonly<Record<"easy" | "hard", Readonly<Record<PilotArm, Readonly<{ samples: number; accepted: number; p95: LatencyQuantile }>>>>>;
  quality: QualityComparison | null;
}>;

declare const derivedFromMeasurement: unique symbol;

/**
 * A measured cell: its guardrail verdicts together with the measurement they
 * were derived from. Only `measureCell` constructs one — it computes both
 * from the same observed pairs — so a record pairing verdicts with a
 * measurement they were not derived from cannot be written outside it.
 */
export type MeasuredCell = Readonly<{
  kind: "measured";
  cell: CellKey;
  qualification: EmissionRouteQualification;
  measurement: CellMeasurement;
  guardrails: GuardrailRecord;
}> & Readonly<{ [derivedFromMeasurement]: true }>;

export type CellOutcome =
  | MeasuredCell
  | Readonly<{
      kind: "qualification-only";
      cell: CellKey;
      qualification: Extract<RouteQualification, { kind: "extraction-only" }>;
      detail: string;
    }>
  | Readonly<{
      kind: "not-measured";
      cell: CellKey;
      qualification: EmissionRouteQualification;
      reason: string;
      scheduledPairs: number;
      observedPairs: number;
      partialObservations: number;
    }>;

// ---------------------------------------------------------------------------
// Release decision (AS-017): illegal "done" states are unrepresentable
// ---------------------------------------------------------------------------

export type PassedCellEvidence = Readonly<{
  cell: CellKey;
  guardrails: GuardrailRecord<PassingVerdict>;
}>;

export type GuardrailViolation = Readonly<{ cell: CellKey; guardrail: GuardrailId; requirement: string; detail: string }>;

export type MissingMeasurement =
  | Readonly<{ kind: "preflight-blocked"; blocks: NonEmpty<PreflightBlock> }>
  | Readonly<{ kind: "no-qualified-capable-route"; detail: string }>
  | Readonly<{ kind: "cell-not-measured"; cell: CellKey; reason: string }>
  | Readonly<{ kind: "guardrail-unresolved"; cell: CellKey; guardrail: GuardrailId; requirement: string; verdict: "inconclusive" | "not-measured"; detail: string }>;

export type ReleaseDecision =
  | Readonly<{
      kind: "done-allowed";
      measuredCells: NonEmpty<PassedCellEvidence>;
      qualificationOnlyCells: readonly CellKey[];
    }>
  | Readonly<{
      kind: "blocked-guardrail-violated";
      violations: NonEmpty<GuardrailViolation>;
      /** Missing measurements are retained alongside, never hidden by the block. */
      alsoMissing: readonly MissingMeasurement[];
      consequence: "design-reconsideration-required";
    }>
  | Readonly<{
      kind: "incomplete-missing-measurement";
      missing: NonEmpty<MissingMeasurement>;
    }>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type PilotEvidence = Readonly<{
  preregistration: Preregistration;
  preflight: PreflightDecision;
  observations: readonly SampleObservation[];
  quality: QualityInputs;
}>;

export type PilotEvaluation = Readonly<{
  cells: readonly CellOutcome[];
  decision: ReleaseDecision;
}>;

export type EvaluationError = Readonly<{ kind: "inconsistent-evidence"; problems: NonEmpty<string> }>;

const latencyOf = (sample: SampleObservation): number =>
  sampleTerminal(sample).kind === "accepted" ? sample.dispatchToIngestionMs : Number.POSITIVE_INFINITY;

const rate = (count: number, total: number): number | null => (total === 0 ? null : count / total);

type RetryTally = Readonly<{ causes: Readonly<Record<RetryCause, number>>; semanticRetries: number; inChildReprompts: number }>;

/** The one retry fold every summary reads (cause counts + retry kinds). */
function tallyRetries(samples: readonly SampleObservation[], qualification: RouteQualification): RetryTally {
  const retries = samples.flatMap((sample) => sampleRetries(sample, qualification));
  return Object.freeze({
    causes: Object.freeze(Object.fromEntries(RETRY_CAUSES.map((cause) =>
      [cause, retries.filter((retry) => retry.cause === cause).length])) as Record<RetryCause, number>),
    semanticRetries: retries.filter((retry) => retry.kind === "semantic-retry").length,
    inChildReprompts: retries.filter((retry) => retry.kind === "in-child-reprompt").length,
  });
}

function summarizeArm(samples: readonly SampleObservation[], qualification: RouteQualification): ArmSummary {
  const terminals = samples.map(sampleTerminal);
  const failures = { "semantic-exhausted": 0, "startup-refused": 0, infrastructure: 0, timeout: 0 };
  for (const terminal of terminals) if (terminal.kind === "terminal-failure") failures[terminal.cause] += 1;
  const { causes, semanticRetries, inChildReprompts } = tallyRetries(samples, qualification);
  const all = samples.map(latencyOf);
  const accepted = all.filter(Number.isFinite);
  return Object.freeze({
    samples: samples.length,
    accepted: accepted.length,
    terminalFailures: Object.freeze(failures),
    p50: quantileRecord(nearestRankQuantile(all, 0.5)),
    p95: quantileRecord(nearestRankQuantile(all, 0.95)),
    acceptedOnlyP50: quantileRecord(nearestRankQuantile(accepted, 0.5)),
    acceptedOnlyP95: quantileRecord(nearestRankQuantile(accepted, 0.95)),
    semanticRetries,
    inChildReprompts,
    retryCauses: causes,
    modelRequestsPerSampleMean: finiteOrNull(mean(samples.map((sample) =>
      sample.attempts.reduce((sum, attempt) => sum + attempt.modelRequests, 0)))),
    followUpTurnsAfterAckTotal: samples.reduce((sum, sample) =>
      sum + sample.attempts.reduce((inner, attempt) => inner + attempt.followUpTurnsAfterAck, 0), 0),
  });
}

function emissionRates(samples: readonly SampleObservation[]): EmissionArmRates {
  const total = samples.length;
  const terminals = samples.map(sampleTerminal);
  const anyCall = samples.filter((sample) => sample.attempts.some((attempt) => attempt.emissionCalls > 0)).length;
  const fallback = terminals.filter((terminal) => terminal.kind === "accepted" && terminal.source === "extraction");
  const duplicates = samples.filter((sample) => sample.attempts.some((attempt) =>
    attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === "duplicate-call")).length;
  return Object.freeze({
    toolUseRate: rate(anyCall, total),
    nonEmissionRate: rate(total - anyCall, total),
    fallbackRate: rate(fallback.length, total),
    fallbackOverRefusalRate: rate(fallback.filter((terminal) => terminal.kind === "accepted" && terminal.fallbackOverRefusal).length, total),
    duplicateCallRate: rate(duplicates, total),
    acceptedViaEmissionRate: rate(terminals.filter((terminal) => terminal.kind === "accepted" && terminal.source === "emission-tool").length, total),
  });
}

function structuralSeries(samples: readonly SampleObservation[], qualification: RouteQualification): StructuralSeries {
  const { causes } = tallyRetries(samples, qualification);
  const rejections = (kind: RejectionCause["kind"]): number => samples.reduce((sum, sample) =>
    sum + sample.attempts.filter((attempt) => attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === kind).length, 0);
  return Object.freeze({
    qualification: qualification.kind,
    providerEnforcedStructuralRetries: qualification.kind === "constrained-emission" ? causes["provider-structural"] : "not-applicable" as const,
    unenforcedSchemaViolationRetries: causes["unenforced-schema-violation"],
    engineOnlyRefusalRetries: causes["engine-only-refusal"],
    unclassifiedToolErrorRetries: causes["unclassified-tool-error"],
    extractionFailures: rejections("extraction-failure"),
    nonEmissionSamples: samples.filter((sample) => sample.attempts.every((attempt) => attempt.emissionCalls === 0)).length,
    duplicateCallRejections: rejections("duplicate-call"),
    observationRefusals: rejections("observation-refused"),
    rawArgumentObservation: Object.freeze({
      emissionCallsWithUnavailableRawBytes: samples.reduce((sum, sample) =>
        sum + sample.attempts.reduce((inner, attempt) => inner + attempt.emissionCalls, 0), 0),
      duplicateKeyMeasurement: "not-claimed" as const,
    }),
  });
}

function latencyGuardrail(pairs: readonly ObservedPair[], prereg: Preregistration): Readonly<{
  measurement: CellMeasurement["latency"];
  guardrail: GuardrailOutcome<GuardrailVerdict, "latency-p95">;
}> {
  const { p95RatioBound: bound, bootstrapResamples, bootstrapSeed, confidenceLevel } = prereg.guardrails;
  const ratioOf = (sample: readonly ObservedPair[]): number =>
    nearestRankQuantile(sample.map((pair) => latencyOf(pair.emission)), 0.95) /
    nearestRankQuantile(sample.map((pair) => latencyOf(pair.extraction)), 0.95);
  const ratio = ratioOf(pairs);
  const interval = bootstrapInterval(pairs, ratioOf, bootstrapResamples, bootstrapSeed, confidenceLevel);
  const both = pairs.filter((pair) => Number.isFinite(latencyOf(pair.emission)) && Number.isFinite(latencyOf(pair.extraction)));
  const differences = both.map((pair) => latencyOf(pair.emission) - latencyOf(pair.extraction));
  const differenceInterval = bootstrapInterval(differences, median, bootstrapResamples, bootstrapSeed + 1, confidenceLevel);
  const fixed3 = (value: number, nonFinite: string): string => (Number.isFinite(value) ? value.toFixed(3) : nonFinite);
  const describe = `p95 ratio ${fixed3(ratio, String(ratio))} (bootstrap ${(confidenceLevel * 100).toFixed(0)}% interval ` +
    `${fixed3(interval.lower, "∞")}–${fixed3(interval.upper, "∞")}) vs bound ${bound}`;
  return Object.freeze({
    measurement: Object.freeze({
      p95Ratio: finiteOrNull(ratio),
      p95RatioInterval: jsonInterval(interval),
      bound,
      medianPairedDifferenceMs: finiteOrNull(median(differences)),
      medianPairedDifferenceInterval: jsonInterval(differenceInterval),
      bothAcceptedPairs: both.length,
    }),
    guardrail: latencyVerdict(ratio, interval, bound, describe),
  });
}

function latencyVerdict(ratio: number, interval: Interval, bound: number, describe: string): GuardrailOutcome<GuardrailVerdict, "latency-p95"> {
  if (Number.isNaN(ratio)) {
    return guardrailOutcome("latency-p95", "inconclusive", `both arms' p95 is dominated by terminal failures or undefined; ${describe}`);
  }
  if (ratio > bound) return guardrailOutcome("latency-p95", "violated", describe);
  if (interval.upper <= bound) return guardrailOutcome("latency-p95", "pass", describe);
  return guardrailOutcome("latency-p95", "inconclusive", `${describe}: the interval crosses the bound — inconclusive is not a pass`);
}

function terminalGuardrail(pairs: readonly ObservedPair[], prereg: Preregistration): Readonly<{
  measurement: CellMeasurement["terminal"];
  guardrail: GuardrailOutcome<GuardrailVerdict, "terminal-failure-non-increase">;
}> {
  const failed = (sample: SampleObservation): number => (sampleTerminal(sample).kind === "terminal-failure" ? 1 : 0);
  const emissionFailures = pairs.reduce((sum, pair) => sum + failed(pair.emission), 0);
  const extractionFailures = pairs.reduce((sum, pair) => sum + failed(pair.extraction), 0);
  const total = pairs.length;
  const difference = (emissionFailures - extractionFailures) / total;
  const interval = bootstrapInterval(
    pairs.map((pair) => failed(pair.emission) - failed(pair.extraction)),
    mean,
    prereg.guardrails.bootstrapResamples,
    prereg.guardrails.bootstrapSeed + 2,
    prereg.guardrails.confidenceLevel,
  );
  const describe = `terminal failures emission ${emissionFailures}/${total} vs extraction-only ${extractionFailures}/${total}`;
  return Object.freeze({
    measurement: Object.freeze({
      rate: Object.freeze({ "emission-enabled": emissionFailures / total, "extraction-only": extractionFailures / total }),
      difference,
      interval: jsonInterval(interval),
    }),
    guardrail: emissionFailures > extractionFailures
      ? guardrailOutcome("terminal-failure-non-increase", "violated", `${describe}: the rate increased`)
      : guardrailOutcome("terminal-failure-non-increase", "pass", describe),
  });
}

function structuralGuardrail(series: StructuralSeries): GuardrailOutcome<GuardrailVerdict, "provider-structural-retries"> {
  if (series.providerEnforcedStructuralRetries === "not-applicable") {
    return guardrailOutcome("provider-structural-retries", "not-applicable",
      `route qualified ${series.qualification}: it was verified to enforce no JSON Schema constraint; ` +
      `${series.unenforcedSchemaViolationRetries} unenforced schema-violation retries and ${series.engineOnlyRefusalRetries} engine-only refusal retries reported separately`);
  }
  if (series.providerEnforcedStructuralRetries === 0) {
    return guardrailOutcome("provider-structural-retries", "pass", "zero retries attributed to provider-enforced constraint violations");
  }
  return guardrailOutcome("provider-structural-retries", "violated",
    `${series.providerEnforcedStructuralRetries} retries attributed to violations of constraints the route was verified to enforce`);
}

function byDifficulty(pairs: readonly ObservedPair[]): CellMeasurement["byDifficulty"] {
  const arm = (selected: readonly SampleObservation[]) => Object.freeze({
    samples: selected.length,
    accepted: selected.filter((sample) => sampleTerminal(sample).kind === "accepted").length,
    p95: quantileRecord(nearestRankQuantile(selected.map(latencyOf), 0.95)),
  });
  const of = (difficulty: "easy" | "hard") => {
    const chosen = pairs.filter((pair) => pair.scheduled.difficulty === difficulty);
    return Object.freeze({
      "emission-enabled": arm(chosen.map((pair) => pair.emission)),
      "extraction-only": arm(chosen.map((pair) => pair.extraction)),
    });
  };
  return Object.freeze({ easy: of("easy"), hard: of("hard") });
}

function evaluateCell(
  cell: CellPreregistration,
  schedule: readonly ScheduledPair[],
  observations: readonly SampleObservation[],
  evidence: PilotEvidence,
): Result<CellOutcome, readonly string[]> {
  const { qualification } = cell;
  if (qualification.kind === "extraction-only") {
    return ok(Object.freeze({
      kind: "qualification-only" as const,
      cell: cell.cell,
      qualification,
      detail: `explicit extraction-only qualification (${qualification.reason}); no emission arm exists, so no constrained samples are recorded`,
    }));
  }
  const scheduled = schedule.filter((pair) => pair.cell === cell.cell);
  const mine = observations.filter((sample) => sample.cell === cell.cell);
  const find = (pairId: string, arm: PilotArm) => mine.find((sample) => sample.pairId === pairId && sample.arm === arm);
  const pairs: ObservedPair[] = scheduled.flatMap((pair) => {
    const emission = find(pair.pairId, "emission-enabled");
    const extraction = find(pair.pairId, "extraction-only");
    return emission !== undefined && extraction !== undefined ? [{ scheduled: pair, emission, extraction }] : [];
  });
  const notMeasured = (reason: string): Result<CellOutcome, never> => ok(Object.freeze({
    kind: "not-measured" as const,
    cell: cell.cell,
    qualification,
    reason,
    scheduledPairs: scheduled.length,
    observedPairs: pairs.length,
    partialObservations: mine.length,
  }));
  if (evidence.preflight.kind === "blocked") {
    return notMeasured(`preflight blocked: ${evidence.preflight.blocks.map((block) => block.kind).join(", ")}`);
  }
  if (pairs.length < scheduled.length) {
    return notMeasured(`${pairs.length}/${scheduled.length} preregistered pairs observed in both arms`);
  }
  return measureCell(cell, qualification, scheduled.length, pairs, evidence);
}

/** The one constructor of a `MeasuredCell`: every measurement value and the
 *  guardrail verdict read from it come from the same complete set of pairs. */
function measureCell(
  cell: CellPreregistration,
  qualification: EmissionRouteQualification,
  scheduledPairs: number,
  pairs: readonly ObservedPair[],
  evidence: PilotEvidence,
): Result<MeasuredCell, readonly string[]> {
  const latency = latencyGuardrail(pairs, evidence.preregistration);
  const terminal = terminalGuardrail(pairs, evidence.preregistration);
  const emissionSamples = pairs.map((pair) => pair.emission);
  const structural = structuralSeries(emissionSamples, qualification);
  const quality = compareQuality(cell, pairs, evidence.preregistration, evidence.quality);
  if (!quality.ok) return quality;
  const measurement: CellMeasurement = Object.freeze({
    scheduledPairs,
    observedPairs: pairs.length,
    arms: Object.freeze({
      "emission-enabled": summarizeArm(emissionSamples, qualification),
      "extraction-only": summarizeArm(pairs.map((pair) => pair.extraction), qualification),
    }),
    latency: latency.measurement,
    terminal: terminal.measurement,
    emissionRates: emissionRates(emissionSamples),
    structural,
    byDifficulty: byDifficulty(pairs),
    quality: quality.value.comparison,
  });
  const guardrails: GuardrailRecord = Object.freeze({
    "measurement-complete": guardrailOutcome("measurement-complete", "pass", `${pairs.length}/${scheduledPairs} preregistered pairs observed in both arms`),
    "latency-p95": latency.guardrail,
    "terminal-failure-non-increase": terminal.guardrail,
    "provider-structural-retries": structuralGuardrail(structural),
    "escaped-defect-severity": quality.value.guardrail,
  });
  return ok(Object.freeze({ kind: "measured" as const, cell: cell.cell, qualification, measurement, guardrails }) as MeasuredCell);
}

function consistencyProblems(evidence: PilotEvidence, schedule: readonly ScheduledPair[]): readonly string[] {
  const scheduledIds = new Map(schedule.map((pair) => [pair.pairId, pair] as const));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const sample of evidence.observations) {
    const pair = scheduledIds.get(sample.pairId);
    const identity = `${sample.pairId}|${sample.arm}`;
    if (pair === undefined) problems.push(`observation ${identity} is not a preregistered pair`);
    else if (pair.cell !== sample.cell || pair.caseId !== sample.caseId) problems.push(`observation ${identity} contradicts its scheduled cell/case`);
    if (seen.has(identity)) problems.push(`observation ${identity} is recorded twice`);
    seen.add(identity);
  }
  if (evidence.preflight.kind === "blocked" && evidence.observations.length > 0) {
    problems.push("a blocked preflight dispatches nothing, yet samples are recorded");
  }
  return problems;
}

const isPassing = (guardrail: GuardrailOutcome): guardrail is GuardrailOutcome<PassingVerdict> =>
  guardrail.verdict === "pass" || guardrail.verdict === "not-applicable";

const allPassing = (guardrails: GuardrailRecord): guardrails is GuardrailRecord<PassingVerdict> =>
  GUARDRAIL_IDS.every((id) => isPassing(guardrails[id]));

/** What one cell contributes to the release decision, in cell order. */
type CellFindings = Readonly<{
  violations: readonly GuardrailViolation[];
  missing: readonly MissingMeasurement[];
  /** The cell's all-passing evidence, only when it is measured on a qualified capable route. */
  passedOnCapableRoute: readonly PassedCellEvidence[];
  qualificationOnly: readonly CellKey[];
}>;

const NO_FINDINGS: CellFindings = Object.freeze({ violations: [], missing: [], passedOnCapableRoute: [], qualificationOnly: [] });

function cellFindings(cell: CellOutcome): CellFindings {
  return match(cell)
    .with({ kind: "qualification-only" }, (only): CellFindings => ({ ...NO_FINDINGS, qualificationOnly: [only.cell] }))
    .with({ kind: "not-measured" }, (unmeasured): CellFindings => ({
      ...NO_FINDINGS,
      missing: [Object.freeze({ kind: "cell-not-measured" as const, cell: unmeasured.cell, reason: unmeasured.reason })],
    }))
    .with({ kind: "measured" }, measuredCellFindings)
    .exhaustive();
}

function measuredCellFindings(measured: MeasuredCell): CellFindings {
  const guardrails = GUARDRAIL_IDS.map((id) => measured.guardrails[id]);
  const violations = guardrails.flatMap((guardrail): readonly GuardrailViolation[] => guardrail.verdict === "violated"
    ? [Object.freeze({ cell: measured.cell, guardrail: guardrail.guardrail, requirement: GUARDRAIL_REQUIREMENT[guardrail.guardrail], detail: guardrail.detail })]
    : []);
  const missing = guardrails.flatMap((guardrail): readonly MissingMeasurement[] => match(guardrail.verdict)
    .with("inconclusive", "not-measured", (verdict) => [Object.freeze({
      kind: "guardrail-unresolved" as const, cell: measured.cell, guardrail: guardrail.guardrail,
      requirement: GUARDRAIL_REQUIREMENT[guardrail.guardrail], verdict, detail: guardrail.detail,
    })])
    .with("pass", "not-applicable", "violated", () => [])
    .exhaustive());
  const passedOnCapableRoute: readonly PassedCellEvidence[] =
    measured.qualification.kind === "constrained-emission" && allPassing(measured.guardrails)
      ? [Object.freeze({ cell: measured.cell, guardrails: measured.guardrails })]
      : [];
  return { violations, missing, passedOnCapableRoute, qualificationOnly: [] };
}

/** AD-11: without a qualified capable route the constrained feature cannot be declared done. */
const NO_CAPABLE_ROUTE: MissingMeasurement = Object.freeze({
  kind: "no-qualified-capable-route" as const,
  detail: "no preregistered cell is qualified constrained-emission on the intended deployment route; " +
    "AD-11: without a qualified capable route the constrained feature cannot be declared measured/done",
});

/** Capability is per cell: a measured (emission-arm) cell on an unconstrained
 *  route passes AS-004 only as not-applicable, so one capable cell must not
 *  carry the others to done. Extraction-only cells stay qualification-only. */
function unconstrainedCellsGap(prereg: Preregistration): readonly MissingMeasurement[] {
  const unconstrained = prereg.cells.filter((cell) => cell.qualification.kind === "unconstrained-emission").map((cell) => cell.cell);
  return unconstrained.length === 0 ? [] : [Object.freeze({
    kind: "no-qualified-capable-route" as const,
    detail: `cells ${unconstrained.join(", ")} are qualified unconstrained-emission on the intended deployment route; ` +
      "AD-11: every measured cell needs a qualified capable route before the constrained feature can be declared measured/done",
  })];
}

/**
 * The release decision. Precedence: any violated guardrail blocks done (and
 * demands design reconsideration — never more windows until one looks
 * favourable); otherwise any missing, not-measured or inconclusive
 * measurement leaves the claim incomplete; only a complete, all-passing
 * record with every measured cell on a qualified capable route allows done.
 *
 * Missing measurements are recorded in order: the preflight block, the
 * capable-route gap, then each cell's. The capable-route check is folded into
 * the done evidence: when nothing else is missing, the cells that passed on a
 * capable route ARE the done evidence, and their absence can only mean no
 * cell is on one — so that gap is recorded exactly then, with no branch that
 * restates it.
 */
function decideRelease(evidence: PilotEvidence, cells: readonly CellOutcome[]): ReleaseDecision {
  const perCell = cells.map(cellFindings);
  const prereg = evidence.preregistration;
  const blocked: readonly MissingMeasurement[] = evidence.preflight.kind === "blocked"
    ? [Object.freeze({ kind: "preflight-blocked" as const, blocks: evidence.preflight.blocks })]
    : [];
  const cellMissing = perCell.flatMap((findings) => findings.missing);
  const capable = prereg.cells.some((cell) => cell.qualification.kind === "constrained-emission");
  /** Every missing measurement except the absence of any capable route. */
  const unresolved = [...blocked, ...(capable ? unconstrainedCellsGap(prereg) : []), ...cellMissing];
  const withNoCapableRoute = (): NonEmpty<MissingMeasurement> => including(blocked, NO_CAPABLE_ROUTE, cellMissing);
  const violated = nonEmpty(perCell.flatMap((findings) => findings.violations));
  if (violated !== null) {
    return Object.freeze({
      kind: "blocked-guardrail-violated" as const,
      violations: violated,
      alsoMissing: capable ? Object.freeze(unresolved) : withNoCapableRoute(),
      consequence: "design-reconsideration-required" as const,
    });
  }
  const incomplete = nonEmpty(unresolved);
  if (incomplete !== null) {
    return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: capable ? incomplete : withNoCapableRoute() });
  }
  const measuredCells = nonEmpty(perCell.flatMap((findings) => findings.passedOnCapableRoute));
  if (measuredCells === null) {
    return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: Object.freeze([NO_CAPABLE_ROUTE] as const) });
  }
  return Object.freeze({
    kind: "done-allowed" as const,
    measuredCells,
    qualificationOnlyCells: Object.freeze(perCell.flatMap((findings) => findings.qualificationOnly)),
  });
}

/** Evaluate a whole window: one outcome per preregistered cell (never
 *  aggregated away) plus the release decision. Inconsistent evidence — samples
 *  for unscheduled pairs, duplicated samples, samples behind a blocked
 *  preflight, assessments naming unknown defects — is refused, not repaired. */
export function evaluatePilot(evidence: PilotEvidence): Result<PilotEvaluation, EvaluationError> {
  const schedule = buildPairSchedule(evidence.preregistration);
  const problems = [...consistencyProblems(evidence, schedule)];
  const cells: CellOutcome[] = [];
  for (const cell of evidence.preregistration.cells) {
    const evaluated = evaluateCell(cell, schedule, evidence.observations, evidence);
    if (evaluated.ok) cells.push(evaluated.value);
    else problems.push(...evaluated.error.map((problem) => `${cell.cell}: ${problem}`));
  }
  const refused = nonEmpty(problems);
  if (refused !== null) return err(Object.freeze({ kind: "inconsistent-evidence" as const, problems: refused }));
  return ok(Object.freeze({ cells: Object.freeze(cells), decision: decideRelease(evidence, cells) }));
}
