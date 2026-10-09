import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SampleObservation } from "./pilot-observation";
import type { RouteProbe } from "./pilot-preflight";
import { buildPairSchedule, type ScheduledPair } from "./pilot-preregistration";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, INFRASTRUCTURE, PILOT_1, REJECTED, sample, TIMEOUT } from "./pilot-test-fixtures";
import type { PilotArm } from "./pilot-vocabulary";
import {
  CONSECUTIVE_OUTAGE_PAIR_LIMIT,
  dispatchedPairsOf,
  judgePair,
  judgesPair,
  observedRouteHealth,
  pairHealth,
  parseRetainedWindowEnding,
  parseWindowEnding,
  ROUTE_BREAKER_START,
  routeHealthOf,
  routeProbeFailed,
  UNEXPLAINED_UNREACHABLE_REASON,
  type JudgedPair,
  type RouteBreaker,
  type RouteHealth,
} from "./pilot-window-ending";

/**
 * How a dispatched window ends, at its pure interface (`pilot-window-ending.ts`):
 * the route health the window records, what an outage looks like from inside
 * the window (`pairHealth`), which pairs are judged (`judgesPair`), the
 * fail-fast rule (`judgePair`), and the `WindowEnding` codec keyed on the
 * window's schemaVersion. The dispatch shell that runs it is pinned end to end
 * in pilot-window.test.ts.
 */

const PAIR = buildPairSchedule(PILOT_1)[0] as ScheduledPair;
const DOWN: RouteHealth = { kind: "unreachable", reason: "fetch failed (connect ECONNREFUSED)" };

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

type PairKind = "accepted" | "rejected" | "timeout" | "infrastructure" | "mixed-outage" | "mixed-infrastructure" | "mixed-timeout" | "rejected-and-timeout";

/** The two arms' sample kinds of each landed pair kind. */
const PAIR_KINDS: Readonly<Record<PairKind, readonly [SampleKind, SampleKind]>> = {
  "accepted": ["accepted", "accepted"],
  "rejected": ["rejected", "rejected"],
  "timeout": ["timeout", "timeout"],
  "infrastructure": ["infrastructure", "infrastructure"],
  "mixed-outage": ["infrastructure", "timeout"],
  "mixed-infrastructure": ["infrastructure", "accepted"],
  "mixed-timeout": ["accepted", "timeout"],
  "rejected-and-timeout": ["rejected", "timeout"],
};

const landedPair = (kind: PairKind): readonly SampleObservation[] => {
  const [emission, extraction] = PAIR_KINDS[kind];
  return [landed(emission, "emission-enabled"), landed(extraction, "extraction-only")];
};

/** The pair health each kind must have: outage-like = infrastructure or timeout, never a rejection. */
const EXPECTED_HEALTH: Readonly<Record<PairKind, ReturnType<typeof pairHealth>["kind"]>> = {
  "accepted": "none",
  "rejected": "none",
  "timeout": "all-outage",
  "infrastructure": "all-outage",
  "mixed-outage": "all-outage",
  "mixed-infrastructure": "needs-probe",
  "mixed-timeout": "needs-probe",
  "rejected-and-timeout": "needs-probe",
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
      const ending = parseWindowEnding({ kind: "aborted", afterPairs: 1, scheduledPairs: 2, reason: { kind: "route-unreachable", reason: expected.reason } });
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
    for (const [kind, health] of Object.entries(EXPECTED_HEALTH)) expect(pairHealth(landedPair(kind as PairKind)), kind).toEqual({ kind: health });
  });
});

describe("judgesPair (which pairs the fail-fast judges)", () => {
  it("judges every pair with pairs still to come, and never the last (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 500 }), (dispatched, scheduled) => {
      fc.pre(dispatched <= scheduled);
      expect(judgesPair(dispatched, scheduled)).toBe(dispatched < scheduled);
    }));
    expect(judgesPair(408, 408)).toBe(false);
  });
});

describe("judgePair (the fail-fast rule)", () => {
  const pairKinds = fc.constantFrom<PairKind>(...(Object.keys(EXPECTED_HEALTH) as PairKind[]));

  const judged = (kind: PairKind, routeDown: boolean): JudgedPair => {
    const health = pairHealth(landedPair(kind));
    return health.kind === "none" ? health : { ...health, route: routeDown ? DOWN : { kind: "reachable" } };
  };

  it("aborts exactly on an unreachable re-probe or the consecutive all-outage limit, and never on model behaviour (property)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ kind: pairKinds, routeDown: fc.boolean() }), { maxLength: 12 }),
      (steps) => {
        let breaker: RouteBreaker = ROUTE_BREAKER_START;
        let streak = 0;
        for (const [index, { kind, routeDown }] of steps.entries()) {
          const probes = EXPECTED_HEALTH[kind] !== "none";
          const result = judgePair(breaker, judged(kind, routeDown));
          streak = EXPECTED_HEALTH[kind] === "all-outage" ? streak + 1 : 0;
          expect(result.breaker.consecutiveOutagePairs).toBe(streak);
          const expected = probes && routeDown
            ? { kind: "route-unreachable", reason: DOWN.reason }
            : streak >= CONSECUTIVE_OUTAGE_PAIR_LIMIT ? { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } : null;
          expect(result.abort).toEqual(expected);
          // A pair the model answered (accepted or rejected) never stops the window.
          if (kind === "accepted" || kind === "rejected") expect(result.abort).toBeNull();
          if (result.abort !== null) {
            // Whatever stopped the window is an ending this revision can record.
            expect(parseWindowEnding({ kind: "aborted", afterPairs: index + 1, scheduledPairs: index + 2, reason: result.abort }).ok).toBe(true);
            return;
          }
          breaker = result.breaker;
        }
      },
    ), { numRuns: 300 });
  });
});

describe("parseWindowEnding (the one WindowEnding constructor of this revision)", () => {
  const reasons = fc.oneof(
    fc.string({ minLength: 1 }).map((reason) => ({ kind: "route-unreachable", reason })),
    fc.integer({ min: 1, max: 12 }).map((pairs) => ({ kind: "consecutive-outage-pairs", pairs })),
  );

  it("admits an aborted ending exactly when 1 ≤ afterPairs < scheduledPairs, a non-empty reason, and a streak of exactly the limit within the pairs dispatched (property)", () => {
    fc.assert(fc.property(fc.integer({ min: -2, max: 12 }), fc.integer({ min: -2, max: 12 }), reasons, (afterPairs, scheduledPairs, reason) => {
      const parsed = parseWindowEnding({ kind: "aborted", afterPairs, scheduledPairs, reason });
      const reasonFits = reason.kind === "route-unreachable"
        ? (reason as { reason: string }).reason.length > 0
        : (reason as { pairs: number }).pairs === CONSECUTIVE_OUTAGE_PAIR_LIMIT && CONSECUTIVE_OUTAGE_PAIR_LIMIT <= afterPairs;
      expect(parsed.ok).toBe(afterPairs >= 1 && afterPairs < scheduledPairs && reasonFits);
      if (parsed.ok) expect(parsed.value).toEqual({ kind: "aborted", afterPairs, scheduledPairs, reason });
    }), { numRuns: 400 });
  });

  it("refuses a schedule aborted after every one of its pairs: a schedule dispatched in full ends completed", () => {
    const parsed = parseWindowEnding({ kind: "aborted", afterPairs: 4, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: "down" } });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("aborted after all 4 scheduled pairs: a schedule dispatched in full ends completed") });
  });

  it("admits a completed ending over any non-negative pair count, and refuses the legacy reason and unknown fields", () => {
    expect(parseWindowEnding({ kind: "completed", pairs: 0 })).toEqual({ ok: true, value: { kind: "completed", pairs: 0 } });
    expect(parseWindowEnding({ kind: "completed", pairs: -1 }).ok).toBe(false);
    expect(parseWindowEnding({ kind: "completed", pairs: 4, extra: true }).ok).toBe(false);
    expect(parseWindowEnding({ kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-infrastructure-failures", pairs: 3 } }))
      .toEqual({ ok: false, error: "invalid window ending: the consecutive-infrastructure-failures reason exists only in a schemaVersion 1 window" });
    expect(parseWindowEnding({ kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "route-unreachable", reason: "" } }).ok).toBe(false);
  });
});

describe("parseRetainedWindowEnding (a retained ending, under the rules of the version that wrote it)", () => {
  it("reads schemaVersion 2 exactly as this revision writes it", () => {
    const raw = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT } };
    expect(parseRetainedWindowEnding(raw, 2)).toEqual(parseWindowEnding(raw));
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
