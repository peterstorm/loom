/**
 * Grammar-constrained decoding calibration pilot — what a cell's emission
 * qualification fixes (Plan AD-11; AS-004, AS-017). PURE.
 *
 * The one owner of the qualification/AS-004 correlation: a constrained route
 * counts its provider-enforced structural retries, and AS-004 passes or is
 * violated on that count; an unconstrained route enforces nothing, so it
 * carries no such count and AS-004 is not applicable; and the qualification
 * fixes the class a passing cell is released in. The release decision
 * (`pilot-core.ts`) reads all of it through two functions —
 * `measureStructural` (a cell's emission-arm retry tally, its structural
 * series and its AS-004 verdict) and `releaseEvidence` (a passing cell's
 * release class) — and through the per-qualification types they return, so it
 * never tells a qualification apart itself. Given a new qualification kind in
 * the preregistration (`EmissionRouteQualification`), the release decision
 * changes only here: its `QualificationTerms` entry and its
 * `QUALIFICATION_RULES` entry, each compile-checked to cover every emission
 * qualification exactly once.
 */

import { RETRY_CAUSES, sampleRetries, type RejectionCause, type RetryCause, type SampleObservation } from "./pilot-observation";
import type { EmissionRouteQualification, RouteQualification } from "./pilot-preregistration";
import { guardrailOutcome, type CellKey, type GuardrailId, type GuardrailOutcome, type GuardrailVerdict, type PassingVerdict } from "./pilot-vocabulary";

export type EmissionKind = EmissionRouteQualification["kind"];
/** The `K` arm of an emission route's qualification. */
export type QualificationOn<K extends EmissionKind> = Extract<EmissionRouteQualification, { kind: K }>;
/** A `K`-qualified emission qualification, its `kind` carried as `K` so the
 *  rules table can be indexed by it (the correlated-union form). */
export type Qualified<K extends EmissionKind> = QualificationOn<K> & Readonly<{ kind: K }>;

/**
 * What a cell's emission qualification fixes. Every per-qualification type
 * below reads its terms from here (`TermOn`), and `QUALIFICATION_RULES` is
 * its one implementation:
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
export type StructuralSeriesOn<K extends EmissionKind> = Readonly<{
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

/** A `K`-qualified cell's guardrail record whose verdicts lie in `V`: AS-004's
 *  is also one its qualification can yield. */
export type CellGuardrails<K extends EmissionKind, V extends GuardrailVerdict> = Readonly<{
  [G in GuardrailId]: GuardrailOutcome<G extends "provider-structural-retries" ? TermOn<"as004", K> & V : V, G>;
}>;

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

/** Retry counts by cause. */
export type RetryCauseCounts = Readonly<Record<RetryCause, number>>;

/** One arm's retries, attributed once: counted by the cause each is attributed to and by retry kind. */
export type RetryTally = Readonly<{ causes: RetryCauseCounts; semanticRetries: number; inChildReprompts: number }>;

/** The one retry attribution: an arm's retries under `qualification`, counted by cause and by kind. */
export function tallyRetries(samples: readonly SampleObservation[], qualification: RouteQualification): RetryTally {
  const retries = samples.flatMap((sample) => sampleRetries(sample, qualification));
  return Object.freeze({
    causes: Object.freeze(Object.fromEntries(RETRY_CAUSES.map((cause) =>
      [cause, retries.filter((retry) => retry.cause === cause).length])) as Record<RetryCause, number>),
    semanticRetries: retries.filter((retry) => retry.kind === "semantic-retry").length,
    inChildReprompts: retries.filter((retry) => retry.kind === "in-child-reprompt").length,
  });
}

/** A `K`-qualified cell's structural series together with the AS-004 verdict read from it. */
type StructuralVerdict<K extends EmissionKind> = Readonly<{
  series: StructuralSeriesOn<K>;
  guardrail: GuardrailOutcome<TermOn<"as004", K>, "provider-structural-retries">;
}>;

/** A `K`-qualified cell's structural series and AS-004 verdict, with the
 *  emission-arm retry tally both were read from. */
export type StructuralMeasurement<K extends EmissionKind> = StructuralVerdict<K> & Readonly<{ retries: RetryTally }>;

/** The part of a structural series every qualification measures the same way.
 *  The rules write it AFTER the two qualification-fixed fields: retained
 *  decisions are compared byte for byte, so the series' key order is evidence. */
type SharedSeries = Omit<StructuralSeriesOn<EmissionKind>, "qualification" | "providerEnforcedStructuralRetries">;

/** What one emission qualification makes of a cell. */
type QualificationRulesOn<K extends EmissionKind> = Readonly<{
  releaseClass: TermOn<"releaseClass", K>;
  /** The complete structural series — the shared part plus the
   *  provider-enforced retry count the route admits — and the AS-004 verdict
   *  read from that same count. */
  structural: (shared: SharedSeries, causes: RetryCauseCounts, qualification: QualificationOn<K>) => StructuralVerdict<K>;
}>;

/** `QualificationTerms`' one implementation: every per-qualification value
 *  the decision reads — and the only place a qualification is told apart. */
const QUALIFICATION_RULES = Object.freeze<Readonly<{ [K in EmissionKind]: QualificationRulesOn<K> }>>({
  "constrained-emission": {
    releaseClass: "constrained",
    structural: (shared, causes, constrained) => {
      const retries = causes["provider-structural"];
      return Object.freeze({
        series: Object.freeze({ qualification: constrained.kind, providerEnforcedStructuralRetries: retries, ...shared }),
        guardrail: retries === 0
          ? guardrailOutcome("provider-structural-retries", "pass", "zero retries attributed to provider-enforced constraint violations")
          : guardrailOutcome("provider-structural-retries", "violated", `${retries} retries attributed to violations of constraints the route was verified to enforce`),
      });
    },
  },
  "unconstrained-emission": {
    releaseClass: "unconstrained-engine-authoritative",
    structural: (shared, causes, unconstrained) => Object.freeze({
      series: Object.freeze({ qualification: unconstrained.kind, providerEnforcedStructuralRetries: "not-applicable" as const, ...shared }),
      guardrail: guardrailOutcome("provider-structural-retries", "not-applicable",
        `route qualified ${unconstrained.kind}: it was verified to enforce no JSON Schema constraint; ` +
        `${causes["unenforced-schema-violation"]} unenforced schema-violation retries and ${causes["engine-only-refusal"]} engine-only refusal retries reported separately`),
    }),
  },
});

function sharedSeries(samples: readonly SampleObservation[], causes: RetryCauseCounts): SharedSeries {
  const rejections = (kind: RejectionCause["kind"]): number => samples.reduce((sum, sample) =>
    sum + sample.attempts.filter((attempt) => attempt.outcome.kind === "rejected" && attempt.outcome.cause.kind === kind).length, 0);
  return Object.freeze({
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

/**
 * A `K`-qualified cell's structural series over its emission-arm samples, and
 * the AS-004 verdict read from it. The retries are attributed here, once per
 * cell, from the samples themselves under this qualification, and the tally is
 * returned with the series so the emission arm's summary reads the same
 * attribution: a series' counts cannot disagree with the samples they are read
 * from, nor with the arm summary. Generic over `K`
 * (called with the union, it returns the union of its arms): the
 * provider-enforced retry count is produced once, by `QUALIFICATION_RULES[K]`,
 * which writes it into the series and reads the verdict from it.
 */
export function measureStructural<K extends EmissionKind>(
  samples: readonly SampleObservation[],
  qualification: Qualified<K>,
): StructuralMeasurement<K> {
  const retries = tallyRetries(samples, qualification);
  const { causes } = retries;
  return Object.freeze({ ...QUALIFICATION_RULES[qualification.kind].structural(sharedSeries(samples, causes), causes, qualification), retries });
}

/**
 * A passing cell's release evidence. Total: the qualification fixes both the
 * release class (`QUALIFICATION_RULES`) and its AS-004 verdict (`constrained`
 * carries `pass`, `unconstrained-engine-authoritative` carries
 * `not-applicable`), so a passing cell whose verdict and class disagree
 * cannot reach here.
 */
export const releaseEvidence = <K extends EmissionKind>(
  passing: Readonly<{ cell: CellKey; qualification: Readonly<{ kind: K }>; guardrails: CellGuardrails<K, PassingVerdict> }>,
): { [Q in K]: PassedOn<Q> }[K] => Object.freeze({
  cell: passing.cell,
  releaseClass: QUALIFICATION_RULES[passing.qualification.kind].releaseClass,
  guardrails: passing.guardrails,
});
