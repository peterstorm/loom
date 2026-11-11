/**
 * The Distill Task rules (ADR-0068): which Waves get one and over which files,
 * when it may be dispatched, what its dispatch says, and which Distill Tasks a
 * reopening sweeps back.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DISTILL_APPENDIX_HEADER,
  distillDispatchBlockers,
  distillPlanNote,
  distillPromptAppendix,
  distillSnapshotRef,
  distillTasksReopenedWith,
  isDistillTask,
  planDistillTasks,
  plannedDistillTasks,
  type DistillPlanInput,
  type DistillSourceTask,
} from "../../src/core/distill-task";
import { DECISION_RECORD_AGENT, DISTILL_AGENT } from "../../src/core/model-profiles";
import type { FrozenRedThenGreenEra } from "../../src/core/proof-obligations";
import { ENGINE_DEFAULT_TEST_FILES } from "../../src/core/test-file-classification";
import type { TaskStatus } from "../../src/types";
import { siblingTaskFixture, type SiblingTaskFixtureInput } from "../fixtures/task-lifecycle";

const ERA: FrozenRedThenGreenEra = { kind: "owed-if-new-tests", testFiles: ENGINE_DEFAULT_TEST_FILES };

const source = (id: string, wave: number, file_list: readonly string[], agent = "code-implementer-agent"): DistillSourceTask =>
  ({ id, agent, wave, file_list });

const planning = (tasks: readonly DistillSourceTask[], overrides: Partial<DistillPlanInput> = {}) =>
  planDistillTasks({ tasks, contractTaskIds: new Set(), frozenPaths: [], era: ERA, setting: "on", ...overrides });

/** The Distill Tasks the roster gets. */
const plan = (tasks: readonly DistillSourceTask[], overrides: Partial<DistillPlanInput> = {}) =>
  plannedDistillTasks(planning(tasks, overrides));

describe("planDistillTasks", () => {
  it("adds one Task per Wave over its implementation files, numbered after the authored ids", () => {
    expect(plan([
      source("T1", 1, ["src/a.ts", "tests/a.test.ts"]),
      source("T7", 1, ["src/b.ts", "src/a.ts"]),
      source("T3", 2, ["src/c.ts"]),
    ])).toEqual([
      { id: "T8", wave: 1, scope: ["src/a.ts", "src/b.ts"], sourceTaskIds: ["T1", "T7"], description: expect.stringContaining("Wave 1") },
      { id: "T9", wave: 2, scope: ["src/c.ts"], sourceTaskIds: ["T3"], description: expect.stringContaining("T3") },
    ]);
  });

  it("takes nothing from a Contract Task, an ADR Task or a frozen path", () => {
    const tasks = [
      source("T1", 1, ["src/types.ts", "tests/acceptance.test.ts", "src/stub.ts"]),
      source("T2", 1, ["src/impl.ts", "./src/frozen-helper.ts"]),
      source("T3", 1, ["docs/adr/ADR-0001.md"], DECISION_RECORD_AGENT),
    ];
    expect(plan(tasks, { contractTaskIds: new Set(["T1"]), frozenPaths: ["src/frozen-helper.ts"] })).toMatchObject([
      { scope: ["src/impl.ts"], sourceTaskIds: ["T2"] },
    ]);
  });

  it.each<[string, readonly DistillSourceTask[], Partial<DistillPlanInput>]>([
    ["only test files", [source("T1", 1, ["tests/a.test.ts", "tests/b.spec.tsx"])], {}],
    ["only a Contract Task", [source("T1", 1, ["src/types.ts"])], { contractTaskIds: new Set(["T1"]) }],
    ["the pass turned off", [source("T1", 1, ["src/a.ts"])], { setting: "off" }],
    ["no frozen classification", [source("T1", 1, ["src/a.ts"])], { era: { kind: "not-owed" } }],
  ])("adds no Task for a roster with %s", (_label, tasks, overrides) => {
    expect(plan(tasks, overrides)).toEqual([]);
  });

  it("says why no Wave was planned, and tells a planned roster with nothing to distill apart from both", () => {
    const tasks = [source("T1", 1, ["src/a.ts"])];
    expect(planning(tasks, { setting: "off" })).toEqual({ kind: "not-planned", reason: "pass-off" });
    expect(planning(tasks, { era: { kind: "not-owed" } })).toEqual({ kind: "not-planned", reason: "no-frozen-classification" });
    // The operator's setting is the cause it names when both hold.
    expect(planning(tasks, { setting: "off", era: { kind: "not-owed" } })).toEqual({ kind: "not-planned", reason: "pass-off" });
    expect(planning([source("T1", 1, ["tests/a.test.ts"])])).toEqual({ kind: "planned", tasks: [] });
  });

  it("notes a missing pass only when the operator did not choose it", () => {
    const tasks = [source("T1", 1, ["src/a.ts"])];
    expect(distillPlanNote(planning(tasks, { era: { kind: "not-owed" } })))
      .toBe("No distill pass: the verification manifest froze no test-file classification, so no Distill Scope " +
        "can be derived and no Wave gets a Distill Task.");
    expect(distillPlanNote(planning(tasks, { setting: "off" }))).toBeNull();
    expect(distillPlanNote(planning(tasks))).toBeNull();
    expect(distillPlanNote(planning([source("T1", 1, ["tests/a.test.ts"])]))).toBeNull();
  });

  it("skips a Wave with nothing to distill without leaving a gap in the ids", () => {
    expect(plan([
      source("T1", 1, ["tests/only.test.ts"]),
      source("T2", 2, ["src/b.ts"]),
    ]).map(({ id, wave }) => ({ id, wave }))).toEqual([{ id: "T3", wave: 2 }]);
  });

  it("holds for every roster: unique fresh ids, one Task per Wave, and a scope drawn only from that Wave's implementation files", () => {
    const file = fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts", "tests/b.spec.ts", "docs/x.md");
    const roster = fc.uniqueArray(
      fc.record({ number: fc.integer({ min: 1, max: 40 }), wave: fc.integer({ min: 1, max: 4 }), files: fc.uniqueArray(file, { maxLength: 4 }) }),
      { selector: ({ number }) => number, minLength: 1, maxLength: 8 },
    ).map((rows) => rows.map(({ number, wave, files }) => source(`T${number}`, wave, files)));
    fc.assert(fc.property(roster, (tasks) => {
      const plans = plan(tasks);
      const authored = new Set(tasks.map(({ id }) => id));
      expect(new Set(plans.map(({ id }) => id)).size).toBe(plans.length);
      expect(plans.some(({ id }) => authored.has(id))).toBe(false);
      expect(new Set(plans.map(({ wave }) => wave)).size).toBe(plans.length);
      for (const { wave, scope } of plans) {
        const waveFiles = tasks.filter((task) => task.wave === wave).flatMap(({ file_list }) => file_list);
        expect(new Set(scope).size).toBe(scope.length);
        expect(scope.every((path) => waveFiles.includes(path) && !/\.(test|spec)\.tsx?$/.test(path))).toBe(true);
      }
    }));
  });
});

const sibling = (id: string, status: TaskStatus, overrides: Partial<SiblingTaskFixtureInput> = {}) =>
  siblingTaskFixture({ id, status, ...overrides });

const distill = (id = "T9", status: TaskStatus = "pending", wave = 1) =>
  sibling(id, status, { agent: DISTILL_AGENT, wave, file_list: ["src/T1.ts", "src/T2.ts"] });

describe("distillDispatchBlockers", () => {
  it("names every Wave sibling that is not implemented yet, in roster order", () => {
    const tasks = [sibling("T1", "implemented"), sibling("T2", "pending"), sibling("T3", "pending", { wave: 2 }), distill()];
    expect(distillDispatchBlockers(tasks, new Set(), distill())).toEqual(["T2"]);
  });

  it("still waits for an implemented sibling that holds a reservation", () => {
    const tasks = [sibling("T1", "implemented"), sibling("T2", "completed"), distill()];
    expect(distillDispatchBlockers(tasks, new Set(["T1"]), distill())).toEqual(["T1"]);
    expect(distillDispatchBlockers(tasks, new Set(), distill())).toEqual([]);
  });

  it("never withholds a Task that is not a Distill Task", () => {
    const tasks = [sibling("T1", "pending"), sibling("T2", "pending")];
    expect(isDistillTask(tasks[0]!)).toBe(false);
    expect(distillDispatchBlockers(tasks, new Set(), tasks[0]!)).toEqual([]);
  });
});

describe("distillPromptAppendix", () => {
  it("is found by its header and lists the scope sorted, whatever order the Task stores it in", () => {
    const appendix = distillPromptAppendix({ id: "T9", file_list: ["src/b.ts", "src/a.ts"] });
    expect(appendix.split("\n")[0]).toBe(DISTILL_APPENDIX_HEADER);
    expect(appendix).toContain("- src/a.ts\n- src/b.ts");
    expect(distillPromptAppendix({ id: "T9", file_list: ["src/a.ts", "src/b.ts"] })).toBe(appendix);
  });
});

describe("distillSnapshotRef", () => {
  it("names one ref per attempt authority", () => {
    expect(distillSnapshotRef("ab12")).toBe("refs/loom/distill/ab12");
  });
});

describe("distillTasksReopenedWith", () => {
  it("sweeps back the implemented Distill Task of each reopened Task's Wave, and no other", () => {
    const tasks = [
      sibling("T1", "implemented"),
      distill("T8", "implemented", 1),
      sibling("T2", "implemented", { wave: 2 }),
      distill("T9", "implemented", 2),
    ];
    expect(distillTasksReopenedWith(tasks, ["T1"])).toEqual(["T8"]);
    expect(distillTasksReopenedWith(tasks, ["T1", "T8"])).toEqual([]);
    expect(distillTasksReopenedWith([sibling("T1", "implemented"), distill("T8", "pending")], ["T1"])).toEqual([]);
  });
});
