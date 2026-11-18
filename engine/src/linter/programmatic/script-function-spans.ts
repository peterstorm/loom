/**
 * Every function in a TypeScript or JavaScript file, measured from the
 * compiler's own parse — the measurement max-function-lines judges.
 *
 * The linter's TypeScript compiler API seam (ADR-0095, beside the core's three
 * of ADR-0042 and ADR-0053), under the same parse-only contract: it calls
 * `ts.createSourceFile` on text it is given and visits nodes, never `ts.sys`,
 * a Program, module resolution or a type checker.
 *
 * One difference from the core seams: the compiler is required on first use,
 * not imported. Every edit's lint hook loads the rule registry, and
 * max-function-lines runs only at the Wave Gate; a static import would make
 * each edit pay the compiler's ~150 ms load for a rule it never runs.
 */

import { createRequire } from "node:module";
import type ts from "typescript";

/** What a function is called in a report: its own name, the binding it is
 *  assigned to, or nothing at all (a callback passed as an argument). */
export type FunctionName = Readonly<{ kind: "named"; name: string }> | Readonly<{ kind: "anonymous" }>;

/**
 * One function body. `startLine` is the 1-based line the function starts on,
 * past any decorators; `bodyLines` counts the lines strictly between the line
 * of its opening brace and the line of its closing brace.
 */
export type FunctionSpan = Readonly<{ name: FunctionName; startLine: number; bodyLines: number }>;

/** A function-like node that can carry a block body. */
type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const require = createRequire(import.meta.url);

/** The compiler, loaded once per process by the module cache. */
const compiler = (): typeof ts => require("typescript");

const named = (name: string): FunctionName => ({ kind: "named", name });
const ANONYMOUS: FunctionName = Object.freeze({ kind: "anonymous" });

/**
 * Every function with a block body in `text`, in source order: declarations,
 * expressions, block-bodied arrows, methods, constructors and accessors. A
 * nested function is a span of its own and is also counted in its parent's
 * lines. The script kind follows the path's extension (`.tsx`, `.jsx`, `.mts`,
 * `.cjs`, …). The parse tolerates syntax errors, so a broken file yields the
 * functions the parser recovered; it never throws on its input.
 */
export function scriptFunctionSpans(path: string, text: string): readonly FunctionSpan[] {
  const tsc = compiler();
  const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, true);
  const spans: FunctionSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionNode(tsc, node) && node.body !== undefined && tsc.isBlock(node.body)) {
      spans.push({ name: nameOf(tsc, node), startLine: startLine(tsc, source, node), bodyLines: bodyLines(source, node.body) });
    }
    tsc.forEachChild(node, visit);
  };
  visit(source);
  return Object.freeze(spans);
}

const isFunctionNode = (tsc: typeof ts, node: ts.Node): node is FunctionNode =>
  tsc.isFunctionDeclaration(node) ||
  tsc.isFunctionExpression(node) ||
  tsc.isArrowFunction(node) ||
  tsc.isMethodDeclaration(node) ||
  tsc.isConstructorDeclaration(node) ||
  tsc.isGetAccessorDeclaration(node) ||
  tsc.isSetAccessorDeclaration(node);

const lineOf = (source: ts.SourceFile, position: number): number => source.getLineAndCharacterOfPosition(position).line;

const bodyLines = (source: ts.SourceFile, body: ts.Block): number =>
  Math.max(0, lineOf(source, body.getEnd()) - lineOf(source, body.getStart(source)) - 1);

/** The function's first line past its decorators — where `async`, a modifier
 *  or the name stands, the line a reader looks for the function on. */
function startLine(tsc: typeof ts, source: ts.SourceFile, node: FunctionNode): number {
  const decorators = tsc.canHaveDecorators(node) ? tsc.getDecorators(node) ?? [] : [];
  const last = decorators.at(-1);
  if (last === undefined) return lineOf(source, node.getStart(source)) + 1;
  const scanner = tsc.createScanner(tsc.ScriptTarget.Latest, true, source.languageVariant, source.text, undefined, last.getEnd());
  scanner.scan();
  return lineOf(source, scanner.getTokenStart()) + 1;
}

/** A property, method or accessor name as written: an identifier, `#private`,
 *  a quoted or numeric key without its quotes, or a computed key's source. */
const propertyName = (tsc: typeof ts, name: ts.PropertyName): string =>
  tsc.isComputedPropertyName(name) ? name.getText() : name.text;

function nameOf(tsc: typeof ts, node: FunctionNode): FunctionName {
  if (tsc.isConstructorDeclaration(node)) return named("constructor");
  if (tsc.isArrowFunction(node) || (tsc.isFunctionExpression(node) && node.name === undefined)) return assignedName(tsc, node);
  // Only `export default function () {}` declares a function without a name.
  return node.name === undefined ? named("default") : named(propertyName(tsc, node.name));
}

/** The binding an unnamed function expression or arrow is assigned to, looking
 *  through parentheses and type assertions (`(async () => {}) as Runner`). */
function assignedName(tsc: typeof ts, node: ts.Expression): FunctionName {
  const holder = node.parent;
  if (
    tsc.isParenthesizedExpression(holder) ||
    tsc.isAsExpression(holder) ||
    tsc.isSatisfiesExpression(holder) ||
    tsc.isTypeAssertionExpression(holder) ||
    tsc.isNonNullExpression(holder)
  ) {
    return assignedName(tsc, holder);
  }
  if (tsc.isVariableDeclaration(holder)) return named(holder.name.getText());
  if (tsc.isPropertyDeclaration(holder) || tsc.isPropertyAssignment(holder)) return named(propertyName(tsc, holder.name));
  if (tsc.isExportAssignment(holder)) return named("default");
  if (tsc.isBinaryExpression(holder) && holder.operatorToken.kind === tsc.SyntaxKind.EqualsToken && holder.right === node) {
    return named(tsc.isPropertyAccessExpression(holder.left) ? holder.left.name.text : holder.left.getText());
  }
  return ANONYMOUS;
}
