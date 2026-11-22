import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";

/**
 * A stop settles only through the exact attempt authority it carries
 * (ADR-0098). No module may guess which Task ran from the executing set: a
 * module that indexes or length-tests `executing_tasks` to pick a Task would
 * reintroduce attribution by convention.
 */
describe("no module guesses a Task from executing_tasks", () => {
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

  it("finds no module picking a Task from executing_tasks", () => {
    const offenders = [join(LOOM_PACKAGE_ROOT, "engine", "src"), join(LOOM_PACKAGE_ROOT, "pi")]
      .flatMap(sources)
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
