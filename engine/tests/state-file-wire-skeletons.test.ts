/**
 * T10 / AD-4: the State File wire proves the three G2 fields before any
 * reader selects from them.
 *
 * - `export_bindings` — the population stamp, in plan order: each binding an
 *   exact record naming a repository-relative path once, a stamped contract
 *   that freezes a types file, and a non-empty list of distinct, validated
 *   identifiers.
 * - `skeletons` — the engine-written skeleton records (FR-031), sorted by
 *   path with no path twice: each names a bound path and its binding's
 *   contract, the path's own skeleton language, an origin, two lowercase
 *   SHA-256 digests and a stale flag.
 * - `tasks[].skeleton_outcomes` — one outcome ADT per distinct file_list path,
 *   each agreeing with the stamp and the records: a `skeleton-written` path
 *   has its record, an `unsupported-language` one is bound and unsupported
 *   for exactly that reason, and an unbound outcome's path is unbound.
 *
 * A graph populated before G2 carries none of them and loads unchanged.
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph, type ParsedTaskGraph } from "../src/state-file-wire";
import { parseAuthoredTaskRoster, populateTaskGraph, type AuthoredTask } from "../src/core/task-graph-population";
import { defaultVerificationManifest } from "../src/core/verification-manifest";
import type { PlanContract } from "../src/types";
import { indexedSpec } from "./fixtures/spec-index-fixture";

const TYPES_FILE = "src/order/order-contract.ts";
const ACCEPTANCE = "tests/order.acceptance.test.ts";
const PRICING = "src/order/pricing.ts";
const QUOTES = "src/order/quotes.ts";
const HELPERS = "src/order/helpers.ts";
const RATES = "src/order/rates.py";
const JAVA_PRICING = "src/main/java/com/acme/order/Pricing.java";

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Order contract",
  declaration: {
    kind: "declared",
    types: { kind: "file", path: TYPES_FILE },
    acceptance: [{ path: ACCEPTANCE, anchors: ["FR-001"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: "Orders are priced.",
  },
};

const TYPELESS: PlanContract = {
  id: "CT-2",
  title: "Audit contract",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "the audit slice consumes no shared surface" },
    acceptance: [{ path: "tests/audit.acceptance.test.ts", anchors: ["FR-002"] }],
    supportedDomain: null,
    entryPoint: null,
    statement: "Audits are logged.",
  },
};

const task = (id: string, wave: number, overrides: Partial<AuthoredTask> = {}): AuthoredTask => ({
  id,
  description: `task ${id}`,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  file_list: [`src/${id}.ts`],
  ...overrides,
});

/** A graph exactly as population writes it before G2: a types-file contract
 *  (T1), a typeless contract (T3), and an implementation Task T2. */
function preG2Graph(): Record<string, unknown> {
  const roster = parseAuthoredTaskRoster([
    task("T1", 1, { file_list: [TYPES_FILE, ACCEPTANCE] }),
    task("T3", 1, { file_list: ["tests/audit.acceptance.test.ts"] }),
    task("T2", 2, {
      depends_on: ["T1", "T3"],
      spec_anchors: ["FR-001", "FR-002"],
      file_list: [PRICING, QUOTES, HELPERS, RATES, JAVA_PRICING, "tests/order/pricing.test.ts"],
    }),
  ]);
  if (!roster.ok) throw new Error(roster.error);
  const result = populateTaskGraph({
    current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: "spec.md", plan_file: "plan.md",
    tasks: [], wave_gates: {},
  }, {
    planTitle: "skeleton wire", validatedPlanFile: "plan.md", tasks: roster.value,
    verificationManifest: defaultVerificationManifest(),
    specIndex: indexedSpec("spec.md"), observedSpecFile: "spec.md",
    force: false, proofBoundary: { kind: "absent", cause: "fixture" }, contracts: [CONTRACT, TYPELESS], invariants: [],
  });
  if (!result.ok) throw new Error(result.error.message);
  const raw = JSON.parse(JSON.stringify(result.value.state)) as Record<string, unknown>;
  const { export_bindings: _stamp, skeletons: _records, ...preG2 } = raw;
  return preG2;
}

const viaDisk = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const BINDINGS = [
  { path: PRICING, contract: "CT-1", exports: [{ name: "priceOrder", alias: "PriceOrderFn" }, { name: "parseOrder", alias: "ParseOrderFn" }] },
  { path: QUOTES, contract: "CT-1", exports: [{ name: "quote", alias: "PriceOrderFn" }] },
  { path: RATES, contract: "CT-1", exports: [{ name: "rate", alias: "PriceOrderFn" }] },
  { path: JAVA_PRICING, contract: "CT-1", exports: [{ name: "priceOrder", alias: "PriceOrderFn" }] },
];

const record = (path: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  path,
  contract: "CT-1",
  language: path.endsWith(".java") ? "java" : "typescript",
  origin: "spawn",
  engineSha256: "a".repeat(64),
  typesSha256: "b".repeat(64),
  stale: null,
  ...overrides,
});

/** Records in path order: the Java path sorts before `src/order/`. */
const RECORDS = [
  record(JAVA_PRICING, { origin: "revision", engineSha256: "c".repeat(64) }),
  record(PRICING, { stale: { revision: 2 } }),
  record(QUOTES, { origin: "contract-stub" }),
];

const OUTCOMES = [
  { path: PRICING, outcome: { kind: "skeleton-written", origin: "spawn" } },
  { path: QUOTES, outcome: { kind: "exists-not-skeletonized" } },
  { path: HELPERS, outcome: { kind: "no-bound-exports" } },
  { path: RATES, outcome: { kind: "unsupported-language", reason: "other-extension" } },
  { path: JAVA_PRICING, outcome: { kind: "skeleton-written", origin: "revision" } },
];

/** The pre-G2 graph with the G2 fields added as raw JSON. */
function g2Graph(fields: Readonly<{
  bindings?: unknown;
  skeletons?: unknown;
  outcomes?: unknown;
}> = {}): Record<string, unknown> {
  const base = preG2Graph();
  const tasks = (base.tasks as Record<string, unknown>[]).map((entry) =>
    entry.id === "T2" && fields.outcomes !== undefined ? { ...entry, skeleton_outcomes: fields.outcomes } : entry);
  return {
    ...base,
    tasks,
    ...(fields.bindings === undefined ? {} : { export_bindings: fields.bindings }),
    ...(fields.skeletons === undefined ? {} : { skeletons: fields.skeletons }),
  };
}

const COMPLETE = { bindings: BINDINGS, skeletons: RECORDS, outcomes: OUTCOMES };

function loaded(raw: Record<string, unknown>): ParsedTaskGraph {
  const parsed = parseTaskGraph(viaDisk(raw));
  if (!parsed.ok) throw new Error(`expected the wire to load the graph: ${parsed.error}`);
  return parsed.value;
}

function refusal(raw: Record<string, unknown>): string {
  const parsed = parseTaskGraph(viaDisk(raw));
  if (parsed.ok) throw new Error("expected the wire to refuse the graph");
  return parsed.error;
}

const withBinding = (index: number, patch: Readonly<Record<string, unknown>>) =>
  BINDINGS.map((binding, at) => (at === index ? { ...binding, ...patch } : binding));
const withRecord = (index: number, patch: Readonly<Record<string, unknown>>) =>
  RECORDS.map((entry, at) => (at === index ? { ...entry, ...patch } : entry));
const withOutcome = (index: number, outcome: unknown) =>
  OUTCOMES.map((entry, at) => (at === index ? { ...entry, outcome } : entry));

describe("a graph populated before G2 on the State File wire", () => {
  it("loads unchanged: no export_bindings, no skeletons, no Task skeleton_outcomes", () => {
    const raw = preG2Graph();
    const graph = loaded(raw);
    expect("export_bindings" in graph).toBe(false);
    expect("skeletons" in graph).toBe(false);
    expect(graph.tasks.every((entry) => !("skeleton_outcomes" in entry))).toBe(true);
    expect(viaDisk(graph)).toEqual(viaDisk(loaded(viaDisk(graph) as Record<string, unknown>)));
  });
});

describe("export_bindings, skeletons and skeleton_outcomes round-trip", () => {
  it("FR-031: loads every engine-written record with its digests, and re-serializes to the same bytes", () => {
    const graph = loaded(g2Graph(COMPLETE));
    expect(viaDisk(graph.export_bindings)).toEqual(BINDINGS);
    expect(viaDisk(graph.skeletons)).toEqual(RECORDS);
    expect(viaDisk(graph.tasks.find(({ id }) => id === "T2")?.skeleton_outcomes)).toEqual(OUTCOMES);
    const again = loaded(viaDisk(graph) as Record<string, unknown>);
    expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
  });

  it("keeps the stamp in plan order and an empty stamp present and empty", () => {
    const reversed = [...BINDINGS].reverse();
    expect(viaDisk(loaded(g2Graph({ bindings: reversed })).export_bindings)).toEqual(reversed);
    const empty = loaded(g2Graph({ bindings: [], skeletons: [], outcomes: [] }));
    expect(empty.export_bindings).toEqual([]);
    expect(empty.skeletons).toEqual([]);
    expect(empty.tasks.find(({ id }) => id === "T2")?.skeleton_outcomes).toEqual([]);
  });

  it("hands readers frozen values", () => {
    const graph = loaded(g2Graph(COMPLETE));
    expect(Object.isFrozen(graph.export_bindings)).toBe(true);
    expect(Object.isFrozen(graph.export_bindings?.[0]?.exports)).toBe(true);
    expect(Object.isFrozen(graph.skeletons)).toBe(true);
    expect(Object.isFrozen(graph.skeletons?.[1]?.stale)).toBe(true);
    expect(Object.isFrozen(graph.tasks.find(({ id }) => id === "T2")?.skeleton_outcomes?.[0]?.outcome)).toBe(true);
  });
});

describe("an export name that is also an alias of its binding", () => {
  const selfAliased = [{ name: "PriceOrderFn", alias: "PriceOrderFn" }];

  it("loads on a Java binding: a Java field and a type never share a namespace", () => {
    const graph = loaded(g2Graph({ bindings: withBinding(3, { exports: selfAliased }) }));
    expect(viaDisk(graph.export_bindings?.find(({ path }) => path === JAVA_PRICING))).toEqual({
      path: JAVA_PRICING, contract: "CT-1", exports: selfAliased,
    });
  });

  it("loads on a binding no skeleton is generated for", () => {
    const graph = loaded(g2Graph({ bindings: withBinding(2, { exports: selfAliased }) }));
    expect(viaDisk(graph.export_bindings?.find(({ path }) => path === RATES))).toEqual({
      path: RATES, contract: "CT-1", exports: selfAliased,
    });
  });

  it("is refused on a TypeScript binding", () => {
    expect(refusal(g2Graph({ bindings: withBinding(1, { exports: selfAliased }) })))
      .toMatch(/export_bindings\[1\] binds the export name 'PriceOrderFn', which is also an alias of the binding \(name-collides-with-alias\)/);
  });
});

describe("export_bindings refusals", () => {
  it.each([
    ["a non-array stamp", { bindings: { path: PRICING } }, /export_bindings must be an array/],
    ["a non-record entry", { bindings: ["src/order/pricing.ts"] }, /export_bindings\[0\]/],
    ["an extra field", { bindings: withBinding(0, { origin: "plan" }) }, /export_bindings\[0\].*origin/],
    ["a missing contract", { bindings: withBinding(0, { contract: undefined }) }, /export_bindings\[0\] is missing field\(s\): contract/],
    ["an unsafe path", { bindings: withBinding(0, { path: "../escape.ts" }) }, /export_bindings\[0\]\.path/],
    ["an absolute path", { bindings: withBinding(0, { path: "/etc/pricing.ts" }) }, /export_bindings\[0\]\.path/],
    ["an unnormalized path", { bindings: withBinding(0, { path: "./src/order/pricing.ts" }) }, /export_bindings\[0\]\.path/],
    ["a path bound twice", { bindings: [...BINDINGS, BINDINGS[0]] }, /export_bindings.*src\/order\/pricing\.ts.*more than once/],
    ["an empty export list", { bindings: withBinding(0, { exports: [] }) }, /export_bindings\[0\]\.exports/],
    ["an export that is no identifier", { bindings: withBinding(1, { exports: [{ name: "quote-it", alias: "PriceOrderFn" }] }) }, /export_bindings\[1\]\.exports\[0\]\.name/],
    ["a reserved-word alias", { bindings: withBinding(1, { exports: [{ name: "quote", alias: "class" }] }) }, /export_bindings\[1\]\.exports\[0\]\.alias/],
    ["an extra export field", { bindings: withBinding(1, { exports: [{ name: "quote", alias: "PriceOrderFn", kind: "fn" }] }) }, /export_bindings\[1\]\.exports\[0\]/],
    ["an export name bound twice", { bindings: withBinding(1, { exports: [{ name: "quote", alias: "PriceOrderFn" }, { name: "quote", alias: "ParseOrderFn" }] }) }, /export_bindings\[1\].*quote.*more than once/],
    ["an unstamped contract", { bindings: withBinding(0, { contract: "CT-9" }) }, /export_bindings\[0\].*CT-9/],
    ["a typeless contract", { bindings: withBinding(0, { contract: "CT-2" }) }, /export_bindings\[0\].*CT-2.*types file/],
    ["a contract that is no contract id", { bindings: withBinding(0, { contract: "ct-1" }) }, /export_bindings\[0\]\.contract 'ct-1' is no contract id CT-<n> \(invalid-contract-id\)/],
    [
      "an export name that is also an alias of the binding",
      { bindings: withBinding(0, { exports: [{ name: "priceOrder", alias: "PriceOrderFn" }, { name: "PriceOrderFn", alias: "ParseOrderFn" }] }) },
      /export_bindings\[0\] binds the export name 'PriceOrderFn', which is also an alias of the binding \(name-collides-with-alias\)/,
    ],
    ["an export whose name is its own alias", { bindings: withBinding(1, { exports: [{ name: "PriceOrderFn", alias: "PriceOrderFn" }] }) }, /export_bindings\[1\].*'PriceOrderFn'.*name-collides-with-alias/],
    [
      "a Java alias that is the file's own class name",
      { bindings: withBinding(3, { exports: [{ name: "priceOrder", alias: "Pricing" }] }) },
      /export_bindings\[3\] binds the alias 'Pricing', the Java file's own class name \(alias-collides-with-class\)/,
    ],
  ])("refuses %s", (_label, fields, message) => {
    expect(refusal(g2Graph(fields))).toMatch(message);
  });
});

describe("skeletons refusals", () => {
  it.each([
    ["a non-array field", { bindings: BINDINGS, skeletons: {} }, /skeletons must be an array/],
    ["a record out of path order", { bindings: BINDINGS, skeletons: [RECORDS[1], RECORDS[0], RECORDS[2]] }, /skeletons.*sorted by path/],
    ["a path recorded twice", { bindings: BINDINGS, skeletons: [RECORDS[0], RECORDS[1], RECORDS[1]] }, /skeletons.*sorted by path/],
    ["an extra field", { bindings: BINDINGS, skeletons: withRecord(0, { bytes: "x" }) }, /skeletons\[0\].*bytes/],
    ["a missing stale flag", { bindings: BINDINGS, skeletons: withRecord(0, { stale: undefined }) }, /skeletons\[0\] is missing field\(s\): stale/],
    ["an uppercase engine digest", { bindings: BINDINGS, skeletons: withRecord(0, { engineSha256: "A".repeat(64) }) }, /skeletons\[0\]\.engineSha256/],
    ["a short types digest", { bindings: BINDINGS, skeletons: withRecord(0, { typesSha256: "b".repeat(63) }) }, /skeletons\[0\]\.typesSha256/],
    ["an unknown origin", { bindings: BINDINGS, skeletons: withRecord(0, { origin: "manual" }) }, /skeletons\[0\]\.origin/],
    ["an unknown language", { bindings: BINDINGS, skeletons: withRecord(0, { language: "kotlin" }) }, /skeletons\[0\]\.language/],
    ["a language its path does not have", { bindings: BINDINGS, skeletons: withRecord(1, { language: "java" }) }, /skeletons\[1\].*typescript/],
    ["a stale revision that is no positive integer", { bindings: BINDINGS, skeletons: withRecord(1, { stale: { revision: 0 } }) }, /skeletons\[1\]\.stale/],
    ["a stale flag with an extra field", { bindings: BINDINGS, skeletons: withRecord(1, { stale: { revision: 1, at: "now" } }) }, /skeletons\[1\]\.stale/],
    ["a record of an unbound path", { bindings: BINDINGS.slice(1), skeletons: RECORDS }, /skeletons\[1\].*src\/order\/pricing\.ts.*not bound/],
    ["a record without any stamp", { skeletons: RECORDS }, /skeletons\[0\].*not bound/],
    ["a contract other than its binding's", { bindings: BINDINGS, skeletons: withRecord(2, { contract: "CT-2" }) }, /skeletons\[2\].*CT-2.*CT-1/],
    ["a record of an unsupported path", { bindings: BINDINGS, skeletons: [...RECORDS, record(RATES)] }, /skeletons\[3\].*rates\.py/],
  ])("refuses %s", (_label, fields, message) => {
    expect(refusal(g2Graph(fields))).toMatch(message);
  });
});

describe("tasks[].skeleton_outcomes refusals", () => {
  it.each([
    ["a non-array field", { outcomes: { path: PRICING } }, /skeleton_outcomes must be an array/],
    ["an extra entry field", { outcomes: [{ ...OUTCOMES[0], note: "x" }] }, /skeleton_outcomes\[0\].*note/],
    ["an unknown outcome kind", { outcomes: withOutcome(0, { kind: "skipped" }) }, /skeleton_outcomes\[0\]\.outcome/],
    ["a written outcome without an origin", { outcomes: withOutcome(0, { kind: "skeleton-written" }) }, /skeleton_outcomes\[0\]\.outcome/],
    ["a written outcome with an unknown origin", { outcomes: withOutcome(0, { kind: "skeleton-written", origin: "manual" }) }, /skeleton_outcomes\[0\]\.outcome/],
    ["an unsupported outcome with an unknown reason", { outcomes: withOutcome(3, { kind: "unsupported-language", reason: "cobol" }) }, /skeleton_outcomes\[3\]\.outcome/],
    ["an outcome carrying a field its kind has not", { outcomes: withOutcome(2, { kind: "no-bound-exports", origin: "spawn" }) }, /skeleton_outcomes\[2\]\.outcome/],
    ["a path with two outcomes", { outcomes: [...OUTCOMES, OUTCOMES[0]] }, /skeleton_outcomes.*src\/order\/pricing\.ts.*more than once/],
    ["a path outside the Task's file_list", { outcomes: [...OUTCOMES, { path: "src/other.ts", outcome: { kind: "no-bound-exports" } }] }, /skeleton_outcomes\[5\].*src\/other\.ts.*file_list/],
  ])("refuses %s", (_label, fields, message) => {
    expect(refusal(g2Graph({ bindings: BINDINGS, skeletons: RECORDS, ...fields }))).toMatch(message);
  });
});

describe("tasks[].skeleton_outcomes against the stamp and the records", () => {
  it.each([
    [
      "a skeleton-written outcome with no record",
      { bindings: BINDINGS, skeletons: [RECORDS[0], RECORDS[2]], outcomes: OUTCOMES },
      /tasks\[2\] \("T2"\)\.skeleton_outcomes\[0\] records 'src\/order\/pricing\.ts' as skeleton-written, but skeletons holds no record of it/,
    ],
    [
      "a skeleton-written outcome with no records at all",
      { bindings: BINDINGS, outcomes: [OUTCOMES[0]] },
      /skeleton_outcomes\[0\] records 'src\/order\/pricing\.ts' as skeleton-written, but skeletons holds no record of it/,
    ],
    [
      "outcomes on a graph with no export_bindings stamp",
      { outcomes: [{ path: HELPERS, outcome: { kind: "no-bound-exports" } }] },
      /tasks\[2\] \("T2"\)\.skeleton_outcomes is recorded, but the TaskGraph has no export_bindings stamp/,
    ],
    [
      "an unsupported-language outcome on an unbound path",
      { bindings: BINDINGS, skeletons: RECORDS, outcomes: [{ path: HELPERS, outcome: { kind: "unsupported-language", reason: "other-extension" } }] },
      /skeleton_outcomes\[0\] records 'src\/order\/helpers\.ts' as unsupported-language, but export_bindings does not bind it/,
    ],
    [
      "an unsupported-language outcome on a supported path",
      { bindings: BINDINGS, skeletons: RECORDS, outcomes: [{ path: PRICING, outcome: { kind: "unsupported-language", reason: "other-extension" } }] },
      /skeleton_outcomes\[0\] records 'src\/order\/pricing\.ts' as unsupported-language, but the path is a typescript skeleton target/,
    ],
    [
      "an unsupported-language outcome with another reason than the path's",
      { bindings: BINDINGS, skeletons: RECORDS, outcomes: withOutcome(3, { kind: "unsupported-language", reason: "jvm-non-java" }) },
      /skeleton_outcomes\[3\] records 'src\/order\/rates\.py' as unsupported-language \(jvm-non-java\), but the path is unsupported as other-extension/,
    ],
    [
      "a no-bound-exports outcome on a bound path",
      { bindings: BINDINGS, skeletons: RECORDS, outcomes: withOutcome(1, { kind: "no-bound-exports" }) },
      /skeleton_outcomes\[1\] records 'src\/order\/quotes\.ts' as no-bound-exports, but export_bindings binds it to CT-1/,
    ],
    [
      "a contract-has-no-types-file outcome on a bound path",
      { bindings: BINDINGS, skeletons: RECORDS, outcomes: withOutcome(4, { kind: "contract-has-no-types-file" }) },
      /skeleton_outcomes\[4\] records 'src\/main\/java\/com\/acme\/order\/Pricing\.java' as contract-has-no-types-file, but export_bindings binds it to CT-1/,
    ],
  ])("refuses %s", (_label, fields, message) => {
    expect(refusal(g2Graph(fields))).toMatch(message);
  });

  it("loads a written outcome whose record a Contract Revision has since given another origin", () => {
    const outcomes = withOutcome(0, { kind: "skeleton-written", origin: "contract-stub" });
    const graph = loaded(g2Graph({ bindings: BINDINGS, skeletons: RECORDS, outcomes }));
    expect(viaDisk(graph.tasks.find(({ id }) => id === "T2")?.skeleton_outcomes)).toEqual(outcomes);
  });

  it("loads an unbound path's contract-has-no-types-file outcome, and an exists-not-skeletonized one on any path", () => {
    const outcomes = [
      { path: PRICING, outcome: { kind: "exists-not-skeletonized" } },
      { path: HELPERS, outcome: { kind: "contract-has-no-types-file" } },
    ];
    const graph = loaded(g2Graph({ bindings: BINDINGS, outcomes }));
    expect(viaDisk(graph.tasks.find(({ id }) => id === "T2")?.skeleton_outcomes)).toEqual(outcomes);
  });

  it("refuses the first contradicting Task, naming its index and id", () => {
    const base = g2Graph({ bindings: BINDINGS, skeletons: RECORDS, outcomes: OUTCOMES });
    const tasks = (base.tasks as Record<string, unknown>[]).map((entry) =>
      entry.id === "T1" ? { ...entry, skeleton_outcomes: [{ path: TYPES_FILE, outcome: { kind: "skeleton-written", origin: "spawn" } }] } : entry);
    expect(refusal({ ...base, tasks })).toMatch(/tasks\[0\] \("T1"\)\.skeleton_outcomes\[0\] records 'src\/order\/order-contract\.ts' as skeleton-written/);
  });
});
