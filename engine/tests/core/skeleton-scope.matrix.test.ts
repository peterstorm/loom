/**
 * INV-5 matrix: which files of which Task owe the signature or ADT check, and
 * against which contracts, is decided only by `core/skeleton/scope.ts`'s
 * `conformanceScope`.
 *
 * Owner rows (T9), the plan's named cases first: a graph populated before G2
 * (no `export_bindings` stamp, AD-14: not checked retroactively), an attested Task, a
 * `documentation-only` Task (and `generated-artifact`), a claimant of a
 * contract with `Types file: none`, a test file in `file_list`, a file that
 * existed at Wave start, and a binder whose contract is still
 * `awaiting-red`. Then the rest of AD-11: other regression waivers still owe;
 * `revised` contracts count; a claimant owes the ADT check over files of the
 * types file's language only; a binder owes the signature check over its
 * bound files whatever their language; bindings of out-of-scope contracts and
 * of other Tasks' paths are dropped; frozen paths are never subjects; the
 * contract Task owes nothing; unsupported files are never in scope.
 *
 * Sibling rows (T12): the settlement observation `observeContractConformance`
 * runs every case above over files on disk that each break the frozen
 * contract, and judges exactly the scope's files, or reports `not-owed`
 * exactly when the scope does.
 *
 * Sibling rows (T14): the implementation brief's `renderFrozenSignatures`,
 * fed every case above, names the frozen ADTs of exactly the scope's
 * contracts, lists the bound exports of exactly the scope's bindings, and
 * states the frozen-signature and marker rules exactly when the scope binds
 * an export — nothing at all when the scope is `not-owed`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { conformanceScope, type ConformanceScope, type SkeletonGraph } from "../../src/core/skeleton/scope";
import { renderFrozenSignatures } from "../../src/core/implementation-brief";
import type { DomainResult } from "../../src/core/orchestration-contract";
import type { ExportBinding, FrozenSurface, Identifier } from "../../src/core/skeleton/types";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { StoredVerificationPolicy } from "../../src/core/verification-policy";
import type { Task, TaskCommonMetadata } from "../../src/types";
import { observeContractConformance } from "../../src/orchestration/contract-conformance-observation";
import { digest } from "../fixtures/acceptance-fixtures";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  cleanupSkeletonRepos,
  JAVA_TYPES_TEXT,
  skeletonRepo,
  spawnFor,
  storedTask,
  TS_CONTRACT as REPO_TS_CONTRACT,
  TS_TYPES_TEXT,
} from "../fixtures/skeleton-repo";
import { parseIsoInstant } from "../../src/core/implementation-completion";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import { productionExactSettlementPorts, settleExactImplementation } from "../../src/handlers/helpers/exact-implementation-settlement";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { StateManager } from "../../src/state-manager";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const TS_TYPES = "src/order/types.ts";
const JAVA_TYPES = "src/main/java/com/acme/OrderContract.java";

const contract = (
  id: string,
  types: AcceptanceContract["types"],
  anchor: string,
  freeze: "awaiting-red" | "frozen" | "revised" = "frozen",
  contractTask = "T1",
): AcceptanceContract => {
  const acceptance = `tests/${id}.acceptance.test.ts`;
  const paths = [{ path: acceptance, sha256: digest("a") }] as const;
  return {
    schemaVersion: 1,
    id,
    title: `${id} title`,
    statement: `${id} behaves as declared.`,
    contractTask,
    types,
    acceptance: [{ path: acceptance, anchors: [anchor] }],
    supportedDomain: null,
    freeze: freeze === "awaiting-red"
      ? { state: "awaiting-red" }
      : freeze === "frozen"
      ? { state: "frozen", wave: 1, paths, roster: [{ file: acceptance, name: `${anchor}: decides`, anchors: [anchor] }] }
      : { state: "revised", paths },
    revisions: [],
  };
};

const TS_CONTRACT = contract("CT-1", { kind: "file", path: TS_TYPES }, "FR-001");
const JAVA_CONTRACT = contract("CT-2", { kind: "file", path: JAVA_TYPES }, "FR-002");
const TYPELESS = contract("CT-3", { kind: "none", reason: "a pure CLI slice" }, "FR-003");
const AWAITING = contract("CT-4", { kind: "file", path: "src/later/types.ts" }, "FR-004", "awaiting-red", "T0");
const REVISED = contract("CT-5", { kind: "file", path: "src/revised/types.ts" }, "FR-005", "revised");
const UNSUPPORTED_TYPES = contract("CT-6", { kind: "file", path: "src/legacy/types.rs" }, "FR-006");

const policy = (reason: "documentation-only" | "generated-artifact" | "acceptance-red-window" | "legacy-new-tests-required-false"): StoredVerificationPolicy => ({
  regression: { kind: "waived", reason },
  new_tests: { kind: "waived", reason: reason === "acceptance-red-window" ? "existing-tests-sufficient" : reason },
});

const task = (
  id: string,
  files: readonly string[],
  anchors: readonly string[] = [],
  extra: Partial<TaskCommonMetadata> = {},
): Task =>
  taskFixture({
    id,
    description: id,
    agent: "code-implementer-agent",
    wave: 2,
    depends_on: ["T1"],
    file_list: [...files],
    spec_anchors: [...anchors],
    spec_contributions: [],
    new_tests_required: false,
    ...extra,
  });

const bound = (path: string, contractId: string): ExportBinding => ({
  path,
  contract: contractId,
  exports: [{ name: "priceOrder" as Identifier, alias: "PriceOrderFn" as Identifier }],
});

const ALL_CONTRACTS = [TS_CONTRACT, JAVA_CONTRACT, TYPELESS, AWAITING, REVISED, UNSUPPORTED_TYPES];

const graphOf = (tasks: readonly Task[], bindings: readonly ExportBinding[]): SkeletonGraph => ({
  ...graphFixture([task("T1", [TS_TYPES, JAVA_TYPES, "tests/CT-1.acceptance.test.ts"]), ...tasks]),
  acceptance_contracts: ALL_CONTRACTS,
  export_bindings: bindings,
});

const scopeOf = (subject: Task, bindings: readonly ExportBinding[] = [], others: readonly Task[] = []) =>
  conformanceScope(graphOf([subject, ...others], bindings), subject);

/** The same graph as populated before G2: no `export_bindings` stamp at all. */
const preG2GraphOf = (tasks: readonly Task[]): SkeletonGraph => {
  const { export_bindings: _stamp, ...unstamped } = graphOf(tasks, []);
  return unstamped;
};

const target = (path: string) => skeletonLanguageOf(path);

describe("INV-5 owner: the plan's named cases", () => {
  it("AD-14: a graph populated before G2 owes nothing, even to a claimant with a file of the types file's language", () => {
    const subject = task("T2", ["src/order/pricing.ts", "src/main/java/com/acme/A.java"], ["FR-001", "FR-002"]);
    expect(conformanceScope(preG2GraphOf([subject]), subject)).toEqual({ kind: "not-owed", reason: "pre-g2-graph" });
    // The stamp decides, not what it binds: an empty stamp is a G2 graph, and the claimant owes the ADT check.
    expect(scopeOf(subject)).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT, JAVA_CONTRACT],
      bindings: [],
      files: [target("src/order/pricing.ts"), target("src/main/java/com/acme/A.java")],
    });
  });

  it("AD-14: the missing stamp is decided before any Task exemption", () => {
    const attested = task("T2", ["src/order/pricing.ts"], ["FR-001"], { implementation_attestation: true });
    expect(conformanceScope(preG2GraphOf([attested]), attested)).toEqual({ kind: "not-owed", reason: "pre-g2-graph" });
  });

  it("an attested Task owes nothing, bound or not", () => {
    const subject = task("T2", ["src/order/pricing.ts"], ["FR-001"], { implementation_attestation: true });
    expect(scopeOf(subject, [bound("src/order/pricing.ts", "CT-1")])).toEqual({ kind: "not-owed", reason: "attested" });
  });

  it("a documentation-only Task owes nothing", () => {
    const subject = task("T2", ["src/order/pricing.ts"], ["FR-001"], { verification_policy: policy("documentation-only") });
    expect(scopeOf(subject, [bound("src/order/pricing.ts", "CT-1")])).toEqual({ kind: "not-owed", reason: "documentation-only" });
  });

  it("a generated-artifact Task owes nothing", () => {
    const subject = task("T2", ["src/order/pricing.ts"], ["FR-001"], { verification_policy: policy("generated-artifact") });
    expect(scopeOf(subject, [bound("src/order/pricing.ts", "CT-1")])).toEqual({ kind: "not-owed", reason: "generated-artifact" });
  });

  it("a claimant of a Types-file-none contract owes nothing", () => {
    const subject = task("T2", ["src/cli.ts"], ["FR-003"]);
    expect(scopeOf(subject)).toEqual({ kind: "not-owed", reason: "no-frozen-contract" });
  });

  it("a test file in file_list is never in scope", () => {
    const subject = task("T2", ["src/order/pricing.ts", "src/order/pricing.test.ts"], ["FR-001"]);
    expect(scopeOf(subject)).toEqual({ kind: "owed", contracts: [TS_CONTRACT], bindings: [], files: [target("src/order/pricing.ts")] });
    expect(scopeOf(task("T2", ["src/order/pricing.test.ts"], ["FR-001"]))).toEqual({ kind: "not-owed", reason: "no-file-in-scope" });
  });

  it("the graph's frozen test-file classification, not the engine default, decides which files are tests", () => {
    const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      kind: "loom-verification-manifest", checks: [], schemaVersion: 2, testFileSuffixes: ["Test.java"],
    })));
    if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
    const subject = task("T2", ["src/main/java/com/acme/PricingTest.java", "src/order/pricing.test.ts"], ["FR-002", "FR-001"]);
    const graph: SkeletonGraph = { ...graphOf([subject], []), verification_manifest: frozen.value };
    expect(conformanceScope(graph, subject)).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT, JAVA_CONTRACT],
      bindings: [],
      files: [target("src/order/pricing.test.ts")],
    });
  });

  it("a file that existed at Wave start is checked when in scope", () => {
    const subject = task("T2", ["src/order/legacy.ts"], ["FR-001"], {
      artifact_baseline: [{ artifact: "src/order/legacy.ts", snapshot: { kind: "sha256", digest: "b".repeat(64) } }],
    });
    expect(scopeOf(subject)).toEqual({ kind: "owed", contracts: [TS_CONTRACT], bindings: [], files: [target("src/order/legacy.ts")] });
  });

  it("a binder whose contract is still awaiting-red owes nothing", () => {
    const subject = task("T2", ["src/later/impl.ts"]);
    expect(scopeOf(subject, [bound("src/later/impl.ts", "CT-4")])).toEqual({ kind: "not-owed", reason: "no-frozen-contract" });
  });
});

describe("INV-5 owner: the rest of AD-11", () => {
  it("other regression waivers still owe", () => {
    for (const reason of ["acceptance-red-window", "legacy-new-tests-required-false"] as const) {
      const subject = task("T2", ["src/order/pricing.ts"], [], { verification_policy: policy(reason) });
      expect(scopeOf(subject, [bound("src/order/pricing.ts", "CT-1")])).toEqual({
        kind: "owed",
        contracts: [TS_CONTRACT],
        bindings: [bound("src/order/pricing.ts", "CT-1")],
        files: [target("src/order/pricing.ts")],
      });
    }
  });

  it("a revised contract counts", () => {
    const subject = task("T2", ["src/revised/impl.ts"], ["FR-005"]);
    expect(scopeOf(subject)).toEqual({ kind: "owed", contracts: [REVISED], bindings: [], files: [target("src/revised/impl.ts")] });
  });

  it("a claimant owes the ADT check over files of the types file's language only", () => {
    const subject = task("T2", ["src/order/a.ts", "src/main/java/com/acme/A.java", "src/order/b.tsx"], ["FR-001"]);
    expect(scopeOf(subject)).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT],
      bindings: [],
      files: [target("src/order/a.ts"), target("src/order/b.tsx")],
    });
    const javaClaimant = task("T2", ["src/order/a.ts", "src/main/java/com/acme/A.java"], ["FR-002"]);
    expect(scopeOf(javaClaimant)).toEqual({
      kind: "owed",
      contracts: [JAVA_CONTRACT],
      bindings: [],
      files: [target("src/main/java/com/acme/A.java")],
    });
  });

  it("a claimant of both languages owes both, contracts in graph order", () => {
    const subject = task("T2", ["src/main/java/com/acme/A.java", "src/order/a.ts"], ["FR-002", "FR-001"]);
    expect(scopeOf(subject)).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT, JAVA_CONTRACT],
      bindings: [],
      files: [target("src/main/java/com/acme/A.java"), target("src/order/a.ts")],
    });
  });

  it("a binder owes the signature check over its bound files whatever their language", () => {
    const subject = task("T2", ["src/main/java/com/acme/Bound.java", "src/main/java/com/acme/Free.java", "src/order/free.ts"]);
    expect(scopeOf(subject, [bound("src/main/java/com/acme/Bound.java", "CT-1")])).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT],
      bindings: [bound("src/main/java/com/acme/Bound.java", "CT-1")],
      files: [target("src/main/java/com/acme/Bound.java"), target("src/order/free.ts")],
    });
  });

  it("bindings of out-of-scope contracts and of other Tasks' paths are dropped", () => {
    const subject = task("T2", ["src/order/pricing.ts", "src/later/impl.ts"]);
    const other = task("T3", ["src/order/other.ts"]);
    expect(scopeOf(subject, [
      bound("src/order/other.ts", "CT-1"),
      bound("src/order/pricing.ts", "CT-1"),
      bound("src/later/impl.ts", "CT-4"),
    ], [other])).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT],
      bindings: [bound("src/order/pricing.ts", "CT-1")],
      // The CT-4 file stays in scope, unbound: CT-1's TypeScript ADT check covers it.
      files: [target("src/order/pricing.ts"), target("src/later/impl.ts")],
    });
  });

  it("a binding on another Task's path alone puts no contract in scope", () => {
    const subject = task("T2", ["src/order/pricing.ts"]);
    const other = task("T3", ["src/order/other.ts"]);
    expect(scopeOf(subject, [bound("src/order/other.ts", "CT-1")], [other])).toEqual({ kind: "not-owed", reason: "no-frozen-contract" });
  });

  it("frozen paths are never conformance subjects", () => {
    // T0 writes CT-4's frozen surface and claims CT-1.
    const subject = task("T0", ["src/later/types.ts", "src/order/a.ts", "tests/CT-4.acceptance.test.ts"], ["FR-001"]);
    expect(scopeOf(subject)).toEqual({ kind: "owed", contracts: [TS_CONTRACT], bindings: [], files: [target("src/order/a.ts")] });
    const onlyFrozen = task("T0", ["src/later/types.ts"], ["FR-001"]);
    expect(scopeOf(onlyFrozen)).toEqual({ kind: "not-owed", reason: "no-file-in-scope" });
  });

  it("the contract Task owes nothing for its own contract", () => {
    const subject = task("T1", [TS_TYPES, JAVA_TYPES, "tests/CT-1.acceptance.test.ts"], ["FR-001"]);
    expect(conformanceScope(graphOf([], []), subject)).toEqual({ kind: "not-owed", reason: "no-frozen-contract" });
  });

  it("unsupported files are never in scope, and a types file of no supported language selects no ADT files", () => {
    expect(scopeOf(task("T2", ["src/order/a.rs", "src/order/b.kt"], ["FR-001"]))).toEqual({ kind: "not-owed", reason: "no-file-in-scope" });
    expect(scopeOf(task("T2", ["src/legacy/impl.ts"], ["FR-006"]))).toEqual({ kind: "not-owed", reason: "no-file-in-scope" });
  });

  it("a supported file is matched to its binding through the plan-path rule", () => {
    const subject = task("T2", ["./src/main/java/com/acme/Bound.java"]);
    expect(scopeOf(subject, [bound("src/main/java/com/acme/Bound.java", "CT-1")])).toEqual({
      kind: "owed",
      contracts: [TS_CONTRACT],
      bindings: [bound("src/main/java/com/acme/Bound.java", "CT-1")],
      files: [target("./src/main/java/com/acme/Bound.java")],
    });
  });
});

// ---------------------------------------------------------------------------
// Sibling: the settlement observation (T12)
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupSkeletonRepos();
});

/** Every frozen types file of ALL_CONTRACTS, as its contract Task froze it. */
const TYPES_FILES: Readonly<Record<string, string>> = {
  [TS_TYPES]: TS_TYPES_TEXT,
  "src/later/types.ts": TS_TYPES_TEXT,
  "src/revised/types.ts": TS_TYPES_TEXT,
  [JAVA_TYPES]: JAVA_TYPES_TEXT.replace("package com.acme.order;", "package com.acme;"),
  "src/legacy/types.rs": "pub type OrderId = String;\n",
};

/** A file that breaks every frozen contract of its language: a TypeScript
 *  file shadows the frozen `OrderId` brand, a Java file the frozen `Order`
 *  record; neither declares any bound export. */
const breakingText = (path: string): string =>
  path.endsWith(".java")
    ? `package com.acme;\n\npublic final class ${basename(path, ".java")} {\n    record Order(String id) {}\n}\n`
    : "export interface OrderId {\n  readonly value: string;\n}\n";

const writeAt = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A repository holding every frozen types file and every file of `subject`, each breaking its contract. */
function repositoryFor(subject: Task): string {
  const root = canonicalTempDir("loom-inv5-matrix-");
  roots.push(root);
  for (const [path, text] of Object.entries(TYPES_FILES)) writeAt(root, path, text);
  for (const path of subject.file_list ?? []) if (TYPES_FILES[path] === undefined) writeAt(root, path, breakingText(path));
  return root;
}

type Judgment = Readonly<{ kind: "not-owed" }> | Readonly<{ kind: "judged"; files: readonly string[] }>;

const scopeJudgment = (scope: ConformanceScope): Judgment =>
  scope.kind === "not-owed" ? { kind: "not-owed" } : { kind: "judged", files: scope.files.map(({ path }) => path) };

/** Through the observation: which files settlement judged, read off the violations every judged file carries. */
function observedJudgment(graph: SkeletonGraph, subject: Task): Judgment {
  const observed = observeContractConformance(repositoryFor(subject), graph, subject);
  if (!observed.ok) throw new Error(`observation failed: ${observed.error}`);
  return observed.value.kind === "not-owed" ? { kind: "not-owed" } : { kind: "judged", files: [...observed.value.violations.keys()] };
}

type MatrixCase = Readonly<{
  name: string;
  subject: Task;
  bindings?: readonly ExportBinding[];
  others?: readonly Task[];
  /** False for a graph populated before G2: no `export_bindings` stamp. */
  stamped?: boolean;
  expected: Judgment;
}>;

const matrixGraph = ({ subject, bindings = [], others = [], stamped = true }: MatrixCase): SkeletonGraph =>
  stamped ? graphOf([subject, ...others], bindings) : preG2GraphOf([subject, ...others]);

const MATRIX: readonly MatrixCase[] = [
  {
    name: "a claimant in a graph populated before G2",
    subject: task("T2", ["src/order/pricing.ts", "src/main/java/com/acme/A.java"], ["FR-001", "FR-002"]),
    stamped: false,
    expected: { kind: "not-owed" },
  },
  {
    name: "the same claimant in a G2 graph whose stamp binds nothing",
    subject: task("T2", ["src/order/pricing.ts", "src/main/java/com/acme/A.java"], ["FR-001", "FR-002"]),
    expected: { kind: "judged", files: ["src/order/pricing.ts", "src/main/java/com/acme/A.java"] },
  },
  {
    name: "an attested Task",
    subject: task("T2", ["src/order/pricing.ts"], ["FR-001"], { implementation_attestation: true }),
    bindings: [bound("src/order/pricing.ts", "CT-1")],
    expected: { kind: "not-owed" },
  },
  {
    name: "a documentation-only Task",
    subject: task("T2", ["src/order/pricing.ts"], ["FR-001"], { verification_policy: policy("documentation-only") }),
    bindings: [bound("src/order/pricing.ts", "CT-1")],
    expected: { kind: "not-owed" },
  },
  {
    name: "a generated-artifact Task",
    subject: task("T2", ["src/order/pricing.ts"], ["FR-001"], { verification_policy: policy("generated-artifact") }),
    bindings: [bound("src/order/pricing.ts", "CT-1")],
    expected: { kind: "not-owed" },
  },
  { name: "a claimant of a Types-file-none contract", subject: task("T2", ["src/cli.ts"], ["FR-003"]), expected: { kind: "not-owed" } },
  {
    name: "a test file in file_list",
    subject: task("T2", ["src/order/pricing.ts", "src/order/pricing.test.ts"], ["FR-001"]),
    expected: { kind: "judged", files: ["src/order/pricing.ts"] },
  },
  {
    name: "a file that existed at Wave start",
    subject: task("T2", ["src/order/legacy.ts"], ["FR-001"], {
      artifact_baseline: [{ artifact: "src/order/legacy.ts", snapshot: { kind: "sha256", digest: "b".repeat(64) } }],
    }),
    expected: { kind: "judged", files: ["src/order/legacy.ts"] },
  },
  {
    name: "a binder whose contract is still awaiting-red",
    subject: task("T2", ["src/later/impl.ts"]),
    bindings: [bound("src/later/impl.ts", "CT-4")],
    expected: { kind: "not-owed" },
  },
  {
    name: "a red-window-waived binder",
    subject: task("T2", ["src/order/pricing.ts"], [], { verification_policy: policy("acceptance-red-window") }),
    bindings: [bound("src/order/pricing.ts", "CT-1")],
    expected: { kind: "judged", files: ["src/order/pricing.ts"] },
  },
  {
    name: "a claimant of both languages",
    subject: task("T2", ["src/main/java/com/acme/A.java", "src/order/a.ts"], ["FR-002", "FR-001"]),
    expected: { kind: "judged", files: ["src/main/java/com/acme/A.java", "src/order/a.ts"] },
  },
  {
    name: "a binder of a Java file to the TypeScript contract",
    subject: task("T2", ["src/main/java/com/acme/Bound.java", "src/main/java/com/acme/Free.java", "src/order/free.ts"]),
    bindings: [bound("src/main/java/com/acme/Bound.java", "CT-1")],
    expected: { kind: "judged", files: ["src/main/java/com/acme/Bound.java", "src/order/free.ts"] },
  },
  {
    name: "a binder beside another Task's binding",
    subject: task("T2", ["src/order/pricing.ts", "src/later/impl.ts"]),
    others: [task("T3", ["src/order/other.ts"])],
    bindings: [bound("src/order/other.ts", "CT-1"), bound("src/order/pricing.ts", "CT-1"), bound("src/later/impl.ts", "CT-4")],
    expected: { kind: "judged", files: ["src/order/pricing.ts", "src/later/impl.ts"] },
  },
  {
    name: "a Task whose files include a frozen path",
    subject: task("T0", ["src/later/types.ts", "src/order/a.ts", "tests/CT-4.acceptance.test.ts"], ["FR-001"]),
    expected: { kind: "judged", files: ["src/order/a.ts"] },
  },
  {
    name: "a claimant of a revised contract",
    subject: task("T2", ["src/revised/impl.ts"], ["FR-005"]),
    expected: { kind: "judged", files: ["src/revised/impl.ts"] },
  },
  {
    name: "a claimant of a supported and an unsupported-language types file",
    subject: task("T2", ["src/order/a.ts"], ["FR-001", "FR-006"]),
    expected: { kind: "judged", files: ["src/order/a.ts"] },
  },
  {
    name: "a claimant of an unsupported-language types file alone",
    subject: task("T2", ["src/legacy/impl.ts"], ["FR-006"]),
    expected: { kind: "not-owed" },
  },
];

describe("INV-5 sibling: the settlement observation judges exactly the owner's scope", () => {
  it.each(MATRIX)("$name", (row) => {
    const { subject, expected } = row;
    const graph = matrixGraph(row);
    const scope = scopeJudgment(conformanceScope(graph, subject));
    expect(scope).toEqual(expected);
    expect(observedJudgment(graph, subject)).toEqual(scope);
  });

  it("the graph's frozen test-file classification decides which files settlement judges", () => {
    const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      kind: "loom-verification-manifest", checks: [], schemaVersion: 2, testFileSuffixes: ["Test.java"],
    })));
    if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
    const subject = task("T2", ["src/main/java/com/acme/PricingTest.java", "src/order/pricing.test.ts"], ["FR-002", "FR-001"]);
    const graph: SkeletonGraph = { ...graphOf([subject], []), verification_manifest: frozen.value };
    expect(observedJudgment(graph, subject)).toEqual(scopeJudgment(conformanceScope(graph, subject)));
    expect(observedJudgment(graph, subject)).toEqual({ kind: "judged", files: ["src/order/pricing.test.ts"] });
  });
});

describe("the settlement observation shell", () => {
  const binder = task("T2", ["src/order/pricing.ts"], ["FR-001"]);
  const binderGraph = () => graphOf([binder], [bound("src/order/pricing.ts", "CT-1")]);

  it("FR-018: judges a missing bound file as deleted, never as an infrastructure failure", () => {
    const root = repositoryFor(binder);
    rmSync(join(root, "src/order/pricing.ts"));
    const observed = observeContractConformance(root, binderGraph(), binder);
    expect(observed).toEqual({
      ok: true,
      value: { kind: "judged", violations: new Map([["src/order/pricing.ts", [{ subject: "priceOrder", reason: "deleted", remedy: null }]]]) },
    });
  });

  it("FR-021: a conforming bound file is judged with no violation", () => {
    const root = repositoryFor(binder);
    writeAt(root, "src/order/pricing.ts", `import type { PriceOrderFn } from "./types";\n\nexport const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });\n`);
    expect(observeContractConformance(root, binderGraph(), binder)).toEqual({ ok: true, value: { kind: "judged", violations: new Map() } });
  });

  it("an unreadable frozen types file is an infrastructure failure naming it, never a verdict", () => {
    const root = repositoryFor(binder);
    rmSync(join(root, TS_TYPES));
    mkdirSync(join(root, TS_TYPES));
    const observed = observeContractConformance(root, binderGraph(), binder);
    expect(observed.ok).toBe(false);
    if (!observed.ok) expect(observed.error).toContain(TS_TYPES);
  });

  it("an unreadable repository root is an infrastructure failure", () => {
    const root = repositoryFor(binder);
    rmSync(root, { recursive: true, force: true });
    const observed = observeContractConformance(root, binderGraph(), binder);
    expect(observed.ok).toBe(false);
  });

  it("a not-owed Task reads nothing: the observation stands even without a repository", () => {
    const attested = task("T2", ["src/order/pricing.ts"], ["FR-001"], { implementation_attestation: true });
    expect(observeContractConformance("/nonexistent/loom-inv5", graphOf([attested], []), attested)).toEqual({
      ok: true,
      value: { kind: "not-owed" },
    });
  });

  it("NFR-002: judges a Task with 20 bound files in well under 2 seconds", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `src/order/bound-${index}.ts`);
    const subject = task("T2", paths, ["FR-001"]);
    const graph = graphOf([subject], paths.map((path) => bound(path, "CT-1")));
    const root = repositoryFor(subject);
    const started = performance.now();
    const observed = observeContractConformance(root, graph, subject);
    const elapsed = performance.now() - started;
    expect(observed.ok && observed.value.kind === "judged" ? observed.value.violations.size : -1).toBe(20);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("the observation inside settleExactImplementation", () => {
  it("a conformance read failure blocks settlement as infrastructure, consuming no semantic attempt", async () => {
    const repo = skeletonRepo();
    const registration = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);
    if (registration.kind !== "registered") throw new Error(`registration refused: ${registration.message}`);
    const [authority] = registration.authorities;
    if (authority === undefined) throw new Error("no T4 authority");
    // The frozen types file can no longer be read as a file.
    rmSync(join(repo.root, REPO_TS_CONTRACT.types));
    mkdirSync(join(repo.root, REPO_TS_CONTRACT.types));
    const observedAt = parseIsoInstant(new Date().toISOString(), "settlement instant");
    if (!observedAt.ok) throw new Error(observedAt.error.errors.join("; "));
    const manager = StateManager.fromPath(repo.statePath);
    if (manager === null) throw new Error("no State File");
    let reason: string | undefined;
    await manager.update((state) => {
      const settled = settleExactImplementation(state, {
        transport: "Claude",
        authority,
        observedAt: observedAt.value,
        parserModifiedPaths: [],
        parserPathLabel: "INV-5 matrix result paths",
        taskCompleted: true,
        testResult: { verdict: "trusted-pass" },
        testEvidence: "INV-5 matrix pass",
        proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
        ledger: { kind: "read", events: [] },
      }, productionExactSettlementPorts(repo.root, repo.statePath));
      reason = settled.infrastructureReason;
      return settled.application.state;
    });
    expect(reason).toContain("contract conformance");
    expect(reason).toContain(REPO_TS_CONTRACT.types);
    const stored = storedTask(repo.rawState(), "T4");
    const history = stored.implementation_attempt_history as readonly Record<string, unknown>[];
    expect(history.at(-1)).toMatchObject({ transition: "infrastructure-blocked", consumesSemanticAttempt: false });
    expect(stored.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Sibling: the implementation brief's duty section (T14)
// ---------------------------------------------------------------------------

/** One frozen ADT per types-file contract, named after it, so the brief's
 *  ADT paragraphs say which contracts it put in scope. */
const SURFACES: ReadonlyMap<string, DomainResult<FrozenSurface, string>> = new Map(ALL_CONTRACTS.flatMap((entry) => {
  if (entry.types.kind !== "file") return [];
  const adts = [{ kind: "brand", name: `${entry.id.replace("-", "")}Id` }] as const;
  const surface: FrozenSurface = entry.types.path.endsWith(".java")
    ? { language: "java", path: entry.types.path, package: "com.acme", holder: "OrderContract", aliases: [], adts }
    : { language: "typescript", path: entry.types.path, aliases: [], adts };
  return [[entry.id, { ok: true, value: surface }] as const];
}));

type BriefDuties = Readonly<{ contracts: readonly string[]; boundPaths: readonly string[] }>;

/** What the brief lists as duties: the contracts whose frozen ADTs it names,
 *  and the files whose bound exports it lists. */
function briefDuties(graph: SkeletonGraph, subject: Task): BriefDuties {
  const section = renderFrozenSignatures(subject, { graph, observations: new Map(), surfaces: SURFACES, unresolved: [] });
  const lines = section.split("\n");
  const contracts = [...section.matchAll(/\*\*Frozen ADTs of (CT-\d+)\*\*/g)].map((found) => found[1] ?? "");
  const boundPaths = lines.flatMap((line, index) => {
    const file = /^- `([^`]+)` — /.exec(line)?.[1];
    return file !== undefined && (lines[index + 1] ?? "").startsWith("  - `priceOrder: PriceOrderFn`") ? [file] : [];
  });
  return { contracts, boundPaths };
}

const scopeDuties = (scope: ConformanceScope): BriefDuties =>
  scope.kind === "not-owed"
    ? { contracts: [], boundPaths: [] }
    : { contracts: scope.contracts.map(({ id }) => id), boundPaths: scope.bindings.map(({ path }) => path) };

describe("INV-5 sibling: the brief lists exactly the owner's duties", () => {
  it.each(MATRIX)("$name", (row) => {
    const graph = matrixGraph(row);
    expect(briefDuties(graph, row.subject)).toEqual(scopeDuties(conformanceScope(graph, row.subject)));
  });

  it("names the frozen-signature and marker rules exactly when the scope binds an export", () => {
    for (const row of MATRIX) {
      const { subject } = row;
      const graph = matrixGraph(row);
      const scope = conformanceScope(graph, subject);
      const section = renderFrozenSignatures(subject, { graph, observations: new Map(), surfaces: SURFACES, unresolved: [] });
      const binds = scope.kind === "owed" && scope.bindings.length > 0;
      expect(/signatures are frozen/.test(section), subject.id).toBe(binds);
      expect(section.includes("`unimplemented: <name>`"), subject.id).toBe(binds);
    }
  });
});
