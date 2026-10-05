import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  contentDigest,
  decidePreflight,
  type PreflightFacts,
  type Preregistration,
  type Result,
} from "./pilot-core";
import {
  checkPreregistrationUnchanged,
  decideRetainedWindow,
  parseAssessmentText,
  parseObservationLog,
  parsePreregistrationFile,
  parseRetainedWindow,
  planDispatch,
  recordWindow,
  retentionStep,
  WINDOW_FILES,
  type DecisionOutcome,
  type LoadedPreregistration,
  type WindowRecord,
  type WindowStore,
} from "./pilot-retention";
import { accepted, fakeRoute, HERE, inputs, prereg, READY, runWindow } from "./pilot-test-fixtures";

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
    schemaVersion: 1,
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

const json = (store: MemoryStore, name: string): Record<string, unknown> => JSON.parse(store.files.get(name) ?? "null");

/** A blocked window as `--pilot` leaves it. */
async function blockedWindow(): Promise<MemoryStore> {
  const store = memoryStore();
  decided(await recordWindow({
    store, record: windowRecord(false), preregistration: LOADED,
    dispatch: () => { throw new Error("a blocked preflight never dispatches"); },
    externalAssessments: [], now: clock,
  }));
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
      value: { preregistration: { path: LOADED.ref.path, digest: LOADED.ref.digest }, facts: UNREACHABLE_FACTS },
    });
    expect(parseRetainedWindow(JSON.stringify({ preflightFacts: UNREACHABLE_FACTS }), "w.json")).toEqual({ ok: false, error: "w.json carries no preregistration record" });
    expect(parseRetainedWindow(JSON.stringify({ ...windowRecord(false), preflightFacts: {} }), "w.json"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^w\.json preflight facts: /) });
  });

  it("refuses to re-decide against a preregistration whose bytes changed", () => {
    const window = { preregistration: { path: LOADED.ref.path, digest: LOADED.ref.digest }, facts: UNREACHABLE_FACTS };
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
    const again = await recordWindow({
      store, record: windowRecord(false), preregistration: LOADED,
      dispatch: () => { throw new Error("unreachable"); }, externalAssessments: [], now: clock,
    });
    expect(again).toEqual({ ok: false, error: "window mem:/window/ already exists; a retained window is never overwritten" });
    expect(store.writes).toHaveLength(writes);
    expect(store.files).toEqual(before);
  });

  it("persists every sample as it lands and closes the window with its observation count", async () => {
    const store = memoryStore();
    const persistedAtLanding: number[] = [];
    const outcome = await recordWindow({
      store, record: windowRecord(true), preregistration: LOADED,
      dispatch: async (persist) => {
        const { records } = await runWindow(fakeRoute(accepted), (record) => {
          persist(record);
          persistedAtLanding.push((store.files.get(WINDOW_FILES.observations) ?? "").trim().split("\n").length);
        });
        return { records, inputs };
      },
      externalAssessments: [], now: clock,
    });
    decided(outcome);
    const lines = (store.files.get(WINDOW_FILES.observations) ?? "").trim().split("\n");
    expect(persistedAtLanding).toEqual(lines.map((_line, index) => index + 1));
    expect((store.files.get(WINDOW_FILES.payloads) ?? "").trim().split("\n")).toHaveLength(lines.length);
    expect(json(store, WINDOW_FILES.window)["observations"]).toBe(lines.length);
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
    let samples = 0;
    const outcome = await recordWindow({
      store, record: windowRecord(true), preregistration: { ...LOADED, prereg: undeclared },
      dispatch: async (persist) => {
        const { records } = await runWindow(fakeRoute(accepted), persist);
        samples = records.length;
        return { records, inputs };
      },
      externalAssessments: [], now: clock,
    });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/^the rubric assessor cannot assess window test-window:/) });
    const window = json(store, WINDOW_FILES.window);
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

  it("refuses a window whose observation log is corrupt", async () => {
    const store = await blockedWindow();
    store.files.set(WINDOW_FILES.observations, "{oops\n");
    expect(decideRetainedWindow({ store, loadPreregistration: loadSame, externalAssessments: [], now: clock }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/^observation line 1: /) });
  });
});
