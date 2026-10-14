/**
 * The Acceptance Stop Check's pure core (G4 slice 1): what a claimant owes at
 * its stop, and the verdict one runner report gives. Only an owed testcase not
 * passing blocks; anything the report cannot show is unobservable.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  judgeStopCheck,
  renderStopCheckBlock,
  stopCheckExpectation,
  type AcceptanceContract,
  type AcceptanceTestcase,
} from "../../src/core/acceptance-contract";
import type { ReportTestcase } from "../../src/core/structured-test-report";
import { contract, frozenPaths, surface, task } from "../fixtures/contract-status-fixtures";
import { digest } from "../fixtures/acceptance-fixtures";

const SURFACE = surface("payload");
const roster: readonly [AcceptanceTestcase, ...AcceptanceTestcase[]] = [
  { file: SURFACE.acceptance, name: "AS-001: one valid call wins", anchors: ["AS-001"] },
  { file: SURFACE.acceptance, name: "AS-002: a second call is refused", anchors: ["AS-002"] },
];
const frozen = (): AcceptanceContract => contract({
  id: "CT-1", surface: SURFACE, anchors: ["AS-001", "AS-002"],
  freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster },
});

const contractTask = task("T1", 1, [SURFACE.types, SURFACE.acceptance]);
const report = (cases: readonly ReportTestcase[]) => ({ ok: true as const, value: cases });
const testcase = (name: string, outcome: ReportTestcase["outcome"]): ReportTestcase =>
  ({ classname: SURFACE.acceptance, name, outcome, failureType: outcome === "failed" ? "AssertionError" : null });
const REPORT_DIGEST = digest("e");

describe("stopCheckExpectation", () => {
  it("owes a claimant every frozen testcase it claims that is due by its Wave", () => {
    const claimant = task("T2", 2, ["src/payload.ts"], ["AS-001", "AS-002"]);
    const check = stopCheckExpectation([frozen()], [contractTask, claimant], claimant);
    expect(check).toMatchObject({ kind: "owed", files: [SURFACE.acceptance], owed: [{ contractId: "CT-1", testcases: roster }] });
  });

  it("owes nothing for an anchor a later Task also claims, which is not yet due", () => {
    const early = task("T2", 2, ["src/a.ts"], ["AS-001", "AS-002"]);
    const later = task("T3", 3, ["src/b.ts"], ["AS-002"]);
    const check = stopCheckExpectation([frozen()], [contractTask, early, later], early);
    expect(check).toMatchObject({ kind: "owed", owed: [{ testcases: [roster[0]] }] });
  });

  it("is none for a non-claimant, the contract Task, and a contract not yet frozen", () => {
    const bystander = task("T2", 2, ["src/other.ts"]);
    expect(stopCheckExpectation([frozen()], [contractTask, bystander], bystander)).toEqual({ kind: "none" });
    expect(stopCheckExpectation([frozen()], [contractTask], contractTask)).toEqual({ kind: "none" });
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    const claimant = task("T2", 2, ["src/a.ts"], ["AS-001"]);
    expect(stopCheckExpectation([awaiting], [contractTask, claimant], claimant)).toEqual({ kind: "none" });
  });
});

describe("judgeStopCheck", () => {
  const claimant = task("T2", 2, ["src/payload.ts"], ["AS-001", "AS-002"]);
  const check = (() => {
    const owed = stopCheckExpectation([frozen()], [contractTask, claimant], claimant);
    if (owed.kind !== "owed") throw new Error("fixture must owe");
    return owed;
  })();

  it("passes when every owed testcase passed", () => {
    expect(judgeStopCheck(check, REPORT_DIGEST, report(roster.map(({ name }) => testcase(name, "passed"))))).toEqual({ kind: "passed" });
  });

  it("names a failed owed testcase with its failure type, and one that did not run", () => {
    const verdict = judgeStopCheck(check, REPORT_DIGEST, report([testcase(roster[0].name, "failed")]));
    expect(verdict).toEqual({
      kind: "failing",
      testcases: [
        { contractId: "CT-1", file: SURFACE.acceptance, name: roster[0].name, outcome: { kind: "failed", failureType: "AssertionError" } },
        { contractId: "CT-1", file: SURFACE.acceptance, name: roster[1].name, outcome: { kind: "did-not-run" } },
      ],
    });
  });

  it("names a skipped owed testcase as skipped, not failed", () => {
    const verdict = judgeStopCheck(check, REPORT_DIGEST, report([testcase(roster[0].name, "skipped"), testcase(roster[1].name, "passed")]));
    expect(verdict).toEqual({
      kind: "failing",
      testcases: [{ contractId: "CT-1", file: SURFACE.acceptance, name: roster[0].name, outcome: { kind: "skipped" } }],
    });
    if (verdict.kind === "failing") expect(renderStopCheckBlock(verdict.testcases, "", 1)).toContain(`'${roster[0].name}' (${SURFACE.acceptance}) — skipped`);
  });

  it("is unobservable when the report ran none of the files, or could not be projected", () => {
    const elsewhere: ReportTestcase = { classname: "tests/other.test.ts", name: "x", outcome: "failed", failureType: "Error" };
    expect(judgeStopCheck(check, REPORT_DIGEST, report([elsewhere]))).toMatchObject({ kind: "unobservable" });
    expect(judgeStopCheck(check, REPORT_DIGEST, { ok: false, error: { kind: "malformed-report", message: "bad xml" } } as never))
      .toMatchObject({ kind: "unobservable", reason: expect.stringContaining("bad xml") });
  });

  it("fails exactly when some owed testcase did not pass, for any outcome mix", () => {
    const outcomes = fc.array(fc.constantFrom<ReportTestcase["outcome"] | "absent">("passed", "failed", "skipped", "absent"), {
      minLength: roster.length, maxLength: roster.length,
    });
    fc.assert(fc.property(outcomes, (mix) => {
      const cases = mix.flatMap((outcome, index) => outcome === "absent" ? [] : [testcase(roster[index]!.name, outcome)]);
      fc.pre(cases.length > 0);
      const verdict = judgeStopCheck(check, REPORT_DIGEST, report(cases));
      expect(verdict.kind).toBe(mix.every((outcome) => outcome === "passed") ? "passed" : "failing");
    }));
  });
});

describe("renderStopCheckBlock", () => {
  it("tells the agent what still fails, that frozen files are read-only, and how many blocks remain", () => {
    const text = renderStopCheckBlock(
      [{ contractId: "CT-1", file: SURFACE.acceptance, name: roster[0].name, outcome: { kind: "failed", failureType: "AssertionError" } }],
      "expected 1 to be 2",
      2,
    );
    expect(text).toContain(`CT-1: '${roster[0].name}' (${SURFACE.acceptance}) — failed (AssertionError)`);
    expect(text).toContain("never edit them");
    expect(text).toContain("at most 2 more time(s)");
    expect(text).toContain("expected 1 to be 2");
  });
});
