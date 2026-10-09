import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pilotRequestId } from "./pilot-binding";
import { evaluatePilot } from "./pilot-core";
import type { ArmRequest } from "./pilot-dispatch";
import { buildPairSchedule } from "./pilot-preregistration";
import { parseBlindingKey, parseQualityAssessment } from "./pilot-quality";
import { rubricAssessment } from "./pilot-rubric";
import {
  ACCEPT_EMISSION,
  ACCEPT_EXTRACTION,
  accepted,
  ATTEMPT_MS,
  fakeRoute,
  fixtures,
  HEALTHY_ROUTE,
  INFRASTRUCTURE,
  inputOf,
  inputs,
  inputsWithout,
  outageFromPair,
  PILOT_1,
  READY,
  REJECTED,
  runWindow,
  sample,
  TIMEOUT,
  WINDOW_ID,
} from "./pilot-test-fixtures";
import { blind, blindedPacket, dispatchSchedule, type RouteHealthProbe, type SampleRecord } from "./pilot-window";
import { CONSECUTIVE_OUTAGE_PAIR_LIMIT, UNEXPLAINED_UNREACHABLE_REASON, type RouteHealth } from "./pilot-window-ending";
import { renderTaskBody } from "./pilot-workload";

/**
 * The window dispatch at its interface (`pilot-window.ts`): `dispatchSchedule`
 * over a fake route (pilot-test-fixtures.ts) — a plain `ArmDispatch` function
 * and a fake clock, wired exactly where `recordWindow` wires the live Pi
 * adapter — and `blind` / `blindedPacket` over plain sample records: the
 * matched-arm dispatch, the attempt-2 retry budget, the blinding key and the
 * arm-free packet, and the fail-closed aborts on a missing input or an
 * inconsistent recorded sample, and the route fail-fast end to end (the
 * probe port, a probe that throws or gives no reason, the last-pair
 * boundary). The pure fail-fast rule and the ending codec are pinned in
 * pilot-window-ending.test.ts; `recordWindow`'s own wiring in
 * pilot-retention.test.ts.
 */

const schedule = buildPairSchedule(PILOT_1);

const taskBody = (cell: ArmRequest["cell"], caseId: string): string => renderTaskBody(inputOf(cell, caseId), fixtures);

describe("dispatchSchedule (matched dispatch over the ArmDispatch port)", () => {
  it("dispatches each scheduled pair once per arm, in scheduled order, over the same task body", async () => {
    const route = fakeRoute(accepted);
    const { records, landed, progress } = await runWindow(route);
    expect(route.requests).toHaveLength(schedule.length * 2);
    schedule.forEach((pair, index) => {
      const arms = route.requests.slice(index * 2, index * 2 + 2);
      expect(arms.map((request) => request.arm)).toEqual([...pair.armOrder]);
      const body = taskBody(pair.cell, pair.caseId);
      for (const request of arms) {
        expect(request.cell).toBe(pair.cell);
        expect(request.attempt).toBe(1);
        expect(request.cellBinding.binding.requestId).toBe(pilotRequestId(WINDOW_ID, pair.pairId, request.arm, 1));
        expect(request.prompt.startsWith(`${body}\n\n## Output\n\n`)).toBe(true);
      }
      expect(arms[0]?.cellBinding.contextDigest).toBe(arms[1]?.cellBinding.contextDigest);
    });
    const dispatchedCells = new Set(route.requests.map((request) => request.cell));
    const emissionCells = PILOT_1.cells.filter((cell) => cell.qualification.kind !== "extraction-only").map((cell) => cell.cell);
    expect([...dispatchedCells].sort()).toEqual([...emissionCells].sort());
    expect(landed).toEqual(records);
    expect(records.map((record) => `${record.sample.pairId}|${record.sample.arm}`))
      .toEqual(schedule.flatMap((pair) => pair.armOrder.map((arm) => `${pair.pairId}|${arm}`)));
    expect(progress).toHaveLength(schedule.length);
    expect(progress.at(-1)).toBe(`${schedule.length}/${schedule.length} ${schedule.at(-1)?.pairId}`);
  });

  it("retries a semantic rejection with one fresh attempt 2 and times the sample across both attempts (AS-015)", async () => {
    const route = fakeRoute((request) => (request.attempt === 1 ? REJECTED : accepted(request)));
    const { records } = await runWindow(route);
    expect(route.requests).toHaveLength(schedule.length * 4);
    for (const record of records) {
      expect(record.sample.attempts.map((attempt) => [attempt.attempt, attempt.outcome.kind])).toEqual([[1, "rejected"], [2, "accepted"]]);
      expect(record.sample.dispatchToIngestionMs).toBe(2 * ATTEMPT_MS);
      expect(record.kind).toBe("accepted");
    }
    const retries = route.requests.filter((request) => request.attempt === 2);
    expect(new Set(retries.map((request) => request.cellBinding.binding.requestId)).size).toBe(retries.length);
    expect(retries.every((request) => request.cellBinding.binding.requestId.endsWith("-a2"))).toBe(true);
  });

  it("never spends more than the attempt-2 budget, and never retries a non-semantic failure", async () => {
    const exhausted = fakeRoute(() => REJECTED);
    const rejected = await runWindow(exhausted);
    expect(Math.max(...exhausted.requests.map((request) => request.attempt))).toBe(2);
    expect(exhausted.requests).toHaveLength(schedule.length * 4);
    expect(rejected.records.every((record) => record.sample.attempts.length === 2 && record.kind === "terminal")).toBe(true);

    // One arm times out on every pair (the other answers, so no pair is an all-outage pair and the schedule completes).
    const timedOut = fakeRoute((request) => (request.arm === "emission-enabled" ? TIMEOUT : accepted(request)));
    const terminal = await runWindow(timedOut);
    expect(timedOut.requests).toHaveLength(schedule.length * 2);
    const timeouts = terminal.records.filter((record) => record.sample.arm === "emission-enabled");
    expect(timeouts).toHaveLength(schedule.length);
    for (const record of timeouts) {
      expect(record.sample.attempts.map((attempt) => attempt.outcome.kind)).toEqual(["timeout"]);
      expect(record.sample.dispatchToIngestionMs).toBe(ATTEMPT_MS);
      expect(record.kind).toBe("terminal");
    }
  });

  describe("aborts the window loudly instead of recording a fabricated sample", () => {
    const first = schedule[0] as (typeof schedule)[number];

    it("refuses a preregistered case with no resolved input before dispatching it", async () => {
      const route = fakeRoute(accepted);
      const landed: unknown[] = [];
      await expect(dispatchSchedule({
        windowId: WINDOW_ID, prereg: PILOT_1, fixtures, inputs: inputsWithout(first.cell, first.caseId), dispatch: route.dispatch, routeHealth: HEALTHY_ROUTE, now: route.now,
        onSample: (record) => { landed.push(record); }, onPair: () => {},
      })).rejects.toThrow(`no resolved input for ${first.cell} case ${first.caseId}`);
      expect(route.requests).toHaveLength(0);
      expect(landed).toHaveLength(0);
    });

    it("refuses a recorded observation the sample parser rejects", async () => {
      // An extraction-only attempt claiming the emission-tool source contradicts its arm.
      const route = fakeRoute(() => ({ kind: "accepted", source: "emission-tool", fallbackOverRefusal: false, payloadDigest: "a".repeat(64) }));
      const landed: unknown[] = [];
      await expect(runWindow(route, (record) => { landed.push(record); }))
        .rejects.toThrow(/^recorded observation for \S+\/extraction-only is malformed: /);
      expect(landed.length).toBeLessThan(2);
    });

    it("refuses an accepted attempt that carries no accepted payload", async () => {
      const route = fakeRoute(accepted);
      const payloadless = { ...route, dispatch: async (request: ArmRequest) => ({ ...(await route.dispatch(request)), acceptedPayload: null }) };
      const landed: unknown[] = [];
      await expect(runWindow(payloadless, (record) => { landed.push(record); }))
        .rejects.toThrow(`recorded sample for ${first.pairId}/${first.armOrder[0]} is inconsistent: its accepted outcome carries no accepted payload`);
      expect(landed).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Route fail-fast
// ---------------------------------------------------------------------------

/** A probe that counts its calls and answers as told. */
function countingProbe(health: RouteHealth): RouteHealthProbe & { calls: () => number } {
  let calls = 0;
  const probe = async (): Promise<RouteHealth> => { calls += 1; return health; };
  return Object.assign(probe, { calls: () => calls });
}

const DOWN: RouteHealth = { kind: "unreachable", reason: "fetch failed (connect ECONNREFUSED)" };

describe("dispatchSchedule route fail-fast", () => {
  it("runs the whole schedule on a healthy route and never probes a pair that only succeeded or was rejected", async () => {
    for (const script of [accepted, () => REJECTED]) {
      const probe = countingProbe(DOWN);
      const { ending, records } = await runWindow(fakeRoute(script), () => {}, probe);
      expect(ending).toEqual({ kind: "completed", pairs: schedule.length });
      expect(records).toHaveLength(schedule.length * 2);
      expect(probe.calls()).toBe(0);
    }
  });

  it("stops right after the first pair whose re-probe finds the route unreachable, keeping both arms of every landed pair", async () => {
    const outageFrom = 4;
    const route = outageFromPair(outageFrom);
    const probe = countingProbe(DOWN);
    const { ending, records, landed } = await runWindow(route, () => {}, probe);
    expect(ending).toEqual({
      kind: "aborted", afterPairs: outageFrom + 1, scheduledPairs: schedule.length,
      reason: { kind: "route-unreachable", reason: DOWN.reason },
    });
    expect(records).toHaveLength((outageFrom + 1) * 2);
    expect(landed).toEqual(records);
    expect(probe.calls()).toBe(1);
    // An infrastructure failure is terminal: it never spends the attempt-2 retry.
    expect(route.requests.slice(outageFrom * 2).every((request) => request.attempt === 1)).toBe(true);
  });

  it("re-probes after a pair with one timed-out sample but keeps going while the route answers", async () => {
    const probe = countingProbe({ kind: "reachable" });
    const { ending } = await runWindow(fakeRoute((request) => (request.arm === "emission-enabled" ? TIMEOUT : accepted(request))), () => {}, probe);
    expect(ending.kind).toBe("completed");
    // Every pair but the last is re-probed: the last has no pair after it to protect (`landPair`).
    expect(probe.calls()).toBe(schedule.length - 1);
  });

  it(`stops after ${CONSECUTIVE_OUTAGE_PAIR_LIMIT} consecutive all-outage pairs even while the route answers its listing`, async () => {
    for (const outage of [INFRASTRUCTURE, TIMEOUT]) {
      const probe = countingProbe({ kind: "reachable" });
      const { ending, records } = await runWindow(fakeRoute(() => outage), () => {}, probe);
      expect(ending, outage.kind).toEqual({
        kind: "aborted", afterPairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT, scheduledPairs: schedule.length,
        reason: { kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT },
      });
      expect(records).toHaveLength(CONSECUTIVE_OUTAGE_PAIR_LIMIT * 2);
      expect(probe.calls()).toBe(CONSECUTIVE_OUTAGE_PAIR_LIMIT);
    }
  });

  it("stops a window whose route hangs inference: every pair times out while the listing answers (timeout-only outage)", async () => {
    // One arm infrastructure, the other a timeout: still an all-outage pair.
    const { ending } = await runWindow(fakeRoute((request) => (request.arm === "emission-enabled" ? TIMEOUT : INFRASTRUCTURE)), () => {}, countingProbe({ kind: "reachable" }));
    expect(ending).toMatchObject({ kind: "aborted", reason: { kind: "consecutive-outage-pairs" } });
  });

  it("fails closed on a probe that rejects or throws: the window ends route-unreachable with the error", async () => {
    const rejecting: RouteHealthProbe = async () => { throw new Error("fetch exploded"); };
    const throwing: RouteHealthProbe = () => { throw "not even an Error"; };
    // A thrown value String() cannot render (a null-prototype object) still closes the window.
    const unprintable: RouteHealthProbe = () => { throw Object.create(null); };
    for (const [probe, reason] of [
      [rejecting, "the route probe failed: fetch exploded"],
      [throwing, "the route probe failed: not even an Error"],
      [unprintable, "the route probe failed: an unprintable thrown object"],
    ] as const) {
      const { ending, records } = await runWindow(fakeRoute(() => TIMEOUT), () => {}, probe);
      expect(ending).toEqual({ kind: "aborted", afterPairs: 1, scheduledPairs: schedule.length, reason: { kind: "route-unreachable", reason } });
      expect(records).toHaveLength(2);
    }
  });

  it("still closes the window as aborted when the probe reports unreachable with a blank reason", async () => {
    for (const blank of ["", "   "]) {
      const { ending, records } = await runWindow(fakeRoute(() => INFRASTRUCTURE), () => {}, countingProbe({ kind: "unreachable", reason: blank }));
      expect(ending).toEqual({
        kind: "aborted", afterPairs: 1, scheduledPairs: schedule.length,
        reason: { kind: "route-unreachable", reason: UNEXPLAINED_UNREACHABLE_REASON },
      });
      expect(records).toHaveLength(2);
    }
  });

  describe("the last scheduled pair: a schedule dispatched in full ends completed, never aborted after all its pairs", () => {
    it("does not re-probe or stop on an outage that starts on the last pair", async () => {
      const probe = countingProbe(DOWN);
      const { ending, records } = await runWindow(outageFromPair(schedule.length - 1), () => {}, probe);
      expect(ending).toEqual({ kind: "completed", pairs: schedule.length });
      expect(records).toHaveLength(schedule.length * 2);
      expect(records.slice(-2).every((landed) => landed.kind === "terminal")).toBe(true);
      expect(probe.calls()).toBe(0);
    });

    it(`completes when the ${CONSECUTIVE_OUTAGE_PAIR_LIMIT}rd consecutive all-outage pair is the last one`, async () => {
      const probe = countingProbe({ kind: "reachable" });
      const { ending } = await runWindow(outageFromPair(schedule.length - CONSECUTIVE_OUTAGE_PAIR_LIMIT), () => {}, probe);
      expect(ending).toEqual({ kind: "completed", pairs: schedule.length });
      // Every outage pair but the last was judged (re-probed); the last has nothing left to protect.
      expect(probe.calls()).toBe(CONSECUTIVE_OUTAGE_PAIR_LIMIT - 1);
    });

    it("still stops on the pair before the last", async () => {
      const { ending } = await runWindow(outageFromPair(schedule.length - 2), () => {}, countingProbe(DOWN));
      expect(ending).toEqual({
        kind: "aborted", afterPairs: schedule.length - 1, scheduledPairs: schedule.length,
        reason: { kind: "route-unreachable", reason: DOWN.reason },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Blinding
// ---------------------------------------------------------------------------

/** A plain sample record of a scheduled pair: accepted (with a payload naming its owner) or terminal. */
function record(index: number, arm: "emission-enabled" | "extraction-only", landed: boolean): SampleRecord {
  const pair = schedule[index % schedule.length] as (typeof schedule)[number];
  if (!landed) return { kind: "terminal", sample: sample(pair, arm, 10, [{ outcome: { kind: "timeout", afterMs: 10 } }]) };
  return {
    kind: "accepted",
    sample: sample(pair, arm, 10, [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION]),
    acceptedPayload: { owner: `${pair.pairId}|${arm}` },
  };
}

const recordsArbitrary = fc.uniqueArray(
  fc.record({ index: fc.nat({ max: schedule.length - 1 }), arm: fc.constantFrom("emission-enabled" as const, "extraction-only" as const), landed: fc.boolean() }),
  { selector: ({ index, arm }) => `${index}|${arm}`, maxLength: 24 },
).map((specs) => specs.map(({ index, arm, landed }) => record(index, arm, landed)));

describe("blind (the retained blinding key)", () => {
  it("blinds exactly the accepted samples, once each, under unique blind ids in blind-id order (property)", () => {
    fc.assert(fc.property(recordsArbitrary, (records) => {
      const blinded = blind(WINDOW_ID, records);
      const key = parseBlindingKey(blinded.key);
      if (!key.ok) throw new Error(key.error.join("; "));
      expect(key.value.windowId).toBe(WINDOW_ID);
      const acceptedIds = records.flatMap((entry) => (entry.kind === "accepted" ? [`${entry.sample.pairId}|${entry.sample.arm}`] : []));
      expect(key.value.entries.map((entry) => `${entry.pairId}|${entry.arm}`).sort()).toEqual([...acceptedIds].sort());
      const blindIds = blinded.entries.map((entry) => entry.blindId);
      expect(new Set(blindIds).size).toBe(blindIds.length);
      expect(blindIds).toEqual([...blindIds].sort());
      expect(key.value.entries.map((entry) => entry.blindId)).toEqual(blindIds);
      for (const entry of blinded.entries) expect(entry.payload).toEqual({ owner: `${entry.pairId}|${entry.arm}` });
    }), { numRuns: 100 });
  });

  it("draws fresh blind ids per blinding, so the packet order is not the schedule's", () => {
    const records = schedule.slice(0, 20).map((_pair, index) => record(index, "emission-enabled", true));
    const first = blind(WINDOW_ID, records).entries.map((entry) => entry.blindId);
    const second = blind(WINDOW_ID, records).entries.map((entry) => entry.blindId);
    expect(first).not.toEqual(second);
    expect(blind(WINDOW_ID, records).entries.map((entry) => entry.pairId)).not.toEqual(records.map((entry) => entry.sample.pairId));
  });
});

describe("blindedPacket (what an assessor sees)", () => {
  it("carries blind id, cell, case and payload only — never the arm or the pair (property)", () => {
    fc.assert(fc.property(recordsArbitrary, (records) => {
      const { key, entries } = blind(WINDOW_ID, records);
      const packet = blindedPacket(WINDOW_ID, entries);
      expect(packet).toMatchObject({ schemaVersion: 1, windowId: WINDOW_ID });
      expect(packet.entries.map((entry) => entry.blindId)).toEqual(key.entries.map((entry) => entry.blindId));
      for (const [index, entry] of packet.entries.entries()) {
        expect(Object.keys(entry).sort()).toEqual(["blindId", "caseId", "cell", "payload"]);
        expect(entry).toEqual({ blindId: entries[index]?.blindId, cell: entries[index]?.cell, caseId: entries[index]?.caseId, payload: entries[index]?.payload });
      }
      const withoutPayloads = JSON.stringify({ ...packet, entries: packet.entries.map(({ payload: _payload, ...rest }) => rest) });
      expect(withoutPayloads).not.toMatch(/emission-enabled|extraction-only|emission-tool|"arm"|"pairId"/);
    }), { numRuns: 100 });
  });

  it("blinds a fake-route window's accepted samples and hides every arm in the packet", async () => {
    // The judge cell's extraction arm never lands: terminal samples are never blinded.
    const { records } = await runWindow(fakeRoute((request) =>
      request.cell === "judge-verdict/v1" && request.arm === "extraction-only" ? REJECTED : accepted(request)));
    const acceptedRecords = records.flatMap((entry) => (entry.kind === "accepted" ? [entry] : []));
    expect(acceptedRecords.length).toBeLessThan(records.length);
    const blinded = blind(WINDOW_ID, records);
    expect(blinded.key.entries).toHaveLength(acceptedRecords.length);
    for (const entry of blinded.entries) {
      const owners = acceptedRecords.filter((owner) => owner.sample.pairId === entry.pairId && owner.sample.arm === entry.arm);
      expect(owners).toHaveLength(1);
      expect(entry.payload).toBe(owners[0]?.acceptedPayload);
    }
    expect(JSON.stringify(blindedPacket(WINDOW_ID, blinded.entries))).not.toMatch(/emission-enabled|extraction-only|emission-tool|"arm"|"pairId"/);
  });

  it("feeds the rubric assessor evidence the release decision accepts", async () => {
    const { records } = await runWindow(fakeRoute(accepted));
    const blinded = blind(WINDOW_ID, records);
    const assessed = rubricAssessment(PILOT_1, blinded.entries, inputs);
    if (!assessed.ok) throw new Error(assessed.error.join("; "));
    const rubric = parseQualityAssessment(assessed.value);
    if (!rubric.ok) throw new Error(rubric.error.join("; "));
    expect(rubric.value).toMatchObject({ assessorId: "rubric-v1", blinded: true });
    expect(rubric.value.entries.map((entry) => entry.blindId)).toEqual(blinded.key.entries.map((entry) => entry.blindId));
    expect(rubric.value.entries.some((entry) => entry.escapedDefects.length > 0)).toBe(true);

    const evaluated = evaluatePilot({
      preregistration: PILOT_1, preflight: READY, observations: records.map((entry) => entry.sample),
      quality: { key: blinded.key, assessments: [rubric.value] },
    });
    if (!evaluated.ok) throw new Error(evaluated.error.problems.join("\n"));
    expect(evaluated.value.cells.every((cell) => cell.kind !== "not-measured")).toBe(true);
  });
});
