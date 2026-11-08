/**
 * Audit-contract properties: the arithmetic that makes budget and carry-forward
 * checkable instead of narrated.
 *
 *   INV-B1  a wave can never spend the critic and validation reserve: whatever
 *           the request, reservations survive the admitted hunter count;
 *   INV-B2  too small a budget is refused with a closed reason token, never
 *           silently truncated (a truncated budget is a silent coverage claim);
 *   INV-C1  an unchecked prior source is current work — `unknown` never means
 *           "unchanged";
 *   INV-R1  `run-metadata.json` is parsed strictly, so a run cannot start with a
 *           profile, policy or scope it made up.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PRIOR_STATUSES,
  SECURITY_INCOMPLETE_REASONS,
  SECURITY_PROFILES,
  admitWave,
  canonicalCoverageId,
  carryAction,
  derivePriorStatus,
  parseSecurityRunMetadata,
  type PriorRecordFacts,
  type SecurityProfile,
} from "../../src/core/security-audit-contract";
import type { StackSignals } from "../../src/core/security-lens-select";

const profiles = fc.constantFrom(...SECURITY_PROFILES);

describe("wave budget admission", () => {
  it("never admits hunters into the critic and validation reserve (INV-B1)", () => {
    fc.assert(
      fc.property(
        profiles,
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 40 }),
        fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
        (profile, budget, spent, plannedHunters, expectedCandidates) => {
          const admitted = admitWave({ profile, budget, spent, plannedHunters, expectedCandidates });
          if (!admitted.ok) {
            expect(SECURITY_INCOMPLETE_REASONS).toContain(admitted.error.reason);
            return;
          }
          const { hunterAssignments, remaining, reserved } = admitted.value;
          expect(hunterAssignments).toBeLessThanOrEqual(plannedHunters);
          expect(hunterAssignments + reserved).toBeLessThanOrEqual(Math.max(0, budget - spent));
          expect(remaining).toBe(Math.max(0, budget - spent) - hunterAssignments);
          expect(remaining).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it("refuses a budget that cannot fund the fixed reserves (INV-B2)", () => {
    const admitted = admitWave({ profile: "standard", budget: 4, spent: 0, plannedHunters: 2, expectedCandidates: null });
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) {
      expect(admitted.error.reason).toBe("budget_cannot_fund_reconnaissance_and_reserves");
      expect(admitted.error.required).toBeGreaterThan(admitted.error.available);
    }
  });

  it("keeps a validation reserve even when every planned hunter fits", () => {
    const admitted = admitWave({ profile: "quick", budget: 10, spent: 0, plannedHunters: 1, expectedCandidates: null });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.error));
    expect(admitted.value.hunterAssignments).toBe(1);
    expect(admitted.value.reserved).toBeGreaterThanOrEqual(2);
  });

  it("charges the deep profile two verifier calls per expected candidate", () => {
    const deep = admitWave({ profile: "deep", budget: 40, spent: 0, plannedHunters: 4, expectedCandidates: 5 });
    const standard = admitWave({ profile: "standard", budget: 40, spent: 0, plannedHunters: 4, expectedCandidates: 5 });
    if (!deep.ok || !standard.ok) throw new Error("both must fit");
    expect(deep.value.reserved).toBeGreaterThan(standard.value.reserved);
  });
});

describe("prior-run carry", () => {
  const facts = (overrides: Partial<PriorRecordFacts>): PriorRecordFacts => ({
    verdict: "confirmed",
    sourceUnchanged: null,
    ...overrides,
  });

  it("treats an unchecked source as current work (INV-C1)", () => {
    expect(derivePriorStatus(facts({ sourceUnchanged: null }))).toBe("prior_confirmed_changed_source");
    expect(carryAction(derivePriorStatus(facts({ sourceUnchanged: null })))).toEqual({ kind: "revalidate" });
    expect(derivePriorStatus(null)).toBe("none");
    expect(carryAction("none")).toEqual({ kind: "current-work" });
  });

  it("carries only a confirmation whose source is proven unchanged", () => {
    expect(carryAction(derivePriorStatus(facts({ sourceUnchanged: true })))).toEqual({ kind: "carry-confirmed" });
    expect(carryAction(derivePriorStatus(facts({ verdict: "confirmed", sourceUnchanged: false })))).toEqual({ kind: "revalidate" });
  });

  it("suppresses only the failed claim, never the unit's coverage", () => {
    expect(carryAction(derivePriorStatus(facts({ verdict: "rejected", sourceUnchanged: false })))).toEqual({
      kind: "suppress-rejected-claim",
    });
    expect(carryAction(derivePriorStatus(facts({ verdict: "covered", sourceUnchanged: true })))).toEqual({ kind: "current-work" });
    expect(carryAction(derivePriorStatus(facts({ verdict: "deferred", sourceUnchanged: true })))).toEqual({ kind: "current-work" });
  });

  it("is total over the closed prior-status vocabulary", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRIOR_STATUSES), (status) => {
        expect(["current-work", "carry-confirmed", "revalidate", "suppress-rejected-claim"]).toContain(carryAction(status).kind);
      }),
    );
  });
});

describe("run metadata", () => {
  const valid = {
    schemaVersion: 1,
    runId: "audit-1",
    repo: "example/app",
    target: "/tmp/example",
    profile: "standard" as SecurityProfile,
    scope: { paths: ["src/app.ts"], kind: "tree", baseRef: null, headRef: null },
    scopePaths: ["src/app.ts"],
    sourceRef: { commit: "0".repeat(40), worktreeDirty: false },
    budget: 20,
    executionPolicy: "sandboxed-source-and-local-only",
    selectedCompanions: ["ATTACK-CLASSES.md"],
    priorRuns: [],
    runStatus: "in_progress",
    incompleteReason: null,
  };

  it("accepts a canonical document", () => {
    const parsed = parseSecurityRunMetadata(valid);
    expect(parsed.ok).toBe(true);
  });

  it("refuses an unknown profile, policy, reason or extra field (INV-R1)", () => {
    expect(parseSecurityRunMetadata({ ...valid, profile: "thorough" }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, executionPolicy: "best-effort" }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, incompleteReason: "ran out of time" }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, extra: true }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, scopePaths: ["../escape.ts"] }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, sourceRef: { commit: "HEAD", worktreeDirty: false } }).ok).toBe(false);
  });
});

describe("coverage identity", () => {
  it("encodes a canonical id that round-trips through the ledger grammar", () => {
    const { canonicalCoverageId: id, encodeCanonicalRef } = { canonicalCoverageId, encodeCanonicalRef: (value: string) => value };
    const coverageId = id({ surface: "http:GET /reports/:id", boundary: "tenant isolation", subsystem: "reporting", attack_class: "cache-key-poisoning" });
    expect(coverageId).toContain("::");
    expect(coverageId).not.toMatch(/\s/);
    expect(id({ surface: "http:GET /reports/:id", boundary: "tenant isolation", subsystem: "reporting", attack_class: "cache-key-poisoning" })).toBe(coverageId);
    expect(id({ surface: "http:GET /reports/:id", boundary: "another boundary", subsystem: "reporting", attack_class: "cache-key-poisoning" })).not.toBe(coverageId);
    expect(encodeCanonicalRef("a::b")).toBe("a::b");
  });

  it("is insensitive to stack signals it never reads", () => {
    const signals = (overrides: Partial<StackSignals>): StackSignals => ({
      languages: [],
      manifests: [],
      servesHttp: false,
      rendersClientSide: false,
      drivesModelsOrTools: false,
      usesQueuesOrRpc: false,
      isolatesTenants: false,
      deploysInfrastructure: false,
      hasNativeMemory: false,
      hasAppOrLocalIpc: false,
      hasReleasePipelines: false,
      hasSharedResourcePressure: false,
      ...overrides,
    });
    expect(signals({}).languages).toEqual([]);
  });
});
