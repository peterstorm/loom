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

function unwrapped(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)
    ? unwrapped(expression.expression) : expression;
}

/** Every name the file binds exactly once, by `const NAME = [...]`. */
function constArrayTables(file: ts.SourceFile): ReadonlyMap<string, ts.ArrayLiteralExpression> {
  const bindings = new Map<string, ts.ArrayLiteralExpression | null>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer === undefined ? undefined : unwrapped(node.initializer);
      const isConst = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
      bindings.set(node.name.text,
        !bindings.has(node.name.text) && isConst && initializer !== undefined && ts.isArrayLiteralExpression(initializer)
          ? initializer : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return new Map([...bindings].flatMap(([name, table]) => table === null ? [] : [[name, table] as const]));
}

/**
 * The rows of one `.each` argument, or `null` when this file alone cannot say
 * what they are. An inline array literal is read directly, and an identifier
 * through the file's single `const` binding to an array literal. Out of the
 * guard's scope: computed tables (`cases.map(...)`), imported or `let`
 * bindings, names bound more than once, and tables with spread rows.
 */
function tableRows(
  table: ts.Expression,
  constTables: ReadonlyMap<string, ts.ArrayLiteralExpression>,
): readonly ts.Expression[] | null {
  const literal = ts.isArrayLiteralExpression(table) ? table
    : ts.isIdentifier(table) ? constTables.get(table.text) : undefined;
  return literal === undefined || literal.elements.some(ts.isSpreadElement) ? null : literal.elements;
}

/** The `file:line` of every `.each` table whose rows mix array literals with other values. */
export function mixedEachTables(fileName: string, source: string): readonly string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const constTables = constArrayTables(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "each" && node.arguments.length === 1) {
      const rows = tableRows(node.arguments[0]!, constTables) ?? [];
      const arrayRows = rows.filter((row) => ts.isArrayLiteralExpression(row)).length;
      if (arrayRows > 0 && arrayRows < rows.length) {
        found.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
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

  it("reads a table through the file's single const binding", () => {
    const source = [
      'const MIXED = [null, [], "text"] as const;',
      "const TUPLES = [[null], [[]]] satisfies readonly (readonly unknown[])[];",
      'it.each(MIXED)("mixed %j", (raw) => {});',
      'it.each(TUPLES)("tuples %j", (raw) => {});',
    ].join("\n");
    expect(mixedEachTables("fixture.ts", source)).toEqual(["fixture.ts:3"]);
  });

  it("leaves tables the file alone cannot describe out of scope", () => {
    const source = [
      'import { IMPORTED } from "./cases";',
      "let reassigned = [null, []];",
      "const SHADOWED = [null, []];",
      'function inner() { const SHADOWED = ["a"]; return SHADOWED; }',
      "const BASE = [[1]];",
      'it.each(IMPORTED)("imported %j", (raw) => {});',
      'it.each(reassigned)("let %j", (raw) => {});',
      'it.each(SHADOWED)("ambiguous %j", (raw) => {});',
      'it.each(BASE.map((row) => row))("computed %j", (raw) => {});',
      'it.each([...BASE, null])("spread %j", (raw) => {});',
    ].join("\n");
    expect(mixedEachTables("fixture.ts", source)).toEqual([]);
  });
});

describe("engine test tables", () => {
  it("never mix array rows with other rows", () => {
    const offenders = testSources(TESTS_ROOT).flatMap((path) =>
      mixedEachTables(relative(PACKAGE_ROOT, path), readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
