import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inferSoleExecutingTask } from "../../src/core/task-attribution";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";

describe("inferSoleExecutingTask", () => {
  it.each<[readonly string[], ReturnType<typeof inferSoleExecutingTask>]>([
    [["T3"], { kind: "inferred", taskId: "T3" as never }],
    [[], { kind: "unattributable", executingCount: 0 }],
    [["T3", "T4"], { kind: "unattributable", executingCount: 2 }],
  ])("infers from %j", (executing, expected) => {
    expect(inferSoleExecutingTask(executing)).toEqual(expected);
  });

  it("infers a Task exactly when one executes, and always names that Task", () => {
    fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }), (executing) => {
      const inference = inferSoleExecutingTask(executing);
      if (executing.length === 1) expect(inference).toEqual({ kind: "inferred", taskId: executing[0] });
      else expect(inference).toEqual({ kind: "unattributable", executingCount: executing.length });
    }));
  });
});

/**
 * Guessing a Task from the executing set is legacy-only and quarantine-only.
 * One constructor owns the guess; a module that indexes or length-tests the
 * executing set to pick a Task would reintroduce attribution by convention.
 */
describe("sole-executing inference has one owner", () => {
  const OWNER = "engine/src/core/task-attribution.ts";
  const PICK = /executing\w*(?:\s*\?\?\s*\[\])?\)?\s*\[0\]|executing\w*\.length\s*===\s*1\b/u;

  const sources = (dir: string): readonly string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });

  it("finds no other module picking a Task from executing_tasks", () => {
    const offenders = [join(LOOM_PACKAGE_ROOT, "engine", "src"), join(LOOM_PACKAGE_ROOT, "pi")]
      .flatMap(sources)
      .filter((path) => relative(LOOM_PACKAGE_ROOT, path) !== OWNER)
      .flatMap((path) => readFileSync(path, "utf8").split("\n")
        .flatMap((line, at) => (PICK.test(line) ? [`${relative(LOOM_PACKAGE_ROOT, path)}:${at + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });

  it("would catch the patterns it exists to refuse", () => {
    for (const line of ["const id = executing[0];", "if (executing.length === 1) {", "(state.executing_tasks ?? [])[0]", "executingTasks[0]!"]) {
      expect(PICK.test(line), line).toBe(true);
    }
  });
});
