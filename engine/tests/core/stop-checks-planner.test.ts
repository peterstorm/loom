/**
 * Unit and property tests for the one stop-check planner (INV-1, AD-9) and
 * the combined plan view (AD-11).
 *
 * `planStopChecks(graph, taskId, changed)` decides both checks. Its
 * acceptance arm must stay the slice-1 acceptance decision, whatever the
 * changed files, and its affected arm forms the runner command only
 * through `affectedRunnerCheck`, over the changed files beneath the runner's
 * cwd. `renderStopChecksPlan` prints the CT-1 acceptance lines unchanged and
 * then the affected section, or exactly one off-reason (FR-028, AS-032,
 * AS-033). A manifest without the new keys freezes no affected runner, so I7
 * is off with the stated reason (FR-017, AS-017).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import {
  AFFECTED_OUTSIDE_CWD_PREFIX,
  AFFECTED_SECTION_HEADING,
  AFFECTED_STOP_CHECK_OFF,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  type ChangedFilePath,
  type ChangedFiles,
} from "../../src/core/affected-stop-check-types";
import { stopCheckExpectation } from "../../src/core/acceptance-contract/stop-check";
import {
  renderStopCheckPlan,
  renderStopChecksPlan,
  stopCheckPlanView,
  stopChecksPlanView,
} from "../../src/core/acceptance-contract/stop-check-plan";
import { planStopChecks } from "../../src/core/acceptance-contract/stop-check-planner";
import { changedFilesAtStop } from "../../src/core/changed-files";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { UNKNOWN_TASK_PREFIX } from "../../src/core/stop-check-plan-types";
import {
  acceptanceRunnerCheck,
  affectedRunnerCheck,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import type { Task, TaskGraph } from "../../src/types";
import { task } from "../fixtures/contract-status-fixtures";
import { acceptancePlanLines, affectedOffSection, frozenContract } from "../fixtures/stop-check-plan-fixtures";
import { ACCEPTANCE_REPORT, ACCEPTANCE_RUNNER, AFFECTED_REPORT, AFFECTED_RUNNER } from "../fixtures/stop-check-runners";
import { graphFixture } from "../fixtures/task-lifecycle";

const TYPES = "src/payload-types.ts";
const ACCEPTANCE_FILE = "tests/payload.acceptance.test.ts";
const OWED = "AS-001: one valid call wins";

const NODE_RUNNER = Object.freeze({
  executable: "node",
  args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
});

function frozen(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const result = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({ kind: "loom-verification-manifest", checks: [], ...document })));
  if (!result.ok) throw new Error(`fixture manifest refused: ${result.error.errors.join("; ")}`);
  return result.value;
}

const bothRunners = (affected: Readonly<Record<string, unknown>> = AFFECTED_RUNNER): FrozenVerificationManifest =>
  frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: affected });

const TASKS: readonly Task[] = [
  task("T1", 1, [TYPES, ACCEPTANCE_FILE]),
  task("T2", 2, ["src/payload.ts"], ["AS-001"]),
  task("T3", 2, ["src/ledger.ts"]),
];

const CONTRACT: AcceptanceContract = frozenContract({
  id: "CT-1",
  types: TYPES,
  files: [{ path: ACCEPTANCE_FILE, anchors: ["AS-001"] }],
  roster: [{ file: ACCEPTANCE_FILE, name: OWED, anchors: ["AS-001"] }],
});

const graphOf = (manifest?: FrozenVerificationManifest, tasks: readonly Task[] = TASKS): TaskGraph => ({
  ...graphFixture(tasks),
  acceptance_contracts: [CONTRACT],
  ...(manifest === undefined ? {} : { verification_manifest: manifest }),
});

/** Changed files as the shell hands them over: always through the INV-7 owner. */
const changed = (...files: string[]): ChangedFiles =>
  changedFilesAtStop(files.map((path) => ({ kind: "FileWrite", path, via: "tool" })), "/work/repo", () => true);
const NONE: ChangedFiles = changed();

const nonEmptyOf = <T,>(values: readonly T[]): NonEmpty<T> => values as unknown as NonEmpty<T>;

function renderedLines(graph: TaskGraph, taskId: string, files: ChangedFiles): readonly string[] {
  const rendering = renderStopChecksPlan(graph, taskId, files);
  if (rendering.kind !== "rendered") throw new Error(`${taskId} is not in the fixture graph`);
  return rendering.lines;
}

describe("planStopChecks", () => {
  it("is unknown-task for an id absent from the TaskGraph", () => {
    expect(planStopChecks(graphOf(bothRunners()), "T9", changed("src/a.ts"))).toEqual({ kind: "unknown-task" });
  });

  it("decides the acceptance arm exactly as before, whatever the changed files", () => {
    const graph = graphOf(bothRunners());
    const task2 = graph.tasks.find(({ id }) => id === "T2")!;
    const check = stopCheckExpectation(graph.acceptance_contracts!, graph.tasks, task2);
    if (check.kind !== "owed") throw new Error("T2 owes AS-001");
    const command = acceptanceRunnerCheck(graph.verification_manifest!.acceptanceRunner!, check.files);
    if (!command.ok) throw new Error("the acceptance runner forms a command");

    for (const files of [NONE, changed("src/payload.ts")]) {
      const plan = planStopChecks(graph, "T2", files);
      expect(plan).toMatchObject({ kind: "known", wave: 2 });
      if (plan.kind !== "known") continue;
      expect(plan.acceptance).toEqual({ kind: "on", check, command: command.value, reportPath: ACCEPTANCE_REPORT });
      const t3 = planStopChecks(graph, "T3", files);
      expect(t3.kind === "known" && t3.acceptance).toEqual({ kind: "off", reason: { kind: "nothing-owed" } });
    }
  });

  it.each<[string, FrozenVerificationManifest | undefined]>([
    ["a schema-1 manifest", frozen({ schemaVersion: 1 })],
    ["a schema-2 manifest without the new keys", frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER })],
    ["no verification manifest", undefined],
  ])("AS-017: FR-017: %s plans the affected check off with no-runner, before any changed-files reason", (_label, manifest) => {
    const graph = graphOf(manifest);
    for (const files of [NONE, changed("src/ledger.ts")]) {
      expect(planStopChecks(graph, "T3", files)).toMatchObject({ kind: "known", affected: { kind: "off", reason: { kind: "no-runner" } } });
    }
  });

  it("plans the affected check off with no-changed-files and no outside detail when the attempt changed nothing", () => {
    expect(planStopChecks(graphOf(bothRunners()), "T3", NONE))
      .toMatchObject({ kind: "known", affected: { kind: "off", reason: { kind: "no-changed-files", outsideCwd: null } } });
  });

  it("forms the affected command over the changed files through affectedRunnerCheck", () => {
    const graph = graphOf(bothRunners());
    const files = nonEmptyOf<ChangedFilePath>(["src/ledger.ts", "src/ledger.test.ts"] as ChangedFilePath[]);
    const command = affectedRunnerCheck(graph.verification_manifest!.affectedRunner!, files);
    if (!command.ok) throw new Error("the affected runner forms a command");

    expect(planStopChecks(graph, "T3", changed(...files))).toMatchObject({
      kind: "known",
      affected: { kind: "on", files, command: command.value, reportPath: AFFECTED_REPORT },
    });
  });

  it("filters the changed files to those beneath the runner cwd, and names the rest when none remain", () => {
    const graph = graphOf(bothRunners({ ...AFFECTED_RUNNER, cwd: "engine" }));

    const on = planStopChecks(graph, "T3", changed("src/ledger.ts", "engine/src/a.ts", "engineering/b.ts", "engine/tests/a.test.ts"));
    expect(on).toMatchObject({ kind: "known", affected: { kind: "on", files: ["engine/src/a.ts", "engine/tests/a.test.ts"] } });
    if (on.kind === "known" && on.affected.kind === "on") {
      expect(on.affected.command.cwd).toBe("engine");
      expect(on.affected.command.args.slice(-2)).toEqual(["src/a.ts", "tests/a.test.ts"]);
    }

    expect(planStopChecks(graph, "T3", changed("src/ledger.ts", "engineering/b.ts"))).toMatchObject({
      kind: "known",
      affected: { kind: "off", reason: { kind: "no-changed-files", outsideCwd: ["src/ledger.ts", "engineering/b.ts"] } },
    });
  });

  it("plans command-refused with the builder's errors when the runner refuses the files", () => {
    const graph = graphOf(frozen({ schemaVersion: 2, affectedRunner: NODE_RUNNER }));
    const refused = affectedRunnerCheck(graph.verification_manifest!.affectedRunner!, nonEmptyOf(["src/ledger.test.js", "-e"]));
    if (refused.ok) throw new Error("node refuses an inline-evaluation option");

    expect(planStopChecks(graph, "T3", changed("src/ledger.test.js", "-e"))).toMatchObject({
      kind: "known",
      affected: { kind: "off", reason: { kind: "command-refused", errors: refused.error.errors } },
    });
  });

  it("is total and the affected arm agrees with affectedRunnerCheck over the files beneath the cwd", () => {
    const file = fc.array(fc.constantFrom("src", "engine", "tests", "a.ts", "b.test.ts", "-e"), { minLength: 1, maxLength: 3 })
      .map((parts) => parts.join("/"));
    const cwd = fc.constantFrom(".", "engine", "src");
    const runner = fc.constantFrom<Readonly<Record<string, unknown>>>(AFFECTED_RUNNER, NODE_RUNNER);
    fc.assert(fc.property(fc.array(file, { maxLength: 6 }), cwd, runner, fc.constantFrom("T1", "T2", "T3"), (files, at, base, taskId) => {
      const graph = graphOf(bothRunners({ ...base, cwd: at }));
      const files$ = changed(...files);
      const plan = planStopChecks(graph, taskId, files$);
      if (plan.kind !== "known") throw new Error("every fixture Task is known");
      const all: readonly string[] = files$.kind === "none" ? [] : files$.files;
      const beneath = all.filter((path) => at === "." || path.startsWith(`${at}/`));
      const command = beneath.length === 0 ? null : affectedRunnerCheck(graph.verification_manifest!.affectedRunner!, nonEmptyOf(beneath));
      const expected = all.length === 0
        ? { kind: "off", reason: { kind: "no-changed-files", outsideCwd: null } }
        : command === null
          ? { kind: "off", reason: { kind: "no-changed-files", outsideCwd: all } }
          : command.ok
            ? { kind: "on", files: beneath, command: command.value, reportPath: AFFECTED_REPORT }
            : { kind: "off", reason: { kind: "command-refused", errors: command.error.errors } };
      expect(plan.affected).toEqual(expected);
    }));
  });
});

describe("renderStopChecksPlan", () => {
  it("refuses an unknown id exactly as the acceptance view does", () => {
    const graph = graphOf(bothRunners());
    expect(renderStopChecksPlan(graph, "T9", changed("src/a.ts"))).toEqual(renderStopCheckPlan(graph, "T9"));
    expect(renderStopChecksPlan(graph, "T9", NONE)).toEqual({ kind: "unknown-task", taskId: "T9", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });
    expect(stopChecksPlanView(graph, "T9", NONE)).toEqual({ kind: "unknown-task", taskId: "T9" });
  });

  it("AS-032: FR-028: renders the unchanged acceptance lines, then the changed files, cwd, expanded argv and report path", () => {
    const graph = graphOf(bothRunners());

    expect(renderedLines(graph, "T2", changed("src/payload.ts", "src/payload.test.ts"))).toEqual([
      ...acceptancePlanLines(graph, "T2"),
      AFFECTED_SECTION_HEADING,
      "  changed files:",
      "    src/payload.ts",
      "    src/payload.test.ts",
      "  cwd: .",
      `  argv: ${JSON.stringify(["vitest", "related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "src/payload.ts", "src/payload.test.ts"])}`,
      `  report: ${AFFECTED_REPORT}`,
    ]);
  });

  it("AS-032: FR-028: shows the files beneath the cwd by repository path and the argv relative to the cwd", () => {
    const graph = graphOf(bothRunners({ ...AFFECTED_RUNNER, cwd: "engine" }));

    expect(renderedLines(graph, "T3", changed("src/ledger.ts", "engine/src/a.ts")).slice(acceptancePlanLines(graph, "T3").length)).toEqual([
      AFFECTED_SECTION_HEADING,
      "  changed files:",
      "    engine/src/a.ts",
      "  cwd: engine",
      `  argv: ${JSON.stringify(["vitest", "related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "src/a.ts"])}`,
      `  report: ${AFFECTED_REPORT}`,
    ]);
  });

  it("AS-017: FR-017: AS-033: with no affected runner frozen, the affected section is off for no-runner alone", () => {
    for (const manifest of [frozen({ schemaVersion: 1 }), frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER })]) {
      const graph = graphOf(manifest);
      expect(renderedLines(graph, "T3", changed("src/ledger.ts"))).toEqual([...acceptancePlanLines(graph, "T3"), ...affectedOffSection("no-runner")]);
    }
  });

  it("AS-033: FR-028: with no changed files the affected section is off for that one reason", () => {
    const graph = graphOf(bothRunners());
    expect(renderedLines(graph, "T2", NONE)).toEqual([...acceptancePlanLines(graph, "T2"), ...affectedOffSection("no-changed-files")]);
  });

  it("AS-033: FR-028: names each changed file outside the runner cwd under the no-changed-files reason", () => {
    const graph = graphOf(bothRunners({ ...AFFECTED_RUNNER, cwd: "engine" }));

    expect(renderedLines(graph, "T3", changed("src/ledger.ts", "pi/x.ts"))).toEqual([
      ...acceptancePlanLines(graph, "T3"),
      ...affectedOffSection("no-changed-files"),
      `    ${AFFECTED_OUTSIDE_CWD_PREFIX}: src/ledger.ts`,
      `    ${AFFECTED_OUTSIDE_CWD_PREFIX}: pi/x.ts`,
    ]);
  });

  it("AS-033: FR-028: shows each refusal error under the command-refused reason", () => {
    const graph = graphOf(frozen({ schemaVersion: 2, affectedRunner: NODE_RUNNER }));
    const refused = affectedRunnerCheck(graph.verification_manifest!.affectedRunner!, nonEmptyOf(["src/ledger.test.js", "-e"]));
    if (refused.ok) throw new Error("node refuses an inline-evaluation option");

    expect(renderedLines(graph, "T3", changed("src/ledger.test.js", "-e"))).toEqual([
      ...acceptancePlanLines(graph, "T3"),
      ...affectedOffSection("command-refused"),
      ...refused.error.errors.map((error) => `    ${error}`),
    ]);
  });

  it("projects the CT-1 acceptance view unchanged inside the combined view", () => {
    const graph = graphOf(bothRunners());
    for (const taskId of ["T1", "T2", "T3"]) {
      const view = stopChecksPlanView(graph, taskId, changed("src/ledger.ts"));
      expect(view).toMatchObject({ kind: "known", acceptance: stopCheckPlanView(graph, taskId) });
    }
    expect(stopChecksPlanView(graph, "T3", changed("src/ledger.ts"))).toMatchObject({
      kind: "known",
      affected: {
        kind: "on",
        files: ["src/ledger.ts"],
        command: {
          argv: ["vitest", "related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "src/ledger.ts"],
          cwd: ".",
          reportPath: AFFECTED_REPORT,
        },
      },
    });
  });

  it("always begins with the CT-1 lines and renders exactly one affected section", () => {
    const file = fc.array(fc.constantFrom("src", "engine", "a.ts", "b.test.ts", "-e"), { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));
    const manifest = fc.constantFrom<FrozenVerificationManifest | undefined>(
      undefined,
      frozen({ schemaVersion: 1 }),
      bothRunners(),
      bothRunners({ ...AFFECTED_RUNNER, cwd: "engine" }),
      frozen({ schemaVersion: 2, affectedRunner: NODE_RUNNER }),
    );
    fc.assert(fc.property(manifest, fc.array(file, { maxLength: 5 }), fc.constantFrom("T1", "T2", "T3"), (m, files, taskId) => {
      const graph = graphOf(m);
      const lines = renderedLines(graph, taskId, changed(...files));
      const head = acceptancePlanLines(graph, taskId);
      expect(lines.slice(0, head.length)).toEqual(head);
      expect(lines.filter((line) => line === AFFECTED_SECTION_HEADING)).toHaveLength(1);
      expect(lines[head.length]).toBe(AFFECTED_SECTION_HEADING);
      const offLines = lines.filter((line) => line.startsWith(`  ${AFFECTED_STOP_CHECK_OFF} — `));
      const on = lines.includes("  changed files:");
      expect(Number(on) + offLines.length).toBe(1);
      expect(lines.some((line) => line.includes("{files}"))).toBe(false);
    }));
  });
});
