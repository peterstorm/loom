import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseSpec, type ParsedSpec } from "../src/core/parse-spec";
import {
  projectRequirementCoverage,
  renderRequirementCoverage,
  type CoverageTask,
  type RecordedHash,
  type SpecIndexAvailability,
} from "../src/core/requirement-coverage";

/**
 * Binds `commands/spec-check.md` to the projection it consumes, on the model of
 * `spec-template-contract.test.ts` binding `commands/specify.md` to the parser.
 *
 * The command file is a hand-written mirror of a typed union that `tsc` cannot
 * see and no other test reads. Three of this feature's shipped defects were the
 * same shape — the command instructing the Agent to use something the renderer
 * never emits — and every one of them would have failed here.
 */

const command = readFileSync(new URL("../../commands/spec-check.md", import.meta.url), "utf8");

const specSource = `# Feature: Contract

## User Scenarios

### US1: [P1] Bind the command to the projection

**Acceptance Scenarios:**
- AS-001: Given a claim, When the gate runs, Then a verdict exists
- AS-002: Given no claim, When the gate runs, Then the scenario is listed

## Functional Requirements

- FR-001: System MUST render what the command tells the Agent to read
- FR-002: System MUST name every unclaimed identifier

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

const task = (overrides: Partial<CoverageTask> = {}): CoverageTask => Object.freeze({
  id: "T1",
  inCurrentWave: true,
  completionAnchors: ["FR-001"],
  declaredFiles: ["src/a.ts"],
  modifiedFiles: ["src/a.ts"],
  anchorHashes: new Map<string, RecordedHash>(),
  ...overrides,
});

/** Every verdict class in one projection, so the render covers the union. */
const everyVerdict = () => projectRequirementCoverage(indexed, [
  task({ id: "T1", completionAnchors: ["FR-001"] }),
  task({ id: "T2", completionAnchors: ["FR-404"] }),
  task({ id: "T3", completionAnchors: ["OOS-001"] }),
  task({ id: "T4", completionAnchors: ["AS-001"], declaredFiles: [], modifiedFiles: [] }),
  task({ id: "T5", completionAnchors: ["AS-002"], modifiedFiles: [] }),
]);

const unavailable = () => {
  const parsed = parseSpec("# not a specification");
  if (parsed.ok) throw new Error("fixture must fail to parse");
  return projectRequirementCoverage(
    { kind: "unavailable", reason: { kind: "unparsed", path: "spec.md", errors: parsed.errors } },
    [task()],
  );
};

describe("commands/spec-check.md is bound to the projection it consumes", () => {
  it("reads the section label the renderer is published under", () => {
    // If the packet section were renamed, the command's decoder would silently
    // find nothing and the Agent would proceed with no projection at all.
    expect(command).toContain('entry.label === "requirement-coverage"');
  });

  it("names both column headings the renderer emits and the command depends on", () => {
    const rendered = renderRequirementCoverage(everyVerdict());
    expect(rendered).toContain("| Task | Claim | Decided by | Severity | Requirement | Detail |");
    // Step 2 and Step 4 both branch on `Decided by`; Step 4 reads `Requirement`.
    expect(command).toContain("Decided by");
    expect(command).toContain("`Requirement` column");
  });

  it("only ever labels a row with a decider the renderer can produce", () => {
    const rendered = renderRequirementCoverage(everyVerdict());
    for (const decider of ["engine", "agent"]) expect(rendered).toContain(`| ${decider} |`);
    // The command must not invent a third bucket for the Agent to sort into.
    for (const stale of ["| projection |", "| assessed |"]) expect(command).not.toContain(stale);
  });

  it("only ever names a severity the renderer can produce", () => {
    const rendered = renderRequirementCoverage(everyVerdict());
    const severities = new Set(
      rendered.split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| Task |") && !line.startsWith("|---"))
        .map((line) => line.split(" | ")[3]),
    );
    expect(severities.size).toBeGreaterThan(0);
    for (const severity of severities) {
      expect(["CRITICAL", "MEDIUM", "NONE"]).toContain(severity);
    }
    // `CANDIDATE` was the severity that conflated settlement with badness.
    expect(command).not.toContain("CANDIDATE");
  });

  it("does not tell the Agent to read anything the projection omits", () => {
    const rendered = renderRequirementCoverage(everyVerdict());
    // Requirement text: Step 4 says the row carries it.
    expect(rendered).toContain("System MUST render what the command tells the Agent to read");
    // The unclaimed rosters Step 4 and Step 5 iterate.
    expect(rendered).toContain("Functional Requirements whose completion no Task claims");
    expect(rendered).toContain("Acceptance Scenarios whose completion no Task claims");
    expect(command).toContain("Acceptance Scenarios whose completion no Task claims");
    // The typed lists Steps 6 and 7 consume.
    expect(rendered).toContain("### Out of Scope (typed exclusion list)");
    expect(rendered).toContain("### Glossary (typed terms)");
  });

  it("gives every step a stated fallback for the Unprojected path", () => {
    // The defect this pins: Steps 6 and 7 forbade grepping while the
    // UNAVAILABLE render carried neither list, so both checks went dark.
    const unavailableText = renderRequirementCoverage(unavailable());
    expect(unavailableText).not.toContain("### Glossary (typed terms)");
    expect(unavailableText).not.toContain("### Out of Scope (typed exclusion list)");
    const steps = command.slice(command.indexOf("### Step 2"));
    for (const step of ["### Step 2", "### Step 5", "### Step 6", "### Step 7"]) {
      const body = steps.slice(steps.indexOf(step), steps.indexOf(step) + 1400);
      expect(body, `${step} must state an Unprojected fallback`).toContain("**Unprojected:**");
    }
  });

  it("states the settled floor the engine actually enforces", () => {
    const rendered = renderRequirementCoverage(everyVerdict());
    expect(rendered).toContain("Your report may not fall below this count");
    expect(command).toContain("may never fall below the projection's stated settled floor");
  });
});
