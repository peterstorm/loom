/**
 * Unit and property tests for the affected stop check's pure core (AD-10):
 * - `judgeAffectedRun` names every failing affected testcase with its file
 *   and name, collection errors included, and passes a zero-test report with
 *   a note (AS-023). A failure the Wave Gate excuses as expected RED (the
 *   contract Wave, or a pending anchor after it) never blocks but is named; a
 *   property pins that the two agree testcase by testcase (CT-2 amendment A1);
 * - `stopCheckBlockDecision` is the whole block-counter transition rule for
 *   every check: 0 → 1 → 2 → 3, then the cap fails open; an unreadable count
 *   fails open; each check has its own cap (AS-029), the Task mutation check's
 *   being 2 (ADR-0071); each check's cap note states that check's own cap. A
 *   property asserts no agent is blocked more than a check's cap by that
 *   check (SC-005);
 * - `renderAffectedBlock` and `renderStopChecksBlock` build the one combined
 *   message, with a heading per contributing check (AS-028);
 * - `mapSomeChecks` maps exactly the checks a block names, in check order:
 *   the shape the stop shell renders the block's parts through.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_BLOCK_HEADING,
  AFFECTED_BLOCK_HEADING,
  AFFECTED_EXCUSED_HEADING,
  AFFECTED_NOTE_TEXT,
  AFFECTED_STOP_CHECK_MAX_BLOCKS,
  MUTATION_BLOCK_HEADING,
  STOP_CHECK_NAMES,
  TASK_MUTATION_STOP_CHECK_MAX_BLOCKS,
  type FailingAffectedTestcase,
  type StopCheckBlockCount,
  type StopCheckName,
} from "../../src/core/affected-stop-check-types";
import {
  blockAdmission,
  judgeAffectedRun,
  mapSomeChecks,
  renderAffectedBlock,
  renderStopChecksBlock,
  stopCheckBlockDecision,
  type Blocking,
  type BlockingChecks,
  type StopCheckBlockCaps,
  type StopCheckFailures,
} from "../../src/core/affected-stop-check";
import {
  emptyAcceptanceExpectation,
  graphAcceptanceExpectation,
  judgeAcceptance,
  observeAcceptanceFacts,
  type AcceptanceContract,
  type AcceptanceExpectation,
} from "../../src/core/acceptance-contract";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { parseJunitTestcases, type JunitTestcasesResult } from "../../src/core/structured-test-report";
import { digest } from "../fixtures/acceptance-fixtures";
import { contract, frozenPaths, surface, task } from "../fixtures/contract-status-fixtures";

type Case = Readonly<{ file: string; name: string; outcome: "passed" | "failed" | "skipped" }>;

const junit = (cases: readonly Case[]): JunitTestcasesResult => parseJunitTestcases(new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites tests="${cases.length}"><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) =>
    `<testcase classname="${file}" name="${name}">` +
    (outcome === "failed" ? `<failure type="AssertionError" message="expected 1 to be 2"/>` : "") +
    (outcome === "skipped" ? "<skipped/>" : "") +
    "</testcase>").join("") +
  "</testsuite></testsuites>"));

/** A gate that owes no contract anything: every failure blocks. */
const NO_CONTRACTS = emptyAcceptanceExpectation(1);

// CT-1 is written by T1 in Wave 1; T2 completes AS-001 in Wave 2 and T3
// completes AS-002 in Wave 3.
const SURFACE = surface("payload");
const AS_001 = "payload > AS-001: one valid call wins";
const AS_002 = "payload > AS-002: a refused call never supplies bytes";
const TASKS = [
  task("T1", 1, [SURFACE.types, SURFACE.acceptance]),
  task("T2", 2, ["src/payload.ts"], ["AS-001"]),
  task("T3", 3, ["src/payload-refusal.ts"], ["AS-002"]),
];
const CONTRACT = { id: "CT-1", surface: SURFACE, anchors: ["AS-001", "AS-002"] } as const;
const AWAITING_RED = contract({ ...CONTRACT, freeze: { state: "awaiting-red" } });
const FROZEN = contract({
  ...CONTRACT,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: frozenPaths(SURFACE, "a"),
    roster: [
      { file: SURFACE.acceptance, name: AS_001, anchors: ["AS-001"] },
      { file: SURFACE.acceptance, name: AS_002, anchors: ["AS-002"] },
    ],
  },
});
const graphExpectation = (frozen: AcceptanceContract, wave: number): AcceptanceExpectation =>
  graphAcceptanceExpectation({ acceptance_contracts: [frozen], tasks: TASKS }, wave);
const acceptanceCase = (name: string, outcome: Case["outcome"]): Case => ({ file: SURFACE.acceptance, name, outcome });
const REPORT = digest("e");

const CAP = AFFECTED_STOP_CHECK_MAX_BLOCKS;
const MUTATION_CAP = TASK_MUTATION_STOP_CHECK_MAX_BLOCKS;
/** The runner checks at the production cap of 3 and the mutation check at its
 *  own. The acceptance constant lives in the acceptance shell, which this pure
 *  core's tests do not import. */
const CAPS: StopCheckBlockCaps = { acceptance: CAP, affected: CAP, mutation: MUTATION_CAP };
const count = (blocks: number): StopCheckBlockCount => ({ kind: "count", blocks });
const unreadable = (reason: string): StopCheckBlockCount => ({ kind: "unreadable", reason });

describe("judgeAffectedRun", () => {
  it("is unobservable when the report could not be parsed, naming why", () => {
    const verdict = judgeAffectedRun(parseJunitTestcases(new TextEncoder().encode("not a report")), NO_CONTRACTS);

    expect(verdict.kind).toBe("unobservable");
    if (verdict.kind === "unobservable") expect(verdict.reason).toMatch(/report could not be read: .+/);
  });

  it("AS-023: passes a report with zero testcases as zero-tests", () => {
    expect(judgeAffectedRun(junit([]), NO_CONTRACTS)).toEqual({ kind: "passed", observed: "zero-tests" });
  });

  it("passes when every testcase passed or was skipped", () => {
    expect(judgeAffectedRun(junit([
      { file: "src/a.test.ts", name: "a > works", outcome: "passed" },
      { file: "src/b.test.ts", name: "b > todo", outcome: "skipped" },
    ]), NO_CONTRACTS)).toEqual({ kind: "passed", observed: "some-tests" });
  });

  it("names every failing testcase with its reported file and name, in report order, and a file that failed to collect", () => {
    expect(judgeAffectedRun(junit([
      { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
      { file: "src/ledger.test.ts", name: "ledger > opens", outcome: "passed" },
      { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "failed" },
      { file: "src/x.test.ts", name: "x > todo", outcome: "skipped" },
    ]), NO_CONTRACTS)).toEqual({
      kind: "failing",
      testcases: [
        { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
        { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "collection-error" },
      ],
      excused: [],
    });
  });
});

describe("judgeAffectedRun: expected-RED acceptance failures (the Wave Gate's rule)", () => {
  const red = (wave: number) => graphExpectation(AWAITING_RED, wave);
  const green = (wave: number) => graphExpectation(FROZEN, wave);

  it("excuses every acceptance testcase failing in the contract Wave, and names them", () => {
    expect(judgeAffectedRun(junit([
      acceptanceCase(AS_001, "failed"),
      acceptanceCase(AS_002, "failed"),
      { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "passed" },
    ]), red(1))).toEqual({
      kind: "excused",
      excused: [{ file: SURFACE.acceptance, name: AS_001 }, { file: SURFACE.acceptance, name: AS_002 }],
    });
  });

  it("after the contract Wave, excuses a pending testcase and blocks a due one", () => {
    // Wave 2 completes AS-001 (due); AS-002 completes in Wave 3 (pending).
    const verdict = judgeAffectedRun(junit([acceptanceCase(AS_001, "failed"), acceptanceCase(AS_002, "failed")]), green(2));

    expect(verdict).toEqual({
      kind: "failing",
      testcases: [{ file: SURFACE.acceptance, name: AS_001, outcome: "failed" }],
      excused: [{ file: SURFACE.acceptance, name: AS_002 }],
    });
    expect(judgeAffectedRun(junit([acceptanceCase(AS_002, "failed")]), green(2)).kind).toBe("excused");
    expect(judgeAffectedRun(junit([acceptanceCase(AS_002, "failed")]), green(3)).kind).toBe("failing");
  });

  it("names blocking and excused acceptance failures by the same declared path, not the runner-relative classname", () => {
    const cwdRelative = (name: string): Case => ({ file: "payload.acceptance.test.ts", name, outcome: "failed" });
    expect(judgeAffectedRun(junit([cwdRelative(AS_001), cwdRelative(AS_002)]), green(2))).toEqual({
      kind: "failing",
      testcases: [{ file: SURFACE.acceptance, name: AS_001, outcome: "failed" }],
      excused: [{ file: SURFACE.acceptance, name: AS_002 }],
    });
  });

  it("blocks an acceptance file that failed to collect, even in the contract Wave", () => {
    expect(judgeAffectedRun(junit([acceptanceCase(SURFACE.acceptance, "failed")]), red(1))).toEqual({
      kind: "failing",
      testcases: [{ file: SURFACE.acceptance, name: SURFACE.acceptance, outcome: "collection-error" }],
      excused: [],
    });
  });

  it("blocks a failure outside the acceptance files, naming the excused ones beside it", () => {
    expect(judgeAffectedRun(junit([
      acceptanceCase(AS_001, "failed"),
      { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
    ]), red(1))).toEqual({
      kind: "failing",
      testcases: [{ file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" }],
      excused: [{ file: SURFACE.acceptance, name: AS_001 }],
    });
  });

  it("fails closed for a contract whose RED was never observed: nothing is frozen to excuse", () => {
    expect(judgeAffectedRun(junit([acceptanceCase(AS_002, "failed")]), red(2))).toEqual({
      kind: "failing",
      testcases: [{ file: SURFACE.acceptance, name: AS_002, outcome: "failed" }],
      excused: [],
    });
  });

  it("excuses nothing before the contract Wave", () => {
    const before = graphExpectation(contract({ ...CONTRACT, contractTask: "T2", freeze: { state: "awaiting-red" } }), 1);
    expect(judgeAffectedRun(junit([acceptanceCase(AS_002, "failed")]), before).kind).toBe("failing");
  });

  it("property: a failure is excused exactly when the Wave Gate would excuse a check failing it alone, and nothing is dropped", () => {
    const anyCase = fc.record({
      file: fc.constantFrom(SURFACE.acceptance, "src/ledger.test.ts"),
      name: fc.constantFrom(AS_001, AS_002, "payload > unanchored", SURFACE.acceptance, "src/ledger.test.ts"),
      outcome: fc.constantFrom("passed", "failed", "skipped") as fc.Arbitrary<Case["outcome"]>,
    });
    fc.assert(fc.property(
      fc.constantFrom(AWAITING_RED, FROZEN),
      fc.integer({ min: 1, max: 4 }),
      fc.array(anyCase, { minLength: 1, maxLength: 6 }),
      (frozen, wave, cases) => {
        const expectation = graphExpectation(frozen, wave);
        const verdict = judgeAffectedRun(junit(cases), expectation);
        const gateExcuses = (testcase: Case): boolean =>
          judgeAcceptance(expectation, [observeAcceptanceFacts(expectation, "verify", REPORT, junit([testcase]))]).excusedCheckIds.length > 0;
        const failed = cases.filter(({ outcome }) => outcome === "failed");
        const excused = verdict.kind === "excused" || verdict.kind === "failing" ? verdict.excused : [];
        const blocking = verdict.kind === "failing" ? verdict.testcases : [];
        expect(blocking.length + excused.length).toBe(failed.length);
        expect(excused.map(({ name }) => name)).toEqual(failed.filter(gateExcuses).map(({ name }) => name));
      },
    ));
  });
});

describe("stopCheckBlockDecision", () => {
  /** Each check's failure, as the shell passes it: the decision carries it into the block unchanged. */
  const A = "acceptance failure";
  const F = "affected failure";
  const M = "mutation failure";
  type Failures = StopCheckFailures<string, string, string>;
  type Issued = Readonly<Record<StopCheckName, StopCheckBlockCount>>;
  type Blocked = Readonly<Record<StopCheckName, Readonly<{ failure: string; blocks: number }> | null>>;
  /** The failures of one stop: every check passing unless named. */
  const failuresOf = (failing: Partial<Failures> = {}): Failures => ({ acceptance: null, affected: null, mutation: null, ...failing });
  /** The counters of one stop: no block issued unless named. */
  const issuedAt = (issued: Partial<Issued> = {}): Issued => ({ acceptance: count(0), affected: count(0), mutation: count(0), ...issued });
  /** What a block names: no check unless named. */
  const blockingOf = (blocking: Partial<Blocked>): Blocked => ({ acceptance: null, affected: null, mutation: null, ...blocking });
  const MUTATION_CAP_NOTE = `the Task mutation check reached its ${MUTATION_CAP}-block cap`;

  it("proceeds with no notes when no check is failing, whatever the counts", () => {
    for (const issued of [count(0), count(CAP), unreadable("EACCES")]) {
      expect(stopCheckBlockDecision({ acceptance: issued, affected: issued, mutation: issued }, failuresOf(), CAPS)).toEqual({ outcome: "proceed", notes: [] });
    }
  });

  it("walks a failing affected check from 0 to 1 to 2 to 3 blocks, then fails open at the cap", () => {
    const failures = failuresOf({ affected: F });
    for (const blocks of [0, 1, 2]) {
      expect(stopCheckBlockDecision(issuedAt({ affected: count(blocks) }), failures, CAPS)).toEqual({
        outcome: "block",
        blocking: blockingOf({ affected: { failure: F, blocks: blocks + 1 } }),
        notes: [],
      });
    }
    expect(stopCheckBlockDecision(issuedAt({ affected: count(CAP) }), failures, CAPS))
      .toEqual({ outcome: "proceed", notes: [AFFECTED_NOTE_TEXT["cap-reached"]] });
  });

  it("ADR-0071: blocks a failing mutation check twice, then fails open at its own cap of 2", () => {
    const failures = failuresOf({ mutation: M });
    for (const blocks of [0, 1]) {
      expect(stopCheckBlockDecision(issuedAt({ mutation: count(blocks) }), failures, CAPS)).toEqual({
        outcome: "block",
        blocking: blockingOf({ mutation: { failure: M, blocks: blocks + 1 } }),
        notes: [],
      });
    }
    expect(stopCheckBlockDecision(issuedAt({ mutation: count(MUTATION_CAP) }), failures, CAPS))
      .toEqual({ outcome: "proceed", notes: [MUTATION_CAP_NOTE] });
    expect(stopCheckBlockDecision(issuedAt({ mutation: unreadable("EIO") }), failures, CAPS))
      .toEqual({ outcome: "proceed", notes: ["the Task mutation check's block counter is unreadable: EIO"] });
  });

  it("fails open with a note naming the cause when a failing check's counter is unreadable", () => {
    const decision = stopCheckBlockDecision(issuedAt({ affected: unreadable("counter.json is not JSON") }), failuresOf({ affected: F }), CAPS);

    expect(decision).toEqual({ outcome: "proceed", notes: [`${AFFECTED_NOTE_TEXT["counter-unreadable"]}: counter.json is not JSON`] });
  });

  it("fails the acceptance check open on its own cap and unreadable counter, with its own notes", () => {
    const failures = failuresOf({ acceptance: A });

    expect(stopCheckBlockDecision(issuedAt({ acceptance: count(CAP) }), failures, CAPS))
      .toEqual({ outcome: "proceed", notes: [`the acceptance stop check reached its ${CAP}-block cap`] });
    expect(stopCheckBlockDecision(issuedAt({ acceptance: unreadable("EIO") }), failures, CAPS))
      .toEqual({ outcome: "proceed", notes: ["the acceptance stop check's block counter is unreadable: EIO"] });
  });

  it("AS-029: keeps an independent cap per check: one at its cap does not stop the others from blocking", () => {
    const failing = failuresOf({ acceptance: A, affected: F });

    expect(stopCheckBlockDecision(issuedAt({ acceptance: count(1), affected: count(CAP) }), failing, CAPS)).toEqual({
      outcome: "block",
      blocking: blockingOf({ acceptance: { failure: A, blocks: 2 } }),
      notes: [AFFECTED_NOTE_TEXT["cap-reached"]],
    });
    expect(stopCheckBlockDecision(issuedAt({ acceptance: count(CAP) }), failing, CAPS)).toEqual({
      outcome: "block",
      blocking: blockingOf({ affected: { failure: F, blocks: 1 } }),
      notes: [`the acceptance stop check reached its ${CAP}-block cap`],
    });
    // The mutation check at its cap leaves a still-failing affected check blocking, and the reverse.
    expect(stopCheckBlockDecision(issuedAt({ affected: count(2), mutation: count(MUTATION_CAP) }), failuresOf({ affected: F, mutation: M }), CAPS)).toEqual({
      outcome: "block",
      blocking: blockingOf({ affected: { failure: F, blocks: 3 } }),
      notes: [MUTATION_CAP_NOTE],
    });
    expect(stopCheckBlockDecision(issuedAt({ affected: count(CAP), mutation: count(1) }), failuresOf({ affected: F, mutation: M }), CAPS)).toEqual({
      outcome: "block",
      blocking: blockingOf({ mutation: { failure: M, blocks: 2 } }),
      notes: [AFFECTED_NOTE_TEXT["cap-reached"]],
    });
  });

  it("states each check's own cap in its note when the caps differ", () => {
    const failing = failuresOf({ acceptance: A, affected: F });
    const caps: StopCheckBlockCaps = { ...CAPS, acceptance: 5 };

    // The acceptance check keeps blocking past the affected cap, up to its own.
    expect(stopCheckBlockDecision(issuedAt({ acceptance: count(CAP), affected: count(CAP) }), failing, caps)).toEqual({
      outcome: "block",
      blocking: blockingOf({ acceptance: { failure: A, blocks: CAP + 1 } }),
      notes: [AFFECTED_NOTE_TEXT["cap-reached"]],
    });
    expect(stopCheckBlockDecision(issuedAt({ acceptance: count(5), affected: count(CAP) }), failing, caps))
      .toEqual({ outcome: "proceed", notes: ["the acceptance stop check reached its 5-block cap", AFFECTED_NOTE_TEXT["cap-reached"]] });
  });

  it("names each check that contributes failures, with its failure and count + 1", () => {
    expect(stopCheckBlockDecision(issuedAt({ affected: count(2), mutation: count(1) }), { acceptance: A, affected: F, mutation: M }, CAPS)).toEqual({
      outcome: "block",
      blocking: { acceptance: { failure: A, blocks: 1 }, affected: { failure: F, blocks: 3 }, mutation: { failure: M, blocks: 2 } },
      notes: [],
    });
  });

  /** The checks a block names, each with the count its counter now records. */
  const blockedChecks = (blocking: BlockingChecks<string, string, string>): ReadonlyArray<readonly [StopCheckName, number]> =>
    STOP_CHECK_NAMES.flatMap((name) => {
      const entry = blocking[name];
      return entry === null ? [] : [[name, entry.blocks] as const];
    });

  it("SC-005: no agent is ever blocked more than a check's cap by that check, and every stop sequence ends", () => {
    const failure = (marker: string) => fc.constantFrom<string | null>(marker, null);
    const stop = fc.record({
      acceptance: failure(A),
      affected: failure(F),
      mutation: failure(M),
      unreadable: fc.constantFrom<StopCheckName | null>(null, null, null, ...STOP_CHECK_NAMES),
    });

    fc.assert(fc.property(fc.array(stop, { minLength: 1, maxLength: 20 }), (stops) => {
      const counters: Record<StopCheckName, number> = { acceptance: 0, affected: 0, mutation: 0 };
      const contributed: Record<StopCheckName, number> = { acceptance: 0, affected: 0, mutation: 0 };
      let blocks = 0;
      for (const { unreadable: lost, ...failures } of stops) {
        const issued = (name: StopCheckName): StopCheckBlockCount => lost === name ? unreadable("lost") : count(counters[name]);
        const decision = stopCheckBlockDecision({ acceptance: issued("acceptance"), affected: issued("affected"), mutation: issued("mutation") }, failures, CAPS);
        if (decision.outcome === "proceed") break; // the agent's stop proceeds: it ends.
        blocks += 1;
        const blocked = blockedChecks(decision.blocking);
        expect(blocked.length).toBeGreaterThan(0);
        for (const [name, recorded] of blocked) {
          expect(failures[name]).not.toBeNull();
          expect(recorded).toBe(counters[name] + 1);
          counters[name] = recorded;
          contributed[name] += 1;
        }
        for (const name of STOP_CHECK_NAMES) expect(contributed[name]).toBeLessThanOrEqual(CAPS[name]);
      }
      // A lost counter only ever fails open, so blocks stay bounded by every cap together.
      expect(blocks).toBeLessThanOrEqual(STOP_CHECK_NAMES.reduce((total, name) => total + CAPS[name], 0));
    }));
  });

  it("SC-005: an agent failing every check forever is blocked exactly the largest cap, then proceeds", () => {
    const counters: Record<StopCheckName, number> = { acceptance: 0, affected: 0, mutation: 0 };
    let blocks = 0;
    for (;;) {
      const issued = { acceptance: count(counters.acceptance), affected: count(counters.affected), mutation: count(counters.mutation) };
      const decision = stopCheckBlockDecision(issued, { acceptance: A, affected: F, mutation: M }, CAPS);
      if (decision.outcome === "proceed") {
        expect(decision.notes).toEqual([`the acceptance stop check reached its ${CAP}-block cap`, AFFECTED_NOTE_TEXT["cap-reached"], MUTATION_CAP_NOTE]);
        break;
      }
      blocks += 1;
      for (const [name, recorded] of blockedChecks(decision.blocking)) counters[name] = recorded;
    }
    expect(blocks).toBe(CAP);
    expect(counters.mutation).toBe(MUTATION_CAP);
  });
});

describe("blockAdmission", () => {
  it("admits a check under its cap, naming the count it would record", () => {
    expect(blockAdmission("affected", count(0), CAP)).toEqual({ kind: "may-block", blocks: 1 });
    expect(blockAdmission("acceptance", count(CAP - 1), CAP)).toEqual({ kind: "may-block", blocks: CAP });
  });

  it("fails a check open at its cap or with an unreadable counter, with that check's own note", () => {
    expect(blockAdmission("affected", count(CAP), CAP)).toEqual({ kind: "fails-open", note: AFFECTED_NOTE_TEXT["cap-reached"] });
    expect(blockAdmission("acceptance", count(5), 5)).toEqual({ kind: "fails-open", note: "the acceptance stop check reached its 5-block cap" });
    expect(blockAdmission("acceptance", unreadable("EIO"), CAP))
      .toEqual({ kind: "fails-open", note: "the acceptance stop check's block counter is unreadable: EIO" });
  });

  it("is the gate the decision applies: a check failing alone blocks exactly when it is admitted, at the count it names", () => {
    const issuedArb = fc.oneof(fc.integer({ min: 0, max: CAP + 2 }).map(count), fc.constant(unreadable("lost")));
    fc.assert(fc.property(fc.constantFrom(...STOP_CHECK_NAMES), issuedArb, (name, issued) => {
      const admission = blockAdmission(name, issued, CAPS[name]);
      const failures = { acceptance: null, affected: null, mutation: null, [name]: "failing" };
      const decision = stopCheckBlockDecision({ acceptance: count(0), affected: count(0), mutation: count(0), [name]: issued }, failures, CAPS);
      if (admission.kind === "may-block") {
        expect(decision.outcome).toBe("block");
        if (decision.outcome === "block") expect(decision.blocking[name]?.blocks).toBe(admission.blocks);
      } else {
        expect(decision).toEqual({ outcome: "proceed", notes: [admission.note] });
      }
    }));
  });
});

describe("renderAffectedBlock", () => {
  const failing: NonEmpty<FailingAffectedTestcase> = [
    { file: "tests/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
    { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "collection-error" },
  ];

  it("names each failing test with its file, attributing a runner-cwd path to the changed repository file", () => {
    const message = renderAffectedBlock(failing, [], { declared: ["engine/tests/ledger.test.ts", "engine/src/ledger.ts"], repositoryRoot: "/work/repo" }, "", 2);

    expect(message).toContain("- 'ledger > balances' (engine/tests/ledger.test.ts) — failed");
    // A file no declared path matches keeps the identity the report gave.
    expect(message).toContain("- 'src/audit.test.ts' (src/audit.test.ts) — failed to collect");
    expect(message).toContain("at most 2 more time(s)");
    expect(message).not.toContain("Runner output");
  });

  it("attributes an absolute reported path inside the repository", () => {
    const message = renderAffectedBlock(
      [{ file: "/work/repo/src/a.test.ts", name: "a > works", outcome: "failed" }],
      [],
      { declared: ["src/a.test.ts"], repositoryRoot: "/work/repo" },
      "",
      0,
    );

    expect(message).toContain("- 'a > works' (src/a.test.ts) — failed");
  });

  it("lists expected-RED acceptance failures as not blocking, after the failures that block", () => {
    const message = renderAffectedBlock(failing, [{ file: SURFACE.acceptance, name: AS_002 }], { declared: [], repositoryRoot: null }, "", 1);

    expect(message.indexOf(AFFECTED_EXCUSED_HEADING)).toBeGreaterThan(message.indexOf("ledger > balances"));
    expect(message).toContain(`${AFFECTED_EXCUSED_HEADING}\n- '${AS_002}' (${SURFACE.acceptance})`);
    expect(renderAffectedBlock(failing, [], { declared: [], repositoryRoot: null }, "", 1)).not.toContain(AFFECTED_EXCUSED_HEADING);
  });

  it("appends the runner output tail when there is one", () => {
    const message = renderAffectedBlock(failing, [], { declared: [], repositoryRoot: null }, "FAIL tests/ledger.test.ts\n", 1);

    expect(message).toContain("Runner output (tail):\nFAIL tests/ledger.test.ts");
    expect(message.endsWith("\n")).toBe(false);
  });
});

describe("renderStopChecksBlock", () => {
  it("AS-028: lists the acceptance part, then the affected part, each under its own heading", () => {
    const message = renderStopChecksBlock({ acceptance: "owed AS-001 still failing", affected: "ledger > balances failing", mutation: "a guard survived" });

    const acceptance = message.indexOf(ACCEPTANCE_BLOCK_HEADING);
    const owed = message.indexOf("owed AS-001");
    const affected = message.indexOf(AFFECTED_BLOCK_HEADING);
    const ledger = message.indexOf("ledger > balances");
    const mutation = message.indexOf(MUTATION_BLOCK_HEADING);
    const guard = message.indexOf("a guard survived");
    expect(acceptance).toBe(0);
    expect([acceptance, owed, affected, ledger, mutation, guard].every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!))).toBe(true);
  });

  it("carries a heading only for a check that contributes failures", () => {
    const affectedOnly = renderStopChecksBlock({ acceptance: null, affected: "ledger > balances failing", mutation: null });
    expect(affectedOnly).toBe(`${AFFECTED_BLOCK_HEADING}\n\nledger > balances failing`);
    expect(affectedOnly).not.toContain(ACCEPTANCE_BLOCK_HEADING);

    const acceptanceOnly = renderStopChecksBlock({ acceptance: "owed AS-001 still failing", affected: null, mutation: null });
    expect(acceptanceOnly).toBe(`${ACCEPTANCE_BLOCK_HEADING}\n\nowed AS-001 still failing`);
    expect(acceptanceOnly).not.toContain(AFFECTED_BLOCK_HEADING);

    expect(renderStopChecksBlock({ acceptance: null, affected: null, mutation: "a guard survived" })).toBe(`${MUTATION_BLOCK_HEADING}\n\na guard survived`);
  });
});

describe("mapSomeChecks", () => {
  const ZERO = { acceptance: count(0), affected: count(0), mutation: count(0) };
  type Markers = StopCheckFailures<string, string, string>;

  it("maps each check a block names, with its name, and leaves the others empty", () => {
    const failing: Markers = { acceptance: null, affected: "F", mutation: "M" };
    const decision = stopCheckBlockDecision(ZERO, failing, CAPS);
    if (decision.outcome !== "block") throw new Error("two failing checks under their caps block");
    expect(mapSomeChecks<Blocking<string>, string>(decision.blocking, (name, { failure, blocks }) => `${name}:${failure}:${blocks}`))
      .toEqual({ acceptance: null, affected: "affected:F:1", mutation: "mutation:M:1" });
  });

  it("property: the parts fill exactly the slots the block fills, each from its own check, in check order", () => {
    const failure = (marker: string) => fc.constantFrom<string | null>(marker, null);
    const failures: fc.Arbitrary<Markers> = fc.record({ acceptance: failure("A"), affected: failure("F"), mutation: failure("M") })
      .filter(({ acceptance, affected, mutation }) => acceptance !== null || affected !== null || mutation !== null);
    fc.assert(fc.property(failures, (failing) => {
      const decision = stopCheckBlockDecision(ZERO, failing, CAPS);
      if (decision.outcome !== "block") throw new Error("a failing check under its cap blocks");
      const named: StopCheckName[] = [];
      const parts = mapSomeChecks<Blocking<string>, string>(decision.blocking, (name, { failure: marker }) => {
        named.push(name);
        return `${name}:${marker}`;
      });
      for (const name of STOP_CHECK_NAMES) expect(parts[name]).toBe(failing[name] === null ? null : `${name}:${failing[name]}`);
      expect(named).toEqual(STOP_CHECK_NAMES.filter((name) => failing[name] !== null));
    }));
  });
});
