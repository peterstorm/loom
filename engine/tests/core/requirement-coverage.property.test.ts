import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, type ParsedSpec, type SpecContentHash } from "../../src/core/parse-spec";
import {
  claimSeverity,
  claimVerdictMessage,
  projectRequirementCoverage,
  recordedAnchorHashes,
  renderRequirementCoverage,
  type CoverageTask,
  type SpecIndexAvailability,
} from "../../src/core/requirement-coverage";

const specSource = `# Feature: Coverage

## User Scenarios

### US1: [P1] Cover requirements

**Acceptance Scenarios:**
- AS-001: Given a claim, When the gate runs, Then a verdict exists
- AS-002: Given no claim, When the gate runs, Then the table says so

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

const indexed: SpecIndexAvailability = Object.freeze({ kind: "indexed", path: "spec.md", index });

const KNOWN = ["FR-001", "FR-002", "FR-003", "AS-001", "AS-002", "OOS-001"] as const;

const claimArb = fc.oneof(
  fc.constantFrom(...KNOWN),
  fc.string({ minLength: 1, maxLength: 12 }),
);

const hashArb: fc.Arbitrary<SpecContentHash> = fc
  .string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 64, maxLength: 64 })
  .map((raw) => raw as SpecContentHash);

const taskArb: fc.Arbitrary<CoverageTask> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  inCurrentWave: fc.boolean(),
  completionAnchors: fc.uniqueArray(claimArb, { maxLength: 6 }),
  declaredFiles: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  modifiedFiles: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 3 }),
  anchorHashes: fc.option(
    fc.array(fc.tuple(claimArb, hashArb), { maxLength: 4 })
      .map((pairs) => new Map(pairs) as ReadonlyMap<string, SpecContentHash>),
    { nil: null },
  ),
});

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

  it("gives every claim a rendered verdict, and grades exactly the non-candidates as settled", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      for (const { verdict } of coverage.rows) {
        expect(claimVerdictMessage(verdict).length).toBeGreaterThan(0);
        // A settled row is exactly a non-candidate; only a candidate is ever
        // handed to a model, and only a drifted candidate grades MEDIUM.
        expect(claimSeverity(verdict) === "CANDIDATE").toBe(
          verdict.kind === "candidate-pass" && verdict.drift.kind !== "drifted",
        );
        expect(["CRITICAL", "MEDIUM", "CANDIDATE"]).toContain(claimSeverity(verdict));
      }
    }));
  });

  it("a claim is unclaimed only when no Task at any Wave names it", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const named = new Set(tasks.flatMap(({ completionAnchors }) => completionAnchors));
      for (const id of coverage.unclaimed) expect(named.has(id)).toBe(false);
      for (const { id } of index.frs) {
        if (!named.has(id)) expect(coverage.unclaimed).toContain(id);
      }
    }));
  });

  it("hashes recorded from the index always read back as stable, for any claim set", () => {
    // The round trip that makes drift meaningful: what `recordedAnchorHashes`
    // writes at link time is exactly what `driftOf` proves unchanged at the
    // gate, so a Requirement nobody edited can never report as drifted.
    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom(...KNOWN), { minLength: 1, maxLength: 6 }),
      (claims) => {
        const recorded = recordedAnchorHashes(index, claims);
        const anchorHashes = new Map(
          Object.entries(recorded).map(([claim, hash]) => [claim, hash as SpecContentHash]),
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
        }
      },
    ));
  });

  it("renders every row it projected, so no verdict is silently dropped", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      const rendered = renderRequirementCoverage(coverage);
      if (coverage.kind !== "projected") return;
      for (const row of coverage.rows) expect(rendered).toContain(row.claim);
      for (const id of coverage.unclaimed) expect(rendered).toContain(id);
    }));
  });
});
