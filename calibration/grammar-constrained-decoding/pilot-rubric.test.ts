import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../engine/src/core/reviewer-contract";
import type { Preregistration, WorkloadCase } from "./pilot-preregistration";
import { parseQualityAssessment } from "./pilot-quality";
import { rubricAssessment, rubricEscapes } from "./pilot-rubric";
import { accepted, corpusCases, fakeRoute, fixtures, inputOf, inputs, inputsWithout, PILOT_1, runWindow, WINDOW_ID } from "./pilot-test-fixtures";
import type { CellKey } from "./pilot-vocabulary";
import { blind } from "./pilot-window";
import type { CaseInput, JudgeFixture, RefutationFixture } from "./pilot-workload";

const caseOf = (cell: CellKey, caseId: string): WorkloadCase => {
  const found = PILOT_1.cells.find((entry) => entry.cell === cell)?.workload.cases.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new Error(`${cell} ${caseId} is not preregistered`);
  return found;
};
/** The escapes of a payload whose every escaped defect the case declares. */
const escapesOf = (...args: Parameters<typeof rubricEscapes>) => {
  const escapes = rubricEscapes(...args);
  if (!escapes.ok) throw new Error(escapes.error);
  return escapes.value;
};
const judgeFixture = (id: string): JudgeFixture => {
  const fixture = fixtures.fixtures[id];
  if (fixture?.kind !== "judge-verdict") throw new Error(`${id} is not a judge fixture`);
  return fixture;
};
const refutationFixture = (id: string): RefutationFixture => {
  const fixture = fixtures.fixtures[id];
  if (fixture?.kind !== "refutation-verdict") throw new Error(`${id} is not a refutation fixture`);
  return fixture;
};
/** The real-defect refutation case's input, bound once: payload in, escapes out. */
const realInput = {
  cell: "refutation-verdict/v1",
  caseId: "refutation-easy-off-by-one",
  fixture: refutationFixture("refutation-easy-off-by-one"),
} as const satisfies CaseInput;
const vulnerable = corpusCases.find((entry) => entry.id === "round12-finding-repair-idempotency-vulnerable");
if (vulnerable === undefined) throw new Error("the corpus carries no round12 vulnerable case");

/** A v2-valid critical reviewer finding with the given claim. */
const reviewerFinding = (claim: string) => ({
  ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0],
  file: "engine/src/handlers/helpers/validate-task-graph.ts", line: 10, claim,
});
const MATCHING_CLAIM = "validate task graph --fix deletes critical finding claims on a second run (not idempotent)";

describe("rubric assessor", () => {
  it("flags a planted fatal flaw that is unnamed or not ranked below a sound candidate", () => {
    const fixture = judgeFixture("judge-hard-readiness-barrier");
    const input: CaseInput = { cell: "judge-verdict/v1", caseId: "judge-hard-readiness-barrier", fixture };
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

  it("refuses a payload its cell's frozen parser refuses — never read as escaping or not", () => {
    const fixture = judgeFixture("judge-hard-readiness-barrier");
    const input: CaseInput = { cell: "judge-verdict/v1", caseId: "judge-hard-readiness-barrier", fixture };
    const workloadCase = caseOf("judge-verdict/v1", "judge-hard-readiness-barrier");
    const sound = fixture.candidates.find((entry) => entry.candidate !== fixture.plantedFlaw.candidate)?.candidate;
    const unscored = {
      criterion: fixture.criterion,
      rankings: fixture.candidates.map((entry) => entry.candidate === fixture.plantedFlaw.candidate
        ? { candidate: entry.candidate, score: 2, fatal_flaw: "throws are caught", strongest_idea: "x" }
        : { candidate: entry.candidate, score: entry.candidate === sound ? "high" : 7, fatal_flaw: null, strongest_idea: "y" }),
    };
    expect(rubricEscapes(workloadCase, input, unscored)).toEqual({
      ok: false,
      error: expect.stringMatching(new RegExp(`^case ${workloadCase.caseId}: the accepted payload does not parse as a judge-verdict/v1 payload: rankings\\.\\d+\\.score: `)),
    });
    // A field rename reads as a refusal for both arms alike, never as every defect escaping.
    const renamed = { criterion: fixture.criterion, ranking: unscored.rankings };
    expect(rubricEscapes(workloadCase, input, renamed).ok).toBe(false);
    const reviewer: CaseInput = { cell: "reviewer-payload/v2", caseId: "round12-vulnerable", corpusCase: vulnerable, changedPaths: [] };
    expect(rubricEscapes(caseOf("reviewer-payload/v2", "round12-vulnerable"), reviewer, { schemaVersion: 2, kind: "standalone-review", findings: [{ claim: MATCHING_CLAIM }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("does not parse as a reviewer-payload/v2 payload: ") });
  });

  it("flags a refuted real defect but not an upheld one or a refuted false positive", () => {
    const real = realInput.fixture;
    const workloadCase = caseOf(realInput.cell, realInput.caseId);
    const payload = (verdict: string) => ({ criterion: real.lens, verdicts: [{ finding_id: real.finding.findingId, verdict, reasoning: "r" }] });
    expect(escapesOf(workloadCase, realInput, payload("refuted"))).toEqual([{ defectId: "loop-skips-last-line", severity: "major" }]);
    expect(escapesOf(workloadCase, realInput, payload("upheld"))).toEqual([]);
    expect(escapesOf(workloadCase, realInput, payload("uncertain"))).toEqual([]);
    const fp = refutationFixture("refutation-easy-guarded-null");
    expect(escapesOf(caseOf("refutation-verdict/v1", "refutation-easy-guarded-null"), { cell: "refutation-verdict/v1", caseId: "refutation-easy-guarded-null", fixture: fp }, payload("refuted"))).toEqual([]);
  });

  it("reuses the corpus match rules for reviewer v2 payloads", () => {
    const input: CaseInput = { cell: "reviewer-payload/v2", caseId: "round12-vulnerable", corpusCase: vulnerable, changedPaths: [] };
    const workloadCase = caseOf("reviewer-payload/v2", "round12-vulnerable");
    const payload = (claim: string) => ({ schemaVersion: 2, kind: "standalone-review", findings: [reviewerFinding(claim)] });
    expect(escapesOf(workloadCase, input, payload(MATCHING_CLAIM))).toEqual([]);
    expect(escapesOf(workloadCase, input, payload("unrelated logging nit"))).toEqual([{ defectId: "repair-idempotency", severity: "critical" }]);
  });

  it("reads a reviewer v3 payload's findings through their drafts, so a matching v3 finding is not an escape", () => {
    const input: CaseInput = { cell: "reviewer-payload/v3", caseId: "round12-vulnerable", corpusCase: vulnerable, changedPaths: [] };
    const workloadCase = caseOf("reviewer-payload/v3", "round12-vulnerable");
    const payload = (claim: string) => ({
      schemaVersion: 3, kind: "standalone-successor-review",
      lineageDigest: fixtures.reviewer.v3Context.lineageDigest, snapshotDigest: fixtures.reviewer.v3Context.snapshotDigest,
      priorAssessments: [],
      findings: [{ draft: reviewerFinding(claim), relation: { kind: "independent" } }],
    });
    expect(escapesOf(workloadCase, input, payload(MATCHING_CLAIM))).toEqual([]);
    expect(escapesOf(workloadCase, input, payload("unrelated logging nit"))).toEqual([{ defectId: "repair-idempotency", severity: "critical" }]);
  });

  it("fails closed on an escaped defect id the case does not declare — never an empty escape list", () => {
    const real = realInput.fixture;
    const declared = caseOf(realInput.cell, realInput.caseId);
    const drifted = { ...declared, knownDefects: [{ defectId: "renamed-defect", severity: "major" as const }] };
    const refuted = { criterion: real.lens, verdicts: [{ finding_id: real.finding.findingId, verdict: "refuted", reasoning: "r" }] };
    expect(rubricEscapes(drifted, realInput, refuted)).toEqual({
      ok: false,
      error: `case ${declared.caseId} declares no known defect "loop-skips-last-line"`,
    });
  });

  it("an undeclared escape is an error exactly when the declared case lets a defect escape (property)", () => {
    const judge = judgeFixture("judge-hard-readiness-barrier");
    const real = realInput.fixture;
    const subjects = [
      { workloadCase: caseOf("judge-verdict/v1", "judge-hard-readiness-barrier"), input: { cell: "judge-verdict/v1", caseId: "judge-hard-readiness-barrier", fixture: judge } },
      { workloadCase: caseOf(realInput.cell, realInput.caseId), input: realInput },
    ] as const;
    const payload = fc.oneof(
      fc.anything(),
      fc.record({
        criterion: fc.constant(judge.criterion),
        rankings: fc.array(fc.record({
          candidate: fc.constantFrom(...judge.candidates.map((entry) => entry.candidate)),
          score: fc.integer({ min: 0, max: 10 }),
          fatal_flaw: fc.option(fc.constantFrom("throws are caught", "unbounded retries")),
          strongest_idea: fc.constant("reuse the budget"),
        }), { minLength: 1 }),
      }),
      fc.record({
        criterion: fc.constant(real.lens),
        verdicts: fc.array(fc.record({
          finding_id: fc.constantFrom(real.finding.findingId, "other"),
          verdict: fc.constantFrom("refuted", "upheld", "uncertain"),
          reasoning: fc.constant("the guard holds"),
        }), { minLength: 1 }),
      }),
    );
    fc.assert(fc.property(fc.constantFrom(...subjects), payload, ({ workloadCase, input }, raw) => {
      const declared = rubricEscapes(workloadCase, input, raw);
      const undeclared = rubricEscapes({ ...workloadCase, knownDefects: [] }, input, raw);
      if (!declared.ok) {
        expect(undeclared).toEqual(declared);
        return;
      }
      expect(undeclared.ok).toBe(declared.value.length === 0);
      if (undeclared.ok) expect(undeclared.value).toEqual([]);
    }));
  });
});

describe("rubric assessment over the blinded packet", () => {
  const blindedWindow = async () => blind(WINDOW_ID, (await runWindow(fakeRoute(accepted))).records).entries;

  it("scores every blinded entry by its case's rubric, as an assessment the release decision parses", async () => {
    const entries = await blindedWindow();
    const assessed = rubricAssessment(PILOT_1, entries, inputs);
    if (!assessed.ok) throw new Error(assessed.error.join("; "));
    const rubric = parseQualityAssessment(assessed.value);
    if (!rubric.ok) throw new Error(rubric.error.join("; "));
    expect(rubric.value).toMatchObject({ assessorId: "rubric-v1", blinded: true });
    entries.forEach((entry, index) => {
      const input = inputOf(entry.cell, entry.caseId);
      expect(rubric.value.entries[index]).toEqual({ blindId: entry.blindId, escapedDefects: escapesOf(caseOf(entry.cell, entry.caseId), input, entry.payload) });
    });
  });

  it("refuses an entry whose case is not preregistered", async () => {
    const [first, ...rest] = await blindedWindow();
    if (first === undefined) throw new Error("the window blinded no entry");
    const assessed = rubricAssessment(PILOT_1, [{ ...first, caseId: "not-preregistered" }, ...rest], inputs);
    expect(assessed).toEqual({ ok: false, error: [expect.stringContaining(`${first.blindId} (${first.cell} case not-preregistered): the case is not preregistered`)] });
  });

  it("refuses an entry whose case has no resolved input", async () => {
    const entries = await blindedWindow();
    const [first] = entries;
    if (first === undefined) throw new Error("the window blinded no entry");
    const assessed = rubricAssessment(PILOT_1, entries, inputsWithout(first.cell, first.caseId));
    expect(assessed.ok).toBe(false);
    expect(assessed.ok ? [] : assessed.error).toContainEqual(expect.stringContaining(`${first.blindId} (${first.cell} case ${first.caseId}): no resolved input`));
  });

  it("refuses an entry whose payload its cell's parser refuses, naming it", async () => {
    const [first, ...rest] = await blindedWindow();
    if (first === undefined) throw new Error("the window blinded no entry");
    const assessed = rubricAssessment(PILOT_1, [{ ...first, payload: { findings: [] } }, ...rest], inputs);
    expect(assessed).toEqual({ ok: false, error: [expect.stringContaining(`${first.blindId} (${first.cell} case ${first.caseId}): case ${first.caseId}: the accepted payload does not parse as a ${first.cell} payload`)] });
  });

  it("refuses an escaped defect id the case does not declare, naming every such entry", async () => {
    const entries = await blindedWindow();
    const undeclared: Preregistration = {
      ...PILOT_1,
      cells: PILOT_1.cells.map((cell) => ({
        ...cell,
        workload: { ...cell.workload, cases: cell.workload.cases.map((entry) => ({ ...entry, knownDefects: [] })) },
      })),
    };
    const declared = rubricAssessment(PILOT_1, entries, inputs);
    if (!declared.ok) throw new Error(declared.error.join("; "));
    const escaping = declared.value.entries.filter((entry) => entry.escapedDefects.length > 0);
    expect(escaping.length).toBeGreaterThan(0);

    const assessed = rubricAssessment(undeclared, entries, inputs);
    expect(assessed.ok).toBe(false);
    const problems = assessed.ok ? [] : assessed.error;
    expect(problems).toHaveLength(escaping.length);
    for (const entry of escaping) expect(problems).toContainEqual(expect.stringMatching(new RegExp(`${entry.blindId} .*declares no known defect`)));
  });
});
