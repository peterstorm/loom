import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec, type ParsedSpec, type SpecContentHash } from "../../src/core/parse-spec";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../src/core/spec-check";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import {
  claimDecider,
  claimSeverity,
  claimVerdictMessage,
  projectRequirementCoverage,
  recordedAnchorHashes,
  renderRequirementCoverage,
  settledCriticalCount,
  settledFloorOf,
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

const parsedDigest = parseArtifactDigest("a".repeat(64));
if (!parsedDigest.ok) throw new Error("fixture Artifact Digest must parse");
const indexed: SpecIndexAvailability =
  Object.freeze({ kind: "indexed", path: "spec.md", contentDigest: parsedDigest.value, index });

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
 * or may not be real. `real` is what makes `stable` deliberately reachable: a
 * random 64-hex value equals a real content hash only with negligible
 * probability, so `hexHashArb` cannot intentionally cover that `DriftFact` arm.
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
    decisionRecord: fc.boolean(),
    completionAnchors: fc.uniqueArray(claimArb, { maxLength: 6 }),
    contributions: fc.array(fc.constantFrom(...KNOWN), { maxLength: 2 }),
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
          decisionRecord: false,
          completionAnchors: claims,
          contributions: [],
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

  it("the floor counts every structural CRITICAL regardless of who assesses implementation", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const structuralCriticals = coverage.rows.filter(({ verdict }) =>
        claimSeverity(verdict) === "CRITICAL").length;
      const unclaimed = coverage.unclaimed.length + coverage.unclaimedScenarios.length;
      const synthetic = coverage.rows.length === 0 && coverage.unclaimedTrace === "nowhere" ? 1 : 0;
      expect(settledCriticalCount(coverage)).toBe(structuralCriticals + unclaimed + synthetic);
    }));
  });

  it("a Wave traces through decision records exactly when every current Task is one and none contributes", () => {
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const current = tasks.filter(({ inCurrentWave }) => inCurrentWave);
      const contributes = current.some(({ contributions }) => contributions.some((claim) => claim !== "OOS-001"));
      const expected = contributes
        ? "contributions"
        : current.length > 0 && current.every(({ decisionRecord }) => decisionRecord) ? "decision-records" : "nowhere";
      expect(coverage.unclaimedTrace).toBe(expected);
    }));
  });

  it("the floor is what reconcileSpecCheck actually enforces", () => {
    // Asserted against the rule that runs, not a second copy of it. The
    // production-dead duplicate this replaces carried these assertions while
    // the enforced copy carried none.
    fc.assert(fc.property(tasksArb, (tasks) => {
      const coverage = projectRequirementCoverage(indexed, tasks);
      if (coverage.kind !== "projected") return;
      const floor = settledFloorOf(coverage);
      if (floor.kind !== "settled") throw new Error("projected coverage must mint a current floor");
      const report = (findings: readonly string[]) => reconcileSpecCheck(
        parseSpecCheckOutput([
          "SPEC_CHECK_WAVE: 1",
          ...findings.map((finding) => `CRITICAL: ${finding}`),
          `SPEC_CHECK_CRITICAL_COUNT: ${findings.length}`,
          "SPEC_CHECK_HIGH_COUNT: 0",
          `SPEC_CHECK_VERDICT: ${findings.length === 0 ? "PASSED" : "BLOCKED"}`,
        ].join("\n")),
        1, "2026-09-06T00:00:00.000Z", floor,
      );
      expect(report(floor.criticalFindings).kind).toBe("captured");
      expect(report([...floor.criticalFindings, "Agent finding"]).kind).toBe("captured");
      if (floor.criticalFindings.length > 0) {
        expect(report(floor.criticalFindings.slice(1)).kind).toBe("evidence-failed");
      }
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
