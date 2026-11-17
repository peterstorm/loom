/**
 * Regression attribution (ADR-0080): a failure in a test file that only
 * unsettled sibling Tasks of the Wave declare is theirs to fix, not the
 * settling Task's. Everything else still counts.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  attributeRegressionFailures,
  regressionScope,
  WHOLE_RUN_SCOPE,
  type RegressionScope,
} from "../../src/core/regression-attribution";
import { resolveTestEvidence } from "../../src/core/implementation-evidence";
import { AGENT_COMMAND_EVIDENCE } from "../../src/core/test-evidence-policy";
import { AGENT_COMMAND_ORIGIN, type Evidence } from "../../src/machine/types";
import type { TaskStatus } from "../../src/types";
import type { TestFileResult } from "../../src/core/red-then-green-types";
import { failing, passing, report } from "../fixtures/red-then-green-status-fixtures";

const ROOT = "/repo";
const OWN_TEST = "tests/own.test.ts";
const T25_TEST = "tests/dags.test.ts";
const SEALED_TEST = "lib/__tests__/sources.test.ts";
const SCOPE: RegressionScope = {
  kind: "attributed",
  owners: new Map([[T25_TEST, ["T25"]], ["dags/lead-scoring/dag.ts", ["T25"]]]),
  repositoryRoot: ROOT,
};

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
  it("excuses failures only in files unsettled siblings declare, when this Task's tests ran and passed", () => {
    expect(attributeRegressionFailures(run([failing(T25_TEST), passing(OWN_TEST)]), SCOPE)).toEqual({
      kind: "foreign-only",
      foreign: [{ file: T25_TEST, owners: ["T25"] }],
    });
  });

  it("matches a reported absolute path inside the repository to its declared file", () => {
    expect(attributeRegressionFailures(run([failing(`${ROOT}/${T25_TEST}`), passing(OWN_TEST)]), SCOPE).kind)
      .toBe("foreign-only");
  });

  it.each<[string, TestFileResult[]]>([
    ["a failure in a file no unsettled sibling declares (this Task broke a settled or sealed test)", [failing(T25_TEST), failing(SEALED_TEST), passing(OWN_TEST)]],
    ["a failure in this Task's own test file", [failing(OWN_TEST), failing(T25_TEST)]],
    // A JUnit collection error carries its failing synthetic testcase.
    ["a collection error outside the foreign files", [failing(T25_TEST), passing("tests/helper.test.ts"), { ...failing(OWN_TEST), collectionError: true }]],
    ["no test outside the foreign files ran", [failing(T25_TEST)]],
    ["only skipped tests outside the foreign files", [failing(T25_TEST), { ...passing(OWN_TEST), skipped: 2 }]],
  ])("keeps the failure on the settling Task for %s", (_label, results) => {
    expect(attributeRegressionFailures(run(results), SCOPE).kind).toBe("stands");
  });

  it("keeps the failure without recorded per-file results or under the whole-run scope", () => {
    expect(attributeRegressionFailures(unrecordedRun(), SCOPE).kind).toBe("stands");
    expect(attributeRegressionFailures(run([failing(T25_TEST), passing(OWN_TEST)]), WHOLE_RUN_SCOPE).kind).toBe("stands");
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
      const attribution = attributeRegressionFailures(run(results), SCOPE);
      if (outsideFailed) expect(attribution.kind).toBe("stands");
    }));
  });
});

describe("resolveTestEvidence with a regression scope", () => {
  const verdictOf = (events: readonly Evidence[], scope: RegressionScope) =>
    resolveTestEvidence(events, AGENT_COMMAND_EVIDENCE, "", false, false, scope);

  it("turns a failure owned entirely by unsettled siblings into this Task's trusted pass, naming the owners", () => {
    const resolved = verdictOf([run([failing(T25_TEST), passing(OWN_TEST)])], SCOPE);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
    expect(resolved.evidence).toContain("failures attributed to unsettled Tasks: tests/dags.test.ts (T25)");
  });

  it("keeps the whole-run failure under the whole-run scope", () => {
    expect(verdictOf([run([failing(T25_TEST), passing(OWN_TEST)])], WHOLE_RUN_SCOPE).result).toEqual({ verdict: "trusted-fail" });
  });

  it("judges only the last trusted run: an earlier attributable failure does not survive a later real one", () => {
    const resolved = verdictOf([
      run([failing(T25_TEST), passing(OWN_TEST)]),
      run([failing(OWN_TEST), passing(T25_TEST)]),
    ], SCOPE);
    expect(resolved.result).toEqual({ verdict: "trusted-fail" });
  });

  it("demotes an attributed pass like any pass when files change after it", () => {
    const resolved = verdictOf([
      run([failing(T25_TEST), passing(OWN_TEST)]),
      { kind: "FileWrite", path: "src/own.ts", via: "tool" },
    ], SCOPE);
    expect(resolved.result.verdict).toBe("untrusted");
  });
});

describe("regressionScope", () => {
  const task = (id: string, wave: number, status: TaskStatus, file_list: readonly string[]) => ({ id, wave, status, file_list });
  const T28 = task("T28", 5, "pending", ["tests/snapshot-parity.test.ts"]);
  const ownersOf = (scope: RegressionScope) => (scope.kind === "attributed" ? [...scope.owners] : []);

  it("maps the files of every other unsettled Task of the Wave to its Tasks", () => {
    const scope = regressionScope([
      T28,
      task("T25", 5, "pending", [T25_TEST]),
      task("T27", 5, "failed", ["tests/retry.test.ts"]),
      task("T26", 5, "implemented", ["tests/support/workbooks.ts"]),
      task("T6", 2, "completed", [SEALED_TEST]),
      task("T13", 6, "pending", ["docs/adr/0021.md"]),
    ], T28, ROOT);
    expect(ownersOf(scope)).toEqual([[T25_TEST, ["T25"]], ["tests/retry.test.ts", ["T27"]]]);
  });

  it("names every unsettled sibling that declares a file", () => {
    const scope = regressionScope([T28, task("T25", 5, "pending", [T25_TEST]), task("T29", 5, "pending", [T25_TEST])], T28, ROOT);
    expect(ownersOf(scope)).toEqual([[T25_TEST, ["T25", "T29"]]]);
  });

  it("never attributes a file the settling Task declares itself, even when a sibling declares it too", () => {
    const settling = task("T28", 5, "pending", [T25_TEST]);
    const scope = regressionScope([settling, task("T25", 5, "pending", [T25_TEST])], settling, ROOT);
    expect(scope).toEqual(WHOLE_RUN_SCOPE);
    expect(attributeRegressionFailures(run([failing(T25_TEST), passing(OWN_TEST)]), scope).kind).toBe("stands");
  });

  it("is the whole-run scope when no unsettled sibling declares a file", () => {
    expect(regressionScope([T28, task("T26", 5, "implemented", [T25_TEST])], T28, ROOT)).toEqual(WHOLE_RUN_SCOPE);
  });
});
