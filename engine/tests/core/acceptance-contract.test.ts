import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  acceptanceContractsFromPlan,
  acceptanceExpectation,
  contractBindingErrors,
  contractClaimants,
  contractRole,
  contractWriter,
  frozenPathDrift,
  frozenPaths,
  isExpectedRedAcceptanceFailure,
  renderFrozenPathDrift,
  judgeAcceptance,
  observeAcceptanceFacts,
  parseAcceptanceContracts,
  parseAcceptanceExpectation,
  parseAcceptanceReportFacts,
  redWindowTaskIds,
  stampAcceptanceFreezes,
  testcaseAcceptanceFile,
  type AcceptanceContract,
  type AcceptanceExpectation,
  type AcceptanceReportFacts,
  type ContractBindingTask,
  type FrozenPathObservation,
} from "../../src/core/acceptance-contract";
import type { ReportTestcase } from "../../src/core/structured-test-report";
import type { PlanContract } from "../../src/types";
import { ACCEPTANCE_RED_WINDOW } from "../../src/core/verification-policy";
import { digest, seen } from "../fixtures/acceptance-fixtures";

const observations = (entries: readonly (readonly [string, FrozenPathObservation])[]): ReadonlyMap<string, FrozenPathObservation> =>
  new Map(entries);
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
    entryPoint: null,
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
    // Population renders the same typed writer problems plan validation does.
    expect(split).toEqual({
      ok: false,
      error: ["CT-1: frozen paths are written by T1 and T2 — one contract task writes the types file and every acceptance file"],
    });
    const unwritten = acceptanceContractsFromPlan([PLAN_CONTRACT], [{ id: "T1", wave: 1, file_list: [TYPES], spec_anchors: [] }]);
    expect(unwritten).toEqual({
      ok: false,
      error: [`CT-1: '${ACCEPTANCE}' is in no task's file_list — decompose must emit the contract task that writes it`],
    });
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

describe("contractBindingErrors — the Task graph binds every contract", () => {
  const view = (id: string, overrides: Partial<ContractBindingTask> = {}): ContractBindingTask =>
    ({ id, file_list: [], spec_anchors: [], depends_on: [], newTestWaiver: null, ...overrides });
  const bound = [
    view("T1", { file_list: [TYPES, ACCEPTANCE] }),
    view("T2", { spec_anchors: ["AS-003"], depends_on: ["T1"] }),
    view("T3", { spec_anchors: ["AS-004"], depends_on: ["T2"], newTestWaiver: "covered-by-acceptance-contract" }),
  ];

  it("accepts a graph where every claimant waits for the contract Task, directly or transitively", () => {
    expect(contractBindingErrors([PLAN_CONTRACT], bound)).toEqual([]);
  });

  it("names a claimant that does not wait for the contract Task, and a covered Requirement no Task claims", () => {
    const errors = contractBindingErrors([PLAN_CONTRACT], [bound[0]!, view("T2", { spec_anchors: ["AS-003"] })]);
    expect(errors).toEqual([
      expect.stringContaining("T2 claims AS-003, which CT-1 covers, but does not depend on its contract task T1"),
      expect.stringContaining("AS-004 is decided by CT-1's acceptance tests but no task claims it"),
    ]);
  });
});

describe("contractRole — the one rule for a Task's part in a contract", () => {
  const extra = { id: "T5", wave: 2, file_list: ["engine/src/bystander.ts"], spec_anchors: [] } as const;
  const tasks = [...TASKS, extra];

  it.each([
    ["the contract Task", "T1", { kind: "contract-task" }],
    ["a claimant, with the anchors it completes", "T2", { kind: "claimant", anchors: ["AS-003"] }],
    ["a Task inside the red window", "T5", { kind: "red-window" }],
    ["a Task after the red window", "T4", { kind: "none" }],
  ])("names %s", (_name, id, role) => {
    expect(contractRole(contract(), tasks.find((task) => task.id === id)!, tasks)).toEqual(role);
  });

  it("agrees with redWindowTaskIds on who runs inside the window", () => {
    const window = redWindowTaskIds([contract()], tasks);
    for (const task of tasks) {
      expect(contractRole(contract(), task, tasks).kind !== "none").toBe(window.has(task.id));
    }
  });

  it("agrees with contractClaimants on who is a claimant", () => {
    const claimants = new Set(contractClaimants(contract(), tasks).map(({ id }) => id));
    for (const task of tasks) {
      expect(contractRole(contract(), task, tasks).kind === "claimant").toBe(claimants.has(task.id));
    }
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

  it("prefers an exact path, and leaves a testcase two files suffix-match unattributed", () => {
    expect(testcaseAcceptanceFile(["b/a/x.acceptance.test.ts", "a/x.acceptance.test.ts"], "a/x.acceptance.test.ts"))
      .toBe("a/x.acceptance.test.ts");
    expect(testcaseAcceptanceFile(["engine/a/x.acceptance.test.ts", "svc/a/x.acceptance.test.ts"], "a/x.acceptance.test.ts"))
      .toBeNull();
  });
});

describe("contractWriter — the one Task that writes every frozen path", () => {
  const paths = [TYPES, ACCEPTANCE] as const;
  const task = (id: string, file_list: readonly string[]) => ({ id, file_list });

  it("names the one Task listing every frozen path exactly", () => {
    expect(contractWriter(paths, [task("T1", [TYPES, `./${ACCEPTANCE}`]), task("T2", ["src/other.ts"])]))
      .toEqual({ ok: true, value: "T1" });
  });

  it("refuses a Task that lists only a deeper path ending in the frozen one: the freeze hashes the declared path", () => {
    expect(contractWriter(paths, [task("T1", [TYPES, `repo/${ACCEPTANCE}`])])).toEqual({
      ok: false,
      error: [{ kind: "unwritten", path: ACCEPTANCE }],
    });
  });

  it("refuses a frozen path two Tasks list, and frozen paths split across Tasks", () => {
    expect(contractWriter(paths, [task("T1", [TYPES, ACCEPTANCE]), task("T2", [ACCEPTANCE])])).toEqual({
      ok: false,
      error: [{ kind: "shared", path: ACCEPTANCE, taskIds: ["T1", "T2"] }],
    });
    expect(contractWriter(paths, [task("T1", [TYPES]), task("T2", [ACCEPTANCE])])).toEqual({
      ok: false,
      error: [{ kind: "split", taskIds: ["T1", "T2"] }],
    });
  });
});

describe("acceptanceExpectation — what each Wave Gate owes a contract", () => {
  it("owes nothing before the contract Wave, RED in it, and GREEN by anchor after it", () => {
    const red = acceptanceExpectation([contract()], TASKS, 1);
    expect(red.contracts).toEqual([
      { contract: "CT-1", phase: "red", files: contract().acceptance, dueWave: { "AS-003": 2, "AS-004": 3 } },
    ]);
    // RED carries no roster on the wire either: the parser refuses one.
    const withRoster = { ...red, contracts: [{ ...red.contracts[0], roster: null }] };
    expect(parseAcceptanceExpectation(JSON.parse(JSON.stringify(red)))).toEqual({ ok: true, value: red });
    expect(parseAcceptanceExpectation(withRoster)).toMatchObject({ ok: false, error: expect.stringContaining("contracts[0].roster is not allowed") });
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

describe("isExpectedRedAcceptanceFailure — the one expected-RED rule the gate and I7 share", () => {
  const observed = (name: string, outcome: ReportTestcase["outcome"], collectionError = false) =>
    ({ file: ACCEPTANCE, name, outcome, collectionError });

  it("holds for a collected failure in the RED Wave, and for a pending one after it, never for a due one", () => {
    const red = acceptanceExpectation([contract()], TASKS, 1);
    expect(isExpectedRedAcceptanceFailure(red, observed(ROSTER[0].name, "failed"))).toBe(true);
    const wave2 = acceptanceExpectation([contract(FROZEN)], TASKS, 2);
    expect(isExpectedRedAcceptanceFailure(wave2, observed(ROSTER[1].name, "failed"))).toBe(true);
    expect(isExpectedRedAcceptanceFailure(wave2, observed(ROSTER[0].name, "failed"))).toBe(false);
  });

  it("fails closed for a collection error, a passing or unanchored testcase, a foreign file and an unobservable contract", () => {
    const red = acceptanceExpectation([contract()], TASKS, 1);
    expect(isExpectedRedAcceptanceFailure(red, observed(ACCEPTANCE, "failed", true))).toBe(false);
    expect(isExpectedRedAcceptanceFailure(red, observed(ROSTER[0].name, "passed"))).toBe(false);
    expect(isExpectedRedAcceptanceFailure(red, { ...observed(ROSTER[0].name, "failed"), file: "tests/core/other.test.ts" })).toBe(false);
    const wave2 = acceptanceExpectation([contract(FROZEN)], TASKS, 2);
    expect(isExpectedRedAcceptanceFailure(wave2, observed("payload > unanchored", "failed"))).toBe(false);
    const unobservable = acceptanceExpectation([contract()], TASKS, 2);
    expect(isExpectedRedAcceptanceFailure(unobservable, observed(ROSTER[1].name, "failed"))).toBe(false);
  });

  it("property: the gate excuses a check exactly when its report fails only testcases the rule holds for", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.boolean(),
      fc.array(fc.record({
        name: fc.constantFrom(ROSTER[0].name, ROSTER[1].name, "payload > unanchored", "tests/acceptance/payload.acceptance.test.ts"),
        outcome: fc.constantFrom("passed", "failed", "skipped") as fc.Arbitrary<ReportTestcase["outcome"]>,
        outside: fc.boolean(),
      }), { maxLength: 6 }),
      (wave, frozen, cases) => {
        const expectation = acceptanceExpectation([contract(frozen ? FROZEN : { state: "awaiting-red" })], TASKS, wave);
        const report = cases.map(({ name, outcome, outside }) =>
          testcase(name, outcome, undefined, outside ? "tests/core/other.test.ts" : undefined));
        const fact = facts(expectation, report);
        const failing = report.filter(({ outcome }) => outcome === "failed");
        const ruleHolds = fact.kind === "projected" && fact.otherFailures === 0 && failing.length > 0 &&
          fact.testcases.filter(({ outcome }) => outcome === "failed").every((observedCase) => isExpectedRedAcceptanceFailure(expectation, observedCase));
        expect(judgeAcceptance(expectation, [fact]).excusedCheckIds).toEqual(ruleHolds ? ["verify"] : []);
      },
    ));
  });
});

describe("stampAcceptanceFreezes — the Acceptance Freeze", () => {
  const digests = observations([[TYPES, seen(digest("a"))], [ACCEPTANCE, seen(digest("b"))]]);

  it("freezes the observed-red bytes and roster at the contract Wave's accepted gate, idempotently", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const stamped = stampAcceptanceFreezes([contract()], expectation, [facts(expectation, RED_REPORT)], digests);
    expect(stamped).toEqual({ ok: true, value: [contract(FROZEN)] });
    const again = stampAcceptanceFreezes([contract(FROZEN)], expectation, [facts(expectation, RED_REPORT)], digests);
    expect(again).toEqual({ ok: true, value: [contract(FROZEN)] });
  });

  it("refuses to restamp a frozen contract with different bytes", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const changed = observations([[TYPES, seen(digest("c"))], [ACCEPTANCE, seen(digest("b"))]]);
    expect(stampAcceptanceFreezes([contract(FROZEN)], expectation, [facts(expectation, RED_REPORT)], changed)).toMatchObject({ ok: false });
  });

  it("names each frozen path it could not read, and why, instead of stamping", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const unreadable = observations([[TYPES, { kind: "unreadable", reason: "ELOOP: refusing to follow a link" }]]);
    expect(stampAcceptanceFreezes([contract()], expectation, [facts(expectation, RED_REPORT)], unreadable)).toEqual({
      ok: false,
      error: `CT-1: frozen paths could not be read to stamp the freeze: '${TYPES}' (ELOOP: refusing to follow a link), ` +
        `'${ACCEPTANCE}' (not observed)`,
    });
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
  it("names every frozen path whose bytes differ, cannot be read, or were not observed", () => {
    expect(frozenPathDrift([contract(FROZEN)], observations([[TYPES, seen(digest("a"))], [ACCEPTANCE, seen(digest("b"))]]))).toEqual([]);
    const unreadable: FrozenPathObservation = { kind: "unreadable", reason: "ENOENT: no such file" };
    const drift = frozenPathDrift([contract(FROZEN)], observations([[TYPES, seen(digest("f"))], [ACCEPTANCE, unreadable]]));
    expect(drift).toEqual([
      { contract: "CT-1", path: TYPES, expected: digest("a"), actual: seen(digest("f")) },
      { contract: "CT-1", path: ACCEPTANCE, expected: digest("b"), actual: unreadable },
    ]);
    expect(renderFrozenPathDrift(drift)).toContain(`CT-1 '${ACCEPTANCE}' is missing or unreadable (ENOENT: no such file)`);
    expect(renderFrozenPathDrift(frozenPathDrift([contract(FROZEN)], observations([[TYPES, seen(digest("a"))]]))))
      .toContain(`CT-1 '${ACCEPTANCE}' was not observed`);
    expect(frozenPathDrift([contract()], new Map())).toEqual([]);
  });
});

describe("wire parsers — contracts and report facts round-trip exactly", () => {
  it("round-trips every freeze state and refuses surplus or contradictory fields", () => {
    for (const freeze of [{ state: "awaiting-red" } as const, FROZEN]) {
      const value = [contract(freeze)];
      expect(parseAcceptanceContracts(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, value });
    }
    // A revised freeze is only ever the product of a recorded revision.
    const revised: AcceptanceContract = {
      ...contract({ state: "revised", paths: FROZEN_PATHS }),
      revisions: [{ revision: 1, reason: "AS-003 was wrong", previous: FROZEN_PATHS, paths: FROZEN_PATHS, revalidatedTaskIds: [] }],
    };
    expect(parseAcceptanceContracts(JSON.parse(JSON.stringify([revised])))).toEqual({ ok: true, value: [revised] });
    expect(parseAcceptanceContracts([{ ...contract(), surplus: true }])).toMatchObject({ ok: false });
    expect(parseAcceptanceContracts([contract(), contract()])).toMatchObject({ ok: false });
    expect(parseAcceptanceContracts([{ ...contract(), freeze: { state: "frozen", wave: 1, paths: [], roster: ROSTER } }])).toMatchObject({ ok: false });
  });

  it("refuses an anchor named twice in an acceptance file or a roster entry, as the plan grammar does", () => {
    const twiceInFile = { ...contract(), acceptance: [{ path: ACCEPTANCE, anchors: ["AS-003", "AS-003", "AS-004"] }] };
    expect(parseAcceptanceContracts([twiceInFile])).toMatchObject({
      ok: false,
      error: expect.stringContaining("anchors names an anchor more than once"),
    });
    const twiceInRoster = contract({ ...FROZEN, roster: [{ ...ROSTER[0], anchors: ["AS-003", "AS-003"] }, ROSTER[1]] });
    expect(parseAcceptanceContracts([twiceInRoster])).toMatchObject({
      ok: false,
      error: expect.stringContaining("anchors names an anchor more than once"),
    });
  });

  it("round-trips projected and unprojectable facts", () => {
    const expectation = acceptanceExpectation([contract()], TASKS, 1);
    const projected = facts(expectation, RED_REPORT);
    expect(projected).toMatchObject({ kind: "projected", otherFailures: 0 });
    expect(parseAcceptanceReportFacts(JSON.parse(JSON.stringify(projected)))).toEqual({ ok: true, value: projected });
    expect(parseAcceptanceReportFacts({ ...projected, otherFailures: -1 })).toMatchObject({ ok: false });
    if (projected.kind !== "projected") throw new Error("fixture facts must project");
    const passedWithFailure = {
      ...projected,
      testcases: [{ ...projected.testcases[0]!, outcome: "passed", failureType: "AssertionError" }],
    };
    expect(parseAcceptanceReportFacts(passedWithFailure)).toMatchObject({
      ok: false,
      error: expect.stringContaining("failureType is recorded only for a failed testcase"),
    });
  });
});
