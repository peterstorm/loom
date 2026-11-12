import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MUTANT_CAP_PER_INVARIANT,
  MUTANT_CAP_PER_TASK,
  MUTANT_TIMEOUT_MS,
  TASK_MUTATION_OPERATORS,
  WAVE_GATE_OPERATORS,
  applyMutant,
  applyTaskMutant,
  mutantTimeoutMs,
  mutationPlan,
  mutationPlanOf,
  parseMutantCap,
  taskMutants,
} from "../../src/core/owner-verification/mutation-plan";
import { sha256Hex } from "../../src/core/digest";
import type { MutationOperator, MutationPlan } from "../../src/core/owner-verification/types";
import { capOf } from "../fixtures/owner-obligation";

const OWNER = "src/rules/owner.ts";

const lines = (from: number, to: number): ReadonlySet<number> =>
  new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));

const planAt = (ownerPath: string, ownerText: string, changedLines: ReadonlySet<number>, cap = 24): MutationPlan => {
  const plan = mutationPlan({ ownerPath, ownerText, changedLines, cap: capOf(cap) });
  if (!plan.ok) throw new Error(`owner does not parse: ${plan.error.diagnostics.join("; ")}`);
  return plan.value;
};

const planOf = (ownerText: string, changedLines: ReadonlySet<number>, cap = 24): MutationPlan =>
  planAt(OWNER, ownerText, changedLines, cap);

/** Each mutant as [operator, line, the owner line it produces], in plan order. */
const rows = (ownerText: string, plan: MutationPlan): readonly (readonly [MutationOperator, number, string])[] =>
  plan.mutants.map((mutant) => [mutant.operator, mutant.line, applyMutant(ownerText, mutant).split("\n")[mutant.line - 1]!] as const);

describe("engine constants", () => {
  it("FR-012: the per-Invariant cap is 24 and the per-mutant limit 60 s", () => {
    expect(MUTANT_CAP_PER_INVARIANT).toBe(24);
    expect(parseMutantCap(24)).toEqual({ ok: true, value: MUTANT_CAP_PER_INVARIANT });
    expect(MUTANT_TIMEOUT_MS).toBe(60_000);
  });

  it("FR-012: the per-mutant limit is clamped to at most the runner's own timeout", () => {
    expect(mutantTimeoutMs(300_000)).toBe(60_000);
    expect(mutantTimeoutMs(60_000)).toBe(60_000);
    expect(mutantTimeoutMs(5_000)).toBe(5_000);
  });
});

describe("mutationPlan", () => {
  const OWNER_TEXT = [
    "export function decide(age: number, member: boolean): boolean {", // 1
    "  if (age >= 18 && member) {", // 2
    "    return true;", // 3
    "  }", // 4
    '  log("rejected");', // 5
    "  return false;", // 6
    "}", // 7
    "",
  ].join("\n");

  it("AS-009: mutants come in (start, operator order) order, each one operator on one site of a changed line", () => {
    const plan = planOf(OWNER_TEXT, lines(1, 7));
    expect(rows(OWNER_TEXT, plan)).toEqual([
      ["condition-negation", 2, "  if (!(age >= 18 && member)) {"],
      ["comparison-flip", 2, "  if (age < 18 && member) {"],
      ["logical-swap", 2, "  if (age >= 18 || member) {"],
      ["boolean-literal-flip", 3, "    return false;"],
      ["return-value-replacement", 3, "    return undefined;"],
      ["statement-removal", 5, "  ;"],
      ["boolean-literal-flip", 6, "  return true;"],
      ["return-value-replacement", 6, "  return undefined;"],
    ]);
    expect(plan.candidates).toBe(8);
  });

  it("AS-009: each mutant carries its 1-based line and column, its span, the original text and its replacement", () => {
    const plan = planOf(OWNER_TEXT, new Set([2]));
    const [negation, flip, swap] = plan.mutants;
    expect(negation).toMatchObject({ line: 2, column: 7, original: "age >= 18 && member", replacement: "!(age >= 18 && member)" });
    expect(flip).toMatchObject({ line: 2, column: 11, original: ">=", replacement: "<" });
    expect(swap).toMatchObject({ line: 2, column: 17, original: "&&", replacement: "||" });
    for (const mutant of plan.mutants) expect(OWNER_TEXT.slice(mutant.start, mutant.end)).toBe(mutant.original);
  });

  it("FR-011: a mutant's id is the sha256 of the owner path, span and operator", () => {
    const [mutant] = planOf(OWNER_TEXT, new Set([5])).mutants;
    expect(mutant!.id).toBe(sha256Hex(JSON.stringify([OWNER, mutant!.start, mutant!.end, mutant!.operator])));
  });

  it("FR-009: a construct counts on the line its replaced span starts on", () => {
    const text = "const v =\n  x\n  && y;\n";
    expect(rows(text, planOf(text, new Set([1])))).toEqual([]);
    expect(rows(text, planOf(text, new Set([3])))).toEqual([["logical-swap", 3, "  || y;"]]);
    const multiLine = "if (\n  ready\n) { go(); }\n";
    expect(rows(multiLine, planOf(multiLine, new Set([2])))).toEqual([["condition-negation", 2, "  !(ready)"]]);
    expect(rows(multiLine, planOf(multiLine, new Set([1])))).toEqual([]);
  });

  it("FR-010: prologue directives are kept in a file and in a function body; a later string statement is removable", () => {
    const text = '"use strict";\nfunction g() {\n  "use strict";\n  "late";\n  "also late";\n}\n';
    const plan = planOf(text, lines(1, 6));
    expect(plan.mutants).toEqual([]);
    const afterCode = 'function h() {\n  run();\n  "late";\n}\n';
    expect(rows(afterCode, planOf(afterCode, lines(1, 4)))).toEqual([
      ["statement-removal", 2, "  ;"],
      ["statement-removal", 3, "  ;"],
    ]);
  });

  it("FR-010: nested constructs each yield their own site, sorted by start then operator", () => {
    const text = "const v = a < b ? c === d : !e;\n";
    expect(rows(text, planOf(text, new Set([1])))).toEqual([
      ["condition-negation", 1, "const v = !(a < b) ? c === d : !e;"],
      ["comparison-flip", 1, "const v = a >= b ? c === d : !e;"],
      ["comparison-flip", 1, "const v = a < b ? c !== d : !e;"],
    ]);
  });

  it("FR-010: an arrow's expression body is not a return and is not mutated by return-value replacement", () => {
    const text = "const f = () => x;\nconst g = () => { return x; };\n";
    expect(rows(text, planOf(text, lines(1, 2)))).toEqual([["return-value-replacement", 2, "const g = () => { return undefined; };"]]);
  });

  it("FR-010: TypeScript syntax parses: generics and type assertions do not confuse the comparison operator", () => {
    const text = "const v = id<number>(x) < (y as number);\n";
    expect(rows(text, planOf(text, new Set([1])))).toEqual([["comparison-flip", 1, "const v = id<number>(x) >= (y as number);"]]);
  });

  it("FR-010: a .tsx or .jsx owner parses with JSX, through the script-kind rule the import-graph seam owns", () => {
    const text = "export const View = (open) => <Door open={open && ready} />;\n";
    for (const ownerPath of ["src/rules/view.tsx", "src/rules/view.jsx"]) {
      expect(rows(text, planAt(ownerPath, text, new Set([1])))).toEqual([
        ["logical-swap", 1, "export const View = (open) => <Door open={open || ready} />;"],
      ]);
    }
  });

  it("FR-010: an owner with syntax errors has no plan: it is owner-unparseable with every diagnostic, never a silent plan", () => {
    const refused = mutationPlan({ ownerPath: OWNER, ownerText: "export function decide( {\n  return x >= 18;\n", changedLines: lines(1, 2), cap: capOf(24) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.kind).toBe("owner-unparseable");
    expect(refused.error.diagnostics.length).toBeGreaterThan(0);
    expect(refused.error.diagnostics[0]).toMatch(/^\d+:\d+ \S/);
  });

  it("FR-010: JSX in a .ts owner is a syntax error, so the owner is owner-unparseable rather than mutated from a garbled tree", () => {
    const refused = mutationPlan({ ownerPath: OWNER, ownerText: "export const v = <Door open={a && b} />;\n", changedLines: lines(1, 1), cap: capOf(24) });
    expect(refused).toMatchObject({ ok: false, error: { kind: "owner-unparseable" } });
  });

  it("AS-014: an owner with no mutable construct on its changed lines yields zero mutants and zero candidates", () => {
    const text = "export type Age = number;\nexport const NAME = \"owner\";\n";
    expect(planOf(text, lines(1, 2))).toEqual({ mutants: [], candidates: 0, cap: 24 });
    expect(planOf(OWNER_TEXT, new Set([1, 4, 7]))).toEqual({ mutants: [], candidates: 0, cap: 24 });
  });

  it("AS-014: an owner unchanged in the Wave (empty changed-line set) yields zero mutants", () => {
    expect(planOf(OWNER_TEXT, new Set())).toEqual({ mutants: [], candidates: 0, cap: 24 });
  });

  it("FR-009: changed lines beyond the owner's last line select nothing", () => {
    expect(planOf(OWNER_TEXT, new Set([99, 100]))).toEqual({ mutants: [], candidates: 0, cap: 24 });
  });

  it("AS-015: over the cap, the selection is the evenly spaced indices floor(i * n / cap)", () => {
    const text = Array.from({ length: 10 }, (_, index) => `f(${index});`).join("\n") + "\n";
    const plan = planOf(text, lines(1, 10), 4);
    expect(plan.candidates).toBe(10);
    expect(plan.mutants.map((mutant) => mutant.line)).toEqual([0, 2, 5, 7].map((index) => index + 1));
    expect(plan.candidates - plan.mutants.length).toBe(6);
  });

  it("AS-015: at or under the cap, every candidate is selected", () => {
    const text = Array.from({ length: 4 }, (_, index) => `f(${index});`).join("\n") + "\n";
    expect(planOf(text, lines(1, 4), 4).mutants).toHaveLength(4);
    expect(planOf(text, lines(1, 4), 5).mutants).toHaveLength(4);
  });
});

describe("applyMutant", () => {
  it("AS-009: replaces exactly the mutant's span", () => {
    const text = "if (x) { y(); }\n";
    const [negation] = planOf(text, new Set([1])).mutants;
    expect(applyMutant(text, negation!)).toBe("if (!(x)) { y(); }\n");
  });
});

// Laws over generated owners: lines drawn from a construct alphabet, any changed-line subset, any cap.
const STATEMENTS = [
  "if (x) { }", "while (x < y) { }", "do { } while (x);", "for (; x; ) { }", "const v = x ? 1 : 2;",
  "const v = x >= y;", "const v = x !== y;", "const v = x && y || z;", "const v = true;",
  "function g() { return x; }", "g();", "x = 1;", "const v = x + y;", "function g() { return; }",
  '"use strict";', "for (;;) { break; }", "export interface Door { readonly open: string }",
  "const v =\n  a\n  === b;",
] as const;

const ownerInput = fc.array(fc.constantFrom(...STATEMENTS), { minLength: 1, maxLength: 40 })
  .map((statements) => statements.join("\n") + "\n")
  .chain((ownerText) => {
    const count = ownerText.split("\n").length - 1;
    return fc.record({
      ownerText: fc.constant(ownerText),
      changedLines: fc.subarray(Array.from({ length: count }, (_, index) => index + 1)).map((chosen) => new Set(chosen)),
      cap: fc.integer({ min: 1, max: 30 }),
    });
  });

describe("mutationPlan laws", () => {
  it("FR-011: SC-003: the plan is byte-identical across 10 runs", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines, cap }) => {
      const first = JSON.stringify(planOf(ownerText, changedLines, cap));
      for (let run = 0; run < 10; run += 1) expect(JSON.stringify(planOf(ownerText, new Set(changedLines), cap))).toBe(first);
    }), { seed: 6_001, numRuns: 40 });
  });

  it("FR-009: AS-009: every mutant changes exactly one site, on a changed line, and differs from the owner only within [start, end)", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines, cap }) => {
      for (const mutant of planOf(ownerText, changedLines, cap).mutants) {
        expect(changedLines.has(mutant.line)).toBe(true);
        expect(ownerText.slice(0, mutant.start).split("\n").length).toBe(mutant.line);
        const mutated = applyMutant(ownerText, mutant);
        expect(mutated.slice(0, mutant.start)).toBe(ownerText.slice(0, mutant.start));
        expect(mutated.slice(mutant.start + mutant.replacement.length)).toBe(ownerText.slice(mutant.end));
        expect(mutated.slice(mutant.start, mutant.start + mutant.replacement.length)).toBe(mutant.replacement);
        expect(mutant.replacement).not.toBe(mutant.original);
      }
    }), { seed: 6_002, numRuns: 80 });
  });

  it("AS-015: FR-012: the selection never exceeds the cap, and selected + unmutated = candidates", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines, cap }) => {
      const plan = planOf(ownerText, changedLines, cap);
      const all = planOf(ownerText, changedLines, 1_000);
      expect(plan.mutants.length).toBeLessThanOrEqual(cap);
      expect(plan.candidates).toBe(all.candidates);
      expect(all.mutants).toHaveLength(all.candidates);
      expect(plan.mutants.length).toBe(Math.min(cap, plan.candidates));
      // The selection's plan is one the constructor admits as it stands: the bound it holds by construction is the bound checked.
      expect(mutationPlanOf({ mutants: plan.mutants, candidates: plan.candidates, cap: plan.cap })).toEqual({ ok: true, value: plan });
      // The selection is a subsequence of the full candidate list.
      const ids = all.mutants.map((mutant) => mutant.id);
      let cursor = 0;
      for (const mutant of plan.mutants) {
        cursor = ids.indexOf(mutant.id, cursor);
        expect(cursor).toBeGreaterThanOrEqual(0);
        cursor += 1;
      }
    }), { seed: 6_003, numRuns: 80 });
  });

  it("AS-014: an empty changed-line set yields zero mutants for every owner", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, cap }) => {
      expect(planOf(ownerText, new Set(), cap)).toEqual({ mutants: [], candidates: 0, cap });
    }), { seed: 6_004, numRuns: 40 });
  });

  it("FR-011: mutant ids are unique within a plan", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines }) => {
      const ids = planOf(ownerText, changedLines, 1_000).mutants.map((mutant) => mutant.id);
      expect(new Set(ids).size).toBe(ids.length);
    }), { seed: 6_005, numRuns: 40 });
  });
});

// The Task mutation check (ADR-0071): the Wave Gate's six operators and `guard-removal`, over a Task's files together.

const GUARDED = [
  "export function debit(balance: number, amount: number): number {", // 1
  '  if (amount <= 0) throw new Error("amount must be positive");', // 2
  "  if (amount > balance) {", // 3
  "    return balance;", // 4
  "  }", // 5
  "  if (balance > 1000) { audit(balance); }", // 6
  "  return balance - amount;", // 7
  "}", // 8
  "",
].join("\n");

const taskMutantsOf = (files: readonly (readonly [string, string])[], cap = 1_000) => {
  const selected = taskMutants(files.map(([path, text]) => ({ path, text, changedLines: lines(1, text.split("\n").length) })), capOf(cap));
  if (!selected.ok) throw new Error(`${selected.error.path} does not parse`);
  return selected.value;
};

describe("the operator sets", () => {
  it("ADR-0036: the Wave Gate applies exactly its six operators, in their fixed order", () => {
    expect(WAVE_GATE_OPERATORS).toEqual([
      "condition-negation", "comparison-flip", "logical-swap", "boolean-literal-flip", "return-value-replacement", "statement-removal",
    ]);
  });

  it("ADR-0071: the Task mutation check applies guard-removal first, then the Wave Gate's six", () => {
    expect(TASK_MUTATION_OPERATORS).toEqual(["guard-removal", ...WAVE_GATE_OPERATORS]);
    expect(MUTANT_CAP_PER_TASK).toBe(8);
  });

  it("ADR-0036: a Wave Gate plan never holds a guard-removal mutant, and its ids are what they were before the operator existed", () => {
    const plan = planOf(GUARDED, lines(1, 8));
    expect(plan.mutants.map(({ operator }) => operator)).not.toContain("guard-removal");
    expect(plan.candidates).toBe(9);
    // The ids of the owner's guard-line mutants, computed before `guard-removal` existed.
    expect(plan.mutants.slice(0, 2).map(({ id, operator }) => [operator, id])).toEqual([
      ["condition-negation", sha256Hex(JSON.stringify([OWNER, 71, 82, "condition-negation"]))],
      ["comparison-flip", sha256Hex(JSON.stringify([OWNER, 78, 80, "comparison-flip"]))],
    ]);
  });

  it("ADR-0036: over generated owners, the Wave Gate plan is the Task selection of the same file with every guard-removal dropped", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines }) => {
      const gate = planOf(ownerText, changedLines, 1_000);
      const selected = taskMutants([{ path: OWNER, text: ownerText, changedLines }], capOf(1_000));
      if (!selected.ok) throw new Error("generated owner does not parse");
      const withoutGuards = selected.value.mutants.filter(({ operator }) => operator !== "guard-removal");
      expect(withoutGuards.map(({ id }) => id)).toEqual(gate.mutants.map(({ id }) => id));
      expect(withoutGuards.map(({ path: _path, ...mutant }) => mutant)).toEqual(gate.mutants);
    }), { seed: 6_101, numRuns: 60 });
  });
});

describe("taskMutants", () => {
  it("ADR-0071: an `if` with no else whose body only exits is a guard, removed whole, before the condition's own mutants", () => {
    const { mutants, candidates } = taskMutantsOf([[OWNER, GUARDED]]);
    const guards = mutants.filter(({ operator }) => operator === "guard-removal");
    expect(guards.map(({ line, original, replacement }) => [line, original, replacement])).toEqual([
      [2, 'if (amount <= 0) throw new Error("amount must be positive");', ";"],
      [3, "if (amount > balance) {\n    return balance;\n  }", ";"],
    ]);
    // Line 6's `if` does not exit, so it is no guard.
    expect(mutants.filter(({ line }) => line === 6).map(({ operator }) => operator)).not.toContain("guard-removal");
    expect(mutants.slice(0, 3).map(({ operator, line }) => [operator, line])).toEqual([
      ["guard-removal", 2], ["condition-negation", 2], ["comparison-flip", 2],
    ]);
    expect(candidates).toBe(mutants.length);
    expect(applyTaskMutant(GUARDED, guards[0]!).split("\n")[1]).toBe("  ;");
  });

  it.each([
    ["an if with an else", "if (x) { return 1; } else { go(); }"],
    ["an if whose body does more than exit", "if (x) { go(); return 1; }"],
    ["an if with an empty body", "if (x) { }"],
  ])("ADR-0071: %s is not a guard", (_label, statement) => {
    const text = `function f() {\n  ${statement}\n}\n`;
    expect(taskMutantsOf([[OWNER, text]]).mutants.map(({ operator }) => operator)).not.toContain("guard-removal");
  });

  it.each(["throw new Error();", "return;", "continue;", "break;"])("ADR-0071: a guard may exit by `%s`", (exit) => {
    const text = `function f() {\n  for (;;) {\n    if (x) ${exit}\n  }\n}\n`;
    expect(taskMutantsOf([[OWNER, text]]).mutants.filter(({ operator }) => operator === "guard-removal")).toHaveLength(1);
  });

  it("ADR-0071: files are taken in the order given, each mutant naming its file, with ids unique across files", () => {
    const { mutants } = taskMutantsOf([["src/b.ts", "g();\n"], ["src/a.ts", "g();\n"]]);
    expect(mutants.map(({ path, operator }) => [path, operator])).toEqual([["src/b.ts", "statement-removal"], ["src/a.ts", "statement-removal"]]);
    expect(new Set(mutants.map(({ id }) => id)).size).toBe(2);
  });

  it("ADR-0071: a file that does not parse refuses the whole selection, naming the file", () => {
    const refused = taskMutants([
      { path: "src/a.ts", text: "g();\n", changedLines: lines(1, 1) },
      { path: "src/broken.ts", text: "function (\n", changedLines: lines(1, 1) },
    ], MUTANT_CAP_PER_TASK);
    expect(refused).toMatchObject({ ok: false, error: { kind: "owner-unparseable", path: "src/broken.ts" } });
  });

  const taskFiles = fc.array(fc.array(fc.constantFrom(...STATEMENTS, "if (x) return;", "if (x) { throw new Error(); }"), { minLength: 0, maxLength: 12 }), { minLength: 1, maxLength: 4 })
    .map((files) => files.map((statements, index): readonly [string, string] => [`src/file-${index}.ts`, `function f() {\n${statements.join("\n")}\n}\n`]));

  it("ADR-0071: the selection holds min(candidates, cap) mutants: the evenly spaced indices floor(i * n / cap) of all files' candidates together", () => {
    fc.assert(fc.property(taskFiles, fc.integer({ min: 1, max: 12 }), (files, cap) => {
      const all = taskMutantsOf(files);
      const capped = taskMutantsOf(files, cap);
      const n = all.mutants.length;
      expect(capped.candidates).toBe(n);
      expect(capped.mutants.length).toBe(Math.min(n, cap));
      const expected = n <= cap ? all.mutants : Array.from({ length: cap }, (_, i) => all.mutants[Math.floor((i * n) / cap)]);
      expect(capped.mutants).toEqual(expected);
    }), { seed: 6_102, numRuns: 80 });
  });

  it("ADR-0071: the selection is deterministic, and every mutant rewrites only its own span on a changed line of its own file", () => {
    fc.assert(fc.property(taskFiles, (files) => {
      const texts = new Map(files);
      const first = taskMutantsOf(files, MUTANT_CAP_PER_TASK);
      expect(JSON.stringify(taskMutantsOf(files, MUTANT_CAP_PER_TASK))).toBe(JSON.stringify(first));
      for (const mutant of first.mutants) {
        const text = texts.get(mutant.path) ?? "";
        expect(text.slice(mutant.start, mutant.end)).toBe(mutant.original);
        const mutated = applyTaskMutant(text, mutant);
        expect(mutated).not.toBe(text);
        expect(mutated.slice(0, mutant.start) + mutated.slice(mutant.start + mutant.replacement.length)).toBe(text.slice(0, mutant.start) + text.slice(mutant.end));
      }
    }), { seed: 6_103, numRuns: 60 });
  });
});
