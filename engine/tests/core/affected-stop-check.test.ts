/**
 * Unit and property tests for the affected stop check's pure core (AD-10):
 * - `judgeAffectedRun` names every failing affected testcase with its file
 *   and name, collection errors included, and passes a zero-test report with
 *   a note (AS-023);
 * - `stopCheckBlockDecision` is the whole block-counter transition rule for
 *   both checks: 0 → 1 → 2 → 3, then the cap fails open; an unreadable count
 *   fails open; each check has its own cap (AS-029); a proceeding stop clears
 *   both counters; each check's cap note states that check's own cap. A
 *   property asserts no agent is blocked more than its cap by either check
 *   (SC-005);
 * - `renderAffectedBlock` and `renderStopChecksBlock` build the one combined
 *   message, with a heading per contributing check (AS-028).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_BLOCK_HEADING,
  AFFECTED_BLOCK_HEADING,
  AFFECTED_NOTE_TEXT,
  AFFECTED_STOP_CHECK_MAX_BLOCKS,
  type FailingAffectedTestcase,
  type StopCheckBlockCount,
} from "../../src/core/affected-stop-check-types";
import {
  judgeAffectedRun,
  renderAffectedBlock,
  renderStopChecksBlock,
  stopCheckBlockDecision,
  type CheckVerdict,
  type StopCheckBlockCaps,
  type StopCheckName,
} from "../../src/core/affected-stop-check";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { parseJunitTestcases, type JunitTestcasesResult } from "../../src/core/structured-test-report";

type Case = Readonly<{ file: string; name: string; outcome: "passed" | "failed" | "skipped" }>;

const junit = (cases: readonly Case[]): JunitTestcasesResult => parseJunitTestcases(new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites tests="${cases.length}"><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) =>
    `<testcase classname="${file}" name="${name}">` +
    (outcome === "failed" ? `<failure type="AssertionError" message="expected 1 to be 2"/>` : "") +
    (outcome === "skipped" ? "<skipped/>" : "") +
    "</testcase>").join("") +
  "</testsuite></testsuites>"));

const CAP = AFFECTED_STOP_CHECK_MAX_BLOCKS;
/** Both checks at the production cap of 3. The acceptance constant lives in
 *  the acceptance shell, which this pure core's tests do not import. */
const CAPS: StopCheckBlockCaps = { acceptance: CAP, affected: CAP };
const count = (blocks: number): StopCheckBlockCount => ({ kind: "count", blocks });
const unreadable = (reason: string): StopCheckBlockCount => ({ kind: "unreadable", reason });

describe("judgeAffectedRun", () => {
  it("is unobservable when the report could not be parsed, naming why", () => {
    const verdict = judgeAffectedRun(parseJunitTestcases(new TextEncoder().encode("not a report")));

    expect(verdict.kind).toBe("unobservable");
    if (verdict.kind === "unobservable") expect(verdict.reason).toMatch(/report could not be read: .+/);
  });

  it("AS-023: passes a report with zero testcases as zero-tests", () => {
    expect(judgeAffectedRun(junit([]))).toEqual({ kind: "passed", observed: "zero-tests" });
  });

  it("passes when every testcase passed or was skipped", () => {
    expect(judgeAffectedRun(junit([
      { file: "src/a.test.ts", name: "a > works", outcome: "passed" },
      { file: "src/b.test.ts", name: "b > todo", outcome: "skipped" },
    ]))).toEqual({ kind: "passed", observed: "some-tests" });
  });

  it("names every failing testcase with its reported file and name, in report order, and a file that failed to collect", () => {
    expect(judgeAffectedRun(junit([
      { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
      { file: "src/ledger.test.ts", name: "ledger > opens", outcome: "passed" },
      { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "failed" },
      { file: "src/x.test.ts", name: "x > todo", outcome: "skipped" },
    ]))).toEqual({
      kind: "failing",
      testcases: [
        { file: "src/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
        { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "collection-error" },
      ],
    });
  });
});

describe("stopCheckBlockDecision", () => {
  const notFailing: Record<StopCheckName, CheckVerdict> = { acceptance: "not-failing", affected: "not-failing" };

  it("proceeds with no notes when neither check is failing, whatever the counts", () => {
    for (const issued of [count(0), count(CAP), unreadable("EACCES")]) {
      expect(stopCheckBlockDecision({ acceptance: issued, affected: issued }, notFailing, CAPS)).toEqual({ outcome: "proceed", notes: [] });
    }
  });

  it("walks a failing affected check from 0 to 1 to 2 to 3 blocks, then fails open at the cap", () => {
    const verdicts = { acceptance: "not-failing", affected: "failing" } as const;
    for (const blocks of [0, 1, 2]) {
      expect(stopCheckBlockDecision({ acceptance: count(0), affected: count(blocks) }, verdicts, CAPS)).toEqual({
        outcome: "block",
        record: { acceptance: { kind: "keep" }, affected: { kind: "set", blocks: blocks + 1 } },
        notes: [],
      });
    }
    expect(stopCheckBlockDecision({ acceptance: count(0), affected: count(CAP) }, verdicts, CAPS))
      .toEqual({ outcome: "proceed", notes: [AFFECTED_NOTE_TEXT["cap-reached"]] });
  });

  it("fails open with a note naming the cause when a failing check's counter is unreadable", () => {
    const decision = stopCheckBlockDecision({ acceptance: count(0), affected: unreadable("counter.json is not JSON") }, { acceptance: "not-failing", affected: "failing" }, CAPS);

    expect(decision).toEqual({ outcome: "proceed", notes: [`${AFFECTED_NOTE_TEXT["counter-unreadable"]}: counter.json is not JSON`] });
  });

  it("fails the acceptance check open on its own cap and unreadable counter, with its own notes", () => {
    const verdicts = { acceptance: "failing", affected: "not-failing" } as const;

    expect(stopCheckBlockDecision({ acceptance: count(CAP), affected: count(0) }, verdicts, CAPS))
      .toEqual({ outcome: "proceed", notes: [`the acceptance stop check reached its ${CAP}-block cap`] });
    expect(stopCheckBlockDecision({ acceptance: unreadable("EIO"), affected: count(0) }, verdicts, CAPS))
      .toEqual({ outcome: "proceed", notes: ["the acceptance stop check's block counter is unreadable: EIO"] });
  });

  it("AS-029: keeps an independent cap per check: one at its cap does not stop the other from blocking", () => {
    const failing = { acceptance: "failing", affected: "failing" } as const;

    expect(stopCheckBlockDecision({ acceptance: count(1), affected: count(CAP) }, failing, CAPS)).toEqual({
      outcome: "block",
      record: { acceptance: { kind: "set", blocks: 2 }, affected: { kind: "keep" } },
      notes: [AFFECTED_NOTE_TEXT["cap-reached"]],
    });
    expect(stopCheckBlockDecision({ acceptance: count(CAP), affected: count(0) }, failing, CAPS)).toEqual({
      outcome: "block",
      record: { acceptance: { kind: "keep" }, affected: { kind: "set", blocks: 1 } },
      notes: [`the acceptance stop check reached its ${CAP}-block cap`],
    });
  });

  it("states each check's own cap in its note when the caps differ", () => {
    const failing = { acceptance: "failing", affected: "failing" } as const;
    const caps: StopCheckBlockCaps = { acceptance: 5, affected: CAP };

    // The acceptance check keeps blocking past the affected cap, up to its own.
    expect(stopCheckBlockDecision({ acceptance: count(CAP), affected: count(CAP) }, failing, caps)).toEqual({
      outcome: "block",
      record: { acceptance: { kind: "set", blocks: CAP + 1 }, affected: { kind: "keep" } },
      notes: [AFFECTED_NOTE_TEXT["cap-reached"]],
    });
    expect(stopCheckBlockDecision({ acceptance: count(5), affected: count(CAP) }, failing, caps))
      .toEqual({ outcome: "proceed", notes: ["the acceptance stop check reached its 5-block cap", AFFECTED_NOTE_TEXT["cap-reached"]] });
  });

  it("records count + 1 for each check that contributes failures to the block", () => {
    expect(stopCheckBlockDecision({ acceptance: count(0), affected: count(2) }, { acceptance: "failing", affected: "failing" }, CAPS)).toEqual({
      outcome: "block",
      record: { acceptance: { kind: "set", blocks: 1 }, affected: { kind: "set", blocks: 3 } },
      notes: [],
    });
  });

  it("SC-005: no agent is ever blocked more than the cap by either check, and every stop sequence ends", () => {
    const verdict = fc.constantFrom<CheckVerdict>("failing", "not-failing");
    const stop = fc.record({ acceptance: verdict, affected: verdict, unreadable: fc.constantFrom<StopCheckName | null>(null, null, null, "acceptance", "affected") });

    fc.assert(fc.property(fc.array(stop, { minLength: 1, maxLength: 20 }), (stops) => {
      const counters: Record<StopCheckName, number> = { acceptance: 0, affected: 0 };
      const contributed: Record<StopCheckName, number> = { acceptance: 0, affected: 0 };
      let blocks = 0;
      for (const { acceptance, affected, unreadable: lost } of stops) {
        const issued = (name: StopCheckName): StopCheckBlockCount => lost === name ? unreadable("lost") : count(counters[name]);
        const decision = stopCheckBlockDecision({ acceptance: issued("acceptance"), affected: issued("affected") }, { acceptance, affected }, CAPS);
        if (decision.outcome === "proceed") break; // the agent's stop proceeds: it ends.
        blocks += 1;
        expect([acceptance, affected]).toContain("failing");
        for (const name of ["acceptance", "affected"] as const) {
          const write = decision.record[name];
          if (write.kind === "set") {
            expect(write.blocks).toBe(counters[name] + 1);
            counters[name] = write.blocks;
            contributed[name] += 1;
          }
        }
        expect(contributed.acceptance).toBeLessThanOrEqual(CAP);
        expect(contributed.affected).toBeLessThanOrEqual(CAP);
      }
      // A lost counter only ever fails open, so blocks stay bounded by both caps together.
      expect(blocks).toBeLessThanOrEqual(2 * CAP);
    }));
  });

  it("SC-005: an agent failing both checks forever is blocked exactly the cap, then proceeds", () => {
    const counters: Record<StopCheckName, number> = { acceptance: 0, affected: 0 };
    let blocks = 0;
    for (;;) {
      const decision = stopCheckBlockDecision({ acceptance: count(counters.acceptance), affected: count(counters.affected) }, { acceptance: "failing", affected: "failing" }, CAPS);
      if (decision.outcome === "proceed") {
        expect(decision.notes).toEqual([`the acceptance stop check reached its ${CAP}-block cap`, AFFECTED_NOTE_TEXT["cap-reached"]]);
        break;
      }
      blocks += 1;
      for (const name of ["acceptance", "affected"] as const) {
        const write = decision.record[name];
        if (write.kind === "set") counters[name] = write.blocks;
      }
    }
    expect(blocks).toBe(CAP);
  });
});

describe("renderAffectedBlock", () => {
  const failing: NonEmpty<FailingAffectedTestcase> = [
    { file: "tests/ledger.test.ts", name: "ledger > balances", outcome: "failed" },
    { file: "src/audit.test.ts", name: "src/audit.test.ts", outcome: "collection-error" },
  ];

  it("names each failing test with its file, attributing a runner-cwd path to the changed repository file", () => {
    const message = renderAffectedBlock(failing, { declared: ["engine/tests/ledger.test.ts", "engine/src/ledger.ts"], repositoryRoot: "/work/repo" }, "", 2);

    expect(message).toContain("- 'ledger > balances' (engine/tests/ledger.test.ts) — failed");
    // A file no declared path matches keeps the identity the report gave.
    expect(message).toContain("- 'src/audit.test.ts' (src/audit.test.ts) — failed to collect");
    expect(message).toContain("at most 2 more time(s)");
    expect(message).not.toContain("Runner output");
  });

  it("attributes an absolute reported path inside the repository", () => {
    const message = renderAffectedBlock(
      [{ file: "/work/repo/src/a.test.ts", name: "a > works", outcome: "failed" }],
      { declared: ["src/a.test.ts"], repositoryRoot: "/work/repo" },
      "",
      0,
    );

    expect(message).toContain("- 'a > works' (src/a.test.ts) — failed");
  });

  it("appends the runner output tail when there is one", () => {
    const message = renderAffectedBlock(failing, { declared: [], repositoryRoot: null }, "FAIL tests/ledger.test.ts\n", 1);

    expect(message).toContain("Runner output (tail):\nFAIL tests/ledger.test.ts");
    expect(message.endsWith("\n")).toBe(false);
  });
});

describe("renderStopChecksBlock", () => {
  it("AS-028: lists the acceptance part, then the affected part, each under its own heading", () => {
    const message = renderStopChecksBlock({ acceptance: "owed AS-001 still failing", affected: "ledger > balances failing" });

    const acceptance = message.indexOf(ACCEPTANCE_BLOCK_HEADING);
    const owed = message.indexOf("owed AS-001");
    const affected = message.indexOf(AFFECTED_BLOCK_HEADING);
    const ledger = message.indexOf("ledger > balances");
    expect(acceptance).toBe(0);
    expect([acceptance, owed, affected, ledger].every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]!))).toBe(true);
  });

  it("carries a heading only for a check that contributes failures", () => {
    const affectedOnly = renderStopChecksBlock({ acceptance: null, affected: "ledger > balances failing" });
    expect(affectedOnly).toBe(`${AFFECTED_BLOCK_HEADING}\n\nledger > balances failing`);
    expect(affectedOnly).not.toContain(ACCEPTANCE_BLOCK_HEADING);

    const acceptanceOnly = renderStopChecksBlock({ acceptance: "owed AS-001 still failing", affected: null });
    expect(acceptanceOnly).toBe(`${ACCEPTANCE_BLOCK_HEADING}\n\nowed AS-001 still failing`);
    expect(acceptanceOnly).not.toContain(AFFECTED_BLOCK_HEADING);
  });
});
