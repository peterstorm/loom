import { describe, expect, it } from "vitest";
import { REVIEWER_OUTPUT_CONTRACT } from "../../engine/src/core/reviewer-contract";
import { mintCellBinding, pilotRequestId, type CellBinding } from "./pilot-binding";
import { corpusCases, fixtures, inputOf, inputs, prereg } from "./pilot-test-fixtures";
import { PILOT_CELLS, type CellKey } from "./pilot-vocabulary";
import {
  parseCaseSource,
  renderPilotPrompt,
  renderTaskBody,
  resolveCaseInput,
  resolveWindowInputs,
  WindowInputs,
  type CaseInput,
} from "./pilot-workload";

const corpus = new Map(corpusCases.map((entry) => [entry.id, entry] as const));
const NO_PATHS = (): readonly string[] => [];
const source = (value: string) => ({ caseId: "case-under-test", source: value });

describe("case-input resolution (the one resolver the window and the tests share)", () => {
  it("resolves every preregistered case to the input its cell can render, carrying its case", () => {
    const changed = (revision: string): readonly string[] => [`changed-in-${revision}`];
    const resolved = resolveWindowInputs(prereg, fixtures, corpusCases, changed);
    if (!resolved.ok) throw new Error(resolved.error.join("\n"));
    const cases = prereg.cells.flatMap((cell) => cell.workload.cases.map((entry) => ({ cell: cell.cell, entry })));
    expect(resolved.value.size).toBe(cases.length);
    for (const { cell, entry } of cases) {
      const input = resolved.value.caseInput(cell, entry.caseId);
      expect(input?.cell).toBe(cell);
      expect(input?.caseId).toBe(entry.caseId);
      if (input !== undefined && "corpusCase" in input) {
        expect(input.changedPaths).toEqual([`changed-in-${input.corpusCase.revision}`]);
        // Vulnerable snapshots are the held-out known-defect cases; their known
        // defects are exactly the corpus expectations.
        expect(entry.heldOutKnownDefectCase).toBe(input.corpusCase.state === "vulnerable");
        if (input.corpusCase.state === "vulnerable") {
          expect(entry.knownDefects.map((defect) => defect.defectId)).toEqual(input.corpusCase.expectedCriticals.map((expectation) => expectation.id));
        }
      }
    }
  });

  it("refuses a source that names a missing case or fixture, or a fixture of another cell", () => {
    const fixtureOf = (kind: string) => Object.entries(fixtures.fixtures).find(([, fixture]) => fixture.kind === kind)?.[0];
    const judgeFixture = fixtureOf("judge-verdict");
    const refutationFixture = fixtureOf("refutation-verdict");
    const corpusId = corpusCases[0]?.id;
    expect(resolveCaseInput("reviewer-payload/v2", source("corpus:no-such-case"), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: "corpus case no-such-case is not in the corpus" });
    expect(resolveCaseInput("judge-verdict/v1", source("fixture:no-such-fixture"), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: "workload fixture no-such-fixture is not in the fixture file" });
    expect(resolveCaseInput("refutation-verdict/v1", source(`fixture:${judgeFixture}`), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: `workload fixture ${judgeFixture} is a judge-verdict fixture, which cannot feed cell refutation-verdict/v1` });
    expect(resolveCaseInput("judge-verdict/v1", source(`fixture:${refutationFixture}`), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: `workload fixture ${refutationFixture} is a refutation-verdict fixture, which cannot feed cell judge-verdict/v1` });
    expect(resolveCaseInput("judge-verdict/v1", source(`corpus:${corpusId}`), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: `case source corpus:${corpusId} is not a workload fixture, which cell judge-verdict/v1 needs` });
    expect(resolveCaseInput("reviewer-payload/v3", source(`fixture:${judgeFixture}`), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: `case source fixture:${judgeFixture} is not a corpus case, which cell reviewer-payload/v3 needs` });
    expect(resolveCaseInput("reviewer-payload/v3", source("nowhere"), corpus, fixtures, NO_PATHS))
      .toEqual({ ok: false, error: 'case source "nowhere" is neither corpus:<id> nor fixture:<id>' });
  });

  it("resolves a fixture source to the cell its own kind feeds, carrying the case it was resolved for", () => {
    for (const [id, fixture] of Object.entries(fixtures.fixtures)) {
      const cell = fixture.kind === "judge-verdict" ? "judge-verdict/v1" : "refutation-verdict/v1";
      expect(resolveCaseInput(cell, source(`fixture:${id}`), corpus, fixtures, NO_PATHS))
        .toEqual({ ok: true, value: { cell, caseId: "case-under-test", fixture } });
    }
  });

  it("looks an input up only for exactly the cell and case it was resolved for", () => {
    const [judge = "", refutation = ""] = (["judge-verdict/v1", "refutation-verdict/v1"] as const)
      .map((cell) => prereg.cells.find((entry) => entry.cell === cell)?.workload.cases[0]?.caseId ?? "");
    expect(inputs.caseInput("judge-verdict/v1", judge)).toMatchObject({ cell: "judge-verdict/v1", caseId: judge });
    expect(inputs.caseInput("refutation-verdict/v1", judge)).toBeUndefined();
    expect(inputs.caseInput("judge-verdict/v1", refutation)).toBeUndefined();
    expect(inputs.caseInput("judge-verdict/v1", "no-such-case")).toBeUndefined();
  });

  it("files every input under the cell and case it carries — the one builder derives the key", () => {
    const all = inputs.values();
    const rebuilt = WindowInputs.of([...all].reverse());
    expect(rebuilt.size).toBe(all.length);
    for (const input of all) expect(rebuilt.caseInput(input.cell, input.caseId)).toBe(input);
    // A case id spelled like another key's separator cannot collide with a different (cell, case).
    const [first] = all;
    if (first === undefined) throw new Error("the window resolved no input");
    const tricky = WindowInputs.of([{ ...first, caseId: `${first.caseId}|x` }]);
    expect(tricky.caseInput(first.cell, first.caseId)).toBeUndefined();
    expect(tricky.caseInput(first.cell, `${first.caseId}|x`)?.caseId).toBe(`${first.caseId}|x`);
    expect(Object.isFrozen(inputs) && Object.isFrozen(all)).toBe(true);
  });

  it("refuses two inputs for one case as a broken construction invariant", () => {
    const [first] = inputs.values();
    if (first === undefined) throw new Error("the window resolved no input");
    expect(() => WindowInputs.of([first, first])).toThrow(`two resolved inputs for ${first.cell} case ${first.caseId}`);
  });

  it("refuses a window's inputs naming every unresolvable case", () => {
    const [first, ...rest] = prereg.cells;
    if (first === undefined) throw new Error("the preregistration has no cell");
    const [case0, case1, ...others] = first.workload.cases;
    if (case0 === undefined || case1 === undefined) throw new Error(`${first.cell} has fewer than two cases`);
    const broken = {
      ...prereg,
      cells: [{ ...first, workload: { ...first.workload, cases: [{ ...case0, source: "corpus:gone" }, { ...case1, source: "fixture:gone" }, ...others] } }, ...rest],
    };
    expect(resolveWindowInputs(broken, fixtures, corpusCases, NO_PATHS)).toEqual({
      ok: false,
      error: [
        `${first.cell} case ${case0.caseId}: corpus case gone is not in the corpus`,
        `${first.cell} case ${case1.caseId}: case source fixture:gone is not a corpus case, which cell ${first.cell} needs`,
      ],
    });
  });

  it("makes an input that cannot feed its cell unrepresentable", () => {
    const judge = inputOf("judge-verdict/v1", prereg.cells.find((cell) => cell.cell === "judge-verdict/v1")?.workload.cases[0]?.caseId ?? "");
    if (!("fixture" in judge) || judge.fixture.kind !== "judge-verdict") throw new Error("the judge cell resolved to no judge fixture");
    // @ts-expect-error — a judge fixture is not a refutation cell's input.
    const crossed: CaseInput = { cell: "refutation-verdict/v1", caseId: judge.caseId, fixture: judge.fixture };
    expect(crossed.cell).toBe("refutation-verdict/v1");
  });

  it("parses case source pointers", () => {
    expect(parseCaseSource("corpus:a:b")).toEqual({ ok: true, value: { kind: "corpus", id: "a:b" } });
    expect(parseCaseSource("fixture:x")).toEqual({ ok: true, value: { kind: "fixture", id: "x" } });
    expect(parseCaseSource("fixture:").ok).toBe(false);
  });
});

describe("matched workload prompts", () => {
  const binding = (cell: CellKey, body: string): CellBinding => {
    const minted = mintCellBinding(cell, pilotRequestId("w", `${cell}#c#r1`, "emission-enabled", 1), body);
    if (!minted.ok) throw new Error(minted.error);
    return minted.value;
  };
  const caseOf = (cell: CellKey): string => {
    const caseId = prereg.cells.find((entry) => entry.cell === cell)?.workload.cases[0]?.caseId;
    if (caseId === undefined) throw new Error(`${cell} has no case`);
    return caseId;
  };

  it("gives both arms byte-identical bodies and differs only in the wire section", () => {
    for (const cell of ["reviewer-payload/v2", "reviewer-payload/v3", "judge-verdict/v1", "refutation-verdict/v1"] as const) {
      const body = renderTaskBody(inputOf(cell, caseOf(cell)), fixtures);
      const minted = binding(cell, body);
      const emission = renderPilotPrompt(body, cell, { arm: "emission-enabled", binding: minted.binding });
      const extraction = renderPilotPrompt(body, cell, { arm: "extraction-only" });
      expect(emission.startsWith(body)).toBe(true);
      expect(extraction.startsWith(body)).toBe(true);
      expect(emission).toContain(minted.binding.toolName);
      expect(extraction).not.toContain(minted.binding.toolName);
      expect(body).toContain(PILOT_CELLS[cell].schemaBytes);
    }
    const v2 = renderTaskBody(inputOf("reviewer-payload/v2", caseOf("reviewer-payload/v2")), fixtures);
    expect(renderPilotPrompt(v2, "reviewer-payload/v2", { arm: "extraction-only" })).toContain(REVIEWER_OUTPUT_CONTRACT);
    const v3 = renderTaskBody(inputOf("reviewer-payload/v3", caseOf("reviewer-payload/v3")), fixtures);
    expect(v3).toContain(fixtures.reviewer.v3Context.lineageDigest);
    expect(v2).not.toContain(fixtures.reviewer.v3Context.lineageDigest);
  });

  it("names the revision-derived changed-path scope of a reviewer snapshot", () => {
    const input = inputOf("reviewer-payload/v2", caseOf("reviewer-payload/v2"));
    if (!("corpusCase" in input)) throw new Error("a reviewer cell resolved to a fixture");
    expect(renderTaskBody({ ...input, changedPaths: ["a.ts", "b.ts"] }, fixtures)).toContain("changed-path scope: a.ts, b.ts.");
    expect(renderTaskBody({ ...input, changedPaths: [] }, fixtures)).toContain("changed-path scope: no changed paths reported.");
  });
});
