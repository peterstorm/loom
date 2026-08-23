import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  deriveProofObligations,
  parseProofObligationInput,
} from "../../src/core/proof-obligations";
import {
  LEGACY_TESTS_WAIVED_POLICY,
  REQUIRED_VERIFICATION_POLICY,
  parseTaskVerificationPolicy,
  parseVerificationPolicy,
  requiresNewTests,
  requiresRegression,
  serializeVerificationPolicy,
  taskVerificationPolicy,
  verificationPolicyFromLegacy,
  verificationPolicyMatchesLegacy,
  type VerificationPolicy,
} from "../../src/core/verification-policy";

const independentPolicy = (
  regressionRequired: boolean,
  newTestsRequired: boolean,
): VerificationPolicy => Object.freeze({
  regression: regressionRequired
    ? Object.freeze({ kind: "required" as const })
    : Object.freeze({ kind: "waived" as const, reason: "documentation-only" as const }),
  newTests: newTestsRequired
    ? Object.freeze({ kind: "required" as const })
    : Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" as const }),
});

describe("VerificationPolicy", () => {
  it("defaults legacy-absent Tasks to both requirements", () => {
    expect(verificationPolicyFromLegacy(undefined)).toEqual(REQUIRED_VERIFICATION_POLICY);
  });

  it("translates legacy false into an explicit total waiver", () => {
    expect(verificationPolicyFromLegacy(false)).toEqual(LEGACY_TESTS_WAIVED_POLICY);
  });

  it("parses independent regression and new-test requirements", () => {
    const parsed = parseVerificationPolicy({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        regression: { kind: "required" },
        newTests: { kind: "waived", reason: "existing-tests-sufficient" },
      },
    });
  });

  it("rejects unknown fields and waiver reasons", () => {
    const parsed = parseVerificationPolicy({
      regression: { kind: "waived", reason: "because-I-said-so", extra: true },
      new_tests: { kind: "required" },
      command: "npm test",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(expect.arrayContaining([
        "verification_policy.command is not allowed",
        "verification_policy.regression.extra is not allowed",
        "verification_policy.regression.reason must be one of documentation-only, generated-artifact, legacy-new-tests-required-false",
      ]));
    }
  });

  it("rejects explicit policy that conflicts with the legacy field", () => {
    const parsed = parseTaskVerificationPolicy({
      new_tests_required: false,
      verification_policy: {
        regression: { kind: "required" },
        new_tests: { kind: "required" },
      },
    }, "Task T1");
    expect(parsed).toEqual({
      ok: false,
      errors: ["Task T1.verification_policy conflicts with Task T1.new_tests_required"],
    });
  });

  it("rejects migration-only waiver provenance in authored policy", () => {
    const parsed = parseTaskVerificationPolicy({
      verification_policy: serializeVerificationPolicy(LEGACY_TESTS_WAIVED_POLICY),
    }, "Task T1", "authored");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(expect.arrayContaining([
        "Task T1.verification_policy.regression.reason must be one of documentation-only, generated-artifact",
        "Task T1.verification_policy.new_tests.reason must be one of existing-tests-sufficient, documentation-only, generated-artifact",
      ]));
    }
  });

  it("accepts equivalent explicit and legacy semantics", () => {
    const parsed = parseTaskVerificationPolicy({
      new_tests_required: false,
      verification_policy: serializeVerificationPolicy(LEGACY_TESTS_WAIVED_POLICY),
    });
    expect(parsed).toEqual({
      ok: true,
      value: { policy: LEGACY_TESTS_WAIVED_POLICY, source: "explicit" },
    });
  });

  it("rejects dual-source proof-obligation input", () => {
    const parsed = parseProofObligationInput({
      verificationPolicy: serializeVerificationPolicy(REQUIRED_VERIFICATION_POLICY),
      newTestsRequired: true,
      declaredArtifacts: [],
    });
    expect(parsed).toEqual({
      ok: false,
      errors: ["verificationPolicy and newTestsRequired are mutually exclusive"],
    });
  });

  it("derives proof obligations independently", () => {
    expect(deriveProofObligations({
      verificationPolicy: independentPolicy(true, false),
      declaredArtifacts: [],
    }).map(({ kind }) => kind)).toEqual(["task-completed", "regression-test-pass"]);

    expect(deriveProofObligations({
      verificationPolicy: independentPolicy(false, true),
      declaredArtifacts: [],
    }).map(({ kind }) => kind)).toEqual(["task-completed", "new-tests"]);
  });

  it("round-trips every independent required/waived combination", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (regression, newTests) => {
      const source = independentPolicy(regression, newTests);
      const parsed = parseVerificationPolicy(serializeVerificationPolicy(source));
      expect(parsed).toEqual({ ok: true, value: source });
    }));
  });

  it("legacy migration is total and deterministic", () => {
    fc.assert(fc.property(fc.option(fc.boolean(), { nil: undefined }), (legacy) => {
      const first = verificationPolicyFromLegacy(legacy);
      const second = verificationPolicyFromLegacy(legacy);
      expect(first).toEqual(second);
      expect(requiresRegression(first)).toBe(legacy !== false);
      expect(requiresNewTests(first)).toBe(legacy !== false);
    }));
  });

  it("explicit disagreement with legacy is always rejected", () => {
    fc.assert(fc.property(fc.boolean(), (legacy) => {
      const opposite = independentPolicy(!legacy, !legacy);
      const parsed = parseTaskVerificationPolicy({
        new_tests_required: legacy,
        verification_policy: serializeVerificationPolicy(opposite),
      });
      expect(parsed.ok).toBe(false);
    }));
  });

  it("trusted projection preserves parsed explicit policy", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (regression, newTests) => {
      const expected = independentPolicy(regression, newTests);
      expect(taskVerificationPolicy({
        verification_policy: serializeVerificationPolicy(expected),
      })).toEqual(expected);
    }));
  });

  it("serializes a deep immutable copy rather than retaining caller aliases", () => {
    const regression: { kind: "waived"; reason: "documentation-only" | "generated-artifact" } = {
      kind: "waived",
      reason: "documentation-only",
    };
    const newTests: { kind: "waived"; reason: "documentation-only" | "generated-artifact" } = {
      kind: "waived",
      reason: "documentation-only",
    };
    const stored = serializeVerificationPolicy({ regression, newTests });
    regression.reason = "generated-artifact";
    newTests.reason = "generated-artifact";
    expect(stored).toEqual({
      regression: { kind: "waived", reason: "documentation-only" },
      new_tests: { kind: "waived", reason: "documentation-only" },
    });
    expect(Object.isFrozen(stored.regression)).toBe(true);
    expect(Object.isFrozen(stored.new_tests)).toBe(true);
  });

  it("legacy equivalence compares required/waived semantics", () => {
    expect(verificationPolicyMatchesLegacy(independentPolicy(true, true), true)).toBe(true);
    expect(verificationPolicyMatchesLegacy(independentPolicy(false, false), false)).toBe(true);
    expect(verificationPolicyMatchesLegacy(independentPolicy(true, false), true)).toBe(false);
  });
});
