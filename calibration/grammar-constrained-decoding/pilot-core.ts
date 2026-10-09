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
 *   inside it. Each released cell states its release class, and the class
 *   fixes its AS-004 verdict: `constrained` carries provider-structural
 *   retries `pass`, `unconstrained-engine-authoritative` carries it
 *   `not-applicable`.
 * - Which classes may be released is the preregistration's release policy,
 *   fixed before any window: `capable-route-required` releases constrained
 *   cells only, and any unconstrained cell keeps the whole claim incomplete
 *   (`no-qualified-capable-route`); `per-route-engine-authoritative`
 *   releases both classes, each on its own complete, all-passing window.
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
import { err, nonEmpty, ok, type NonEmpty, type Result } from "../kernel";
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
  type ReleasePolicy,
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

type EmissionKind = EmissionRouteQualification["kind"];
/** The `K` arm of an emission route's qualification. */
type QualificationOn<K extends EmissionKind> = Extract<EmissionRouteQualification, { kind: K }>;

/**
 * What a cell's emission qualification fixes — the ONE owner of the
 * qualification/AS-004 correlation. Every per-qualification type below reads
 * its terms from here (`TermOn`), and `QUALIFICATION_RULES` is its one
 * implementation:
 *
 * - `providerEnforcedRetries`: a count on a constrained route; `not-applicable`
 *   on a route that enforces nothing.
 * - `as004`: the AS-004 verdicts the route can yield — on a constrained route
 *   the provider-enforced retries pass or violate it; an unconstrained route
 *   enforces nothing, so AS-004 is not applicable there.
 * - `releaseClass`: the class a passing cell is released in.
 */
type QualificationTerms = Readonly<{
  "constrained-emission": Readonly<{ providerEnforcedRetries: number; as004: "pass" | "violated"; releaseClass: "constrained" }>;
  "unconstrained-emission": Readonly<{
    providerEnforcedRetries: "not-applicable";
    as004: "not-applicable";
    releaseClass: "unconstrained-engine-authoritative";
  }>;
}>;

// Exactly one entry per emission qualification: a missing or extra one does not compile.
true satisfies [Exclude<EmissionKind, keyof QualificationTerms> | Exclude<keyof QualificationTerms, EmissionKind>] extends [never] ? true : never;

/** Term `T` of a `K`-qualified cell. Always read through this mapped access,
 *  never as `QualificationTerms[K][T]`: a value written for a generic `K` is
 *  then checked against EVERY qualification's term, not against their union,
 *  so a single generic constructor cannot write one qualification's term into
 *  another's cell. */
type TermOn<T extends keyof QualificationTerms[EmissionKind], K extends EmissionKind> = { [Q in EmissionKind]: QualificationTerms[Q][T] }[K];

/** The structural series of a cell on a `K`-qualified route. */
type StructuralSeriesOn<K extends EmissionKind> = Readonly<{
  qualification: K;
  /** Retries attributed to constraints the route was VERIFIED to enforce;
   *  not-applicable on a route that enforces nothing. */
  providerEnforcedStructuralRetries: TermOn<"providerEnforcedRetries", K>;
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

/** A cell's structural series. Its qualification fixes what its
 *  provider-enforced retry count can be, so a constrained series reading
 *  `not-applicable`, or an unconstrained one carrying a count, is unrepresentable. */
export type StructuralSeries = { [K in EmissionKind]: StructuralSeriesOn<K> }[EmissionKind];

/** A cell's measurement on a `K`-qualified route: its structural series is that route's. */
type CellMeasurementOn<K extends EmissionKind> = Readonly<{
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
  structural: StructuralSeriesOn<K>;
  byDifficulty: Readonly<Record<"easy" | "hard", Readonly<Record<PilotArm, Readonly<{ samples: number; accepted: number; p95: LatencyQuantile }>>>>>;
  quality: QualityComparison | null;
}>;

export type CellMeasurement = { [K in EmissionKind]: CellMeasurementOn<K> }[EmissionKind];

declare const derivedFromMeasurement: unique symbol;

/** A `K`-qualified cell's guardrail record whose verdicts lie in `V`: AS-004's
 *  is also one its qualification can yield. */
type CellGuardrails<K extends EmissionKind, V extends GuardrailVerdict> = Readonly<{
  [G in GuardrailId]: GuardrailOutcome<G extends "provider-structural-retries" ? TermOn<"as004", K> & V : V, G>;
}>;

/** A measured cell on a `K`-qualified route whose verdicts lie in `V`. */
type MeasuredOn<K extends EmissionKind, V extends GuardrailVerdict> = Readonly<{
  kind: "measured";
  cell: CellKey;
  qualification: QualificationOn<K>;
  measurement: CellMeasurementOn<K>;
  guardrails: CellGuardrails<K, V>;
}>;
/** `MeasuredOn` over the qualifications `K` (all of them by default), as their union. */
type MeasuredCellOf<V extends GuardrailVerdict, K extends EmissionKind = EmissionKind> = { [Q in K]: MeasuredOn<Q, V> }[K];
type Sealed<T> = T & Readonly<{ [derivedFromMeasurement]: true }>;

/**
 * A measured cell: its guardrail verdicts together with the measurement they
 * were derived from. Only `measureCell` constructs one — it computes both
 * from the same observed pairs — so a record pairing verdicts with a
 * measurement they were not derived from cannot be written outside it. The
 * qualification fixes the AS-004 verdicts it can carry, so a constrained
 * cell reading `not-applicable`, or an unconstrained one reading `pass`, is
 * unrepresentable.
 */
export type MeasuredCell = Sealed<MeasuredCellOf<GuardrailVerdict>>;
/** A measured cell whose every guardrail passes. */
type PassingCell = Sealed<MeasuredCellOf<PassingVerdict>>;

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

/** A `K`-qualified cell released: every verdict passing, AS-004's the one its class carries. */
type PassedOn<K extends EmissionKind> = Readonly<{ cell: CellKey; releaseClass: TermOn<"releaseClass", K>; guardrails: CellGuardrails<K, PassingVerdict> }>;

/**
 * How a cell is released. `constrained`: the route was verified to enforce the
 * schema, so AS-004 (zero provider-structural retries) passed.
 * `unconstrained-engine-authoritative`: the route enforces nothing, so AS-004
 * is not applicable and the engine's validation of every payload is the
 * authority; AS-015 and AS-016 passed all the same.
 */
export type PassedCellEvidence = { [K in EmissionKind]: PassedOn<K> }[EmissionKind];

export type GuardrailViolation = Readonly<{ cell: CellKey; guardrail: GuardrailId; requirement: string; detail: string }>;

export type MissingMeasurement =
  | Readonly<{ kind: "preflight-blocked"; blocks: NonEmpty<PreflightBlock> }>
  | Readonly<{ kind: "no-qualified-capable-route"; detail: string }>
  /** Per-route policy: no cell was measured on an emission route, so nothing can be released. */
  | Readonly<{ kind: "no-released-cell"; detail: string }>
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

/** A `K`-qualified emission qualification, its `kind` carried as `K` so the
 *  rules table can be indexed by it (the correlated-union form). */
type Qualified<K extends EmissionKind> = QualificationOn<K> & Readonly<{ kind: K }>;

/** What one emission qualification makes of a cell. */
type QualificationRulesOn<K extends EmissionKind> = Readonly<{
  releaseClass: TermOn<"releaseClass", K>;
  /** AS-004 read from the emission arm's retry causes: the provider-enforced
   *  retry count the route admits, and the verdict read from it. */
  structural: (causes: RetryTally["causes"], qualification: QualificationOn<K>) => Readonly<{
    providerEnforcedStructuralRetries: TermOn<"providerEnforcedRetries", K>;
    guardrail: GuardrailOutcome<TermOn<"as004", K>, "provider-structural-retries">;
  }>;
}>;

/** `QualificationTerms`' one implementation: every per-qualification value
 *  the decision reads — and the only place a qualification is told apart. */
const QUALIFICATION_RULES = Object.freeze<Readonly<{ [K in EmissionKind]: QualificationRulesOn<K> }>>({
  "constrained-emission": {
    releaseClass: "constrained",
    structural: (causes) => {
      const retries = causes["provider-structural"];
      return Object.freeze({
        providerEnforcedStructuralRetries: retries,
        guardrail: retries === 0
          ? guardrailOutcome("provider-structural-retries", "pass", "zero retries attributed to provider-enforced constraint violations")
          : guardrailOutcome("provider-structural-retries", "violated", `${retries} retries attributed to violations of constraints the route was verified to enforce`),
      });
    },
  },
  "unconstrained-emission": {
    releaseClass: "unconstrained-engine-authoritative",
    structural: (causes, unconstrained) => Object.freeze({
      providerEnforcedStructuralRetries: "not-applicable",
      guardrail: guardrailOutcome("provider-structural-retries", "not-applicable",
        `route qualified ${unconstrained.kind}: it was verified to enforce no JSON Schema constraint; ` +
        `${causes["unenforced-schema-violation"]} unenforced schema-violation retries and ${causes["engine-only-refusal"]} engine-only refusal retries reported separately`),
    }),
  },
});

/** The structural series on a `K`-qualified route, given the provider-enforced retry count `K` admits. */
function structuralSeries<K extends EmissionKind>(
  samples: readonly SampleObservation[],
  qualification: K,
  causes: RetryTally["causes"],
  providerEnforcedStructuralRetries: TermOn<"providerEnforcedRetries", K>,
): StructuralSeriesOn<K> {
  const rejections = (kind: RejectionCause["kind"]): number => samples.reduce((sum, sample) =>
    sum + sample.attempts.filter((attempt) => attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === kind).length, 0);
  return Object.freeze({
    qualification,
    providerEnforcedStructuralRetries,
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

/**
 * The one constructor of a `MeasuredCell`: every measurement value and the
 * guardrail verdict read from it come from the same complete set of pairs.
 * Generic over the qualification `K` (called with the union, it returns the
 * union of its arms): the AS-004 series and verdict come from
 * `QUALIFICATION_RULES[K]`, and a value of another qualification's terms does
 * not compile here (`TermOn`), so no per-qualification arm is needed.
 */
function measureCell<K extends EmissionKind>(
  cell: CellPreregistration,
  qualification: Qualified<K>,
  scheduledPairs: number,
  pairs: readonly ObservedPair[],
  evidence: PilotEvidence,
): Result<Sealed<MeasuredCellOf<GuardrailVerdict, K>>, readonly string[]> {
  const latency = latencyGuardrail(pairs, evidence.preregistration);
  const terminal = terminalGuardrail(pairs, evidence.preregistration);
  const emissionSamples = pairs.map((pair) => pair.emission);
  const { causes } = tallyRetries(emissionSamples, qualification);
  const structural = QUALIFICATION_RULES[qualification.kind].structural(causes, qualification);
  const quality = compareQuality(cell, pairs, evidence.preregistration, evidence.quality);
  if (!quality.ok) return quality;
  const measured: MeasuredOn<K, GuardrailVerdict> = Object.freeze({
    kind: "measured" as const,
    cell: cell.cell,
    qualification,
    measurement: Object.freeze({
      scheduledPairs,
      observedPairs: pairs.length,
      arms: Object.freeze({
        "emission-enabled": summarizeArm(emissionSamples, qualification),
        "extraction-only": summarizeArm(pairs.map((pair) => pair.extraction), qualification),
      }),
      latency: latency.measurement,
      terminal: terminal.measurement,
      emissionRates: emissionRates(emissionSamples),
      structural: structuralSeries(emissionSamples, qualification.kind, causes, structural.providerEnforcedStructuralRetries),
      byDifficulty: byDifficulty(pairs),
      quality: quality.value.comparison,
    }),
    guardrails: Object.freeze({
      "measurement-complete": guardrailOutcome("measurement-complete", "pass", `${pairs.length}/${scheduledPairs} preregistered pairs observed in both arms`),
      "latency-p95": latency.guardrail,
      "terminal-failure-non-increase": terminal.guardrail,
      "provider-structural-retries": structural.guardrail,
      "escaped-defect-severity": quality.value.guardrail,
    }),
  });
  // The brand's one construction site: it seals only the value built above from this call's own
  // measurement — no helper can seal anything else.
  return ok(measured as Sealed<MeasuredCellOf<GuardrailVerdict, K>>);
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

const isPassing = (guardrail: GuardrailOutcome): boolean => guardrail.verdict === "pass" || guardrail.verdict === "not-applicable";

const allPassing = (measured: MeasuredCell): measured is PassingCell => GUARDRAIL_IDS.every((id) => isPassing(measured.guardrails[id]));

/**
 * A passing cell's release evidence. Total: the qualification fixes both the
 * release class (`QUALIFICATION_RULES`) and its AS-004 verdict (`constrained`
 * carries `pass`, `unconstrained-engine-authoritative` carries
 * `not-applicable`), so a passing cell whose verdict and class disagree
 * cannot reach here.
 */
const releaseEvidence = <K extends EmissionKind>(
  passing: MeasuredOn<K, PassingVerdict> & Readonly<{ qualification: Readonly<{ kind: K }> }>,
): { [Q in K]: PassedOn<Q> }[K] => Object.freeze({
  cell: passing.cell,
  releaseClass: QUALIFICATION_RULES[passing.qualification.kind].releaseClass,
  guardrails: passing.guardrails,
});

/** What the preregistered release policy makes of a window's cells. */
type PolicyRelease = Readonly<{
  /** The policy's own gaps, recorded before any cell's. */
  routeGaps: readonly MissingMeasurement[];
  /** The passing cells the policy releases, in cell order; or, when it
   *  releases none, the gap a record that is otherwise complete carries. */
  release: Result<NonEmpty<PassedCellEvidence>, MissingMeasurement>;
}>;

/** AD-11: without a qualified capable route the constrained feature cannot be declared done. */
const NO_CAPABLE_ROUTE: MissingMeasurement = Object.freeze({
  kind: "no-qualified-capable-route" as const,
  detail: "no preregistered cell is qualified constrained-emission on the intended deployment route; " +
    "AD-11: without a qualified capable route the constrained feature cannot be declared measured/done",
});

/** Per-route policy: a release needs at least one cell measured on an emission route. */
const NO_RELEASED_CELL: MissingMeasurement = Object.freeze({
  kind: "no-released-cell" as const,
  detail: "no preregistered cell is measured on an emission route (every cell is extraction-only); " +
    "a per-route release needs at least one complete, all-passing emission cell",
});

/**
 * The release policy's one interpreter. `capable-route-required` releases
 * constrained cells only, and records the absent capable route — or, beside
 * a capable one, the cells left unconstrained (capability is per cell, so one
 * capable cell must not carry the others to done) — as gaps of its own.
 * `per-route-engine-authoritative` releases every passing emission cell in its
 * class and records no route gap: each cell stands on its own window.
 */
function releaseUnderPolicy(policy: ReleasePolicy, cells: readonly CellOutcome[]): PolicyRelease {
  const passed = cells.flatMap((cell) => (cell.kind === "measured" && allPassing(cell) ? [releaseEvidence(cell)] : []));
  return match(policy)
    .returnType<PolicyRelease>()
    .with({ kind: "capable-route-required" }, () => ({
      routeGaps: capableRouteGaps(cells),
      release: releasedOr(passed.filter((evidence) => evidence.releaseClass === "constrained"), NO_CAPABLE_ROUTE),
    }))
    .with({ kind: "per-route-engine-authoritative" }, () => ({ routeGaps: [], release: releasedOr(passed, NO_RELEASED_CELL) }))
    .exhaustive();
}

/** The cells a policy releases, or — when it releases none — its gap. */
function releasedOr(released: readonly PassedCellEvidence[], gap: MissingMeasurement): PolicyRelease["release"] {
  const nonEmptyRelease = nonEmpty(released);
  return nonEmptyRelease === null ? err(gap) : ok(nonEmptyRelease);
}

/** `capable-route-required`'s own gaps: the absent capable route, or the cells left unconstrained beside one. */
function capableRouteGaps(cells: readonly CellOutcome[]): readonly MissingMeasurement[] {
  const qualified = (kind: RouteQualification["kind"]): readonly CellKey[] =>
    cells.filter((cell) => cell.qualification.kind === kind).map((cell) => cell.cell);
  const constrained = qualified("constrained-emission");
  const unconstrained = qualified("unconstrained-emission");
  if (constrained.length === 0) return [NO_CAPABLE_ROUTE];
  if (unconstrained.length === 0) return [];
  return [Object.freeze({
    kind: "no-qualified-capable-route" as const,
    detail: `cells ${unconstrained.join(", ")} are qualified unconstrained-emission on the intended deployment route; ` +
      "AD-11: every measured cell needs a qualified capable route before the constrained feature can be declared measured/done",
  })];
}

/** What one cell contributes to the release decision, in cell order — the
 *  same under every release policy. */
type CellFindings = Readonly<{
  violations: readonly GuardrailViolation[];
  missing: readonly MissingMeasurement[];
  qualificationOnly: readonly CellKey[];
}>;

const NO_FINDINGS: CellFindings = Object.freeze({ violations: [], missing: [], qualificationOnly: [] });

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

/** A measured cell's violated and unresolved guardrails; a cell with neither is passing, and released by the policy. */
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
  return { violations, missing, qualificationOnly: [] };
}

/**
 * The release decision. Precedence: any violated guardrail blocks done (and
 * demands design reconsideration — never more windows until one looks
 * favourable); otherwise any missing, not-measured or inconclusive
 * measurement leaves the claim incomplete; only a complete, all-passing
 * record the preregistered policy releases allows done.
 *
 * Missing measurements form one list, in order: the preflight block, the
 * policy's route gaps, then each cell's. When that list is empty and no
 * guardrail is violated, every emission cell is measured and passing, so the
 * policy releases them all unless no cell was dispatched at all — the gap
 * the policy names for an empty release.
 */
function decideRelease(evidence: PilotEvidence, cells: readonly CellOutcome[]): ReleaseDecision {
  const perCell = cells.map(cellFindings);
  const policy = releaseUnderPolicy(evidence.preregistration.releasePolicy, cells);
  const blocked: readonly MissingMeasurement[] = evidence.preflight.kind === "blocked"
    ? [Object.freeze({ kind: "preflight-blocked" as const, blocks: evidence.preflight.blocks })]
    : [];
  const missing = Object.freeze([...blocked, ...policy.routeGaps, ...perCell.flatMap((findings) => findings.missing)]);
  const violated = nonEmpty(perCell.flatMap((findings) => findings.violations));
  if (violated !== null) {
    return Object.freeze({
      kind: "blocked-guardrail-violated" as const,
      violations: violated,
      alsoMissing: missing,
      consequence: "design-reconsideration-required" as const,
    });
  }
  const incomplete = nonEmpty(missing);
  if (incomplete !== null) return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: incomplete });
  if (!policy.release.ok) {
    return Object.freeze({ kind: "incomplete-missing-measurement" as const, missing: Object.freeze([policy.release.error] as const) });
  }
  return Object.freeze({
    kind: "done-allowed" as const,
    measuredCells: policy.release.value,
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
