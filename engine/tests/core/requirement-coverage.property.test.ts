import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, type ParsedSpec, type SpecContentHash } from "../../src/core/parse-spec";
import {
  claimDecider,
  claimSeverity,
  claimVerdictMessage,
  projectRequirementCoverage,
  recordedAnchorHashes,
  renderRequirementCoverage,
  settledCriticalCount,
  settledFloorProblem,
  type CoverageTask,
  type RecordedHash,
  type SpecIndexAvailability,
} from "../../src/core/requirement-coverage";

const specSource = `# Feature: Coverage

## User Scenarios

### US1: [P1] Cover requirements

**Acceptance Scenarios:**
- AS-001: Given a claim, When the gate runs, Then a verdict exists
- AS-002: Given no claim, When the gate runs, Then the scenario is listed

## Functional Requirements

- FR-001: System MUST join claims against the Spec Index
- FR-002: System MUST record Requirement hashes at link time
- FR-003: System MUST report drift as a distinct fact

## Out of Scope

- OOS-001: Symbol-level source indexing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
`;

const index = ((): ParsedSpec => {
  const parsed = parseSpec(specSource);
  if (!parsed.ok) throw new Error("fixture specification must parse");
  return parsed.value;
})();

const indexed: SpecIndexAvailability =
  Object.freeze({ kind: "indexed", path: "spec.md", contentDigest: "a".repeat(64), index });

const KNOWN = ["FR-001", "FR-002", "FR-003", "AS-001", "AS-002", "OOS-001"] as const;

/** Every real content hash, so `stable` is reachable from the general roster. */
const REAL_HASHES: ReadonlyMap<string, SpecContentHash> =
  new Map(Object.entries(recordedAnchorHashes(index, KNOWN)));

const claimArb = fc.oneof(
  fc.constantFrom(...KNOWN),
  fc.string({ minLength: 1, maxLength: 12 }),
);

const hexHashArb: fc.Arbitrary<SpecContentHash> = fc
  .string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 64, maxLength: 64 })
  .map((raw) => raw as SpecContentHash);

/**
 * A recorded hash of every kind the boundary can produce, for a claim that may
 * or may not be real. `real` is what makes `stable` reachable: a purely random
 * 64-hex string can never equal a content hash, so an arbitrary built only from
 * `hexHashArb` silently excluded one third of `DriftFact` from every property.
 */
const recordedArb = (claim: string): fc.Arbitrary<RecordedHash> => {
  const real = REAL_HASHES.get(claim);
  return fc.oneof(
    ...(real === undefined ? [] : [fc.constant<RecordedHash>({ kind: "readable", hash: real })]),
    hexHashArb.map<RecordedHash>((hash) => ({ kind: "readable", hash })),
    fc.string({ minLength: 1, maxLength: 8 })
      .filter((raw) => !/^[0-9a-f]{64}$/u.test(raw))
      .map<RecordedHash>((stored) => ({ kind: "unreadable", stored })),
  );
};

const anchorHashesArb = (claims: readonly string[]): fc.Arbitrary<ReadonlyMap<string, RecordedHash>> =>
  claims.length === 0
    ? fc.constant(new Map<string, RecordedHash>())
    : fc.tuple(...claims.map((claim) => fc.option(recordedArb(claim), { nil: null })))
        .map((recorded) => new Map(
          claims.flatMap((claim, at) => {
            const value = recorded[at];
            return value === null || value === undefined ? [] : [[claim, value] as const];
          }),
        ));

const taskArb: fc.Arbitrary<CoverageTask> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 6 }),
    inCurrentWave: fc.boolean(),
    completionAnchors: fc.uniqueArray(claimArb, { maxLength: 6 }),
    declaredFiles: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
    modifiedFiles: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  })
  .chain((base) => anchorHashesArb(base.completionAnchors).map((anchorHashes) => ({ ...base, anchorHashes })));

const tasksArb = fc.array(taskArb, { maxLength: 5 });

describe("Requirement Coverage Projection properties", () => {
  it("is total and deterministic for any roster", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      expect(() => projectRequirementCoverage(indexed, tasks)).not.toThrow();
      expect(projectRequirementCoverage(indexed, tasks))
        .toEqual(projectRequirementCoverage(indexed, tasks));
    }));
  });

  it("emits exactly one row per current-Wave claim, in roster order", () => {
    // The count invariant `/spec-check` Step 4 used to enforce by asking the
    // model to re-count its own output. Here it holds by construction.
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const expected = tasks
        .filter(({ inCurrentWave }) => inCurrentWave)
        .flatMap((task) => task.completionAnchors.map((claim) => `${task.id}|${claim}`));
      expect(coverage.rows.map(({ taskId, claim }) => `${taskId}|${claim}`)).toEqual(expected);
    }));
  });

  it("never hands a model a claim the Spec Index does not define as completable", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      for (const row of coverage.rows) {
        if (row.verdict.kind !== "candidate-pass") continue;
        expect(["FR-001", "FR-002", "FR-003", "AS-001", "AS-002"]).toContain(row.verdict.entry.id);
      }
    }));
  });

  it("decides settlement by verdict kind alone, never by severity", () => {
    // The invariant D6 restored: a MEDIUM or CRITICAL row can still be the
    // Agent's, and only a candidate-pass ever is.
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      for (const { verdict } of coverage.rows) {
        expect(claimVerdictMessage(verdict).length).toBeGreaterThan(0);
        expect(claimDecider(verdict)).toBe(verdict.kind === "candidate-pass" ? "agent" : "engine");
        if (verdict.kind === "candidate-pass") {
          const expectedSeverity = verdict.drift.kind === "unreadable-record"
            ? "CRITICAL"
            : verdict.drift.kind === "drifted" ? "MEDIUM" : "NONE";
          expect(claimSeverity(verdict)).toBe(expectedSeverity);
        } else {
          expect(claimSeverity(verdict)).toBe("CRITICAL");
        }
      }
    }));
  });

  it("reaches every DriftFact kind across the generated rosters", () => {
    // A guard on the arbitraries themselves: the previous `hashArb` made
    // `stable` unreachable, so a property named for it proved nothing.
    const seen = new Set<string>();
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      for (const { verdict } of coverage.rows) {
        if (verdict.kind === "candidate-pass") seen.add(verdict.drift.kind);
      }
    }), { numRuns: 400 });
    expect(seen).toEqual(new Set(["unverifiable", "unreadable-record", "stable", "drifted"]));
  });

  it("an identifier is unclaimed only when no Task at any Wave names it", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const named = new Set(tasks.flatMap(({ completionAnchors }) => completionAnchors));
      for (const id of [...coverage.unclaimed, ...coverage.unclaimedScenarios]) {
        expect(named.has(id)).toBe(false);
      }
      for (const { id } of index.frs) {
        if (!named.has(id)) expect(coverage.unclaimed).toContain(id);
      }
      for (const { id } of index.scenarios) {
        if (!named.has(id)) expect(coverage.unclaimedScenarios).toContain(id);
      }
    }));
  });

  it("hashes recorded from the index always read back as stable, for any claim set", () => {
    // The round trip that makes drift meaningful: what `recordedAnchorHashes`
    // writes at link time is exactly what the gate proves unchanged, so a
    // Requirement nobody edited can never report as drifted.
    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom(...KNOWN), { minLength: 1, maxLength: 6 }),
      (claims) => {
        const anchorHashes = new Map<string, RecordedHash>(
          Object.entries(recordedAnchorHashes(index, claims))
            .map(([claim, hash]) => [claim, { kind: "readable", hash } as const]),
        );
        const coverage = projectRequirementCoverage(indexed, [{
          id: "T1",
          inCurrentWave: true,
          completionAnchors: claims,
          declaredFiles: ["src/a.ts"],
          modifiedFiles: ["src/a.ts"],
          anchorHashes,
        }]);
        if (coverage.kind !== "projected") return;
        for (const { verdict } of coverage.rows) {
          if (verdict.kind !== "candidate-pass") continue;
          expect(verdict.drift.kind).toBe("stable");
          expect(claimSeverity(verdict)).toBe("NONE");
        }
      },
    ));
  });

  it("the settled floor equals the CRITICAL findings the command tells the Agent to emit", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      // A Wave with no claims renders one synthetic CRITICAL row, and the floor
      // counts it: that row names an entire Wave of work tracing to no
      // Requirement, and it was the one settled finding an Agent could drop for
      // free while the projection stated a floor of zero.
      const criticalRows = coverage.rows.length === 0
        ? 1
        : coverage.rows.filter(({ verdict }) => claimSeverity(verdict) === "CRITICAL").length;
      const expected = criticalRows + coverage.unclaimed.length + coverage.unclaimedScenarios.length;
      expect(settledCriticalCount(coverage)).toBe(expected);
      expect(settledFloorProblem(coverage, expected)).toBeNull();
      if (expected > 0) expect(settledFloorProblem(coverage, expected - 1)).not.toBeNull();
    }));
  });

  it("renders one body row per projected row, whatever the claim text contains", () => {
    // Asserts the table's SHAPE, not substring presence: a claim carrying a
    // pipe or a newline must not become extra rows in engine-settled authority.
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      const rendered = renderRequirementCoverage(coverage);
      if (coverage.kind !== "projected") return;
      const bodyRows = rendered
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| Task |") && !line.startsWith("|---"));
      expect(bodyRows).toHaveLength(Math.max(coverage.rows.length, 1));
      for (const id of [...coverage.unclaimed, ...coverage.unclaimedScenarios]) {
        expect(rendered).toContain(id);
      }
    }));
  });
});
