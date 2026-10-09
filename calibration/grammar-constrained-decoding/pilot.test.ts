import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import { match } from "ts-pattern";
import { evaluatePilot, type CellOutcome, type MeasuredCell, type PassedCellEvidence, type PilotEvaluation } from "./pilot-core";
import type { SampleObservation } from "./pilot-observation";
import type { PreflightDecision } from "./pilot-preflight";
import { buildPairSchedule, type Preregistration, type ScheduledPair } from "./pilot-preregistration";
import type { BlindingKey, QualityAssessment } from "./pilot-quality";
import {
  ACCEPT_EMISSION,
  ACCEPT_EXTRACTION,
  READY,
  sample,
  constrainedCells,
  extractionOnlyCell,
  PILOT_1,
  PILOT_2,
  testPreregistration,
  type PreregistrationEdit,
  type AttemptSpec,
} from "./pilot-test-fixtures";
import { CELL_KEYS, type CellKey, type PilotArm } from "./pilot-vocabulary";

/**
 * The release decision at its one entry point, `evaluatePilot`: per-cell
 * measurements, every guardrail and the decision derived from them. The
 * parsed inputs and the quality comparison are pinned at their own seams
 * (pilot-preregistration, pilot-observation, pilot-preflight,
 * pilot-statistics and pilot-quality test suites); here AS-016 is pinned
 * only as it reaches the release decision.
 */

type SampleSpec = Readonly<{ ms: number; attempts: readonly AttemptSpec[] }>;

/** A complete window over every scheduled pair, with a blinding key and two
 *  blinded assessors whose escapes the caller decides. */
function fullWindow(
  prereg: Preregistration,
  spec: (pair: ScheduledPair, arm: PilotArm) => SampleSpec,
  escapes: (pair: ScheduledPair, arm: PilotArm, assessor: string) => readonly { defectId: string; severity: "minor" | "major" | "critical" }[] = () => [],
  assessorIds: readonly string[] = ["rubric-v1", "human-blind-1"],
): Readonly<{ observations: SampleObservation[]; key: BlindingKey; assessments: QualityAssessment[] }> {
  const schedule = buildPairSchedule(prereg);
  const observations: SampleObservation[] = [];
  const keyEntries: { blindId: string; pairId: string; arm: PilotArm }[] = [];
  for (const pair of schedule) {
    for (const arm of pair.armOrder) {
      const { ms, attempts } = spec(pair, arm);
      observations.push(sample(pair, arm, ms, attempts));
      keyEntries.push({ blindId: `blind-${keyEntries.length}`, pairId: pair.pairId, arm });
    }
  }
  const assessments = assessorIds.map((assessorId): QualityAssessment => ({
    schemaVersion: 1,
    assessorId,
    method: "test",
    blinded: true,
    entries: keyEntries.map((entry) => {
      const pair = schedule.find((candidate) => candidate.pairId === entry.pairId) as ScheduledPair;
      return { blindId: entry.blindId, escapedDefects: [...escapes(pair, entry.arm, assessorId)] };
    }),
  }));
  return { observations, key: { schemaVersion: 1, windowId: "test-window", entries: keyEntries }, assessments };
}

function evaluate(prereg: Preregistration, window: ReturnType<typeof fullWindow>, preflight: PreflightDecision = READY): PilotEvaluation {
  const evaluated = evaluatePilot({
    preregistration: prereg,
    preflight,
    observations: window.observations,
    quality: { key: window.key, assessments: window.assessments },
  });
  if (!evaluated.ok) throw new Error(evaluated.error.problems.join("\n"));
  return evaluated.value;
}

const measured = (cells: readonly CellOutcome[], cell: CellKey): Extract<CellOutcome, { kind: "measured" }> => {
  const found = cells.find((entry) => entry.cell === cell);
  if (found?.kind !== "measured") throw new Error(`${cell} is ${found?.kind ?? "absent"}`);
  return found;
};

const matchedArms = (pair: ScheduledPair, arm: PilotArm): SampleSpec => ({
  ms: 10_000 + pair.repeat * 37,
  attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION],
});

const BLOCKED: PreflightDecision = { kind: "blocked", blocks: [{ kind: "route-unreachable", reason: "ECONNREFUSED" }], runtime: READY.runtime };

const NO_CAPABLE_ROUTE = {
  kind: "no-qualified-capable-route",
  detail: "no preregistered cell is qualified constrained-emission on the intended deployment route; " +
    "AD-11: without a qualified capable route the constrained feature cannot be declared measured/done",
};

/** The kinds of every missing measurement a decision records, blocked or not. */
const missingKinds = (result: PilotEvaluation): readonly string[] => match(result.decision)
  .with({ kind: "incomplete-missing-measurement" }, ({ missing }) => missing.map((entry) => entry.kind))
  .with({ kind: "blocked-guardrail-violated" }, ({ alsoMissing }) => alsoMissing.map((entry) => entry.kind))
  .with({ kind: "done-allowed" }, () => [])
  .exhaustive();

// ---------------------------------------------------------------------------

describe("capable-route gap (folded into the done evidence)", () => {
  /** Every cell extraction-only: nothing is dispatched, so the window carries no sample. */
  const allExtractionOnly = (): Preregistration => {
    const base = testPreregistration();
    return {
      ...base,
      cells: base.cells.map((cell) => ({ ...cell, qualification: { kind: "extraction-only", reason: "route rejects the schema", evidence: "test" } })),
    };
  };
  const decide = (prereg: Preregistration, preflight: PreflightDecision) => {
    const evaluated = evaluatePilot({ preregistration: prereg, preflight, observations: [], quality: { key: null, assessments: [] } });
    if (!evaluated.ok) throw new Error(evaluated.error.problems.join("\n"));
    return evaluated.value;
  };

  it("records the absent capable route as the one missing measurement when nothing else is missing", () => {
    const { cells, decision } = decide(allExtractionOnly(), READY);
    expect(cells.map((cell) => cell.kind)).toEqual(["qualification-only", "qualification-only", "qualification-only", "qualification-only"]);
    expect(decision).toEqual({ kind: "incomplete-missing-measurement", missing: [NO_CAPABLE_ROUTE] });
  });

  it("records it after the preflight block and before every cell's missing measurement", () => {
    expect(decide(allExtractionOnly(), BLOCKED).decision).toEqual({
      kind: "incomplete-missing-measurement",
      missing: [{ kind: "preflight-blocked", blocks: BLOCKED.kind === "blocked" ? BLOCKED.blocks : [] }, NO_CAPABLE_ROUTE],
    });
    const unconstrained = decide(PILOT_1, BLOCKED).decision;
    if (unconstrained.kind !== "incomplete-missing-measurement") throw new Error(unconstrained.kind);
    expect(unconstrained.missing.map((missing) => missing.kind)).toEqual([
      "preflight-blocked", "no-qualified-capable-route", "cell-not-measured", "cell-not-measured", "cell-not-measured", "cell-not-measured",
    ]);
    expect(unconstrained.missing[1]).toEqual(NO_CAPABLE_ROUTE);
  });

  it("keeps it alongside a violation that blocks done", () => {
    const prereg = testPreregistration();
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => ({
      ms: (arm === "emission-enabled" ? 20_000 : 10_000) + pair.repeat,
      attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION],
    })));
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
    if (result.decision.kind !== "blocked-guardrail-violated") return;
    expect(result.decision.alsoMissing[0]).toEqual(NO_CAPABLE_ROUTE);
  });
});

describe("release decision", () => {
  it("allows done only for a complete, all-passing window on a qualified capable route", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.decision.kind).toBe("done-allowed");
    if (result.decision.kind !== "done-allowed") return;
    expect(result.decision.measuredCells.map((cell) => cell.cell).sort()).toEqual([...CELL_KEYS].sort());
    const v2 = measured(result.cells, "reviewer-payload/v2");
    expect(v2.measurement.observedPairs).toBe(104);
    expect(v2.measurement.emissionRates.toolUseRate).toBe(1);
    expect(v2.measurement.structural.providerEnforcedStructuralRetries).toBe(0);
    expect(v2.measurement.structural.rawArgumentObservation.duplicateKeyMeasurement).toBe("not-claimed");
  });

  it("derives a measured cell's verdicts from its own measurement; a hand-built measured cell does not type-check", () => {
    const prereg = testPreregistration();
    const cell = measured(evaluate(prereg, fullWindow(prereg, matchedArms)).cells, "judge-verdict/v1");
    const { measurement, guardrails } = cell;
    expect(guardrails["measurement-complete"].detail).toBe(`${measurement.observedPairs}/${measurement.scheduledPairs} preregistered pairs observed in both arms`);
    expect(guardrails["latency-p95"].detail).toContain(`p95 ratio ${measurement.latency.p95Ratio?.toFixed(3)}`);
    expect(guardrails["provider-structural-retries"].verdict).toBe(measurement.structural.providerEnforcedStructuralRetries === "not-applicable" ? "not-applicable" : "pass");
    // @ts-expect-error — only the evaluator's measureCell constructs a MeasuredCell.
    const forged: CellOutcome = { kind: "measured", cell: cell.cell, qualification: cell.qualification, measurement, guardrails };
    expect(forged.kind).toBe("measured");
  });

  it("never allows done on the retained (unconstrained) deployment route, however good the window", () => {
    const prereg = testPreregistration();
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
    if (result.decision.kind !== "incomplete-missing-measurement") return;
    expect(result.decision.missing.map((missing) => missing.kind)).toContain("no-qualified-capable-route");
    expect(measured(result.cells, "judge-verdict/v1").guardrails["provider-structural-retries"].verdict).toBe("not-applicable");
  });

  it("never lets one capable cell carry a measured unconstrained cell to done (capability is per cell)", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells("judge-verdict/v1"));
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(measured(result.cells, "judge-verdict/v1").guardrails["provider-structural-retries"].verdict).toBe("not-applicable");
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
    if (result.decision.kind !== "incomplete-missing-measurement") return;
    expect(result.decision.missing).toEqual([{
      kind: "no-qualified-capable-route",
      detail: "cells judge-verdict/v1 are qualified unconstrained-emission on the intended deployment route; " +
        "AD-11: every measured cell needs a qualified capable route before the constrained feature can be declared measured/done",
    }]);
  });

  it("records a blocked preflight as incomplete with every cell not measured and nothing fabricated", () => {
    const prereg = PILOT_1;
    const blocked: PreflightDecision = {
      kind: "blocked",
      blocks: [{ kind: "route-unreachable", reason: "ECONNREFUSED" }],
      runtime: READY.runtime,
    };
    const evaluated = evaluatePilot({ preregistration: prereg, preflight: blocked, observations: [], quality: { key: null, assessments: [] } });
    if (!evaluated.ok) throw new Error(evaluated.error.problems.join());
    expect(evaluated.value.cells.map((cell) => cell.kind)).toEqual(["not-measured", "not-measured", "not-measured", "not-measured"]);
    expect(evaluated.value.decision.kind).toBe("incomplete-missing-measurement");
    if (evaluated.value.decision.kind !== "incomplete-missing-measurement") return;
    expect(evaluated.value.decision.missing.map((missing) => missing.kind)).toEqual(
      expect.arrayContaining(["preflight-blocked", "no-qualified-capable-route", "cell-not-measured"]));
  });

  it("AS-015: blocks done when emission p95 exceeds the +25% bound", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => ({
      ms: (arm === "emission-enabled" ? 20_000 : 10_000) + pair.repeat,
      attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION],
    })));
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
    if (result.decision.kind !== "blocked-guardrail-violated") return;
    expect(result.decision.violations.map((violation) => `${violation.guardrail}:${violation.requirement}`)).toContain("latency-p95:AS-015");
    expect(result.decision.consequence).toBe("design-reconsideration-required");
  });

  it("treats an interval crossing the bound as inconclusive, which is not a pass", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    // Exactly 5 slow emission samples per cell: the observed p95 (nearest
    // rank) is 12 000 ms = 1.2x, but resamples with more than 5% slow
    // samples push p95 to 20 000 ms, so the interval crosses 1.25.
    const firstCase = (cell: CellKey) => prereg.cells.find((entry) => entry.cell === cell)?.workload.cases[0]?.caseId;
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => ({
      ms: arm === "extraction-only" ? 10_000 : pair.caseId === firstCase(pair.cell) && pair.repeat <= 5 ? 20_000 : 12_000,
      attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION],
    })));
    for (const cell of CELL_KEYS) {
      const latency = measured(result.cells, cell);
      expect(latency.measurement.latency.p95Ratio).toBeCloseTo(1.2);
      expect(latency.guardrails["latency-p95"].verdict).toBe("inconclusive");
    }
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
  });

  it("retains terminal failures separately and blocks on any increase", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    let failures = 0;
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => {
      if (arm === "emission-enabled" && pair.cell === "judge-verdict/v1" && failures < 1) {
        failures += 1;
        return { ms: 900_000, attempts: [{ outcome: { kind: "timeout", afterMs: 900_000 } }] };
      }
      return matchedArms(pair, arm);
    }));
    const judge = measured(result.cells, "judge-verdict/v1");
    expect(judge.measurement.arms["emission-enabled"].terminalFailures.timeout).toBe(1);
    expect(judge.guardrails["terminal-failure-non-increase"].verdict).toBe("violated");
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
  });

  it("blocks on a retry caused by a constraint the route was verified to enforce (AS-004)", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    let injected = false;
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => {
      if (!injected && arm === "emission-enabled" && pair.cell === "refutation-verdict/v1") {
        injected = true;
        return { ms: 10_000, attempts: [{ ...ACCEPT_EMISSION, toolErrors: [{ class: "harness-schema-validation" }] }] };
      }
      return matchedArms(pair, arm);
    }));
    const refutation = measured(result.cells, "refutation-verdict/v1");
    expect(refutation.measurement.structural.providerEnforcedStructuralRetries).toBe(1);
    expect(refutation.guardrails["provider-structural-retries"].verdict).toBe("violated");
  });

  it("reports engine-only refusals, duplicates and non-emission as their own series", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => {
      if (arm !== "emission-enabled" || pair.cell !== "reviewer-payload/v2") return matchedArms(pair, arm);
      return match3(pair.repeat % 3);
    }));
    function match3(slot: number): SampleSpec {
      if (slot === 0) return { ms: 10_000, attempts: [ACCEPT_EXTRACTION] };
      if (slot === 1) return { ms: 10_000, attempts: [{ outcome: { kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } }, emissionCalls: 2 }, ACCEPT_EMISSION] };
      return { ms: 10_000, attempts: [{ ...ACCEPT_EMISSION, toolErrors: [{ class: "engine-refusal", code: "invalid-payload" }] }] };
    }
    const series = measured(result.cells, "reviewer-payload/v2").measurement;
    expect(series.structural.providerEnforcedStructuralRetries).toBe(0);
    expect(series.structural.engineOnlyRefusalRetries).toBeGreaterThan(0);
    expect(series.structural.duplicateCallRejections).toBeGreaterThan(0);
    expect(series.structural.nonEmissionSamples).toBeGreaterThan(0);
    expect(series.emissionRates.fallbackRate).toBeGreaterThan(0);
    expect(series.arms["emission-enabled"].retryCauses["duplicate-call"]).toBeGreaterThan(0);
  });

  it("keeps a partial window not-measured with its partial count, never extrapolated", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const window = fullWindow(prereg, matchedArms);
    const partial = { ...window, observations: window.observations.filter((observation) => !(observation.cell === "judge-verdict/v1" && observation.caseId === "judge-hard-readiness-barrier")) };
    const result = evaluate(prereg, partial);
    const judge = result.cells.find((cell) => cell.cell === "judge-verdict/v1");
    expect(judge).toMatchObject({ kind: "not-measured", scheduledPairs: 100, observedPairs: 75, partialObservations: 150 });
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
  });

  it("keeps an extraction-only-qualified cell as an explicit qualification outcome", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells(), extractionOnlyCell("reviewer-payload/v3"));
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.cells.find((cell) => cell.cell === "reviewer-payload/v3")?.kind).toBe("qualification-only");
    expect(result.decision.kind).toBe("done-allowed");
    if (result.decision.kind === "done-allowed") expect(result.decision.qualificationOnlyCells).toEqual(["reviewer-payload/v3"]);
  });

  it("refuses inconsistent evidence instead of repairing it", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const window = fullWindow(prereg, matchedArms);
    const problems = (observations: readonly SampleObservation[], preflight: PreflightDecision = READY) => {
      const evaluated = evaluatePilot({ preregistration: prereg, preflight, observations, quality: { key: window.key, assessments: window.assessments } });
      return evaluated.ok ? [] : evaluated.error.problems;
    };
    const first = window.observations[0] as SampleObservation;
    expect(problems([...window.observations, first]).join()).toContain("recorded twice");
    expect(problems([{ ...first, pairId: "unscheduled#x#r1" }]).join()).toContain("not a preregistered pair");
    expect(problems([first], { kind: "blocked", blocks: [{ kind: "route-unreachable", reason: "x" }], runtime: READY.runtime }).join())
      .toContain("a blocked preflight dispatches nothing");
  });
});

describe("escaped-defect severity (AS-016)", () => {
  const knownDefectOf = (pair: ScheduledPair, prereg: Preregistration) =>
    prereg.cells.find((cell) => cell.cell === pair.cell)?.workload.cases.find((entry) => entry.caseId === pair.caseId)?.knownDefects ?? [];

  it("is not measured with fewer than the preregistered blinded assessors", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, matchedArms, () => [], ["rubric-v1"]));
    expect(measured(result.cells, "judge-verdict/v1").guardrails["escaped-defect-severity"].verdict).toBe("not-measured");
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
  });

  it("blocks when the emission arm lets more severe defects escape than the PR #52-only baseline", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, matchedArms, (pair, arm) =>
      arm === "emission-enabled" ? knownDefectOf(pair, prereg).map((defect) => ({ ...defect })) : []));
    const judge = measured(result.cells, "judge-verdict/v1");
    expect(judge.guardrails["escaped-defect-severity"].verdict).toBe("violated");
    expect(judge.measurement.quality?.observedEscapes.length).toBeGreaterThan(0);
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
  });

  it("preserves assessor disagreements and adjudicates conservatively for both arms", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, matchedArms, (pair, _arm, assessor) =>
      assessor === "human-blind-1" && pair.cell === "refutation-verdict/v1" && pair.repeat === 1
        ? knownDefectOf(pair, prereg).map((defect) => ({ ...defect }))
        : []));
    const quality = measured(result.cells, "refutation-verdict/v1").measurement.quality;
    expect(quality?.disagreements.length).toBe(4); // 2 held-out cases x 2 arms at repeat 1
    expect(quality?.observedEscapes.every((escape) => escape.observedBy.includes("human-blind-1"))).toBe(true);
    expect(quality?.pairedDifference.mean).toBe(0);
  });

  it("counts every known defect as escaped when no payload was accepted", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) =>
      arm === "emission-enabled" && pair.cell === "judge-verdict/v1"
        ? { ms: 5_000, attempts: [{ outcome: { kind: "startup-refused", reason: "readiness refused" } }] }
        : matchedArms(pair, arm)));
    const quality = measured(result.cells, "judge-verdict/v1").measurement.quality;
    expect(quality?.observedEscapes.filter((escape) => escape.observedBy.includes("terminal-failure")).length).toBe(100);
  });

  it("refuses an assessment naming a defect the case does not have", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    const window = fullWindow(prereg, matchedArms, (pair) => (pair.cell === "judge-verdict/v1" && pair.repeat === 1 ? [{ defectId: "invented", severity: "minor" }] : []));
    const evaluated = evaluatePilot({ preregistration: prereg, preflight: READY, observations: window.observations, quality: { key: window.key, assessments: window.assessments } });
    expect(evaluated.ok).toBe(false);
  });
});

describe("decision soundness (properties)", () => {
  it("done-allowed implies every measured guardrail passed; any violation blocks done", () => {
    const prereg = testPreregistration(PILOT_1, constrainedCells());
    fc.assert(fc.property(
      fc.double({ min: 0.5, max: 2, noNaN: true }),
      fc.nat({ max: 3 }),
      (slowdown, emissionTimeouts) => {
        let timeouts = 0;
        const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => {
          if (arm === "emission-enabled" && pair.cell === "reviewer-payload/v2" && timeouts < emissionTimeouts) {
            timeouts += 1;
            return { ms: 900_000, attempts: [{ outcome: { kind: "timeout", afterMs: 900_000 } }] };
          }
          const base = 10_000 + pair.repeat * 50;
          return { ms: arm === "emission-enabled" ? base * slowdown : base, attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION] };
        }));
        const guardrails = result.cells.flatMap((cell) => (cell.kind === "measured" ? Object.values(cell.guardrails) : []));
        if (result.decision.kind === "done-allowed") {
          expect(guardrails.every((guardrail) => guardrail.verdict === "pass" || guardrail.verdict === "not-applicable")).toBe(true);
        }
        if (guardrails.some((guardrail) => guardrail.verdict === "violated")) {
          expect(result.decision.kind).toBe("blocked-guardrail-violated");
        }
        if (emissionTimeouts > 0) expect(result.decision.kind).not.toBe("done-allowed");
      },
    ), { numRuns: 12 });
  });
});

describe("per-route release policy (pilot-2: unconstrained emission, engine-authoritative)", () => {
  const perRoute = (...edits: readonly PreregistrationEdit[]) => testPreregistration(PILOT_2, ...edits);

  it("releases a complete, all-passing unconstrained window as unconstrained-engine-authoritative, AS-004 not applicable", () => {
    const prereg = perRoute();
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.decision.kind).toBe("done-allowed");
    if (result.decision.kind !== "done-allowed") return;
    expect(result.decision.measuredCells.map((cell) => [cell.cell, cell.releaseClass])).toEqual(
      prereg.cells.map((cell) => [cell.cell, "unconstrained-engine-authoritative"]));
    for (const cell of result.decision.measuredCells) {
      expect(cell.guardrails["provider-structural-retries"].verdict).toBe("not-applicable");
      expect(cell.guardrails["latency-p95"].verdict).toBe("pass");
      expect(cell.guardrails["terminal-failure-non-increase"].verdict).toBe("pass");
      expect(cell.guardrails["escaped-defect-severity"].verdict).toBe("pass");
    }
  });

  it("states each released cell's class: constrained cells keep AS-004 beside engine-authoritative ones", () => {
    const prereg = perRoute(constrainedCells("judge-verdict/v1"));
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.decision.kind).toBe("done-allowed");
    if (result.decision.kind !== "done-allowed") return;
    expect(Object.fromEntries(result.decision.measuredCells.map((cell) => [cell.cell, [cell.releaseClass, cell.guardrails["provider-structural-retries"].verdict]]))).toEqual({
      "reviewer-payload/v2": ["constrained", "pass"],
      "reviewer-payload/v3": ["constrained", "pass"],
      "judge-verdict/v1": ["unconstrained-engine-authoritative", "not-applicable"],
      "refutation-verdict/v1": ["constrained", "pass"],
    });
  });

  it("still blocks a constrained cell's provider-structural retry (AS-004 applies to constrained cells)", () => {
    const prereg = perRoute(constrainedCells());
    let injected = false;
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => {
      if (!injected && arm === "emission-enabled" && pair.cell === "refutation-verdict/v1") {
        injected = true;
        return { ms: 10_000, attempts: [{ ...ACCEPT_EMISSION, toolErrors: [{ class: "harness-schema-validation" }] }] };
      }
      return matchedArms(pair, arm);
    }));
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
    if (result.decision.kind !== "blocked-guardrail-violated") return;
    expect(result.decision.violations.map((violation) => `${violation.cell}:${violation.guardrail}`)).toEqual(["refutation-verdict/v1:provider-structural-retries"]);
  });

  it("blocks on an AS-015 violation and records no capable-route gap", () => {
    const prereg = perRoute();
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) => ({
      ms: (arm === "emission-enabled" ? 20_000 : 10_000) + pair.repeat,
      attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION],
    })));
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
    expect(missingKinds(result)).not.toContain("no-qualified-capable-route");
  });

  it("keeps a blocked preflight, a partial window and a missing assessor incomplete, without a capable-route gap", () => {
    const blocked = evaluatePilot({ preregistration: perRoute(), preflight: BLOCKED, observations: [], quality: { key: null, assessments: [] } });
    if (!blocked.ok) throw new Error(blocked.error.problems.join());
    expect(blocked.value.decision.kind).toBe("incomplete-missing-measurement");
    expect(missingKinds(blocked.value)).toEqual(["preflight-blocked", "cell-not-measured", "cell-not-measured", "cell-not-measured", "cell-not-measured"]);

    const prereg = perRoute();
    const window = fullWindow(prereg, matchedArms);
    const partial = evaluate(prereg, { ...window, observations: window.observations.filter((observation) => observation.cell !== "judge-verdict/v1") });
    expect(missingKinds(partial)).toEqual(["cell-not-measured"]);

    const oneAssessor = evaluate(prereg, fullWindow(prereg, matchedArms, () => [], ["rubric-v1"]));
    expect(oneAssessor.decision.kind).toBe("incomplete-missing-measurement");
    expect(new Set(missingKinds(oneAssessor))).toEqual(new Set(["guardrail-unresolved"]));
  });

  it("releases nothing when no cell is measured on an emission route", () => {
    const base = perRoute();
    const prereg: Preregistration = {
      ...base,
      cells: base.cells.map((cell) => ({ ...cell, qualification: { kind: "extraction-only", reason: "route rejects the schema", evidence: "test" } })),
    };
    const evaluated = evaluatePilot({ preregistration: prereg, preflight: READY, observations: [], quality: { key: null, assessments: [] } });
    if (!evaluated.ok) throw new Error(evaluated.error.problems.join());
    expect(evaluated.value.decision).toMatchObject({ kind: "incomplete-missing-measurement", missing: [{ kind: "no-released-cell" }] });
  });

  it("makes an engine-authoritative release carrying an AS-004 pass unrepresentable", () => {
    const prereg = perRoute();
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    if (result.decision.kind !== "done-allowed") throw new Error(result.decision.kind);
    const released = result.decision.measuredCells[0];
    const passing = { guardrail: "provider-structural-retries", verdict: "pass", detail: "x" } as const;
    // @ts-expect-error — an unconstrained-engine-authoritative release carries AS-004 only as not-applicable.
    const forged: PassedCellEvidence = { ...released, releaseClass: "unconstrained-engine-authoritative", guardrails: { ...released.guardrails, "provider-structural-retries": passing } };
    const inconclusive = { guardrail: "latency-p95", verdict: "inconclusive", detail: "x" } as const;
    // @ts-expect-error — no released cell carries a non-passing guardrail.
    const unresolved: PassedCellEvidence = { ...released, guardrails: { ...released.guardrails, "latency-p95": inconclusive } };
    expect([forged.cell, unresolved.cell]).toEqual([released.cell, released.cell]);
  });

  it("types a measured cell's AS-004 verdict by its qualification, so a passing cell cannot mismatch its release class", () => {
    type As004Of<K extends MeasuredCell["qualification"]["kind"]> =
      Extract<MeasuredCell, { qualification: { kind: K } }>["guardrails"]["provider-structural-retries"]["verdict"];
    expectTypeOf<As004Of<"constrained-emission">>().toEqualTypeOf<"pass" | "violated">();
    expectTypeOf<As004Of<"unconstrained-emission">>().toEqualTypeOf<"not-applicable">();
    expectTypeOf<Extract<PassedCellEvidence, { releaseClass: "constrained" }>["guardrails"]["provider-structural-retries"]["verdict"]>().toEqualTypeOf<"pass">();
    expectTypeOf<Extract<PassedCellEvidence, { releaseClass: "unconstrained-engine-authoritative" }>["guardrails"]["provider-structural-retries"]["verdict"]>()
      .toEqualTypeOf<"not-applicable">();

    const prereg = perRoute(constrainedCells("judge-verdict/v1"));
    const { cells } = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(measured(cells, "judge-verdict/v1").guardrails["provider-structural-retries"].verdict).toBe("not-applicable");
    expect(measured(cells, "reviewer-payload/v2").guardrails["provider-structural-retries"].verdict).toBe("pass");
  });
});

describe("release policy soundness (properties)", () => {
  /** A window with an arbitrary emission slowdown and arbitrary emission timeouts on one cell,
   *  optionally with one provider-structural retry on another cell's emission arm. */
  const perturbed = (prereg: Preregistration, slowdown: number, emissionTimeouts: number, structuralRetryOn: CellKey | null = null) => {
    let timeouts = 0;
    let retried = false;
    return evaluate(prereg, fullWindow(prereg, (pair, arm) => {
      if (arm === "emission-enabled" && pair.cell === "judge-verdict/v1" && timeouts < emissionTimeouts) {
        timeouts += 1;
        return { ms: 900_000, attempts: [{ outcome: { kind: "timeout", afterMs: 900_000 } }] };
      }
      if (arm === "emission-enabled" && pair.cell === structuralRetryOn && !retried) {
        retried = true;
        return { ms: 10_000 + pair.repeat * 50, attempts: [{ ...ACCEPT_EMISSION, toolErrors: [{ class: "harness-schema-validation" }] }] };
      }
      const base = 10_000 + pair.repeat * 50;
      return { ms: arm === "emission-enabled" ? base * slowdown : base, attempts: [arm === "emission-enabled" ? ACCEPT_EMISSION : ACCEPT_EXTRACTION] };
    }));
  };
  const verdictsOf = (result: PilotEvaluation) =>
    result.cells.flatMap((cell) => (cell.kind === "measured" ? Object.values(cell.guardrails).map((guardrail) => guardrail.verdict) : []));
  const arbitraryWindow = [fc.double({ min: 0.5, max: 2, noNaN: true }), fc.nat({ max: 2 })] as const;

  it("capable-route-required: an unconstrained-only matrix never reaches done-allowed, whatever the window", () => {
    const prereg = testPreregistration();
    fc.assert(fc.property(...arbitraryWindow, (slowdown, emissionTimeouts) => {
      const result = perturbed(prereg, slowdown, emissionTimeouts);
      expect(result.decision.kind).not.toBe("done-allowed");
      if (result.decision.kind === "incomplete-missing-measurement") expect(result.decision.missing[0]).toEqual(NO_CAPABLE_ROUTE);
      if (result.decision.kind === "blocked-guardrail-violated") expect(result.decision.alsoMissing[0]).toEqual(NO_CAPABLE_ROUTE);
    }), { numRuns: 8 });
  });

  it("per-route: a complete unconstrained matrix is done-allowed exactly when every guardrail passes; any violation blocks", () => {
    const prereg = testPreregistration(PILOT_2);
    fc.assert(fc.property(...arbitraryWindow, (slowdown, emissionTimeouts) => {
      const result = perturbed(prereg, slowdown, emissionTimeouts);
      const verdicts = verdictsOf(result);
      const allPassing = verdicts.every((verdict) => verdict === "pass" || verdict === "not-applicable");
      expect(result.decision.kind === "done-allowed").toBe(allPassing);
      if (verdicts.includes("violated")) expect(result.decision.kind).toBe("blocked-guardrail-violated");
      if (result.decision.kind === "done-allowed") {
        expect(result.decision.measuredCells.every((cell) => cell.releaseClass === "unconstrained-engine-authoritative")).toBe(true);
      }
    }), { numRuns: 8 });
  });

  it("per-route, mixed matrix: AS-004 reads only its qualification's verdicts, and every passing cell is released in its class (no per-cell gap)", () => {
    const prereg = testPreregistration(PILOT_2, constrainedCells("judge-verdict/v1"));
    const RELEASE_CLASS = { "constrained-emission": "constrained", "unconstrained-emission": "unconstrained-engine-authoritative" } as const;
    const AS004_VERDICTS = { "constrained-emission": ["pass", "violated"], "unconstrained-emission": ["not-applicable"] } as const;
    fc.assert(fc.property(
      ...arbitraryWindow,
      fc.constantFrom<CellKey | null>(null, "reviewer-payload/v2", "judge-verdict/v1"),
      (slowdown, emissionTimeouts, structuralRetryOn) => {
        const result = perturbed(prereg, slowdown, emissionTimeouts, structuralRetryOn);
        const measuredCells = result.cells.flatMap((cell) => (cell.kind === "measured" ? [cell] : []));
        expect(measuredCells.map((cell) => cell.cell)).toEqual(prereg.cells.map((cell) => cell.cell));
        for (const cell of measuredCells) {
          expect(AS004_VERDICTS[cell.qualification.kind]).toContain(cell.guardrails["provider-structural-retries"].verdict);
        }
        expect(missingKinds(result)).not.toContain("no-released-cell");
        expect(missingKinds(result)).not.toContain("no-qualified-capable-route");
        const passing = measuredCells.filter((cell) => verdictsOf({ ...result, cells: [cell] }).every((verdict) => verdict === "pass" || verdict === "not-applicable"));
        expect(result.decision.kind === "done-allowed").toBe(passing.length === measuredCells.length);
        if (result.decision.kind === "done-allowed") {
          expect(result.decision.measuredCells.map((cell) => [cell.cell, cell.releaseClass]))
            .toEqual(passing.map((cell) => [cell.cell, RELEASE_CLASS[cell.qualification.kind]]));
        }
      },
    ), { numRuns: 12 });
  });
});
