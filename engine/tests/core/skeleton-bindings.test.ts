/**
 * Unit and property tests for the `**Export bindings:**` plan grammar (AD-3):
 * `parseIdentifier`, `parseContractId`, `parseExportBindings`, `validateExportBindings`,
 * `renderExportBinding`, `bindingStampAgreement` and `renderBindingProblem`.
 * Every malformed shape and every graph-shape refusal is decided here; the
 * parse ∘ render round-trip is a property.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PlanContract } from "../../src/core/acceptance-contract";
import { parsePlanExportBindings, parsePlanModels } from "../../src/core/parse-plan-models";
import { checkPlanModelBindings, validateModelBindings, type ModelBindingDeps } from "../../src/handlers/helpers/validate-model-bindings";
import {
  bindingStampAgreement,
  parseContractId,
  parseExportBindings,
  parseIdentifier,
  renderBindingProblem,
  renderExportBinding,
  validateExportBindings,
} from "../../src/core/skeleton/bindings";
import type { BindingProblem, BindingTaskView, ExportBinding, Identifier } from "../../src/core/skeleton/types";

const TYPES = "src/order/order-contract.ts";
const ACCEPTANCE = "tests/order.acceptance.test.ts";
const OTHER_TYPES = "src/billing/billing-contract.ts";
const OTHER_ACCEPTANCE = "tests/billing.acceptance.test.ts";
const NO_TYPES_ACCEPTANCE = "tests/cli.acceptance.test.ts";

const id = (raw: string): Identifier => {
  const parsed = parseIdentifier(raw);
  if (!parsed.ok) throw new Error(`fixture identifier ${raw}: ${parsed.error}`);
  return parsed.value;
};

const binding = (path: string, contract: string, ...exports: readonly [string, string][]): ExportBinding => {
  const [first, ...rest] = exports.map(([name, alias]) => ({ name: id(name), alias: id(alias) }));
  if (first === undefined) throw new Error("fixture binding needs an export");
  return { path, contract, exports: [first, ...rest] };
};

const contract = (contractId: string, typesPath: string | null, acceptancePath: string): PlanContract => ({
  id: contractId,
  title: `${contractId} contract`,
  declaration: {
    kind: "declared",
    types: typesPath === null ? { kind: "none", reason: "a CLI contract" } : { kind: "file", path: typesPath },
    acceptance: [{ path: acceptancePath, anchors: ["AS-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: `${contractId} statement`,
  },
});

const CONTRACTS: readonly PlanContract[] = [
  contract("CT-1", TYPES, ACCEPTANCE),
  contract("CT-2", OTHER_TYPES, OTHER_ACCEPTANCE),
  contract("CT-3", null, NO_TYPES_ACCEPTANCE),
  { id: "CT-4", title: "broken", declaration: { kind: "malformed", problems: [{ kind: "missing-statement" }] } },
];

const task = (taskId: string, file_list: readonly string[], depends_on: readonly string[] = [], regressionWaiver: BindingTaskView["regressionWaiver"] = null): BindingTaskView =>
  ({ id: taskId, file_list, depends_on, regressionWaiver });

const TASKS: readonly BindingTaskView[] = [
  task("T1", [TYPES, ACCEPTANCE, "src/order/stub-on-contract.ts"]),
  task("T2", [OTHER_TYPES, OTHER_ACCEPTANCE]),
  task("T3", ["src/order/pricing.ts"], ["T1", "T9"]),
  task("T4", ["src/order/late.ts"], ["T3"]),
  task("T5", ["src/order/early.ts"], ["T2"]),
  task("T6", ["src/order/docs.ts"], ["T1"], "documentation-only"),
  task("T7", ["src/order/generated.ts"], ["T1"], "generated-artifact"),
  task("T8", ["src/order/red-window.ts"], ["T1"], "acceptance-red-window"),
  task("T9", [NO_TYPES_ACCEPTANCE]),
  task("T10", ["src/order/Pricing.rs"], ["T1"]),
];

const section = (...lines: readonly string[]): string => `## File Structure

### Pricing (T3, Wave 2)

\`\`\`
src/order/pricing.ts   — NEW pricing
\`\`\`

**Export bindings:**
${lines.join("\n")}
`;

const parse = (...lines: readonly string[]) => parseExportBindings(section(...lines));
const validate = (...lines: readonly string[]): readonly BindingProblem[] =>
  validateExportBindings(parse(...lines), CONTRACTS, TASKS);

describe("parseIdentifier", () => {
  it("mints identifiers that match the grammar", () => {
    for (const raw of ["priceOrder", "_x", "PriceOrderFn", "a1_B2"]) {
      expect(parseIdentifier(raw)).toEqual({ ok: true, value: raw });
    }
  });

  it("refuses tokens outside ^[A-Za-z_][A-Za-z0-9_]*$", () => {
    for (const raw of ["", "1abc", "price-order", "a b", "$x", "a.b", "priceOrder;", "é"]) {
      expect(parseIdentifier(raw)).toEqual({ ok: false, error: "invalid-identifier" });
    }
  });

  it("refuses reserved words of TypeScript and Java from one fixed list", () => {
    for (const raw of ["class", "function", "const", "export", "import", "public", "static", "final", "int", "boolean", "synchronized", "var", "record", "_", "await", "yield"]) {
      expect(parseIdentifier(raw)).toEqual({ ok: false, error: "reserved-word" });
    }
  });

  it("is a fixed point: every accepted identifier re-parses to itself", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/), (raw) => {
      const first = parseIdentifier(raw);
      if (!first.ok) return first.error === "reserved-word";
      return JSON.stringify(parseIdentifier(first.value)) === JSON.stringify(first);
    }));
  });
});

describe("parseContractId", () => {
  it("mints CT-<digits> contract ids", () => {
    for (const raw of ["CT-1", "CT-42", "CT-007"]) expect(parseContractId(raw)).toEqual({ ok: true, value: raw });
  });

  it("refuses every other token", () => {
    for (const raw of ["", "CT-", "ct-1", "CT1", "CT-1a", " CT-1", "CT-1 ", "CT--1", "XT-1"]) {
      expect(parseContractId(raw), raw).toEqual({ ok: false, error: "invalid-contract-id" });
    }
  });

  it("is a fixed point over the contract-id shape", () => {
    fc.assert(fc.property(fc.stringMatching(/^CT-\d{1,4}$/), (raw) => {
      expect(parseContractId(raw)).toEqual({ ok: true, value: raw });
    }));
  });
});

describe("parseExportBindings — grammar", () => {
  it("AS-001: records parseOrder: ParseOrderFn and priceOrder: PriceOrderFn against the file", () => {
    expect(parse("- `src/order/pricing.ts` — CT-1: parseOrder: ParseOrderFn, priceOrder: PriceOrderFn")).toEqual({
      bindings: [binding("src/order/pricing.ts", "CT-1", ["parseOrder", "ParseOrderFn"], ["priceOrder", "PriceOrderFn"])],
      problems: [],
    });
  });

  it("reads every Export bindings label in the section, in plan order, and accepts en dash and hyphen separators", () => {
    const text = `## File Structure

\`\`\`
src/a.ts — NEW
\`\`\`

**Export bindings:**

- \`src/a.ts\` – CT-1: a: AFn
- \`./src/b.ts\` - CT-2: b: BFn

### Second group

\`\`\`
src/c.ts — NEW
\`\`\`

**Export bindings:**
- \`src/c.ts\` — CT-1: c: CFn,d: DFn
`;
    expect(parseExportBindings(text)).toEqual({
      bindings: [
        binding("src/a.ts", "CT-1", ["a", "AFn"]),
        binding("src/b.ts", "CT-2", ["b", "BFn"]),
        binding("src/c.ts", "CT-1", ["c", "CFn"], ["d", "DFn"]),
      ],
      problems: [],
    });
  });

  it("ignores a label quoted inside a fence and an empty section", () => {
    expect(parseExportBindings("## File Structure\n\n```\n**Export bindings:**\n- `src/a.ts` — CT-1: a: AFn\n```\n")).toEqual({ bindings: [], problems: [] });
    expect(parseExportBindings("")).toEqual({ bindings: [], problems: [] });
  });

  it("stops the list at the first line that is not an item", () => {
    expect(parseExportBindings(`**Export bindings:**
- \`src/a.ts\` — CT-1: a: AFn
Prose after the list.
- \`src/b.ts\` — CT-1: b: BFn
`).bindings).toEqual([binding("src/a.ts", "CT-1", ["a", "AFn"])]);
  });

  it("AS-005: a missing name, a missing alias and a repeated export name are refused, naming the file and the entry", () => {
    const line = "- `src/order/pricing.ts` — CT-1: : PriceOrderFn";
    expect(parse(line)).toEqual({ bindings: [], problems: [{ kind: "malformed-entry", path: "src/order/pricing.ts", line, reason: "missing-name" }] });
    const noAlias = "- `src/order/pricing.ts` — CT-1: priceOrder:";
    expect(parse(noAlias).problems).toEqual([{ kind: "malformed-entry", path: "src/order/pricing.ts", line: noAlias, reason: "missing-alias" }]);
    const bare = "- `src/order/pricing.ts` — CT-1: priceOrder";
    expect(parse(bare).problems).toEqual([{ kind: "malformed-entry", path: "src/order/pricing.ts", line: bare, reason: "missing-alias" }]);
    const duplicate = "- `src/order/pricing.ts` — CT-1: priceOrder: PriceOrderFn, priceOrder: ParseOrderFn";
    expect(parse(duplicate)).toEqual({ bindings: [], problems: [{ kind: "duplicate-name", path: "src/order/pricing.ts", name: "priceOrder" }] });
  });

  it("refuses an export name equal to an alias on its line, naming the file and the name", () => {
    const self = "- `src/a.ts` — CT-1: PriceOrderFn: PriceOrderFn";
    expect(parse(self)).toEqual({ bindings: [], problems: [{ kind: "name-collides-with-alias", path: "src/a.ts", name: "PriceOrderFn" }] });
    const crossed = "- `src/a.ts` — CT-1: a: BFn, BFn: CFn, CFn: AFn";
    expect(parse(crossed)).toEqual({
      bindings: [],
      problems: [
        { kind: "name-collides-with-alias", path: "src/a.ts", name: "BFn" },
        { kind: "name-collides-with-alias", path: "src/a.ts", name: "CFn" },
      ],
    });
    // Another line's alias is in another file's scope: no collision.
    expect(parse("- `src/a.ts` — CT-1: a: BFn", "- `src/b.ts` — CT-1: BFn: CFn").problems).toEqual([]);
    expect(validate(self)).toContainEqual({ kind: "name-collides-with-alias", path: "src/a.ts", name: "PriceOrderFn" });
  });

  it("names every malformed shape with its reason", () => {
    const cases: readonly [string, BindingProblem][] = [
      ["- src/a.ts — CT-1: a: AFn", { kind: "malformed-entry", path: null, line: "- src/a.ts — CT-1: a: AFn", reason: "not-a-binding-line" }],
      ["- `` — CT-1: a: AFn", { kind: "malformed-entry", path: null, line: "- `` — CT-1: a: AFn", reason: "not-a-binding-line" }],
      ["- `src/a.ts` CT-1: a: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` CT-1: a: AFn", reason: "not-a-binding-line" }],
      ["- `src/a.ts`", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts`", reason: "missing-contract" }],
      ["- `src/a.ts` — a: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — a: AFn", reason: "missing-contract" }],
      ["- `src/a.ts` — ct-1: a: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — ct-1: a: AFn", reason: "missing-contract" }],
      ["- `src/a.ts` — CT-1x: a: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1x: a: AFn", reason: "missing-contract" }],
      ["- `src/a.ts` — CT-1 a: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1 a: AFn", reason: "missing-contract" }],
      ["- `src/a.ts` — CT-1", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1", reason: "empty-exports" }],
      ["- `src/a.ts` — CT-1:", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1:", reason: "empty-exports" }],
      ["- `src/a.ts` — CT-1: a: AFn,", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: a: AFn,", reason: "missing-name" }],
      ["- `src/a.ts` — CT-1: a-b: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: a-b: AFn", reason: "invalid-identifier" }],
      ["- `src/a.ts` — CT-1: a: A.Fn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: a: A.Fn", reason: "invalid-identifier" }],
      ["- `src/a.ts` — CT-1: a: B: C", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: a: B: C", reason: "invalid-identifier" }],
      ["- `src/a.ts` — CT-1: class: AFn", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: class: AFn", reason: "reserved-word" }],
      ["- `src/a.ts` — CT-1: a: interface", { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: a: interface", reason: "reserved-word" }],
    ];
    for (const [line, problem] of cases) {
      expect(parse(line), line).toEqual({ bindings: [], problems: [problem] });
    }
  });

  it("names each distinct reason of one line once, and keeps the well-formed lines", () => {
    const line = "- `src/a.ts` — CT-1: a-b: AFn, c-d: CFn, class: X";
    expect(parse(line, "- `src/b.ts` — CT-1: b: BFn")).toEqual({
      bindings: [binding("src/b.ts", "CT-1", ["b", "BFn"])],
      problems: [
        { kind: "malformed-entry", path: "src/a.ts", line, reason: "invalid-identifier" },
        { kind: "malformed-entry", path: "src/a.ts", line, reason: "reserved-word" },
      ],
    });
  });

  it("refuses a label with no items or a value on the label line", () => {
    expect(parseExportBindings("**Export bindings:**\n\nProse.\n").problems)
      .toEqual([{ kind: "malformed-entry", path: null, line: "**Export bindings:**", reason: "not-a-binding-line" }]);
    expect(parseExportBindings("**Export bindings:** - `src/a.ts` — CT-1: a: AFn\n").problems)
      .toEqual([{ kind: "malformed-entry", path: null, line: "**Export bindings:** - `src/a.ts` — CT-1: a: AFn", reason: "not-a-binding-line" }]);
  });

  it("AS-004: a path on lines of two contracts is multi-contract, naming both; on two lines of one contract a duplicate", () => {
    expect(parse("- `src/a.ts` — CT-2: a: AFn", "- `src/a.ts` — CT-1: b: BFn")).toEqual({
      bindings: [],
      problems: [{ kind: "multi-contract", path: "src/a.ts", contracts: ["CT-2", "CT-1"] }],
    });
    expect(parse("- `src/a.ts` — CT-1: a: AFn", "- `src/a.ts` — CT-1: b: BFn")).toEqual({
      bindings: [],
      problems: [{ kind: "duplicate-path", path: "src/a.ts", contract: "CT-1" }],
    });
    expect(parse("- `src/a.ts` — CT-1: a: AFn", "- `./src/a.ts` — CT-2: b: BFn", "- `src/a.ts` — CT-1: c: CFn").problems).toEqual([
      { kind: "multi-contract", path: "src/a.ts", contracts: ["CT-1", "CT-2"] },
      { kind: "duplicate-path", path: "src/a.ts", contract: "CT-1" },
    ]);
  });

  it("counts a malformed line's contract toward its path's contracts", () => {
    expect(parse("- `src/a.ts` — CT-1: a: AFn", "- `src/a.ts` — CT-2: b-c: BFn").problems).toEqual([
      { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-2: b-c: BFn", reason: "invalid-identifier" },
      { kind: "multi-contract", path: "src/a.ts", contracts: ["CT-1", "CT-2"] },
    ]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseExportBindings("**Export bindings:**\r\n- `src/a.ts` — CT-1: a: AFn\r\n").bindings)
      .toEqual([binding("src/a.ts", "CT-1", ["a", "AFn"])]);
  });
});

describe("validateExportBindings — FR-002 refusals", () => {
  it("AS-001: accepts a binding held by a Task that depends on the contract Task", () => {
    expect(validate("- `src/order/pricing.ts` — CT-1: parseOrder: ParseOrderFn, priceOrder: PriceOrderFn")).toEqual([]);
  });

  it("accepts a holder that reaches the contract Task transitively, and a bound path in an unsupported language", () => {
    expect(validate("- `src/order/late.ts` — CT-1: a: AFn")).toEqual([]);
    expect(validate("- `src/order/Pricing.rs` — CT-1: a: AFn")).toEqual([]);
    expect(validate("- `src/order/red-window.ts` — CT-1: a: AFn")).toEqual([]);
  });

  it("AS-002: refuses a path outside the repository or otherwise unsafe, naming the file", () => {
    for (const path of ["../outside.ts", "/etc/pricing.ts", "src/../../x.ts", "C:/x.ts"]) {
      expect(validate(`- \`${path}\` — CT-1: a: AFn`), path).toContainEqual({ kind: "unsafe-path", path });
    }
  });

  it("AS-003: refuses a frozen path of any declared contract, naming that contract", () => {
    expect(validate(`- \`${TYPES}\` — CT-1: a: AFn`)).toContainEqual({ kind: "frozen-path", path: TYPES, contract: "CT-1" });
    expect(validate(`- \`${ACCEPTANCE}\` — CT-1: a: AFn`)).toContainEqual({ kind: "frozen-path", path: ACCEPTANCE, contract: "CT-1" });
    expect(validate(`- \`${OTHER_ACCEPTANCE}\` — CT-1: a: AFn`)).toContainEqual({ kind: "frozen-path", path: OTHER_ACCEPTANCE, contract: "CT-2" });
    expect(validate(`- \`${NO_TYPES_ACCEPTANCE}\` — CT-1: a: AFn`)).toContainEqual({ kind: "frozen-path", path: NO_TYPES_ACCEPTANCE, contract: "CT-3" });
  });

  it("AS-004: refuses one file bound by two contracts, naming the file and both contracts", () => {
    expect(validate("- `src/order/pricing.ts` — CT-1: a: AFn", "- `src/order/pricing.ts` — CT-2: b: BFn"))
      .toEqual([{ kind: "multi-contract", path: "src/order/pricing.ts", contracts: ["CT-1", "CT-2"] }]);
  });

  it("AS-005: reports every parse-time problem it receives", () => {
    expect(validate("- `src/order/pricing.ts` — CT-1: : AFn")).toEqual([
      { kind: "malformed-entry", path: "src/order/pricing.ts", line: "- `src/order/pricing.ts` — CT-1: : AFn", reason: "missing-name" },
    ]);
  });

  it("refuses an unknown contract and a contract that declares no types file", () => {
    expect(validate("- `src/order/pricing.ts` — CT-9: a: AFn")).toEqual([{ kind: "unknown-contract", path: "src/order/pricing.ts", contract: "CT-9" }]);
    expect(validate("- `src/order/pricing.ts` — CT-3: a: AFn")).toEqual([{ kind: "contract-without-types", path: "src/order/pricing.ts", contract: "CT-3" }]);
  });

  it("leaves a malformed contract to contract validation", () => {
    expect(validate("- `src/order/pricing.ts` — CT-4: a: AFn")).toEqual([]);
  });

  it("refuses a bound path on the contract Task's own file_list", () => {
    expect(validate("- `src/order/stub-on-contract.ts` — CT-1: a: AFn")).toEqual([
      { kind: "bound-on-contract-task", path: "src/order/stub-on-contract.ts", contract: "CT-1", task: "T1" },
      { kind: "unheld-path", path: "src/order/stub-on-contract.ts" },
    ]);
  });

  it("refuses a bound path no non-contract Task holds", () => {
    expect(validate("- `src/order/nowhere.ts` — CT-1: a: AFn")).toEqual([{ kind: "unheld-path", path: "src/order/nowhere.ts" }]);
    // Exact match only: a deeper path that merely ends in the bound path holds nothing.
    expect(validate("- `order/pricing.ts` — CT-1: a: AFn")).toEqual([{ kind: "unheld-path", path: "order/pricing.ts" }]);
  });

  it("refuses a holder that does not depend on the contract Task, directly or transitively", () => {
    expect(validate("- `src/order/early.ts` — CT-1: a: AFn"))
      .toEqual([{ kind: "holder-not-after-contract", path: "src/order/early.ts", task: "T5", contractTask: "T1" }]);
  });

  it("refuses a bound path on a documentation-only or generated-artifact waived Task", () => {
    expect(validate("- `src/order/docs.ts` — CT-1: a: AFn"))
      .toEqual([{ kind: "bound-on-waived-task", path: "src/order/docs.ts", task: "T6", reason: "documentation-only" }]);
    expect(validate("- `src/order/generated.ts` — CT-1: a: AFn"))
      .toEqual([{ kind: "bound-on-waived-task", path: "src/order/generated.ts", task: "T7", reason: "generated-artifact" }]);
  });

  it("names every problem of every binding in plan order", () => {
    expect(validate(
      "- `src/order/early.ts` — CT-1: a: AFn",
      "- `src/order/docs.ts` — CT-9: b: BFn",
      "- `src/x.ts` — CT-1: c-d: CFn",
    )).toEqual([
      { kind: "malformed-entry", path: "src/x.ts", line: "- `src/x.ts` — CT-1: c-d: CFn", reason: "invalid-identifier" },
      { kind: "holder-not-after-contract", path: "src/order/early.ts", task: "T5", contractTask: "T1" },
      { kind: "unknown-contract", path: "src/order/docs.ts", contract: "CT-9" },
      { kind: "bound-on-waived-task", path: "src/order/docs.ts", task: "T6", reason: "documentation-only" },
    ]);
  });
});

describe("renderBindingProblem", () => {
  const problems: readonly BindingProblem[] = [
    { kind: "unsafe-path", path: "../x.ts" },
    { kind: "frozen-path", path: TYPES, contract: "CT-1" },
    { kind: "malformed-entry", path: "src/a.ts", line: "- `src/a.ts` — CT-1: : AFn", reason: "missing-name" },
    { kind: "malformed-entry", path: null, line: "- src/a.ts", reason: "not-a-binding-line" },
    { kind: "duplicate-name", path: "src/a.ts", name: "a" },
    { kind: "name-collides-with-alias", path: "src/a.ts", name: "AFn" },
    { kind: "duplicate-path", path: "src/a.ts", contract: "CT-1" },
    { kind: "multi-contract", path: "src/a.ts", contracts: ["CT-1", "CT-2"] },
    { kind: "unknown-contract", path: "src/a.ts", contract: "CT-9" },
    { kind: "contract-without-types", path: "src/a.ts", contract: "CT-3" },
    { kind: "bound-on-contract-task", path: "src/a.ts", contract: "CT-1", task: "T1" },
    { kind: "unheld-path", path: "src/a.ts" },
    { kind: "holder-not-after-contract", path: "src/a.ts", task: "T5", contractTask: "T1" },
    { kind: "bound-on-waived-task", path: "src/a.ts", task: "T6", reason: "documentation-only" },
  ];

  it("FR-002: names the file and the reason of every refusal", () => {
    for (const problem of problems) {
      if (problem.path !== null) expect(renderBindingProblem(problem), problem.kind).toContain(`'${problem.path}'`);
    }
    expect(renderBindingProblem(problems[2]!)).toContain("missing its export name");
    expect(renderBindingProblem(problems[3]!)).toContain("'- src/a.ts'");
    expect(renderBindingProblem(problems[5]!)).toContain("'AFn'");
    expect(renderBindingProblem(problems[7]!)).toContain("CT-1 and CT-2");
    expect(renderBindingProblem(problems[12]!)).toContain("T5");
    expect(renderBindingProblem(problems[12]!)).toContain("T1");
    expect(new Set(problems.map(renderBindingProblem)).size).toBe(problems.length);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const identifierArb: fc.Arbitrary<Identifier> = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/)
  .map((raw) => parseIdentifier(raw))
  .filter((parsed): parsed is { ok: true; value: Identifier } => parsed.ok)
  .map((parsed) => parsed.value);

const pathArb = fc.tuple(
  fc.array(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), { minLength: 1, maxLength: 4 }),
  fc.constantFrom(".ts", ".tsx", ".java", ".rs"),
).map(([segments, ext]) => `${segments.join("/")}${ext}`);

/** One line's exports: distinct names, none equal to an alias of the line. */
const exportsArb = fc.uniqueArray(fc.record({ name: identifierArb, alias: identifierArb }), { minLength: 1, maxLength: 5, selector: ({ name }) => name })
  .filter((exports) => !exports.some(({ name }) => exports.some(({ alias }) => alias === name)));

const bindingsArb: fc.Arbitrary<readonly ExportBinding[]> = fc.uniqueArray(
  fc.record({
    path: pathArb,
    contract: fc.integer({ min: 1, max: 99 }).map((n) => `CT-${n}`),
    exports: exportsArb,
  }),
  { minLength: 1, maxLength: 6, selector: ({ path }) => path },
).map((records) => records.map(({ path, contract: ct, exports }) => ({ path, contract: ct, exports: [exports[0]!, ...exports.slice(1)] as const })));

describe("properties", () => {
  it("parse ∘ render is the identity on well-formed bindings", () => {
    fc.assert(fc.property(bindingsArb, (bindings) => {
      const text = `## File Structure\n\n**Export bindings:**\n${bindings.map(renderExportBinding).join("\n")}\n`;
      expect(parseExportBindings(text)).toEqual({ bindings, problems: [] });
    }));
  });

  it("refuses exactly the names a line shares with its aliases", () => {
    const entriesArb = fc.uniqueArray(fc.record({ name: identifierArb, alias: identifierArb }), { minLength: 1, maxLength: 5, selector: ({ name }) => name });
    fc.assert(fc.property(entriesArb, (entries) => {
      const line = `- \`src/a.ts\` — CT-1: ${entries.map(({ name, alias }) => `${name}: ${alias}`).join(", ")}`;
      const aliases = new Set<string>(entries.map(({ alias }) => alias));
      const shared = entries.map(({ name }) => name).filter((name) => aliases.has(name));
      const parsed = parse(line);
      expect(parsed.problems).toEqual(shared.map((name) => ({ kind: "name-collides-with-alias", path: "src/a.ts", name })));
      expect(parsed.bindings).toHaveLength(shared.length === 0 ? 1 : 0);
    }));
  });

  it("parsing is total and deterministic over arbitrary text", () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.string(), fc.constant("**Export bindings:**"), fc.constant("- `a.ts` — CT-1: a: B"))), (lines) => {
      const text = lines.join("\n");
      expect(parseExportBindings(text)).toEqual(parseExportBindings(text));
    }));
  });

  it("bindingStampAgreement accepts exactly an equal stamp", () => {
    fc.assert(fc.property(bindingsArb, bindingsArb, (plan, stamp) => {
      const agreement = bindingStampAgreement(plan, stamp);
      const equal = JSON.stringify(plan) === JSON.stringify(stamp);
      expect(agreement.ok).toBe(equal);
      expect(bindingStampAgreement(plan, plan)).toEqual({ ok: true, value: null });
    }));
  });
});

describe("bindingStampAgreement", () => {
  it("names each binding the plan adds and the stamp holds that the plan no longer does", () => {
    const kept = binding("src/a.ts", "CT-1", ["a", "AFn"]);
    const added = binding("src/b.ts", "CT-1", ["b", "BFn"]);
    const dropped = binding("src/c.ts", "CT-2", ["c", "CFn"]);
    const result = bindingStampAgreement([kept, added], [kept, dropped]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(renderExportBinding(added));
    expect(result.error).toContain(renderExportBinding(dropped));
    expect(result.error).not.toContain(renderExportBinding(kept));
  });

  it("treats a reordering as drift", () => {
    const a = binding("src/a.ts", "CT-1", ["a", "AFn"]);
    const b = binding("src/b.ts", "CT-1", ["b", "BFn"]);
    const result = bindingStampAgreement([a, b], [b, a]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("order");
  });
});

// ---------------------------------------------------------------------------
// Plan validation: validateModelBindings runs validateExportBindings
// ---------------------------------------------------------------------------

describe("validateModelBindings — export bindings refuse the plan", () => {
  const NO_FILES: ModelBindingDeps = {
    readFile: (path) => ({ ok: false, error: `ENOENT: ${path}` }),
    pathPresence: () => ({ kind: "absent" }),
  };

  const PLAN = (bindingLine: string): string => `# Plan

## Contracts

### CT-1: Orders

**Types file:** \`${TYPES}\`
**Acceptance tests:**
- \`${ACCEPTANCE}\` — AS-001
**Statement:** orders price.

## File Structure

\`\`\`
src/order/pricing.ts — NEW
\`\`\`

**Export bindings:**
${bindingLine}
`;

  const ROSTER = [
    { id: "T1", wave: 1, file_list: [TYPES, ACCEPTANCE], depends_on: [], spec_anchors: [] },
    { id: "T2", wave: 2, file_list: ["src/order/pricing.ts"], depends_on: ["T1"], spec_anchors: ["AS-001"] },
    {
      id: "T3", wave: 2, file_list: ["src/order/docs.ts"], depends_on: ["T1"], spec_anchors: [],
      verification_policy: { regression: { kind: "waived", reason: "documentation-only" }, new_tests: { kind: "waived", reason: "documentation-only" } },
    },
  ];

  const errorsFor = (bindingLine: string): readonly string[] => {
    const plan = PLAN(bindingLine);
    const result = validateModelBindings(parsePlanModels(plan), ROSTER, NO_FILES, parsePlanExportBindings(plan));
    return result.ok ? [] : result.errors;
  };

  /** The fail-closed entry point over one plan text. */
  const check = (plan: string, roster: readonly Record<string, unknown>[] = ROSTER) =>
    checkPlanModelBindings("plan.md", roster, {
      ...NO_FILES,
      readFile: (path) => (path === "plan.md" ? { ok: true, content: plan } : { ok: false, error: `ENOENT: ${path}` }),
    });

  it("AS-001: the fail-closed check validates a plan whose only model is its export bindings", () => {
    const plan = "# Plan\n\n## File Structure\n\n**Export bindings:**\n- `src/order/pricing.ts` — CT-1: a: AFn\n";
    const errors = check(plan);
    // CT-1 is undeclared in this plan, so the binding is refused: bindings alone opt the plan in.
    expect(errors).toMatchObject({ ok: false, kind: "invalid-bindings" });
    expect(check(PLAN("- `src/order/pricing.ts` — CT-1: parseOrder: ParseOrderFn"))).toMatchObject({ ok: true, kind: "validated" });
  });

  it("AS-005: the fail-closed check refuses a plan whose only binding line is malformed", () => {
    const line = "- `src/order/pricing.ts` — CT-1: priceOrder";
    const result = check(`# Plan\n\n## File Structure\n\n**Export bindings:**\n${line}\n`);
    expect(result).toMatchObject({ ok: false, kind: "invalid-bindings" });
    expect(result.ok ? [] : result.errors).toContainEqual(
      `Export bindings: ${renderBindingProblem({ kind: "malformed-entry", path: "src/order/pricing.ts", line, reason: "missing-alias" })}`);
  });

  it("a plan without export bindings validates exactly as it did before the grammar", () => {
    const plan = "# Plan\n\n## Summary\n\nNothing.\n";
    expect(check(plan, [])).toMatchObject({ ok: true, kind: "opted-out" });
    expect(validateModelBindings(parsePlanModels(plan), [], NO_FILES)).toEqual(
      validateModelBindings(parsePlanModels(plan), [], NO_FILES, parsePlanExportBindings(plan)));
  });

  it("AS-001: accepts a plan whose bindings validate", () => {
    expect(errorsFor("- `src/order/pricing.ts` — CT-1: parseOrder: ParseOrderFn, priceOrder: PriceOrderFn")).toEqual([]);
  });

  it("AS-002: refuses an unsafe path, naming the file and the reason", () => {
    expect(errorsFor("- `../outside.ts` — CT-1: a: AFn")).toContainEqual(
      `Export bindings: ${renderBindingProblem({ kind: "unsafe-path", path: "../outside.ts" })}`);
  });

  it("AS-003: refuses a frozen path, naming the path", () => {
    expect(errorsFor(`- \`${ACCEPTANCE}\` — CT-1: a: AFn`)).toContainEqual(
      `Export bindings: ${renderBindingProblem({ kind: "frozen-path", path: ACCEPTANCE, contract: "CT-1" })}`);
  });

  it("AS-004: refuses a file bound by two contracts, naming the file and both contracts", () => {
    const errors = errorsFor("- `src/order/pricing.ts` — CT-1: a: AFn\n- `src/order/pricing.ts` — CT-2: b: BFn");
    expect(errors.some((error) => error.includes("'src/order/pricing.ts'") && error.includes("CT-1 and CT-2"))).toBe(true);
  });

  it("AS-005: refuses a malformed entry, naming the file and the entry", () => {
    const line = "- `src/order/pricing.ts` — CT-1: priceOrder";
    expect(errorsFor(line)).toContainEqual(
      `Export bindings: ${renderBindingProblem({ kind: "malformed-entry", path: "src/order/pricing.ts", line, reason: "missing-alias" })}`);
  });

  it("reads the regression waiver through the verification policy", () => {
    expect(errorsFor("- `src/order/docs.ts` — CT-1: a: AFn")).toContainEqual(
      `Export bindings: ${renderBindingProblem({ kind: "bound-on-waived-task", path: "src/order/docs.ts", task: "T3", reason: "documentation-only" })}`);
  });
});
