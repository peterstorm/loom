/**
 * The skeleton fixture repository (CT-3): a real temp Git repository holding
 * three Acceptance Contracts and the implementation Tasks that bind to them,
 * with a raw-JSON State File carrying the `export_bindings` population stamp.
 *
 * - CT-1 (contract Task T1): a TypeScript types file `src/order/order-contract.ts`
 *   declaring function-type aliases and two frozen ADTs (the discriminated
 *   union `OrderState` and the brand `OrderId`), and its acceptance file.
 * - CT-2 (contract Task T2): a Java holder `com.acme.order.OrderContract`
 *   nesting two functional interfaces, a sealed interface with two permitted
 *   records, and two records.
 * - CT-3 (contract Task T3): `Types file: none`.
 *
 * Wave 2 holds the implementation Tasks (all depend on their contract Task):
 * - T4 claims CT-1. Bound: `pricing.ts` (two exports), `quotes.ts` (one),
 *   `legacy.ts` (exists at Wave start, shadows and re-lists frozen ADTs) and
 *   `rates.py` (bound, but Python has no skeleton language). Unbound:
 *   `helpers.ts`. Plus a test file, which owns no skeleton outcome.
 * - T5 claims CT-2. Bound: `Pricing.java` (two exports) and `Existing.java`
 *   (exists at Wave start). Unbound: `Discounts.java`.
 * - T6 claims CT-3: `audit-log.ts`, under a contract with no types file.
 * - T7 claims CT-1 with a `documentation-only` regression waiver; its existing
 *   `state-view.ts` shadows a frozen ADT.
 * - T8 claims CT-1; its existing `order-view.ts` shadows a frozen ADT. Tests
 *   arm it for attestation (the `declared-artifact-attested` arm).
 *
 * The State File is first proven loadable by the production parser WITHOUT the
 * G2 fields, then the G2 fields are added in their raw wire form:
 * `export_bindings`, and — when a scenario seeds them — `skeletons` records.
 * The tests read every engine output as unknown JSON and decode it here into
 * the CT-1 types, so they depend only on the wire shape, never on engine
 * internals or the engine's own serializer.
 *
 * Canonical skeleton bytes are rendered here from the CT-1 format (AD-8):
 * the test-side oracle every written skeleton is compared against.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AcceptanceContract, AcceptanceTestcase, FrozenPathDigest } from "../../src/core/acceptance-contract";
import { parseIsoInstant, type ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import { productionExactSettlementPorts, settleExactImplementation } from "../../src/handlers/helpers/exact-implementation-settlement";
import { renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import { StateManager } from "../../src/state-manager";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import type {
  ConformanceViolation,
  ResolutionProblem,
  SkeletonLanguage,
  SkeletonOrigin,
  SkeletonOutcome,
  SkeletonRecord,
  UnsupportedReason,
  ViolationReason,
} from "../../src/core/skeleton/types";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import type { TaskExecutionSpawn } from "../../src/core/validate-task-execution";
import { newWaveGate } from "../../src/core/wave-gate-model";
import type { Task, TaskGraph } from "../../src/types";
import { contentDigest } from "./acceptance-fixtures";
import { canonicalTempDir } from "./canonical-temp-dir";
import {
  completedWaveGateFixture,
  graphFixture,
  pendingTaskProof,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "./task-lifecycle";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const TS_CONTRACT = Object.freeze({
  id: "CT-1",
  contractTask: "T1",
  types: "src/order/order-contract.ts",
  acceptance: "tests/order.acceptance.test.ts",
  anchors: ["AS-101", "AS-104", "AS-105"] as const,
});

export const JAVA_CONTRACT = Object.freeze({
  id: "CT-2",
  contractTask: "T2",
  types: "src/main/java/com/acme/order/OrderContract.java",
  acceptance: "src/test/java/com/acme/order/OrderAcceptanceTest.java",
  anchors: ["AS-102"] as const,
});

const NO_TYPES_CONTRACT = Object.freeze({
  id: "CT-3",
  contractTask: "T3",
  acceptance: "tests/audit.acceptance.test.ts",
  anchors: ["AS-103"] as const,
});

/** Every implementation path of the fixture, by role. */
export const PATHS = Object.freeze({
  /** T4, bound to CT-1: `priceOrder: PriceOrderFn, parseOrder: ParseOrderFn`. */
  tsPricing: "src/order/pricing.ts",
  /** T4, bound to CT-1: `quote: PriceOrderFn`. */
  tsQuotes: "src/order/quotes.ts",
  /** T4, bound to CT-1: `quoteOrder: PriceOrderFn`; exists at Wave start. */
  tsLegacy: "src/order/legacy.ts",
  /** T4, bound to CT-1 (`rate: PriceOrderFn`), but Python: unsupported. */
  pythonRates: "src/order/rates.py",
  /** T4, unbound. */
  tsHelpers: "src/order/helpers.ts",
  /** T4's test file: no skeleton outcome. */
  tsTest: "tests/order/pricing.test.ts",
  /** T5, bound to CT-2: `priceOrder: PriceOrderFn, parseOrder: ParseOrderFn`. */
  javaPricing: "src/main/java/com/acme/order/pricing/Pricing.java",
  /** T5, bound to CT-2: `priceOrder: PriceOrderFn`; exists at Wave start. */
  javaExisting: "src/main/java/com/acme/order/pricing/Existing.java",
  /** T5, unbound. */
  javaDiscounts: "src/main/java/com/acme/order/pricing/Discounts.java",
  /** T6, claimant of the no-types contract CT-3. */
  auditLog: "src/audit/audit-log.ts",
  /** T7 (documentation-only waiver); exists at Wave start, shadows `OrderId`. */
  stateView: "src/order/state-view.ts",
  /** T8 (attested in tests); exists at Wave start, shadows `OrderId`. */
  orderView: "src/order/order-view.ts",
});

const PLAN_FILE = ".claude/plans/skeleton-fixture.md";
const SPEC_FILE = ".claude/specs/skeleton-fixture/spec.md";
const STATE_FILE = ".claude/state/active_task_graph.json";

// ---------------------------------------------------------------------------
// Frozen sources
// ---------------------------------------------------------------------------

export const TS_TYPES_TEXT = `export type Order = Readonly<{ id: string; lines: readonly string[] }>;
export type Price = Readonly<{ cents: number }>;
export type OrderId = string & { readonly __brand: "OrderId" };
export type OrderState =
  | Readonly<{ status: "draft" }>
  | Readonly<{ status: "paid"; at: string }>;

export type ParseOrderFn = (raw: string) => Order;
export type PriceOrderFn = (order: Order, quantity: number) => Price;
`;

const TS_ACCEPTANCE_TEXT = `import { describe, expect, it } from "vitest";
import type { PriceOrderFn } from "../src/order/order-contract";
import { priceOrder } from "../src/order/pricing";

describe("order pricing", () => {
  it("AS-101: prices an order", () => {
    const price: PriceOrderFn = priceOrder;
    expect(price({ id: "o-1", lines: [] }, 2)).toEqual({ cents: 0 });
  });
});
`;

export const JAVA_TYPES_TEXT = `package com.acme.order;

import java.util.List;

/** Frozen CT-2 surface. */
public interface OrderContract {
    @FunctionalInterface
    interface PriceOrderFn {
        Price apply(Order order, int quantity);
    }

    @FunctionalInterface
    interface ParseOrderFn {
        Order parse(String raw);
    }

    sealed interface OrderState permits Draft, Paid {}

    record Draft() implements OrderState {}

    record Paid(String at) implements OrderState {}

    record Order(String id, List<String> lines) {}

    record Price(long cents) {}
}
`;

const JAVA_ACCEPTANCE_TEXT = `package com.acme.order;

import com.acme.order.pricing.Pricing;
import org.junit.jupiter.api.Test;

class OrderAcceptanceTest {
    @Test
    void as102PricesAnOrder() {
        Pricing.priceOrder.apply(new OrderContract.Order("o-1", java.util.List.of()), 2);
    }
}
`;

const AUDIT_ACCEPTANCE_TEXT = `import { expect, it } from "vitest";

it("AS-103: audits a change", () => {
  expect(true).toBe(true);
});
`;

/** `legacy.ts` at Wave start: no `quoteOrder`, a local `OrderId` shadowing the
 *  frozen brand, and a local union re-listing two frozen `OrderState` tags. */
export const TS_LEGACY_TEXT = `export interface OrderId {
  readonly value: string;
}

type LegacyState = { status: "draft" } | { status: "paid"; at: string };

export const legacyTotal = (state: LegacyState, cents: number): number => (state.status === "paid" ? cents : 0);
`;

/** `state-view.ts` (T7) and `order-view.ts` (T8) at Wave start: each shadows
 *  the frozen `OrderId` brand. */
export const SHADOWING_VIEW_TEXT = `export interface OrderId {
  readonly value: string;
}

export const viewOf = (id: OrderId): string => id.value;
`;

export const JAVA_EXISTING_TEXT = `package com.acme.order.pricing;

public final class Existing {
    private Existing() {}
}
`;

/** The specification every Task's Requirement trace joins against. */
const SPEC_TEXT = `# Feature: Skeleton fixture

## User Scenarios

### US1: [P1] Price orders against frozen contracts

**Acceptance Scenarios:**
- AS-101: Given an order, When it is priced, Then the TypeScript price is returned
- AS-102: Given an order, When it is priced in Java, Then the Java price is returned
- AS-103: Given a change, When it is made, Then it is audited
- AS-104: Given an order state, When it is viewed, Then the view names it
- AS-105: Given an order, When it is viewed, Then the view names its id

## Functional Requirements

- FR-001: System MUST price orders through the frozen contracts

## Out of Scope

- OOS-001: Anything else

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Order | A priced purchase |
`;

// ---------------------------------------------------------------------------
// Bindings: the population stamp and the plan text it was stamped from
// ---------------------------------------------------------------------------

/** One `export_bindings` entry exactly as population stamps it. */
type RawExportBinding = Readonly<{
  path: string;
  contract: string;
  exports: readonly Readonly<{ name: string; alias: string }>[];
}>;

const bound = (path: string, contract: string, ...exports: readonly [string, string][]): RawExportBinding => ({
  path,
  contract,
  exports: exports.map(([name, alias]) => ({ name, alias })),
});

/** The fixture's bindings, in plan order. */
const EXPORT_BINDINGS: readonly RawExportBinding[] = Object.freeze([
  bound(PATHS.tsPricing, "CT-1", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
  bound(PATHS.tsQuotes, "CT-1", ["quote", "PriceOrderFn"]),
  bound(PATHS.tsLegacy, "CT-1", ["quoteOrder", "PriceOrderFn"]),
  bound(PATHS.pythonRates, "CT-1", ["rate", "PriceOrderFn"]),
  bound(PATHS.javaPricing, "CT-2", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
  bound(PATHS.javaExisting, "CT-2", ["priceOrder", "PriceOrderFn"]),
]);

const bindingLine = ({ path, contract, exports }: RawExportBinding): string =>
  `- \`${path}\` — ${contract}: ${exports.map(({ name, alias }) => `${name}: ${alias}`).join(", ")}`;

/** One File Structure group of the plan, with its `**Export bindings:**` list
 *  when any of its files is bound. */
const planGroup = (title: string, files: readonly string[], lines: readonly RawExportBinding[]): string => [
  `### ${title}`,
  "",
  "```",
  ...files.map((file) => `${file} — NEW`),
  "```",
  ...(lines.length === 0 ? [] : ["", "**Export bindings:**", ...lines.map(bindingLine)]),
  "",
].join("\n");

/** The plan's `## Contracts` section, one entry per Acceptance Contract. */
const PLAN_CONTRACT_LINES: readonly string[] = Object.freeze([
  "## Contracts",
  "",
  "### CT-1: Order pricing",
  "",
  `**Types file:** \`${TS_CONTRACT.types}\``,
  "**Acceptance tests:**",
  `- \`${TS_CONTRACT.acceptance}\` — ${TS_CONTRACT.anchors.join(", ")}`,
  "**Statement:** Orders are priced and parsed through the frozen function types.",
  "",
  "### CT-2: Java order pricing",
  "",
  `**Types file:** \`${JAVA_CONTRACT.types}\``,
  "**Acceptance tests:**",
  `- \`${JAVA_CONTRACT.acceptance}\` — ${JAVA_CONTRACT.anchors.join(", ")}`,
  "**Statement:** Java orders are priced through the frozen functional interfaces.",
  "",
  "### CT-3: Audit",
  "",
  "**Types file:** none",
  "**No types reason:** The audit slice drives an existing entry point.",
  "**Acceptance tests:**",
  `- \`${NO_TYPES_CONTRACT.acceptance}\` — ${NO_TYPES_CONTRACT.anchors.join(", ")}`,
  "**Statement:** Every change is audited.",
  "",
]);

/** The plan the brief re-reads: File Structure groups with their
 *  `**Export bindings:**` lists (agreeing with the stamp), and the contracts. */
function planText(bindings: readonly RawExportBinding[]): string {
  const boundIn = (files: readonly string[]) => bindings.filter(({ path }) => files.includes(path));
  const t4 = [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy, PATHS.pythonRates, PATHS.tsHelpers, PATHS.tsTest];
  const t5 = [PATHS.javaPricing, PATHS.javaExisting, PATHS.javaDiscounts];
  return [
    "# Plan: skeleton fixture",
    "",
    "## Summary",
    "",
    "Orders are priced against frozen contracts.",
    "",
    "## File Structure",
    "",
    planGroup("Contract CT-1 (T1, Wave 1)", [TS_CONTRACT.types, TS_CONTRACT.acceptance], []),
    planGroup("Contract CT-2 (T2, Wave 1)", [JAVA_CONTRACT.types, JAVA_CONTRACT.acceptance], []),
    planGroup("Contract CT-3 (T3, Wave 1)", [NO_TYPES_CONTRACT.acceptance], []),
    planGroup("Pricing (T4, Wave 2)", t4, boundIn(t4)),
    planGroup("Java pricing (T5, Wave 2)", t5, boundIn(t5)),
    planGroup("Audit (T6, Wave 2)", [PATHS.auditLog], []),
    planGroup("Views (T7, T8, Wave 2)", [PATHS.stateView, PATHS.orderView], []),
    ...PLAN_CONTRACT_LINES,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Canonical skeleton bytes (the CT-1 format, AD-8): the test-side oracle
// ---------------------------------------------------------------------------

const HEADER_TAIL = "Make these signatures work; keep each name and its type.";

export const sha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");

/** The canonical TypeScript skeleton of `path`, bound to CT-1, importing the
 *  types file extensionless (the fixture's acceptance file imports it so). */
export function canonicalTsSkeleton(path: string, exports: readonly Readonly<{ name: string; alias: string }>[]): string {
  const fromDir = dirname(path).split("/");
  const toParts = TS_CONTRACT.types.replace(/\.ts$/, "").split("/");
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) common += 1;
  const ups = fromDir.length - common;
  const rest = toParts.slice(common).join("/");
  const specifier = ups === 0 ? `./${rest}` : `${"../".repeat(ups)}${rest}`;
  const aliases = [...new Set(exports.map(({ alias }) => alias))].sort();
  return [
    `// Skeleton written by Loom from ${TS_CONTRACT.types} (${TS_CONTRACT.id}). ${HEADER_TAIL}`,
    `import type { ${aliases.join(", ")} } from "${specifier}";`,
    ...exports.flatMap(({ name, alias }) => [
      "",
      `export const ${name}: ${alias} = () => {`,
      `  throw new Error("unimplemented: ${name}");`,
      "};",
    ]),
    "",
  ].join("\n");
}

/** The canonical Java skeleton of a path under `src/main/java/`, bound to the
 *  CT-2 holder; `arity` gives each alias's single abstract method's parameter count. */
export function canonicalJavaSkeleton(
  path: string,
  exports: readonly Readonly<{ name: string; alias: string }>[],
  arity: Readonly<Record<string, number>>,
  typesPath: string = JAVA_CONTRACT.types,
): string {
  const relative = path.slice(path.indexOf("src/main/java/") + "src/main/java/".length);
  const segments = relative.split("/");
  const className = segments.pop()!.replace(/\.java$/, "");
  const javaPackage = segments.join(".");
  const aliases = [...new Set(exports.map(({ alias }) => alias))].sort();
  const lambda = (count: number) => `(${Array.from({ length: count }, (_, index) => `p${index}`).join(", ")})`;
  return [
    `// Skeleton written by Loom from ${typesPath} (${JAVA_CONTRACT.id}). ${HEADER_TAIL}`,
    `package ${javaPackage};`,
    "",
    ...aliases.map((alias) => `import com.acme.order.OrderContract.${alias};`),
    "",
    `public final class ${className} {`,
    `    private ${className}() {}`,
    ...exports.flatMap(({ name, alias }) => [
      "",
      `    public static final ${alias} ${name} = ${lambda(arity[alias] ?? 0)} -> {`,
      `        throw new UnsupportedOperationException("unimplemented: ${name}");`,
      "    };",
    ]),
    "}",
    "",
  ].join("\n");
}

export const JAVA_ARITY: Readonly<Record<string, number>> = Object.freeze({ PriceOrderFn: 2, ParseOrderFn: 1 });

const bindingOf = (path: string): RawExportBinding => {
  const found = EXPORT_BINDINGS.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`fixture: ${path} is not bound`);
  return found;
};

/** The canonical skeleton the engine must write at a bound TypeScript or Java path. */
export function canonicalSkeletonOf(path: string): string {
  const { exports } = bindingOf(path);
  return path.endsWith(".java") ? canonicalJavaSkeleton(path, exports, JAVA_ARITY) : canonicalTsSkeleton(path, exports);
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

/**
 * `implementation-wave` (default): the three contracts are frozen at Wave 1
 * (their stamps digest the bytes on disk), Wave 1 completed, and Wave 2 is
 * current with every implementation Task pending.
 *
 * `contract-wave`: Wave 1 is current; the contract Tasks are pending, the
 * contracts `awaiting-red`, and only the contract files exist (as the
 * contract Task's agent wrote them). No implementation file exists, legacy or
 * otherwise.
 */
export type SkeletonRepoStage = "implementation-wave" | "contract-wave";

export type SkeletonRepoOptions = Readonly<{
  stage?: SkeletonRepoStage;
  /** `none`: the plan binds nothing and the graph carries an empty stamp. */
  bindings?: "stamped" | "none";
  /** Skeleton records seeded into the State File; the caller writes their files. */
  skeletons?: readonly SkeletonRecord[];
  /** The CT-1 types file's bytes, written and frozen in place of `TS_TYPES_TEXT`. */
  tsTypesText?: string;
}>;

/** The State File as the JSON object on disk: its fields still unknown until
 *  `decodeStateFile` reads the slices a test asserts on. */
export type RawStateFile = Record<string, unknown>;

export type SkeletonRepo = Readonly<{
  root: string;
  statePath: string;
  /** The current bytes of a repository path, or null when it does not exist. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
  remove: (path: string) => void;
  /** The current raw State File. */
  rawState: () => RawStateFile;
  /** Replace the State File with an edited copy of its raw JSON. */
  rewriteState: (edit: (raw: RawStateFile) => RawStateFile) => void;
  /** Commit every workspace change, so the next registration's baseline starts clean. */
  commit: (message: string) => void;
  /** Write the contract Tasks' frozen sources, as their agents would in the contract Wave. */
  writeContractSources: () => void;
  /**
   * Freeze the contract Wave and start Wave 2: commit the workspace, add the
   * Wave-start implementation files that do not exist yet (an engine stub at a
   * path is kept), and replace the State File with the implementation-wave
   * graph, keeping the stored `export_bindings` and `skeletons`.
   */
  advanceToImplementationWave: () => void;
}>;

const created: string[] = [];
const ENVIRONMENT_KEYS = ["LOOM_STATE_PATH", "CLAUDE_PROJECT_DIR", "LOOM_SUBAGENT_DIR"] as const;
let savedEnvironment: readonly (readonly [string, string | undefined])[] | null = null;

/** Remove every fixture repository and restore the environment the fixtures set. */
export function cleanupSkeletonRepos(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedEnvironment !== null) {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnvironment = null;
  }
}

const frozenDigest = (path: string, text: string): FrozenPathDigest => ({ path, sha256: contentDigest(text) });

/** A contract's freeze at `stage`: `awaiting-red` in the contract Wave, else
 *  frozen at Wave 1 over `paths`, with one roster testcase per anchor. */
function freezeOf(
  stage: SkeletonRepoStage,
  paths: NonEmpty<FrozenPathDigest>,
  file: string,
  [anchor, ...anchors]: readonly [string, ...string[]],
): AcceptanceContract["freeze"] {
  const testcase = (covered: string): AcceptanceTestcase => ({ file, name: `${covered}: behaves as declared`, anchors: [covered] });
  return stage === "contract-wave"
    ? { state: "awaiting-red" }
    : { state: "frozen", wave: 1, paths, roster: [testcase(anchor), ...anchors.map(testcase)] };
}

/** What distinguishes one fixture contract; the rest of its record is shared. */
type ContractSeed = Readonly<{
  id: string;
  title: string;
  statement: string;
  contractTask: string;
  types: AcceptanceContract["types"];
  acceptance: string;
  anchors: readonly [string, ...string[]];
  frozen: NonEmpty<FrozenPathDigest>;
}>;

const contractOf = (stage: SkeletonRepoStage, seed: ContractSeed): AcceptanceContract => ({
  schemaVersion: 1,
  id: seed.id,
  title: seed.title,
  statement: seed.statement,
  contractTask: seed.contractTask,
  types: seed.types,
  acceptance: [{ path: seed.acceptance, anchors: [...seed.anchors] }],
  supportedDomain: null,
  freeze: freezeOf(stage, seed.frozen, seed.acceptance, seed.anchors),
  revisions: [],
});

function contracts(stage: SkeletonRepoStage, tsTypesText: string): readonly AcceptanceContract[] {
  const seeds: readonly ContractSeed[] = [
    {
      ...TS_CONTRACT,
      title: "Order pricing",
      statement: "Orders are priced and parsed through the frozen function types.",
      types: { kind: "file", path: TS_CONTRACT.types },
      frozen: [frozenDigest(TS_CONTRACT.types, tsTypesText), frozenDigest(TS_CONTRACT.acceptance, TS_ACCEPTANCE_TEXT)],
    },
    {
      ...JAVA_CONTRACT,
      title: "Java order pricing",
      statement: "Java orders are priced through the frozen functional interfaces.",
      types: { kind: "file", path: JAVA_CONTRACT.types },
      frozen: [frozenDigest(JAVA_CONTRACT.types, JAVA_TYPES_TEXT), frozenDigest(JAVA_CONTRACT.acceptance, JAVA_ACCEPTANCE_TEXT)],
    },
    {
      ...NO_TYPES_CONTRACT,
      title: "Audit",
      statement: "Every change is audited.",
      types: { kind: "none", reason: "The audit slice drives an existing entry point." },
      frozen: [frozenDigest(NO_TYPES_CONTRACT.acceptance, AUDIT_ACCEPTANCE_TEXT)],
    },
  ];
  return seeds.map((seed) => contractOf(stage, seed));
}

type TaskSpec = Readonly<{
  id: string;
  wave: number;
  files: readonly string[];
  anchors: readonly string[];
  dependsOn: readonly string[];
  waiver?: "documentation-only";
}>;

const TASK_SPECS: readonly TaskSpec[] = [
  { id: "T1", wave: 1, files: [TS_CONTRACT.types, TS_CONTRACT.acceptance], anchors: [], dependsOn: [] },
  { id: "T2", wave: 1, files: [JAVA_CONTRACT.types, JAVA_CONTRACT.acceptance], anchors: [], dependsOn: [] },
  { id: "T3", wave: 1, files: [NO_TYPES_CONTRACT.acceptance], anchors: [], dependsOn: [] },
  {
    id: "T4",
    wave: 2,
    files: [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy, PATHS.pythonRates, PATHS.tsHelpers, PATHS.tsTest],
    anchors: ["AS-101"],
    dependsOn: ["T1"],
  },
  { id: "T5", wave: 2, files: [PATHS.javaPricing, PATHS.javaExisting, PATHS.javaDiscounts], anchors: ["AS-102"], dependsOn: ["T2"] },
  { id: "T6", wave: 2, files: [PATHS.auditLog], anchors: ["AS-103"], dependsOn: ["T3"] },
  { id: "T7", wave: 2, files: [PATHS.stateView], anchors: ["AS-104"], dependsOn: ["T1"], waiver: "documentation-only" },
  { id: "T8", wave: 2, files: [PATHS.orderView], anchors: ["AS-105"], dependsOn: ["T1"] },
];

function task(spec: TaskSpec, stage: SkeletonRepoStage): Task {
  const contractTask = spec.wave === 1;
  const completed = contractTask && stage === "implementation-wave";
  const base = {
    id: spec.id,
    description: `${spec.id} of the skeleton fixture`,
    agent: "code-implementer-agent",
    wave: spec.wave,
    depends_on: [...spec.dependsOn],
    file_list: [...spec.files],
    spec_anchors: [...spec.anchors],
    spec_contributions: [],
  } as const;
  if (completed) {
    return taskFixture({
      ...base,
      status: "completed",
      proof: satisfiedProof(spec.files),
      review_status: "passed",
      review_generation: 1,
    });
  }
  if (spec.waiver !== undefined) {
    return taskFixture({
      ...base,
      verification_policy: {
        regression: { kind: "waived", reason: spec.waiver },
        new_tests: { kind: "waived", reason: spec.waiver },
      },
      proof: pendingTaskProof(spec.files, false),
    });
  }
  return taskFixture({ ...base, new_tests_required: false });
}

function graph(stage: SkeletonRepoStage, tsTypesText: string): TaskGraph {
  const base = graphFixture(TASK_SPECS.map((spec) => task(spec, stage)));
  return stage === "contract-wave"
    ? { ...base, spec_file: SPEC_FILE, plan_file: PLAN_FILE, current_wave: 1, wave_gates: { "1": newWaveGate() }, acceptance_contracts: contracts(stage, tsTypesText) }
    : {
        ...base,
        spec_file: SPEC_FILE,
        plan_file: PLAN_FILE,
        current_wave: 2,
        executing_tasks: [],
        wave_gates: {
          "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
          "2": newWaveGate(),
        },
        wave_gate_history: [completedWaveGateFixture({ runId: "run.skeleton-wave-1", wave: 1 })],
        acceptance_contracts: contracts(stage, tsTypesText),
      };
}

/** The frozen files the contract Tasks write: their types files and acceptance tests. */
function contractSources(tsTypesText: string): Readonly<Record<string, string>> {
  return {
    [TS_CONTRACT.types]: tsTypesText,
    [TS_CONTRACT.acceptance]: TS_ACCEPTANCE_TEXT,
    [JAVA_CONTRACT.types]: JAVA_TYPES_TEXT,
    [JAVA_CONTRACT.acceptance]: JAVA_ACCEPTANCE_TEXT,
    [NO_TYPES_CONTRACT.acceptance]: AUDIT_ACCEPTANCE_TEXT,
  };
}

/** The implementation files that already exist when Wave 2 starts. */
const WAVE_START_FILES: Readonly<Record<string, string>> = Object.freeze({
  [PATHS.tsLegacy]: TS_LEGACY_TEXT,
  [PATHS.javaExisting]: JAVA_EXISTING_TEXT,
  [PATHS.stateView]: SHADOWING_VIEW_TEXT,
  [PATHS.orderView]: SHADOWING_VIEW_TEXT,
});

/** The repository's initial files, committed as its base. A contract Wave
 *  starts with none: the contract Tasks' agents write them. */
function initialFiles(stage: SkeletonRepoStage, tsTypesText: string): Readonly<Record<string, string>> {
  return stage === "contract-wave" ? {} : { ...contractSources(tsTypesText), ...WAVE_START_FILES };
}

/** The State File of `stage`, proven loadable by the production parser before
 *  the G2 fields are added in their raw wire form. */
function stateFileOf(
  stage: SkeletonRepoStage,
  tsTypesText: string,
  bindings: readonly RawExportBinding[],
  skeletons: readonly SkeletonRecord[] | undefined,
): RawStateFile {
  const proven = parseRawStateFile(JSON.stringify({ spec_trace_version: 2, ...graph(stage, tsTypesText) }));
  protectedGraphFixture(proven);
  return {
    ...proven,
    export_bindings: bindings,
    ...(skeletons === undefined ? {} : { skeletons }),
  };
}

const git = (root: string, ...args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8" });

/** A writer of repository paths under `root`, creating parent directories. */
const fileWriter = (root: string) => (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A committer of every workspace change under `root`. */
const committer = (root: string) => (message: string): void => {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", message);
};

/** Initialise the Git repository at `root` and commit its base: the initial
 *  files of `stage`, the plan stamped from `bindings`, and the spec. */
function initRepository(root: string, stage: SkeletonRepoStage, tsTypesText: string, bindings: readonly RawExportBinding[]): void {
  const write = fileWriter(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "loom@example.test");
  git(root, "config", "user.name", "Loom Test");
  write(".gitignore", ".claude/state/\nsubagents/\n");
  for (const [path, text] of Object.entries(initialFiles(stage, tsTypesText))) write(path, text);
  write(PLAN_FILE, planText(bindings));
  write(SPEC_FILE, SPEC_TEXT);
  committer(root)("skeleton fixture base");
}

/** The raw State File at `statePath`: replaced whole on write, read as unknown JSON. */
const stateFileAt = (statePath: string) => Object.freeze({
  writeState: (value: RawStateFile): void => {
    mkdirSync(dirname(statePath), { recursive: true });
    // StateManager leaves the State File read-only; a fixture rewrite replaces it.
    rmSync(statePath, { force: true });
    writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`);
  },
  readState: (): RawStateFile => parseRawStateFile(readFileSync(statePath, "utf8")),
});

/** Point the environment at the fixture repository, saving what it replaces. */
function pointEnvironmentAt(root: string, statePath: string): void {
  if (savedEnvironment === null) savedEnvironment = ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const);
  const subagents = join(root, "subagents");
  mkdirSync(subagents, { recursive: true, mode: 0o700 });
  process.env.LOOM_STATE_PATH = statePath;
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.LOOM_SUBAGENT_DIR = subagents;
}

/** Build one fixture repository, point the environment at its State File, and
 *  return its handle. Call `cleanupSkeletonRepos` in `afterEach`. */
export function skeletonRepo(options: SkeletonRepoOptions = {}): SkeletonRepo {
  const stage = options.stage ?? "implementation-wave";
  const root = canonicalTempDir("loom-skeleton-repo-");
  created.push(root);
  const tsTypesText = options.tsTypesText ?? TS_TYPES_TEXT;
  const bindings = options.bindings === "none" ? [] : EXPORT_BINDINGS;
  initRepository(root, stage, tsTypesText, bindings);
  const write = fileWriter(root);
  const commit = committer(root);

  const statePath = join(root, STATE_FILE);
  const { writeState, readState } = stateFileAt(statePath);
  const seeded = options.skeletons === undefined
    ? undefined
    : [...options.skeletons].sort((a, b) => a.path.localeCompare(b.path));
  writeState(stateFileOf(stage, tsTypesText, bindings, seeded));
  pointEnvironmentAt(root, statePath);

  return Object.freeze({
    root,
    statePath,
    read: (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null),
    write,
    remove: (path: string) => rmSync(join(root, path), { force: true }),
    rawState: readState,
    rewriteState: (edit: (value: RawStateFile) => RawStateFile) => writeState(edit(readState())),
    commit,
    writeContractSources: () => {
      for (const [path, text] of Object.entries(contractSources(tsTypesText))) write(path, text);
    },
    advanceToImplementationWave: () => {
      for (const [path, text] of Object.entries(initialFiles("implementation-wave", tsTypesText))) {
        if (!existsSync(join(root, path))) write(path, text);
      }
      commit("contract Wave 1 frozen");
      const { skeletons } = decodeStateFile(readState());
      writeState(stateFileOf("implementation-wave", tsTypesText, bindings, skeletons ?? undefined));
    },
  });
}

/** A skeleton record as the engine records one: the digest of `bytes`, and of
 *  the contract's frozen types file. */
export function seededRecord(
  path: string,
  bytes: string,
  origin: SkeletonOrigin = "spawn",
): SkeletonRecord {
  const java = path.endsWith(".java");
  return {
    path,
    contract: java ? JAVA_CONTRACT.id : TS_CONTRACT.id,
    language: java ? "java" : "typescript",
    origin,
    engineSha256: sha256(bytes),
    typesSha256: sha256(java ? JAVA_TYPES_TEXT : TS_TYPES_TEXT),
    stale: null,
  };
}

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

/** The implementation spawn the engine owes `taskId` now: its marker prompt
 *  with the retry or attestation appendix the dispatch derivation adds. */
export function spawnFor(raw: RawStateFile, taskId: string): TaskExecutionSpawn {
  const parsed = protectedGraphFixture(raw);
  const owed = parsed.tasks.find(({ id }) => id === taskId);
  if (owed === undefined) throw new Error(`fixture: no Task ${taskId}`);
  const derivation = deriveTaskImplementationDispatch(owed);
  if (derivation.kind !== "dispatch") throw new Error(`fixture: ${taskId} is owed no dispatch (${derivation.kind})`);
  const appendix = derivation.dispatch.promptAppendix;
  return {
    kind: "implementation",
    prompt: appendix === null ? `Task ID: ${taskId}` : `Task ID: ${taskId}\n${appendix}`,
    description: `${taskId} implementation`,
  };
}

// ---------------------------------------------------------------------------
// Decoding engine output (unknown JSON → CT-1 types)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ORIGINS: readonly SkeletonOrigin[] = ["spawn", "contract-stub", "revision"];
const LANGUAGES: readonly SkeletonLanguage[] = ["typescript", "java"];
const UNSUPPORTED_REASONS: readonly UnsupportedReason[] = ["other-extension", "java-outside-main-root", "java-invalid-name", "jvm-non-java"];

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/** A `SkeletonOutcome`, or null when `value` is none. */
function asSkeletonOutcome(value: unknown): SkeletonOutcome | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "skeleton-written":
      return oneOf(ORIGINS, value.origin) ? { kind: "skeleton-written", origin: value.origin } : null;
    case "no-bound-exports":
      return { kind: "no-bound-exports" };
    case "contract-has-no-types-file":
      return { kind: "contract-has-no-types-file" };
    case "unsupported-language":
      return oneOf(UNSUPPORTED_REASONS, value.reason) ? { kind: "unsupported-language", reason: value.reason } : null;
    case "exists-not-skeletonized":
      return { kind: "exists-not-skeletonized" };
    default:
      return null;
  }
}

/** A `SkeletonRecord`, or null when `value` is none. */
function asSkeletonRecord(value: unknown): SkeletonRecord | null {
  if (!isRecord(value)) return null;
  const { path, contract, language, origin, engineSha256, typesSha256, stale } = value;
  if (typeof path !== "string" || typeof contract !== "string") return null;
  if (!oneOf(LANGUAGES, language) || !oneOf(ORIGINS, origin)) return null;
  if (typeof engineSha256 !== "string" || typeof typesSha256 !== "string") return null;
  const parsedStale = stale === null
    ? null
    : isRecord(stale) && typeof stale.revision === "number" ? { revision: stale.revision } : undefined;
  if (parsedStale === undefined) return null;
  return { path, contract, language, origin, engineSha256, typesSha256, stale: parsedStale };
}

const VIOLATION_REASONS: readonly ViolationReason[] = [
  "deleted",
  "renamed",
  "retyped",
  "still-unimplemented",
  "shadows-frozen-adt",
  "re-lists-frozen-variants",
];

/** A `ConformanceViolation`, or null when `value` is none. */
function asConformanceViolation(value: unknown): ConformanceViolation | null {
  if (!isRecord(value) || typeof value.subject !== "string" || !oneOf(VIOLATION_REASONS, value.reason)) return null;
  const remedy = value.remedy === undefined || value.remedy === null ? null : typeof value.remedy === "string" ? value.remedy : undefined;
  return remedy === undefined ? null : { subject: value.subject, reason: value.reason, remedy };
}

const RESOLUTION_KINDS = ["missing-alias", "not-a-function", "generic-alias"] as const;

/** An alias-level `ResolutionProblem` (missing, not a function, generic), or null. */
function asAliasProblem(value: unknown): Extract<ResolutionProblem, { alias: string }> | null {
  if (!isRecord(value) || !oneOf(RESOLUTION_KINDS, value.kind)) return null;
  const { alias, path, typesFile } = value;
  if (typeof alias !== "string" || typeof path !== "string" || typeof typesFile !== "string") return null;
  return { kind: value.kind, alias, path, typesFile };
}

/** Every object anywhere inside `value` that `pick` accepts, depth-first. */
function collect<T>(value: unknown, pick: (candidate: Record<string, unknown>) => T | null): readonly T[] {
  const found: T[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const picked = pick(node);
    if (picked !== null) found.push(picked);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return found;
}

// ---------------------------------------------------------------------------
// The State File decoder: one boundary for every slice the tests read
// ---------------------------------------------------------------------------

/** One stored Task, decoded: its fields as written (for field-level
 *  assertions) and the G2 slices the tests compare. */
type StoredTaskSlices = Readonly<{
  fields: RawStateFile;
  outcomes: ReadonlyMap<string, SkeletonOutcome>;
  proofFailureKinds: readonly string[];
  contractViolations: ReadonlyMap<string, readonly ConformanceViolation[]>;
}>;

/** The State File slices the fixture reads, each in its CT-1 type. */
type StateFileSlices = Readonly<{
  /** Null when the State File carries no `skeletons` key. */
  skeletons: readonly SkeletonRecord[] | null;
  tasks: ReadonlyMap<string, StoredTaskSlices>;
}>;

/** A State File that is not the shape its wire defines fails the test loudly:
 *  a malformed slice is an engine defect, never a slice to skip. */
const malformed = (what: string, value: unknown): never => {
  throw new Error(`fixture: the State File's ${what} is malformed: ${JSON.stringify(value)}`);
};

/** `value` decoded by `decode`, or a refusal naming `what`. */
const decoded = <T>(decode: (value: unknown) => T | null, value: unknown, what: string): T =>
  decode(value) ?? malformed(what, value);

/** An optional array field's entries: none when the field is absent. */
const entriesOf = (value: unknown, what: string): readonly unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : malformed(what, value);

/** The State File's bytes as its JSON object. */
function parseRawStateFile(text: string): RawStateFile {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : malformed("top level", parsed);
}

/** The failures of a stored Proof: none when the Task carries no Proof. */
function proofFailuresOf(proof: unknown, taskId: string): readonly Readonly<{ kind: string; failure: RawStateFile }>[] {
  if (proof === undefined) return [];
  if (!isRecord(proof)) return malformed(`Task ${taskId} proof`, proof);
  return entriesOf(proof.failures, `Task ${taskId} proof failures`).map((failure) =>
    isRecord(failure) && typeof failure.kind === "string"
      ? { kind: failure.kind, failure }
      : malformed(`Task ${taskId} proof failure`, failure));
}

function decodeStoredTask(value: unknown): readonly [string, StoredTaskSlices] {
  if (!isRecord(value) || typeof value.id !== "string") return malformed("Task", value);
  const id = value.id;
  const outcomes = entriesOf(value.skeleton_outcomes, `Task ${id} skeleton_outcomes`).map((entry) =>
    isRecord(entry) && typeof entry.path === "string"
      ? [entry.path, decoded(asSkeletonOutcome, entry.outcome, `Task ${id} skeleton outcome at ${entry.path}`)] as const
      : malformed(`Task ${id} skeleton outcome`, entry));
  const failures = proofFailuresOf(value.proof, id);
  const violated = failures.filter(({ kind }) => kind === "declared-artifact-contract-violated").map(({ failure }) =>
    typeof failure.artifact === "string" && Array.isArray(failure.violations)
      ? [
          failure.artifact,
          failure.violations.map((entry) => decoded(asConformanceViolation, entry, `Task ${id} violation in ${String(failure.artifact)}`)),
        ] as const
      : malformed(`Task ${id} contract-violated failure`, failure));
  return [id, {
    fields: value,
    outcomes: new Map(outcomes),
    proofFailureKinds: failures.map(({ kind }) => kind),
    contractViolations: new Map(violated),
  }];
}

/** Decode the State File slices the fixture reads, refusing any malformed one. */
function decodeStateFile(raw: RawStateFile): StateFileSlices {
  return {
    skeletons: raw.skeletons === undefined
      ? null
      : entriesOf(raw.skeletons, "skeletons").map((entry) => decoded(asSkeletonRecord, entry, "skeleton record")),
    tasks: new Map(entriesOf(raw.tasks, "tasks").map(decodeStoredTask)),
  };
}

/** The decoded slices of `taskId`. */
function taskSlices(raw: RawStateFile, taskId: string): StoredTaskSlices {
  const found = decodeStateFile(raw).tasks.get(taskId);
  if (found === undefined) throw new Error(`fixture: the State File holds no Task ${taskId}`);
  return found;
}

/** Every skeleton record the State File holds, by path. */
export function recordedSkeletons(raw: RawStateFile): ReadonlyMap<string, SkeletonRecord> {
  return new Map((decodeStateFile(raw).skeletons ?? []).map((record) => [record.path, record] as const));
}

/** The skeleton outcomes the State File recorded on `taskId`, by path. */
export const recordedOutcomes = (raw: RawStateFile, taskId: string): ReadonlyMap<string, SkeletonOutcome> =>
  taskSlices(raw, taskId).outcomes;

/** One stored Task of the raw State File, as written. */
export const storedTask = (raw: RawStateFile, taskId: string): RawStateFile => taskSlices(raw, taskId).fields;

/** The kinds of every failure of `taskId`'s stored Proof (empty when it has none). */
export const proofFailureKinds = (raw: RawStateFile, taskId: string): readonly string[] =>
  taskSlices(raw, taskId).proofFailureKinds;

/** Every `declared-artifact-contract-violated` failure of `taskId`'s stored
 *  Proof: its violations, by artifact. */
export const contractViolations = (raw: RawStateFile, taskId: string): ReadonlyMap<string, readonly ConformanceViolation[]> =>
  taskSlices(raw, taskId).contractViolations;

/** A violation's subject and reason, the pair every assertion compares. */
export const subjectAndReason = ({ subject, reason }: ConformanceViolation): string => `${subject}: ${reason}`;

// ---------------------------------------------------------------------------
// Entry-point drivers: settlement, status, brief
// ---------------------------------------------------------------------------

/** Settle one registered attempt through `settleExactImplementation`, as the
 *  Claude stop shell does: the agent changed `modified`, reported a trusted
 *  pass, and the ledger read no red-then-green events. */
export async function settleAttempt(
  repo: SkeletonRepo,
  authority: ImplementationAttemptAuthority,
  modified: readonly string[],
  taskCompleted = true,
): Promise<void> {
  const observedAt = parseIsoInstant(new Date().toISOString(), "fixture settlement instant");
  if (!observedAt.ok) throw new Error(observedAt.error.errors.join("; "));
  const manager = StateManager.fromPath(repo.statePath);
  if (manager === null) throw new Error(`fixture: no State File at ${repo.statePath}`);
  await manager.update((state) => settleExactImplementation(state, {
    transport: "Claude",
    authority,
    observedAt: observedAt.value,
    parserModifiedPaths: modified,
    parserPathLabel: "skeleton fixture result paths",
    taskCompleted,
    testResult: { verdict: "trusted-pass" },
    testEvidence: "skeleton fixture pass",
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    ledger: { kind: "read", events: [] },
  }, productionExactSettlementPorts(repo.root, repo.statePath)).application.state);
}

export type CliRun = Readonly<{ stdout: string; stderr: string; status: number | null }>;

/** `helper orchestration status [--json]`, run exactly as an operator types it. */
export function orchestrationStatus(repo: SkeletonRepo, asJson: boolean): CliRun {
  const result = spawnSync("bun", ["engine/src/cli.ts", "helper", "orchestration", "status", ...(asJson ? ["--json"] : [])], {
    cwd: resolve(LOOM_PACKAGE_ROOT),
    env: { ...process.env, LOOM_STATE_PATH: repo.statePath, NO_COLOR: "1" },
    input: "",
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/** The `--json` status document, as unknown JSON. */
export function statusDocument(repo: SkeletonRepo): unknown {
  const run = orchestrationStatus(repo, true);
  try {
    return JSON.parse(run.stdout) as unknown;
  } catch {
    throw new Error(`status --json printed no JSON (exit ${run.status}): ${run.stderr}${run.stdout}`);
  }
}

/** Every value the status document carries under a `skeletons` key. */
const skeletonReports = (document: unknown): readonly unknown[] =>
  collect(document, (node) => ("skeletons" in node ? { report: node.skeletons } : null)).map(({ report }) => report);

/** Every `{ path, outcome }` the status document's skeleton report lists. */
export function statusOutcomes(document: unknown): readonly Readonly<{ path: string; outcome: SkeletonOutcome }>[] {
  return skeletonReports(document).flatMap((report) => collect(report, (node) => {
    if (typeof node.path !== "string") return null;
    const outcome = asSkeletonOutcome(node.outcome);
    return outcome === null ? null : { path: node.path, outcome };
  }));
}

/** Every path the status document's skeleton report flags stale, with the revision. */
export function statusStaleFlags(document: unknown): readonly Readonly<{ path: string; revision: number }>[] {
  return skeletonReports(document).flatMap((report) => collect(report, (node) =>
    typeof node.path === "string" && isRecord(node.stale) && typeof node.stale.revision === "number"
      ? { path: node.path, revision: node.stale.revision }
      : null));
}

/** Every alias-level stage-two problem the status document's skeleton report names. */
export function statusAliasProblems(document: unknown): readonly Extract<ResolutionProblem, { alias: string }>[] {
  return skeletonReports(document).flatMap((report) => collect(report, asAliasProblem));
}

/** The rendered implementation brief of `taskId` (the shell behind `helper
 *  orchestration brief` and the spawn gate's marker expansion). */
export function briefOf(repo: SkeletonRepo, taskId: string): string {
  const rendered = renderTaskImplementationBrief(repo.statePath, LOOM_PACKAGE_ROOT, { taskId, operatorNotes: [] });
  if (!rendered.ok) throw new Error(`brief of ${taskId} refused: ${rendered.error}`);
  return rendered.value.prompt;
}

/** The exact render strings of the five skeleton outcomes and the stale flag (AD-13, FR-033). */
export const OUTCOME_TEXT = Object.freeze({
  written: "skeleton written",
  noBoundExports: "no bound exports, no skeleton",
  noTypesFile: "contract has no types file, no skeletons",
  unsupported: "unsupported language, no skeleton",
  exists: "exists, not skeletonized",
  stale: "stale against revised contract",
});

const matches = (text: string, needle: string | RegExp): boolean =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text);

/** Whether one line of `text` carries every needle. */
export const someLine = (text: string, ...needles: readonly (string | RegExp)[]): boolean =>
  text.split("\n").some((line) => needles.every((needle) => matches(line, needle)));

/** Whether one blank-line-separated paragraph of `text` carries every needle. */
export const someParagraph = (text: string, ...needles: readonly (string | RegExp)[]): boolean =>
  text.split(/\n[ \t]*\n/).some((paragraph) => needles.every((needle) => matches(paragraph, needle)));
