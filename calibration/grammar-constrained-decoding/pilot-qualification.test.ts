import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import { measureStructural, releaseEvidence, type StructuralMeasurement } from "./pilot-qualification";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, firstPair, sample } from "./pilot-test-fixtures";
import { guardrailOutcome, type GuardrailId } from "./pilot-vocabulary";

/**
 * What a cell's emission qualification fixes, at the module's own interface:
 * `measureStructural` (the structural series and the AS-004 verdict read from
 * the same provider-enforced count, both attributed from the samples alone)
 * and `releaseEvidence` (the release class).
 * How these reach the release decision is pinned through `evaluatePilot` in
 * `pilot.test.ts`.
 */

const CONSTRAINED = { kind: "constrained-emission", enforcedConstraints: ["type", "required"], evidence: "test" } as const;
const UNCONSTRAINED = { kind: "unconstrained-emission", evidence: "test" } as const;

/** Errored tool results by class, re-prompted in child before an accepted emission. */
type ToolErrorCounts = Readonly<{ schemaValidation: number; engineRefusal: number; unclassified: number }>;
const toolErrorCounts = fc.record({ schemaValidation: fc.nat({ max: 12 }), engineRefusal: fc.nat({ max: 12 }), unclassified: fc.nat({ max: 12 }) });

/** One emission-arm sample whose accepted attempt was re-prompted after each counted tool error. */
const repromptedSample = ({ schemaValidation, engineRefusal, unclassified }: ToolErrorCounts) => [
  sample(firstPair(), "emission-enabled", 10_000, [{
    ...ACCEPT_EMISSION,
    toolErrors: [
      ...Array.from({ length: schemaValidation }, () => ({ class: "harness-schema-validation" })),
      ...Array.from({ length: engineRefusal }, () => ({ class: "engine-refusal", code: "test-refusal" })),
      ...Array.from({ length: unclassified }, () => ({ class: "unclassified", excerpt: "test" })),
    ],
  }]),
];

/** A series without the two fields its qualification fixes. */
const sharedPart = ({ series }: StructuralMeasurement<"constrained-emission"> | StructuralMeasurement<"unconstrained-emission">) => {
  const { qualification: _qualification, providerEnforcedStructuralRetries: _providerEnforced, ...shared } = series;
  return shared;
};

describe("measureStructural", () => {
  it("attributes a constrained route's schema-validation retries to the provider, writes that count into its series and reads AS-004 from it (property)", () => {
    fc.assert(fc.property(toolErrorCounts, (errors) => {
      const { series, guardrail } = measureStructural(repromptedSample(errors), CONSTRAINED);
      expect(series.qualification).toBe("constrained-emission");
      expect(series.providerEnforcedStructuralRetries).toBe(errors.schemaValidation);
      expect(series.unenforcedSchemaViolationRetries).toBe(0);
      expect(guardrail.guardrail).toBe("provider-structural-retries");
      expect(guardrail.verdict).toBe(errors.schemaValidation === 0 ? "pass" : "violated");
    }), { numRuns: 100 });
  });

  it("gives an unconstrained route no provider-enforced count and AS-004 not-applicable, its schema-validation retries reported as unenforced (property)", () => {
    fc.assert(fc.property(toolErrorCounts, (errors) => {
      const { series, guardrail } = measureStructural(repromptedSample(errors), UNCONSTRAINED);
      expect([series.qualification, series.providerEnforcedStructuralRetries]).toEqual(["unconstrained-emission", "not-applicable"]);
      expect(series.unenforcedSchemaViolationRetries).toBe(errors.schemaValidation);
      expect(guardrail.verdict).toBe("not-applicable");
      expect(guardrail.detail).toContain(`${errors.schemaValidation} unenforced schema-violation retries and ${errors.engineRefusal} engine-only refusal retries`);
    }), { numRuns: 100 });
  });

  it("measures everything but the schema-validation attribution identically under either qualification (property)", () => {
    fc.assert(fc.property(toolErrorCounts, (errors) => {
      const samples = repromptedSample(errors);
      const { unenforcedSchemaViolationRetries: _constrainedUnenforced, ...constrained } = sharedPart(measureStructural(samples, CONSTRAINED));
      const { unenforcedSchemaViolationRetries: _unconstrainedUnenforced, ...unconstrained } = sharedPart(measureStructural(samples, UNCONSTRAINED));
      expect(unconstrained).toEqual(constrained);
      expect([constrained.engineOnlyRefusalRetries, constrained.unclassifiedToolErrorRetries]).toEqual([errors.engineRefusal, errors.unclassified]);
    }), { numRuns: 100 });
  });

  it("counts the emission arm's rejections, non-emission samples and emission calls from the samples themselves", () => {
    const pair = firstPair();
    const samples = [
      sample(pair, "emission-enabled", 10_000, [{ outcome: { kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } }, emissionCalls: 2 }, ACCEPT_EMISSION]),
      sample(pair, "emission-enabled", 10_000, [{ outcome: { kind: "rejected", cause: { kind: "extraction-failure", detail: "no JSON" } } }, ACCEPT_EXTRACTION]),
      sample(pair, "emission-enabled", 10_000, [ACCEPT_EMISSION]),
    ];
    const { series } = measureStructural(samples, CONSTRAINED);
    expect(series).toMatchObject({
      duplicateCallRejections: 1,
      extractionFailures: 1,
      observationRefusals: 0,
      nonEmissionSamples: 1,
      rawArgumentObservation: { emissionCallsWithUnavailableRawBytes: 4, duplicateKeyMeasurement: "not-claimed" },
    });
  });
});

describe("releaseEvidence", () => {
  const passingGuardrails = <V extends "pass" | "not-applicable">(as004: V) => {
    const pass = <G extends GuardrailId>(id: G) => guardrailOutcome(id, "pass", "test");
    return {
      "measurement-complete": pass("measurement-complete"),
      "latency-p95": pass("latency-p95"),
      "terminal-failure-non-increase": pass("terminal-failure-non-increase"),
      "provider-structural-retries": guardrailOutcome("provider-structural-retries", as004, "test"),
      "escaped-defect-severity": pass("escaped-defect-severity"),
    };
  };

  it("releases a passing cell in the class its qualification fixes, carrying its guardrails verbatim", () => {
    const constrainedGuardrails = passingGuardrails("pass");
    expect(releaseEvidence({ cell: "judge-verdict/v1", qualification: CONSTRAINED, guardrails: constrainedGuardrails }))
      .toEqual({ cell: "judge-verdict/v1", releaseClass: "constrained", guardrails: constrainedGuardrails });
    const unconstrainedGuardrails = passingGuardrails("not-applicable");
    expect(releaseEvidence({ cell: "judge-verdict/v1", qualification: UNCONSTRAINED, guardrails: unconstrainedGuardrails }))
      .toEqual({ cell: "judge-verdict/v1", releaseClass: "unconstrained-engine-authoritative", guardrails: unconstrainedGuardrails });
  });

  it("does not type-check a cell whose AS-004 verdict contradicts its qualification", () => {
    expectTypeOf(releaseEvidence({ cell: "judge-verdict/v1", qualification: CONSTRAINED, guardrails: passingGuardrails("pass") }).releaseClass)
      .toEqualTypeOf<"constrained">();
    // @ts-expect-error — an unconstrained route enforces nothing, so its AS-004 verdict is only not-applicable.
    const forgedUnconstrained = releaseEvidence({ cell: "judge-verdict/v1", qualification: UNCONSTRAINED, guardrails: passingGuardrails("pass") });
    // @ts-expect-error — a constrained route's AS-004 verdict is pass or violated, never not-applicable.
    const forgedConstrained = releaseEvidence({ cell: "judge-verdict/v1", qualification: CONSTRAINED, guardrails: passingGuardrails("not-applicable") });
    expect([forgedUnconstrained.releaseClass, forgedConstrained.releaseClass]).toEqual(["unconstrained-engine-authoritative", "constrained"]);
  });
});
