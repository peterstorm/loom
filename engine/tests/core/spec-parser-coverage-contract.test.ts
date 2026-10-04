import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSpec, specParseErrorMessage } from "../../src/core/parse-spec";
import {
  projectRequirementCoverage,
  settledFloorOf,
  type CoverageTask,
} from "../../src/core/requirement-coverage";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../src/core/spec-check";
import { projectSpecBytes } from "../../src/orchestration/spec-index-observation";

const canonicalSpec = [
  "## User Scenarios",
  "**Acceptance Scenarios:**",
  "- AS-001: Given valid input, When parsed, Then retain its full body",
  "",
  "## Functional Requirements",
  "- FR-001: System MUST retain the full Requirement body",
  "",
  "## Out of Scope",
  "- OOS-001: Semantic source indexing",
  "",
  "## Appendix: Glossary",
  "| Term | Definition |",
  "| --- | --- |",
  "| Spec Index | The parsed structural entries |",
].join("\n");

const tasks: readonly CoverageTask[] = [{
  id: "T1",
  inCurrentWave: true,
  decisionRecord: false,
  completionAnchors: ["FR-001", "AS-001"],
  contributions: [],
  declaredFiles: ["src/parser.ts"],
  modifiedFiles: ["src/parser.ts"],
  anchorHashes: new Map(),
}];
const path = "spec.md";
const zeroCriticalReport = parseSpecCheckOutput([
  "SPEC_CHECK_WAVE: 1",
  "SPEC_CHECK_CRITICAL_COUNT: 0",
  "SPEC_CHECK_HIGH_COUNT: 0",
  "SPEC_CHECK_VERDICT: PASSED",
].join("\n"));

const matrix = (["FR", "AS", "OOS"] as const).flatMap((family) => ([
  { indentation: "two spaces", indent: "  " },
  { indentation: "four spaces", indent: "    " },
  { indentation: "tab", indent: "\t" },
  { indentation: "mixed", indent: " \t" },
] as const).flatMap((indentation) => ([
  { separation: "adjacent", gap: "\n" },
  { separation: "blank-separated", gap: "\n\n" },
] as const).map((separation) => ({ family, ...indentation, ...separation }))));

describe("Spec parser to Requirement Coverage settlement contract", () => {
  it("settles a canonical fully claimed spec at zero structural CRITICAL findings", () => {
    const parsed = parseSpec(canonicalSpec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("canonical contract fixture must parse");
    const availability = projectSpecBytes(path, Buffer.from(canonicalSpec, "utf8"));
    expect(availability).toMatchObject({ kind: "indexed", path, index: parsed.value });
    const coverage = projectRequirementCoverage(availability, tasks);
    expect(coverage).toMatchObject({ kind: "projected", unclaimed: [], unclaimedScenarios: [] });
    const floor = settledFloorOf(coverage);
    expect(floor).toEqual({ kind: "settled", count: 0, criticalFindings: [] });
    expect(reconcileSpecCheck(zeroCriticalReport, 1, "now", floor).kind).toBe("captured");
  });

  it.each(matrix)(
    "makes nested $family / $indentation / $separation unavailable, never zero-critical settled",
    ({ family, indent, gap }) => {
      const nested = `${indent}- ${family}-009: must not vanish into a zero-critical projection`;
      const malformed = canonicalSpec.replace(new RegExp(`(- ${family}-001:[^\\n]*)`, "u"), `$1${gap}${nested}`);
      const bytes = Buffer.from(malformed, "utf8");
      const contentDigest = createHash("sha256").update(bytes).digest("hex");
      const line = malformed.split("\n").indexOf(nested) + 1;
      const section = { FR: "Functional Requirements", AS: "Acceptance Scenarios", OOS: "Out of Scope" }[family];
      const expectedErrors = [{ kind: "entry-not-canonical", section, line }];
      const expectedReason = { kind: "unparsed", path, contentDigest, errors: expectedErrors };

      // Run the bytes-backed production chain even if direct parsing regresses;
      // the decisive assertion observes settlement authority, not a test-made Left.
      const parsed = parseSpec(malformed);
      const availability = projectSpecBytes(path, bytes);
      const coverage = projectRequirementCoverage(availability, tasks);
      const floor = settledFloorOf(coverage);
      expect(floor).toMatchObject({
        kind: "unprojected",
        reason: expect.stringContaining(`${section} line ${line}`),
      });
      expect(parsed).toEqual({ ok: false, errors: expectedErrors });
      expect(availability).toEqual({ kind: "unavailable", reason: expectedReason });
      expect(coverage).toEqual({ kind: "unavailable", reason: expectedReason });
      if (parsed.ok) throw new Error("nested structural ID unexpectedly indexed");
      expect(floor).toEqual({
        kind: "unprojected",
        reason: `spec file ${path} is not a canonical specification: ${parsed.errors.map(specParseErrorMessage).join("; ")}`,
      });
      expect(reconcileSpecCheck(zeroCriticalReport, 1, "now", floor)).toMatchObject({
        kind: "evidence-failed",
        specCheck: { verdict: "EVIDENCE_CAPTURE_FAILED", cause: "projection-unavailable" },
      });
    },
  );
});
