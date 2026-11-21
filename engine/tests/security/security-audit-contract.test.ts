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
import { z } from "zod/v4";
import {
  PRIOR_STATUSES,
  SECURITY_INCOMPLETE_REASONS,
  SECURITY_PROFILES,
  admitWave,
  canonicalCoverageId,
  carryAction,
  derivePriorStatus,
  encodeCanonicalRef,
  isCanonicalCoverageRefs,
  isOneOf,
  isWireRecord,
  parseCoverageRefs,
  parseSecurityProfile,
  parseSecurityRunMetadata,
  parseWire,
  priorRecordFactsSchema,
  stringListSchema,
  wirePath,
  wireViolation,
  type PriorRecordFacts,
} from "../../src/core/security-audit-contract";
import { aRefs, aRunMetadata, ok } from "./fixtures";

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
          // `remaining` still CONTAINS the reserve: admission keeps it, it does
          // not spend it — which is what `WaveAdmission.remaining` documents.
          expect(remaining).toBeGreaterThanOrEqual(reserved);
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
  const valid = aRunMetadata({
    repo: "example/app",
    target: "/tmp/example",
    scope: { paths: ["src/app.ts"], kind: "tree", baseRef: null, headRef: null },
    scopePaths: ["src/app.ts"],
    budget: 20,
    selectedCompanions: ["ATTACK-CLASSES.md"],
    runStatus: "in_progress",
  });

  it("accepts a canonical document, and its JSON form", () => {
    expect(parseSecurityRunMetadata(valid).ok).toBe(true);
    expect(parseSecurityRunMetadata(JSON.parse(JSON.stringify(valid))).ok).toBe(true);
  });

  it("ties the incomplete reason to the run status", () => {
    expect(parseSecurityRunMetadata({ ...valid, runStatus: "incomplete" }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, incompleteReason: "critic_budget_exhausted" }).ok).toBe(false);
    expect(parseSecurityRunMetadata({ ...valid, runStatus: "incomplete", incompleteReason: "critic_budget_exhausted" }).ok).toBe(true);
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
  const refs = aRefs({ surface: "http:GET /reports/:id", boundary: "tenant isolation", subsystem: "reporting", attack_class: "cache-key-poisoning" });

  it("percent-encodes every reserved byte, so `::` can only be the field separator", () => {
    expect(encodeCanonicalRef("http:GET /reports/:id")).toBe("http%3AGET%20%2Freports%2F%3Aid");
    expect(encodeCanonicalRef("a-b_c.d~e")).toBe("a-b_c.d~e");
    expect(canonicalCoverageId(refs)).toBe("http%3AGET%20%2Freports%2F%3Aid::tenant%20isolation::reporting::cache-key-poisoning");
    expect(canonicalCoverageId(aRefs({ ...refs, lifecycle: "retention" }))).toBe(`${canonicalCoverageId(refs)}::retention`);
    expect(canonicalCoverageId(aRefs({ ...refs, boundary: "another boundary" }))).not.toBe(canonicalCoverageId(refs));
  });

  it("refuses a reference that is not canonical rather than encoding it", () => {
    for (const bad of ["", " padded", "zero​width", "é"]) {
      expect(() => encodeCanonicalRef(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it("round-trips: splitting an id on `::` and decoding each field recovers the refs", () => {
    const field = fc.stringMatching(/^[A-Za-z0-9 :/_.~%-]{1,24}$/).filter((value) => value.trim() === value && /\S/.test(value));
    fc.assert(
      fc.property(field, field, field, field, (surface, boundary, subsystem, attack_class) => {
        const id = canonicalCoverageId(aRefs({ surface, boundary, subsystem, attack_class }));
        expect(id.split("::").map((encoded) => decodeURIComponent(encoded))).toEqual([surface, boundary, subsystem, attack_class]);
      }),
    );
  });
});

describe("the wire parsing kit", () => {
  const pair = z.strictObject({ name: z.string(), tags: stringListSchema });
  const refusal = (raw: unknown, root = "$") => {
    const parsed = parseWire(pair, raw, root);
    return parsed.ok ? [] : parsed.error;
  };

  it("spells a path as the diagnostics do: `.key` for a field, `[i]` for an element, `$` for the root", () => {
    expect(wirePath("$", [])).toBe("$");
    expect(wirePath("", [])).toBe("$");
    expect(wirePath("$", [0, "checks", 2, "agent_id"])).toBe("$[0].checks[2].agent_id");
    expect(wirePath("", ["units", 0, "status"])).toBe("units[0].status");
    expect(wirePath("critic", ["missingUnits", 1])).toBe("critic.missingUnits[1]");
  });

  it("parses a well-formed document into its typed value", () => {
    expect(parseWire(pair, { name: "a", tags: ["x"] })).toEqual({ ok: true, value: { name: "a", tags: ["x"] } });
  });

  it("names an absent field as required and a mistyped one by the type it expected", () => {
    expect(refusal({ tags: [1] })).toEqual([
      wireViolation("$.name", "required"),
      wireViolation("$.tags[0]", "expected a string"),
    ]);
    expect(refusal("x", "seed")).toEqual([wireViolation("seed", "expected an object")]);
    expect(refusal({ name: "a", tags: "x" })).toEqual([wireViolation("$.tags", "expected an array of strings")]);
  });

  it("names every undeclared key on its own path, in document order", () => {
    expect(refusal({ zeta: 1, name: "a", tags: [], alpha: 2 })).toEqual([
      wireViolation("$.zeta", "unknown field"),
      wireViolation("$.alpha", "unknown field"),
    ]);
  });

  it("calls only a JSON object a record", () => {
    expect(isWireRecord({})).toBe(true);
    expect(isWireRecord({ a: 1 })).toBe(true);
    for (const value of [null, [], "x", 1, undefined]) expect(isWireRecord(value), String(value)).toBe(false);
  });

  it("admits exactly the members of a closed vocabulary", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      expect(isOneOf(SECURITY_PROFILES, value)).toBe(typeof value === "string" && (SECURITY_PROFILES as readonly string[]).includes(value));
    }));
  });
});

describe("prior record facts: a wire seed's prior facts, refused rather than thrown", () => {
  const prior = (raw: unknown) => parseWire(priorRecordFactsSchema.nullable().default(null), raw, "prior");

  it("reads absent and null as no prior record, and a well-formed record as itself", () => {
    expect(prior(undefined)).toEqual({ ok: true, value: null });
    expect(prior(null)).toEqual({ ok: true, value: null });
    expect(prior({ verdict: "confirmed", sourceUnchanged: null })).toEqual({ ok: true, value: { verdict: "confirmed", sourceUnchanged: null } });
  });

  it.each([
    ["a carry-status token in place of a verdict", { verdict: "prior_confirmed_same_source", sourceUnchanged: true }, "prior.verdict"],
    ["a missing verdict", { sourceUnchanged: true }, "prior.verdict"],
    ["an unexpected field", { verdict: "covered", sourceUnchanged: true, status: "covered" }, "prior.status"],
    ["a non-boolean sourceUnchanged", { verdict: "covered", sourceUnchanged: "yes" }, "prior.sourceUnchanged"],
    ["a scalar", "confirmed", "prior"],
  ])("refuses %s with a named violation, never a pattern-match throw", (_case, raw, path) => {
    const parsed = prior(raw);
    expect(parsed.ok ? [] : parsed.error.map((violation) => violation.path)).toEqual([path]);
  });
});

describe("run metadata: the illegal combinations do not parse", () => {
  const base = aRunMetadata();
  const issues = (raw: unknown): readonly string[] => {
    const parsed = parseSecurityRunMetadata(raw);
    return parsed.ok ? [] : parsed.error.issues;
  };

  it("names the incomplete-reason rule in both directions", () => {
    expect(issues({ ...base, runStatus: "incomplete", incompleteReason: null })).toContain("incompleteReason: an incomplete run must name its reason");
    expect(issues({ ...base, runStatus: "complete", incompleteReason: "critic_budget_exhausted" }))
      .toContain("incompleteReason: a complete run records no incomplete reason");
  });

  it("refuses a published run that is still in progress", () => {
    expect(issues({ ...base, runStatus: "in_progress", published: true })).toContain("published: an in_progress run cannot be published");
    expect(issues({ ...base, runStatus: "complete", published: true })).toEqual([]);
  });

  it("ties a scope's refs to its kind: a diff names both commits, a tree names none", () => {
    const commit = "a".repeat(40);
    const scope = (value: Record<string, unknown>) => ({ ...base, scope: { paths: ["src/api/login.ts"], ...value } });
    expect(issues(scope({ kind: "diff", baseRef: commit, headRef: "b".repeat(64) }))).toEqual([]);
    expect(issues(scope({ kind: "tree", baseRef: null, headRef: null }))).toEqual([]);
    expect(issues(scope({ kind: "diff", baseRef: null, headRef: commit }))).not.toEqual([]);
    expect(issues(scope({ kind: "diff", baseRef: commit, headRef: null }))).not.toEqual([]);
    expect(issues(scope({ kind: "tree", baseRef: commit, headRef: null }))).not.toEqual([]);
    expect(issues(scope({ kind: "diff", baseRef: "main", headRef: commit }))).not.toEqual([]);
  });
});

describe("parseSecurityProfile", () => {
  it("admits exactly the budget profiles", () => {
    for (const profile of SECURITY_PROFILES) expect(parseSecurityProfile(profile)).toEqual({ ok: true, value: profile });
    for (const bad of ["thorough", "", null, 2]) expect(parseSecurityProfile(bad).ok, String(bad)).toBe(false);
  });
});

describe("coverage refs are parsed once, and only parsed refs are encoded", () => {
  it("guards exactly the tuples the parser admits", () => {
    const valid = { surface: "s", boundary: "b", subsystem: "x", attack_class: "a" };
    expect(isCanonicalCoverageRefs(valid)).toBe(true);
    expect(isCanonicalCoverageRefs({ ...valid, lifecycle: "retention" })).toBe(true);
    expect(isCanonicalCoverageRefs({ ...valid, extra: "x" })).toBe(false);
    expect(isCanonicalCoverageRefs({ ...valid, surface: " padded" })).toBe(false);
    expect(isCanonicalCoverageRefs({ surface: "s", boundary: "b", subsystem: "x" })).toBe(false);
    fc.assert(fc.property(fc.dictionary(fc.constantFrom("surface", "boundary", "subsystem", "attack_class", "lifecycle", "x"), fc.string()), (raw) => {
      expect(isCanonicalCoverageRefs(raw)).toBe(parseCoverageRefs(raw).ok);
    }));
  });

  it("returns a fresh record in the fixed field order, never the caller's document", () => {
    const raw = { lifecycle: "retention", attack_class: "a", subsystem: "x", boundary: "b", surface: "s" };
    const refs = ok(parseCoverageRefs(raw));
    expect(refs).not.toBe(raw);
    expect(Object.keys(refs)).toEqual(["surface", "boundary", "subsystem", "attack_class", "lifecycle"]);
  });
});
