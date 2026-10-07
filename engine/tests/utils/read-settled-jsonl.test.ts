/**
 * Pins the SubagentStop flush-race read: a torn final JSONL record is re-read
 * within a bounded budget, never repaired, and read failures are never retried.
 * The read and sleep ports are plain fakes, so the race is reproduced
 * deterministically.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCompleteClaudeJsonl } from "../../src/core/claude-transcript-integrity";
import {
  DEFAULT_SETTLE_POLICY,
  hasCompleteJsonlTail,
  parseSettlePolicy,
  readSettledJsonl,
  type SettlePolicy,
} from "../../src/utils/read-settled-jsonl";

const RECORD = JSON.stringify({ type: "user", message: { role: "user", content: "go" } });
const COMPLETE = `${RECORD}\n${JSON.stringify({ type: "attachment" })}\n`;
const TORN = `${RECORD}\n{"type":"attach`;

function policy(attempts: number, delayMs: number): SettlePolicy {
  const parsed = parseSettlePolicy({ attempts, delayMs });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const POLICY = policy(4, 7);

/** A read port that serves `reads` in order, repeating the last one. */
function scriptedReads(reads: readonly string[]): Readonly<{ read: () => string; count: () => number }> {
  let calls = 0;
  return {
    read: () => reads[Math.min(calls++, reads.length - 1)] ?? "",
    count: () => calls,
  };
}

function recordingSleep(): Readonly<{ sleep: (ms: number) => Promise<void>; delays: number[] }> {
  const delays: number[] = [];
  return { sleep: async (ms) => { delays.push(ms); }, delays };
}

describe("hasCompleteJsonlTail", () => {
  it("accepts only non-empty bytes ending on a record boundary", () => {
    expect(hasCompleteJsonlTail(COMPLETE)).toBe(true);
    expect(hasCompleteJsonlTail(TORN)).toBe(false);
    expect(hasCompleteJsonlTail("")).toBe(false);
  });

  it("never accepts a prefix that the strict parser would refuse", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: COMPLETE.length }), (cut) => {
      const prefix = COMPLETE.slice(0, cut);
      if (hasCompleteJsonlTail(prefix)) expect(parseCompleteClaudeJsonl(prefix).kind).toBe("complete");
    }));
  });
});

describe("parseSettlePolicy", () => {
  it("accepts exactly positive-integer attempts with a non-negative integer delay", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000 }),
      fc.integer({ min: 0, max: 10_000 }),
      (attempts, delayMs) => {
        const parsed = parseSettlePolicy({ attempts, delayMs });
        expect(parsed.ok && parsed.value).toEqual({ attempts, delayMs });
        expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
      },
    ));
    expect(DEFAULT_SETTLE_POLICY).toEqual({ attempts: 20, delayMs: 100 });
  });

  it.each([
    ["zero attempts", 0, 100, "attempts"],
    ["negative attempts", -3, 100, "attempts"],
    ["fractional attempts", 2.5, 100, "attempts"],
    ["NaN attempts", Number.NaN, 100, "attempts"],
    ["infinite attempts", Number.POSITIVE_INFINITY, 100, "attempts"],
    ["negative delay", 3, -1, "delayMs"],
    ["fractional delay", 3, 0.5, "delayMs"],
    ["NaN delay", 3, Number.NaN, "delayMs"],
  ])("rejects a nonsensical budget: %s", (_label, attempts, delayMs, field) => {
    const parsed = parseSettlePolicy({ attempts, delayMs });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(field);
  });
});

describe("readSettledJsonl", () => {
  it("performs exactly one read under a single-attempt budget, even when torn", async () => {
    const reads = scriptedReads([TORN, COMPLETE]);
    const clock = recordingSleep();
    await expect(readSettledJsonl(reads.read, clock.sleep, policy(1, 7))).resolves.toBe(TORN);
    expect(reads.count()).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it("returns a complete first read without sleeping", async () => {
    const reads = scriptedReads([COMPLETE]);
    const clock = recordingSleep();
    await expect(readSettledJsonl(reads.read, clock.sleep, POLICY)).resolves.toBe(COMPLETE);
    expect(reads.count()).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it("re-reads a torn tail until the harness finishes the record", async () => {
    const reads = scriptedReads([TORN, "", COMPLETE]);
    const clock = recordingSleep();
    const settled = await readSettledJsonl(reads.read, clock.sleep, POLICY);
    expect(settled).toBe(COMPLETE);
    expect(parseCompleteClaudeJsonl(settled).kind).toBe("complete");
    expect(clock.delays).toEqual([7, 7]);
  });

  it("returns the last torn bytes unchanged once the budget is spent, so the strict parser still fails closed", async () => {
    const reads = scriptedReads([TORN]);
    const clock = recordingSleep();
    const settled = await readSettledJsonl(reads.read, clock.sleep, POLICY);
    expect(settled).toBe(TORN);
    expect(reads.count()).toBe(POLICY.attempts);
    expect(clock.delays).toHaveLength(POLICY.attempts - 1);
    expect(parseCompleteClaudeJsonl(settled).kind).toBe("malformed");
  });

  it("propagates a read failure on the first attempt without retrying", async () => {
    const clock = recordingSleep();
    let calls = 0;
    const failing = (): string => {
      calls += 1;
      throw new Error("EISDIR: illegal operation on a directory");
    };
    await expect(readSettledJsonl(failing, clock.sleep, POLICY)).rejects.toThrow("EISDIR");
    expect(calls).toBe(1);
    expect(clock.delays).toEqual([]);
  });
});
