import { describe, expect, it } from "vitest";
import {
  matchCalibrationFindings,
  parseCalibrationCorpus,
  parseCalibrationPredictions,
  scoreCalibration,
  serializeCalibrationScore,
  type CalibrationExpectation,
  type CalibrationPrediction,
} from "../../src/core/model-calibration";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

function expectation(
  id: string,
  claim: string,
  match: CalibrationExpectation["match"] = null,
): CalibrationExpectation {
  return { id, claim, file: null, line: null, aliases: [], match };
}

function prediction(claim: string, file: string | null = null): CalibrationPrediction {
  return { claim, file, line: null };
}

function corpusJson(): unknown {
  return {
    schema_version: 1,
    cases: [
      {
        id: "vulnerable-race",
        state: "vulnerable",
        revision: REVISION_A,
        context: { task: "T1" },
        expected_criticals: [
          {
            id: "lost-update",
            claim: "A concurrent write loses the critical finding",
            file: "engine/src/core/findings.ts",
            match: { all_of: ["concurrent", "loses"], any_of: ["finding", "claim"] },
          },
        ],
      },
      {
        id: "fixed-race",
        state: "fixed",
        revision: REVISION_B,
        expected_criticals: [
          {
            id: "lost-update",
            claim: "A concurrent write loses the critical finding",
            file: "engine/src/core/findings.ts",
            match: { all_of: ["concurrent", "loses"], any_of: ["finding", "claim"] },
          },
        ],
      },
    ],
  };
}

function predictionsJson(fixedFindings: readonly unknown[] = []): unknown {
  return {
    schema_version: 1,
    profile_id: "implementation",
    cases: [
      {
        case_id: "vulnerable-race",
        status: "executed",
        findings: [
          {
            severity: "critical",
            claim: "A concurrent update loses one finding claim",
            file: "engine/src/core/findings.ts",
          },
          {
            severity: "critical",
            claim: "A previously unknown parser problem",
            file: "engine/src/core/review-output.ts",
          },
        ],
      },
      { case_id: "fixed-race", status: "executed", findings: fixedFindings },
    ],
  };
}

describe("calibration parsers", () => {
  it("parses and canonically sorts corpus cases and expectations", () => {
    const raw = corpusJson() as { cases: unknown[] };
    const parsed = parseCalibrationCorpus({ ...raw, schema_version: 1, cases: [...raw.cases].reverse() });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.cases.map((entry) => entry.id)).toEqual(["fixed-race", "vulnerable-race"]);
      expect(parsed.value.cases[0]!.expectedCriticals[0]!.match).toEqual({
        allOf: ["concurrent", "loses"],
        anyOf: ["finding", "claim"],
      });
    }
  });

  it("parses predictions, including an explicit not-executed state", () => {
    const raw = predictionsJson() as { cases: unknown[] };
    const parsed = parseCalibrationPredictions({
      ...raw,
      cases: [raw.cases[0], { case_id: "fixed-race", status: "not-executed", reason: "runner unavailable" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.cases[0]).toMatchObject({ caseId: "fixed-race", status: "not-executed" });
  });

  it("fails loudly on malformed corpus and model output", () => {
    const corpus = corpusJson() as Record<string, unknown>;
    expect(parseCalibrationCorpus({ ...corpus, schema_version: 2 }).ok).toBe(false);
    expect(parseCalibrationCorpus({ schema_version: 1, cases: [] }).ok).toBe(false);

    const predictions = predictionsJson() as Record<string, unknown> & {
      cases: Array<{ findings: Array<Record<string, unknown>> }>;
    };
    const malformed = structuredClone(predictions);
    malformed.cases[0]!.findings[0]!.severity = "advisory";
    const parsed = parseCalibrationPredictions(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("severity must equal critical");
  });

  it("rejects duplicate case identities at both boundaries", () => {
    const corpus = corpusJson() as Record<string, unknown> & { cases: unknown[] };
    expect(parseCalibrationCorpus({ ...corpus, cases: [corpus.cases[0], corpus.cases[0]] }).ok).toBe(false);
    const predictions = predictionsJson() as Record<string, unknown> & { cases: unknown[] };
    expect(parseCalibrationPredictions({ ...predictions, cases: [predictions.cases[0], predictions.cases[0]] }).ok).toBe(false);
  });
});

describe("one-to-one finding matching", () => {
  it("never lets one prediction satisfy two expectations", () => {
    const expected = [
      expectation("E1", "first", { allOf: ["shared trigger"], anyOf: [] }),
      expectation("E2", "second", { allOf: ["shared trigger"], anyOf: [] }),
    ];
    const result = matchCalibrationFindings(expected, [prediction("The shared trigger is exploitable")]);
    expect(result.matches).toHaveLength(1);
    expect(result.missedExpectations).toHaveLength(1);
    expect(result.novelPredictions).toHaveLength(0);
  });

  it("finds a maximum-cardinality assignment instead of taking the first greedy edge", () => {
    const expected = [
      expectation("flexible", "flexible", { allOf: [], anyOf: ["alpha", "beta"] }),
      expectation("only-alpha", "only alpha", { allOf: ["alpha"], anyOf: [] }),
    ];
    const result = matchCalibrationFindings(expected, [prediction("alpha"), prediction("beta")]);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((entry) => [entry.expectation.id, entry.prediction.claim])).toEqual([
      ["flexible", "beta"],
      ["only-alpha", "alpha"],
    ]);
  });

  it("is invariant to input permutations and reports unmatched predictions as novel", () => {
    const expected = [
      expectation("B", "beta"),
      expectation("A", "alpha"),
    ];
    const predictions = [prediction("novel"), prediction("beta"), prediction("alpha")];
    const first = matchCalibrationFindings(expected, predictions);
    const second = matchCalibrationFindings([...expected].reverse(), [...predictions].reverse());
    const summarize = (result: typeof first) => ({
      matches: result.matches.map((entry) => [entry.expectation.id, entry.prediction.claim]),
      novel: result.novelPredictions.map((entry) => entry.claim),
    });
    expect(summarize(first)).toEqual(summarize(second));
    expect(first.novelPredictions.map((entry) => entry.claim)).toEqual(["novel"]);
  });
});

describe("profile scoring", () => {
  it("scores vulnerable detection and fixed avoidance separately", () => {
    const corpus = parseCalibrationCorpus(corpusJson());
    const predictions = parseCalibrationPredictions(predictionsJson());
    expect(corpus.ok).toBe(true);
    expect(predictions.ok).toBe(true);
    if (!corpus.ok || !predictions.ok) return;
    const scored = scoreCalibration(corpus.value, predictions.value);
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    expect(scored.value.execution).toBe("complete");
    expect(scored.value.vulnerable).toMatchObject({ expectedCount: 1, detectedCount: 1, recall: 1 });
    expect(scored.value.fixed).toMatchObject({
      knownFindingCount: 1,
      knownFalsePositiveCount: 0,
      avoidedKnownFindingCount: 1,
      avoidanceRate: 1,
    });
    expect(scored.value.novelPredictionCount).toBe(1);
  });

  it("classifies only known fixed-case matches as false positives, never novel findings", () => {
    const corpus = parseCalibrationCorpus(corpusJson());
    const predictions = parseCalibrationPredictions(predictionsJson([
      {
        severity: "critical",
        claim: "A concurrent update loses one finding claim",
        file: "engine/src/core/findings.ts",
      },
      {
        severity: "critical",
        claim: "A genuinely novel concern",
        file: "engine/src/core/new.ts",
      },
    ]));
    if (!corpus.ok || !predictions.ok) throw new Error("fixture did not parse");
    const scored = scoreCalibration(corpus.value, predictions.value);
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    expect(scored.value.fixed.knownFalsePositiveCount).toBe(1);
    expect(scored.value.novelPredictionCount).toBe(2); // one vulnerable + one fixed novel
    const fixedCase = scored.value.cases.find((entry) => entry.caseId === "fixed-race");
    expect(fixedCase).toMatchObject({ state: "fixed", execution: "executed" });
    if (fixedCase?.execution === "executed" && fixedCase.state === "fixed") {
      expect(fixedCase.novelPredictions.map((entry) => entry.claim)).toEqual(["A genuinely novel concern"]);
      expect(fixedCase.knownFalsePositiveCount).toBe(1);
    }
  });

  it("marks any unexecuted live case incomplete rather than passing it", () => {
    const corpus = parseCalibrationCorpus(corpusJson());
    const raw = predictionsJson() as { schema_version: number; profile_id: string; cases: unknown[] };
    const predictions = parseCalibrationPredictions({
      ...raw,
      cases: [raw.cases[0], { case_id: "fixed-race", status: "not-executed", reason: "no credentials" }],
    });
    if (!corpus.ok || !predictions.ok) throw new Error("fixture did not parse");
    const scored = scoreCalibration(corpus.value, predictions.value);
    expect(scored.ok).toBe(true);
    if (scored.ok) {
      expect(scored.value.execution).toBe("incomplete");
      expect(scored.value.fixed.executedCaseCount).toBe(0);
      expect(scored.value.cases).toContainEqual({
        caseId: "fixed-race",
        state: "fixed",
        execution: "not-executed",
        reason: "no credentials",
      });
    }
  });

  it("rejects missing or foreign prediction cases and serializes deterministically", () => {
    const corpus = parseCalibrationCorpus(corpusJson());
    const predictions = parseCalibrationPredictions(predictionsJson());
    if (!corpus.ok || !predictions.ok) throw new Error("fixture did not parse");
    expect(scoreCalibration(corpus.value, { ...predictions.value, cases: predictions.value.cases.slice(1) }).ok).toBe(false);
    expect(scoreCalibration(corpus.value, {
      ...predictions.value,
      cases: [...predictions.value.cases, { caseId: "foreign", status: "executed", predictions: [] }],
    }).ok).toBe(false);
    const score = scoreCalibration(corpus.value, predictions.value);
    if (!score.ok) throw new Error("fixture did not score");
    expect(serializeCalibrationScore(score.value)).toBe(serializeCalibrationScore(score.value));
    expect(JSON.parse(serializeCalibrationScore(score.value)).profileId).toBe("implementation");
  });
});
