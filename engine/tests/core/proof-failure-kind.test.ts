/**
 * The receipt failure kind each ProofFailure mints (`proofFailureKind`). The
 * table is keyed by every ProofFailure kind, so a new failure in the union is
 * a compile error here until its receipt label is pinned.
 */
import { describe, expect, it } from "vitest";
import { proofFailureKind } from "../../src/core/implementation-completion";
import { contractViolatedFailureKind, type ProofFailure } from "../../src/core/proof-obligations";

type Case = Readonly<{ failure: ProofFailure; label: string }>;

const VIOLATED: Extract<ProofFailure, { kind: "declared-artifact-contract-violated" }> = {
  kind: "declared-artifact-contract-violated",
  artifact: "src/order.ts",
  violations: [{ subject: "priceOrder", reason: "still-unimplemented", remedy: null }],
};

const CASES: { readonly [Kind in ProofFailure["kind"]]: Case } = {
  "task-not-completed": { failure: { kind: "task-not-completed" }, label: "proof:task-not-completed" },
  "test-result-missing": { failure: { kind: "test-result-missing" }, label: "proof:test-result-missing" },
  "regression-tests-failed": {
    failure: { kind: "regression-tests-failed", provenance: "ledger" },
    label: "proof:regression-tests-failed",
  },
  "untrusted-regression-tests-failed": {
    failure: { kind: "untrusted-regression-tests-failed", label: "pi-structured" },
    label: "proof:untrusted-regression-tests-failed",
  },
  "untrusted-regression-pass": {
    failure: { kind: "untrusted-regression-pass", label: "pi-structured" },
    label: "proof:untrusted-regression-pass",
  },
  "new-tests-not-observed": { failure: { kind: "new-tests-not-observed" }, label: "proof:new-tests-not-observed" },
  "red-then-green-unproven": {
    failure: { kind: "red-then-green-unproven", gap: { kind: "red-missing", untrustedOnly: false } },
    label: "proof:red-then-green-unproven:red-missing",
  },
  "attempt-scope-drifted": { failure: { kind: "attempt-scope-drifted" }, label: "proof:attempt-scope-drifted" },
  "declared-artifact-not-changed": {
    failure: { kind: "declared-artifact-not-changed", artifact: "src/order.ts" },
    label: "proof:declared-artifact-not-changed",
  },
  "declared-artifact-contract-violated": {
    failure: VIOLATED,
    label: contractViolatedFailureKind(VIOLATED, 4_096),
  },
  "declared-artifact-drifted": {
    failure: { kind: "declared-artifact-drifted", artifact: "src/order.ts" },
    label: "proof:declared-artifact-drifted",
  },
};

describe("proofFailureKind", () => {
  it.each(Object.entries(CASES))("mints the receipt label for %s", (_kind, { failure, label }) => {
    expect(proofFailureKind(failure)).toBe(label);
  });

  it("names an I6 failure by its unmet step", () => {
    expect(proofFailureKind({ kind: "red-then-green-unproven", gap: { kind: "ledger-unavailable" } }))
      .toBe("proof:red-then-green-unproven:ledger-unavailable");
  });

  it("carries a contract-violated failure's artifact and violations behind its label prefix", () => {
    expect(proofFailureKind(VIOLATED).startsWith("proof:declared-artifact-contract-violated ")).toBe(true);
    expect(proofFailureKind(VIOLATED)).toContain("src/order.ts");
  });
});
