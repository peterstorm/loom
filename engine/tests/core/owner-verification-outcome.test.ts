import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyBaseline, classifyMutantRun, verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type { MatrixTestRun } from "../../src/core/owner-verification/types";

/** The matrix test as the plan declares it: repository-relative. */
const MATRIX = "engine/tests/core/rules.matrix.test.ts";
/** The same file as Vitest names it: relative to the runner's cwd (`engine/`). */
const REPORTED = "tests/core/rules.matrix.test.ts";

type Case = Readonly<{ classname: string; name: string; failure?: "AssertionError" | "Error"; skipped?: true }>;

function junit(cases: readonly Case[]): Uint8Array {
  const failures = cases.filter((testcase) => testcase.failure !== undefined).length;
  const skipped = cases.filter((testcase) => testcase.skipped).length;
  const body = cases.map((testcase) => `<testcase classname="${testcase.classname}" name="${testcase.name}">` +
    (testcase.failure === undefined ? "" : `<failure message="failed" type="${testcase.failure}">failed</failure>`) +
    (testcase.skipped ? "<skipped/>" : "") + "</testcase>");
  return new TextEncoder().encode([
    '<?xml version="1.0" encoding="UTF-8" ?>',
    `<testsuites name="vitest tests" tests="${cases.length}" failures="${failures}" errors="0">`,
    `<testsuite name="suite" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}">`,
    ...body,
    "</testsuite>",
    "</testsuites>",
  ].join("\n"));
}

const pass = (name: string, classname = REPORTED): Case => ({ classname, name: `matrix > ${name}` });
const fail = (name: string, classname = REPORTED): Case => ({ classname, name: `matrix > ${name}`, failure: "AssertionError" });
const COLLECTION: Case = { classname: REPORTED, name: REPORTED, failure: "Error" };

const exited = (cases: readonly Case[], exitCode: number | null = cases.some((testcase) => testcase.failure) ? 1 : 0, signal: string | null = null): MatrixTestRun =>
  ({ kind: "exited", exitCode, signal, report: { kind: "produced", bytes: junit(cases) } });

const infrastructure = (kind: string) => ({ kind: "infrastructure", failure: { kind, detail: expect.any(String) } });

describe("classifyMutantRun", () => {
  it("AS-010: a failing non-collection testcase of the matrix test kills the mutant", () => {
    expect(classifyMutantRun(exited([pass("a"), fail("b")]), MATRIX)).toEqual({ kind: "killed" });
    expect(classifyMutantRun(exited([COLLECTION, fail("b")]), MATRIX)).toEqual({ kind: "killed" });
    // The report decides, not the exit code: a failing testcase kills even beside a signal.
    expect(classifyMutantRun(exited([fail("b")], null, "SIGTERM"), MATRIX)).toEqual({ kind: "killed" });
  });

  it("AS-011: a mutant against which every attributed testcase passes, exit 0, survives", () => {
    expect(classifyMutantRun(exited([pass("a"), pass("b")]), MATRIX)).toEqual({ kind: "survived" });
  });

  it("AS-012: only collection or import errors make the mutant invalid, naming them", () => {
    expect(classifyMutantRun(exited([COLLECTION]), MATRIX)).toEqual({ kind: "invalid", collectionErrors: [REPORTED] });
  });

  it("AS-013: a mutant whose run timed out is killed by timeout", () => {
    expect(classifyMutantRun({ kind: "timed-out", elapsedMs: 61_000 }, MATRIX)).toEqual({ kind: "timed-out" });
  });

  it("FR-013: testcases of other files are not attributed: they neither kill nor survive", () => {
    const other = "tests/other.test.ts";
    expect(classifyMutantRun(exited([fail("x", other), pass("a")], 0), MATRIX)).toEqual({ kind: "survived" });
    expect(classifyMutantRun(exited([fail("x", other)]), MATRIX)).toEqual(infrastructure("matrix-test-not-collected"));
  });

  it("FR-016: an absolute classname outside any known root is not attributed", () => {
    expect(classifyMutantRun(exited([pass("a", `/elsewhere/${REPORTED}`)]), MATRIX)).toEqual(infrastructure("matrix-test-not-collected"));
  });

  it("FR-016: a matrix test whose every testcase was skipped never survives", () => {
    const skipped: Case = { classname: REPORTED, name: "matrix > a", skipped: true };
    expect(classifyMutantRun(exited([skipped]), MATRIX)).toEqual(infrastructure("matrix-test-not-collected"));
    expect(classifyBaseline(exited([skipped]), MATRIX)).toEqual(infrastructure("matrix-test-not-collected"));
  });

  it("FR-016: the spawn failure's message rides in the detail", () => {
    expect(classifyMutantRun({ kind: "spawn-failed", message: "ENOENT: bun" }, MATRIX))
      .toEqual({ kind: "infrastructure", failure: { kind: "spawn-failed", detail: expect.stringContaining("ENOENT: bun") } });
  });
});

describe("AD-7 table: every row, mutant and baseline", () => {
  const ROWS: readonly (readonly [string, MatrixTestRun, unknown, unknown])[] = [
    ["process timed out", { kind: "timed-out", elapsedMs: 60_000 }, { kind: "timed-out" }, infrastructure("baseline-timed-out")],
    ["spawn failed", { kind: "spawn-failed", message: "EACCES" }, infrastructure("spawn-failed"), infrastructure("spawn-failed")],
    ["report missing", { kind: "exited", exitCode: 0, signal: null, report: { kind: "missing" } }, infrastructure("report-missing"), infrastructure("report-missing")],
    ["report unreadable", { kind: "exited", exitCode: 0, signal: null, report: { kind: "unreadable", reason: "EISDIR" } }, infrastructure("report-unreadable"), infrastructure("report-unreadable")],
    ["report unparseable", { kind: "exited", exitCode: 1, signal: null, report: { kind: "produced", bytes: new TextEncoder().encode("{}") } }, infrastructure("report-unreadable"), infrastructure("report-unreadable")],
    ["failing non-collection testcase", exited([pass("a"), fail("b")]), { kind: "killed" }, { kind: "red", failures: ["matrix > b"] }],
    ["only collection errors", exited([COLLECTION]), { kind: "invalid", collectionErrors: [REPORTED] }, { kind: "red", failures: [REPORTED] }],
    ["zero attributed testcases", exited([pass("a", "tests/other.test.ts")]), infrastructure("matrix-test-not-collected"), infrastructure("matrix-test-not-collected")],
    ["all pass, exit 0", exited([pass("a"), pass("b")]), { kind: "survived" }, { kind: "green" }],
    ["all pass, non-zero exit", exited([pass("a")], 2), infrastructure("exit-unexplained-by-report"), infrastructure("exit-unexplained-by-report")],
    ["all pass, signal", exited([pass("a")], null, "SIGKILL"), infrastructure("exit-unexplained-by-report"), infrastructure("exit-unexplained-by-report")],
  ];

  it.each(ROWS)("FR-013: FR-016: %s", (_row, run, mutant, baseline) => {
    expect(classifyMutantRun(run, MATRIX)).toEqual(mutant);
    expect(classifyBaseline(run, MATRIX)).toEqual(baseline);
  });

  it("FR-008: a red baseline names every failing testcase, collection errors included", () => {
    expect(classifyBaseline(exited([COLLECTION, fail("b"), pass("c")]), MATRIX)).toEqual({ kind: "red", failures: [REPORTED, "matrix > b"] });
  });
});

describe("verifiedMutationOf", () => {
  const SURVIVOR = { mutantId: "d".repeat(64), operator: "boolean-literal-flip", line: 3, column: 12, original: "true", replacement: "false" } as const;

  it("AS-013: derives generated from killed, timed out, invalid and survivors", () => {
    expect(verifiedMutationOf({ killed: 2, timedOut: 1, invalid: 3, survivors: [SURVIVOR], unmutated: 4, ownerChangedInWave: true }))
      .toEqual({ ok: true, value: { kind: "verified", generated: 7, killed: 2, timedOut: 1, invalid: 3, survivors: [SURVIVOR], unmutated: 4, ownerChangedInWave: true } });
  });

  it("AS-014: an owner changed in the Wave with no mutable construct verifies with zero mutants", () => {
    expect(verifiedMutationOf({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true }))
      .toEqual({ ok: true, value: { kind: "verified", generated: 0, killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true } });
  });

  it("AS-014: an unchanged owner refuses any generated or unmutated mutant", () => {
    expect(verifiedMutationOf({ killed: 0, timedOut: 1, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false }))
      .toEqual({ ok: false, error: { kind: "mutants-without-owner-change", generated: 1, unmutated: 0 } });
    expect(verifiedMutationOf({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 5, ownerChangedInWave: false }))
      .toEqual({ ok: false, error: { kind: "mutants-without-owner-change", generated: 0, unmutated: 5 } });
  });

  it("FR-016: refuses generated mutants that are all invalid: such a run carries no mutation evidence", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 40 }), (invalid, unmutated) => {
      expect(verifiedMutationOf({ killed: 0, timedOut: 0, invalid, survivors: [], unmutated, ownerChangedInWave: true }))
        .toEqual({ ok: false, error: { kind: "no-valid-mutants", generated: invalid } });
    }), { numRuns: 50 });
    expect(verifiedMutationOf({ killed: 0, timedOut: 1, invalid: 3, survivors: [], unmutated: 0, ownerChangedInWave: true }).ok).toBe(true);
    expect(verifiedMutationOf({ killed: 0, timedOut: 0, invalid: 3, survivors: [SURVIVOR], unmutated: 0, ownerChangedInWave: true }).ok).toBe(true);
  });

  it("FR-012: refuses the first count that is not a non-negative integer, in field order", () => {
    expect(verifiedMutationOf({ killed: -1, timedOut: 0.5, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true }))
      .toEqual({ ok: false, error: { kind: "count-not-a-count", field: "killed", value: -1 } });
    expect(verifiedMutationOf({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: Number.POSITIVE_INFINITY, ownerChangedInWave: true }))
      .toEqual({ ok: false, error: { kind: "count-not-a-count", field: "unmutated", value: Number.POSITIVE_INFINITY } });
  });
});
