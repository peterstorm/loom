import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  TRUSTED_LEDGER_ONLY_POLICY,
  PI_STRUCTURED_EVIDENCE_POLICY,
  derivePendingTaskProof,
  deriveProofObligations,
  evaluateProofObligations,
  evaluateTaskProof,
  parseObservedProofEvidence,
  parseProofEvaluationPolicy,
  parseProofEvidence,
  parseProofFailure,
  parseProofObligation,
  parseProofObligationInput,
  parseProofObligationResult,
  parseTaskProof,
  parseTaskTestResult,
  reevaluateTaskProof,
  type ObservedProofEvidence,
  type ProofObligationInput,
} from "../../src/core/proof-obligations";

const input: ProofObligationInput = {
  newTestsRequired: true,
  declaredArtifacts: ["engine/src/core/proof-obligations.ts", "engine/tests/core/proof-obligations.test.ts"],
};

const completeEvidence: ObservedProofEvidence = {
  taskCompleted: true,
  testResult: { verdict: "trusted-pass" },
  filesModified: [...input.declaredArtifacts],
  newTestsWritten: true,
  newTestEvidence: "vitest: 12 tests passed",
};

describe("proof obligation derivation", () => {
  it("derives regression, required new tests, and one obligation per declared artifact", () => {
    expect(deriveProofObligations(input)).toEqual([
      { kind: "task-completed" },
      { kind: "regression-test-pass" },
      { kind: "new-tests" },
      { kind: "declared-artifact-changed", artifact: "engine/src/core/proof-obligations.ts" },
      { kind: "declared-artifact-changed", artifact: "engine/tests/core/proof-obligations.test.ts" },
    ]);
  });

  it("waives regression and new-test obligations when decomposition explicitly waives tests", () => {
    const obligations = deriveProofObligations({
      newTestsRequired: false,
      declaredArtifacts: ["docs/decision.md"],
    });
    expect(obligations).toEqual([
      { kind: "task-completed" },
      { kind: "declared-artifact-changed", artifact: "docs/decision.md" },
    ]);
  });

  it("normalizes duplicate artifact declarations without mutating the source", () => {
    const source = {
      newTestsRequired: true,
      declaredArtifacts: [" a.ts ", "a.ts", "b.ts"],
    };
    const before = structuredClone(source);
    const obligations = deriveProofObligations(source);

    expect(source).toEqual(before);
    expect(obligations.filter((item) => item.kind === "declared-artifact-changed")).toEqual([
      { kind: "declared-artifact-changed", artifact: "a.ts" },
      { kind: "declared-artifact-changed", artifact: "b.ts" },
    ]);
  });

  it("creates an immutable pending result for every obligation", () => {
    const proof = derivePendingTaskProof(input);
    expect(proof.state).toBe("pending");
    expect(proof.results).toHaveLength(proof.obligations.length);
    expect(proof.results.map((result) => result.obligation)).toEqual(proof.obligations);
    expect(proof.results.every((result) => result.state === "pending")).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.obligations)).toBe(true);
    expect(Object.isFrozen(proof.results)).toBe(true);
  });
});

describe("proof evaluation", () => {
  it("becomes implementation-ready only when every obligation is satisfied", () => {
    const proof = evaluateTaskProof(input, completeEvidence);

    expect(proof.state).toBe("satisfied");
    expect(proof.results).toHaveLength(proof.obligations.length);
    expect(proof.results.every((result) => result.state === "satisfied")).toBe(true);
  });

  it("a trusted failure is a typed regression failure", () => {
    const proof = evaluateTaskProof(input, {
      ...completeEvidence,
      testResult: { verdict: "trusted-fail" },
    });

    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({ kind: "regression-tests-failed", provenance: "ledger" });
    }
  });

  it("rejects an untrusted claimed pass by default as a typed failure", () => {
    const proof = evaluateTaskProof(input, {
      ...completeEvidence,
      testResult: { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)", provenance: "unverified" },
    });

    expect(TRUSTED_LEDGER_ONLY_POLICY.untrustedPass).toBe("reject");
    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({
        kind: "untrusted-regression-pass",
        label: "transcript-regex (fallback)",
      });
    }
  });

  it("can explicitly accept Pi structured evidence without laundering it into ledger provenance", () => {
    const proof = evaluateTaskProof(
      input,
      {
        ...completeEvidence,
        testResult: {
          verdict: "untrusted",
          passed: true,
          label: "pi-structured: tool-result",
          provenance: "pi-structured",
        },
      },
      PI_STRUCTURED_EVIDENCE_POLICY,
    );

    expect(proof.state).toBe("satisfied");
    if (proof.state === "satisfied") {
      expect(proof.evidence[1]).toEqual({
        kind: "regression-test-pass",
        provenance: "pi-structured",
        verdict: "untrusted-pass",
        label: "pi-structured: tool-result",
      });
      expect(proof.evidence[1]).not.toMatchObject({ provenance: "evidence-ledger" });
    }
  });

  it("does not let the Pi policy turn an untrusted failed run into a pass", () => {
    const proof = evaluateTaskProof(
      input,
      {
        ...completeEvidence,
        testResult: {
          verdict: "untrusted",
          passed: false,
          label: "pi-structured: tool-result",
          provenance: "pi-structured",
        },
      },
      PI_STRUCTURED_EVIDENCE_POLICY,
    );

    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({
        kind: "untrusted-regression-tests-failed",
        label: "pi-structured: tool-result",
      });
    }
  });

  // The trust upgrade reads `provenance`, never the label's spelling: a
  // transcript-regex verdict labelled to look structured must not be accepted.
  it("refuses a pi-structured LABEL that carries unverified provenance", () => {
    const proof = evaluateTaskProof(
      input,
      {
        ...completeEvidence,
        testResult: {
          verdict: "untrusted",
          passed: true,
          label: "pi-structured: forged by a producer that knows the string",
          provenance: "unverified",
        },
      },
      PI_STRUCTURED_EVIDENCE_POLICY,
    );

    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({
        kind: "untrusted-regression-pass",
        label: "pi-structured: forged by a producer that knows the string",
      });
    }
  });

  it("parses a stored result with no provenance as unverified, never as structured", () => {
    const parsed = parseTaskTestResult({
      verdict: "untrusted",
      passed: true,
      label: "pi-structured: legacy record written before the field existed",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "pi-structured: legacy record written before the field existed",
      provenance: "unverified",
    });
  });

  it("refuses a stored result whose provenance is unrecognized", () => {
    const parsed = parseTaskTestResult({
      verdict: "untrusted",
      passed: true,
      label: "some run",
      provenance: "evidence-ledger",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors.join(" ")).toContain("provenance");
  });

  it("evaluates every obligation exactly once even when several fail", () => {
    const obligations = deriveProofObligations(input);
    const proof = evaluateProofObligations(obligations, { taskCompleted: false, filesModified: [] });

    expect(proof.state).toBe("failed");
    expect(proof.results).toHaveLength(obligations.length);
    expect(proof.results.map((result) => result.obligation)).toEqual(obligations);
    expect(new Set(proof.results.map((result) => JSON.stringify(result.obligation))).size).toBe(obligations.length);
    if (proof.state === "failed") {
      expect(proof.failures).toEqual([
        { kind: "task-not-completed" },
        { kind: "test-result-missing" },
        { kind: "new-tests-not-observed" },
        { kind: "declared-artifact-not-changed", artifact: "engine/src/core/proof-obligations.ts" },
        { kind: "declared-artifact-not-changed", artifact: "engine/tests/core/proof-obligations.test.ts" },
      ]);
    }
  });

  it("requires every declared artifact, not merely one member of the declaration", () => {
    const proof = evaluateTaskProof(input, {
      ...completeEvidence,
      filesModified: [input.declaredArtifacts[0]!],
    });

    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({
        kind: "declared-artifact-not-changed",
        artifact: input.declaredArtifacts[1],
      });
    }
  });

  it("re-evaluation is a value-level fixed point and ignores the prior state arm", () => {
    const pending = derivePendingTaskProof(input);
    const once = reevaluateTaskProof(pending, completeEvidence);
    const twice = reevaluateTaskProof(once, completeEvidence);
    expect(twice).toEqual(once);
  });
});

describe("unknown-input parsers", () => {
  it("parses the small derivation and observation shapes into defensive immutable copies", () => {
    const rawInput = { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] };
    const rawEvidence = {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: ["src/a.ts"],
      newTestsWritten: true,
      newTestEvidence: "one test",
    };
    const parsedInput = parseProofObligationInput(rawInput);
    const parsedEvidence = parseObservedProofEvidence(rawEvidence);

    expect(parsedInput.ok).toBe(true);
    expect(parsedEvidence.ok).toBe(true);
    if (parsedInput.ok && parsedEvidence.ok) {
      rawInput.declaredArtifacts.push("later.ts");
      rawEvidence.filesModified.push("later.ts");
      expect(parsedInput.value.declaredArtifacts).toEqual(["src/a.ts"]);
      expect(parsedEvidence.value.filesModified).toEqual(["src/a.ts"]);
      expect(Object.isFrozen(parsedInput.value.declaredArtifacts)).toBe(true);
      expect(Object.isFrozen(parsedEvidence.value.filesModified)).toBe(true);
    }
  });

  it("round-trips every authored proof state and rejects result coverage drift", () => {
    const proofs = [
      derivePendingTaskProof(input),
      evaluateTaskProof(input, { taskCompleted: false, filesModified: [] }),
      evaluateTaskProof(input, completeEvidence),
    ];
    for (const proof of proofs) {
      const parsed = parseTaskProof(JSON.parse(JSON.stringify(proof)));
      expect(parsed.ok, proof.state).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(proof);
    }

    const satisfied = evaluateTaskProof(input, completeEvidence);
    const malformed = JSON.parse(JSON.stringify(satisfied));
    malformed.results.pop();
    const parsed = parseTaskProof(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toContain("proof must contain exactly one result per obligation");
  });

  it("rejects state/result disagreement and forged aggregate evidence", () => {
    const failed = evaluateTaskProof(input, { taskCompleted: false, filesModified: [] });
    const wrongState = { ...JSON.parse(JSON.stringify(failed)), state: "satisfied", evidence: [] };
    expect(parseTaskProof(wrongState).ok).toBe(false);

    const satisfied = evaluateTaskProof(input, completeEvidence);
    const forged = JSON.parse(JSON.stringify(satisfied));
    forged.evidence[1].provenance = "pi-structured";
    expect(parseTaskProof(forged).ok).toBe(false);
  });

  it("rejects same-length result binding drift and valid aggregate evidence drift", () => {
    const satisfied = evaluateTaskProof(input, completeEvidence);

    const wrongResultBinding = JSON.parse(JSON.stringify(satisfied));
    [wrongResultBinding.results[0], wrongResultBinding.results[1]] =
      [wrongResultBinding.results[1], wrongResultBinding.results[0]];
    const binding = parseTaskProof(wrongResultBinding);
    expect(binding.ok).toBe(false);
    if (!binding.ok) {
      expect(binding.errors).toContain("proof.results[0] must correspond to proof.obligations[0]");
    }

    const wrongAggregateEvidence = JSON.parse(JSON.stringify(satisfied));
    wrongAggregateEvidence.evidence.reverse();
    const aggregate = parseTaskProof(wrongAggregateEvidence);
    expect(aggregate.ok).toBe(false);
    if (!aggregate.ok) {
      expect(aggregate.errors).toContain("proof.evidence must equal the evidence derived from proof.results");
    }
  });

  it("accepts a valid explicit Verification Policy obligation input", () => {
    expect(parseProofObligationInput({
      verificationPolicy: {
        regression: { kind: "required" },
        new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
      },
      declaredArtifacts: [],
    })).toMatchObject({
      ok: true,
      value: {
        verificationPolicy: {
          regression: { kind: "required" },
          newTests: { kind: "waived", reason: "existing-tests-sufficient" },
        },
        declaredArtifacts: [],
      },
    });
  });

  it("parses only explicit policies", () => {
    expect(parseProofEvaluationPolicy({ untrustedPass: "reject" })).toEqual({
      ok: true,
      value: TRUSTED_LEDGER_ONLY_POLICY,
    });
    expect(parseProofEvaluationPolicy({ untrustedPass: "trust-everything" }).ok).toBe(false);
    expect(parseProofEvaluationPolicy(undefined).ok).toBe(false);
  });
});

describe("proof properties", () => {
  const artifact = fc.stringMatching(/^[a-z]{1,8}\.ts$/);

  it("PROPERTY: deterministic evaluation is idempotent and always has exact result coverage", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(artifact, { maxLength: 8 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (artifacts, newTestsRequired, testsPass, newTestsWritten) => {
          const source = { newTestsRequired, declaredArtifacts: artifacts };
          const evidence: ObservedProofEvidence = {
            taskCompleted: true,
            testResult: testsPass ? { verdict: "trusted-pass" } : { verdict: "trusted-fail" },
            filesModified: artifacts.filter((_, index) => index % 2 === 0),
            newTestsWritten,
          };
          const obligations = deriveProofObligations(source);
          const once = evaluateProofObligations(obligations, evidence);
          const twice = reevaluateTaskProof(once, evidence);
          return (
            JSON.stringify(once) === JSON.stringify(twice)
            && once.results.length === once.obligations.length
            && once.results.every((result, index) =>
              JSON.stringify(result.obligation) === JSON.stringify(once.obligations[index]))
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("PROPERTY: removing any required observation blocks implementation readiness", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(artifact, { minLength: 1, maxLength: 7 }),
        fc.integer({ min: 0, max: 8 }),
        (artifacts, removalIndex) => {
          const source = { newTestsRequired: true, declaredArtifacts: artifacts };
          const full: ObservedProofEvidence = {
            taskCompleted: true,
            testResult: { verdict: "trusted-pass" },
            filesModified: artifacts,
            newTestsWritten: true,
          };
          const variants: ObservedProofEvidence[] = [
            { ...full, testResult: undefined },
            { ...full, newTestsWritten: false },
            ...artifacts.map((removed) => ({
              ...full,
              filesModified: artifacts.filter((artifact) => artifact !== removed),
            })),
          ];
          const proof = evaluateTaskProof(source, variants[removalIndex % variants.length]!);
          return proof.state !== "satisfied";
        },
      ),
      { numRuns: 100 },
    );
  });

  it("PROPERTY: every proof/test ADT arm rejects surplus fields", () => {
    const pending = derivePendingTaskProof(input);
    const failed = evaluateTaskProof(input, { taskCompleted: false, filesModified: [] });
    const satisfied = evaluateTaskProof(input, completeEvidence);
    const cases: readonly Readonly<{
      parser: (raw: unknown) => Readonly<{ ok: boolean }>;
      value: Readonly<Record<string, unknown>>;
    }>[] = [
      ...[
        { kind: "task-completed" },
        { kind: "regression-test-pass" },
        { kind: "new-tests" },
        { kind: "declared-artifact-changed", artifact: "src/a.ts" },
      ].map((value) => ({ parser: parseProofObligation, value })),
      ...[
        { verdict: "trusted-pass" },
        { verdict: "trusted-fail" },
        { verdict: "untrusted", passed: true, label: "pi", provenance: "pi-structured" },
      ].map((value) => ({ parser: parseTaskTestResult, value })),
      ...[
        { kind: "task-not-completed" },
        { kind: "test-result-missing" },
        { kind: "regression-tests-failed", provenance: "ledger" },
        { kind: "untrusted-regression-tests-failed", label: "fallback" },
        { kind: "untrusted-regression-pass", label: "fallback" },
        { kind: "new-tests-not-observed" },
        { kind: "declared-artifact-not-changed", artifact: "src/a.ts" },
      ].map((value) => ({ parser: parseProofFailure, value })),
      ...[
        { kind: "task-completed" },
        { kind: "regression-test-pass", provenance: "evidence-ledger", verdict: "trusted-pass" },
        { kind: "regression-test-pass", provenance: "pi-structured", verdict: "untrusted-pass", label: "pi" },
        { kind: "new-tests", detail: null },
        { kind: "declared-artifact-changed", artifact: "src/a.ts" },
      ].map((value) => ({ parser: parseProofEvidence, value })),
      { parser: parseProofObligationResult, value: pending.results[0] },
      { parser: parseProofObligationResult, value: failed.results[0] },
      { parser: parseProofObligationResult, value: satisfied.results[0] },
      { parser: parseTaskProof, value: pending },
      { parser: parseTaskProof, value: failed },
      { parser: parseTaskProof, value: satisfied },
      { parser: parseProofObligationInput, value: { newTestsRequired: false, declaredArtifacts: [] } },
      {
        parser: parseProofObligationInput,
        value: {
          verificationPolicy: {
            regression: { kind: "required" },
            new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
          },
          declaredArtifacts: [],
        },
      },
      { parser: parseObservedProofEvidence, value: { taskCompleted: true, filesModified: [] } },
      { parser: parseProofEvaluationPolicy, value: { untrustedPass: "reject" } },
    ];

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: cases.length - 1 }),
        fc.stringMatching(/^surplus_[a-z]{1,8}$/),
        fc.jsonValue(),
        (caseIndex, key, surplusValue) => {
          const selected = cases[caseIndex]!;
          return !selected.parser({ ...selected.value, [key]: surplusValue }).ok;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("PROPERTY: parsers are total over unknown JSON values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => parseTaskProof(value)).not.toThrow();
        expect(() => parseProofObligationInput(value)).not.toThrow();
        expect(() => parseObservedProofEvidence(value)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
