/**
 * Ledger read-back of per-file TestRun results (G4 slice 2, FR-003, FR-004).
 *
 * `parseEvidenceLine` is the ledger's one line parser; its `report` field is
 * re-minted through `parseReportSummary`, so per-file results are parsed (not
 * passed through), legacy lines read as unrecorded, and anything malformed or
 * unreconciled makes the report null while the TestRun fact stays readable.
 */

import { describe, expect, it } from "vitest";
import type { TestFileResult } from "../../src/core/red-then-green-types";
import { parseReportSummary } from "../../src/core/structured-test-report";
import { parseEvidenceLine } from "../../src/machine/evidence";
import type { Evidence } from "../../src/machine/types";

const result = (file: string, executed: number, failed: number, collectionError = false): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError });

const RESULTS: readonly TestFileResult[] = [
  result("tests/broken.test.ts", 1, 1, true),
  result("tests/green.test.ts", 2, 0),
  result("tests/red.test.ts", 2, 1),
];

const line = (report: unknown, command = "npx vitest run"): string =>
  JSON.stringify({ epoch: "agent-1:code-implementer-agent", event: { kind: "TestRun", command, exit: 1, report } });

function testRun(raw: string): Extract<Evidence, { kind: "TestRun" }> {
  const parsed = parseEvidenceLine(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.value.event.kind !== "TestRun") throw new Error("not a TestRun");
  return parsed.value.event;
}

describe("TestRun per-file read-back", () => {
  it("AS-001: a recorded summary round-trips through the ledger line byte-for-byte", () => {
    const summary = parseReportSummary(5, 2, "junit-xml", { kind: "recorded", results: RESULTS });
    const written = line(summary);
    const run = testRun(written);
    expect(run.report?.files).toEqual({ kind: "recorded", results: RESULTS });
    expect(line(run.report)).toBe(written);
  });

  it("AS-003: a legacy line reads as unrecorded and re-serializes to the exact legacy bytes", () => {
    const legacy = line({ total: 5, failed: 2, source: "junit-xml" });
    const run = testRun(legacy);
    expect(run.report).toMatchObject({ total: 5, failed: 2, source: "junit-xml" });
    expect(run.report?.files).toEqual({ kind: "unrecorded" });
    expect(line(run.report)).toBe(legacy);
  });

  it("FR-004: an explicitly unrecorded files field reads like a legacy line", () => {
    const run = testRun(line({ total: 3, failed: 0, source: "vitest-json", files: { kind: "unrecorded" } }));
    expect(run.report?.files).toEqual({ kind: "unrecorded" });
  });

  it("AS-002: malformed, unreconciled or over-specified per-file results null the report, never the fact", () => {
    const bad: readonly unknown[] = [
      { kind: "recorded", results: RESULTS, origin: "agent" },
      { kind: "recorded", results: [...RESULTS.slice(0, 2), { ...result("tests/red.test.ts", 2, 1), path: "/x" }] },
      { kind: "recorded", results: RESULTS.slice(0, 2) },
      // sums agree, but a JUnit collection error with no failing testcase is impossible
      { kind: "recorded", results: [result("tests/broken.test.ts", 1, 0, true), result("tests/green.test.ts", 2, 0), result("tests/red.test.ts", 2, 2)] },
      { kind: "unrecorded", results: [] },
      [],
      7,
    ];
    for (const files of bad) {
      const run = testRun(line({ total: 5, failed: 2, source: "junit-xml", files }, "npm test"));
      expect(run.command, JSON.stringify(files)).toBe("npm test");
      expect(run.exit).toBe(1);
      expect(run.report, JSON.stringify(files)).toBeNull();
    }
  });

  it("AS-002: the existing count checks still apply before per-file results are considered", () => {
    for (const counts of [{ total: 1, failed: 2 }, { total: -1, failed: 0 }, { total: "5", failed: 2 }]) {
      expect(testRun(line({ ...counts, source: "junit-xml" })).report).toBeNull();
    }
    expect(testRun(line({ total: 5, failed: 2, source: "tap", files: { kind: "recorded", results: RESULTS } })).report).toBeNull();
  });
});
