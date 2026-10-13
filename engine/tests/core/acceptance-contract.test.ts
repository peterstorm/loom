import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ACCEPTANCE_RED_WINDOW,
  acceptanceContractsFromPlan,
  acceptanceExpectation,
  frozenPathDrift,
  frozenPaths,
  judgeAcceptance,
  observeAcceptanceFacts,
  parseAcceptanceContracts,
  parseAcceptanceReportFacts,
  redWindowTaskIds,
  stampAcceptanceFreezes,
  testcaseAcceptanceFile,
  type AcceptanceContract,
  type AcceptanceExpectation,
  type AcceptanceReportFacts,
} from "../../src/core/acceptance-contract";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import type { ReportTestcase } from "../../src/core/structured-test-report";
import type { PlanContract } from "../../src/types";

const digest = (char: string): ArtifactDigest => char.repeat(64) as ArtifactDigest;
const REPORT = digest("e");
const ACCEPTANCE = "engine/tests/acceptance/payload.acceptance.test.ts";
const TYPES = "engine/src/core/payload-contract.ts";

const PLAN_CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Payload ingestion",
  declaration: {
    kind: "declared",
    types: { kind: "file", path: TYPES },
    acceptance: [{ path: ACCEPTANCE, anchors: ["AS-003", "AS-004"] }],
    supportedDomain: ACCEPTANCE,
    statement: "One valid call wins.",
  },
};

// T1 writes the contract in Wave 1; T2 completes AS-003 in Wave 2 and T3
// completes AS-004 in Wave 3; T4 is unrelated work in Wave 4.
const TASKS = [
  { id: "T1", wave: 1, file_list: [TYPES, ACCEPTANCE], spec_anchors: [] },
  { id: "T2", wave: 2, file_list: ["engine/src/core/payload.ts"], spec_anchors: ["AS-003"] },
  { id: "T3", wave: 3, file_list: ["engine/src/core/payload-refusal.ts"], spec_anchors: ["AS-004"] },
  { id: "T4", wave: 4, file_list: ["engine/src/other.ts"], spec_anchors: [] },
] as const;

function contract(freeze: AcceptanceContract["freeze"] = { state: "awaiting-red" }): AcceptanceContract {
  const built = acceptanceContractsFromPlan([PLAN_CONTRACT], TASKS);
  if (!built.ok) throw new Error(built.error.join("; "));
  return { ...built.value[0]!, freeze };
}

const testcase = (name: string, outcome: ReportTestcase["outcome"], failureType: string | null = outcome === "failed" ? "AssertionError" : null, classname = "tests/acceptance/payload.acceptance.test.ts"): ReportTestcase =>
  ({ classname, name, outcome, failureType });

const RED_REPORT: readonly ReportTestcase[] = [
  testcase("plain", "passed", null, "tests/core/other.test.ts"),
  testcase("payload > AS-003: one valid call wins", "failed"),
  testcase("payload > AS-004: a refused call never supplies bytes", "failed", "Error"),
];

const facts = (expectation: AcceptanceExpectation, cases: readonly ReportTestcase[]): AcceptanceReportFacts =>
  observeAcceptanceFacts(expectation, "verify", REPORT, { ok: true, value: cases });

const FROZEN_PATHS = [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("b") }] as const;
const ROSTER = [
  { file: ACCEPTANCE, name: "payload > AS-003: one valid call wins", anchors: ["AS-003"] },
  { file: ACCEPTANCE, name: "payload > AS-004: a refused call never supplies bytes", anchors: ["AS-004"] },
] as const;
const FROZEN: AcceptanceContract["freeze"] = { state: "frozen", wave: 1, paths: FROZEN_PATHS, roster: ROSTER };

describe("acceptanceContractsFromPlan — the contract the graph persists", () => {
  it("names the one Task that writes every frozen path as the contract Task", () => {
    const built = contract();
    expect(built).toMatchObject({ schemaVersion: 1, id: "CT-1", contractTask: "T1", statement: "One valid call wins." });
    expect(frozenPaths(built)).toEqual([TYPES, ACCEPTANCE]);
  });

  it("refuses a malformed declaration or a contract no single Task writes", () => {
    const split = acceptanceContractsFromPlan([PLAN_CONTRACT], [
      { id: "T1", wave: 1, file_list: [TYPES], spec_anchors: [] },
      { id: "T2", wave: 1, file_list: [ACCEPTANCE], spec_anchors: [] },
    ]);
    expect(split).toMatchObject({ ok: false });
    const malformed = acceptanceContractsFromPlan(
      [{ id: "CT-2", title: "X", declaration: { kind: "malformed", problems: [{ kind: "missing-statement" }] } }],
      TASKS,
    );
    expect(malformed).toMatchObject({ ok: false });
  });
});

describe("redWindowTaskIds — the Tasks a red acceptance suite would fail", () => {
  it("covers every Task from the contract Wave through the Wave that completes its last anchor", () => {
    expect([...redWindowTaskIds([contract()], TASKS)].sort()).toEqual(["T1", "T2", "T3"]);
    expect(ACCEPTANCE_RED_WINDOW).toBe("acceptance-red-window");
  });
});

describe("testcaseAcceptanceFile — attributing a JUnit testcase to a declared acceptance file", () => {
  it.each([
    ["a Vitest path relative to the project root", "tests/acceptance/payload.acceptance.test.ts", ACCEPTANCE],
    ["the exact repository path", ACCEPTANCE, ACCEPTANCE],
    ["a Surefire class name", "com.acme.PayloadAcceptanceTest", "svc/src/test/java/com/acme/PayloadAcceptanceTest.java"],
    ["a nested Surefire class", "com.acme.PayloadAcceptanceTest$Refusals", "svc/src/test/java/com/acme/PayloadAcceptanceTest.java"],
  ])("matches %s", (_name, classname, file) => {
    expect(testcaseAcceptanceFile([file], classname)).toBe(file);
  });

  it("never matches a different file that shares a suffix segment", () => {
    expect(testcaseAcceptanceFile([ACCEPTANCE], "load.acceptance.test.ts")).toBeNull();
    expect(testcaseAcceptanceFile([ACCEPTANCE], "tests/core/other.test.ts")).toBeNull();
  });
});

describe("acceptanceExpectation — what each Wave Gate owes a contract", () => {
  it("owes nothing before the contract Wave, RED in it, and GREEN by anchor after it", () => {
    expect(acceptanceExpectation([contract()], TASKS, 1).contracts).toMatchObject([
      { contract: "CT-1", phase: "red", roster: null, dueWave: { "AS-003": 2, "AS-004": 3 } },
    ]);
    expect(acceptanceExpectation([contract(FROZEN)], TASKS, 2).contracts).toMatchObject([
      { contract: "CT-1", phase: "green", roster: ROSTER },
    ]);
  });

  it("fails closed when a later Wave finds a contract whose RED was never observed", () => {
    expect(acceptanceExpectation([contract()], TASKS, 2)).toMatchObject({
      contracts: [],
      unobservable: [{ contract: "CT-1" }],
    });
  });
});

describe("judgeAcceptance — RED in the contract Wave", () => {
  const expectation = acceptanceExpectation([contract()], TASKS, 1);

  it("accepts every acceptance testcase failing, and excuses the check's non-zero exit", () => {
    expect(judgeAcceptance(expectation, [facts(expectation, RED_REPORT)])).toEqual({ failures: [], excusedCheckIds: ["verify"] });
  });

  it("refuses an acceptance testcase that already passes", () => {
    const judged = judgeAcceptance(expectation, [facts(expectation, [RED_REPORT[1]!, testcase("payload > AS-004: refuses", "passed")])]);
    expect(judged.failures).toEqual([{ kind: "acceptance-not-red", contract: "CT-1", testcases: [{ file: ACCEPTANCE, name: "payload > AS-004: refuses" }] }]);
  });

  it("refuses a file that never loaded: its synthetic testcase is not a behavioral RED", () => {
    const broken = testcase("tests/acceptance/payload.acceptance.test.ts", "failed", "Error");
    const judged = judgeAcceptance(expectation, [facts(expectation, [broken])]);
    expect(judged.failures).toContainEqual({ kind: "acceptance-file-not-collected", contract: "CT-1", file: ACCEPTANCE });
    expect(judged.excusedCheckIds).toEqual([]);
  });

  it("refuses an unanchored testcase and an anchor no testcase decides", () => {
    const judged = judgeAcceptance(expectation, [facts(expectation, [RED_REPORT[1]!, testcase("payload > refuses garbage", "failed")])]);
    expect(judged.failures).toEqual([
      { kind: "acceptance-testcase-unanchored", contract: "CT-1", file: ACCEPTANCE, name: "payload > refuses garbage" },
      { kind: "acceptance-anchor-untested", contract: "CT-1", file: ACCEPTANCE, anchor: "AS-004" },
    ]);
  });

  it("never excuses a failure outside the acceptance files", () => {
    const judged = judgeAcceptance(expectation, [facts(expectation, [...RED_REPORT, testcase("breaks", "failed", "AssertionError", "tests/core/other.test.ts")])]);
    expect(judged).toEqual({ failures: [], excusedCheckIds: [] });
  });

  it("refuses a report the engine could not project, naming why", () => {
    const unprojectable = observeAcceptanceFacts(expectation, "verify", REPORT, {
      ok: false,
      error: { kind: "invalid-structured-test-report", reason: "unrecognized-format", message: "Vitest JSON" },
    });
    expect(judgeAcceptance(expectation, [unprojectable]).failures).toEqual([
      { kind: "acceptance-not-observed", contract: "CT-1", reasons: ["verify: Vitest JSON"] },
    ]);
  });
});

describe("judgeAcceptance — GREEN by anchor after the contract Wave", () => {
  it("excuses a testcase whose anchor completes in a later Wave, and requires the due one to pass", () => {
    const expectation = acceptanceExpectation([contract(FROZEN)], TASKS, 2);
    const wave2 = [testcase(ROSTER[0].name, "passed"), testcase(ROSTER[1].name, "failed")];
    expect(judgeAcceptance(expectation, [facts(expectation, wave2)])).toEqual({ failures: [], excusedCheckIds: ["verify"] });
    const regressed = [testcase(ROSTER[0].name, "failed"), testcase(ROSTER[1].name, "failed")];
    expect(judgeAcceptance(expectation, [facts(expectation, regressed)])).toEqual({
      failures: [{ kind: "acceptance-not-green", contract: "CT-1", testcases: [{ file: ACCEPTANCE, name: ROSTER[0].name }] }],
      excusedCheckIds: [],
    });
  });

  it("refuses a frozen testcase the report no longer runs", () => {
    const expectation = acceptanceExpectation([contract(FROZEN)], TASKS, 4);
    const judged = judgeAcceptance(expectation, [facts(expectation, [testcase(ROSTER[0].name, "passed")])]);
    expect(judged.failures).toEqual([
      { kind: "acceptance-not-green", contract: "CT-1", testcases: [{ file: ACCEPTANCE, name: ROSTER[1].name }] },
    ]);
  });

  it("property: a gate never excuses a check whose failures leave the acceptance files", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.record({ outcome: fc.constantFrom("passed", "failed", "skipped") as fc.Arbitrary<ReportTestcase["outcome"]>, anchor: fc.constantFrom("AS-003", "AS-004") }), { maxLength: 6 }),
      (wave, cases) => {
        const expectation = acceptanceExpectation([contract(wave === 1 ? { state: "awaiting-red" } : FROZEN)], TASKS, wave);
        const report = [
          ...cases.map(({ outcome, anchor }, index) => testcase(`p > ${anchor}: case ${index}`, outcome)),
          testcase("outside", "failed", "AssertionError", "tests/core/other.test.ts"),
        ];
        return judgeAcceptance(expectation, [facts(expectation, report)]).excusedCheckIds.length === 0;
      },
    ));
  });
});

describe("stampAcceptanceFreezes — the Acceptance Freeze", () => {
  const digests = new Map([[TYPES, digest("a")], [ACCEPTANCE, digest("b")]]);

  it("freezes the observed-red bytes and roster at the contract Wave's accepted gate, idempotently", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const stamped = stampAcceptanceFreezes([contract()], expectation, [facts(expectation, RED_REPORT)], digests);
    expect(stamped).toEqual({ ok: true, value: [contract(FROZEN)] });
    const again = stampAcceptanceFreezes([contract(FROZEN)], expectation, [facts(expectation, RED_REPORT)], digests);
    expect(again).toEqual({ ok: true, value: [contract(FROZEN)] });
  });

  it("refuses to restamp a frozen contract with different bytes", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const changed = new Map([[TYPES, digest("c")], [ACCEPTANCE, digest("b")]]);
    expect(stampAcceptanceFreezes([contract(FROZEN)], expectation, [facts(expectation, RED_REPORT)], changed)).toMatchObject({ ok: false });
  });

  it("re-records the roster green at the first gate after a Contract Revision", () => {
    const revised = contract({ state: "revised", paths: FROZEN_PATHS });
    const expectation = acceptanceExpectation([revised], TASKS, 3);
    const green = [testcase(ROSTER[0].name, "passed"), testcase(ROSTER[1].name, "passed")];
    expect(stampAcceptanceFreezes([revised], expectation, [facts(expectation, green)], digests)).toEqual({
      ok: true,
      value: [contract({ state: "frozen", wave: 3, paths: FROZEN_PATHS, roster: ROSTER })],
    });
  });
});

describe("frozenPathDrift — bytes that changed outside any Task", () => {
  it("names every frozen path whose bytes differ or vanished", () => {
    expect(frozenPathDrift([contract(FROZEN)], new Map([[TYPES, digest("a")], [ACCEPTANCE, digest("b")]]))).toEqual([]);
    expect(frozenPathDrift([contract(FROZEN)], new Map([[TYPES, digest("f")], [ACCEPTANCE, null]]))).toEqual([
      { contract: "CT-1", path: TYPES, expected: digest("a"), actual: digest("f") },
      { contract: "CT-1", path: ACCEPTANCE, expected: digest("b"), actual: null },
    ]);
    expect(frozenPathDrift([contract()], new Map())).toEqual([]);
  });
});

describe("wire parsers — contracts and report facts round-trip exactly", () => {
  it("round-trips every freeze state and refuses surplus or contradictory fields", () => {
    for (const freeze of [{ state: "awaiting-red" } as const, FROZEN, { state: "revised", paths: FROZEN_PATHS } as const]) {
      const value = [contract(freeze)];
      expect(parseAcceptanceContracts(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, value });
    }
    expect(parseAcceptanceContracts([{ ...contract(), surplus: true }])).toMatchObject({ ok: false });
    expect(parseAcceptanceContracts([contract(), contract()])).toMatchObject({ ok: false });
    expect(parseAcceptanceContracts([{ ...contract(), freeze: { state: "frozen", wave: 1, paths: [], roster: ROSTER } }])).toMatchObject({ ok: false });
  });

  it("round-trips projected and unprojectable facts", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const projected = facts(expectation, RED_REPORT);
    expect(projected).toMatchObject({ kind: "projected", otherFailures: 0 });
    expect(parseAcceptanceReportFacts(JSON.parse(JSON.stringify(projected)))).toEqual({ ok: true, value: projected });
    expect(parseAcceptanceReportFacts({ ...projected, otherFailures: -1 })).toMatchObject({ ok: false });
  });
});
