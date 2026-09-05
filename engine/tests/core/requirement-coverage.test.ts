import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseSpec, parseSpecContentHash, type ParsedSpec, type SpecContentHash } from "../../src/core/parse-spec";
import {
  claimSeverity,
  claimVerdictMessage,
  projectRequirementCoverage,
  recordedAnchorHashes,
  renderRequirementCoverage,
  specIndexUnavailableMessage,
  type CoverageTask,
  type SpecIndexAvailability,
} from "../../src/core/requirement-coverage";

const specSource = `# Feature: Coverage

## User Scenarios

### US1: [P1] Cover requirements

**Acceptance Scenarios:**
- AS-001: Given a claim, When the gate runs, Then a verdict exists

## Functional Requirements

- FR-001: System MUST join claims against the Spec Index
- FR-002: System MUST record Requirement hashes at link time

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

const hashesOf = (claims: readonly string[]): ReadonlyMap<string, SpecContentHash> => {
  const recorded = recordedAnchorHashes(index, claims);
  const map = new Map<string, SpecContentHash>();
  for (const [claim, raw] of Object.entries(recorded)) {
    const hash = parseSpecContentHash(raw);
    if (hash !== null) map.set(claim, hash);
  }
  return map;
};

const task = (overrides: Partial<CoverageTask> = {}): CoverageTask => Object.freeze({
  id: "T1",
  inCurrentWave: true,
  completionAnchors: ["FR-001"],
  declaredFiles: ["src/a.ts"],
  modifiedFiles: ["src/a.ts"],
  anchorHashes: null,
  ...overrides,
});

/** The projected shape, or a failure — every assertion below wants rows. */
const rowsOf = (tasks: readonly CoverageTask[], availability: SpecIndexAvailability = indexed) => {
  const coverage = projectRequirementCoverage(availability, tasks);
  if (coverage.kind !== "projected") throw new Error("expected a projected coverage");
  return coverage;
};

describe("projectRequirementCoverage", () => {
  it("hands a structurally sound claim to the model as a candidate", () => {
    const { rows } = rowsOf([task({ anchorHashes: hashesOf(["FR-001"]) })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: "T1", claim: "FR-001" });
    expect(rows[0]?.verdict).toMatchObject({ kind: "candidate-pass", drift: { kind: "stable" } });
    expect(claimSeverity(rows[0]!.verdict)).toBe("CANDIDATE");
  });

  it("settles a claim the specification does not define", () => {
    const { rows } = rowsOf([task({ completionAnchors: ["FR-404"] })]);
    expect(rows[0]?.verdict).toEqual({ kind: "unknown-requirement" });
    expect(claimSeverity(rows[0]!.verdict)).toBe("CRITICAL");
  });

  it("settles a claim to have completed an explicitly excluded item", () => {
    const { rows } = rowsOf([task({ completionAnchors: ["OOS-001"] })]);
    expect(rows[0]?.verdict).toMatchObject({ kind: "excluded-requirement", entry: { id: "OOS-001" } });
    expect(claimSeverity(rows[0]!.verdict)).toBe("CRITICAL");
  });

  it("separates declaring no artifacts from modifying no files", () => {
    const declaredNothing = rowsOf([task({ declaredFiles: [], modifiedFiles: [] })]);
    expect(declaredNothing.rows[0]?.verdict).toMatchObject({ kind: "not-declared" });

    const modifiedNothing = rowsOf([task({ declaredFiles: ["src/a.ts"], modifiedFiles: [] })]);
    expect(modifiedNothing.rows[0]?.verdict).toMatchObject({ kind: "not-implemented" });
  });

  it("reports drift when the Requirement text changed since the claim was made", () => {
    const stale = new Map<string, SpecContentHash>([["FR-001", "0".repeat(64) as SpecContentHash]]);
    const { rows } = rowsOf([task({ anchorHashes: stale })]);
    expect(rows[0]?.verdict).toMatchObject({
      kind: "candidate-pass",
      drift: { kind: "drifted", recorded: "0".repeat(64) },
    });
    expect(claimSeverity(rows[0]!.verdict)).toBe("MEDIUM");
  });

  it("reports unverifiable drift rather than stable when no hash was recorded", () => {
    const { rows } = rowsOf([task({ anchorHashes: null })]);
    expect(rows[0]?.verdict).toMatchObject({ kind: "candidate-pass", drift: { kind: "unverifiable" } });
    // The distinction is the whole point: a graph with no recorded hash has not
    // proven the text is unchanged, and must never render as though it had.
    expect(claimVerdictMessage(rows[0]!.verdict)).toContain("unverifiable");
    expect(claimVerdictMessage(rows[0]!.verdict)).not.toContain("unchanged");
  });

  it("emits rows only for the current Wave but counts claims from every Wave", () => {
    const coverage = rowsOf([
      task({ id: "T1", inCurrentWave: true, completionAnchors: ["FR-001"] }),
      task({ id: "T2", inCurrentWave: false, completionAnchors: ["FR-002"] }),
    ]);
    expect(coverage.rows.map(({ taskId }) => taskId)).toEqual(["T1"]);
    // FR-002 is claimed by a later Wave, so it is planned — not unclaimed.
    expect(coverage.unclaimed).toEqual([]);
  });

  it("names Functional Requirements no Task in the graph claims", () => {
    const coverage = rowsOf([task({ completionAnchors: ["FR-001"] })]);
    expect(coverage.unclaimed).toEqual(["FR-002"]);
  });

  it("carries the typed exclusion list and glossary instead of a grepped section", () => {
    const coverage = rowsOf([task()]);
    expect(coverage.exclusions.map(({ id }) => id)).toEqual(["OOS-001"]);
    expect(coverage.glossary.map(({ term }) => term)).toEqual(["Spec Index"]);
  });

  it("is an honest absence when no Spec Index could be projected", () => {
    const unparsed = parseSpec("# not a specification");
    if (unparsed.ok) throw new Error("fixture must fail to parse");
    const coverage = projectRequirementCoverage(
      { kind: "unavailable", reason: { kind: "unparsed", path: "spec.md", errors: unparsed.errors } },
      [task()],
    );
    expect(coverage.kind).toBe("unavailable");
    const rendered = renderRequirementCoverage(coverage);
    expect(rendered).toContain("UNAVAILABLE");
    expect(rendered).toContain("never a pass");
  });

  it("renders every settled row with its severity so no verdict reaches an operator without text", () => {
    const coverage = projectRequirementCoverage(indexed, [
      task({ id: "T1", completionAnchors: ["FR-001", "FR-404", "OOS-001"] }),
    ]);
    const rendered = renderRequirementCoverage(coverage);
    for (const claim of ["FR-001", "FR-404", "OOS-001"]) expect(rendered).toContain(claim);
    expect(rendered).toContain("CRITICAL");
    expect(rendered).toContain("CANDIDATE");
    expect(rendered).toContain("Assess only `CANDIDATE` rows");
  });

  it("states which Wave made no claims rather than rendering an empty table", () => {
    const rendered = renderRequirementCoverage(
      projectRequirementCoverage(indexed, [task({ completionAnchors: [] })]),
    );
    expect(rendered).toContain("make no Requirement Completion Claims");
  });
});

describe("recordedAnchorHashes", () => {
  it("records the entry's own hash, never a re-derived one", () => {
    const recorded = recordedAnchorHashes(index, ["FR-001", "AS-001"]);
    expect(recorded["FR-001"]).toBe(index.frs[0].contentHash);
    expect(recorded["AS-001"]).toBe(index.scenarios[0].contentHash);
  });

  it("omits identifiers the specification does not define", () => {
    // Nothing can be asserted about text that does not exist; the projection
    // reports the identifier itself as `unknown-requirement` instead.
    expect(recordedAnchorHashes(index, ["FR-404"])).toEqual({});
  });

  it("is frozen so a caller cannot backdate a recorded hash", () => {
    expect(Object.isFrozen(recordedAnchorHashes(index, ["FR-001"]))).toBe(true);
  });
});

describe("specIndexUnavailableMessage", () => {
  it("renders every reason", () => {
    expect(specIndexUnavailableMessage({ kind: "no-spec-file" })).toContain("no spec_file");
    expect(specIndexUnavailableMessage({ kind: "unreadable", path: "s.md", reason: "ENOENT" }))
      .toContain("ENOENT");
    const unparsed = parseSpec("# not a specification");
    if (unparsed.ok) throw new Error("fixture must fail to parse");
    expect(specIndexUnavailableMessage({ kind: "unparsed", path: "s.md", errors: unparsed.errors }))
      .toContain("not a canonical specification");
  });
});

describe("CONTEXT.md binding", () => {
  const context = readFileSync(new URL("../../../CONTEXT.md", import.meta.url), "utf8");

  it("binds the living language to the projection's behavior", () => {
    // The same discipline the Spec Index entry carries: the documented terms
    // and the module must not drift from each other, so the claims CONTEXT.md
    // makes are executed here rather than merely written down.
    expect(context).toMatch(/\*\*Requirement Coverage Projection\*\*/u);
    expect(context).toMatch(/\*\*Requirement Content Hash\*\*/u);

    // "Four outcomes are decided by structure alone" — exactly four settled kinds.
    const settledKinds = new Set(
      rowsOf([
        task({ id: "A", completionAnchors: ["FR-404"] }),
        task({ id: "B", completionAnchors: ["OOS-001"] }),
        task({ id: "C", completionAnchors: ["FR-001"], declaredFiles: [], modifiedFiles: [] }),
        task({ id: "D", completionAnchors: ["FR-002"], modifiedFiles: [] }),
      ]).rows.map(({ verdict }) => verdict.kind),
    );
    expect(settledKinds).toEqual(new Set([
      "unknown-requirement", "excluded-requirement", "not-declared", "not-implemented",
    ]));
    for (const kind of settledKinds) expect(kind).not.toBe("candidate-pass");

    // "a Task with no recorded hash yields unverifiable, never stable"
    const noHash = rowsOf([task({ anchorHashes: null })]).rows[0]?.verdict;
    expect(noHash).toMatchObject({ drift: { kind: "unverifiable" } });

    // "an identifier the specification does not define records nothing"
    expect(recordedAnchorHashes(index, ["FR-404"])).toEqual({});
  });
});
