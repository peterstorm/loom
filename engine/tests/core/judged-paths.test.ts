import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  judgedPathProblems,
  parseJudgedPaths,
  renderJudgedPathProblem,
  type JudgedPathTaskView,
} from "../../src/core/judged-paths";

const view = (id: string, wave: number, fileList: readonly string[], judgedPaths: readonly string[] = []): JudgedPathTaskView =>
  ({ id, wave, fileList, judgedPaths });

describe("parseJudgedPaths", () => {
  it("reads an absent field as no judged paths", () => {
    expect(parseJudgedPaths(undefined, "T1")).toEqual({ ok: true, value: [] });
  });

  it("admits distinct repository-relative paths", () => {
    expect(parseJudgedPaths(["src/a.ts", "src/b.ts"], "T1")).toEqual({ ok: true, value: ["src/a.ts", "src/b.ts"] });
  });

  it("refuses a non-array, a repeat, and a path that is not repository-relative, naming the Task", () => {
    expect(parseJudgedPaths("src/a.ts", "T1")).toEqual({ ok: false, errors: ["Task T1: 'judged_paths' must be an array of paths"] });
    const repeated = parseJudgedPaths(["src/a.ts", "src/a.ts"], "T2");
    expect(repeated).toEqual({ ok: false, errors: ["Task T2: judged_paths repeats 'src/a.ts'"] });
    const absolute = parseJudgedPaths(["/abs/a.ts", "../up.ts", 3], "T3");
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) {
      expect(absolute.errors).toHaveLength(3);
      for (const error of absolute.errors) expect(error).toContain("Task T3: judged_paths[");
    }
  });
});

describe("judgedPathProblems", () => {
  it("refuses the host-memory shape: a later-Wave budget test judging code completed Waves wrote", () => {
    const roster = [
      view("T9", 3, ["lib/lead-snapshot/recompute.ts"]),
      view("T10", 4, ["dags/lead-scoring/dag.ts"]),
      view("T12", 5, ["tests/bench/memory-budgets.test.ts"], ["lib/lead-snapshot/recompute.ts", "dags/lead-scoring/dag.ts"]),
    ];
    expect(judgedPathProblems(roster)).toEqual([
      { kind: "earlier-writer", taskId: "T12", wave: 5, path: "lib/lead-snapshot/recompute.ts", writerId: "T9", writerWave: 3 },
      { kind: "earlier-writer", taskId: "T12", wave: 5, path: "dags/lead-scoring/dag.ts", writerId: "T10", writerWave: 4 },
    ]);
  });

  it("admits a judge in the writer's Wave or an earlier one", () => {
    const roster = [
      view("T1", 1, ["tests/budget.test.ts"], ["src/serve.ts"]),
      view("T2", 2, ["src/serve.ts"]),
      view("T3", 2, ["tests/same-wave.test.ts"], ["src/serve.ts"]),
    ];
    expect(judgedPathProblems(roster)).toEqual([]);
  });

  it("refuses a path no Task writes and a path the judge writes itself", () => {
    const roster = [view("T1", 1, ["src/own.ts", "tests/t.test.ts"], ["src/own.ts", "src/nobody.ts"])];
    expect(judgedPathProblems(roster)).toEqual([
      { kind: "self-written", taskId: "T1", path: "src/own.ts" },
      { kind: "unwritten", taskId: "T1", path: "src/nobody.ts" },
    ]);
  });

  it("renders every problem with the Task, the path and the fix", () => {
    const [earlier] = judgedPathProblems([view("W", 1, ["a.ts"]), view("J", 2, [], ["a.ts"])]);
    expect(earlier).toBeDefined();
    const rendered = renderJudgedPathProblem(earlier!);
    expect(rendered).toContain("Task J (Wave 2) judges 'a.ts', which W writes in the earlier Wave 1");
    expect(rendered).toContain("Acceptance Contract");
    expect(renderJudgedPathProblem({ kind: "unwritten", taskId: "J", path: "b.ts" })).toContain("no fixer");
    expect(renderJudgedPathProblem({ kind: "self-written", taskId: "J", path: "c.ts" })).toContain("remove it from judged_paths");
  });

  // A roster of writers over a small path alphabet, plus one judge per case.
  const paths = fc.constantFrom("a.ts", "b.ts", "c.ts", "d.ts");
  const writer = fc.record({
    wave: fc.integer({ min: 1, max: 5 }),
    fileList: fc.uniqueArray(paths, { maxLength: 3 }),
  });
  const rosterArb = fc.tuple(
    fc.array(writer, { minLength: 1, maxLength: 5 }),
    fc.integer({ min: 1, max: 5 }),
    fc.uniqueArray(paths, { minLength: 1, maxLength: 4 }),
  ).map(([writers, judgeWave, judged]) => [
    ...writers.map((w, index) => view(`W${index}`, w.wave, w.fileList)),
    view("J", judgeWave, [], judged),
  ]);

  it("property: a roster passes exactly when every judged path has a writer and none is in an earlier Wave", () => {
    fc.assert(fc.property(rosterArb, (roster) => {
      const judge = roster.at(-1)!;
      const writersOf = (path: string) => roster.filter((task) => task !== judge && task.fileList.includes(path));
      const repairable = judge.judgedPaths.every((path) =>
        writersOf(path).length > 0 && writersOf(path).every((writer) => writer.wave >= judge.wave));
      expect(judgedPathProblems(roster).length === 0).toBe(repairable);
    }));
  });

  it("property: raising the judge's Wave never removes an earlier-writer problem", () => {
    fc.assert(fc.property(rosterArb, fc.integer({ min: 0, max: 3 }), (roster, raise) => {
      const judge = roster.at(-1)!;
      const raised = [...roster.slice(0, -1), { ...judge, wave: judge.wave + raise }];
      const earlier = (r: readonly JudgedPathTaskView[]) =>
        judgedPathProblems(r).filter((problem) => problem.kind === "earlier-writer").length;
      expect(earlier(raised)).toBeGreaterThanOrEqual(earlier(roster));
    }));
  });

  it("property: a roster with no judged paths has no problems", () => {
    fc.assert(fc.property(fc.array(writer, { maxLength: 6 }), (writers) => {
      expect(judgedPathProblems(writers.map((w, index) => view(`W${index}`, w.wave, w.fileList)))).toEqual([]);
    }));
  });
});
