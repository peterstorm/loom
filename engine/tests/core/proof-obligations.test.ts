import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { canonicalStructuralEquals } from "../../src/core/orchestration-contract";
import {
  CONTRACT_VIOLATED_FAILURE_KIND_PREFIX,
  TRUSTED_LEDGER_ONLY_POLICY,
  PI_STRUCTURED_EVIDENCE_POLICY,
  contractViolatedFailureKind,
  parseContractViolatedFailureKind,
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
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import type { ConformanceViolation, ContractConformance } from "../../src/core/skeleton/types";

const UNIMPLEMENTED: ConformanceViolation = { subject: "priceOrder", reason: "still-unimplemented", remedy: null };

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
  contractConformance: CONFORMANCE_NOT_OWED,
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
    const proof = evaluateProofObligations(obligations, { taskCompleted: false, filesModified: [], contractConformance: CONFORMANCE_NOT_OWED });

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
      contractConformance: { kind: "not-owed" },
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
      evaluateTaskProof(input, { taskCompleted: false, filesModified: [], contractConformance: CONFORMANCE_NOT_OWED }),
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
    const failed = evaluateTaskProof(input, { taskCompleted: false, filesModified: [], contractConformance: CONFORMANCE_NOT_OWED });
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

  it("accepts key-order-permuted but structurally-equal aggregate evidence (kernel equality, not textual)", () => {
    // pr-test-analyzer-3 pin, widening arm: the sfh-2 swap replaced the
    // key-order-sensitive JSON.stringify comparison with the kernel's
    // canonical structural equality, whose record arm matches keys by
    // identity, not position. A persisted proof whose stored evidence spells
    // the same record in a different key order is therefore ACCEPTED where the
    // old textual comparison refused; a revert to textual equality turns this
    // test red.
    const satisfied = evaluateTaskProof(input, completeEvidence);
    const original = JSON.parse(JSON.stringify(satisfied));
    const permuted = JSON.parse(JSON.stringify(satisfied));
    const reordered = Object.fromEntries(Object.entries(permuted.evidence[1]).reverse());
    permuted.evidence[1] = reordered;
    // The permutation is real: the textual spellings differ.
    expect(JSON.stringify(permuted.evidence[1])).not.toBe(JSON.stringify(original.evidence[1]));
    expect(parseTaskProof(permuted).ok).toBe(true);
  });

  it("reads an own undefined-valued key as distinct from an absent key (kernel equality, not textual)", () => {
    // pr-test-analyzer-3 pin, narrowing arm: JSON.stringify DROPPED
    // undefined-valued own keys, so the old textual comparison silently agreed
    // with a record carrying one; the kernel reads it as a distinct key and
    // refuses. Pinned at the kernel seam — through parseTaskProof the
    // element-parse exact-record arm refuses the same shape first (both
    // layers fail closed), so the kernel pin is the discriminating one.
    expect(canonicalStructuralEquals({ kind: "task-completed", extra: undefined }, { kind: "task-completed" })).toBe(false);
    // The same record without the key is equal (the absent key is not a
    // distinct fact), and key order never decides.
    expect(canonicalStructuralEquals({ extra: undefined, kind: "task-completed" }, { kind: "task-completed", extra: undefined })).toBe(true);
    expect(canonicalStructuralEquals(
      { verdict: "trusted-pass", provenance: "evidence-ledger", kind: "regression-test-pass" },
      { kind: "regression-test-pass", provenance: "evidence-ledger", verdict: "trusted-pass" },
    )).toBe(true);
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
            contractConformance: CONFORMANCE_NOT_OWED,
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
            contractConformance: CONFORMANCE_NOT_OWED,
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
    const failed = evaluateTaskProof(input, { taskCompleted: false, filesModified: [], contractConformance: CONFORMANCE_NOT_OWED });
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
        { kind: "declared-artifact-contract-violated", artifact: "src/a.ts", violations: [UNIMPLEMENTED] },
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
      { parser: parseObservedProofEvidence, value: { taskCompleted: true, filesModified: [], contractConformance: CONFORMANCE_NOT_OWED } },
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

describe("declared-artifact contract conformance (AD-5, FR-021)", () => {
  const ARTIFACT = "src/order/pricing.ts";
  const OTHER = "src/order/quotes.ts";
  const contractInput: ProofObligationInput = { newTestsRequired: false, declaredArtifacts: [ARTIFACT, OTHER] };
  const RENAMED: ConformanceViolation = { subject: "parseOrder", reason: "renamed", remedy: null };
  const RELISTED: ConformanceViolation = {
    subject: "OrderState",
    reason: "re-lists-frozen-variants",
    remedy: "LocalState re-lists the variants of the frozen union OrderState",
  };
  const judged = (entries: readonly (readonly [string, readonly [ConformanceViolation, ...ConformanceViolation[]]])[]): ContractConformance =>
    ({ kind: "judged", violations: new Map(entries) });
  const observed = (filesModified: readonly string[], contractConformance: ContractConformance): ObservedProofEvidence => ({
    taskCompleted: true,
    filesModified,
    contractConformance,
  });
  const resultFor = (proof: ReturnType<typeof evaluateTaskProof>, artifact: string) =>
    proof.results.find(({ obligation }) => obligation.kind === "declared-artifact-changed" && obligation.artifact === artifact);

  it("AS-015: an untouched engine skeleton is refused as still unimplemented, never as not-changed", () => {
    const proof = evaluateTaskProof(contractInput, observed([OTHER], judged([[ARTIFACT, [UNIMPLEMENTED]]])));

    expect(proof.state).toBe("failed");
    expect(resultFor(proof, ARTIFACT)).toEqual({
      state: "failed",
      obligation: { kind: "declared-artifact-changed", artifact: ARTIFACT },
      failure: { kind: "declared-artifact-contract-violated", artifact: ARTIFACT, violations: [UNIMPLEMENTED] },
    });
    expect(proof.state === "failed" ? proof.failures : []).toEqual([
      { kind: "declared-artifact-contract-violated", artifact: ARTIFACT, violations: [UNIMPLEMENTED] },
    ]);
  });

  it("FR-021: violations are reported ahead of the changed test, every one of them, in judge order", () => {
    const proof = evaluateTaskProof(contractInput, observed([ARTIFACT, OTHER], judged([[ARTIFACT, [UNIMPLEMENTED, RENAMED, RELISTED]]])));

    expect(resultFor(proof, ARTIFACT)?.state).toBe("failed");
    expect(proof.state === "failed" ? proof.failures : []).toEqual([
      { kind: "declared-artifact-contract-violated", artifact: ARTIFACT, violations: [UNIMPLEMENTED, RENAMED, RELISTED] },
    ]);
    // The sibling artifact, changed and conforming, is satisfied as changed.
    expect(resultFor(proof, OTHER)).toEqual({
      state: "satisfied",
      obligation: { kind: "declared-artifact-changed", artifact: OTHER },
      evidence: { kind: "declared-artifact-changed", artifact: OTHER },
    });
  });

  it("FR-012: a judged artifact with no violation is satisfied only when it changed", () => {
    const conforming = judged([]);
    expect(evaluateTaskProof(contractInput, observed([ARTIFACT, OTHER], conforming)).state).toBe("satisfied");
    const unchanged = evaluateTaskProof(contractInput, observed([OTHER], conforming));
    expect(unchanged.state === "failed" ? unchanged.failures : []).toEqual([
      { kind: "declared-artifact-not-changed", artifact: ARTIFACT },
    ]);
  });

  it("a not-owed observation leaves the changed test alone", () => {
    expect(evaluateTaskProof(contractInput, observed([ARTIFACT, OTHER], CONFORMANCE_NOT_OWED)).state).toBe("satisfied");
    const unchanged = evaluateTaskProof(contractInput, observed([], CONFORMANCE_NOT_OWED));
    expect(unchanged.state === "failed" ? unchanged.failures.map(({ kind }) => kind) : []).toEqual([
      "declared-artifact-not-changed",
      "declared-artifact-not-changed",
    ]);
  });

  it("violations of a path that is no declared artifact refuse nothing", () => {
    const proof = evaluateTaskProof(contractInput, observed([ARTIFACT, OTHER], judged([["src/elsewhere.ts", [UNIMPLEMENTED]]])));
    expect(proof.state).toBe("satisfied");
  });

  it("AS-037: the declared-artifact-attested verify-only arm is never judged", () => {
    const attested = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: [ARTIFACT], declaredArtifactExpectation: "attested" },
      observed([], judged([[ARTIFACT, [UNIMPLEMENTED]]])),
    );
    expect(attested.state).toBe("satisfied");
    expect(attested.results.map(({ state }) => state)).toEqual(["satisfied", "satisfied", "satisfied"]);
  });

  it("FR-021: a contract-violated failure round-trips through the failure, result and proof parsers", () => {
    const proof = evaluateTaskProof(contractInput, observed([OTHER], judged([[ARTIFACT, [UNIMPLEMENTED, RELISTED]]])));
    const json = JSON.parse(JSON.stringify(proof)) as unknown;
    const parsed = parseTaskProof(json);
    expect(parsed).toEqual({ ok: true, value: proof });
    const failure = { kind: "declared-artifact-contract-violated", artifact: ARTIFACT, violations: [UNIMPLEMENTED, RELISTED] };
    expect(parseProofFailure(failure)).toEqual({ ok: true, value: failure });
  });

  it("refuses a contract-violated failure with no violation, an unknown reason, a malformed violation or a blank artifact", () => {
    const base = { kind: "declared-artifact-contract-violated", artifact: ARTIFACT };
    for (const raw of [
      { ...base, violations: [] },
      { ...base, violations: "priceOrder" },
      { ...base, violations: [{ subject: "priceOrder", reason: "forgotten", remedy: null }] },
      { ...base, violations: [{ subject: "", reason: "deleted", remedy: null }] },
      { ...base, violations: [{ subject: "priceOrder", reason: "deleted", remedy: 3 }] },
      { ...base, violations: [{ subject: "priceOrder", reason: "deleted" }] },
      { ...base, violations: [{ subject: "priceOrder", reason: "deleted", remedy: null, extra: true }] },
      { ...base, violations: [null] },
      { kind: base.kind, artifact: " ", violations: [UNIMPLEMENTED] },
      { kind: base.kind, violations: [UNIMPLEMENTED] },
    ]) {
      expect(parseProofFailure(raw).ok, JSON.stringify(raw)).toBe(false);
    }
    for (const reason of ["deleted", "renamed", "retyped", "still-unimplemented", "shadows-frozen-adt", "re-lists-frozen-variants"]) {
      expect(parseProofFailure({ ...base, violations: [{ subject: "x", reason, remedy: null }] }).ok, reason).toBe(true);
    }
  });

  it("refuses a contract-violated result bound to another artifact or to the attested arm", () => {
    const failure = { kind: "declared-artifact-contract-violated", artifact: ARTIFACT, violations: [UNIMPLEMENTED] };
    expect(parseProofObligationResult({
      state: "failed", obligation: { kind: "declared-artifact-changed", artifact: ARTIFACT }, failure,
    }).ok).toBe(true);
    expect(parseProofObligationResult({
      state: "failed", obligation: { kind: "declared-artifact-changed", artifact: OTHER }, failure,
    }).ok).toBe(false);
    expect(parseProofObligationResult({
      state: "failed", obligation: { kind: "declared-artifact-attested", artifact: ARTIFACT }, failure,
    }).ok).toBe(false);
    expect(parseProofObligationResult({
      state: "failed", obligation: { kind: "task-completed" }, failure,
    }).ok).toBe(false);
  });

  it("refuses an observation that has not decided contractConformance (AD-5: required, never judges nothing)", () => {
    expect(parseObservedProofEvidence({ taskCompleted: true, filesModified: [ARTIFACT] })).toEqual({
      ok: false,
      errors: ["contractConformance must be decided as not-owed or judged"],
    });
    expect(parseObservedProofEvidence({ taskCompleted: true, filesModified: [ARTIFACT], contractConformance: undefined }).ok).toBe(false);
  });

  it("parses both contractConformance arms into a defensive copy", () => {
    const raw = { taskCompleted: true, filesModified: [ARTIFACT] };
    expect(parseObservedProofEvidence({ ...raw, contractConformance: { kind: "not-owed" } })).toEqual({
      ok: true,
      value: { taskCompleted: true, filesModified: [ARTIFACT], contractConformance: { kind: "not-owed" } },
    });
    const source = new Map<string, unknown>([[ARTIFACT, [UNIMPLEMENTED, RENAMED]]]);
    const parsed = parseObservedProofEvidence({ ...raw, contractConformance: { kind: "judged", violations: source } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    source.set(OTHER, [RELISTED]);
    expect(parsed.value.contractConformance).toEqual({ kind: "judged", violations: new Map([[ARTIFACT, [UNIMPLEMENTED, RENAMED]]]) });
  });

  it("refuses a malformed contractConformance observation", () => {
    const raw = { taskCompleted: true, filesModified: [] };
    for (const contractConformance of [
      null,
      "not-owed",
      { kind: "owed" },
      { kind: "not-owed", violations: new Map() },
      { kind: "judged" },
      { kind: "judged", violations: [[ARTIFACT, [UNIMPLEMENTED]]] },
      { kind: "judged", violations: { [ARTIFACT]: [UNIMPLEMENTED] } },
      { kind: "judged", violations: new Map([[ARTIFACT, []]]) },
      { kind: "judged", violations: new Map([["", [UNIMPLEMENTED]]]) },
      { kind: "judged", violations: new Map([[ARTIFACT, [{ subject: "x", reason: "lost", remedy: null }]]]) },
      { kind: "judged", violations: new Map([[ARTIFACT, [UNIMPLEMENTED]]]), surplus: 1 },
    ]) {
      expect(parseObservedProofEvidence({ ...raw, contractConformance }).ok, String(contractConformance)).toBe(false);
    }
  });
});

describe("contract-violated receipt failure kind (FR-021)", () => {
  const ARTIFACT = "src/order/pricing.ts";
  const RELISTED: ConformanceViolation = {
    subject: "OrderState",
    reason: "re-lists-frozen-variants",
    remedy: "LocalState re-lists the variants of the frozen union OrderState",
  };
  type Violations = readonly [ConformanceViolation, ...ConformanceViolation[]];
  const failureOf = (violations: Violations) =>
    ({ kind: "declared-artifact-contract-violated" as const, artifact: ARTIFACT, violations });

  it("FR-021: round-trips every violation of an artifact, file, subject, reason and remedy, through the receipt kind", () => {
    const kind = contractViolatedFailureKind(failureOf([UNIMPLEMENTED, RELISTED]), 4_096);
    expect(kind.startsWith(`${CONTRACT_VIOLATED_FAILURE_KIND_PREFIX}`)).toBe(true);
    expect(parseContractViolatedFailureKind(kind)).toEqual({
      ok: true,
      value: { artifact: ARTIFACT, shown: [UNIMPLEMENTED, RELISTED], omitted: 0 },
    });
  });

  it("bounds an over-long list to the longest prefix that fits and counts the rest", () => {
    const many = Array.from({ length: 400 }, (_, index): ConformanceViolation =>
      ({ subject: `export${index}`, reason: "deleted", remedy: null })) as unknown as Violations;
    const kind = contractViolatedFailureKind(failureOf(many), 4_096);
    expect(kind.length).toBeLessThanOrEqual(4_096);
    const parsed = parseContractViolatedFailureKind(kind);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.value.omitted).toBeGreaterThan(0);
    expect(parsed.value.shown.length + parsed.value.omitted).toBe(400);
    expect(parsed.value.shown).toEqual(many.slice(0, parsed.value.shown.length));
    // One more shown violation would not have fit.
    const tighter = contractViolatedFailureKind(failureOf(many), kind.length - 1);
    const tighterParsed = parseContractViolatedFailureKind(tighter);
    expect(tighterParsed.ok && tighterParsed.value.shown.length).toBe(parsed.value.shown.length - 1);
  });

  it("counts a single violation too long for the bound instead of dropping it", () => {
    const huge: ConformanceViolation = { subject: "x", reason: "retyped", remedy: "r".repeat(5_000) };
    const kind = contractViolatedFailureKind(failureOf([huge]), 4_096);
    expect(kind.length).toBeLessThanOrEqual(4_096);
    expect(parseContractViolatedFailureKind(kind)).toEqual({ ok: true, value: { artifact: ARTIFACT, shown: [], omitted: 1 } });
  });

  it("property: decoding an encoded kind yields a prefix of the violations plus the count it leaves out", () => {
    const violation = fc.record({
      // Canonical subjects: the violation parser trims, as it does for the stored Proof.
      subject: fc.string({ minLength: 1, maxLength: 40 }).map((value) => value.trim()).filter((value) => value !== ""),
      reason: fc.constantFrom(
        "deleted", "renamed", "retyped", "still-unimplemented", "shadows-frozen-adt", "re-lists-frozen-variants",
      ) as fc.Arbitrary<ConformanceViolation["reason"]>,
      remedy: fc.option(fc.string({ maxLength: 80 }), { nil: null }),
    });
    fc.assert(fc.property(
      fc.array(violation, { minLength: 1, maxLength: 30 }),
      fc.integer({ min: 200, max: 4_096 }),
      (violations, bound) => {
        const kind = contractViolatedFailureKind(failureOf(violations as unknown as Violations), bound);
        expect(kind.length).toBeLessThanOrEqual(bound);
        const parsed = parseContractViolatedFailureKind(kind);
        if (!parsed.ok) throw new Error(parsed.errors.join("; "));
        expect(parsed.value.artifact).toBe(ARTIFACT);
        expect(parsed.value.shown).toEqual(violations.slice(0, parsed.value.shown.length));
        expect(parsed.value.shown.length + parsed.value.omitted).toBe(violations.length);
      },
    ));
  });

  it("refuses a kind that is not an exact, well-formed contract-violated receipt kind", () => {
    const encode = (body: unknown) => `${CONTRACT_VIOLATED_FAILURE_KIND_PREFIX}${JSON.stringify(body)}`;
    const good = { artifact: ARTIFACT, omitted: 0, violations: [UNIMPLEMENTED] };
    for (const kind of [
      "proof:declared-artifact-not-changed",
      `proof:declared-artifact-contract-violated ${ARTIFACT}: priceOrder: still-unimplemented`,
      `${CONTRACT_VIOLATED_FAILURE_KIND_PREFIX}{`,
      encode([good]),
      encode({ ...good, extra: true }),
      encode({ ...good, artifact: " " }),
      encode({ ...good, omitted: -1 }),
      encode({ ...good, omitted: 1.5 }),
      encode({ ...good, violations: [], omitted: 0 }),
      encode({ ...good, violations: [{ subject: "x", reason: "lost", remedy: null }] }),
      encode({ artifact: ARTIFACT, violations: [UNIMPLEMENTED] }),
    ]) {
      expect(parseContractViolatedFailureKind(kind).ok, kind).toBe(false);
    }
    expect(parseContractViolatedFailureKind(encode({ ...good, violations: [], omitted: 2 }))).toEqual({
      ok: true,
      value: { artifact: ARTIFACT, shown: [], omitted: 2 },
    });
  });
});
