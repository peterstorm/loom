/**
 * The parse-only compiler seam max-function-lines measures TypeScript and
 * JavaScript with (ADR-0095). Every case is plain text in, spans out: the
 * forms the regex-era detector missed, the forms it found (whose line and
 * length must not move), and the inputs a line scanner got wrong.
 */
import { describe, expect, it } from "vitest";
import { scriptFunctionSpans, type FunctionSpan } from "../../../src/linter/programmatic/script-function-spans";

/** `count` statement lines, each indented by `indent`. */
const body = (count: number, indent = "  "): readonly string[] =>
  Array.from({ length: count }, (_, index) => `${indent}step${index}();`);

const source = (...lines: readonly (string | readonly string[])[]): string => lines.flat().join("\n");

/** The spans as `name@line:bodyLines`, the shape every assertion compares. */
const spans = (text: string, path = "src/sample.ts"): readonly string[] =>
  scriptFunctionSpans(path, text).map(render);

const render = ({ name, startLine, bodyLines }: FunctionSpan): string =>
  `${name.kind === "named" ? name.name : "<anonymous>"}@${startLine}:${bodyLines}`;

describe("scriptFunctionSpans: the forms the regex detector already found keep their line and length", () => {
  it.each([
    ["a function declaration", "function foo() {", "}", "foo@1:3"],
    ["an exported async function", "export async function foo() {", "}", "foo@1:3"],
    ["a block-bodied arrow const", "const greet = (name: string) => {", "};", "greet@1:3"],
    ["an exported async arrow with a return type", "export const load = async (id: string): Promise<number> => {", "};", "load@1:3"],
    ["a function whose parameter type holds braces", "function f(x: { a: number }): { b: number } {", "}", "f@1:3"],
  ])("%s", (_form, open, close, expected) => {
    expect(spans(source(open, body(3), close))).toEqual([expected]);
  });

  it("a class method, a modified method and a constructor", () => {
    const text = source(
      "class Shop {",
      "  constructor(private readonly id: string) {",
      body(2, "    "),
      "  }",
      "  async open(query: string): Promise<void> {",
      body(4, "    "),
      "  }",
      "  private static close() {",
      body(1, "    "),
      "  }",
      "}",
    );
    expect(spans(text)).toEqual(["constructor@2:2", "open@6:4", "close@12:1"]);
  });

  it("counts the lines strictly between the brace lines: comments and blank lines included", () => {
    expect(spans(source("function f() {", "  // a comment", "", "  /* block", "  */", "  return 1;", "}"))).toEqual(["f@1:5"]);
  });

  it("a one-line body has no lines between its braces", () => {
    expect(spans("function f() { return 1; }")).toEqual(["f@1:0"]);
  });
});

describe("scriptFunctionSpans: the forms the regex detector missed", () => {
  it("a signature spanning several lines, measured from the line its body opens", () => {
    const text = source(
      "export function createScheduler(",
      "  deps: Deps,",
      "  options: Options,",
      "): Scheduler",
      "{",
      body(3),
      "}",
    );
    expect(spans(text)).toEqual(["createScheduler@1:3"]);
  });

  it("a multi-line arrow const", () => {
    const text = source("export const createAdapter = (", "  config: Config,", "): Adapter => {", body(4), "};");
    expect(spans(text)).toEqual(["createAdapter@1:4"]);
  });

  it("an arrow const whose initializer starts on the next line", () => {
    expect(spans(source("export const run =", "  async () => {", body(2), "  };"))).toEqual(["run@2:2"]);
  });

  it("a function nested in another is reported in its own right and counted in its parent", () => {
    const text = source(
      "function outer() {",
      "  const inner = () => {",
      body(3, "    "),
      "  };",
      "  return inner;",
      "}",
    );
    expect(spans(text)).toEqual(["outer@1:6", "inner@2:3"]);
  });

  it("object-literal methods, arrow and function-expression properties, getters and setters", () => {
    const text = source(
      "export const adapter = {",
      "  load: async (id: string) => {",
      body(2, "    "),
      "  },",
      "  save(x: number) {",
      body(1, "    "),
      "  },",
      "  'kebab-name': function () {",
      body(1, "    "),
      "  },",
      "  get size() {",
      body(1, "    "),
      "  },",
      "  set size(value: number) {",
      body(1, "    "),
      "  },",
      "};",
    );
    expect(spans(text)).toEqual(["load@2:2", "save@6:1", "kebab-name@9:1", "size@12:1", "size@15:1"]);
  });

  it("class property arrows, class accessors and private methods", () => {
    const text = source(
      "class Handler {",
      "  handle = async () => {",
      body(2, "    "),
      "  };",
      "  get ready(): boolean {",
      body(1, "    "),
      "  }",
      "  #reset() {",
      body(1, "    "),
      "  }",
      "}",
    );
    expect(spans(text)).toEqual(["handle@2:2", "ready@6:1", "#reset@9:1"]);
  });

  it("function expressions passed as arguments are anonymous, reported on their own line", () => {
    const text = source(
      "items.map(async (x) => {",
      body(2),
      "});",
      "setTimeout(function () {",
      body(1),
      "}, 10);",
    );
    expect(spans(text)).toEqual(["<anonymous>@1:2", "<anonymous>@5:1"]);
  });

  it("export default functions are named by their export", () => {
    expect(spans(source("export default function () {", body(2), "}"))).toEqual(["default@1:2"]);
    expect(spans(source("export default async () => {", body(2), "};"))).toEqual(["default@1:2"]);
    expect(spans(source("export default function main() {", body(2), "}"))).toEqual(["main@1:2"]);
  });

  it("names a function by the binding it is assigned to, through parentheses and assertions", () => {
    const text = source(
      "module.exports.start = function () {",
      body(1),
      "};",
      "const typed = (async () => {",
      body(1),
      "}) as Runner;",
      "handlers['save'] = () => {",
      body(1),
      "};",
    );
    expect(spans(text)).toEqual(["start@1:1", "typed@4:1", "handlers['save']@7:1"]);
  });

  it("a named function expression keeps its own name", () => {
    expect(spans(source("const alias = function real() {", body(1), "};"))).toEqual(["real@1:1"]);
  });

  it("reports a decorated method on the method's line, not the decorator's", () => {
    const text = source(
      "class Api {",
      "  @Get(':id')",
      "  @Auth()",
      "  async find(id: string) {",
      body(2, "    "),
      "  }",
      "}",
    );
    expect(spans(text)).toEqual(["find@4:2"]);
  });

  it("skips declarations without a body and expression-bodied arrows", () => {
    const text = source(
      "declare function ambient(): void;",
      "function overloaded(x: string): void;",
      "function overloaded(x: unknown) {",
      body(1),
      "}",
      "abstract class Base { abstract run(): void; }",
      "const short = (x: number) => x + 1;",
    );
    expect(spans(text)).toEqual(["overloaded@3:1"]);
  });
});

describe("scriptFunctionSpans: inputs a line scanner misread", () => {
  it("braces inside strings, template literals, regexes and comments do not move the body", () => {
    const text = source(
      "function tricky() {",
      "  const json = \"{ \\\"key\\\": \\\"}\\\" }\";",
      "  const single = '}';",
      "  const template = `${'{'} } ${`}`}`;",
      "  const pattern = /}{/;",
      "  // }",
      "  /* } */",
      "  return [json, single, template, pattern];",
      "}",
    );
    expect(spans(text)).toEqual(["tricky@1:7"]);
  });

  it("a multi-line template literal holding a function-looking line is not a function", () => {
    const text = source("const doc = `", "function fake() {", "}", "`;", "function real() {", body(1), "}");
    expect(spans(text)).toEqual(["real@5:1"]);
  });

  it("control-flow blocks are not functions", () => {
    expect(spans(source("if (ready) {", body(2), "}", "while (running) {", body(1), "}", "for (;;) {", "}"))).toEqual([]);
  });
});

describe("scriptFunctionSpans: every script spelling", () => {
  it("parses TSX: JSX bodies, generic arrows and components", () => {
    const text = source(
      "export function Page({ items }: Props) {",
      "  return (",
      "    <ul>",
      "      {items.map((item) => {",
      "        return <li key={item.id}>{item.name}</li>;",
      "      })}",
      "    </ul>",
      "  );",
      "}",
    );
    expect(spans(text, "src/page.tsx")).toEqual(["Page@1:7", "<anonymous>@4:1"]);
  });

  it("parses JSX in .jsx and .js files", () => {
    const text = source("export const App = () => {", "  return <div>{'}'}</div>;", "};");
    expect(spans(text, "src/app.jsx")).toEqual(["App@1:1"]);
    expect(spans(text, "src/app.js")).toEqual(["App@1:1"]);
  });

  it.each(["src/a.mts", "src/a.cts", "src/a.mjs", "src/a.cjs"])("parses %s", (path) => {
    expect(spans(source("export function f() {", body(2), "}"), path)).toEqual(["f@1:2"]);
  });
});

describe("scriptFunctionSpans: a file with syntax errors", () => {
  it("reports what the parser recovered and never throws", () => {
    const text = source(
      "function intact() {",
      body(2),
      "}",
      "function broken( {",
      "  const = ;",
      "}",
      "const after = () => {",
      body(1),
      "};",
    );
    expect(() => scriptFunctionSpans("src/broken.ts", text)).not.toThrow();
    expect(spans(text, "src/broken.ts")).toContain("intact@1:2");
  });

  it("an unclosed body runs to the end of the file", () => {
    expect(spans(source("function open() {", body(3)))).toEqual(["open@1:2"]);
  });

  it("an empty file has no functions", () => {
    expect(spans("")).toEqual([]);
  });
});
