import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import { RETRY_CAUSES, type RetryCause } from "./pilot-observation";
import { measureStructural, releaseEvidence, type RetryCauseCounts, type StructuralMeasurement } from "./pilot-qualification";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, firstPair, sample } from "./pilot-test-fixtures";
import { guardrailOutcome, type GuardrailId } from "./pilot-vocabulary";

/**
 * What a cell's emission qualification fixes, at the module's own interface:
 * `measureStructural` (the structural series and the AS-004 verdict read from
 * the same provider-enforced count) and `releaseEvidence` (the release class).
 * How these reach the release decision is pinned through `evaluatePilot` in
 * `pilot.test.ts`.
 */

const CONSTRAINED = { kind: "constrained-emission", enforcedConstraints: ["type", "required"], evidence: "test" } as const;
const UNCONSTRAINED = { kind: "unconstrained-emission", evidence: "test" } as const;

const NO_RETRIES: RetryCauseCounts = Object.fromEntries(RETRY_CAUSES.map((cause) => [cause, 0])) as Record<RetryCause, number>;
const retryCounts = fc.record(Object.fromEntries(RETRY_CAUSES.map((cause) => [cause, fc.nat({ max: 50 })])) as Record<RetryCause, fc.Arbitrary<number>>);

/** A series without the two fields its qualification fixes. */
const sharedPart = ({ series }: StructuralMeasurement<"constrained-emission"> | StructuralMeasurement<"unconstrained-emission">) => {
  const { qualification: _qualification, providerEnforcedStructuralRetries: _providerEnforced, ...shared } = series;
  return shared;
};

describe("measureStructural", () => {
  it("writes a constrained route's provider-enforced count into its series and reads AS-004 from that same count (property)", () => {
    fc.assert(fc.property(retryCounts, (causes) => {
      const { series, guardrail } = measureStructural([], causes, CONSTRAINED);
      expect(series.qualification).toBe("constrained-emission");
      expect(series.providerEnforcedStructuralRetries).toBe(causes["provider-structural"]);
      expect(guardrail.guardrail).toBe("provider-structural-retries");
      expect(guardrail.verdict).toBe(causes["provider-structural"] === 0 ? "pass" : "violated");
    }), { numRuns: 200 });
  });

  it("gives an unconstrained route no provider-enforced count and AS-004 not-applicable, whatever its retries (property)", () => {
    fc.assert(fc.property(retryCounts, (causes) => {
      const { series, guardrail } = measureStructural([], causes, UNCONSTRAINED);
      expect([series.qualification, series.providerEnforcedStructuralRetries]).toEqual(["unconstrained-emission", "not-applicable"]);
      expect(guardrail.verdict).toBe("not-applicable");
      expect(guardrail.detail).toContain(`${causes["unenforced-schema-violation"]} unenforced schema-violation retries`);
    }), { numRuns: 200 });
  });

  it("measures everything but the qualification-fixed fields identically under either qualification (property)", () => {
    fc.assert(fc.property(retryCounts, (causes) => {
      const constrained = sharedPart(measureStructural([], causes, CONSTRAINED));
      expect(sharedPart(measureStructural([], causes, UNCONSTRAINED))).toEqual(constrained);
      expect([constrained.unenforcedSchemaViolationRetries, constrained.engineOnlyRefusalRetries, constrained.unclassifiedToolErrorRetries])
        .toEqual([causes["unenforced-schema-violation"], causes["engine-only-refusal"], causes["unclassified-tool-error"]]);
    }), { numRuns: 100 });
  });

  it("counts the emission arm's rejections, non-emission samples and emission calls from the samples themselves", () => {
    const pair = firstPair();
    const samples = [
      sample(pair, "emission-enabled", 10_000, [{ outcome: { kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } }, emissionCalls: 2 }, ACCEPT_EMISSION]),
      sample(pair, "emission-enabled", 10_000, [{ outcome: { kind: "rejected", cause: { kind: "extraction-failure", detail: "no JSON" } } }, ACCEPT_EXTRACTION]),
      sample(pair, "emission-enabled", 10_000, [ACCEPT_EMISSION]),
    ];
    const { series } = measureStructural(samples, NO_RETRIES, CONSTRAINED);
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
