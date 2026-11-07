/**
 * INV-6 matrix: which paths are supported skeleton targets, and in which
 * language, is decided only by `core/skeleton/language.ts`'s
 * `skeletonLanguageOf`.
 *
 * Owner rows (T9): the plan's path table (`.ts`, `.tsx`, `.mts`, `.cts`,
 * `src/main/java/a/b/C.java`, `src/test/java/C.java`, `lib/C.java`, `.kt`,
 * `.scala`, `.rs`) plus the edges the predicate decides (declaration files,
 * the default Java package, a module-prefixed Java root, invalid and reserved
 * Java names, extensionless and dot-file basenames). The owner is also the
 * only constructor of the type-level `SkeletonTarget` brand: a source scan
 * fails on a type assertion to a target type anywhere else.
 *
 * Sibling rows (T9): the same table through `outcomes.ts` (AD-13 step 4: a
 * bound absent path is `skeleton-written` exactly when supported, else
 * `unsupported-language` with the owner's reason) and `scope.ts` (a bound
 * production file is in the conformance scope exactly when supported, with
 * the owner's target, Java package included).
 *
 * Sibling rows (T11): the same table through the spawn materialization
 * (`materializeTaskSkeletons` over a temp repository: a bound absent path is
 * written exactly when supported — a TypeScript skeleton, or a Java skeleton
 * declaring the owner's package and class — else nothing is written and the
 * outcome is `unsupported-language` with the owner's reason) and the
 * frozen-surface observation (`observeFrozenSurface` reads a types file at
 * the path with the TypeScript or Java reader exactly when the owner says so,
 * the Java package included, else refuses it naming the owner's reason).
 *
 * Sibling rows (T13): the same table through the contract stub step
 * (`materializeContractStubs` at the contract Task's stop: a bound absent path
 * is stubbed exactly when supported, with the owner's language, package and
 * class, else nothing is written or recorded) and the revision refresh
 * (`refreshRevisedSkeletons`: an untouched recorded skeleton is regenerated
 * exactly when supported, else left byte-identical).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { knownSkeletonOutcomes } from "../fixtures/known-skeleton-outcomes";
import { conformanceScope } from "../../src/core/skeleton/scope";
import type { ExportBinding, Identifier, UnsupportedReason } from "../../src/core/skeleton/types";
import type { Task, TaskGraph } from "../../src/types";
import { refreshRevisedSkeletons } from "../../src/orchestration/skeleton-revision";
import { materializeContractStubs } from "../../src/orchestration/contract-stub-materialization";
import { observeFrozenSurface } from "../../src/orchestration/frozen-surface-observation";
import { materializeTaskSkeletons } from "../../src/orchestration/skeleton-materialization";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contentDigest, digest } from "../fixtures/acceptance-fixtures";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

type Row =
  | Readonly<{ path: string; verdict: "typescript" }>
  | Readonly<{ path: string; verdict: "java"; package: string | null; className: string }>
  | Readonly<{ path: string; verdict: "unsupported"; reason: UnsupportedReason }>;

/** The plan's INV-6 path table, then the owner's edge rows. */
const TABLE: readonly Row[] = [
  { path: "src/order/pricing.ts", verdict: "typescript" },
  { path: "src/ui/price-tag.tsx", verdict: "typescript" },
  { path: "src/order/pricing.mts", verdict: "typescript" },
  { path: "src/order/pricing.cts", verdict: "typescript" },
  { path: "src/main/java/a/b/C.java", verdict: "java", package: "a.b", className: "C" },
  { path: "src/test/java/C.java", verdict: "unsupported", reason: "java-outside-main-root" },
  { path: "lib/C.java", verdict: "unsupported", reason: "java-outside-main-root" },
  { path: "src/main/kotlin/a/C.kt", verdict: "unsupported", reason: "jvm-non-java" },
  { path: "src/main/scala/a/C.scala", verdict: "unsupported", reason: "jvm-non-java" },
  { path: "src/order/pricing.rs", verdict: "unsupported", reason: "other-extension" },
  // Edges the owner decides.
  { path: "pricing.ts", verdict: "typescript" },
  { path: "src/order/globals.d.ts", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/globals.d.mts", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/globals.d.cts", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/.ts", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/pricing", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/pricing.js", verdict: "unsupported", reason: "other-extension" },
  { path: "src/order/pricing.TS", verdict: "unsupported", reason: "other-extension" },
  { path: "build.gradle.kts", verdict: "unsupported", reason: "jvm-non-java" },
  { path: "src/main/java/C.java", verdict: "java", package: null, className: "C" },
  { path: "billing/src/main/java/com/acme/Invoices.java", verdict: "java", package: "com.acme", className: "Invoices" },
  { path: "src/main/java/$a/_b/C$1.java", verdict: "java", package: "$a._b", className: "C$1" },
  { path: "src/main/java/a/b/src/main/java/C.java", verdict: "java", package: "a.b.src.main.java", className: "C" },
  { path: "src/main/javax/C.java", verdict: "unsupported", reason: "java-outside-main-root" },
  { path: "src/java/main/C.java", verdict: "unsupported", reason: "java-outside-main-root" },
  { path: "main/java/C.java", verdict: "unsupported", reason: "java-outside-main-root" },
  { path: "src/main/java/com/my-co/C.java", verdict: "unsupported", reason: "java-invalid-name" },
  { path: "src/main/java/com/class/C.java", verdict: "unsupported", reason: "java-invalid-name" },
  { path: "src/main/java/com/1st/C.java", verdict: "unsupported", reason: "java-invalid-name" },
  { path: "src/main/java/com/acme/enum.java", verdict: "unsupported", reason: "java-invalid-name" },
  { path: "src/main/java/com/acme/My-Class.java", verdict: "unsupported", reason: "java-invalid-name" },
  { path: "src/main/java/com/acme/.java", verdict: "unsupported", reason: "other-extension" },
];

const expected = (row: Row) => {
  switch (row.verdict) {
    case "typescript":
      return { kind: "supported", language: "typescript", path: row.path };
    case "java":
      return { kind: "supported", language: "java", path: row.path, package: row.package, className: row.className };
    case "unsupported":
      return { kind: "unsupported", path: row.path, reason: row.reason };
  }
};

const TYPES = "src/contract/types.ts";

const frozenContract = (): AcceptanceContract => ({
  schemaVersion: 1,
  id: "CT-1",
  title: "CT-1 title",
  statement: "CT-1 behaves as declared.",
  contractTask: "T1",
  types: { kind: "file", path: TYPES },
  acceptance: [{ path: "tests/ct-1.acceptance.test.ts", anchors: ["FR-001"] }],
  supportedDomain: null,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: TYPES, sha256: digest("a") }],
    roster: [{ file: "tests/ct-1.acceptance.test.ts", name: "FR-001: decides", anchors: ["FR-001"] }],
  },
  revisions: [],
});

const holder = (path: string): Task =>
  taskFixture({
    id: "T2",
    description: "T2",
    agent: "code-implementer-agent",
    wave: 2,
    depends_on: ["T1"],
    file_list: [path],
    spec_anchors: [],
    spec_contributions: [],
    new_tests_required: false,
  });

/** Names and aliases do not matter to the language decision; bindings.ts mints them in production. */
const bound = (path: string): ExportBinding => ({
  path,
  contract: "CT-1",
  exports: [{ name: "priceOrder" as Identifier, alias: "PriceOrderFn" as Identifier }],
});

const graphBinding = (path: string): TaskGraph => ({
  ...graphFixture([holder(path)]),
  acceptance_contracts: [frozenContract()],
  export_bindings: [bound(path)],
});

describe("INV-6 owner: skeletonLanguageOf", () => {
  for (const row of TABLE) {
    it(`${row.path} is ${row.verdict === "unsupported" ? `unsupported (${row.reason})` : row.verdict}`, () => {
      expect(skeletonLanguageOf(row.path)).toEqual(expected(row));
    });
  }
});

describe("INV-6 owner: the only constructor of the SkeletonTarget brand", () => {
  const REPO_ROOT = resolve(__dirname, "../../..");
  const OWNER = "engine/src/core/skeleton/language.ts";
  const ASSERTION = /\bas\s+(?:Ts|Java)?SkeletonTarget\b/g;

  /** Every TypeScript source under a repository directory, node_modules excluded. */
  const sourcesUnder = (directory: string): readonly string[] =>
    (readdirSync(join(REPO_ROOT, directory), { recursive: true, encoding: "utf8" }))
      .filter((entry) => /\.(?:m|c)?tsx?$/.test(entry) && !entry.split("/").includes("node_modules"))
      .map((entry) => `${directory}/${entry}`);

  it("no module but language.ts asserts a value to a target type, and language.ts mints one per language", () => {
    const assertions = ["engine/src", "engine/tests", "pi"].flatMap(sourcesUnder).flatMap((path) =>
      [...readFileSync(join(REPO_ROOT, path), "utf8").matchAll(ASSERTION)].map(() => path));
    expect(assertions.filter((path) => path !== OWNER)).toEqual([]);
    expect(assertions.filter((path) => path === OWNER)).toHaveLength(2);
  });
});

describe("INV-6 sibling: skeletonOutcomesOf (AD-13 step 4) agrees with the owner", () => {
  for (const row of TABLE) {
    it(`${row.path}, bound and absent`, () => {
      const [only, ...rest] = knownSkeletonOutcomes(graphBinding(row.path), "T2", new Map());
      expect(rest).toEqual([]);
      expect(only).toEqual({
        path: row.path,
        outcome: row.verdict === "unsupported"
          ? { kind: "unsupported-language", reason: row.reason }
          : { kind: "skeleton-written", origin: "spawn" },
      });
    });
  }
});

describe("INV-6 sibling: conformanceScope agrees with the owner", () => {
  for (const row of TABLE) {
    it(`${row.path}, bound to a frozen contract`, () => {
      const graph = graphBinding(row.path);
      const scope = conformanceScope(graph, graph.tasks[0]!);
      if (row.verdict === "unsupported") {
        expect(scope).toEqual({ kind: "not-owed", reason: "no-file-in-scope" });
      } else {
        expect(scope).toEqual({
          kind: "owed",
          contracts: [frozenContract()],
          bindings: [bound(row.path)],
          files: [expected(row)],
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// I/O siblings over a temp repository
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRepo = (files: Readonly<Record<string, string>>): string => {
  const root = canonicalTempDir("loom-skeleton-language-matrix-");
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const readAt = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;

const TS_TYPES_TEXT = "export type PriceOrderFn = (raw: string) => string;\n";
const ACCEPTANCE = "tests/ct-1.acceptance.test.ts";
const ACCEPTANCE_TEXT = "it(\"FR-001: decides\", () => {});\n";
const JAVA_TYPES = "src/main/java/com/acme/Contract.java";

/** A Java holder nesting one functional interface `PriceOrderFn`. */
const javaTypesText = (javaPackage: string | null, holderName: string): string =>
  `${javaPackage === null ? "" : `package ${javaPackage};\n\n`}public interface ${holderName} {\n` +
  "    @FunctionalInterface\n    interface PriceOrderFn {\n        String apply(String raw);\n    }\n}\n";
const JAVA_TYPES_TEXT = javaTypesText("com.acme", "Contract");

/** CT-1 freezes the TypeScript types file, CT-2 the Java one, both stamped over the bytes on disk. */
const stampedContract = (id: string, typesPath: string, typesText: string): AcceptanceContract => ({
  ...frozenContract(),
  id,
  types: { kind: "file", path: typesPath },
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: typesPath, sha256: contentDigest(typesText) }, { path: ACCEPTANCE, sha256: contentDigest(ACCEPTANCE_TEXT) }],
    roster: [{ file: ACCEPTANCE, name: "FR-001: decides", anchors: ["FR-001"] }],
  },
});

/** The row's path bound to the contract of its own language (TypeScript for unsupported rows). */
const materializationGraph = (row: Row): TaskGraph => ({
  ...graphFixture([holder(row.path)]),
  acceptance_contracts: [stampedContract("CT-1", TYPES, TS_TYPES_TEXT), stampedContract("CT-2", JAVA_TYPES, JAVA_TYPES_TEXT)],
  export_bindings: [{ ...bound(row.path), contract: row.verdict === "java" ? "CT-2" : "CT-1" }],
});

describe("INV-6 sibling: materializeTaskSkeletons agrees with the owner", () => {
  for (const row of TABLE) {
    it(`${row.path}, bound and absent`, () => {
      const root = tempRepo({ [TYPES]: TS_TYPES_TEXT, [JAVA_TYPES]: JAVA_TYPES_TEXT, [ACCEPTANCE]: ACCEPTANCE_TEXT });
      const result = materializeTaskSkeletons(root, materializationGraph(row), ["T2"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const bytes = readAt(root, row.path);
      const outcomes = result.value.outcomes.get("T2");
      switch (row.verdict) {
        case "typescript":
          expect(outcomes).toEqual([{ path: row.path, outcome: { kind: "skeleton-written", origin: "spawn" } }]);
          expect(bytes).toContain("export const priceOrder: PriceOrderFn = () => {");
          expect(result.value.records.map(({ path, language }) => [path, language])).toEqual([[row.path, "typescript"]]);
          break;
        case "java":
          expect(outcomes).toEqual([{ path: row.path, outcome: { kind: "skeleton-written", origin: "spawn" } }]);
          expect(bytes).toContain(`public final class ${row.className} {`);
          if (row.package === null) expect(bytes).not.toContain("package ");
          else expect(bytes).toContain(`package ${row.package};\n`);
          expect(result.value.records.map(({ path, language }) => [path, language])).toEqual([[row.path, "java"]]);
          break;
        case "unsupported":
          expect(outcomes).toEqual([{ path: row.path, outcome: { kind: "unsupported-language", reason: row.reason } }]);
          expect(bytes).toBeNull();
          expect(result.value.records).toEqual([]);
          break;
      }
    });
  }
});

describe("INV-6 sibling: observeFrozenSurface picks the reader the owner names", () => {
  for (const row of TABLE) {
    it(`a types file at ${row.path}`, () => {
      const text = row.verdict === "java" ? javaTypesText(row.package, row.className) : TS_TYPES_TEXT;
      const root = tempRepo({ [row.path]: text });
      const observed = observeFrozenSurface(root, { ...frozenContract(), types: { kind: "file", path: row.path } }, "current");
      switch (row.verdict) {
        case "typescript":
          expect(observed.ok && [observed.value.language, observed.value.path]).toEqual(["typescript", row.path]);
          break;
        case "java":
          expect(observed.ok && observed.value.language === "java" && [observed.value.package, observed.value.holder])
            .toEqual([row.package, row.className]);
          break;
        case "unsupported":
          expect(observed.ok).toBe(false);
          if (!observed.ok) {
            expect(observed.error).toMatchObject({ kind: "types-unparseable", typesFile: row.path });
            expect(JSON.stringify(observed.error)).toContain(row.reason);
          }
          break;
      }
    });
  }
});

/** What a written skeleton at the row's path must say, per the owner's verdict. */
function expectOwnersTarget(row: Row, bytes: string | null): void {
  switch (row.verdict) {
    case "typescript":
      expect(bytes).toContain("export const priceOrder: PriceOrderFn = () => {");
      break;
    case "java":
      expect(bytes).toContain(`public final class ${row.className} {`);
      if (row.package === null) expect(bytes).not.toContain("package ");
      else expect(bytes).toContain(`package ${row.package};\n`);
      break;
    case "unsupported":
      throw new Error(`${row.path} is no skeleton target`);
  }
}

/** A State File store over one in-memory graph: the stub step's port, faked. */
function storeOver(graph: TaskGraph) {
  let current: TaskGraph = graph;
  return {
    load: () => current,
    getPath: () => "/unused/state.json",
    updateAndReturn: async <T,>(fn: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>): Promise<T> => {
      const produced = fn(current);
      current = produced.state;
      return produced.value;
    },
    current: (): TaskGraph => current,
  };
}

/** T1, the contract Task that writes both contracts' types files. */
const CONTRACT_TASK: Task = taskFixture({
  id: "T1",
  description: "T1",
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: [],
  file_list: [TYPES, JAVA_TYPES, "tests/ct-1.acceptance.test.ts"],
  spec_anchors: [],
  spec_contributions: [],
  new_tests_required: false,
});

/** The contract Wave: both contracts await red, T1 is their contract Task, and the row's path is bound. */
const contractWaveGraph = (row: Row): TaskGraph => {
  const graph = materializationGraph(row);
  return {
    ...graph,
    tasks: [CONTRACT_TASK, ...graph.tasks],
    acceptance_contracts: (graph.acceptance_contracts ?? []).map((contract) => ({ ...contract, freeze: { state: "awaiting-red" } })),
  };
};

describe("INV-6 sibling: materializeContractStubs agrees with the owner", () => {
  for (const row of TABLE) {
    it(`${row.path}, bound and absent at the contract Task's stop`, async () => {
      const root = tempRepo({ [TYPES]: TS_TYPES_TEXT, [JAVA_TYPES]: JAVA_TYPES_TEXT, [ACCEPTANCE]: ACCEPTANCE_TEXT });
      const store = storeOver(contractWaveGraph(row));
      const result = await materializeContractStubs(root, store, "T1");
      expect(result.ok && result.value.problems).toEqual([]);
      const records = store.current().skeletons ?? [];
      if (row.verdict === "unsupported") {
        expect(readAt(root, row.path)).toBeNull();
        expect(records).toEqual([]);
      } else {
        expectOwnersTarget(row, readAt(root, row.path));
        expect(records.map(({ path, language, origin }) => [path, language, origin])).toEqual([[row.path, row.verdict, "contract-stub"]]);
      }
    });
  }
});

const OLD_SKELETON = "// the engine's bytes from before the revision\n";

/** Wave 2 after a revision of the row's contract: an engine-written skeleton record at the row's path. */
const revisionGraph = (row: Row): TaskGraph => ({
  ...materializationGraph(row),
  skeletons: [{
    path: row.path,
    contract: row.verdict === "java" ? "CT-2" : "CT-1",
    language: row.verdict === "java" ? "java" : "typescript",
    origin: "spawn",
    engineSha256: contentDigest(OLD_SKELETON),
    typesSha256: contentDigest("the types from before the revision"),
    stale: null,
  }],
});

describe("INV-6 sibling: refreshRevisedSkeletons agrees with the owner", () => {
  for (const row of TABLE) {
    it(`${row.path}, an untouched skeleton of a revised contract`, () => {
      const root = tempRepo({ [TYPES]: TS_TYPES_TEXT, [JAVA_TYPES]: JAVA_TYPES_TEXT, [ACCEPTANCE]: ACCEPTANCE_TEXT, [row.path]: OLD_SKELETON });
      const result = refreshRevisedSkeletons(root, revisionGraph(row), row.verdict === "java" ? "CT-2" : "CT-1");
      expect(result.ok && result.value.bindingProblems).toEqual([]);
      const settled = result.ok
        ? [...result.value.settlements].map(([path, settlement]) =>
          settlement.kind === "refreshed" ? [path, settlement.kind, settlement.skeleton.language] : [path, settlement.kind])
        : null;
      if (row.verdict === "unsupported") {
        expect(settled).toEqual([]);
        expect(readAt(root, row.path)).toBe(OLD_SKELETON);
      } else {
        expectOwnersTarget(row, readAt(root, row.path));
        expect(settled).toEqual([[row.path, "refreshed", row.verdict]]);
      }
    });
  }
});
