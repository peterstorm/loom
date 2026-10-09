import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SampleObservation } from "./pilot-observation";
import type { RouteProbe } from "./pilot-preflight";
import { buildPairSchedule, type ScheduledPair } from "./pilot-preregistration";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, HERE, INFRASTRUCTURE, PILOT_1, REJECTED, sample, TIMEOUT } from "./pilot-test-fixtures";
import type { PilotArm } from "./pilot-vocabulary";
import {
  CONSECUTIVE_OUTAGE_PAIR_LIMIT,
  dispatchedPairsOf,
  landPair,
  observedRouteHealth,
  pairHealth,
  parseRetainedWindowEnding,
  parseWindowEnding,
  routeHealthOf,
  routeProbeFailed,
  startSchedule,
  UNEXPLAINED_UNREACHABLE_REASON,
  type PairHealth,
  type RouteHealth,
  type ScheduleProgress,
} from "./pilot-window-ending";

/**
 * How a dispatched window ends, at its pure interface (`pilot-window-ending.ts`):
 * the route health the window records, what an outage looks like from inside
 * the window (`pairHealth`), the one fail-fast step (`startSchedule`,
 * `landPair`: which pairs are judged, when the route is re-probed, and every
 * ending it returns), and the `WindowEnding` codec keyed on the window's
 * schemaVersion. The dispatch shell that runs it is pinned end to end in
 * pilot-window.test.ts.
 */

const PAIR = buildPairSchedule(PILOT_1)[0] as ScheduledPair;
const DOWN = { kind: "unreachable", reason: "fetch failed (connect ECONNREFUSED)" } as const satisfies RouteHealth;

// One place states how a landed sample of each kind looks.
type SampleKind = "accepted" | "rejected" | "timeout" | "infrastructure";

/** One arm's landed sample of `kind`; a semantic rejection spends the attempt-2 retry before it is terminal. */
function landed(kind: SampleKind, arm: PilotArm, pair: ScheduledPair = PAIR): SampleObservation {
  switch (kind) {
    case "accepted": return sample(pair, arm, 10, [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION]);
    case "rejected": return sample(pair, arm, 10, [{ outcome: REJECTED }, { outcome: REJECTED }]);
    case "timeout": return sample(pair, arm, 10, [{ outcome: TIMEOUT }]);
    case "infrastructure": return sample(pair, arm, 10, [{ outcome: INFRASTRUCTURE }]);
  }
}

const isOutageLike = (kind: SampleKind): boolean => kind === "timeout" || kind === "infrastructure";

/** A pair whose two arms landed the same sample kind is named by it; the mixed pairs are the rest. */
type PairKind = SampleKind | "mixed-outage" | "mixed-infrastructure" | "mixed-timeout" | "rejected-and-timeout";

/** Each landed pair kind: its two arms' sample kinds, and the pair health it
 *  must have (outage-like = infrastructure or timeout, never a rejection). */
const PAIR_KINDS: Readonly<Record<PairKind, Readonly<{ samples: readonly [SampleKind, SampleKind]; health: PairHealth["kind"] }>>> = {
  "accepted": { samples: ["accepted", "accepted"], health: "none" },
  "rejected": { samples: ["rejected", "rejected"], health: "none" },
  "timeout": { samples: ["timeout", "timeout"], health: "all-outage" },
  "infrastructure": { samples: ["infrastructure", "infrastructure"], health: "all-outage" },
  "mixed-outage": { samples: ["infrastructure", "timeout"], health: "all-outage" },
  "mixed-infrastructure": { samples: ["infrastructure", "accepted"], health: "needs-probe" },
  "mixed-timeout": { samples: ["accepted", "timeout"], health: "needs-probe" },
  "rejected-and-timeout": { samples: ["rejected", "timeout"], health: "needs-probe" },
};
const PAIR_KIND_NAMES = Object.keys(PAIR_KINDS) as PairKind[];

const landedPair = (kind: PairKind): readonly SampleObservation[] => {
  const [emission, extraction] = PAIR_KINDS[kind].samples;
  return [landed(emission, "emission-enabled"), landed(extraction, "extraction-only")];
};

describe("route health (what the window records of the route)", () => {
  it("reads the preflight's route fact: only an unreachable route is unhealthy", () => {
    const probes: readonly RouteProbe[] = [
      { kind: "reachable", servedModels: ["glm"] },
      { kind: "reachable", servedModels: [] },
      { kind: "served-model-unverified", reason: "GET /models answered HTTP 401" },
    ];
    for (const probe of probes) expect(routeHealthOf(probe), probe.kind).toEqual({ kind: "reachable" });
    expect(routeHealthOf({ kind: "unreachable", reason: "GET /models: refused" })).toEqual({ kind: "unreachable", reason: "GET /models: refused" });
  });

  it("never records an empty unreachable reason, whatever the probe answered (property)", () => {
    fc.assert(fc.property(fc.string(), (reason) => {
      const blank = reason.trim() === "";
      const expected = { kind: "unreachable", reason: blank ? UNEXPLAINED_UNREACHABLE_REASON : reason };
      expect(observedRouteHealth({ kind: "unreachable", reason })).toEqual(expected);
      expect(routeHealthOf({ kind: "unreachable", reason })).toEqual(expected);
      // Every recorded reason is one an ending accepts.
      const ending = parseWindowEnding({ kind: "aborted", afterPairs: 1, scheduledPairs: 2, reason: { kind: "route-unreachable", reason: expected.reason } }, 2);
      expect(ending.ok).toBe(true);
    }), { numRuns: 200 });
    expect(observedRouteHealth({ kind: "reachable" })).toEqual({ kind: "reachable" });
    expect(routeProbeFailed("fetch exploded")).toEqual({ kind: "unreachable", reason: "the route probe failed: fetch exploded" });
  });
});

describe("pairHealth (what an outage looks like from inside the window)", () => {
  const sampleKinds = fc.constantFrom<SampleKind>("accepted", "rejected", "timeout", "infrastructure");
  const arms = fc.constantFrom<PilotArm>("emission-enabled", "extraction-only");

  it("is none with no outage-like sample, all-outage when every sample is one, needs-probe otherwise (property)", () => {
    fc.assert(fc.property(fc.array(fc.record({ arm: arms, kind: sampleKinds }), { maxLength: 4 }), (specs) => {
      const outageLike = specs.filter(({ kind }) => isOutageLike(kind)).length;
      const expected = outageLike === 0 ? "none" : outageLike === specs.length ? "all-outage" : "needs-probe";
      expect(pairHealth(specs.map(({ kind, arm }) => landed(kind, arm)))).toEqual({ kind: expected });
    }), { numRuns: 200 });
  });

  it("classifies each landed pair kind", () => {
    for (const kind of PAIR_KIND_NAMES) expect(pairHealth(landedPair(kind)), kind).toEqual({ kind: PAIR_KINDS[kind].health });
  });
});

describe("startSchedule / landPair (the one fail-fast step)", () => {
  type Step = Readonly<{ kind: PairKind; routeDown: boolean }>;
  const steps = fc.array(fc.record({ kind: fc.constantFrom(...PAIR_KIND_NAMES), routeDown: fc.boolean() }), { minLength: 12, maxLength: 12 });

  /** Runs a schedule of `scheduled` pairs through the step as the shell does,
   *  answering each re-probe the step asks for as `routeDown` says. */
  function run(scheduled: number, script: readonly Step[]) {
    let progress: ScheduleProgress = startSchedule(scheduled);
    const probedAfter: number[] = [];
    let landedPairs = 0;
    for (const { kind, routeDown } of script) {
      if (progress.kind === "ended") break;
      const step = landPair(progress.breaker, landedPair(kind));
      landedPairs += 1;
      if (step.kind === "probe-route") probedAfter.push(landedPairs);
      progress = step.kind === "probe-route" ? step.judge(routeDown ? DOWN : { kind: "reachable" }) : step;
    }
    return { progress, probedAfter, landedPairs };
  }

  /** The rule restated: what ending a schedule reaches, and after which pairs it re-probes. */
  function expectedRun(scheduled: number, script: readonly Step[]) {
    const probedAfter: number[] = [];
    let streak = 0;
    for (const [index, { kind, routeDown }] of script.slice(0, scheduled).entries()) {
      const afterPairs = index + 1;
      if (afterPairs === scheduled) break;
      const { health } = PAIR_KINDS[kind];
      streak = health === "all-outage" ? streak + 1 : 0;
      if (health === "none") continue;
      probedAfter.push(afterPairs);
      if (routeDown) return { probedAfter, ending: { kind: "aborted", afterPairs, scheduledPairs: scheduled, reason: { kind: "route-unreachable", reason: DOWN.reason } } };
      if (streak >= CONSECUTIVE_OUTAGE_PAIR_LIMIT) {
        return { probedAfter, ending: { kind: "aborted", afterPairs, scheduledPairs: scheduled, reason: { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } } };
      }
    }
    return { probedAfter, ending: { kind: "completed", pairs: scheduled } };
  }

  it("ends every schedule exactly as the rule says: on an unreachable re-probe, on the consecutive all-outage limit, or completed (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), steps, (scheduled, script) => {
      const { progress, probedAfter, landedPairs } = run(scheduled, script);
      const expected = expectedRun(scheduled, script);
      expect(progress.kind).toBe("ended");
      if (progress.kind !== "ended") return;
      expect(progress.ending).toEqual(expected.ending);
      expect(probedAfter).toEqual(expected.probedAfter);
      expect(landedPairs).toBe(dispatchedPairsOf(progress.ending));
    }), { numRuns: 400 });
  });

  it("never returns an ending parseWindowEnding refuses, and never asks to probe the last pair (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), steps, (scheduled, script) => {
      const { progress, probedAfter } = run(scheduled, script);
      if (progress.kind !== "ended") throw new Error("a schedule always ends by its last pair");
      // The recorded ending round-trips through the one constructor, as window.json writes it.
      const reread = parseWindowEnding(JSON.parse(JSON.stringify(progress.ending)), scheduled);
      expect(reread).toEqual({ ok: true, value: progress.ending });
      expect(probedAfter.every((afterPairs) => afterPairs < scheduled)).toBe(true);
      if (progress.ending.kind === "aborted") expect(progress.ending.afterPairs).toBeLessThan(scheduled);
    }), { numRuns: 400 });
  });

  it("never stops on model behaviour: a schedule of answered pairs completes without a probe (property)", () => {
    const answered = fc.array(fc.record({ kind: fc.constantFrom<PairKind>("accepted", "rejected"), routeDown: fc.boolean() }), { minLength: 12, maxLength: 12 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), answered, (scheduled, script) => {
      const { progress, probedAfter } = run(scheduled, script);
      expect(progress).toEqual({ kind: "ended", ending: { kind: "completed", pairs: scheduled } });
      expect(probedAfter).toEqual([]);
    }), { numRuns: 100 });
  });

  it("completes an empty schedule at once, and never judges the last pair", () => {
    expect(startSchedule(0)).toEqual({ kind: "ended", ending: { kind: "completed", pairs: 0 } });
    expect(() => startSchedule(-1)).toThrow("a schedule has a whole number of pairs, not -1");
    // A one-pair schedule's only pair is its last: an outage there is recorded in its samples, not as an abort.
    const single = startSchedule(1);
    if (single.kind !== "running") throw new Error("a one-pair schedule runs");
    expect(landPair(single.breaker, landedPair("infrastructure"))).toEqual({ kind: "ended", ending: { kind: "completed", pairs: 1 } });
    // The limit reached on the last pair completes too.
    const outages = Array.from({ length: CONSECUTIVE_OUTAGE_PAIR_LIMIT }, () => ({ kind: "infrastructure" as const, routeDown: false }));
    expect(run(CONSECUTIVE_OUTAGE_PAIR_LIMIT, outages)).toMatchObject({
      progress: { kind: "ended", ending: { kind: "completed", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } },
      probedAfter: Array.from({ length: CONSECUTIVE_OUTAGE_PAIR_LIMIT - 1 }, (_unused, index) => index + 1),
    });
  });

  it("records a blank unreachable answer under a named reason, so the judge always returns a recordable ending", () => {
    const opened = startSchedule(4);
    if (opened.kind !== "running") throw new Error("a four-pair schedule runs");
    const step = landPair(opened.breaker, landedPair("timeout"));
    if (step.kind !== "probe-route") throw new Error("an all-outage pair before the last is re-probed");
    for (const blank of ["", "  "]) {
      expect(step.judge({ kind: "unreachable", reason: blank })).toEqual({
        kind: "ended",
        ending: { kind: "aborted", afterPairs: 1, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: UNEXPLAINED_UNREACHABLE_REASON } },
      });
    }
  });
});

describe("parseWindowEnding (the one WindowEnding constructor of this revision)", () => {
  const reasons = fc.oneof(
    fc.string({ minLength: 1 }).map((reason) => ({ kind: "route-unreachable", reason })),
    fc.integer({ min: 1, max: 12 }).map((pairs) => ({ kind: "consecutive-outage-pairs", pairs })),
  );

  it("admits an aborted ending exactly when 1 ≤ afterPairs < scheduledPairs, a non-empty reason, and a streak of exactly the limit within the pairs dispatched (property)", () => {
    fc.assert(fc.property(fc.integer({ min: -2, max: 12 }), fc.integer({ min: -2, max: 12 }), reasons, (afterPairs, scheduledPairs, reason) => {
      const parsed = parseWindowEnding({ kind: "aborted", afterPairs, scheduledPairs, reason }, scheduledPairs);
      const reasonFits = reason.kind === "route-unreachable"
        ? (reason as { reason: string }).reason.length > 0
        : (reason as { pairs: number }).pairs === CONSECUTIVE_OUTAGE_PAIR_LIMIT && CONSECUTIVE_OUTAGE_PAIR_LIMIT <= afterPairs;
      expect(parsed.ok).toBe(afterPairs >= 1 && afterPairs < scheduledPairs && reasonFits);
      if (parsed.ok) expect(parsed.value).toEqual({ kind: "aborted", afterPairs, scheduledPairs, reason });
    }), { numRuns: 400 });
  });

  it("admits an ending only of the schedule it is parsed against: a completed one ran every pair, an aborted one names that schedule (property)", () => {
    const pairCounts = fc.integer({ min: 0, max: 12 });
    fc.assert(fc.property(pairCounts, pairCounts, (pairs, scheduledPairs) => {
      const completed = parseWindowEnding({ kind: "completed", pairs }, scheduledPairs);
      expect(completed.ok).toBe(pairs === scheduledPairs);
      if (!completed.ok) expect(completed.error).toBe(`invalid window ending: pairs: completed after ${pairs} pairs of a ${scheduledPairs}-pair schedule`);
      // An abort between the pairs of a `pairs + 2`-pair schedule, parsed against `scheduledPairs`.
      const recorded = pairs + 2;
      const aborted = parseWindowEnding({ kind: "aborted", afterPairs: 1, scheduledPairs: recorded, reason: { kind: "route-unreachable", reason: "down" } }, scheduledPairs);
      expect(aborted.ok).toBe(recorded === scheduledPairs);
      if (!aborted.ok) expect(aborted.error).toBe(`invalid window ending: scheduledPairs: ${recorded} recorded for a ${scheduledPairs}-pair schedule`);
    }), { numRuns: 200 });
  });

  it("refuses a schedule aborted after every one of its pairs: a schedule dispatched in full ends completed", () => {
    const parsed = parseWindowEnding({ kind: "aborted", afterPairs: 4, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: "down" } }, 4);
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("aborted after all 4 scheduled pairs: a schedule dispatched in full ends completed") });
  });

  it("admits a completed ending over any non-negative pair count, and refuses the legacy reason and unknown fields", () => {
    expect(parseWindowEnding({ kind: "completed", pairs: 0 }, 0)).toEqual({ ok: true, value: { kind: "completed", pairs: 0 } });
    expect(parseWindowEnding({ kind: "completed", pairs: -1 }, -1).ok).toBe(false);
    expect(parseWindowEnding({ kind: "completed", pairs: 4, extra: true }, 4).ok).toBe(false);
    expect(parseWindowEnding({ kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-infrastructure-failures", pairs: 3 } }, 4))
      .toEqual({ ok: false, error: "invalid window ending: the consecutive-infrastructure-failures reason exists only in a schemaVersion 1 window" });
    expect(parseWindowEnding({ kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: "" } }, 4).ok).toBe(false);
  });
});

describe("parseRetainedWindowEnding (a retained ending, under the rules of the version that wrote it)", () => {
  it("reads schemaVersion 2 exactly as this revision writes it", () => {
    const raw = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } };
    expect(parseRetainedWindowEnding(raw, 2)).toEqual(parseWindowEnding(raw, 4));
  });

  it("reads a schemaVersion 2 streak under the limit that version recorded (3), not under the live limit", () => {
    // Literal 3, never CONSECUTIVE_OUTAGE_PAIR_LIMIT: a retained window's evidence must not move with the live rule.
    const recorded = { kind: "aborted", afterPairs: 5, scheduledPairs: 408, reason: { kind: "consecutive-outage-pairs", pairs: 3 } };
    expect(parseRetainedWindowEnding(recorded, 2)).toEqual({ ok: true, value: recorded });
    for (const pairs of [2, 4]) expect(parseRetainedWindowEnding({ ...recorded, reason: { kind: "consecutive-outage-pairs", pairs } }, 2).ok).toBe(false);
  });

  it("reads every retained schemaVersion 2 window's ending back as it was recorded", () => {
    const windows = join(HERE, "windows");
    const retained = readdirSync(windows)
      .map((id) => JSON.parse(readFileSync(join(windows, id, "window.json"), "utf-8")) as { schemaVersion: number; ending?: unknown })
      .filter((record) => record.schemaVersion === 2);
    expect(retained.length).toBeGreaterThan(0);
    for (const { ending } of retained) expect(parseRetainedWindowEnding(ending, 2)).toEqual({ ok: true, value: ending });
  });

  it("reads schemaVersion 1 as revision e8d688d8 recorded it: its legacy reason, and an abort judged on the last pair", () => {
    const legacy = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-infrastructure-failures", pairs: 3 } };
    expect(parseRetainedWindowEnding(legacy, 1)).toEqual({ ok: true, value: legacy });
    const lastPair = { kind: "aborted", afterPairs: 4, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: "down" } };
    expect(parseRetainedWindowEnding(lastPair, 1)).toEqual({ ok: true, value: lastPair });
    // e8d688d8 never wrote this revision's reason, nor a streak other than its own limit.
    expect(parseRetainedWindowEnding({ ...legacy, reason: { kind: "consecutive-outage-pairs", pairs: 3 } }, 1))
      .toEqual({ ok: false, error: "invalid window ending: the consecutive-outage-pairs reason exists only in a schemaVersion 2 window" });
    expect(parseRetainedWindowEnding({ ...legacy, reason: { kind: "consecutive-infrastructure-failures", pairs: 2 } }, 1).ok).toBe(false);
    expect(parseRetainedWindowEnding({ ...legacy, afterPairs: 5 }, 1)).toMatchObject({ ok: false, error: expect.stringContaining("aborted after 5 of 4 scheduled pairs") });
  });

  it("counts the pairs an ending dispatched", () => {
    const of = (raw: unknown) => {
      const parsed = parseRetainedWindowEnding(raw, 1);
      if (!parsed.ok) throw new Error(parsed.error);
      return dispatchedPairsOf(parsed.value);
    };
    expect(of({ kind: "completed", pairs: 408 })).toBe(408);
    expect(of({ kind: "aborted", afterPairs: 13, scheduledPairs: 408, reason: { kind: "route-unreachable", reason: "down" } })).toBe(13);
  });
});
