/**
 * INV-4 matrix: each file_list path's skeleton outcome, and whether an
 * existing skeleton is engine-untouched, are decided only by
 * `core/skeleton/outcomes.ts` (`skeletonOutcomesOf` and its `skeletonOutcomes`
 * wrapper, `isUntouchedSkeleton`).
 *
 * Owner rows (T9): one graph and one observation set exercise every step of
 * the AD-13 precedence, and every pair of steps where a lower step would
 * apply if the higher one did not:
 *   1. an untouched engine skeleton (recorded digest, or canonical bytes with
 *      or without a record) → `skeleton-written` with the record's origin, or
 *      `spawn` when adopted without a record;
 *   2. any other present path → `exists-not-skeletonized`;
 *   3. unbound → `contract-has-no-types-file` for a claimant of a
 *      `Types file: none` contract, else `no-bound-exports`;
 *   4. bound and unsupported → `unsupported-language` with the reason;
 *   5. bound and supported → `skeleton-written { origin: "spawn" }`.
 * Test files never get an outcome; an unknown Task is `unknown-task`, never
 * an empty list (the wrapper keeps its empty list for known-id callers), while
 * a Task with no production files has an empty list. The five render
 * strings are exact.
 *
 * Sibling row (T11): the spawn materialization's `planTaskSkeletons`, fed
 * this same graph and observation set, records exactly the owner's outcome
 * per path, and maps only an owner-decided `skeleton-written` outcome to a
 * write: create when absent, adopt canonical bytes with no record, nothing
 * for an already untouched recorded skeleton or any other outcome.
 *
 * Sibling rows (T13): the contract stop's `planContractStubs` and the
 * revision's `planSkeletonRevision`, fed this same graph's records and
 * observation set with a canonical skeleton per writable bound path, act on a
 * present file exactly when the owner judges it untouched (create, adopt or
 * refresh; refresh or re-record), flag a record stale exactly when the owner
 * judges its file touched, and agree with the owner's outcome for the path.
 *
 * Sibling rows (T14): `helper orchestration status`'s `skeletonStatusReport`
 * and the brief's `renderFrozenSignatures`, fed this same graph (Wave 2
 * current) and observation set, list exactly the owner's outcome per path —
 * status as `projected` where registration recorded none, and the recorded
 * one where it did — each rendered with the owner's exact string on the line
 * naming the path.
 */

import { describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { renderFrozenSignatures } from "../../src/core/implementation-brief";
import { isUntouchedSkeleton, renderSkeletonOutcome, skeletonOutcomes, skeletonOutcomesOf } from "../../src/core/skeleton/outcomes";
import type { SkeletonGraph } from "../../src/core/skeleton/scope";
import { renderSkeletonStatus, skeletonStatusReport } from "../../src/core/skeleton/status";
import type {
  ExportBinding,
  GeneratedSkeleton,
  Identifier,
  PathObservation,
  SkeletonOutcome,
  SkeletonRecord,
} from "../../src/core/skeleton/types";
import { planSkeletonRevision } from "../../src/handlers/helpers/revise-contract";
import { planContractStubs } from "../../src/orchestration/contract-stub-materialization";
import { planTaskSkeletons, type SkeletonCandidate } from "../../src/orchestration/skeleton-materialization";
import type { Task } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const ENGINE = "e".repeat(64);
const CANONICAL = "c".repeat(64);
const EDITED = "d".repeat(64);

const task = (id: string, files: readonly string[], anchors: readonly string[] = []): Task =>
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
  });

const contract = (id: string, types: AcceptanceContract["types"], anchors: readonly [string, ...string[]]): AcceptanceContract => ({
  schemaVersion: 1,
  id,
  title: `${id} title`,
  statement: `${id} behaves as declared.`,
  contractTask: "T1",
  types,
  acceptance: [{ path: `tests/${id}.acceptance.test.ts`, anchors }],
  supportedDomain: null,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: `tests/${id}.acceptance.test.ts`, sha256: digest("a") }],
    roster: [{ file: `tests/${id}.acceptance.test.ts`, name: `${anchors[0]}: decides`, anchors }],
  },
  revisions: [],
});

/** A typed contract and a `Types file: none` one. */
const TYPED = contract("CT-1", { kind: "file", path: "src/contract/types.ts" }, ["FR-001"]);
const TYPELESS = contract("CT-2", { kind: "none", reason: "a pure CLI slice" }, ["FR-002"]);

const bound = (path: string, contractId = "CT-1"): ExportBinding => ({
  path,
  contract: contractId,
  exports: [{ name: "priceOrder" as Identifier, alias: "PriceOrderFn" as Identifier }],
});

const record = (path: string, origin: SkeletonRecord["origin"]): SkeletonRecord => ({
  path,
  contract: "CT-1",
  language: "typescript",
  origin,
  engineSha256: ENGINE,
  typesSha256: "f".repeat(64),
  stale: null,
});

const present = (sha256: string, canonicalSha256: string | null = null): PathObservation => ({ kind: "present", sha256, canonicalSha256 });
const ABSENT: PathObservation = { kind: "absent" };

/** T2 binds CT-1 and claims nothing; T3 claims the typeless CT-2; T4 claims only the typed CT-1. */
const T2_FILES = [
  "src/stub.ts", //                1. recorded engine digest, contract-stub origin
  "src/adopted.ts", //             1. canonical bytes, no record → adopted as spawn
  "src/refreshed.ts", //           1. canonical bytes beside a stale engine digest → record origin
  "src/unbound-skeleton.ts", //    1. untouched beats unbound
  "src/edited.ts", //              2. recorded skeleton, edited
  "src/existing.ts", //            2. present, never recorded, bound
  "src/main/kotlin/a/Old.kt", //   2. present beats unsupported
  "src/helper.ts", //              3. unbound, no typeless claim
  "src/Pricing.kt", //             4. bound, unsupported
  "src/main/java/a/b/C.java", //   5. bound, supported Java
  "src/pricing.ts", //             5. bound, supported, not observed at all
  "tests/pricing.test.ts", //      test file: no outcome
] as const;

const T3_FILES = ["src/cli.ts", "src/cli-bound.ts", "src/cli-present.ts", "tests/cli.test.ts"] as const;
const T4_FILES = ["src/typed-helper.ts"] as const;

const GRAPH: SkeletonGraph = {
  ...graphFixture([
    task("T1", ["src/contract/types.ts", "tests/CT-1.acceptance.test.ts", "tests/CT-2.acceptance.test.ts"]),
    task("T2", T2_FILES),
    task("T3", T3_FILES, ["FR-002"]),
    task("T4", T4_FILES, ["FR-001"]),
  ]),
  acceptance_contracts: [TYPED, TYPELESS],
  export_bindings: [
    bound("src/existing.ts"),
    bound("src/main/kotlin/a/Old.kt"),
    bound("src/Pricing.kt"),
    bound("src/main/java/a/b/C.java"),
    bound("src/pricing.ts"),
    bound("src/stub.ts"),
    bound("src/adopted.ts"),
    bound("src/refreshed.ts"),
    bound("src/edited.ts"),
    bound("src/cli-bound.ts"),
  ],
  skeletons: [
    record("src/edited.ts", "spawn"),
    record("src/refreshed.ts", "revision"),
    record("src/stub.ts", "contract-stub"),
    record("src/unbound-skeleton.ts", "spawn"),
  ],
};

const OBSERVATIONS: ReadonlyMap<string, PathObservation> = new Map([
  ["src/stub.ts", present(ENGINE)],
  ["src/adopted.ts", present(CANONICAL, CANONICAL)],
  ["src/refreshed.ts", present(CANONICAL, CANONICAL)],
  ["src/unbound-skeleton.ts", present(ENGINE)],
  ["src/edited.ts", present(EDITED, CANONICAL)],
  ["src/existing.ts", present(EDITED)],
  ["src/main/kotlin/a/Old.kt", present(EDITED)],
  ["src/helper.ts", ABSENT],
  ["src/Pricing.kt", ABSENT],
  ["src/main/java/a/b/C.java", ABSENT],
  ["tests/pricing.test.ts", present(EDITED)],
  ["src/cli.ts", ABSENT],
  ["src/cli-bound.ts", ABSENT],
  ["src/cli-present.ts", present(EDITED)],
  ["src/typed-helper.ts", ABSENT],
]);

const written = (origin: "spawn" | "contract-stub" | "revision"): SkeletonOutcome => ({ kind: "skeleton-written", origin });
const EXISTS: SkeletonOutcome = { kind: "exists-not-skeletonized" };
const NO_BOUND: SkeletonOutcome = { kind: "no-bound-exports" };
const NO_TYPES: SkeletonOutcome = { kind: "contract-has-no-types-file" };

describe("INV-4 owner: skeletonOutcomes precedence over one graph and observation set", () => {
  it("gives exactly one outcome per non-test path of a binder, in file_list order", () => {
    expect(skeletonOutcomes(GRAPH, "T2", OBSERVATIONS)).toEqual([
      { path: "src/stub.ts", outcome: written("contract-stub") },
      { path: "src/adopted.ts", outcome: written("spawn") },
      { path: "src/refreshed.ts", outcome: written("revision") },
      { path: "src/unbound-skeleton.ts", outcome: written("spawn") },
      { path: "src/edited.ts", outcome: EXISTS },
      { path: "src/existing.ts", outcome: EXISTS },
      { path: "src/main/kotlin/a/Old.kt", outcome: EXISTS },
      { path: "src/helper.ts", outcome: NO_BOUND },
      { path: "src/Pricing.kt", outcome: { kind: "unsupported-language", reason: "jvm-non-java" } },
      { path: "src/main/java/a/b/C.java", outcome: written("spawn") },
      { path: "src/pricing.ts", outcome: written("spawn") },
    ]);
  });

  it("a claimant of a Types-file-none contract: unbound paths say so, bound and present paths keep their steps", () => {
    expect(skeletonOutcomes(GRAPH, "T3", OBSERVATIONS)).toEqual([
      { path: "src/cli.ts", outcome: NO_TYPES },
      { path: "src/cli-bound.ts", outcome: written("spawn") },
      { path: "src/cli-present.ts", outcome: EXISTS },
    ]);
  });

  it("a claimant of only a typed contract has no bound exports on an unbound path", () => {
    expect(skeletonOutcomes(GRAPH, "T4", OBSERVATIONS)).toEqual([{ path: "src/typed-helper.ts", outcome: NO_BOUND }]);
  });

  it("the contract Task of a Types-file-none contract is no claimant of it", () => {
    expect(skeletonOutcomes(GRAPH, "T1", new Map()).map(({ outcome }) => outcome)).toEqual([NO_BOUND]);
  });

  it("an unknown Task is unknown-task, distinguishable from a Task with no production files", () => {
    expect(skeletonOutcomesOf(GRAPH, "T9", OBSERVATIONS)).toEqual({ ok: false, error: { kind: "unknown-task", taskId: "T9" } });
    const testsOnly: SkeletonGraph = { ...GRAPH, tasks: [...GRAPH.tasks, task("T5", ["tests/only.test.ts"])] };
    expect(skeletonOutcomesOf(testsOnly, "T5", OBSERVATIONS)).toEqual({ ok: true, value: [] });
    // The known-id wrapper the shells still call keeps its empty list for an unknown id.
    expect(skeletonOutcomes(GRAPH, "T9", OBSERVATIONS)).toEqual([]);
  });

  it("the wrapper is skeletonOutcomesOf's value for every known Task", () => {
    for (const id of ["T1", "T2", "T3", "T4"]) {
      expect(skeletonOutcomesOf(GRAPH, id, OBSERVATIONS)).toEqual({ ok: true, value: skeletonOutcomes(GRAPH, id, OBSERVATIONS) });
    }
  });

  it("a graph without bindings or records: every absent path is unbound, every present one exists", () => {
    const graph = graphFixture([task("T2", ["src/a.ts", "src/b.ts"])]);
    expect(skeletonOutcomes(graph, "T2", new Map([["src/b.ts", present(ENGINE, ENGINE)]]))).toEqual([
      { path: "src/a.ts", outcome: NO_BOUND },
      { path: "src/b.ts", outcome: written("spawn") },
    ]);
  });
});

describe("INV-4 owner: isUntouchedSkeleton", () => {
  const rows: readonly [string, SkeletonRecord | undefined, string | null, string | null, boolean][] = [
    ["recorded engine digest", record("src/a.ts", "spawn"), ENGINE, null, true],
    ["recorded engine digest, other canonical", record("src/a.ts", "spawn"), ENGINE, CANONICAL, true],
    ["canonical bytes with a record", record("src/a.ts", "spawn"), CANONICAL, CANONICAL, true],
    ["canonical bytes without a record", undefined, CANONICAL, CANONICAL, true],
    ["edited bytes with a record", record("src/a.ts", "spawn"), EDITED, CANONICAL, false],
    ["edited bytes, no record, no canonical", undefined, EDITED, null, false],
    ["missing file, no canonical", undefined, null, null, false],
    ["missing file with a record and no canonical", record("src/a.ts", "spawn"), null, null, false],
    ["missing file with canonical bytes", undefined, null, CANONICAL, false],
  ];
  for (const [name, recorded, current, canonical, untouched] of rows) {
    it(`${name} → ${untouched}`, () => {
      expect(isUntouchedSkeleton(recorded, current, canonical)).toBe(untouched);
    });
  }
});

describe("INV-4 owner: exact render strings", () => {
  const rows: readonly [SkeletonOutcome, string][] = [
    [written("spawn"), "skeleton written"],
    [written("contract-stub"), "skeleton written"],
    [written("revision"), "skeleton written"],
    [NO_BOUND, "no bound exports, no skeleton"],
    [NO_TYPES, "contract has no types file, no skeletons"],
    [{ kind: "unsupported-language", reason: "jvm-non-java" }, "unsupported language, no skeleton"],
    [{ kind: "unsupported-language", reason: "other-extension" }, "unsupported language, no skeleton"],
    [EXISTS, "exists, not skeletonized"],
  ];
  for (const [outcome, rendered] of rows) {
    it(`${JSON.stringify(outcome)} renders '${rendered}'`, () => {
      expect(renderSkeletonOutcome(outcome)).toBe(rendered);
    });
  }

  it("renders every outcome of the matrix graph to one of the five strings", () => {
    const strings = new Set(["T1", "T2", "T3", "T4"].flatMap((id) =>
      skeletonOutcomes(GRAPH, id, OBSERVATIONS).map(({ outcome }) => renderSkeletonOutcome(outcome))));
    expect([...strings].sort()).toEqual([
      "contract has no types file, no skeletons",
      "exists, not skeletonized",
      "no bound exports, no skeleton",
      "skeleton written",
      "unsupported language, no skeleton",
    ]);
  });
});

describe("INV-4 sibling: planTaskSkeletons (spawn materialization) agrees with the owner", () => {
  const candidate = (path: string): SkeletonCandidate => ({
    skeleton: { path, language: path.endsWith(".java") ? "java" : "typescript", bytes: `// ${path}\n`, sha256: CANONICAL },
    contract: "CT-1",
    typesSha256: "f".repeat(64),
  });
  /** A canonical skeleton for every bound supported path, as stage two generates them. */
  const CANDIDATES: ReadonlyMap<string, SkeletonCandidate> = new Map([
    "src/adopted.ts",
    "src/refreshed.ts",
    "src/edited.ts",
    "src/existing.ts",
    "src/main/java/a/b/C.java",
    "src/pricing.ts",
    "src/cli-bound.ts",
  ].map((path) => [path, candidate(path)] as const));

  for (const taskId of ["T1", "T2", "T3", "T4", "T9"]) {
    it(`${taskId}: records exactly the owner's outcome for every path`, () => {
      const plan = planTaskSkeletons(GRAPH, taskId, OBSERVATIONS, CANDIDATES);
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.value.outcomes).toEqual(skeletonOutcomes(GRAPH, taskId, OBSERVATIONS));
    });
  }

  it("writes only where the owner says skeleton-written: create absent paths, adopt unrecorded canonical bytes", () => {
    const plan = planTaskSkeletons(GRAPH, "T2", OBSERVATIONS, CANDIDATES);
    expect(plan.ok && plan.value.actions.map((action) => [action.kind, action.candidate.skeleton.path])).toEqual([
      ["adopt", "src/adopted.ts"],
      ["create", "src/main/java/a/b/C.java"],
      ["create", "src/pricing.ts"],
    ]);
    const claimant = planTaskSkeletons(GRAPH, "T3", OBSERVATIONS, CANDIDATES);
    expect(claimant.ok && claimant.value.actions.map((action) => [action.kind, action.candidate.skeleton.path])).toEqual([
      ["create", "src/cli-bound.ts"],
    ]);
  });

  it("refreshes an untouched recorded skeleton whose canonical bytes changed, keeping its origin", () => {
    const stale = new Map(OBSERVATIONS).set("src/stub.ts", present(ENGINE, CANONICAL));
    const plan = planTaskSkeletons(GRAPH, "T2", stale, new Map(CANDIDATES).set("src/stub.ts", candidate("src/stub.ts")));
    expect(plan.ok && plan.value.outcomes).toEqual(skeletonOutcomes(GRAPH, "T2", stale));
    expect(plan.ok && plan.value.actions.find((action) => action.candidate.skeleton.path === "src/stub.ts")).toEqual({
      kind: "refresh",
      candidate: candidate("src/stub.ts"),
      expectedSha256: ENGINE,
      origin: "contract-stub",
    });
  });

  it("refuses to plan an absent skeleton-written path it has no canonical bytes for", () => {
    const plan = planTaskSkeletons(GRAPH, "T2", OBSERVATIONS, new Map());
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toHaveLength(2);
      expect(plan.error.join("\n")).toContain("src/main/java/a/b/C.java");
      expect(plan.error.join("\n")).toContain("src/pricing.ts");
    }
  });
});

/** The canonical skeleton of every bound T2 path the generator can write, in
 *  stamp order, as the stub and revision steps generate them. */
const SKELETONS: readonly GeneratedSkeleton[] = (GRAPH.export_bindings ?? [])
  .filter(({ path }) => (T2_FILES as readonly string[]).includes(path) && !path.endsWith(".kt"))
  .map(({ path }) => ({ path, language: path.endsWith(".java") ? "java" : "typescript", bytes: `// ${path}\n`, sha256: CANONICAL }));

const T2_OUTCOMES = new Map(skeletonOutcomes(GRAPH, "T2", OBSERVATIONS).map(({ path, outcome }) => [path, outcome] as const));
const recordAt = (path: string): SkeletonRecord | undefined => (GRAPH.skeletons ?? []).find((recorded) => recorded.path === path);
const currentSha = (path: string): string | null => {
  const observation = OBSERVATIONS.get(path);
  return observation?.kind === "present" ? observation.sha256 : null;
};

describe("INV-4 sibling: planContractStubs (the contract Task's stop) agrees with the owner", () => {
  const actions = planContractStubs(GRAPH.skeletons ?? [], OBSERVATIONS, SKELETONS);

  it("creates absent stubs, adopts canonical bytes, refreshes untouched engine bytes, and never touches the rest", () => {
    expect(actions.map((action) => [action.kind, action.skeleton.path])).toEqual([
      ["create", "src/main/java/a/b/C.java"],
      ["create", "src/pricing.ts"],
      ["refresh", "src/stub.ts"],
      ["adopt", "src/adopted.ts"],
      ["adopt", "src/refreshed.ts"],
    ]);
    expect(actions.find((action) => action.skeleton.path === "src/stub.ts")).toMatchObject({ expectedSha256: ENGINE });
  });

  it("acts on a present path exactly when the owner judges it untouched, and only where the owner says skeleton-written", () => {
    for (const skeleton of SKELETONS) {
      const acted = actions.some((action) => action.skeleton.path === skeleton.path);
      const sha = currentSha(skeleton.path);
      if (sha !== null) expect(acted, skeleton.path).toBe(isUntouchedSkeleton(recordAt(skeleton.path), sha, CANONICAL));
      if (acted) expect(T2_OUTCOMES.get(skeleton.path)?.kind, skeleton.path).toBe("skeleton-written");
    }
  });
});

describe("INV-4 sibling: planSkeletonRevision (the Contract Revision) agrees with the owner", () => {
  const actions = planSkeletonRevision(GRAPH.skeletons ?? [], OBSERVATIONS, SKELETONS);

  it("refreshes untouched engine bytes, re-records canonical ones, and flags modified ones stale", () => {
    expect(actions.map((action) => [action.kind, action.record.path])).toEqual([
      ["stale", "src/edited.ts"],
      ["re-record", "src/refreshed.ts"],
      ["refresh", "src/stub.ts"],
    ]);
  });

  it("flags a record stale exactly when the owner judges its file touched, and that file is `exists, not skeletonized`", () => {
    for (const record of GRAPH.skeletons ?? []) {
      const sha = currentSha(record.path);
      if (sha === null) continue;
      const stale = actions.some((action) => action.kind === "stale" && action.record.path === record.path);
      expect(stale, record.path).toBe(!isUntouchedSkeleton(record, sha, CANONICAL));
      if (stale) expect(T2_OUTCOMES.get(record.path), record.path).toEqual(EXISTS);
    }
  });
});

/** The matrix graph with Wave 2 current: the Wave its implementation Tasks run in. */
const WAVE_2: SkeletonGraph = { ...GRAPH, current_wave: 2 };
const WAVE_2_TASKS = ["T1", "T2", "T3", "T4"] as const;

describe("INV-4 sibling: skeletonStatusReport (helper orchestration status) agrees with the owner", () => {
  const report = skeletonStatusReport(WAVE_2, OBSERVATIONS, []);

  it("lists exactly the owner's outcome for every path of every current-Wave Task, projected where none is recorded", () => {
    expect(report.kind).toBe("reported");
    if (report.kind !== "reported") return;
    expect(report.tasks.map(({ taskId }) => taskId)).toEqual([...WAVE_2_TASKS]);
    for (const { taskId, files } of report.tasks) {
      expect(files.map(({ path, outcome }) => ({ path, outcome })), taskId).toEqual(skeletonOutcomes(WAVE_2, taskId, OBSERVATIONS));
      expect(files.every(({ basis }) => basis === "projected"), taskId).toBe(true);
    }
  });

  it("renders each path with the owner's exact string", () => {
    const lines = renderSkeletonStatus(report);
    for (const taskId of WAVE_2_TASKS) {
      for (const { path, outcome } of skeletonOutcomes(WAVE_2, taskId, OBSERVATIONS)) {
        expect(lines, path).toContain(`  - ${taskId} ${path}: ${renderSkeletonOutcome(outcome)} (projected)`);
      }
    }
  });

  it("shows a recorded outcome where registration recorded one, and the owner's projection everywhere else", () => {
    const recorded: SkeletonOutcome = written("contract-stub");
    const graph: SkeletonGraph = {
      ...WAVE_2,
      tasks: WAVE_2.tasks.map((entry) => (entry.id === "T4"
        ? { ...entry, skeleton_outcomes: [{ path: "src/typed-helper.ts", outcome: recorded }] }
        : entry)),
    };
    const files = (taskId: string) => {
      const reported = skeletonStatusReport(graph, OBSERVATIONS, []);
      return reported.kind === "reported" ? reported.tasks.find((entry) => entry.taskId === taskId)?.files : undefined;
    };
    expect(files("T4")).toEqual([{ path: "src/typed-helper.ts", outcome: recorded, basis: "recorded" }]);
    expect(files("T2")?.map(({ path, outcome }) => ({ path, outcome }))).toEqual(skeletonOutcomes(graph, "T2", OBSERVATIONS));
  });
});

describe("INV-4 sibling: renderFrozenSignatures (the implementation brief) agrees with the owner", () => {
  for (const taskId of WAVE_2_TASKS) {
    it(`${taskId}: states exactly the owner's outcome, with its exact string, on the line naming each path`, () => {
      const subject = WAVE_2.tasks.find(({ id }) => id === taskId);
      if (subject === undefined) throw new Error(taskId);
      const section = renderFrozenSignatures(subject, { graph: WAVE_2, observations: OBSERVATIONS, surfaces: new Map(), unresolved: [] });
      const outcomes = skeletonOutcomes(WAVE_2, taskId, OBSERVATIONS);
      for (const { path, outcome } of outcomes) {
        expect(section.split("\n"), path).toContain(`- \`${path}\` — ${renderSkeletonOutcome(outcome)}`);
      }
      const listed = section.split("\n").filter((line) => line.startsWith("- `"));
      expect(listed).toHaveLength(outcomes.length);
    });
  }
});
