/**
 * Pins the SubagentStop flush-race read: a torn final JSONL record is re-read
 * within a bounded budget, never repaired, and read failures are never retried.
 * The read and sleep ports are plain fakes, so the race is reproduced
 * deterministically.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCompleteClaudeJsonl } from "../../src/core/claude-transcript-integrity";
import { hasCompleteJsonlTail, readSettledJsonl, type SettlePolicy } from "../../src/utils/read-settled-jsonl";

const RECORD = JSON.stringify({ type: "user", message: { role: "user", content: "go" } });
const COMPLETE = `${RECORD}\n${JSON.stringify({ type: "attachment" })}\n`;
const TORN = `${RECORD}\n{"type":"attach`;
const POLICY: SettlePolicy = { attempts: 4, delayMs: 7 };

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

describe("readSettledJsonl", () => {
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
