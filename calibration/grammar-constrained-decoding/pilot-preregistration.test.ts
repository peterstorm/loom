import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { buildPairSchedule, encodePreregistration, parsePreregistration, type Preregistration, type ReleasePolicy } from "./pilot-preregistration";
import {
  fixtureBytes,
  HERE,
  LOADED,
  pilot2PreregBytes,
  preregBytes,
  extractionOnlyCell,
  PILOT_1,
  PILOT_2,
  REPO_ROOT,
  RETAINED_PREREGISTRATIONS,
  testPreregistration,
} from "./pilot-test-fixtures";
import { CELL_KEYS, contentDigest } from "./pilot-vocabulary";

describe("preregistration (retained before any window)", () => {
  it("parses the retained preregistration with the four required cells and >=100 pairs each", () => {
    expect(PILOT_1.cells.map((cell) => cell.cell).sort()).toEqual([...CELL_KEYS].sort());
    const schedule = buildPairSchedule(PILOT_1);
    const perCell = Object.fromEntries(CELL_KEYS.map((cell) => [cell, schedule.filter((pair) => pair.cell === cell).length]));
    expect(perCell).toEqual({ "reviewer-payload/v2": 104, "reviewer-payload/v3": 104, "judge-verdict/v1": 100, "refutation-verdict/v1": 100 });
    expect(PILOT_1.guardrails.p95RatioBound).toBe(1.25);
  });

  it("pins the exact workload fixture bytes by content address", () => {
    expect(PILOT_1.workloadFixturesDigest).toBe(contentDigest(fixtureBytes));
  });

  it("pins each retained preregistration once, in the manifest: its bytes hash to the pin and parse to its id", () => {
    for (const { path, id, digest } of RETAINED_PREREGISTRATIONS) {
      const bytes = readFileSync(join(REPO_ROOT, path));
      expect(contentDigest(bytes), path).toBe(digest);
      const parsed = parsePreregistration(JSON.parse(bytes.toString("utf-8")));
      expect(parsed.ok && parsed.value.id, path).toBe(id);
    }
    // Every preregistration file is pinned, so a new one cannot land without its pin.
    const files = readdirSync(HERE).filter((file) => /^preregistration.*\.json$/.test(file)).map((file) => relative(REPO_ROOT, join(HERE, file)));
    expect([...files].sort()).toEqual(RETAINED_PREREGISTRATIONS.map((ref) => ref.path).sort());
    expect(RETAINED_PREREGISTRATIONS).toContainEqual(LOADED.ref);
  });

  it("refuses preregistrations that loosen the spec or under-size a cell", () => {
    type RawCase = { caseId: string; difficulty: string; knownDefects: unknown[] };
    type RawPrereg = {
      minimumPairsPerCell: number;
      semanticAttemptBudget: number;
      guardrails: Record<string, number>;
      cells: Array<{ qualification: unknown; workload: { repeatsPerCase: number; cases: RawCase[] } }>;
    };
    const base = JSON.parse(preregBytes.toString("utf-8")) as RawPrereg;
    const cellAt = (raw: RawPrereg, index: number) => raw.cells[index] as RawPrereg["cells"][number];
    const mutate = (change: (raw: RawPrereg) => void): readonly string[] => {
      const raw = structuredClone(base);
      change(raw);
      const parsed = parsePreregistration(raw);
      return parsed.ok ? [] : parsed.error;
    };
    expect(mutate((raw) => { raw.guardrails.p95RatioBound = 1.3; })).not.toEqual([]);
    expect(mutate((raw) => { raw.minimumPairsPerCell = 50; })).not.toEqual([]);
    expect(mutate((raw) => { raw.cells.pop(); }).join()).toContain("refutation-verdict/v1 must be preregistered exactly once");
    expect(mutate((raw) => { cellAt(raw, 2).workload.repeatsPerCase = 24; }).join()).toContain("96 paired requests < preregistered minimum 100");
    expect(mutate((raw) => { cellAt(raw, 2).workload.cases = cellAt(raw, 2).workload.cases.map((entry) => ({ ...entry, difficulty: "easy" })); }).join())
      .toContain("needs at least one hard case");
    expect(mutate((raw) => { (cellAt(raw, 0).workload.cases[1] as RawCase).knownDefects = []; }).join()).toContain("held-out known-defect case must name its known defects");
    expect(mutate((raw) => { (cellAt(raw, 0).workload.cases[1] as RawCase).caseId = (cellAt(raw, 0).workload.cases[0] as RawCase).caseId; }).join())
      .toContain("case ids must be unique");
    expect(mutate((raw) => { raw.semanticAttemptBudget = 3; })).not.toEqual([]);
    expect(mutate((raw) => { raw.guardrails["requiredIndependentAssessors"] = 1; })).not.toEqual([]);
    expect(mutate((raw) => { cellAt(raw, 0).qualification = { kind: "constrained-emission", enforcedConstraints: [], evidence: "x" }; })).not.toEqual([]);
  });
});

describe("paired schedule", () => {
  it("is deterministic, unique and ABBA-counterbalanced per cell", () => {
    const first = buildPairSchedule(PILOT_1);
    expect(buildPairSchedule(PILOT_1)).toEqual(first);
    expect(new Set(first.map((pair) => pair.pairId)).size).toBe(first.length);
    for (const cell of CELL_KEYS) {
      const pairs = first.filter((pair) => pair.cell === cell);
      const emissionFirst = pairs.filter((pair) => pair.armOrder[0] === "emission-enabled").length;
      expect(Math.abs(emissionFirst * 2 - pairs.length)).toBeLessThanOrEqual(2);
    }
  });

  it("schedules nothing for an extraction-only-qualified cell (no fabricated samples)", () => {
    const schedule = buildPairSchedule(testPreregistration(PILOT_1, extractionOnlyCell("judge-verdict/v1")));
    expect(schedule.some((pair) => pair.cell === "judge-verdict/v1")).toBe(false);
  });

  it("is a permutation of the same pairs under any seed (property)", () => {
    const prereg = testPreregistration();
    const canonical = buildPairSchedule(prereg).map((pair) => pair.pairId).sort();
    fc.assert(fc.property(fc.nat(), (seed) => {
      const reseeded = buildPairSchedule({ ...prereg, scheduleSeed: seed });
      expect(reseeded.map((pair) => pair.pairId).sort()).toEqual(canonical);
    }), { numRuns: 20 });
  });
});

describe("release policy (fixed by the preregistration, before any window)", () => {
  type RawPrereg = Record<string, unknown>;
  const pilot1 = (): RawPrereg => JSON.parse(preregBytes.toString("utf-8")) as RawPrereg;
  const pilot2 = (): RawPrereg => JSON.parse(pilot2PreregBytes.toString("utf-8")) as RawPrereg;
  const parsedPolicy = (raw: RawPrereg) => {
    const parsed = parsePreregistration(raw);
    return parsed.ok ? parsed.value.releasePolicy : null;
  };

  it("parses the retained pilot-1 preregistration (schemaVersion 1, no field) to capable-route-required", () => {
    expect(PILOT_1.schemaVersion).toBe(1);
    expect(PILOT_1.releasePolicy).toEqual({ kind: "capable-route-required" });
  });

  it("parses pilot-2 to per-route-engine-authoritative over exactly pilot-1's route, workload, cells and guardrails", () => {
    const parsed = parsePreregistration(pilot2());
    if (!parsed.ok) throw new Error(parsed.error.join("\n"));
    const prereg2 = parsed.value;
    expect(prereg2).toMatchObject({ schemaVersion: 2, id: "gcd-ad11-pilot-2", scheduleSeed: 20261008, releasePolicy: { kind: "per-route-engine-authoritative" } });
    const workloadOf = ({ route, workloadFixturesDigest, minimumPairsPerCell, semanticAttemptBudget, perAttemptTimeoutMs, guardrails, cells }: Preregistration) =>
      ({ route, workloadFixturesDigest, minimumPairsPerCell, semanticAttemptBudget, perAttemptTimeoutMs, guardrails, cells });
    expect(workloadOf(prereg2)).toEqual(workloadOf(PILOT_1));
    expect(Date.parse(prereg2.recordedAt)).toBeGreaterThan(Date.parse(PILOT_1.recordedAt));
  });

  it("requires a schemaVersion 2 preregistration to state its policy (no default) and refuses an unknown kind", () => {
    const { releasePolicy: _omitted, ...withoutPolicy } = pilot2();
    expect(parsedPolicy(withoutPolicy)).toBeNull();
    expect(parsedPolicy({ ...pilot2(), releasePolicy: { kind: "release-whatever-passes" } })).toBeNull();
    expect(parsedPolicy({ ...pilot2(), releasePolicy: { kind: "per-route-engine-authoritative", default: true } })).toBeNull();
    expect(parsedPolicy({ ...pilot2(), releasePolicy: "per-route-engine-authoritative" })).toBeNull();
    expect(parsedPolicy({ ...pilot2(), releasePolicy: { kind: "capable-route-required" } })).toEqual({ kind: "capable-route-required" });
  });

  it("never admits a policy field on schemaVersion 1, so a retained v1 record cannot be re-read under another rule", () => {
    expect(parsedPolicy({ ...pilot1(), releasePolicy: { kind: "per-route-engine-authoritative" } })).toBeNull();
    expect(parsedPolicy({ ...pilot1(), releasePolicy: { kind: "capable-route-required" } })).toBeNull();
    expect(parsedPolicy({ ...pilot1(), schemaVersion: 3 })).toBeNull();
  });

  it("types a schemaVersion 1 preregistration as carrying only capable-route-required", () => {
    expectTypeOf<Extract<Preregistration, { schemaVersion: 1 }>["releasePolicy"]>().toEqualTypeOf<Readonly<{ kind: "capable-route-required" }>>();
    expectTypeOf<Extract<Preregistration, { schemaVersion: 2 }>["releasePolicy"]>().toEqualTypeOf<ReleasePolicy>();
    if (PILOT_1.schemaVersion !== 1) throw new Error("the retained pilot-1 preregistration is schemaVersion 1");
    // @ts-expect-error — a schemaVersion 1 preregistration cannot carry the per-route policy.
    const forged: Preregistration = { ...PILOT_1, releasePolicy: { kind: "per-route-engine-authoritative" } };
    expect(forged.schemaVersion).toBe(1);
  });

  it("encodes each retained preregistration back to exactly its recorded record (a v1 record without the implied policy)", () => {
    expect(encodePreregistration(PILOT_1)).toEqual(pilot1());
    expect(encodePreregistration(PILOT_1)).not.toHaveProperty("releasePolicy");
    expect(encodePreregistration(PILOT_2)).toEqual(pilot2());
  });

  it("round-trips any parsed preregistration through its record (property)", () => {
    fc.assert(fc.property(
      fc.constantFrom(PILOT_1, PILOT_2), fc.nat(), fc.integer({ min: 200, max: 5000 }),
      (base, scheduleSeed, bootstrapResamples) => {
        const prereg: Preregistration = { ...base, scheduleSeed, guardrails: { ...base.guardrails, bootstrapResamples } };
        expect(parsePreregistration(encodePreregistration(prereg))).toEqual({ ok: true, value: prereg });
      },
    ), { numRuns: 40 });
  });

  it("admits a policy exactly when the version allows it (property)", () => {
    const POLICY_KINDS = ["capable-route-required", "per-route-engine-authoritative"] as const;
    fc.assert(fc.property(
      fc.constantFrom(1, 2, 3),
      fc.option(fc.oneof(fc.constantFrom(...POLICY_KINDS), fc.string()), { nil: undefined }),
      (schemaVersion, kind) => {
        const { releasePolicy: _omitted, ...base } = pilot2();
        const raw = kind === undefined ? { ...base, schemaVersion } : { ...base, schemaVersion, releasePolicy: { kind } };
        const known = kind !== undefined && (POLICY_KINDS as readonly string[]).includes(kind);
        const expected = schemaVersion === 1 && kind === undefined ? { kind: "capable-route-required" }
          : schemaVersion === 2 && known ? { kind }
          : null;
        expect(parsedPolicy(raw)).toEqual(expected);
      },
    ), { numRuns: 60 });
  });
});
