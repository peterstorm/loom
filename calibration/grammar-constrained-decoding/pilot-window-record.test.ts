import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERE, LOADED, testWindowRecord as windowRecord, UNREACHABLE_FACTS } from "./pilot-test-fixtures";
import { CONSECUTIVE_OUTAGE_PAIR_LIMIT, parseWindowEnding, type WindowEnding } from "./pilot-window-ending";
import {
  DISPATCHED,
  describeWindowEnding,
  encodeWindowRecord,
  parseRetainedWindow,
  type ClosedWindowRecord,
} from "./pilot-window-record";

/**
 * `window.json` at its codec (`pilot-window-record.ts`): what a re-decision
 * reads back of a retained record of either schema version — the
 * preregistration reference, the facts, and the ending under the rules of the
 * version that wrote it, cross-checked against the recorded observation count
 * — and the operator-facing line for an aborted window. That `recordWindow`
 * writes through this codec is pinned in pilot-retention.test.ts.
 */

const ending = (raw: unknown): WindowEnding => {
  const parsed = parseWindowEnding(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("parseRetainedWindow (the retained record read back)", () => {
  it("reads back a retained window's preregistration record and facts, and refuses one without them", () => {
    const text = encodeWindowRecord(windowRecord(false));
    expect(parseRetainedWindow(text, "w.json")).toEqual({
      ok: true,
      value: { preregistration: LOADED.ref, facts: UNREACHABLE_FACTS, ending: { kind: "open" } },
    });
    expect(parseRetainedWindow(JSON.stringify({ preflightFacts: UNREACHABLE_FACTS }), "w.json")).toEqual({ ok: false, error: "w.json carries no preregistration record" });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), preflightFacts: {} }), "w.json"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json preflight facts: /) });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), schemaVersion: 3 }), "w.json"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json is not a schemaVersion 1 or 2 window record: schemaVersion: /) });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), dispatch: { kind: "maybe" } }), "w.json"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json is not a schemaVersion 1 or 2 window record: dispatch/) });
    expect(parseRetainedWindow("{", "w.json")).toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json: /) });
  });

  describe("reads a retained window's ending back (parse, don't validate)", () => {
    const COMPLETED = { kind: "completed", pairs: 4 };
    const ABORTED = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-outage-pairs", pairs: 3 } };
    const LEGACY = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-infrastructure-failures", pairs: 3 } };
    /** Two samples per pair the ending dispatched (none for a window that never dispatched). */
    const samplesOf = (recorded: unknown): number => {
      const shape = recorded as { kind?: string; pairs?: number; afterPairs?: number } | undefined;
      return 2 * (shape?.kind === "completed" ? shape.pairs ?? 0 : shape?.afterPairs ?? 0);
    };
    const closed = (version: 1 | 2, dispatched: boolean, recorded?: unknown, observations = samplesOf(recorded)): string => JSON.stringify({
      ...windowRecord(dispatched), schemaVersion: version, endedAt: "2026-10-05T09:00:00.000Z", observations, ...(recorded === undefined ? {} : { ending: recorded }),
    });
    const endingOf = (text: string) => {
      const parsed = parseRetainedWindow(text, "w.json");
      return parsed.ok ? parsed.value.ending : parsed;
    };

    it("parses a closed dispatched window's ending, completed or aborted", () => {
      expect(endingOf(closed(2, true, COMPLETED))).toEqual({ kind: "dispatched", ending: COMPLETED });
      expect(endingOf(closed(2, true, ABORTED))).toEqual({ kind: "dispatched", ending: ABORTED });
      // A window retained at e8d688d8 (schemaVersion 1) parses its ending too, legacy reason included.
      expect(endingOf(closed(1, true, LEGACY))).toEqual({ kind: "dispatched", ending: LEGACY });
    });

    it("admits a missing ending only on a schemaVersion 1 window retained before the field existed", () => {
      expect(endingOf(closed(1, true, undefined, 816))).toEqual({ kind: "dispatched-unrecorded" });
      expect(endingOf(closed(2, true))).toEqual({ ok: false, error: "w.json is a closed dispatched schemaVersion 2 window without its ending" });
      expect(endingOf(closed(1, false))).toEqual({ kind: "not-dispatched" });
      expect(endingOf(closed(2, false))).toEqual({ kind: "not-dispatched" });
    });

    it("refuses an ending where none can exist, and a corrupt or out-of-version ending", () => {
      expect(endingOf(closed(2, false, COMPLETED))).toEqual({ ok: false, error: "w.json never dispatched, yet records an ending" });
      expect(endingOf(JSON.stringify({ ...windowRecord(true), ending: COMPLETED }))).toEqual({ ok: false, error: "w.json records an ending but was never closed" });
      expect(endingOf(closed(2, true, LEGACY))).toMatchObject({ ok: false, error: expect.stringContaining("the consecutive-infrastructure-failures reason exists only in a schemaVersion 1 window") });
      expect(endingOf(closed(1, true, ABORTED))).toMatchObject({ ok: false, error: expect.stringContaining("the consecutive-outage-pairs reason exists only in a schemaVersion 2 window") });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 5 }))).toMatchObject({ ok: false, error: expect.stringContaining("aborted after 5 of 4 scheduled pairs") });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 0 }))).toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json invalid window ending: afterPairs/) });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 2 }))).toMatchObject({ ok: false, error: expect.stringContaining("3 consecutive pairs exceed the 2 dispatched") });
      expect(endingOf(closed(2, true, { kind: "completed" }))).toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json invalid window ending: pairs/) });
    });

    it("refuses a schemaVersion 2 window aborted after its last pair, but reads one recorded by e8d688d8 as it was recorded", () => {
      const lastPair = { ...ABORTED, afterPairs: 4, reason: { kind: "route-unreachable", reason: "down" } };
      expect(endingOf(closed(2, true, lastPair))).toMatchObject({
        ok: false, error: expect.stringContaining("aborted after all 4 scheduled pairs: a schedule dispatched in full ends completed"),
      });
      // e8d688d8 judged the last pair too: its retained windows stay readable exactly as recorded.
      expect(endingOf(closed(1, true, lastPair))).toEqual({ kind: "dispatched", ending: lastPair });
    });

    it("refuses an ending whose dispatched pairs disagree with the observations recorded beside it", () => {
      expect(endingOf(closed(2, true, COMPLETED, 7))).toEqual({ ok: false, error: "w.json records 7 observations, but its ending dispatched 4 pairs (8 samples)" });
      expect(endingOf(closed(2, true, ABORTED, 8))).toEqual({ ok: false, error: "w.json records 8 observations, but its ending dispatched 3 pairs (6 samples)" });
      expect(endingOf(closed(2, false, undefined, 2))).toEqual({ ok: false, error: "w.json never dispatched, yet records 2 observations" });
      const { observations: _dropped, ...withoutCount } = JSON.parse(closed(2, true, COMPLETED)) as Record<string, unknown>;
      expect(endingOf(JSON.stringify(withoutCount))).toEqual({ ok: false, error: "w.json was closed without its observation count" });
    });
  });

  it("reads the retained 2026-10-09 pilot-2 window back as the route-unreachable abort it recorded", () => {
    const path = join(HERE, "windows", "gcd-ad11-pilot-2--2026-10-09T08-35-45-959Z", "window.json");
    const parsed = parseRetainedWindow(readFileSync(path, "utf-8"), path);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.ending).toMatchObject({
      kind: "dispatched",
      ending: { kind: "aborted", afterPairs: 13, scheduledPairs: 408, reason: { kind: "route-unreachable" } },
    });
  });
});

describe("describeWindowEnding (the operator-facing line)", () => {
  const closedWith = (recorded: WindowEnding, observations: number): ClosedWindowRecord =>
    ({ ...windowRecord(true), dispatch: DISPATCHED, endedAt: "2026-10-05T09:00:00.000Z", observations, ending: recorded });

  it("names an aborted window's pairs and why the fail-fast stopped it", () => {
    expect(describeWindowEnding(closedWith(ending({ kind: "aborted", afterPairs: 13, scheduledPairs: 408, reason: { kind: "route-unreachable", reason: "GET /v1/models: refused" } }), 26)))
      .toBe("pilot window ABORTED after 13/408 pairs: the route stopped answering: GET /v1/models: refused. Every landed sample is retained; the rest are unmeasured.");
    const outage = ending({ kind: "aborted", afterPairs: 5, scheduledPairs: 408, reason: { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } });
    expect(describeWindowEnding(closedWith(outage, 10)))
      .toBe(`pilot window ABORTED after 5/408 pairs: ${CONSECUTIVE_OUTAGE_PAIR_LIMIT} consecutive pairs failed at the infrastructure or timed out. Every landed sample is retained; the rest are unmeasured.`);
  });

  it("says nothing for a completed schedule or a window that never dispatched (its decision says the rest)", () => {
    expect(describeWindowEnding(closedWith(ending({ kind: "completed", pairs: 408 }), 816))).toBeNull();
    const blocked = windowRecord(false);
    if (blocked.dispatch.kind !== "not-attempted") throw new Error("a blocked preflight never dispatches");
    expect(describeWindowEnding({ ...blocked, dispatch: blocked.dispatch, endedAt: "2026-10-05T09:00:00.000Z", observations: 0 })).toBeNull();
  });
});
