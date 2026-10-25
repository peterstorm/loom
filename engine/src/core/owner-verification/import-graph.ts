/**
 * A module's import edges (AD-5), parsed with the TypeScript compiler API.
 * One of the two INV-1 seams allowed to import `typescript`; it parses
 * already-read text only: no `ts.sys`, no Program, no language service.
 *
 * - `import` edges: static `import … from`, side-effect `import "…"`,
 *   `import x = require("…")`, and string-literal `import("…")` / `require("…")`
 *   calls anywhere in the file.
 * - `reexport` edges: `export … from "…"` in every form.
 * - `typeOnly`: the edge is erased at runtime and never loads its module:
 *   `import type`, `export type … from`, `import type x = require(…)`, and an
 *   import or export whose every named specifier is `type` (with no default
 *   or namespace binding). Coverage ignores such edges.
 *
 * Comments, plain strings, templates with substitutions, computed specifiers
 * and member calls such as `module.require("…")` are never edges. Each
 * (kind, specifier) appears once, in first-seen source order, and is
 * type-only only when every occurrence is.
 *
 * `parseModule` is the one parse both INV-1 seams share (this module and
 * `mutation-plan.ts`): the script kind comes from the path's extension, so a
 * `.tsx` or `.jsx` module is parsed with JSX, and `syntaxErrorsOf` reads the
 * parser's diagnostics back.
 */

import ts from "typescript";

export type EdgeKind = "import" | "reexport";

/** One module edge: how it is written, what it names, and whether it is erased at runtime. */
export type Edge = Readonly<{ kind: EdgeKind; specifier: string; typeOnly: boolean }>;

/** A module's edges, in first-seen source order. */
export type ModuleEdges = readonly Edge[];

/** The one path-to-script-kind rule: JSX for `.tsx`/`.jsx`, JavaScript for `.js`/`.mjs`/`.cjs`, TypeScript otherwise. */
const scriptKindOf = (path: string): ts.ScriptKind =>
  path.endsWith(".tsx") ? ts.ScriptKind.TSX
  : path.endsWith(".jsx") ? ts.ScriptKind.JSX
  : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs") ? ts.ScriptKind.JS
  : ts.ScriptKind.TS;

/** Parses already-read module text with the script kind its path names, parent pointers set. */
export const parseModule = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));

/**
 * Every syntax error the parser reported, as `line:column message`; `[]` for
 * clean text. Null when this TypeScript exposes no parse diagnostics at all,
 * so a caller can fail closed rather than read silence as clean.
 */
export const syntaxErrorsOf = (source: ts.SourceFile): readonly string[] | null => {
  // The parser's own diagnostics are not in the public typings, so they are
  // read as unknown and proven an array before use.
  const diagnostics: unknown = "parseDiagnostics" in source ? source.parseDiagnostics : undefined;
  if (!Array.isArray(diagnostics)) return null;
  return diagnostics.map((diagnostic: ts.Diagnostic) => {
    const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
};

const everySpecifierTypeOnly = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean =>
  elements.length > 0 && elements.every((element) => element.isTypeOnly);

/** Whether an import declaration binds types only: `import type`, or only `type` specifiers and no default binding. */
const importIsTypeOnly = (clause: ts.ImportClause | undefined): boolean => {
  if (clause === undefined) return false;
  // `phaseModifier` exists from TypeScript 5.9; engine/package.json declares
  // `typescript` a runtime dependency at ^5.9.0, so it is always present here.
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && everySpecifierTypeOnly(bindings.elements);
};

/** Whether a re-export carries types only: `export type … from`, or only `type` specifiers. */
const exportIsTypeOnly = (node: ts.ExportDeclaration): boolean =>
  node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && everySpecifierTypeOnly(node.exportClause.elements));

/** The edge a node contributes; null when it is no module edge. */
const edgeOf = (node: ts.Node): Edge | null => {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return { kind: "import", specifier: node.moduleSpecifier.text, typeOnly: importIsTypeOnly(node.importClause) };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return { kind: "reexport", specifier: node.moduleSpecifier.text, typeOnly: exportIsTypeOnly(node) };
  }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return { kind: "import", specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly };
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const first = node.arguments[0]!;
    const isModuleCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require");
    if (isModuleCall && ts.isStringLiteralLike(first)) return { kind: "import", specifier: first.text, typeOnly: false };
  }
  return null;
};

/** Each (kind, specifier) once, in first-seen order; a runtime occurrence makes the edge runtime. */
const mergeEdges = (edges: readonly Edge[]): ModuleEdges => {
  const merged = new Map<string, Edge>();
  for (const edge of edges) {
    const key = `${edge.kind}\0${edge.specifier}`;
    const seen = merged.get(key);
    merged.set(key, seen === undefined ? edge : { ...seen, typeOnly: seen.typeOnly && edge.typeOnly });
  }
  return [...merged.values()];
};

export const moduleEdges = (path: string, text: string): ModuleEdges => {
  const edges: Edge[] = [];
  const visit = (node: ts.Node): void => {
    const edge = edgeOf(node);
    if (edge !== null) edges.push(edge);
    ts.forEachChild(node, visit);
  };
  visit(parseModule(path, text));
  return mergeEdges(edges);
};
