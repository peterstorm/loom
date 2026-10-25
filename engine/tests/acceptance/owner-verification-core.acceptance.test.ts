/**
 * CT-1 acceptance: the pure owner-verification core.
 *
 * - Sibling coverage (`coverageOverFiles`): a matrix test covers an owned
 *   Invariant only when its direct imports, closed under re-exports and
 *   resolved through relative paths and tsconfig `paths` aliases to files,
 *   include the owner and every declared sibling entry point.
 * - The mutation plan (`mutationPlan`, `applyMutant`): a pure, deterministic
 *   function of owner bytes, changed lines and cap, built from exactly the six
 *   fixed operators on changed lines only, capped with an evenly spaced
 *   selection and the unmutated count reported.
 * - Outcome classification (`classifyMutantRun`, `classifyBaseline`): only the
 *   structured report decides killed, survived and invalid; a timeout kills a
 *   mutant; every ambiguous observation is infrastructure and never a kill.
 *
 * This file holds the contract's supported domain: the supported/unsupported
 * construct table of the operator set, and the laws of coverage and of the
 * mutation plan, as test cases.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { coverageOverFiles } from "../../src/core/owner-verification/coverage";
import { applyMutant, mutationPlan, mutationPlanOf, parseMutantCap } from "../../src/core/owner-verification/mutation-plan";
import { classifyBaseline, classifyMutantRun, verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type {
  MatrixTestRun,
  Mutant,
  MutantCap,
  MutationOperator,
  MutationPlan,
  OwnerObligation,
  PathAliases,
  MutationPlanInput,
  SurvivorDiagnostic,
} from "../../src/core/owner-verification/types";
import { ownerObligation } from "../fixtures/owner-obligation";

// ---------------------------------------------------------------------------
// Sibling coverage
// ---------------------------------------------------------------------------

const OWNER = "src/rules/owner.ts";
const SIBLING_A = "src/rules/sibling-a.ts";
const SIBLING_B = "src/rules/sibling-b.ts";
const BARREL = "src/rules/index.ts";
const MATRIX = "tests/rules.matrix.test.ts";

const obligation = (siblings: readonly string[] = [SIBLING_A, SIBLING_B]): OwnerObligation => ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
  owner: OWNER,
  siblings: siblings.map((path) => ({ path, note: null })),
  matrixTest: MATRIX,
  mutation: { kind: "verify" },
});

/** `@rules/*` resolves to `src/rules/*`, repository-relative. */
const ALIASES: PathAliases = [{ pattern: "@rules/*", targets: ["src/rules/*"] }];

/** The repository files every coverage case starts from; the matrix test is added per case. */
const SOURCES: Readonly<Record<string, string>> = {
  [OWNER]: "export function decide(age: number, member: boolean): boolean {\n  return age >= 18 && member;\n}\n",
  [SIBLING_A]: 'import { decide } from "./owner";\nexport const admitMember = (age: number) => decide(age, true);\n',
  [SIBLING_B]: 'import { decide } from "./owner";\nexport const admitGuest = (age: number) => decide(age, false);\n',
  [BARREL]: 'export { admitGuest } from "./sibling-b";\n',
  "src/rules/guests.ts": 'export * from "./index";\n',
  "src/other/sibling-a.ts": "export const admitMember = () => false;\n",
  "tests/owner.ts": "export const decide = () => true;\n",
};

const files = (matrixText: string, extra: Readonly<Record<string, string>> = {}): ReadonlyMap<string, string> =>
  new Map(Object.entries({ ...SOURCES, ...extra, [MATRIX]: matrixText }));

const coverage = (matrixText: string, siblings?: readonly string[], aliases: PathAliases = ALIASES) =>
  coverageOverFiles({ matrixTest: MATRIX, obligation: obligation(siblings), files: files(matrixText), aliases });

const importing = (...specifiers: string[]): string =>
  specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`).join("\n") + "\nit('decides', () => {});\n";

describe("sibling coverage (CT-1)", () => {
  it("AS-001: a matrix test importing the owner and every declared sibling entry point covers the Invariant", () => {
    expect(coverage(importing("../src/rules/owner", "../src/rules/sibling-a", "../src/rules/sibling-b"))).toEqual({ kind: "covered" });
  });

  it("AS-002: a matrix test that omits one declared sibling is missing exactly that sibling path", () => {
    expect(coverage(importing("../src/rules/owner", "../src/rules/sibling-a"))).toEqual({ kind: "missing", paths: [SIBLING_B] });
  });

  it("FR-006: every missing path is named, in declared order with the owner first", () => {
    expect(coverage(importing("vitest"))).toEqual({ kind: "missing", paths: [OWNER, SIBLING_A, SIBLING_B] });
    expect(coverage(importing("../src/rules/sibling-b"))).toEqual({ kind: "missing", paths: [OWNER, SIBLING_A] });
  });

  it("AS-003: with `Sibling entry points: none` only the owner must be reached", () => {
    expect(coverage(importing("../src/rules/owner"), [])).toEqual({ kind: "covered" });
    expect(coverage(importing("vitest"), [])).toEqual({ kind: "missing", paths: [OWNER] });
  });

  it("AS-003: FR-005: the owner reached only through a sibling's own import is not reached (no transitive closure over plain imports)", () => {
    expect(coverage(importing("../src/rules/sibling-a"), [])).toEqual({ kind: "missing", paths: [OWNER] });
    expect(coverage(importing("../src/rules/sibling-a", "../src/rules/sibling-b"))).toEqual({ kind: "missing", paths: [OWNER] });
  });

  it("AS-006: a sibling reached through a re-export barrel, a path alias or a relative path counts as reached", () => {
    expect(coverage(importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/index"))).toEqual({ kind: "covered" });
    // A directory import resolves through `/index.ts`; a `.js` specifier through its `.ts` file.
    expect(coverage(importing("../src/rules/owner.js", "@rules/sibling-a", "../src/rules"))).toEqual({ kind: "covered" });
  });

  it("AS-006: a re-export chain of any length reaches its target", () => {
    expect(coverage(importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/guests"))).toEqual({ kind: "covered" });
  });

  it("AS-006: a specifier that resolves to a different file does not count", () => {
    // `./owner` from tests/ is tests/owner.ts, not the owner module.
    expect(coverage(importing("./owner", "@rules/sibling-a", "@rules/sibling-b"))).toEqual({ kind: "missing", paths: [OWNER] });
    // An alias whose target is another directory reaches that directory's file.
    const otherAlias: PathAliases = [{ pattern: "@rules/*", targets: ["src/other/*"] }];
    expect(coverage(importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/sibling-b"), undefined, otherAlias))
      .toEqual({ kind: "missing", paths: [SIBLING_A] });
    // A bare package specifier is external and reaches nothing.
    expect(coverage(importing("rules/owner", "../src/rules/sibling-a", "../src/rules/sibling-b"))).toEqual({ kind: "missing", paths: [OWNER] });
  });

  it("FR-005: every module-import form counts; text that only looks like an import does not", () => {
    const matrix = [
      'import "../src/rules/owner";',
      'import siblingA = require("../src/rules/sibling-a");',
      'it("loads the guest door", async () => { await import("../src/rules/sibling-b"); });',
    ].join("\n");
    expect(coverage(matrix)).toEqual({ kind: "covered" });
    expect(coverage('const { decide } = require("../src/rules/owner");\nexport { admitMember } from "../src/rules/sibling-a";\nexport * from "../src/rules/sibling-b";\n'))
      .toEqual({ kind: "covered" });
    const lookalikes = [
      'import "../src/rules/owner";',
      '// import "../src/rules/sibling-a";',
      'const path = "../src/rules/sibling-b";',
      "const text = `import(\"../src/rules/sibling-b\")`;",
    ].join("\n");
    expect(coverage(lookalikes)).toEqual({ kind: "missing", paths: [SIBLING_A, SIBLING_B] });
  });

  // Laws: the coverage decision is a pure function of the import graph and the declared paths.
  const MATRIX_TEXTS = [
    importing("../src/rules/owner", "../src/rules/sibling-a", "../src/rules/sibling-b"),
    importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/index"),
    importing("../src/rules/sibling-a"),
    importing("./owner", "../src/rules/guests"),
  ];

  it("FR-007: the verdict is invariant under the file map's insertion order and repeated evaluation", () => {
    fc.assert(fc.property(
      fc.constantFrom(...MATRIX_TEXTS),
      fc.array(fc.nat(), { minLength: Object.keys(SOURCES).length + 1, maxLength: Object.keys(SOURCES).length + 1 }),
      (matrixText, keys) => {
        const entries = [...files(matrixText).entries()];
        const shuffled = new Map(entries.map((entry, index) => [keys[index]!, index, entry] as const)
          .sort((left, right) => left[0] - right[0] || left[1] - right[1])
          .map(([, , entry]) => entry));
        const input = { matrixTest: MATRIX, obligation: obligation(), aliases: ALIASES };
        const ordered = coverageOverFiles({ ...input, files: files(matrixText) });
        expect(coverageOverFiles({ ...input, files: shuffled })).toEqual(ordered);
        expect(coverageOverFiles({ ...input, files: files(matrixText) })).toEqual(ordered);
      },
    ), { numRuns: 40 });
  });

  it("FR-007: adding a file nothing imports never changes the verdict", () => {
    fc.assert(fc.property(
      fc.constantFrom(...MATRIX_TEXTS),
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.string(),
      (matrixText, name, text) => {
        const input = { matrixTest: MATRIX, obligation: obligation(), aliases: ALIASES };
        const before = coverageOverFiles({ ...input, files: files(matrixText) });
        const after = coverageOverFiles({ ...input, files: files(matrixText, { [`src/unrelated/${name}.ts`]: text }) });
        expect(after).toEqual(before);
      },
    ), { numRuns: 40 });
  });
});

// ---------------------------------------------------------------------------
// The mutation plan
// ---------------------------------------------------------------------------

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

const lines = (from: number, to: number): ReadonlySet<number> =>
  new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));

/** A cap through its parser, the only way to hold one. Called inside testcases, never at load. */
const capOf = (raw: number): MutantCap => {
  const parsed = parseMutantCap(raw);
  if (!parsed.ok) throw new Error(`not a mutant cap: ${raw}`);
  return parsed.value;
};

/** The plan of a well-formed owner; every owner this file plans parses. */
const planned = (input: MutationPlanInput): MutationPlan => {
  const plan = mutationPlan(input);
  if (!plan.ok) throw new Error(`owner does not parse: ${plan.error.diagnostics.join("; ")}`);
  return plan.value;
};

const planOf = (ownerText: string, changedLines: ReadonlySet<number>, cap = 24): MutationPlan =>
  planned({ ownerPath: OWNER, ownerText, changedLines, cap: capOf(cap) });

/** The sites the cap left unmutated, derived from the plan. */
const unmutatedOf = (plan: MutationPlan): number => plan.candidates - plan.mutants.length;

/** Each mutant as its operator and the owner line it produces, sorted: the
 *  mutant set's behavior, independent of how a site's span is chosen. */
const mutatedLines = (ownerText: string, plan: MutationPlan): readonly (readonly [MutationOperator, number, string])[] =>
  plan.mutants
    .map((mutant) => [mutant.operator, mutant.line, applyMutant(ownerText, mutant).split("\n")[mutant.line - 1]!] as const)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

const sorted = (rows: readonly (readonly [MutationOperator, number, string])[]) =>
  [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

describe("the mutation plan (CT-1)", () => {
  it("AS-009: each mutant is one fixed operator applied to one site on a changed line", () => {
    const plan = planOf(OWNER_TEXT, lines(1, 7));
    expect(mutatedLines(OWNER_TEXT, plan)).toEqual(sorted([
      ["condition-negation", 2, "  if (!(age >= 18 && member)) {"],
      ["comparison-flip", 2, "  if (age < 18 && member) {"],
      ["logical-swap", 2, "  if (age >= 18 || member) {"],
      ["boolean-literal-flip", 3, "    return false;"],
      ["return-value-replacement", 3, "    return undefined;"],
      ["statement-removal", 5, "  ;"],
      ["boolean-literal-flip", 6, "  return true;"],
      ["return-value-replacement", 6, "  return undefined;"],
    ]));
    expect(plan.candidates).toBe(8);
    expect(unmutatedOf(plan)).toBe(0);
    for (const mutant of plan.mutants) {
      expect(OWNER_TEXT.slice(mutant.start, mutant.end)).toBe(mutant.original);
      expect(mutant.replacement).not.toBe(mutant.original);
    }
  });

  it("FR-009: sites are restricted to the owner's changed lines", () => {
    const plan = planOf(OWNER_TEXT, new Set([5]));
    expect(mutatedLines(OWNER_TEXT, plan)).toEqual([["statement-removal", 5, "  ;"]]);
    const lineThree = planOf(OWNER_TEXT, new Set([3]));
    expect(lineThree.mutants.map((mutant) => mutant.line)).toEqual([3, 3]);
    expect(lineThree.candidates).toBe(2);
  });

  it("AS-014: changed lines with no mutable construct generate zero mutants", () => {
    const text = 'export type Age = number;\nexport const NAME = "owner";\nexport interface Door { readonly open: boolean }\n';
    expect(planOf(text, lines(1, 3))).toEqual({ mutants: [], candidates: 0, cap: 24 });
    expect(planOf(OWNER_TEXT, new Set())).toEqual({ mutants: [], candidates: 0, cap: 24 });
  });

  it("AS-015: FR-012: more sites than the cap select an evenly spaced, deterministic subset and report the unmutated count", () => {
    // Thirty expression statements, one per line: thirty statement-removal sites.
    const text = Array.from({ length: 30 }, (_, index) => `f(${index});`).join("\n") + "\n";
    const plan = planOf(text, lines(1, 30));
    expect(plan.candidates).toBe(30);
    expect(plan.cap).toBe(24);
    expect(plan.mutants).toHaveLength(24);
    expect(unmutatedOf(plan)).toBe(6);
    // floor(i * 30 / 24) for i < 24, as 1-based lines.
    expect(plan.mutants.map((mutant) => mutant.line)).toEqual(
      [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 23, 25, 26, 27, 28].map((index) => index + 1));
    expect(planOf(text, lines(1, 30))).toEqual(plan);
  });

  it("FR-011: the mutant set is identical on every run for the same owner bytes, changed lines and cap", () => {
    const first = planOf(OWNER_TEXT, lines(1, 7));
    for (let run = 0; run < 10; run += 1) expect(planOf(OWNER_TEXT, lines(1, 7))).toEqual(first);
    const ids = first.mutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FR-017: the plan is a pure function of its input, never of the filesystem", () => {
    const absent = planned({ ownerPath: "no/such/dir/owner.ts", ownerText: OWNER_TEXT, changedLines: new Set([5]), cap: capOf(24) });
    expect(absent.mutants.map((mutant) => [mutant.operator, mutant.line])).toEqual([["statement-removal", 5]]);
    // The owner path enters only the mutant identity, never the site choice.
    const elsewhere = planned({ ownerPath: "src/elsewhere.ts", ownerText: OWNER_TEXT, changedLines: new Set([5]), cap: capOf(24) });
    expect(elsewhere.mutants.map(({ id: _id, ...site }) => site)).toEqual(absent.mutants.map(({ id: _id, ...site }) => site));
    expect(elsewhere.mutants[0]!.id).not.toBe(absent.mutants[0]!.id);
  });

  it.each([0, -1, -24, 1.5, 23.999, Number.NaN, Number.POSITIVE_INFINITY])("FR-012: the cap parser refuses %s: a cap is a positive integer", (raw) => {
    expect(parseMutantCap(raw)).toEqual({ ok: false, error: { kind: "not-positive-integer", raw } });
  });

  it("FR-012: the cap parser accepts every positive integer, the engine's 24 included", () => {
    expect(parseMutantCap(24)).toEqual({ ok: true, value: 24 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (raw) => {
      expect(parseMutantCap(raw)).toEqual({ ok: true, value: raw });
    }), { numRuns: 40 });
  });

  it("FR-012: a plan is built only within its cap and its candidates", () => {
    const site: Mutant = {
      id: "a".repeat(64), operator: "statement-removal", line: 5, column: 3, start: 116, end: 132, original: 'log("rejected");', replacement: ";",
    };
    const cap = capOf(1);
    expect(mutationPlanOf({ mutants: [site], candidates: 3, cap })).toEqual({ ok: true, value: { mutants: [site], candidates: 3, cap: 1 } });
    expect(mutationPlanOf({ mutants: [], candidates: 0, cap })).toEqual({ ok: true, value: { mutants: [], candidates: 0, cap: 1 } });
    expect(mutationPlanOf({ mutants: [site, { ...site, id: "b".repeat(64) }], candidates: 3, cap }))
      .toEqual({ ok: false, error: { kind: "mutants-exceed-cap", mutants: 2, cap: 1 } });
    expect(mutationPlanOf({ mutants: [site], candidates: 0, cap: capOf(24) }))
      .toEqual({ ok: false, error: { kind: "mutants-exceed-candidates", mutants: 1, candidates: 0 } });
    for (const candidates of [-1, 2.5, Number.NaN]) {
      expect(mutationPlanOf({ mutants: [], candidates, cap })).toEqual({ ok: false, error: { kind: "candidates-not-a-count", candidates } });
    }
  });

  // FR-010: the operator set is fixed by the engine. One row per construct: the
  // owner (every line changed) and the exact mutated lines it must produce.
  const SUPPORTED: readonly (readonly [string, string, readonly (readonly [MutationOperator, string])[]])[] = [
    ["if condition", "if (x) { }", [["condition-negation", "if (!(x)) { }"]]],
    ["while condition", "while (x) { }", [["condition-negation", "while (!(x)) { }"]]],
    ["do-while condition", "do { } while (x);", [["condition-negation", "do { } while (!(x));"]]],
    ["for condition", "for (; x; ) { }", [["condition-negation", "for (; !(x); ) { }"]]],
    ["conditional expression", "const v = x ? 1 : 2;", [["condition-negation", "const v = !(x) ? 1 : 2;"]]],
    ["< flips to >=", "const v = x < y;", [["comparison-flip", "const v = x >= y;"]]],
    [">= flips to <", "const v = x >= y;", [["comparison-flip", "const v = x < y;"]]],
    ["> flips to <=", "const v = x > y;", [["comparison-flip", "const v = x <= y;"]]],
    ["<= flips to >", "const v = x <= y;", [["comparison-flip", "const v = x > y;"]]],
    ["=== flips to !==", "const v = x === y;", [["comparison-flip", "const v = x !== y;"]]],
    ["!== flips to ===", "const v = x !== y;", [["comparison-flip", "const v = x === y;"]]],
    ["== flips to !=", "const v = x == y;", [["comparison-flip", "const v = x != y;"]]],
    ["!= flips to ==", "const v = x != y;", [["comparison-flip", "const v = x == y;"]]],
    ["&& swaps to ||", "const v = x && y;", [["logical-swap", "const v = x || y;"]]],
    ["|| swaps to &&", "const v = x || y;", [["logical-swap", "const v = x && y;"]]],
    ["true flips to false", "const v = true;", [["boolean-literal-flip", "const v = false;"]]],
    ["false flips to true", "const v = false;", [["boolean-literal-flip", "const v = true;"]]],
    ["a returned value becomes undefined", "function g() { return x; }", [["return-value-replacement", "function g() { return undefined; }"]]],
    ["an expression statement is removed", "g();", [["statement-removal", ";"]]],
    ["an assignment statement is removed", "x = 1;", [["statement-removal", ";"]]],
  ];

  const UNSUPPORTED: readonly (readonly [string, string])[] = [
    ["arithmetic", "const v = x + y;"],
    ["unary minus", "const v = -x;"],
    ["logical not", "const v = !x;"],
    ["nullish coalescing", "const v = x ?? y;"],
    ["string literal", 'const v = "text";'],
    ["numeric literal", "const v = 42;"],
    ["empty return", "function g() { return; }"],
    ["a return already undefined", "function g() { return undefined; }"],
    ["a prologue directive", '"use strict";'],
    ["a for loop without a condition", "for (;;) { break; }"],
    ["a declaration", "export interface Door { readonly open: string }"],
  ];

  it.each(SUPPORTED)("FR-010: AS-009: supported — %s", (_construct, text, expected) => {
    const plan = planOf(`${text}\n`, new Set([1]));
    expect(plan.mutants.map((mutant) => [mutant.operator, applyMutant(`${text}\n`, mutant).split("\n")[0]])).toEqual(expected);
  });

  it.each(UNSUPPORTED)("FR-010: AS-014: unsupported — %s generates no mutant", (_construct, text) => {
    expect(planOf(`${text}\n`, new Set([1]))).toEqual({ mutants: [], candidates: 0, cap: 24 });
  });

  it("FR-010: the operators the engine applies are exactly the fixed six", () => {
    const text = SUPPORTED.map(([, construct]) => construct).join("\n") + "\n";
    const plan = planOf(text, lines(1, SUPPORTED.length), 1_000);
    expect([...new Set(plan.mutants.map((mutant) => mutant.operator))].sort()).toEqual([
      "boolean-literal-flip", "comparison-flip", "condition-negation", "logical-swap", "return-value-replacement", "statement-removal",
    ]);
  });

  // Laws over generated owners: statements drawn from the supported and
  // unsupported tables, any changed-line subset, any cap.
  const owners = fc.array(fc.constantFrom(...SUPPORTED.map(([, text]) => text), ...UNSUPPORTED.map(([, text]) => text)), { minLength: 1, maxLength: 40 })
    .map((statements) => statements.join("\n") + "\n");
  const ownerInput = owners.chain((ownerText) => {
    const count = ownerText.split("\n").length - 1;
    return fc.record({
      ownerText: fc.constant(ownerText),
      changedLines: fc.subarray(Array.from({ length: count }, (_, index) => index + 1)).map((chosen) => new Set(chosen)),
      cap: fc.integer({ min: 1, max: 30 }),
    });
  });

  it("FR-011: FR-012: FR-017: laws — deterministic, confined to changed lines, capped, and each mutant changes one site", () => {
    fc.assert(fc.property(ownerInput, ({ ownerText, changedLines, cap: raw }) => {
      const cap = capOf(raw);
      const plan = planned({ ownerPath: OWNER, ownerText, changedLines, cap });
      expect(planned({ ownerPath: OWNER, ownerText, changedLines: new Set(changedLines), cap })).toEqual(plan);
      expect(plan.cap).toBe(raw);
      expect(plan.mutants.length).toBeLessThanOrEqual(raw);
      expect(plan.mutants.length).toBeLessThanOrEqual(plan.candidates);
      expect(unmutatedOf(plan)).toBe(Math.max(0, plan.candidates - raw));
      if (changedLines.size === 0) expect(plan.mutants).toEqual([]);
      for (const mutant of plan.mutants as readonly Mutant[]) {
        expect(changedLines.has(mutant.line)).toBe(true);
        const mutated = applyMutant(ownerText, mutant);
        expect(ownerText.slice(mutant.start, mutant.end)).toBe(mutant.original);
        expect(mutated).toBe(ownerText.slice(0, mutant.start) + mutant.replacement + ownerText.slice(mutant.end));
        expect(mutated).not.toBe(ownerText);
      }
    }), { numRuns: 60 });
  });
});

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

type Case = Readonly<{ classname: string; name: string; failure?: "AssertionError" | "Error" }>;

/** A Vitest-shaped JUnit report over `cases`, counts reconciled per file. */
function junit(cases: readonly Case[]): Uint8Array {
  const byFile = new Map<string, Case[]>();
  for (const testcase of cases) byFile.set(testcase.classname, [...(byFile.get(testcase.classname) ?? []), testcase]);
  const failures = (group: readonly Case[]) => group.filter((testcase) => testcase.failure !== undefined).length;
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const suites = [...byFile.entries()].map(([file, group]) => [
    `<testsuite name="${escape(file)}" tests="${group.length}" failures="${failures(group)}" errors="0" skipped="0">`,
    ...group.map((testcase) => `<testcase classname="${escape(testcase.classname)}" name="${escape(testcase.name)}">` +
      (testcase.failure === undefined ? "" : `<failure message="failed" type="${testcase.failure}">failed</failure>`) + "</testcase>"),
    "</testsuite>",
  ].join("\n"));
  return new TextEncoder().encode([
    '<?xml version="1.0" encoding="UTF-8" ?>',
    `<testsuites name="vitest tests" tests="${cases.length}" failures="${failures(cases)}" errors="0">`,
    ...suites,
    "</testsuites>",
  ].join("\n"));
}

const passing = (name: string): Case => ({ classname: MATRIX, name: `matrix > ${name}` });
const failing = (name: string): Case => ({ classname: MATRIX, name: `matrix > ${name}`, failure: "AssertionError" });
const COLLECTION_ERROR: Case = { classname: MATRIX, name: MATRIX, failure: "Error" };

const exited = (cases: readonly Case[] | null, exitCode: number | null = cases?.some((testcase) => testcase.failure) ? 1 : 0, signal: string | null = null): MatrixTestRun => ({
  kind: "exited",
  exitCode,
  signal,
  report: cases === null ? { kind: "missing" } : { kind: "produced", bytes: junit(cases) },
});

describe("outcome classification (CT-1)", () => {
  it("AS-010: a mutant whose report shows at least one failing testcase is killed", () => {
    expect(classifyMutantRun(exited([passing("admits members"), failing("refuses minors")]), MATRIX)).toEqual({ kind: "killed" });
    // A real failure beside a collection error still kills.
    expect(classifyMutantRun(exited([COLLECTION_ERROR, failing("refuses minors")]), MATRIX)).toEqual({ kind: "killed" });
  });

  it("AS-011: a mutant against which the matrix test passes survives", () => {
    expect(classifyMutantRun(exited([passing("admits members"), passing("refuses minors")]), MATRIX)).toEqual({ kind: "survived" });
  });

  it("AS-012: a mutant whose report shows only collection or import errors is invalid, neither killed nor survived", () => {
    expect(classifyMutantRun(exited([COLLECTION_ERROR]), MATRIX)).toEqual({ kind: "invalid", collectionErrors: [MATRIX] });
  });

  it("AS-013: a mutant whose run exceeded its time limit is killed by timeout", () => {
    expect(classifyMutantRun({ kind: "timed-out", elapsedMs: 60_000 }, MATRIX)).toEqual({ kind: "timed-out" });
  });

  const infrastructure = (kind: string) => ({ kind: "infrastructure", failure: { kind, detail: expect.any(String) } });

  // FR-013 / FR-016: the full table. Each row: the observation, the mutant's
  // outcome, and the baseline's.
  const TABLE: readonly (readonly [string, MatrixTestRun, unknown, unknown])[] = [
    ["process timed out", { kind: "timed-out", elapsedMs: 60_000 }, { kind: "timed-out" }, infrastructure("baseline-timed-out")],
    ["the runner could not start", { kind: "spawn-failed", message: "ENOENT" }, infrastructure("spawn-failed"), infrastructure("spawn-failed")],
    ["the report is missing", exited(null, 0), infrastructure("report-missing"), infrastructure("report-missing")],
    ["the report is unreadable", { kind: "exited", exitCode: 0, signal: null, report: { kind: "unreadable", reason: "EACCES" } }, infrastructure("report-unreadable"), infrastructure("report-unreadable")],
    ["the report does not parse", { kind: "exited", exitCode: 1, signal: null, report: { kind: "produced", bytes: new TextEncoder().encode("not a report") } }, infrastructure("report-unreadable"), infrastructure("report-unreadable")],
    ["a failing non-collection testcase", exited([failing("refuses minors")]), { kind: "killed" }, { kind: "red", failures: ["matrix > refuses minors"] }],
    ["only collection errors", exited([COLLECTION_ERROR]), { kind: "invalid", collectionErrors: [MATRIX] }, { kind: "red", failures: [MATRIX] }],
    ["no testcase of the matrix test", exited([{ classname: "tests/other.test.ts", name: "other > passes" }]), infrastructure("matrix-test-not-collected"), infrastructure("matrix-test-not-collected")],
    ["every testcase passes, exit 0", exited([passing("admits members")]), { kind: "survived" }, { kind: "green" }],
    ["every testcase passes, non-zero exit", exited([passing("admits members")], 1), infrastructure("exit-unexplained-by-report"), infrastructure("exit-unexplained-by-report")],
    ["every testcase passes, killed by a signal", exited([passing("admits members")], null, "SIGKILL"), infrastructure("exit-unexplained-by-report"), infrastructure("exit-unexplained-by-report")],
  ];

  it.each(TABLE)("FR-013: FR-016: %s", (_row, run, mutant, baseline) => {
    expect(classifyMutantRun(run, MATRIX)).toEqual(mutant);
    expect(classifyBaseline(run, MATRIX)).toEqual(baseline);
  });

  it("FR-013: FR-016: an empty report is infrastructure, never a kill", () => {
    const empty: MatrixTestRun = { kind: "exited", exitCode: 0, signal: null, report: { kind: "produced", bytes: junit([]) } };
    const outcome = classifyMutantRun(empty, MATRIX);
    expect(outcome.kind).toBe("infrastructure");
    if (outcome.kind === "infrastructure") expect(["report-unreadable", "matrix-test-not-collected"]).toContain(outcome.failure.kind);
    expect(classifyBaseline(empty, MATRIX).kind).toBe("infrastructure");
  });

  const SURVIVOR: SurvivorDiagnostic = {
    mutantId: "c".repeat(64), operator: "logical-swap", line: 2, column: 7, original: "age >= 18 && member", replacement: "age >= 18 || member",
  };
  const TALLY = { killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3, ownerChangedInWave: true } as const;

  it("FR-013: AS-013: a verified run derives `generated` from its tallies; a timed-out mutant is a kill counted in `timedOut` only", () => {
    expect(verifiedMutationOf(TALLY)).toEqual({ ok: true, value: { kind: "verified", generated: 9, ...TALLY } });
    expect(verifiedMutationOf({ ...TALLY, killed: 0, timedOut: 4, invalid: 0, survivors: [] }))
      .toEqual({ ok: true, value: { kind: "verified", generated: 4, killed: 0, timedOut: 4, invalid: 0, survivors: [], unmutated: 3, ownerChangedInWave: true } });
  });

  it("AS-014: an owner the Wave did not change verifies with zero mutants, and nothing else", () => {
    const unchanged = { killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false } as const;
    expect(verifiedMutationOf(unchanged)).toEqual({ ok: true, value: { kind: "verified", generated: 0, ...unchanged } });
    expect(verifiedMutationOf({ ...unchanged, killed: 1 }))
      .toEqual({ ok: false, error: { kind: "mutants-without-owner-change", generated: 1, unmutated: 0 } });
    expect(verifiedMutationOf({ ...unchanged, survivors: [SURVIVOR], unmutated: 2 }))
      .toEqual({ ok: false, error: { kind: "mutants-without-owner-change", generated: 1, unmutated: 2 } });
  });

  it.each([
    ["killed", -1], ["timedOut", 1.5], ["invalid", Number.NaN], ["unmutated", -3],
  ] as const)("FR-012: FR-013: a verified run refuses a %s of %s: every count is a non-negative integer", (field, value) => {
    expect(verifiedMutationOf({ ...TALLY, [field]: value })).toEqual({ ok: false, error: { kind: "count-not-a-count", field, value } });
  });

  it("FR-013: testcases of other files neither kill nor explain the matrix test", () => {
    const others: Case = { classname: "tests/other.test.ts", name: "other > fails", failure: "AssertionError" };
    expect(classifyMutantRun(exited([others, passing("admits members")], 0), MATRIX)).toEqual({ kind: "survived" });
    expect(classifyMutantRun(exited([others, failing("refuses minors")]), MATRIX)).toEqual({ kind: "killed" });
  });
});
