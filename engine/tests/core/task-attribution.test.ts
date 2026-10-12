import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inferSoleExecutingTask } from "../../src/core/task-attribution";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";

describe("inferSoleExecutingTask", () => {
  it.each<[readonly string[], ReturnType<typeof inferSoleExecutingTask>]>([
    [["T3"], { kind: "inferred", taskId: "T3" }],
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
  // Every way this codebase spells "the first / only executing Task": indexing,
  // .at(0), destructuring the executing set, or a strict or loose length-1 test.
  const PICK = new RegExp([
    String.raw`executing\w*(?:\s*\?\?\s*\[\])?\)?\s*(?:\[0\]|\.at\(\s*0\s*\))`,
    String.raw`executing\w*\.length\s*={2,3}\s*1\b`,
    String.raw`\b1\s*={2,3}\s*\(?[\w.]*executing\w*\.length`,
    String.raw`(?:const|let|var)\s*\[\s*\w+[^\]]*\]\s*=\s*\(?[\w.]*executing`,
  ].join("|"), "u");

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
    for (const line of [
      "const id = executing[0];",
      "if (executing.length === 1) {",
      "if (executing.length == 1) {",
      "if (1 === state.executing_tasks.length) {",
      "(state.executing_tasks ?? [])[0]",
      "executingTasks[0]!",
      "const only = executing.at(0);",
      "const [only] = state.executing_tasks ?? [];",
      "let [first, ...others] = executingTasks;",
    ]) {
      expect(PICK.test(line), line).toBe(true);
    }
    // Reads that check membership or count without picking a Task stay legal.
    for (const line of [
      "(state.executing_tasks ?? []).includes(taskId)",
      "executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== taskId),",
      "if (executing.length > 0) {",
    ]) {
      expect(PICK.test(line), line).toBe(false);
    }
  });
});
