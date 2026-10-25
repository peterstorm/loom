/**
 * `moduleEdges` (T5, AD-5): the matrix test's module edges, parsed with the
 * TypeScript compiler API from already-read text. Every module-import form
 * is an `import` edge, `export … from` a `reexport` edge, and text that only
 * looks like an import (comments, plain strings, templates, computed
 * specifiers, member calls named `require`) never counts. An edge erased at
 * runtime (`import type`, `export type … from`, all-`type` specifiers) is
 * tagged `typeOnly`, so coverage can ignore it.
 */

import { describe, expect, it } from "vitest";
import { moduleEdges, parseModule, syntaxErrorsOf, type Edge, type EdgeKind } from "../../src/core/owner-verification/import-graph";

const loaded = (kind: EdgeKind, specifier: string): Edge => ({ kind, specifier, typeOnly: false });
const erased = (kind: EdgeKind, specifier: string): Edge => ({ kind, specifier, typeOnly: true });
const specifiers = (path: string, text: string): readonly string[] => moduleEdges(path, text).map(({ specifier }) => specifier);

describe("moduleEdges", () => {
  it("FR-005: collects every static import form, tagging the type-only one", () => {
    const text = [
      'import { a } from "./a";',
      'import b from "./b";',
      'import * as c from "./c";',
      'import type { D } from "./d";',
      'import "./side-effect";',
      'import e = require("./e");',
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual([
      loaded("import", "./a"),
      loaded("import", "./b"),
      loaded("import", "./c"),
      erased("import", "./d"),
      loaded("import", "./side-effect"),
      loaded("import", "./e"),
    ]);
  });

  it("FR-005: collects string-literal dynamic import() and require() anywhere in the file", () => {
    const text = [
      'const f = require("./f");',
      'it("loads", async () => { const g = await import("./g"); return g; });',
      "function later() { return require(`./h`); }",
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual([loaded("import", "./f"), loaded("import", "./g"), loaded("import", "./h")]);
  });

  it("FR-005: AS-006: `export … from` is a re-export, in every form, tagging the type-only one", () => {
    const text = [
      'export { a } from "./a";',
      'export * from "./b";',
      'export * as c from "./c";',
      'export type { D } from "./d";',
      "export const local = 1;",
      "const x = 2;\nexport { x };",
    ].join("\n");
    expect(moduleEdges("src/index.ts", text)).toEqual([
      loaded("reexport", "./a"),
      loaded("reexport", "./b"),
      loaded("reexport", "./c"),
      erased("reexport", "./d"),
    ]);
  });

  it("FR-005: an import or re-export is type-only exactly when nothing it binds survives to runtime", () => {
    const text = [
      'import { type A, type B } from "./all-type-specifiers";',
      'import { type C, d } from "./mixed-specifiers";',
      'import E, { type F } from "./default-binding";',
      'import type * as G from "./type-namespace";',
      'import type H = require("./type-require");',
      'import {} from "./empty-braces";',
      'export { type I, type J } from "./all-type-reexport";',
      'export { type K, l } from "./mixed-reexport";',
      'export type * from "./type-star";',
      'export type * as M from "./type-star-namespace";',
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual([
      erased("import", "./all-type-specifiers"),
      loaded("import", "./mixed-specifiers"),
      loaded("import", "./default-binding"),
      erased("import", "./type-namespace"),
      erased("import", "./type-require"),
      loaded("import", "./empty-braces"),
      erased("reexport", "./all-type-reexport"),
      loaded("reexport", "./mixed-reexport"),
      erased("reexport", "./type-star"),
      erased("reexport", "./type-star-namespace"),
    ]);
  });

  it("FR-005: text that only looks like an import is not an edge", () => {
    const text = [
      '// import "./commented";',
      '/* require("./block-comment") */',
      'const path = "./plain-string";',
      "const template = `import(\"./in-template\")`;",
      "const computed = require(path);",
      "const dynamic = import(`./${path}`);",
      'const member = module.require("./member");',
      'const notRequire = requireLike("./other");',
      'type T = typeof import("./type-position");',
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual([]);
  });

  it("parses TSX files without dropping their imports", () => {
    const text = 'import { View } from "./view";\nexport const App = () => <View title="x" />;\n';
    expect(moduleEdges("src/app.tsx", text)).toEqual([loaded("import", "./view")]);
  });

  it("keeps each (kind, specifier) once, in first-seen order", () => {
    const text = 'import "./a";\nimport { b } from "./b";\nimport { c } from "./a";\nexport * from "./b";\nexport * from "./b";\n';
    expect(moduleEdges("tests/x.test.ts", text)).toEqual([loaded("import", "./a"), loaded("import", "./b"), loaded("reexport", "./b")]);
  });

  it("a specifier imported both as types and at runtime is a runtime edge, whichever comes first", () => {
    for (const text of [
      'import type { A } from "./a";\nimport { b } from "./a";\n',
      'import { b } from "./a";\nimport type { A } from "./a";\n',
    ]) {
      expect(moduleEdges("tests/x.test.ts", text)).toEqual([loaded("import", "./a")]);
    }
  });

  it("is total over unparseable text: syntax errors yield the edges the parser recovered, never a throw", () => {
    expect(() => moduleEdges("tests/x.test.ts", "import { from ;;; ((( export")).not.toThrow();
    expect(specifiers("tests/x.test.ts", 'import "./a";\nconst = = ;\n')).toEqual(["./a"]);
  });
});

describe("parseModule and syntaxErrorsOf: the parse both INV-1 seams share", () => {
  it("parses JSX in .tsx and .jsx paths and reports clean text as clean", () => {
    for (const path of ["src/app.tsx", "src/app.jsx"]) {
      expect(syntaxErrorsOf(parseModule(path, "export const App = () => <div title=\"x\">{1 < 2}</div>;\n"))).toEqual([]);
    }
  });

  it("parses a .ts path as TypeScript without JSX, so JSX there is a syntax error", () => {
    expect(syntaxErrorsOf(parseModule("src/app.ts", "export const App = () => <div>hi</div>;\n"))?.length).toBeGreaterThan(0);
    expect(syntaxErrorsOf(parseModule("src/cast.ts", "export const n = <number>(1 as unknown);\n"))).toEqual([]);
  });

  it("reports every syntax error as line:column and message", () => {
    const errors = syntaxErrorsOf(parseModule("src/broken.ts", "export const ok = 1;\nconst = = ;\n"));
    expect(errors).not.toBeNull();
    expect(errors!.length).toBeGreaterThan(0);
    expect(errors![0]).toMatch(/^2:\d+ \S/);
  });
});
