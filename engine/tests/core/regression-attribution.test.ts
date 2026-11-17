/**
 * Regression attribution (loom#199, Cause 1): a failure in a test file that
 * another in-flight Task of the Wave owns is that Task's to fix, not the
 * settling Task's. Everything else still counts.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  attributeRegressionFailures,
  foreignTestOwners,
  NO_FOREIGN_OWNERS,
  type ForeignTestOwners,
} from "../../src/core/regression-attribution";
import { resolveTestEvidence, WHOLE_RUN_SCOPE } from "../../src/core/implementation-evidence";
import { AGENT_COMMAND_EVIDENCE } from "../../src/core/test-evidence-policy";
import { AGENT_COMMAND_ORIGIN, type Evidence } from "../../src/machine/types";
import type { TestFileResult } from "../../src/core/red-then-green-types";
import { failing, passing, report } from "../fixtures/red-then-green-status-fixtures";

const ROOT = "/repo";
const OWN_TEST = "tests/own.test.ts";
const T25_TEST = "tests/dags.test.ts";
const SEALED_TEST = "lib/__tests__/sources.test.ts";
const OWNERS: ForeignTestOwners = new Map([[T25_TEST, "T25"], ["dags/lead-scoring/dag.ts", "T25"]]);

type TestRunFact = Extract<Evidence, { kind: "TestRun" }>;
const run = (results: readonly TestFileResult[], exit = results.some((r) => r.failed > 0) ? 1 : 0): TestRunFact => ({
  kind: "TestRun",
  origin: AGENT_COMMAND_ORIGIN,
  command: "bun test --reporter=junit --reporter-outfile=/tmp/r.xml",
  exit,
  report: report(results),
});
const unrecordedRun = (): TestRunFact => ({ ...run([failing(T25_TEST), passing(OWN_TEST)]), report: { ...report([passing(OWN_TEST)]), files: { kind: "unrecorded" } } as TestRunFact["report"] });

describe("attributeRegressionFailures", () => {
  it("excuses failures only in files another in-flight Task owns, when this Task's tests ran and passed", () => {
    expect(attributeRegressionFailures(run([failing(T25_TEST), passing(OWN_TEST)]), OWNERS, ROOT)).toEqual({
      kind: "foreign-only",
      foreign: [{ file: T25_TEST, owner: "T25" }],
    });
  });

  it("matches a reported absolute path inside the repository to its declared file", () => {
    expect(attributeRegressionFailures(run([failing(`${ROOT}/${T25_TEST}`), passing(OWN_TEST)]), OWNERS, ROOT).kind)
      .toBe("foreign-only");
  });

  it.each<[string, TestFileResult[]]>([
    ["a failure in a file no in-flight Task owns (this Task broke a settled or sealed test)", [failing(T25_TEST), failing(SEALED_TEST), passing(OWN_TEST)]],
    ["a failure in this Task's own test file", [failing(OWN_TEST), failing(T25_TEST)]],
    // A JUnit collection error carries its failing synthetic testcase.
    ["a collection error outside the foreign files", [failing(T25_TEST), passing("tests/helper.test.ts"), { ...failing(OWN_TEST), collectionError: true }]],
    ["no test outside the foreign files ran", [failing(T25_TEST)]],
    ["only skipped tests outside the foreign files", [failing(T25_TEST), { ...passing(OWN_TEST), skipped: 2 }]],
  ])("keeps the failure on the settling Task for %s", (_label, results) => {
    expect(attributeRegressionFailures(run(results), OWNERS, ROOT).kind).toBe("stands");
  });

  it("keeps the failure without recorded per-file results or without other in-flight owners", () => {
    expect(attributeRegressionFailures(unrecordedRun(), OWNERS, ROOT).kind).toBe("stands");
    expect(attributeRegressionFailures(run([failing(T25_TEST), passing(OWN_TEST)]), NO_FOREIGN_OWNERS, ROOT).kind).toBe("stands");
  });

  it("never excuses a run in which a file outside the foreign set failed (property)", () => {
    const file = fc.constantFrom(OWN_TEST, T25_TEST, SEALED_TEST, "tests/other.test.ts");
    // A JUnit collection error always carries a failing synthetic testcase.
    const result = fc.record({ file, failed: fc.integer({ min: 0, max: 2 }), collectionError: fc.boolean() })
      .map(({ file: f, failed, collectionError }): TestFileResult =>
        ({ file: f, executed: 2, failed: collectionError ? Math.max(failed, 1) : failed, skipped: 0, collectionError }));
    // A reconciled report names each file once.
    fc.assert(fc.property(fc.uniqueArray(result, { minLength: 1, maxLength: 4, selector: (r) => r.file }), (results) => {
      const outsideFailed = results.some((r) => r.file !== T25_TEST && (r.failed > 0 || r.collectionError));
      const attribution = attributeRegressionFailures(run(results), OWNERS, ROOT);
      if (outsideFailed) expect(attribution.kind).toBe("stands");
    }));
  });
});

describe("resolveTestEvidence with a regression scope", () => {
  const verdictOf = (events: readonly Evidence[], scoped: boolean) =>
    resolveTestEvidence(events, AGENT_COMMAND_EVIDENCE, "", false, false, scoped ? { owners: OWNERS, repositoryRoot: ROOT } : WHOLE_RUN_SCOPE);

  it("turns a failure owned entirely by another in-flight Task into this Task's trusted pass, naming the owner", () => {
    const resolved = verdictOf([run([failing(T25_TEST), passing(OWN_TEST)])], true);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
    expect(resolved.evidence).toContain("failures attributed to in-flight Tasks: tests/dags.test.ts (T25)");
  });

  it("keeps the whole-run failure without a scope, as before", () => {
    expect(verdictOf([run([failing(T25_TEST), passing(OWN_TEST)])], false).result).toEqual({ verdict: "trusted-fail" });
  });

  it("demotes an attributed pass like any pass when files change after it", () => {
    const resolved = verdictOf([
      run([failing(T25_TEST), passing(OWN_TEST)]),
      { kind: "FileWrite", path: "src/own.ts", via: "tool" },
    ], true);
    expect(resolved.result.verdict).toBe("untrusted");
  });
});

describe("foreignTestOwners", () => {
  const task = (id: string, wave: number, status: string, file_list: readonly string[]) => ({ id, wave, status, file_list });

  it("maps the files of every other not-yet-settled Task of the Wave to its Task", () => {
    const owners = foreignTestOwners([
      task("T28", 5, "pending", ["tests/snapshot-parity.test.ts"]),
      task("T25", 5, "pending", [T25_TEST]),
      task("T26", 5, "implemented", ["tests/support/workbooks.ts"]),
      task("T6", 2, "completed", [SEALED_TEST]),
      task("T13", 6, "pending", ["docs/adr/0021.md"]),
    ], "T28", 5);
    expect([...owners]).toEqual([[T25_TEST, "T25"]]);
  });
});
