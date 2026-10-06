import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REVIEWER_OUTPUT_CONTRACT, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../engine/src/core/reviewer-contract";
import { parseCalibrationCorpus } from "../../engine/src/core/model-calibration";
import {
  bootstrapInterval,
  buildPairSchedule,
  CELL_KEYS,
  classifyEmissionToolError,
  contentDigest,
  decidePreflight,
  evaluatePilot,
  nearestRankQuantile,
  parsePreflightFacts,
  parsePreregistration,
  parseQualityAssessment,
  parseSampleObservation,
  sampleRetries,
  type BlindingKey,
  type CellKey,
  type CellOutcome,
  type PilotArm,
  type PilotEvaluation,
  type PreflightDecision,
  type PreflightFacts,
  type Preregistration,
  type QualityAssessment,
  type SampleObservation,
  type ScheduledPair,
} from "./pilot-core";
import {
  cellSchemaBytes,
  parseCaseSource,
  pilotRequestId,
  renderPilotPrompt,
  renderTaskBody,
  rubricEscapes,
  type CaseInput,
} from "./pilot-workload";
import { classifyAttemptTranscript, mintCellBinding, type CellBinding } from "./pilot-dispatch";
import { fixtures as retainedFixtureSet, HERE, prereg as retainedPrereg, READY, REPO_ROOT } from "./pilot-test-fixtures";

const preregBytes = readFileSync(join(HERE, "preregistration.json"));
const fixtureBytes = readFileSync(join(HERE, "workload-fixtures.json"));

/** A test preregistration: the retained one, optionally with every cell (but
 *  `unconstrained`, which keeps the retained unconstrained qualification)
 *  qualified as a capable (constrained) route and a cheaper bootstrap. */
function testPreregistration(options: Readonly<{ constrained?: boolean; extractionOnly?: CellKey; unconstrained?: CellKey }> = {}): Preregistration {
  const raw = JSON.parse(preregBytes.toString("utf-8")) as { guardrails: { bootstrapResamples: number }; cells: Array<{ cell: string; qualification: unknown }> };
  raw.guardrails.bootstrapResamples = 200;
  for (const cell of raw.cells) {
    if (options.constrained && options.unconstrained !== cell.cell) {
      cell.qualification = { kind: "constrained-emission", enforcedConstraints: ["type", "required", "enum", "additionalProperties"], evidence: "test" };
    }
    if (options.extractionOnly === cell.cell) {
      cell.qualification = { kind: "extraction-only", reason: "route rejects the schema", evidence: "test" };
    }
  }
  const parsed = parsePreregistration(raw);
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

type AttemptSpec = Readonly<{
  outcome: Record<string, unknown>;
  emissionCalls?: number;
  toolErrors?: readonly Record<string, unknown>[];
}>;

const ACCEPT_EMISSION: AttemptSpec = { outcome: { kind: "accepted", source: "emission-tool", fallbackOverRefusal: false, payloadDigest: "a".repeat(64) }, emissionCalls: 1 };
const ACCEPT_EXTRACTION: AttemptSpec = { outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false, payloadDigest: "b".repeat(64) } };

function sample(pair: ScheduledPair, arm: PilotArm, ms: number, attempts: readonly AttemptSpec[]): SampleObservation {
  const parsed = parseSampleObservation({
    pairId: pair.pairId,
    cell: pair.cell,
    caseId: pair.caseId,
    arm,
    dispatchToIngestionMs: ms,
    attempts: attempts.map((spec, index) => ({
      attempt: index + 1,
      elapsedMs: ms / attempts.length,
      readinessMs: arm === "emission-enabled" ? 50 : null,
      modelRequests: 1 + (spec.toolErrors?.length ?? 0),
      emissionCalls: spec.emissionCalls ?? 0,
      toolErrors: spec.toolErrors ?? [],
      toolAcknowledged: spec.outcome["source"] === "emission-tool",
      followUpTurnsAfterAck: 0,
      outcome: spec.outcome,
    })),
    rawArgumentObservation: "unavailable",
  });
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return parsed.value;
}

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

// ---------------------------------------------------------------------------

describe("preregistration (retained before any window)", () => {
  it("parses the retained preregistration with the four required cells and >=100 pairs each", () => {
    const prereg = retainedPrereg;
    expect(prereg.cells.map((cell) => cell.cell).sort()).toEqual([...CELL_KEYS].sort());
    const schedule = buildPairSchedule(prereg);
    const perCell = Object.fromEntries(CELL_KEYS.map((cell) => [cell, schedule.filter((pair) => pair.cell === cell).length]));
    expect(perCell).toEqual({ "reviewer-payload/v2": 104, "reviewer-payload/v3": 104, "judge-verdict/v1": 100, "refutation-verdict/v1": 100 });
    expect(prereg.guardrails.p95RatioBound).toBe(1.25);
  });

  it("pins the exact workload fixture bytes by content address", () => {
    expect(retainedPrereg.workloadFixturesDigest).toBe(contentDigest(fixtureBytes));
  });

  it("pins the frozen registry schema digests and tool names of every cell", () => {
    for (const cell of retainedPrereg.cells) {
      expect(cell.schemaDigest).toBe(contentDigest(cellSchemaBytes(cell.cell)));
    }
  });

  it("resolves every case source to a corpus case or a fixture of the right kind", () => {
    const fixtures = retainedFixtureSet;
    const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.reviewer.corpus), "utf-8"));
    if (!corpus.ok) throw new Error(corpus.errors.join("\n"));
    for (const cell of retainedPrereg.cells) {
      for (const entry of cell.workload.cases) {
        const source = parseCaseSource(entry.source);
        if (!source.ok) throw new Error(source.error);
        if (source.value.kind === "corpus") {
          const corpusCase = corpus.value.cases.find((item) => item.id === source.value.id);
          expect(corpusCase, entry.source).toBeDefined();
          // Vulnerable snapshots are the held-out known-defect cases; their known
          // defects are exactly the corpus expectations.
          expect(entry.heldOutKnownDefectCase).toBe(corpusCase?.state === "vulnerable");
          if (corpusCase?.state === "vulnerable") {
            expect(entry.knownDefects.map((defect) => defect.defectId)).toEqual(corpusCase.expectedCriticals.map((expectation) => expectation.id));
          }
        } else {
          const fixture = fixtures.fixtures[source.value.id];
          expect(fixture?.kind, entry.source).toBe(cell.cell === "judge-verdict/v1" ? "judge-verdict" : "refutation-verdict");
        }
      }
    }
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
    const prereg = retainedPrereg;
    const first = buildPairSchedule(prereg);
    expect(buildPairSchedule(prereg)).toEqual(first);
    expect(new Set(first.map((pair) => pair.pairId)).size).toBe(first.length);
    for (const cell of CELL_KEYS) {
      const pairs = first.filter((pair) => pair.cell === cell);
      const emissionFirst = pairs.filter((pair) => pair.armOrder[0] === "emission-enabled").length;
      expect(Math.abs(emissionFirst * 2 - pairs.length)).toBeLessThanOrEqual(2);
    }
  });

  it("schedules nothing for an extraction-only-qualified cell (no fabricated samples)", () => {
    const schedule = buildPairSchedule(testPreregistration({ extractionOnly: "judge-verdict/v1" }));
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

describe("observations", () => {
  it("classifies errored emission tool results by their real producers", () => {
    expect(classifyEmissionToolError("Validation failed for tool \"loom_emit_judge_verdict\":\n  - score: must be <= 10")).toEqual({ class: "harness-schema-validation" });
    expect(classifyEmissionToolError("invalid-schema: emission arguments do not conform")).toEqual({ class: "engine-refusal", code: "invalid-schema" });
    expect(classifyEmissionToolError("Tool not found")).toEqual({ class: "unclassified", excerpt: "Tool not found" });
  });

  it("refuses attempt sequences the request-slot budget cannot produce", () => {
    const pair = buildPairSchedule(retainedPrereg)[0] as ScheduledPair;
    const raw = (attempts: readonly AttemptSpec[]) => ({
      pairId: pair.pairId, cell: pair.cell, caseId: pair.caseId, arm: "emission-enabled", dispatchToIngestionMs: 1,
      attempts: attempts.map((spec, index) => ({
        attempt: index + 1, elapsedMs: 1, readinessMs: null, modelRequests: 1, emissionCalls: 0, toolErrors: [],
        toolAcknowledged: false, followUpTurnsAfterAck: 0, outcome: spec.outcome,
      })),
      rawArgumentObservation: "unavailable",
    });
    const rejected: AttemptSpec = { outcome: { kind: "rejected", cause: { kind: "extraction-failure", detail: "none" } } };
    expect(parseSampleObservation(raw([ACCEPT_EMISSION, ACCEPT_EMISSION])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected, rejected, rejected])).ok).toBe(false);
    expect(parseSampleObservation(raw([rejected, ACCEPT_EMISSION])).ok).toBe(true);
    expect(parseSampleObservation(raw([rejected, rejected])).ok).toBe(true);
  });

  it("refuses observations whose arm, source and counters contradict each other", () => {
    const pair = buildPairSchedule(retainedPrereg)[0] as ScheduledPair;
    const attempt = (overrides: Record<string, unknown>) => ({
      attempt: 1, elapsedMs: 1, readinessMs: null, modelRequests: 1, emissionCalls: 0, toolErrors: [],
      toolAcknowledged: false, followUpTurnsAfterAck: 0, outcome: ACCEPT_EXTRACTION.outcome, ...overrides,
    });
    const parses = (arm: PilotArm, overrides: Record<string, unknown>): boolean => parseSampleObservation({
      pairId: pair.pairId, cell: pair.cell, caseId: pair.caseId, arm, dispatchToIngestionMs: 1,
      attempts: [attempt(overrides)], rawArgumentObservation: "unavailable",
    }).ok;
    const accepted = (source: string, fallbackOverRefusal: boolean) => ({ outcome: { kind: "accepted", source, fallbackOverRefusal, payloadDigest: "a".repeat(64) } });

    // The extraction-only arm is offered no emission tool and passes no readiness barrier.
    expect(parses("extraction-only", {})).toBe(true);
    expect(parses("extraction-only", { emissionCalls: 1 })).toBe(false);
    expect(parses("extraction-only", { readinessMs: 50 })).toBe(false);
    expect(parses("extraction-only", { toolErrors: [{ class: "unclassified", excerpt: "Tool not found" }] })).toBe(false);
    expect(parses("extraction-only", { toolAcknowledged: true })).toBe(false);
    expect(parses("extraction-only", accepted("emission-tool", false))).toBe(false);
    expect(parses("extraction-only", accepted("extraction", true))).toBe(false);
    expect(parses("extraction-only", { outcome: { kind: "startup-refused", reason: "barrier" } })).toBe(false);
    expect(parses("extraction-only", { outcome: { kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } } })).toBe(false);
    // Only extraction selected over a refused call carries the fallback flag.
    expect(parses("emission-enabled", { ...accepted("emission-tool", false), emissionCalls: 1, readinessMs: 50 })).toBe(true);
    expect(parses("emission-enabled", { ...accepted("emission-tool", true), emissionCalls: 1 })).toBe(false);
    expect(parses("emission-enabled", { ...accepted("extraction", true), emissionCalls: 1 })).toBe(true);
    expect(parses("emission-enabled", { outcome: { kind: "startup-refused", reason: "barrier" } })).toBe(true);
  });

  it("attributes retries to separate series: provider-enforced vs unenforced vs engine-only", () => {
    const pair = buildPairSchedule(retainedPrereg)[0] as ScheduledPair;
    const observed = sample(pair, "emission-enabled", 30_000, [
      { outcome: { kind: "rejected", cause: { kind: "observation-refused", detail: "incomplete" } }, emissionCalls: 1, toolErrors: [{ class: "harness-schema-validation" }] },
      { ...ACCEPT_EMISSION, toolErrors: [{ class: "engine-refusal", code: "invalid-payload" }] },
    ]);
    const constrained = { kind: "constrained-emission", enforcedConstraints: ["enum"], evidence: "x" } as const;
    const unconstrained = { kind: "unconstrained-emission", evidence: "x" } as const;
    expect(sampleRetries(observed, constrained).map((retry) => `${retry.kind}:${retry.cause}`)).toEqual([
      "semantic-retry:provider-structural", "in-child-reprompt:provider-structural", "in-child-reprompt:engine-only-refusal",
    ]);
    expect(sampleRetries(observed, unconstrained).map((retry) => retry.cause)).toEqual([
      "unenforced-schema-violation", "unenforced-schema-violation", "engine-only-refusal",
    ]);
  });
});

describe("preflight (content-addressed frozen runtime + live route)", () => {
  const prereg = retainedPrereg;
  const facts = (overrides: Partial<PreflightFacts> = {}): PreflightFacts => ({
    registry: Object.fromEntries(prereg.cells.map((cell) => [cell.cell, { toolName: cell.toolName, schemaDigest: cell.schemaDigest }])) as PreflightFacts["registry"],
    workloadFixturesDigest: prereg.workloadFixturesDigest,
    piVersion: prereg.route.piVersion,
    stagedRuntimeRevision: "sha256:staged",
    loadedRuntimeRevision: null,
    route: { kind: "reachable", servedModels: [prereg.route.model] },
    ...overrides,
  });

  it("is ready only when every identity matches and the served model is reachable", () => {
    const decision = decidePreflight(prereg, facts());
    expect(decision.kind).toBe("ready");
    expect(decision.runtime.loadedRuntime).toEqual({ kind: "unobserved" });
    expect(decidePreflight(prereg, facts({ loadedRuntimeRevision: "sha256:staged" })).runtime.loadedRuntime)
      .toEqual({ kind: "matches-staged", revision: "sha256:staged" });
  });

  it("blocks on every requalification trigger and on an unreachable route", () => {
    const blocksOf = (decision: PreflightDecision) => (decision.kind === "blocked" ? decision.blocks.map((block) => block.kind) : []);
    const registry = { ...facts().registry, "judge-verdict/v1": { toolName: "loom_emit_judge_verdict", schemaDigest: "f".repeat(64) } };
    expect(blocksOf(decidePreflight(prereg, facts({ registry })))).toEqual(["schema-digest-mismatch"]);
    expect(blocksOf(decidePreflight(prereg, facts({ piVersion: "0.84.0" })))).toEqual(["pi-version-mismatch"]);
    expect(blocksOf(decidePreflight(prereg, facts({ workloadFixturesDigest: "0".repeat(64) })))).toEqual(["workload-fixtures-changed"]);
    expect(blocksOf(decidePreflight(prereg, facts({ route: { kind: "unreachable", reason: "ECONNREFUSED" } })))).toEqual(["route-unreachable"]);
    expect(blocksOf(decidePreflight(prereg, facts({ route: { kind: "reachable", servedModels: ["other"] } })))).toEqual(["served-model-absent"]);
    expect(blocksOf(decidePreflight(prereg, facts({ loadedRuntimeRevision: "sha256:stale" })))).toEqual(["loaded-runtime-mismatch"]);
  });

  it("round-trips retained facts through the parser so re-decisions re-derive the verdict", () => {
    const retained = JSON.parse(JSON.stringify(facts({ route: { kind: "unreachable", reason: "down" } })));
    const parsed = parsePreflightFacts(retained);
    expect(parsed.ok && decidePreflight(prereg, parsed.value).kind).toBe("blocked");
    expect(parsePreflightFacts({ ...retained, route: { kind: "maybe" } }).ok).toBe(false);
  });

  it("parses retained digests as strictly as the preregistration (lowercase SHA-256 hex)", () => {
    const retained = JSON.parse(JSON.stringify(facts()));
    const judge = retained.registry["judge-verdict/v1"];
    for (const digest of [judge.schemaDigest.toUpperCase(), `sha256-${judge.schemaDigest}`, judge.schemaDigest.slice(1)]) {
      expect(parsePreflightFacts({ ...retained, registry: { ...retained.registry, "judge-verdict/v1": { ...judge, schemaDigest: digest } } }).ok).toBe(false);
    }
    expect(parsePreflightFacts({ ...retained, workloadFixturesDigest: "not-a-digest" }).ok).toBe(false);
    expect(parsePreflightFacts(retained).ok).toBe(true);
  });
});

describe("statistics", () => {
  it("ranks terminal failures (+inf) into quantiles instead of dropping them", () => {
    expect(nearestRankQuantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRankQuantile([...Array.from({ length: 94 }, () => 1), ...Array.from({ length: 6 }, () => Infinity)], 0.95)).toBe(Infinity);
    expect(Number.isNaN(nearestRankQuantile([], 0.5))).toBe(true);
  });

  it("produces a deterministic percentile bootstrap interval", () => {
    const values = Array.from({ length: 50 }, (_unused, index) => index);
    const mean = (sample: readonly number[]) => sample.reduce((sum, value) => sum + value, 0) / sample.length;
    const first = bootstrapInterval(values, mean, 400, 7, 0.95);
    expect(bootstrapInterval(values, mean, 400, 7, 0.95)).toEqual(first);
    expect(first.lower).toBeLessThan(24.5);
    expect(first.upper).toBeGreaterThan(24.5);
    expect(bootstrapInterval([5, 5, 5], mean, 200, 1, 0.95)).toMatchObject({ lower: 5, upper: 5 });
  });
});

describe("release decision", () => {
  it("allows done only for a complete, all-passing window on a qualified capable route", () => {
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true, unconstrained: "judge-verdict/v1" });
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
    const prereg = retainedPrereg;
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
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
    const window = fullWindow(prereg, matchedArms);
    const partial = { ...window, observations: window.observations.filter((observation) => !(observation.cell === "judge-verdict/v1" && observation.caseId === "judge-hard-readiness-barrier")) };
    const result = evaluate(prereg, partial);
    const judge = result.cells.find((cell) => cell.cell === "judge-verdict/v1");
    expect(judge).toMatchObject({ kind: "not-measured", scheduledPairs: 100, observedPairs: 75, partialObservations: 150 });
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
  });

  it("keeps an extraction-only-qualified cell as an explicit qualification outcome", () => {
    const prereg = testPreregistration({ constrained: true, extractionOnly: "reviewer-payload/v3" });
    const result = evaluate(prereg, fullWindow(prereg, matchedArms));
    expect(result.cells.find((cell) => cell.cell === "reviewer-payload/v3")?.kind).toBe("qualification-only");
    expect(result.decision.kind).toBe("done-allowed");
    if (result.decision.kind === "done-allowed") expect(result.decision.qualificationOnlyCells).toEqual(["reviewer-payload/v3"]);
  });

  it("refuses inconsistent evidence instead of repairing it", () => {
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
    const result = evaluate(prereg, fullWindow(prereg, matchedArms, () => [], ["rubric-v1"]));
    expect(measured(result.cells, "judge-verdict/v1").guardrails["escaped-defect-severity"].verdict).toBe("not-measured");
    expect(result.decision.kind).toBe("incomplete-missing-measurement");
  });

  it("blocks when the emission arm lets more severe defects escape than the PR #52-only baseline", () => {
    const prereg = testPreregistration({ constrained: true });
    const result = evaluate(prereg, fullWindow(prereg, matchedArms, (pair, arm) =>
      arm === "emission-enabled" ? knownDefectOf(pair, prereg).map((defect) => ({ ...defect })) : []));
    const judge = measured(result.cells, "judge-verdict/v1");
    expect(judge.guardrails["escaped-defect-severity"].verdict).toBe("violated");
    expect(judge.measurement.quality?.observedEscapes.length).toBeGreaterThan(0);
    expect(result.decision.kind).toBe("blocked-guardrail-violated");
  });

  it("preserves assessor disagreements and adjudicates conservatively for both arms", () => {
    const prereg = testPreregistration({ constrained: true });
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
    const prereg = testPreregistration({ constrained: true });
    const result = evaluate(prereg, fullWindow(prereg, (pair, arm) =>
      arm === "emission-enabled" && pair.cell === "judge-verdict/v1"
        ? { ms: 5_000, attempts: [{ outcome: { kind: "startup-refused", reason: "readiness refused" } }] }
        : matchedArms(pair, arm)));
    const quality = measured(result.cells, "judge-verdict/v1").measurement.quality;
    expect(quality?.observedEscapes.filter((escape) => escape.observedBy.includes("terminal-failure")).length).toBe(100);
  });

  it("parses assessor ids as path-safe tokens (they name the retained file)", () => {
    const assessment = (assessorId: string) => ({ schemaVersion: 1, assessorId, method: "m", blinded: true, entries: [] });
    expect(parseQualityAssessment(assessment("human-blind-1")).ok).toBe(true);
    expect(parseQualityAssessment(assessment("rubric-v1.2_b")).ok).toBe(true);
    for (const unsafe of ["../escape", "a/b", ".hidden", "", "a b", "x".repeat(65)]) {
      expect(parseQualityAssessment(assessment(unsafe)).ok, unsafe).toBe(false);
    }
    expect(parseQualityAssessment({ ...assessment("ok"), blinded: false }).ok).toBe(false);
  });

  it("refuses an assessment naming a defect the case does not have", () => {
    const prereg = testPreregistration({ constrained: true });
    const window = fullWindow(prereg, matchedArms, (pair) => (pair.cell === "judge-verdict/v1" && pair.repeat === 1 ? [{ defectId: "invented", severity: "minor" }] : []));
    const evaluated = evaluatePilot({ preregistration: prereg, preflight: READY, observations: window.observations, quality: { key: window.key, assessments: window.assessments } });
    expect(evaluated.ok).toBe(false);
  });
});

describe("decision soundness (properties)", () => {
  it("done-allowed implies every measured guardrail passed; any violation blocks done", () => {
    const prereg = testPreregistration({ constrained: true });
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

  it("adding an emission terminal failure never improves the p95 ratio (failures are never hidden)", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 20, maxLength: 60 }),
      fc.nat({ max: 19 }),
      (latencies, failAt) => {
        const ratio = (emission: readonly number[]) => nearestRankQuantile(emission, 0.95) / nearestRankQuantile(latencies, 0.95);
        const failed = latencies.map((value, index) => (index === failAt ? Infinity : value));
        expect(ratio(failed)).toBeGreaterThanOrEqual(ratio(latencies));
      },
    ), { numRuns: 100 });
  });
});

describe("matched workload prompts", () => {
  const fixtures = retainedFixtureSet;
  const judgeInput: CaseInput = { kind: "judge", fixture: fixtures.fixtures["judge-hard-readiness-barrier"] as Extract<CaseInput, { kind: "judge" }>["fixture"] };
  const corpusInput = (): CaseInput => {
    const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.reviewer.corpus), "utf-8"));
    if (!corpus.ok) throw new Error(corpus.errors.join());
    return { kind: "corpus", corpusCase: corpus.value.cases[1] as never, changedPaths: ["engine/src/handlers/helpers/validate-task-graph.ts"] };
  };
  const binding = (cell: CellKey, body: string): CellBinding => {
    const minted = mintCellBinding(cell, pilotRequestId("w", `${cell}#c#r1`, "emission-enabled", 1), body);
    if (!minted.ok) throw new Error(minted.error);
    return minted.value;
  };

  it("gives both arms byte-identical bodies and differs only in the wire section", () => {
    for (const [cell, input] of [["reviewer-payload/v2", corpusInput()], ["reviewer-payload/v3", corpusInput()], ["judge-verdict/v1", judgeInput]] as const) {
      const body = renderTaskBody(cell, input, fixtures);
      if (!body.ok) throw new Error(body.error);
      const minted = binding(cell, body.value);
      const emission = renderPilotPrompt(body.value, cell, { arm: "emission-enabled", binding: minted.binding });
      const extraction = renderPilotPrompt(body.value, cell, { arm: "extraction-only" });
      expect(emission.startsWith(body.value)).toBe(true);
      expect(extraction.startsWith(body.value)).toBe(true);
      expect(emission).toContain(minted.binding.toolName);
      expect(extraction).not.toContain(minted.binding.toolName);
      expect(body.value).toContain(cellSchemaBytes(cell));
    }
    const v2 = renderTaskBody("reviewer-payload/v2", corpusInput(), fixtures);
    expect(v2.ok && renderPilotPrompt(v2.value, "reviewer-payload/v2", { arm: "extraction-only" })).toContain(REVIEWER_OUTPUT_CONTRACT);
    const v3 = renderTaskBody("reviewer-payload/v3", corpusInput(), fixtures);
    expect(v3.ok && v3.value).toContain(fixtures.reviewer.v3Context.lineageDigest);
  });

  it("refuses a case input that cannot feed the cell", () => {
    expect(renderTaskBody("refutation-verdict/v1", judgeInput, fixtures).ok).toBe(false);
  });

  it("mints canonical per-attempt request identities and a prompt-addressed context digest", () => {
    const id = pilotRequestId("window", "judge-verdict/v1#c#r1", "extraction-only", 2);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/);
    expect(id).not.toBe(pilotRequestId("window", "judge-verdict/v1#c#r1", "extraction-only", 1));
    expect(binding("judge-verdict/v1", "body").contextDigest).toBe(contentDigest("body"));
  });
});

describe("rubric assessor", () => {
  const fixtures = retainedFixtureSet;
  const prereg = retainedPrereg;
  const caseOf = (cell: CellKey, caseId: string) =>
    prereg.cells.find((entry) => entry.cell === cell)?.workload.cases.find((entry) => entry.caseId === caseId) as Preregistration["cells"][number]["workload"]["cases"][number];
  /** The escapes of a payload whose every escaped defect the case declares. */
  const escapesOf = (...args: Parameters<typeof rubricEscapes>) => {
    const escapes = rubricEscapes(...args);
    if (!escapes.ok) throw new Error(escapes.error);
    return escapes.value;
  };

  it("flags a planted fatal flaw that is unnamed or not ranked below a sound candidate", () => {
    const fixture = fixtures.fixtures["judge-hard-readiness-barrier"] as Extract<CaseInput, { kind: "judge" }>["fixture"];
    const input: CaseInput = { kind: "judge", fixture };
    const workloadCase = caseOf("judge-verdict/v1", "judge-hard-readiness-barrier");
    const verdict = (flawScore: number, flaw: string | null) => ({
      criterion: fixture.criterion,
      rankings: fixture.candidates.map((entry) => entry.candidate === fixture.plantedFlaw.candidate
        ? { candidate: entry.candidate, score: flawScore, fatal_flaw: flaw, strongest_idea: "x" }
        : { candidate: entry.candidate, score: 7, fatal_flaw: null, strongest_idea: "y" }),
    });
    expect(escapesOf(workloadCase, input, verdict(2, "throws are caught"))).toEqual([]);
    expect(escapesOf(workloadCase, input, verdict(2, null))).toEqual([{ defectId: "caught-throw-is-not-a-barrier", severity: "critical" }]);
    expect(escapesOf(workloadCase, input, verdict(9, "throws are caught"))).toHaveLength(1);
  });

  it("refuses a named planted flaw whose ranking cannot be compared — never 'not escaped'", () => {
    const fixture = retainedFixtureSet.fixtures["judge-hard-readiness-barrier"] as Extract<CaseInput, { kind: "judge" }>["fixture"];
    const input: CaseInput = { kind: "judge", fixture };
    const workloadCase = caseOf("judge-verdict/v1", "judge-hard-readiness-barrier");
    const sound = fixture.candidates.find((entry) => entry.candidate !== fixture.plantedFlaw.candidate)?.candidate;
    const payload = {
      criterion: fixture.criterion,
      rankings: fixture.candidates.map((entry) => entry.candidate === fixture.plantedFlaw.candidate
        ? { candidate: entry.candidate, score: 2, fatal_flaw: "throws are caught", strongest_idea: "x" }
        : { candidate: entry.candidate, score: entry.candidate === sound ? "high" : 7, fatal_flaw: null, strongest_idea: "y" }),
    };
    expect(rubricEscapes(workloadCase, input, payload)).toEqual({
      ok: false,
      error: `case ${workloadCase.caseId}: the judge ranking of candidate(s) ${JSON.stringify(sound)} carries no numeric score, so the planted flaw cannot be ranked`,
    });
  });

  it("flags a refuted real defect but not an upheld one or a refuted false positive", () => {
    const real = fixtures.fixtures["refutation-easy-off-by-one"] as Extract<CaseInput, { kind: "refutation" }>["fixture"];
    const workloadCase = caseOf("refutation-verdict/v1", "refutation-easy-off-by-one");
    const payload = (verdict: string) => ({ criterion: real.lens, verdicts: [{ finding_id: real.finding.findingId, verdict, reasoning: "r" }] });
    expect(escapesOf(workloadCase, { kind: "refutation", fixture: real }, payload("refuted"))).toEqual([{ defectId: "loop-skips-last-line", severity: "major" }]);
    expect(escapesOf(workloadCase, { kind: "refutation", fixture: real }, payload("upheld"))).toEqual([]);
    expect(escapesOf(workloadCase, { kind: "refutation", fixture: real }, payload("uncertain"))).toEqual([]);
    const fp = fixtures.fixtures["refutation-easy-guarded-null"] as Extract<CaseInput, { kind: "refutation" }>["fixture"];
    expect(escapesOf(caseOf("refutation-verdict/v1", "refutation-easy-guarded-null"), { kind: "refutation", fixture: fp }, payload("refuted"))).toEqual([]);
  });

  it("reuses the corpus match rules for reviewer payloads", () => {
    const corpus = parseCalibrationCorpus(readFileSync(join(REPO_ROOT, fixtures.reviewer.corpus), "utf-8"));
    if (!corpus.ok) throw new Error(corpus.errors.join());
    const vulnerable = corpus.value.cases.find((entry) => entry.id === "round12-finding-repair-idempotency-vulnerable") as never;
    const input: CaseInput = { kind: "corpus", corpusCase: vulnerable, changedPaths: [] };
    const workloadCase = caseOf("reviewer-payload/v2", "round12-vulnerable");
    const finding = (claim: string) => ({ schemaVersion: 2, kind: "standalone-review", findings: [{ severity: "critical", file: "engine/src/handlers/helpers/validate-task-graph.ts", line: 10, claim, basis: "observed" }] });
    expect(escapesOf(workloadCase, input, finding("validate task graph --fix deletes critical finding claims on a second run (not idempotent)"))).toEqual([]);
    expect(escapesOf(workloadCase, input, finding("unrelated logging nit"))).toEqual([{ defectId: "repair-idempotency", severity: "critical" }]);
  });

  it("fails closed on an escaped defect id the case does not declare — never an empty escape list", () => {
    const real = fixtures.fixtures["refutation-easy-off-by-one"] as Extract<CaseInput, { kind: "refutation" }>["fixture"];
    const declared = caseOf("refutation-verdict/v1", "refutation-easy-off-by-one");
    const drifted = { ...declared, knownDefects: [{ defectId: "renamed-defect", severity: "major" as const }] };
    const refuted = { criterion: real.lens, verdicts: [{ finding_id: real.finding.findingId, verdict: "refuted", reasoning: "r" }] };
    expect(rubricEscapes(drifted, { kind: "refutation", fixture: real }, refuted)).toEqual({
      ok: false,
      error: `case ${declared.caseId} declares no known defect "loop-skips-last-line"`,
    });
  });

  it("an undeclared escape is an error exactly when the declared case lets a defect escape (property)", () => {
    const judge = fixtures.fixtures["judge-hard-readiness-barrier"] as Extract<CaseInput, { kind: "judge" }>["fixture"];
    const real = fixtures.fixtures["refutation-easy-off-by-one"] as Extract<CaseInput, { kind: "refutation" }>["fixture"];
    const subjects = [
      { workloadCase: caseOf("judge-verdict/v1", "judge-hard-readiness-barrier"), input: { kind: "judge", fixture: judge } },
      { workloadCase: caseOf("refutation-verdict/v1", "refutation-easy-off-by-one"), input: { kind: "refutation", fixture: real } },
    ] as const;
    const payload = fc.oneof(
      fc.anything(),
      fc.record({
        rankings: fc.array(fc.record({
          candidate: fc.constantFrom(...judge.candidates.map((entry) => entry.candidate)),
          score: fc.integer({ min: 0, max: 10 }),
          fatal_flaw: fc.option(fc.string()),
        })),
      }),
      fc.record({ verdicts: fc.array(fc.record({ finding_id: fc.constantFrom(real.finding.findingId, "other"), verdict: fc.constantFrom("refuted", "upheld", "uncertain") })) }),
    );
    fc.assert(fc.property(fc.constantFrom(...subjects), payload, ({ workloadCase, input }, raw) => {
      const declared = escapesOf(workloadCase, input, raw);
      const undeclared = rubricEscapes({ ...workloadCase, knownDefects: [] }, input, raw);
      expect(undeclared.ok).toBe(declared.length === 0);
      if (undeclared.ok) expect(undeclared.value).toEqual([]);
    }));
  });
});

describe("transcript classification through the engine's own selection", () => {
  const judgePayload = { criterion: "correctness", rankings: [{ candidate: "a.md", score: 7, fatal_flaw: null, strongest_idea: "reuse the budget" }] };
  const cellBinding = (cell: CellKey): CellBinding => {
    const minted = mintCellBinding(cell, pilotRequestId("w", `${cell}#c#r1`, "emission-enabled", 1), "prompt");
    if (!minted.ok) throw new Error(minted.error);
    return minted.value;
  };
  const toolCall = (id: string, name: string, args: unknown) => ({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] });
  const toolResult = (id: string, name: string, isError: boolean, text: string) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
  const finalText = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
  const classify = (cell: CellKey, messages: readonly unknown[], launch: Parameters<typeof classifyAttemptTranscript>[0]["launch"] = { kind: "settled" }) =>
    classifyAttemptTranscript({ arm: "emission-enabled", cell, cellBinding: cellBinding(cell), messages, attempt: 1, elapsedMs: 1234, readinessMs: 80, launch });

  it("accepts one successful emission call (tool-only completion, no final text)", () => {
    const result = classify("judge-verdict/v1", [toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "accepted")]);
    expect(result.observation).toMatchObject({ emissionCalls: 1, toolAcknowledged: true, followUpTurnsAfterAck: 0, modelRequests: 1, outcome: { kind: "accepted", source: "emission-tool" } });
    expect(result.acceptedPayload).toEqual(judgePayload);
  });

  it("accepts a reviewer v2 emission and counts a follow-up turn after the acknowledgment", () => {
    const result = classify("reviewer-payload/v2", [
      toolCall("c1", "loom_emit_reviewer_payload", REVIEWER_PAYLOAD_EXAMPLE_V2),
      toolResult("c1", "loom_emit_reviewer_payload", false, "accepted"),
      finalText("done"),
    ]);
    expect(result.observation).toMatchObject({ followUpTurnsAfterAck: 1, outcome: { kind: "accepted", source: "emission-tool" } });
  });

  it("falls back to final-message extraction when the model never emits", () => {
    const result = classify("judge-verdict/v1", [finalText(JSON.stringify(judgePayload))]);
    expect(result.observation).toMatchObject({ emissionCalls: 0, outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false } });
  });

  it("records Pi's validation re-prompt and refuses the incomplete observation (no silent recovery)", () => {
    const result = classify("judge-verdict/v1", [
      toolCall("c1", "loom_emit_judge_verdict", { ...judgePayload, rankings: [{ ...judgePayload.rankings[0], score: 12 }] }),
      toolResult("c1", "loom_emit_judge_verdict", true, "Validation failed for tool \"loom_emit_judge_verdict\":\n  - score: must be <= 10"),
      toolCall("c2", "loom_emit_judge_verdict", judgePayload),
      toolResult("c2", "loom_emit_judge_verdict", false, "accepted"),
    ]);
    expect(result.observation.toolErrors).toEqual([{ class: "harness-schema-validation" }]);
    expect(result.observation.emissionCalls).toBe(2);
    expect(result.observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "observation-refused" } });
  });

  it("rejects two distinct successful calls as duplicate-call ambiguity, even with valid final text", () => {
    const result = classify("judge-verdict/v1", [
      toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "ok"),
      toolCall("c2", "loom_emit_judge_verdict", judgePayload), toolResult("c2", "loom_emit_judge_verdict", false, "ok"),
      finalText(JSON.stringify(judgePayload)),
    ]);
    expect(result.observation.outcome).toEqual({ kind: "rejected", cause: { kind: "duplicate-call", calls: 2 } });
  });

  it("rejects an unusable final message and a frozen-parser refusal separately", () => {
    // PR #52's fail-closed admission: no final text, or two candidate text blocks, is an extraction failure.
    expect(classify("judge-verdict/v1", []).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    expect(classify("judge-verdict/v1", [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }]).observation.outcome)
      .toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    // Admitted text that the frozen parser refuses is an ingestion refusal, not an extraction failure.
    expect(classify("judge-verdict/v1", [finalText("no json here")]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
    expect(classify("judge-verdict/v1", [finalText(JSON.stringify({ criterion: "c", rankings: [{ candidate: "a", score: 12, fatal_flaw: null, strongest_idea: "x" }] }))]).observation.outcome)
      .toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
  });

  it("classifies the extraction-only arm by its final message alone, with no emission counters", () => {
    const extraction = (messages: readonly unknown[]) => classifyAttemptTranscript({
      arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"), messages, attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
    });
    // A call to the tool the arm was never offered is not an emission call: the baseline extracts.
    const result = extraction([
      toolCall("c1", "loom_emit_judge_verdict", judgePayload),
      toolResult("c1", "loom_emit_judge_verdict", true, "Tool loom_emit_judge_verdict not found"),
      finalText(JSON.stringify(judgePayload)),
    ]);
    expect(result.observation).toEqual({
      attempt: 1, elapsedMs: 5, readinessMs: null, modelRequests: 2, emissionCalls: 0, toolErrors: [], toolAcknowledged: false, followUpTurnsAfterAck: 0,
      outcome: { kind: "accepted", source: "extraction", fallbackOverRefusal: false, payloadDigest: contentDigest(JSON.stringify(judgePayload)) },
    });
    expect(extraction([]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "extraction-failure" } });
    expect(extraction([finalText("no json here")]).observation.outcome).toMatchObject({ kind: "rejected", cause: { kind: "payload-refused" } });
  });

  it("canonicalizes an accepted payload identically for both arms, whatever the model's key order", () => {
    const reordered = `{"rankings":[{"strongest_idea":"reuse the budget","fatal_flaw":null,"score":7,"candidate":"a.md"}],"criterion":"correctness"}`;
    const emission = classify("judge-verdict/v1", [toolCall("c1", "loom_emit_judge_verdict", judgePayload), toolResult("c1", "loom_emit_judge_verdict", false, "accepted")]);
    const extraction = classifyAttemptTranscript({
      arm: "extraction-only", cell: "judge-verdict/v1", cellBinding: cellBinding("judge-verdict/v1"), messages: [finalText(reordered)],
      attempt: 1, elapsedMs: 5, launch: { kind: "settled" },
    });
    expect(JSON.stringify(extraction.acceptedPayload)).toBe(JSON.stringify(emission.acceptedPayload));
    expect(extraction.observation.outcome).toMatchObject({ payloadDigest: (emission.observation.outcome as { payloadDigest: string }).payloadDigest });
  });

  it("passes launch failures through as their own terminal classes", () => {
    expect(classify("judge-verdict/v1", [], { kind: "startup-refused", reason: "readiness refused" }).observation.outcome).toEqual({ kind: "startup-refused", reason: "readiness refused" });
    expect(classify("judge-verdict/v1", [], { kind: "timeout", afterMs: 900_000 }).observation.outcome).toEqual({ kind: "timeout", afterMs: 900_000 });
    expect(classify("judge-verdict/v1", [], { kind: "infrastructure-failure", reason: "spawn" }).observation.outcome).toEqual({ kind: "infrastructure-failure", reason: "spawn" });
  });
});
