import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ObservedPair } from "./pilot-observation";
import { buildPairSchedule, type CellPreregistration, type ScheduledPair, type WorkloadCase } from "./pilot-preregistration";
import {
  compareQuality,
  parseBlindingKey,
  parseQualityAssessment,
  type BlindingKey,
  type EscapedDefect,
  type QualityAssessment,
  type QualityGuardrail,
} from "./pilot-quality";
import { ACCEPT_EMISSION, ACCEPT_EXTRACTION, sample, testPreregistration } from "./pilot-test-fixtures";
import { PILOT_ARMS, SEVERITIES, SEVERITY_WEIGHT, type PilotArm, type Severity } from "./pilot-vocabulary";

/**
 * Escaped-defect severity (AS-016) at its interface: the blinding-key and
 * assessment parsers, and `compareQuality` — the paired comparison of one
 * cell's held-out pairs over a blinding key and blinded assessments.
 */

const prereg = testPreregistration();
const CELL = "refutation-verdict/v1" as const;
const cell = prereg.cells.find((entry) => entry.cell === CELL) as CellPreregistration;
const caseOf = (pair: ScheduledPair): WorkloadCase => cell.workload.cases.find((entry) => entry.caseId === pair.caseId) as WorkloadCase;
const schedule = buildPairSchedule(prereg).filter((pair) => pair.cell === CELL);
const heldOut = schedule.filter((pair) => caseOf(pair).heldOutKnownDefectCase);

const TIMED_OUT = { outcome: { kind: "timeout", afterMs: 10 } };

/** Both arms of a scheduled pair, accepted unless the arm is listed as terminal. */
const observed = (pair: ScheduledPair, terminal: readonly PilotArm[] = []): ObservedPair => ({
  scheduled: pair,
  emission: sample(pair, "emission-enabled", 10, [terminal.includes("emission-enabled") ? TIMED_OUT : ACCEPT_EMISSION]),
  extraction: sample(pair, "extraction-only", 10, [terminal.includes("extraction-only") ? TIMED_OUT : ACCEPT_EXTRACTION]),
});

const blindId = (pair: ScheduledPair, arm: PilotArm): string => `blind-${pair.pairId}-${arm}`;

const keyFor = (pairs: readonly ScheduledPair[]): BlindingKey => ({
  schemaVersion: 1,
  windowId: "w",
  entries: pairs.flatMap((pair) => PILOT_ARMS.map((arm) => ({ blindId: blindId(pair, arm), pairId: pair.pairId, arm }))),
});

type Escapes = (pair: ScheduledPair, arm: PilotArm) => readonly EscapedDefect[];

const assessment = (assessorId: string, pairs: readonly ScheduledPair[], escapes: Escapes = () => []): QualityAssessment => ({
  schemaVersion: 1,
  assessorId,
  method: "test",
  blinded: true,
  entries: pairs.flatMap((pair) => PILOT_ARMS.map((arm) => ({ blindId: blindId(pair, arm), escapedDefects: [...escapes(pair, arm)] }))),
});

/** The case's own known defect, at a chosen severity. */
const knownAt = (pair: ScheduledPair, severity: Severity): readonly EscapedDefect[] =>
  caseOf(pair).knownDefects.map((defect) => ({ defectId: defect.defectId, severity }));

const compared = (pairs: readonly ObservedPair[], key: BlindingKey | null, assessments: readonly QualityAssessment[]): QualityGuardrail => {
  const result = compareQuality(cell, pairs, prereg, { key, assessments });
  if (!result.ok) throw new Error(result.error.join("\n"));
  return result.value;
};

const twoAssessors = (escapes: Escapes = () => []): readonly QualityAssessment[] =>
  [assessment("rubric-v1", heldOut, escapes), assessment("human-blind-1", heldOut, escapes)];

describe("blinding key and assessment parsers", () => {
  it("parses a blinding key and refuses duplicate blind ids or an unknown arm", () => {
    const key = keyFor(heldOut.slice(0, 2));
    expect(parseBlindingKey(key)).toEqual({ ok: true, value: key });
    const [first] = key.entries;
    expect(parseBlindingKey({ ...key, entries: [...key.entries, first] }).ok).toBe(false);
    expect(parseBlindingKey({ ...key, entries: [{ ...first, arm: "both" }] }).ok).toBe(false);
    expect(parseBlindingKey({ ...key, extra: true }).ok).toBe(false);
  });

  it("parses a blinded assessment and refuses an unblinded one, a duplicate blind id or an unknown severity", () => {
    const parsed = assessment("human-blind-1", heldOut.slice(0, 1), (pair) => knownAt(pair, "major"));
    expect(parseQualityAssessment(parsed)).toEqual({ ok: true, value: parsed });
    const [entry] = parsed.entries;
    expect(parseQualityAssessment({ ...parsed, blinded: false }).ok).toBe(false);
    expect(parseQualityAssessment({ ...parsed, entries: [entry, entry] }).ok).toBe(false);
    expect(parseQualityAssessment({ ...parsed, entries: [{ blindId: "b", escapedDefects: [{ defectId: "d", severity: "fatal" }] }] }).ok).toBe(false);
  });

  it("parses assessor ids as path-safe tokens (they name the retained file)", () => {
    const named = (assessorId: string) => ({ schemaVersion: 1, assessorId, method: "m", blinded: true, entries: [] });
    for (const safe of ["human-blind-1", "rubric-v1.2_b"]) expect(parseQualityAssessment(named(safe)).ok, safe).toBe(true);
    for (const unsafe of ["../escape", "a/b", ".hidden", "", "a b", "x".repeat(65)]) expect(parseQualityAssessment(named(unsafe)).ok, unsafe).toBe(false);
  });
});

describe("compareQuality (AS-016 paired escaped-defect comparison)", () => {
  it("is not measured when no held-out known-defect pair was observed", () => {
    const sound = schedule.filter((pair) => !caseOf(pair).heldOutKnownDefectCase).map((pair) => observed(pair));
    expect(sound.length).toBeGreaterThan(0);
    expect(compared(sound, null, [])).toEqual({
      comparison: null,
      guardrail: { guardrail: "escaped-defect-severity", verdict: "not-measured", detail: "no held-out known-defect pair was observed" },
    });
  });

  it("compares the held-out pairs only, and passes when neither arm lets a defect escape", () => {
    const result = compared(schedule.map((pair) => observed(pair)), keyFor(heldOut), twoAssessors());
    expect(result.comparison).toMatchObject({
      heldOutPairs: heldOut.length,
      assessors: ["human-blind-1", "rubric-v1"],
      meanEscapedSeverity: { "emission-enabled": 0, "extraction-only": 0 },
      pairedDifference: { mean: 0 },
      observedEscapes: [],
      disagreements: [],
    });
    expect(result.guardrail.verdict).toBe("pass");
  });

  it("is violated when the emission arm lets more severe defects escape than the extraction baseline", () => {
    const result = compared(heldOut.map((pair) => observed(pair)), keyFor(heldOut),
      twoAssessors((pair, arm) => (arm === "emission-enabled" ? knownAt(pair, "major") : [])));
    expect(result.comparison?.pairedDifference.mean).toBe(SEVERITY_WEIGHT.major);
    expect(result.guardrail.verdict).toBe("violated");
    expect(result.guardrail.detail).toContain("worse than the PR #52-only extraction baseline");
  });

  it("is inconclusive — never a pass — when the paired interval crosses the margin", () => {
    // Emission is worse on even repeats and better on odd ones: a mean at or below 0, a wide interval.
    const result = compared(heldOut.map((pair) => observed(pair)), keyFor(heldOut), twoAssessors((pair, arm) =>
      (pair.repeat % 2 === 0) === (arm === "emission-enabled") ? knownAt(pair, "critical") : []));
    expect(result.comparison?.pairedDifference.mean).toBeLessThanOrEqual(0);
    expect(result.comparison?.pairedDifference.interval.upper).toBeGreaterThan(prereg.guardrails.qualityNonInferiorityMargin);
    expect(result.guardrail.verdict).toBe("inconclusive");
  });

  it("lets every known defect escape at its preregistered severity when no payload was accepted", () => {
    const pairs = heldOut.map((pair) => observed(pair, ["emission-enabled"]));
    // Terminal samples are never blinded: the key covers the extraction arm only.
    const key: BlindingKey = { ...keyFor(heldOut), entries: keyFor(heldOut).entries.filter((entry) => entry.arm === "extraction-only") };
    const result = compared(pairs, key, twoAssessors());
    const terminal = result.comparison?.observedEscapes ?? [];
    expect(terminal).toHaveLength(heldOut.length);
    for (const escape of terminal) {
      const pair = heldOut.find((entry) => entry.pairId === escape.pairId) as ScheduledPair;
      expect(escape).toEqual({ pairId: pair.pairId, arm: "emission-enabled", defectId: caseOf(pair).knownDefects[0]?.defectId, observedBy: ["terminal-failure"], severity: caseOf(pair).knownDefects[0]?.severity });
    }
    expect(result.guardrail.verdict).toBe("violated");
  });

  it("retains disagreements and adjudicates conservatively — the maximum severity any assessor observed", () => {
    const [pair] = heldOut;
    if (pair === undefined) throw new Error("no held-out pair");
    const result = compared([observed(pair)], keyFor([pair]), [
      assessment("rubric-v1", [pair], (_pair, arm) => (arm === "extraction-only" ? knownAt(pair, "minor") : [])),
      assessment("human-blind-1", [pair], (_pair, arm) => (arm === "extraction-only" ? knownAt(pair, "critical") : [])),
    ]);
    const defectId = caseOf(pair).knownDefects[0]?.defectId;
    expect(result.comparison?.observedEscapes).toEqual([
      { pairId: pair.pairId, arm: "extraction-only", defectId, observedBy: ["rubric-v1", "human-blind-1"], severity: "critical" },
    ]);
    expect(result.comparison?.disagreements).toEqual([{
      pairId: pair.pairId,
      arm: "extraction-only",
      byAssessor: { "rubric-v1": [{ defectId, severity: "minor" }], "human-blind-1": [{ defectId, severity: "critical" }] },
    }]);
    expect(result.comparison?.meanEscapedSeverity["extraction-only"]).toBe(SEVERITY_WEIGHT.critical);
  });

  it("is not measured with fewer blinded assessors than preregistered, or with an unscored held-out request", () => {
    const pairs = heldOut.map((pair) => observed(pair));
    const one = compared(pairs, keyFor(heldOut), [assessment("rubric-v1", heldOut)]);
    expect(one.guardrail).toMatchObject({ verdict: "not-measured", detail: "1 blinded independent assessor(s) < preregistered 2" });
    expect(one.comparison?.meanEscapedSeverity).toEqual({ "emission-enabled": null, "extraction-only": null });

    const noKey = compared(pairs, null, twoAssessors());
    expect(noKey.guardrail.verdict).toBe("not-measured");
    expect(noKey.guardrail.detail).toContain(`${heldOut.length * 2} held-out request(s) unscored (first: ${heldOut[0]?.pairId}/emission-enabled: no blinding-key entry)`);

    const [first, ...rest] = heldOut;
    if (first === undefined) throw new Error("no held-out pair");
    const partial = compared(pairs, keyFor(heldOut), [assessment("rubric-v1", heldOut), assessment("human-blind-1", rest)]);
    expect(partial.guardrail.verdict).toBe("not-measured");
    expect(partial.guardrail.detail).toContain(`assessor human-blind-1 did not score blind id ${blindId(first, "emission-enabled")}`);
  });

  it("refuses a duplicate assessor and an assessment naming a defect the case does not declare", () => {
    const pairs = heldOut.map((pair) => observed(pair));
    expect(compareQuality(cell, pairs, prereg, { key: keyFor(heldOut), assessments: [assessment("rubric-v1", heldOut), assessment("rubric-v1", heldOut)] }))
      .toEqual({ ok: false, error: ["each assessor may submit exactly one assessment"] });
    const [first] = heldOut;
    if (first === undefined) throw new Error("no held-out pair");
    const invented = assessment("human-blind-1", heldOut, (pair, arm) =>
      pair === first && arm === "emission-enabled" ? [{ defectId: "invented", severity: "minor" }] : []);
    expect(compareQuality(cell, pairs, prereg, { key: keyFor(heldOut), assessments: [assessment("rubric-v1", heldOut), invented] }))
      .toEqual({ ok: false, error: [`assessor human-blind-1 names unknown defect invented for ${blindId(first, "emission-enabled")}`] });
  });

  it("scores both arms by the same rule: the paired difference is the mean weight difference, and swapping the arms negates it (property)", () => {
    const pairs = heldOut.map((pair) => observed(pair));
    const severity = fc.option(fc.constantFrom(...SEVERITIES), { nil: null });
    fc.assert(fc.property(
      fc.array(fc.tuple(severity, severity), { minLength: heldOut.length, maxLength: heldOut.length }),
      (assigned) => {
        const escapesBy = (swap: boolean): Escapes => (pair, arm) => {
          const [emission, extraction] = assigned[heldOut.indexOf(pair)] ?? [null, null];
          const chosen = (arm === "emission-enabled") !== swap ? emission : extraction;
          return chosen === null ? [] : knownAt(pair, chosen);
        };
        const weight = (value: Severity | null): number => (value === null ? 0 : SEVERITY_WEIGHT[value]);
        const expected = assigned.reduce((sum, [emission, extraction]) => sum + weight(emission) - weight(extraction), 0) / heldOut.length;
        const straight = compared(pairs, keyFor(heldOut), twoAssessors(escapesBy(false))).comparison?.pairedDifference.mean;
        const swapped = compared(pairs, keyFor(heldOut), twoAssessors(escapesBy(true))).comparison?.pairedDifference.mean;
        expect(straight).toBeCloseTo(expected, 10);
        expect(swapped).toBeCloseTo(-expected, 10);
      },
    ), { numRuns: 25 });
  });
});
