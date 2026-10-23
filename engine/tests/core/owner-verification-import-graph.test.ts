/**
 * `moduleEdges` (T5, AD-5): the matrix test's module edges, parsed with the
 * TypeScript compiler API from already-read text. Every module-import form
 * counts as an import, `export … from` as a re-export, and text that only
 * looks like an import (comments, plain strings, templates, computed
 * specifiers, member calls named `require`) never counts.
 */

import { describe, expect, it } from "vitest";
import { moduleEdges } from "../../src/core/owner-verification/import-graph";

describe("moduleEdges", () => {
  it("FR-005: collects every static import form", () => {
    const text = [
      'import { a } from "./a";',
      'import b from "./b";',
      'import * as c from "./c";',
      'import type { D } from "./d";',
      'import "./side-effect";',
      'import e = require("./e");',
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual({
      imports: ["./a", "./b", "./c", "./d", "./side-effect", "./e"],
      reexports: [],
    });
  });

  it("FR-005: collects string-literal dynamic import() and require() anywhere in the file", () => {
    const text = [
      'const f = require("./f");',
      'it("loads", async () => { const g = await import("./g"); return g; });',
      "function later() { return require(`./h`); }",
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text).imports).toEqual(["./f", "./g", "./h"]);
  });

  it("FR-005: AS-006: `export … from` is a re-export, in every form", () => {
    const text = [
      'export { a } from "./a";',
      'export * from "./b";',
      'export * as c from "./c";',
      'export type { D } from "./d";',
      "export const local = 1;",
      "const x = 2;\nexport { x };",
    ].join("\n");
    expect(moduleEdges("src/index.ts", text)).toEqual({ imports: [], reexports: ["./a", "./b", "./c", "./d"] });
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
    ].join("\n");
    expect(moduleEdges("tests/x.test.ts", text)).toEqual({ imports: [], reexports: [] });
  });

  it("parses TSX files without dropping their imports", () => {
    const text = 'import { View } from "./view";\nexport const App = () => <View title="x" />;\n';
    expect(moduleEdges("src/app.tsx", text).imports).toEqual(["./view"]);
  });

  it("keeps repeated specifiers once, in first-seen order", () => {
    const text = 'import "./a";\nimport { b } from "./b";\nimport { c } from "./a";\nexport * from "./b";\nexport * from "./b";\n';
    expect(moduleEdges("tests/x.test.ts", text)).toEqual({ imports: ["./a", "./b"], reexports: ["./b"] });
  });

  it("is total over unparseable text: syntax errors yield the edges the parser recovered, never a throw", () => {
    expect(() => moduleEdges("tests/x.test.ts", "import { from ;;; ((( export")).not.toThrow();
    expect(moduleEdges("tests/x.test.ts", 'import "./a";\nconst = = ;\n').imports).toEqual(["./a"]);
  });
});
