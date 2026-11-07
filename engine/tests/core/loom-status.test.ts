/**
 * T14 (AD-13): the skeleton report of `helper orchestration status` and the
 * `skeleton-bindings-unresolved` blocker.
 *
 * Pure rows: `skeletonStatusReport` lists every non-test file_list path of
 * the current Wave's Tasks with exactly one outcome — recorded when the
 * Task's registration recorded one, else projected through `skeletonOutcomesOf`
 * — every stale flag, and every stage-two problem; `renderSkeletonStatus`
 * renders it with the exact AD-13 strings. `classifyImplementationWindow`
 * replaces `spawn-wave-implementation` with `repair-skeleton-bindings` while
 * a stage-two problem stands, and status names it under the
 * `skeleton-bindings-unresolved` reason. A report status could not observe
 * blocks nothing, but an owed spawn names it as `skeletons-unobserved`.
 *
 * Shell rows: `helper orchestration status [--json]`, spawned exactly as an
 * operator types it, over the skeleton fixture repository.
 */

import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { classifyImplementationWindow, type ImplementationReservationStatusObservation } from "../../src/core/implementation-window";
import { deriveLoomStatusFromParsedGraph, renderLoomStatusHuman, renderLoomStatusJson } from "../../src/core/loom-status";
import { knownSkeletonOutcomes } from "../fixtures/known-skeleton-outcomes";
import { productionFiles } from "../../src/core/skeleton/graph-view";
import {
  renderSkeletonStatus,
  skeletonReportScope,
  skeletonStatusReport,
  skeletonsUnobserved,
  unresolvedSkeletonBindings,
  type SkeletonStatusReport,
  type UnresolvedSkeletonBinding,
} from "../../src/core/skeleton/status";
import type { ExportBinding, Identifier, PathObservation, SkeletonOutcome, SkeletonRecord } from "../../src/core/skeleton/types";
import type { Task, TaskGraph } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import {
  cleanupSkeletonRepos,
  OUTCOME_TEXT,
  orchestrationStatus,
  PATHS,
  skeletonRepo,
  someLine,
  statusAliasProblems,
  statusDocument,
  TS_CONTRACT as REPO_TS_CONTRACT,
  TS_TYPES_TEXT,
} from "../fixtures/skeleton-repo";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

afterEach(cleanupSkeletonRepos);

const ENGINE = "e".repeat(64);
const EDITED = "d".repeat(64);

const task = (id: string, wave: number, files: readonly string[], anchors: readonly string[] = [], status: "pending" | "completed" = "pending"): Task =>
  taskFixture({
    id,
    description: id,
    agent: "code-implementer-agent",
    wave,
    depends_on: wave === 1 ? [] : ["T1"],
    file_list: [...files],
    spec_anchors: [...anchors],
    spec_contributions: [],
    new_tests_required: false,
    status,
  });

const contract = (id: string, types: AcceptanceContract["types"], anchor: string): AcceptanceContract => ({
  schemaVersion: 1,
  id,
  title: `${id} title`,
  statement: `${id} behaves as declared.`,
  contractTask: "T1",
  types,
  acceptance: [{ path: `tests/${id}.acceptance.test.ts`, anchors: [anchor] }],
  supportedDomain: null,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: `tests/${id}.acceptance.test.ts`, sha256: digest("a") }],
    roster: [{ file: `tests/${id}.acceptance.test.ts`, name: `${anchor}: decides`, anchors: [anchor] }],
  },
  revisions: [],
});

const bound = (path: string): ExportBinding => ({
  path,
  contract: "CT-1",
  exports: [{ name: "priceOrder" as Identifier, alias: "PriceOrderFn" as Identifier }],
});

const record = (path: string, stale: SkeletonRecord["stale"] = null): SkeletonRecord => ({
  path,
  contract: "CT-1",
  language: "typescript",
  origin: "spawn",
  engineSha256: ENGINE,
  typesSha256: "f".repeat(64),
  stale,
});

const written: SkeletonOutcome = { kind: "skeleton-written", origin: "spawn" };
const EXISTS: SkeletonOutcome = { kind: "exists-not-skeletonized" };
const NO_BOUND: SkeletonOutcome = { kind: "no-bound-exports" };
const NO_TYPES: SkeletonOutcome = { kind: "contract-has-no-types-file" };
const UNSUPPORTED: SkeletonOutcome = { kind: "unsupported-language", reason: "other-extension" };

/** T4's registration recorded `skeleton written` at `quotes.ts`; the implementer has since edited it. */
const RECORDED_T4 = {
  ...task("T4", 2, ["src/quotes.ts"], ["FR-001"]),
  skeleton_outcomes: [{ path: "src/quotes.ts", outcome: written }],
};

const GRAPH: TaskGraph = {
  ...graphFixture([
    task("T1", 1, ["src/contract/types.ts", "tests/CT-1.acceptance.test.ts", "tests/CT-2.acceptance.test.ts"], [], "completed"),
    task("T2", 2, ["src/pricing.ts", "src/legacy.ts", "src/rates.py", "src/helper.ts", "tests/pricing.test.ts"]),
    task("T3", 2, ["src/cli.ts"], ["FR-002"]),
    RECORDED_T4,
  ]),
  current_wave: 2,
  acceptance_contracts: [
    contract("CT-1", { kind: "file", path: "src/contract/types.ts" }, "FR-001"),
    contract("CT-2", { kind: "none", reason: "a pure CLI slice" }, "FR-002"),
  ],
  export_bindings: [bound("src/pricing.ts"), bound("src/legacy.ts"), bound("src/rates.py"), bound("src/quotes.ts")],
  skeletons: [record("src/legacy.ts", { revision: 1 }), record("src/quotes.ts")],
};

const present = (sha256: string): PathObservation => ({ kind: "present", sha256, canonicalSha256: null });
const OBSERVATIONS: ReadonlyMap<string, PathObservation> = new Map([
  ["src/pricing.ts", { kind: "absent" }],
  ["src/legacy.ts", present(EDITED)],
  ["src/rates.py", { kind: "absent" }],
  ["src/helper.ts", { kind: "absent" }],
  ["tests/pricing.test.ts", present(EDITED)],
  ["src/cli.ts", { kind: "absent" }],
  ["src/quotes.ts", present(EDITED)],
]);

const MISSING_ALIAS: UnresolvedSkeletonBinding = {
  problem: { kind: "missing-alias", alias: "ParseOrderFn", path: "src/pricing.ts", typesFile: "src/contract/types.ts" },
  message: "src/pricing.ts binds ParseOrderFn, but the frozen types file src/contract/types.ts declares no ParseOrderFn",
};

describe("skeletonStatusReport", () => {
  it("AS-042: lists every non-test file_list path of the current Wave's Tasks with exactly one outcome", () => {
    const report = skeletonStatusReport(GRAPH, OBSERVATIONS, []);
    expect(report.kind).toBe("reported");
    if (report.kind !== "reported") return;
    expect(report.wave).toBe(2);
    expect(report.tasks.map(({ taskId }) => taskId)).toEqual(["T2", "T3", "T4"]);
    for (const { taskId, files } of report.tasks) {
      const owner = GRAPH.tasks.find(({ id }) => id === taskId);
      if (owner === undefined) throw new Error(taskId);
      expect(files.map(({ path }) => path)).toEqual(productionFiles(GRAPH, owner));
    }
    expect(report.tasks.flatMap(({ files }) => files.map(({ path }) => path))).not.toContain("tests/pricing.test.ts");
  });

  it("FR-040: projects each fallback outcome through skeletonOutcomesOf, one per path", () => {
    const report = skeletonStatusReport(GRAPH, OBSERVATIONS, []);
    expect(report).toEqual({
      kind: "reported",
      wave: 2,
      tasks: [
        {
          taskId: "T2",
          files: [
            { path: "src/pricing.ts", outcome: written, basis: "projected" },
            { path: "src/legacy.ts", outcome: EXISTS, basis: "projected" },
            { path: "src/rates.py", outcome: UNSUPPORTED, basis: "projected" },
            { path: "src/helper.ts", outcome: NO_BOUND, basis: "projected" },
          ],
        },
        { taskId: "T3", files: [{ path: "src/cli.ts", outcome: NO_TYPES, basis: "projected" }] },
        { taskId: "T4", files: [{ path: "src/quotes.ts", outcome: written, basis: "recorded" }] },
      ],
      stale: [{ path: "src/legacy.ts", contract: "CT-1", stale: { revision: 1 } }],
      unresolved: [],
    });
    const projected = knownSkeletonOutcomes(GRAPH, "T2", OBSERVATIONS);
    if (report.kind === "reported") {
      expect(report.tasks[0]?.files.map(({ path, outcome }) => ({ path, outcome }))).toEqual(projected);
    }
  });

  const statusOf = (taskId: string, path: string) => {
    const report = skeletonStatusReport(GRAPH, OBSERVATIONS, []);
    return report.kind === "reported" ? report.tasks.find((entry) => entry.taskId === taskId)?.files.find((file) => file.path === path) : undefined;
  };
  const humanLineOf = (path: string): string | undefined =>
    renderSkeletonStatus(skeletonStatusReport(GRAPH, OBSERVATIONS, [])).find((line) => line.includes(` ${path}: `));

  it("AS-038: a file with no bound exports is \"no bound exports, no skeleton\" in --json and the human view", () => {
    expect(statusOf("T2", "src/helper.ts")?.outcome).toEqual(NO_BOUND);
    expect(humanLineOf("src/helper.ts")).toBe("  - T2 src/helper.ts: no bound exports, no skeleton (projected)");
  });

  it("AS-039: a claimant's file of a Types-file-none contract is \"contract has no types file, no skeletons\"", () => {
    expect(statusOf("T3", "src/cli.ts")?.outcome).toEqual(NO_TYPES);
    expect(humanLineOf("src/cli.ts")).toBe("  - T3 src/cli.ts: contract has no types file, no skeletons (projected)");
  });

  it("AS-040: a bound file in an unsupported language is \"unsupported language, no skeleton\"", () => {
    expect(statusOf("T2", "src/rates.py")?.outcome).toEqual(UNSUPPORTED);
    expect(humanLineOf("src/rates.py")).toBe("  - T2 src/rates.py: unsupported language, no skeleton (projected)");
  });

  it("AS-041: an existing file_list path is \"exists, not skeletonized\"", () => {
    expect(statusOf("T2", "src/legacy.ts")?.outcome).toEqual(EXISTS);
    expect(humanLineOf("src/legacy.ts")).toBe("  - T2 src/legacy.ts: exists, not skeletonized (projected)");
  });

  it("FR-040: a recorded outcome is shown as recorded, even where projection would now differ", () => {
    expect(knownSkeletonOutcomes(GRAPH, "T4", OBSERVATIONS)).toEqual([{ path: "src/quotes.ts", outcome: EXISTS }]);
    const report = skeletonStatusReport(GRAPH, OBSERVATIONS, []);
    expect(report.kind === "reported" && report.tasks[2]).toEqual({
      taskId: "T4",
      files: [{ path: "src/quotes.ts", outcome: written, basis: "recorded" }],
    });
  });

  it("AS-050: lists every stale skeleton record, whatever its Wave", () => {
    const graph: TaskGraph = { ...GRAPH, skeletons: [record("src/elsewhere.ts", { revision: 2 }), ...(GRAPH.skeletons ?? [])] };
    const report = skeletonStatusReport(graph, OBSERVATIONS, []);
    expect(report.kind === "reported" && report.stale).toEqual([
      { path: "src/elsewhere.ts", contract: "CT-1", stale: { revision: 2 } },
      { path: "src/legacy.ts", contract: "CT-1", stale: { revision: 1 } },
    ]);
  });

  it("AS-051: carries every stage-two problem it is given", () => {
    const report = skeletonStatusReport(GRAPH, OBSERVATIONS, [MISSING_ALIAS]);
    expect(report.kind === "reported" && report.unresolved).toEqual([MISSING_ALIAS]);
    expect(unresolvedSkeletonBindings(report)).toEqual([MISSING_ALIAS.message]);
  });

  it("AS-006: a stamp that binds nothing reports every new file as no bound exports", () => {
    const graph: TaskGraph = { ...GRAPH, export_bindings: [], skeletons: [] };
    const report = skeletonStatusReport(graph, OBSERVATIONS, []);
    expect(report.kind === "reported" && report.tasks.find(({ taskId }) => taskId === "T2")?.files).toEqual([
      { path: "src/pricing.ts", outcome: NO_BOUND, basis: "projected" },
      { path: "src/legacy.ts", outcome: EXISTS, basis: "projected" },
      { path: "src/rates.py", outcome: NO_BOUND, basis: "projected" },
      { path: "src/helper.ts", outcome: NO_BOUND, basis: "projected" },
    ]);
  });

  it("is not applicable outside an execute Wave, or for a TaskGraph populated before bindings were stamped", () => {
    const { export_bindings: _dropped, ...unstamped } = GRAPH;
    expect(skeletonStatusReport(unstamped, OBSERVATIONS, []).kind).toBe("not-applicable");
    expect(skeletonStatusReport({ ...GRAPH, current_phase: "decompose" }, OBSERVATIONS, []).kind).toBe("not-applicable");
    expect(skeletonStatusReport({ ...GRAPH, current_wave: undefined }, OBSERVATIONS, []).kind).toBe("not-applicable");
    expect(unresolvedSkeletonBindings(skeletonStatusReport(unstamped, OBSERVATIONS, [MISSING_ALIAS]))).toEqual([]);
  });

  it("scopes the observation to the current Wave, and stage-two problems to its outstanding Tasks", () => {
    const graph: TaskGraph = {
      ...GRAPH,
      tasks: GRAPH.tasks.map((entry) => (entry.id === "T3" ? task("T3", 2, ["src/cli.ts"], ["FR-002"], "completed") : entry)),
    };
    const scope = skeletonReportScope(graph);
    expect(scope.kind).toBe("wave");
    if (scope.kind !== "wave") return;
    expect(scope.wave).toBe(2);
    expect(scope.tasks.map(({ id }) => id)).toEqual(["T2", "T3", "T4"]);
    expect(scope.outstanding.map(({ id }) => id)).toEqual(["T2", "T4"]);
  });
});

describe("renderSkeletonStatus", () => {
  it("FR-040: one line per path with the exact outcome string and its basis, then each stale flag and problem", () => {
    expect(renderSkeletonStatus(skeletonStatusReport(GRAPH, OBSERVATIONS, [MISSING_ALIAS]))).toEqual([
      "- skeletons: Wave 2",
      `  - T2 src/pricing.ts: ${OUTCOME_TEXT.written} (projected)`,
      `  - T2 src/legacy.ts: ${OUTCOME_TEXT.exists} (projected)`,
      `  - T2 src/rates.py: ${OUTCOME_TEXT.unsupported} (projected)`,
      `  - T2 src/helper.ts: ${OUTCOME_TEXT.noBoundExports} (projected)`,
      `  - T3 src/cli.ts: ${OUTCOME_TEXT.noTypesFile} (projected)`,
      `  - T4 src/quotes.ts: ${OUTCOME_TEXT.written} (recorded)`,
      `  - src/legacy.ts: ${OUTCOME_TEXT.stale} CT-1 (revision 1)`,
      `  - unresolved: ${MISSING_ALIAS.message}`,
    ]);
  });

  it("names why there is no report", () => {
    expect(renderSkeletonStatus({ kind: "not-applicable", reason: "no execute Wave is current" }))
      .toEqual(["- skeletons: not applicable (no execute Wave is current)"]);
    expect(renderSkeletonStatus(skeletonsUnobserved("cannot read src/a.ts"))).toEqual(["- skeletons: unobserved (cannot read src/a.ts)"]);
  });
});

// ---------------------------------------------------------------------------
// The blocker
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const observed: ImplementationReservationStatusObservation = { kind: "observed", observedAtMs: NOW, anyActiveForGraph: false };
const WINDOW_GRAPH: TaskGraph = graphFixture([task("T1", 1, ["src/a.ts"]), task("T2", 1, ["src/b.ts"])]);

describe("classifyImplementationWindow: skeleton-bindings-unresolved", () => {
  it("AS-051: replaces spawn-wave-implementation with the repair, naming every problem", () => {
    const window = classifyImplementationWindow(WINDOW_GRAPH, observed, [MISSING_ALIAS.message]);
    expect(window).toMatchObject({
      kind: "window",
      wave: 1,
      pendingTaskIds: ["T1", "T2"],
      recovery: { kind: "repair-skeleton-bindings", wave: 1, unresolved: [MISSING_ALIAS.message] },
    });
    expect(window.kind === "window" && window.message).toContain("ParseOrderFn");
  });

  it("spawns as before when every binding resolves", () => {
    expect(classifyImplementationWindow(WINDOW_GRAPH, observed, [])).toMatchObject({
      kind: "window",
      recovery: { kind: "spawn-wave-implementation" },
    });
    expect(classifyImplementationWindow(WINDOW_GRAPH, observed)).toMatchObject({ recovery: { kind: "spawn-wave-implementation" } });
  });

  it("leaves a Wave with nothing to spawn alone: only a spawn is blocked", () => {
    const done = graphFixture([task("T1", 1, ["src/a.ts"], [], "completed")]);
    const window = classifyImplementationWindow(done, observed, [MISSING_ALIAS.message]);
    expect(window.kind === "window" && window.recovery.kind).not.toBe("repair-skeleton-bindings");
  });
});

const STATUS_DEPS = {
  loadPlanModels: () => ({ kind: "none" as const }),
  filePresence: () => ({ ok: true as const, exists: true }),
  implementationReservations: observed,
};

describe("the status document's skeleton report", () => {
  const report: SkeletonStatusReport = skeletonStatusReport(GRAPH, OBSERVATIONS, [MISSING_ALIAS]);

  it("AS-051: blocks the spawn under the skeleton-bindings-unresolved reason, naming the problem", () => {
    const document = deriveLoomStatusFromParsedGraph({ ok: true, value: GRAPH }, { ...STATUS_DEPS, skeletons: report });
    expect(document.skeletons).toEqual(report);
    const action = document.next.action;
    expect(action.kind === "blocked" && action.diagnostic.kind).toBe("skeleton-bindings-unresolved");
    const reason = document.next.reasons.find(({ kind }) => kind === "skeleton-bindings-unresolved");
    expect(reason?.message).toContain(MISSING_ALIAS.message);
  });

  it("FR-040: --json carries the report and the human view renders it", () => {
    const document = deriveLoomStatusFromParsedGraph({ ok: true, value: GRAPH }, { ...STATUS_DEPS, skeletons: report });
    expect((JSON.parse(renderLoomStatusJson(document)) as { skeletons: unknown }).skeletons).toEqual(JSON.parse(JSON.stringify(report)));
    const human = renderLoomStatusHuman(document);
    for (const line of renderSkeletonStatus(report)) expect(human).toContain(line);
  });

  it("is reported unobserved, and blocks nothing, when status was derived without a skeleton observation", () => {
    const document = deriveLoomStatusFromParsedGraph({ ok: true, value: GRAPH }, STATUS_DEPS);
    expect(document.skeletons.kind).toBe("unobserved");
    expect(document.next.reasons.map(({ kind }) => kind)).not.toContain("skeleton-bindings-unresolved");
  });

  it("names a failed observation as skeletons-unobserved while it still owes the spawn (registration stays the authority)", () => {
    const document = deriveLoomStatusFromParsedGraph(
      { ok: true, value: GRAPH },
      { ...STATUS_DEPS, skeletons: skeletonsUnobserved("cannot read src/pricing.ts") },
    );
    const action = document.next.action;
    expect(action.kind === "blocked" && action.diagnostic.kind).toBe("wave-gate-not-started");
    expect(action.kind === "blocked" && action.diagnostic.kind === "wave-gate-not-started" && action.diagnostic.recovery.kind)
      .toBe("spawn-wave-implementation");
    const reason = document.next.reasons.find(({ kind }) => kind === "skeletons-unobserved");
    expect(reason).toEqual({
      kind: "skeletons-unobserved",
      message: "status could not observe Wave 2's skeleton paths (cannot read src/pricing.ts); " +
        "registration observes them again and refuses the spawn on anything it cannot read",
      taskId: null,
    });
  });

  it("names nothing unobserved once the skeletons were observed", () => {
    const document = deriveLoomStatusFromParsedGraph({ ok: true, value: GRAPH }, { ...STATUS_DEPS, skeletons: skeletonStatusReport(GRAPH, OBSERVATIONS, []) });
    expect(document.next.reasons.map(({ kind }) => kind)).not.toContain("skeletons-unobserved");
  });
});

// ---------------------------------------------------------------------------
// helper orchestration status, spawned as an operator types it
// ---------------------------------------------------------------------------

type ReportedJson = Readonly<{ kind: string; wave?: number; tasks?: readonly Readonly<{ taskId: string }>[] }>;

describe("helper orchestration status --json", () => {
  it("FR-040: reports the current Wave's skeletons and still owes the spawn when every binding resolves", () => {
    const repo = skeletonRepo();
    const document = statusDocument(repo) as Readonly<{ skeletons: ReportedJson; next: { reasons: readonly { kind: string }[] } }>;
    expect(document.skeletons).toMatchObject({ kind: "reported", wave: 2 });
    expect(document.skeletons.tasks?.map(({ taskId }) => taskId)).toEqual(["T4", "T5", "T6", "T7", "T8"]);
    expect(document.next.reasons.map(({ kind }) => kind)).not.toContain("skeleton-bindings-unresolved");
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.tsPricing, OUTCOME_TEXT.written)).toBe(true);
  });

  it("a skeleton path status cannot read is reported unobserved under the skeletons-unobserved reason, and the spawn is still owed", () => {
    const repo = skeletonRepo();
    repo.write(PATHS.tsPricing, "export {};\n");
    chmodSync(join(repo.root, PATHS.tsPricing), 0o000);
    try {
      const document = statusDocument(repo) as Readonly<{
        skeletons: ReportedJson;
        next: { reasons: readonly { kind: string; message: string }[] };
      }>;
      expect(document.skeletons.kind).toBe("unobserved");
      const reason = document.next.reasons.find(({ kind }) => kind === "skeletons-unobserved");
      expect(reason?.message).toContain(PATHS.tsPricing);
      expect(document.next.reasons.map(({ kind }) => kind)).toContain("wave-gate-not-started");
    } finally {
      chmodSync(join(repo.root, PATHS.tsPricing), 0o644);
    }
  });

  it("AS-051: a frozen types file that drifted from its stamp blocks the spawn, naming the types file", () => {
    const repo = skeletonRepo();
    repo.write(REPO_TS_CONTRACT.types, `${TS_TYPES_TEXT}export type Drift = string;\n`);
    const status = statusDocument(repo);
    const text = JSON.stringify(status);
    expect(text).toContain("skeleton-bindings-unresolved");
    expect(text).toContain("types-drifted");
    expect(text).toContain(REPO_TS_CONTRACT.types);
    expect(statusAliasProblems(status)).toEqual([]);
    expect(orchestrationStatus(repo, false).stdout).toContain(`unresolved: the frozen types file ${REPO_TS_CONTRACT.types}`);
  });

  it("AS-051: a missing alias in the frozen types names the alias, the binding file and the types file", () => {
    const repo = skeletonRepo({ tsTypesText: TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "") });
    expect(statusAliasProblems(statusDocument(repo))).toEqual([
      { kind: "missing-alias", alias: "ParseOrderFn", path: PATHS.tsPricing, typesFile: REPO_TS_CONTRACT.types },
    ]);
  });
});
