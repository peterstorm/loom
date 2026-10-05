/**
 * Every `.each` table states its rows one way: all argument tuples, or all
 * single values — never a mix.
 *
 * Runners disagree on a mixed table. Vitest spreads rows only when EVERY row
 * is an array, so a mixed table hands each row over whole. Bun (like Jest)
 * spreads every array row, so a bare `[]` row becomes zero arguments: a
 * one-parameter callback then receives the runner's `done` callback instead,
 * and the case times out without ever asserting on the input it names. A
 * table that mixes the two shapes therefore means different inputs under
 * different runners. Writing such rows as explicit one-element tuples —
 * `it.each<[unknown]>([[null], [[]], ["text"]])` — means the same thing
 * everywhere.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TESTS_ROOT, "..");

/** The `file:line` of every `.each([...])` table whose rows mix array literals with other values. */
export function mixedEachTables(fileName: string, source: string): readonly string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "each" && node.arguments.length === 1) {
      const table = node.arguments[0]!;
      if (ts.isArrayLiteralExpression(table)) {
        const arrayRows = table.elements.filter((row) => ts.isArrayLiteralExpression(row)).length;
        if (arrayRows > 0 && arrayRows < table.elements.length) {
          found.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function testSources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("mixedEachTables", () => {
  it("flags a table mixing array rows with other rows, and only that table", () => {
    const source = [
      'it.each([null, [], "text"])("mixed %j", (raw) => {});',
      'it.each<[unknown]>([[null], [[]], ["text"]])("tuples %j", (raw) => {});',
      'it.each(["a", "b"])("values %s", (raw) => {});',
      'it.each([["label", 1], ["other", 2]])("rows %s", (_label, value) => {});',
      'describe.each([{ a: 1 }, [1]])("nested %j", () => {});',
    ].join("\n");
    expect(mixedEachTables("fixture.ts", source)).toEqual(["fixture.ts:1", "fixture.ts:5"]);
  });
});

describe("engine test tables", () => {
  it("never mix array rows with other rows", () => {
    const offenders = testSources(TESTS_ROOT).flatMap((path) =>
      mixedEachTables(relative(PACKAGE_ROOT, path), readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
