/**
 * A module's import edges (AD-5), parsed with the TypeScript compiler API.
 * One of the two INV-1 seams allowed to import `typescript`; it parses
 * already-read text only: no `ts.sys`, no Program, no language service.
 *
 * - `imports`: static `import … from`, side-effect `import "…"`,
 *   `import x = require("…")`, and string-literal `import("…")` / `require("…")`
 *   calls anywhere in the file.
 * - `reexports`: `export … from "…"` in every form.
 *
 * Comments, plain strings, templates with substitutions, computed specifiers
 * and member calls such as `module.require("…")` are never edges. Each list
 * keeps a specifier once, in first-seen source order.
 */

import ts from "typescript";

export type ModuleEdges = Readonly<{ imports: readonly string[]; reexports: readonly string[] }>;

const scriptKindOf = (path: string): ts.ScriptKind =>
  path.endsWith(".tsx") ? ts.ScriptKind.TSX
  : path.endsWith(".jsx") ? ts.ScriptKind.JSX
  : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs") ? ts.ScriptKind.JS
  : ts.ScriptKind.TS;

/** The specifier a node contributes, tagged by edge kind; null when it is no module edge. */
const edgeOf = (node: ts.Node): Readonly<{ kind: "import" | "reexport"; specifier: string }> | null => {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return { kind: "import", specifier: node.moduleSpecifier.text };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return { kind: "reexport", specifier: node.moduleSpecifier.text };
  }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return { kind: "import", specifier: node.moduleReference.expression.text };
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const first = node.arguments[0]!;
    const isModuleCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require");
    if (isModuleCall && ts.isStringLiteralLike(first)) return { kind: "import", specifier: first.text };
  }
  return null;
};

export const moduleEdges = (path: string, text: string): ModuleEdges => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKindOf(path));
  const edges: { kind: "import" | "reexport"; specifier: string }[] = [];
  const visit = (node: ts.Node): void => {
    const edge = edgeOf(node);
    if (edge !== null) edges.push(edge);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const unique = (kind: "import" | "reexport"): readonly string[] =>
    [...new Set(edges.filter((edge) => edge.kind === kind).map((edge) => edge.specifier))];
  return { imports: unique("import"), reexports: unique("reexport") };
};
