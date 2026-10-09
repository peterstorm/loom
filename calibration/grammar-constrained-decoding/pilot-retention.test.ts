import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Result } from "../kernel";
import { decidePreflight, type PreflightFacts } from "./pilot-preflight";
import type { Preregistration } from "./pilot-preregistration";
import {
  checkPreregistrationUnchanged,
  decideRetainedWindow,
  parseAssessmentText,
  parseObservationLog,
  parsePreregistrationFile,
  parseRetainedWindow,
  pilotWindowId,
  planDispatch,
  recordWindow,
  retentionStep,
  WINDOW_FILES,
  type DecisionOutcome,
  type LoadedPreregistration,
  type RecordedWindow,
  type WindowRecord,
  type WindowRun,
  type WindowStore,
} from "./pilot-retention";
import {
  accepted, ATTEMPT_MS, fakeRoute, HEALTHY_ROUTE, HERE, INFRASTRUCTURE, pilot2PreregBytes, prereg, READY, REPO_ROOT, runWindow, WORKLOAD, type FakeRoute,
} from "./pilot-test-fixtures";
import { contentDigest } from "./pilot-vocabulary";

/**
 * The retention rules of one AD-11 window (AS-017), pinned at the
 * `WindowStore` port with an in-memory store: the pure derivations directly,
 * and the `--pilot` / `--decide` sequences over them.
 */

type MemoryStore = WindowStore & Readonly<{ files: Map<string, string>; writes: string[] }>;

function memoryStore(seed: ReadonlyMap<string, string> = new Map()): MemoryStore {
  const files = new Map(seed);
  const writes: string[] = [];
  return {
    files,
    writes,
    read: (name) => files.get(name) ?? null,
    write: (name, text) => { writes.push(name); files.set(name, text); },
    append: (name, text) => { writes.push(name); files.set(name, (files.get(name) ?? "") + text); },
    list: (directory) => [...files.keys()].filter((name) => name.startsWith(`${directory}/`)).map((name) => name.slice(directory.length + 1)),
    locate: (name) => `mem:/window/${name}`,
  };
}

const preregBytes = readFileSync(join(HERE, "preregistration.json"));
const LOADED: LoadedPreregistration = {
  ref: { path: "calibration/grammar-constrained-decoding/preregistration.json", digest: contentDigest(preregBytes), id: prereg.id },
  prereg,
};
const loadSame = (): Result<LoadedPreregistration, string> => ({ ok: true, value: LOADED });

const UNREACHABLE_FACTS: PreflightFacts = {
  registry: { "reviewer-payload/v2": null, "reviewer-payload/v3": null, "judge-verdict/v1": null, "refutation-verdict/v1": null },
  workloadFixturesDigest: prereg.workloadFixturesDigest,
  piVersion: prereg.route.piVersion,
  stagedRuntimeRevision: "sha256:abc",
  loadedRuntimeRevision: null,
  route: { kind: "unreachable", reason: "connection refused" },
};

const windowRecord = (dispatched: boolean): WindowRecord => {
  const preflight = dispatched ? READY : decidePreflight(prereg, UNREACHABLE_FACTS);
  return {
    schemaVersion: 2,
    windowId: "test-window",
    preregistration: LOADED.ref,
    workloadFixtures: { path: "calibration/grammar-constrained-decoding/workload-fixtures.json", digest: prereg.workloadFixturesDigest },
    startedAt: "2026-10-05T08:00:00.000Z",
    preflightFacts: UNREACHABLE_FACTS,
    preflight,
    dispatch: planDispatch(preflight, false),
  };
};

let tick = 0;
const clock = (): string => new Date(Date.UTC(2026, 9, 5, 9, 0, tick++)).toISOString();

const assessmentText = (assessorId: string, method: string): string =>
  JSON.stringify({ schemaVersion: 1, assessorId, method, blinded: true, entries: [] }, null, 2);

const decided = (result: Result<DecisionOutcome, string>): Extract<DecisionOutcome, { kind: "recorded" }> => {
  if (!result.ok) throw new Error(result.error);
  if (result.value.kind !== "recorded") throw new Error(result.value.problems.join("\n"));
  return result.value;
};

/** A window `recordWindow` recorded (nothing refused before writing). */
const recorded = (result: Result<RecordedWindow, string>): RecordedWindow => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** A recorded window whose decision was recorded. */
const decidedRecord = (result: Result<RecordedWindow, string>) => decided(recorded(result).decision);

const json = (store: MemoryStore, name: string): Record<string, unknown> => JSON.parse(store.files.get(name) ?? "null");

/** A `--pilot` run over a store, dispatching through a route (by default one that must never be reached). */
const windowRun = (store: MemoryStore, record: WindowRecord, overrides: Partial<WindowRun> = {}, route?: FakeRoute): WindowRun => ({
  store, record, preregistration: LOADED, workload: WORKLOAD,
  dispatch: route?.dispatch ?? (() => { throw new Error("a window that does not dispatch never reaches the route"); }),
  routeHealth: route === undefined ? () => { throw new Error("a window that does not dispatch never probes the route"); } : HEALTHY_ROUTE,
  monotonicNow: route?.now ?? (() => { throw new Error("a window that does not dispatch reads no monotonic clock"); }),
  onPair: () => {},
  externalAssessments: [], now: clock,
  ...overrides,
});

/** A blocked window as `--pilot` leaves it. */
async function blockedWindow(): Promise<MemoryStore> {
  const store = memoryStore();
  decidedRecord(await recordWindow(windowRun(store, windowRecord(false))));
  return store;
}

// ---------------------------------------------------------------------------

describe("pure retention derivations", () => {
  it("plans dispatch only behind a ready preflight and without --preflight-only", () => {
    expect(planDispatch(READY, false)).toEqual({ kind: "dispatched" });
    expect(planDispatch(READY, true)).toEqual({ kind: "not-attempted", reason: "--preflight-only" });
    expect(planDispatch(decidePreflight(prereg, UNREACHABLE_FACTS), false).kind).toBe("not-attempted");
  });

  it("content-addresses a preregistration by its exact bytes and refuses malformed files", () => {
    const parsed = parsePreregistrationFile(preregBytes, "p.json");
    expect(parsed.ok && parsed.value.digest).toBe(contentDigest(preregBytes));
    expect(parsePreregistrationFile(new TextEncoder().encode("{"), "p.json")).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid preregistration p\.json: /) });
    expect(parsePreregistrationFile(new TextEncoder().encode("{}"), "p.json")).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid preregistration p\.json:\n {2}- /) });
  });

  it("reads a missing observation log as no samples and names the first malformed line", async () => {
    expect(parseObservationLog(null)).toEqual({ ok: true, value: [] });
    const { records } = await runWindow(fakeRoute(accepted));
    const log = records.slice(0, 3).map((record) => JSON.stringify(record.sample)).join("\n") + "\n";
    const parsed = parseObservationLog(log);
    expect(parsed.ok && parsed.value).toEqual(records.slice(0, 3).map((record) => record.sample));
    expect(parseObservationLog(`${log}{not json\n`)).toMatchObject({ ok: false, error: expect.stringMatching(/^observation line 4: /) });
    expect(parseObservationLog(`{"pairId":"x"}\n`)).toMatchObject({ ok: false, error: expect.stringMatching(/^observation line 1: /) });
  });

  it("reads back a retained window's preregistration record and facts, and refuses one without them", () => {
    const text = JSON.stringify(windowRecord(false));
    expect(parseRetainedWindow(text, "w.json")).toEqual({
      ok: true,
      value: { preregistration: { path: LOADED.ref.path, digest: LOADED.ref.digest }, facts: UNREACHABLE_FACTS, ending: { kind: "open" } },
    });
    expect(parseRetainedWindow(JSON.stringify({ preflightFacts: UNREACHABLE_FACTS }), "w.json")).toEqual({ ok: false, error: "w.json carries no preregistration record" });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), preflightFacts: {} }), "w.json"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json preflight facts: /) });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), schemaVersion: 3 }), "w.json"))
      .toEqual({ ok: false, error: "w.json carries no schemaVersion 1 or 2 dispatch record" });
  });

  describe("reads a retained window's ending back (parse, don't validate)", () => {
    const COMPLETED = { kind: "completed", pairs: 4 };
    const ABORTED = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-outage-pairs", pairs: 3 } };
    const LEGACY = { kind: "aborted", afterPairs: 3, scheduledPairs: 4, reason: { kind: "consecutive-infrastructure-failures", pairs: 3 } };
    const closed = (version: 1 | 2, dispatched: boolean, ending?: unknown): string => JSON.stringify({
      ...windowRecord(dispatched), schemaVersion: version, endedAt: "2026-10-05T09:00:00.000Z", observations: 0, ...(ending === undefined ? {} : { ending }),
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
      expect(endingOf(closed(1, true))).toEqual({ kind: "dispatched-unrecorded" });
      expect(endingOf(closed(2, true))).toEqual({ ok: false, error: "w.json is a closed dispatched schemaVersion 2 window without its ending" });
      expect(endingOf(closed(1, false))).toEqual({ kind: "not-dispatched" });
      expect(endingOf(closed(2, false))).toEqual({ kind: "not-dispatched" });
    });

    it("refuses an ending where none can exist, and a corrupt or out-of-version ending", () => {
      expect(endingOf(closed(2, false, COMPLETED))).toEqual({ ok: false, error: "w.json never dispatched, yet records an ending" });
      expect(endingOf(JSON.stringify({ ...windowRecord(true), ending: COMPLETED }))).toEqual({ ok: false, error: "w.json records an ending but was never closed" });
      expect(endingOf(closed(2, true, LEGACY))).toMatchObject({ ok: false, error: expect.stringContaining("exists only in a schemaVersion 1 window") });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 5 }))).toMatchObject({ ok: false, error: expect.stringContaining("aborted after 5 of 4 scheduled pairs") });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 0 }))).toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json invalid window ending: afterPairs/) });
      expect(endingOf(closed(2, true, { ...ABORTED, afterPairs: 2 }))).toMatchObject({ ok: false, error: expect.stringContaining("3 consecutive pairs exceed the 2 dispatched") });
      expect(endingOf(closed(2, true, { kind: "completed" }))).toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json invalid window ending: pairs/) });
    });

    it("round-trips every aborted ending recordWindow writes (property)", async () => {
      await fc.assert(fc.asyncProperty(fc.nat({ max: 6 }), fc.boolean(), async (outageFrom, routeDown) => {
        const store = memoryStore();
        const route = fakeRoute((request) => (route.requests.length > outageFrom * 2 ? INFRASTRUCTURE : accepted(request)));
        const { window } = recorded(await recordWindow(windowRun(store, windowRecord(true), {
          routeHealth: async () => (routeDown ? { kind: "unreachable", reason: "down" } : { kind: "reachable" }),
        }, route)));
        if (!("ending" in window)) throw new Error("a dispatched window records its ending");
        expect(endingOf(store.files.get(WINDOW_FILES.window) ?? "")).toEqual({ kind: "dispatched", ending: window.ending });
      }), { numRuns: 14 });
    });
  });

  it("refuses to re-decide against a preregistration whose bytes changed", () => {
    const window = { preregistration: { path: LOADED.ref.path, digest: LOADED.ref.digest }, facts: UNREACHABLE_FACTS, ending: { kind: "not-dispatched" as const } };
    expect(checkPreregistrationUnchanged(window, LOADED, "w")).toEqual({ ok: true, value: null });
    const edited = { ...LOADED, ref: { ...LOADED.ref, digest: "e".repeat(64) } };
    expect(checkPreregistrationUnchanged(window, edited, "w")).toMatchObject({ ok: false, error: expect.stringContaining("changed after window w was recorded") });
  });

  it("retains a new assessment, ignores identical bytes and refuses different bytes (property)", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/), fc.string(), fc.string(), (assessorId, first, second) => {
      const external = { path: "a.json", text: assessmentText(assessorId, `m${first}`) };
      const fresh = retentionStep(external, () => null, (file) => file);
      expect(fresh).toEqual({ ok: true, value: { kind: "retain", file: `assessments/${assessorId}.json`, text: external.text } });
      expect(retentionStep(external, () => external.text, (file) => file)).toEqual({ ok: true, value: { kind: "already-retained" } });
      const other = { path: "b.json", text: assessmentText(assessorId, `m${second}`) };
      const conflicting = retentionStep(other, () => external.text, (file) => file);
      expect(conflicting.ok).toBe(first === second);
      if (!conflicting.ok) expect(conflicting.error).toContain("never overwritten");
    }), { numRuns: 50 });
  });

  it("refuses an unparseable assessment by its path", () => {
    expect(parseAssessmentText("{", "x.json")).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid assessment x\.json: /) });
    expect(parseAssessmentText(assessmentText("../escape", "m"), "x.json")).toMatchObject({ ok: false, error: expect.stringContaining("assessorId") });
  });
});

describe("recordWindow (--pilot)", () => {
  it("retains a blocked window: no dispatch, a closed window record, key/packet/rubric and an incomplete decision", async () => {
    const store = await blockedWindow();
    const window = json(store, WINDOW_FILES.window);
    expect(window).toMatchObject({ dispatch: { kind: "not-attempted" }, observations: 0 });
    expect(typeof window["endedAt"]).toBe("string");
    expect(store.files.has(WINDOW_FILES.observations)).toBe(false);
    expect(json(store, WINDOW_FILES.key)).toMatchObject({ windowId: "test-window", entries: [] });
    expect(store.files.has("assessments/rubric-v1.json")).toBe(true);
    const decision = json(store, WINDOW_FILES.decision);
    expect(decision).toMatchObject({ schemaVersion: 1, preregistration: LOADED.ref, decidedFrom: { observations: 0, assessors: ["rubric-v1"] } });
    expect((decision["decision"] as { kind: string }).kind).toBe("incomplete-missing-measurement");
    expect(store.files.get(WINDOW_FILES.decisionLog)).toBe(`${JSON.stringify(decision)}\n`);
  });

  it("never overwrites a retained window", async () => {
    const store = await blockedWindow();
    const before = new Map(store.files);
    const writes = store.writes.length;
    const again = await recordWindow(windowRun(store, windowRecord(false)));
    expect(again).toEqual({ ok: false, error: "window mem:/window/ already exists; a retained window is never overwritten" });
    expect(store.writes).toHaveLength(writes);
    expect(store.files).toEqual(before);
  });

  it("runs the matched dispatch over the port and clock it is given, persisting each sample as it lands", async () => {
    const store = memoryStore();
    const route = fakeRoute(accepted);
    // Each dispatch sees how many observations were persisted before it.
    const persistedAtDispatch: number[] = [];
    const counted: FakeRoute = {
      ...route,
      dispatch: async (request) => {
        persistedAtDispatch.push((store.files.get(WINDOW_FILES.observations) ?? "").split("\n").filter(Boolean).length);
        return route.dispatch(request);
      },
    };
    const progress: string[] = [];
    decidedRecord(await recordWindow(windowRun(store, windowRecord(true), { onPair: (index, total) => { progress.push(`${index + 1}/${total}`); } }, counted)));
    const lines = (store.files.get(WINDOW_FILES.observations) ?? "").trim().split("\n");
    // The fake route answers every attempt at once: attempt n sees the n-1 samples before it persisted.
    expect(persistedAtDispatch).toEqual(lines.map((_line, index) => index));
    expect(route.requests).toHaveLength(lines.length);
    expect(progress).toHaveLength(lines.length / 2);
    const samples = lines.map((line) => JSON.parse(line) as { pairId: string; arm: string; dispatchToIngestionMs: number });
    // The window's sample timing is read from the injected monotonic clock.
    expect(samples.every((entry) => entry.dispatchToIngestionMs === ATTEMPT_MS)).toBe(true);
    const payloads = (store.files.get(WINDOW_FILES.payloads) ?? "").trim().split("\n").map((line) => JSON.parse(line) as { pairId: string; arm: string });
    expect(payloads.map(({ pairId, arm }) => `${pairId}|${arm}`)).toEqual(samples.map(({ pairId, arm }) => `${pairId}|${arm}`));
    expect(json(store, WINDOW_FILES.window)["observations"]).toBe(lines.length);
    // The rubric read every case input the window resolved: every accepted sample is blinded and scored.
    expect((json(store, "assessments/rubric-v1.json")["entries"] as unknown[]).length).toBe(lines.length);
  });

  it("refuses a window whose case inputs do not resolve before writing anything", async () => {
    const store = memoryStore();
    const [first, ...rest] = prereg.cells;
    if (first === undefined) throw new Error("the preregistration has no cell");
    const [broken, ...cases] = first.workload.cases;
    if (broken === undefined) throw new Error(`${first.cell} has no case`);
    const unresolvable: Preregistration = { ...prereg, cells: [{ ...first, workload: { ...first.workload, cases: [{ ...broken, source: "corpus:gone" }, ...cases] } }, ...rest] };
    const route = fakeRoute(accepted);
    const outcome = await recordWindow(windowRun(store, windowRecord(true), { preregistration: { ...LOADED, prereg: unresolvable } }, route));
    expect(outcome).toEqual({
      ok: false,
      error: `window test-window cannot dispatch: its preregistered case inputs do not resolve:\n  - ${first.cell} case ${broken.caseId}: corpus case gone is not in the corpus`,
    });
    expect(store.writes).toEqual([]);
    expect(route.requests).toHaveLength(0);
    // A window that will not dispatch never resolves its inputs.
    decidedRecord(await recordWindow(windowRun(memoryStore(), windowRecord(false), { preregistration: { ...LOADED, prereg: unresolvable } })));
  });

  it("loads the workload corpus only for a window that dispatches: a blocked or --preflight-only window is retained whatever the corpus", async () => {
    const loads: string[] = [];
    const unloadable = { ...WORKLOAD, loadCorpusCases: () => { loads.push("load"); return { ok: false as const, error: "ENOENT: no such corpus" }; } };
    const preflightOnly: WindowRecord = { ...windowRecord(true), dispatch: planDispatch(READY, true) };
    for (const record of [windowRecord(false), preflightOnly]) {
      const store = memoryStore();
      const outcome = decidedRecord(await recordWindow(windowRun(store, record, { workload: unloadable })));
      expect(outcome.decision).toBe("incomplete-missing-measurement");
      expect(json(store, WINDOW_FILES.window)).toMatchObject({ dispatch: record.dispatch, observations: 0 });
      expect(store.files.has(WINDOW_FILES.decision)).toBe(true);
    }
    expect(loads).toEqual([]);

    // A window that will dispatch loads it first, and refuses before writing anything.
    const store = memoryStore();
    const route = fakeRoute(accepted);
    expect(await recordWindow(windowRun(store, windowRecord(true), { workload: unloadable }, route))).toEqual({
      ok: false,
      error: "window test-window cannot dispatch: its workload corpus does not load: ENOENT: no such corpus",
    });
    expect(loads).toEqual(["load"]);
    expect(store.writes).toEqual([]);
    expect(route.requests).toHaveLength(0);
  });

  it("records a window the route fail-fast stopped: its ending in window.json and in the result, every landed sample, and an incomplete decision", async () => {
    const store = memoryStore();
    const run = windowRun(store, windowRecord(true), {
      routeHealth: async () => ({ kind: "unreachable", reason: "fetch failed (connect ECONNREFUSED)" }),
    }, fakeRoute(() => INFRASTRUCTURE));
    const { window, decision } = recorded(await recordWindow(run));
    expect(decided(decision).decision).toBe("incomplete-missing-measurement");
    const ending = {
      kind: "aborted", afterPairs: 1, scheduledPairs: expect.any(Number),
      reason: { kind: "route-unreachable", reason: "fetch failed (connect ECONNREFUSED)" },
    };
    expect(window).toMatchObject({ dispatch: { kind: "dispatched" }, observations: 2, ending });
    // The result IS the record written: one source of how the window ended.
    expect(json(store, WINDOW_FILES.window)).toEqual(JSON.parse(JSON.stringify(window)));
    expect((store.files.get(WINDOW_FILES.observations) ?? "").trim().split("\n")).toHaveLength(2);
  });

  it("closes a window whose route probe throws as route-unreachable with the error, never leaving it open", async () => {
    const store = memoryStore();
    const run = windowRun(store, windowRecord(true), {
      routeHealth: async () => { throw new Error("probe crashed"); },
    }, fakeRoute(() => INFRASTRUCTURE));
    const { window } = recorded(await recordWindow(run));
    expect(window).toMatchObject({
      endedAt: expect.any(String),
      ending: { kind: "aborted", afterPairs: 1, reason: { kind: "route-unreachable", reason: "the route probe failed: probe crashed" } },
    });
    expect(json(store, WINDOW_FILES.window)).toMatchObject({ endedAt: expect.any(String), ending: { kind: "aborted" } });
    expect(store.files.has(WINDOW_FILES.decision)).toBe(true);
  });

  it("records a completed schedule's ending, and none for a window that never dispatched", async () => {
    const dispatched = memoryStore();
    const { window } = recorded(await recordWindow(windowRun(dispatched, windowRecord(true), {}, fakeRoute(accepted))));
    expect(window).toMatchObject({ ending: { kind: "completed" } });
    expect(json(dispatched, WINDOW_FILES.window)["ending"]).toMatchObject({ kind: "completed" });
    const readBack = parseRetainedWindow(dispatched.files.get(WINDOW_FILES.window) ?? "", "w.json");
    expect(readBack.ok && readBack.value.ending).toEqual({ kind: "dispatched", ending: { kind: "completed", pairs: expect.any(Number) } });
    const blocked = recorded(await recordWindow(windowRun(memoryStore(), windowRecord(false))));
    expect(blocked.window).toMatchObject({ dispatch: { kind: "not-attempted" }, observations: 0 });
    expect(blocked.window).not.toHaveProperty("ending");
    expect(json(await blockedWindow(), WINDOW_FILES.window)).not.toHaveProperty("ending");
  });

  it("names a window by its preregistration id and a path-safe start time", () => {
    expect(pilotWindowId("gcd-ad11-pilot-1", "2026-10-03T09:23:39.047Z")).toBe("gcd-ad11-pilot-1--2026-10-03T09-23-39-047Z");
    // Every retained window belongs to one of the retained preregistrations (pilot-1, pilot-2).
    const preregistrationIds = [preregBytes, pilot2PreregBytes].map((bytes) => (JSON.parse(bytes.toString("utf-8")) as { id: string }).id);
    for (const id of readdirSync(join(HERE, "windows"))) {
      expect(preregistrationIds.some((preregistrationId) => id.startsWith(`${preregistrationId}--`)), id).toBe(true);
      expect(id).not.toMatch(/[:.]/);
    }
  });

  it("records how a window ended even when the rubric cannot assess it (key and packet kept, no rubric file, no decision)", async () => {
    const store = memoryStore();
    const undeclared: Preregistration = {
      ...prereg,
      cells: prereg.cells.map((cell) => ({
        ...cell,
        workload: { ...cell.workload, cases: cell.workload.cases.map((entry) => ({ ...entry, knownDefects: [] })) },
      })),
    };
    const route = fakeRoute(accepted);
    const outcome = recorded(await recordWindow(windowRun(store, windowRecord(true), { preregistration: { ...LOADED, prereg: undeclared } }, route)));
    expect(outcome.decision).toMatchObject({ ok: false, error: expect.stringMatching(/^the rubric assessor cannot assess window test-window:/) });
    expect(outcome.window).toMatchObject({ ending: { kind: "completed" } });
    const window = json(store, WINDOW_FILES.window);
    const samples = route.requests.length;
    expect(samples).toBeGreaterThan(0);
    expect(window["observations"]).toBe(samples);
    expect(typeof window["endedAt"]).toBe("string");
    expect(store.files.has(WINDOW_FILES.key)).toBe(true);
    expect(store.files.has(WINDOW_FILES.packet)).toBe(true);
    expect(store.files.has("assessments/rubric-v1.json")).toBe(false);
    expect(store.files.has(WINDOW_FILES.decision)).toBe(false);
  });
});

describe("decideRetainedWindow (--decide)", () => {
  it("re-decides from retained evidence and appends every decision to the log", async () => {
    const store = await blockedWindow();
    const outcome = decided(decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [], now: clock }));
    expect(outcome).toEqual({ kind: "recorded", decision: "incomplete-missing-measurement", file: "mem:/window/release-decision.json" });
    const log = (store.files.get(WINDOW_FILES.decisionLog) ?? "").trim().split("\n").map((line) => JSON.parse(line));
    expect(log).toHaveLength(2);
    expect(log[0].decidedAt).not.toBe(log[1].decidedAt);
    expect(json(store, WINDOW_FILES.decision)).toEqual(log[1]);
  });

  it("retains an external assessment once, and refuses a different one for the same assessor without deciding", async () => {
    const store = await blockedWindow();
    const first = { path: "human.json", text: assessmentText("human-blind-1", "independent blinded review") };
    const once = decided(decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [first], now: clock }));
    expect(once.decision).toBe("incomplete-missing-measurement");
    expect(store.files.get("assessments/human-blind-1.json")).toBe(first.text);
    expect((json(store, WINDOW_FILES.decision)["decidedFrom"] as { assessors: string[] }).assessors).toEqual(["human-blind-1", "rubric-v1"]);
    decided(decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [first], now: clock }));

    const logBefore = store.files.get(WINDOW_FILES.decisionLog);
    const conflicting = decideRetainedWindow({
      store, loadPreregistration: loadSame, now: clock,
      externalAssessments: [{ path: "human.json", text: assessmentText("human-blind-1", "a second, more favourable opinion") }],
    });
    expect(conflicting).toEqual({
      ok: false,
      error: "assessment mem:/window/assessments/human-blind-1.json is already retained with different content; a retained assessment is never overwritten",
    });
    expect(store.files.get("assessments/human-blind-1.json")).toBe(first.text);
    expect(store.files.get(WINDOW_FILES.decisionLog)).toBe(logBefore);
  });

  it("refuses a preregistration changed after the window, before deciding anything", async () => {
    const store = await blockedWindow();
    const decisions = store.files.get(WINDOW_FILES.decisionLog);
    const edited = (): Result<LoadedPreregistration, string> => ({ ok: true, value: { ...LOADED, ref: { ...LOADED.ref, digest: "e".repeat(64) } } });
    const result = decideRetainedWindow({ store, loadPreregistration: edited, externalAssessments: [], now: clock });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`preregistration ${LOADED.ref.path} changed after window mem:/window/ was recorded`) });
    expect(store.files.get(WINDOW_FILES.decisionLog)).toBe(decisions);
  });

  it("refuses inconsistent evidence (AS-017): surfaces every problem and records no decision", async () => {
    const store = await blockedWindow();
    const decisionBefore = store.files.get(WINDOW_FILES.decision);
    const logBefore = store.files.get(WINDOW_FILES.decisionLog);
    const { records } = await runWindow(fakeRoute(accepted));
    const sample = JSON.stringify(records[0]?.sample);
    // A sample behind a blocked preflight, recorded twice.
    store.files.set(WINDOW_FILES.observations, `${sample}\n${sample}\n`);
    const writes = store.writes.length;
    const result = decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [], now: clock });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.kind).toBe("inconsistent");
    const problems = result.value.kind === "inconsistent" ? result.value.problems.join("\n") : "";
    expect(problems).toContain("is recorded twice");
    expect(problems).toContain("a blocked preflight dispatches nothing, yet samples are recorded");
    expect(store.writes).toHaveLength(writes);
    expect(store.files.get(WINDOW_FILES.decision)).toBe(decisionBefore);
    expect(store.files.get(WINDOW_FILES.decisionLog)).toBe(logBefore);
  });

  it("re-decides every retained window to exactly its retained decision and cells", () => {
    const loadRetained = (path: string): Result<LoadedPreregistration, string> => {
      const parsed = parsePreregistrationFile(readFileSync(join(REPO_ROOT, path)), path);
      return parsed.ok ? { ok: true, value: { ref: { path, digest: parsed.value.digest, id: parsed.value.prereg.id }, prereg: parsed.value.prereg } } : parsed;
    };
    const windows = readdirSync(join(HERE, "windows"));
    expect(windows.length).toBeGreaterThan(0);
    for (const id of windows) {
      const dir = join(HERE, "windows", id);
      const files = new Map<string, string>();
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          const path = join(entry.parentPath, entry.name);
          files.set(path.slice(dir.length + 1), readFileSync(path, "utf-8"));
        }
      }
      const retained = JSON.parse(files.get(WINDOW_FILES.decision) ?? "null") as { decision: unknown; cells: unknown };
      const store = memoryStore(files);
      decided(decideRetainedWindow({ store, loadPreregistration: loadRetained, externalAssessments: [], now: clock }));
      const fresh = json(store, WINDOW_FILES.decision);
      expect(JSON.stringify(fresh["decision"]), id).toBe(JSON.stringify(retained.decision));
      expect(JSON.stringify(fresh["cells"]), id).toBe(JSON.stringify(retained.cells));
    }
  });

  it("refuses a window whose observation log is corrupt", async () => {
    const store = await blockedWindow();
    store.files.set(WINDOW_FILES.observations, "{oops\n");
    expect(decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [], now: clock }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^observation line 1: /) });
  });
});
