import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_FUNCTION_LINES_OPTIONS as DEFAULTS,
  detectFunctions,
  detectedLongFunctionKeys,
  handler,
  type MaxFunctionLinesOptions,
} from "../../../src/linter/programmatic/max-function-lines";
import type { Baseline } from "../../../src/linter/programmatic/baseline";
import { excludePatterns } from "../exclude-patterns";

/** The default options with another line limit. */
const limit = (maxLines: number): MaxFunctionLinesOptions => ({ ...DEFAULTS, maxLines });

/** A 50-line limit excluding `excludePatterns`, matched inside `projectRoot`. */
const excluding = (entries: readonly string[], projectRoot: string | null): MaxFunctionLinesOptions =>
  ({ ...DEFAULTS, maxLines: 50, excludePatterns: excludePatterns(...entries), projectRoot });

/** The default options with a grandfathered list, read inside `projectRoot`. */
const baselined = (baseline: Baseline, projectRoot: string | null = null): MaxFunctionLinesOptions =>
  ({ ...DEFAULTS, baseline, projectRoot });

/** `opening`, `count` statement lines, `closing`. */
const fn = (opening: string, count: number, closing = "}", indent = "  "): string =>
  [opening, ...Array.from({ length: count }, (_, i) => `${indent}const x${i} = ${i};`), closing].join("\n");

const messageFor = (name: string, lines: number, max = 50): string =>
  `Function "${name}" is ${lines} lines (max: ${max}). Decompose into smaller functions with single responsibilities.`;

describe("max-function-lines", () => {
  describe("detectFunctions", () => {
    it("detects simple function declaration", () => {
      const fns = detectFunctions(`function foo() {\n  const x = 1;\n  return x;\n}\n`, "src/foo.ts");
      expect(fns).toEqual([{ name: { kind: "named", name: "foo" }, startLine: 1, bodyLines: 2 }]);
    });

    it("detects async and exported functions", () => {
      expect(detectFunctions(`async function fetchData() {\n  await something();\n}\n`, "src/a.ts").map((f) => f.name))
        .toEqual([{ kind: "named", name: "fetchData" }]);
      expect(detectFunctions(`export function doStuff() {\n  return 42;\n}\n`, "src/a.ts").map((f) => f.name))
        .toEqual([{ kind: "named", name: "doStuff" }]);
    });

    it("detects arrow function with block body", () => {
      expect(detectFunctions(`const greet = (name: string) => {\n  return "hi";\n};\n`, "src/a.ts").map((f) => f.name))
        .toEqual([{ kind: "named", name: "greet" }]);
    });

    it("handles nested braces correctly", () => {
      const content = [
        "function outer() {",
        "  if (true) {",
        "    doSomething();",
        "  }",
        "  for (const x of items) {",
        "    process(x);",
        "  }",
        "}",
      ].join("\n");
      expect(detectFunctions(content, "src/a.ts")).toEqual([{ name: { kind: "named", name: "outer" }, startLine: 1, bodyLines: 6 }]);
    });

    it("measures a Java file by bracket depth: a constructor is a function, an if is not", () => {
      const content = ["public class Shop {", "  public Shop(String id) {", "    if (id == null) {", "      throw new IllegalArgumentException();", "    }", "  }", "}"].join("\n");
      expect(detectFunctions(content, "src/Shop.java")).toEqual([{ name: { kind: "named", name: "Shop" }, startLine: 2, bodyLines: 3 }]);
    });
  });

  describe("handler", () => {
    it("returns no violations for short functions", () => {
      expect(handler(`function short() {\n  return 1;\n}\n`, "src/foo.ts", DEFAULTS)).toHaveLength(0);
    });

    it("returns violation for function exceeding max lines", () => {
      const violations = handler(fn("function long() {", 60), "src/foo.ts", limit(50));
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("max-function-lines");
      expect(violations[0].line).toBe(1);
      expect(violations[0].fixHint).toContain("long");
      expect(violations[0].fixHint).toContain("60");
    });

    it("respects custom maxLines parameter", () => {
      const content = fn("function medium() {", 30);
      expect(handler(content, "src/foo.ts", limit(25))).toHaveLength(1);
      expect(handler(content, "src/foo.ts", limit(50))).toHaveLength(0);
    });

    it("excludes test files by default", () => {
      const content = fn("function long() {", 100);
      expect(handler(content, "src/foo.test.ts", DEFAULTS)).toHaveLength(0);
      expect(handler(content, "src/foo.spec.ts", DEFAULTS)).toHaveLength(0);
      expect(handler(content, "src/foo.property.test.ts", DEFAULTS)).toHaveLength(0);
    });

    it("excludes every file beneath a directory pattern, and not a sibling that shares its prefix", () => {
      const content = fn("function long() {", 100);
      const infra = excluding(["src/infra/"], "/work/shop");
      expect(handler(content, "src/infra/db.ts", infra)).toHaveLength(0);
      expect(handler(content, "/work/shop/src/infra/db.ts", infra)).toHaveLength(0);
      expect(handler(content, "src/infrastructure/db.ts", infra)).toHaveLength(1);
    });

    it("matches a directory pattern inside the project root, not against the directories above it", () => {
      const content = fn("function long() {", 100);
      const root = "/home/u/apps/shop";

      expect(handler(content, `${root}/src/order.ts`, excluding(["apps/"], root))).toHaveLength(1);
      expect(handler(content, `${root}/apps/demo/main.ts`, excluding(["apps/"], root))).toHaveLength(0);
      // With no project the frame is unknown: a directory excludes nothing.
      expect(handler(content, `${root}/src/order.ts`, excluding(["apps/"], null))).toHaveLength(1);
      expect(handler(content, `${root}/apps/demo/main.ts`, excluding(["apps/"], null))).toHaveLength(1);
    });

    it("reports multiple over-length functions", () => {
      const content = `${fn("function a() {", 55)}\n\n${fn("function b() {", 55)}`;
      expect(handler(content, "src/foo.ts", limit(50))).toHaveLength(2);
    });

    it("function at exactly maxLines is allowed, and one line more is not", () => {
      expect(handler(fn("function exact() {", 50), "src/foo.ts", limit(50))).toHaveLength(0);
      expect(handler(fn("function oneOver() {", 51), "src/foo.ts", limit(50))).toHaveLength(1);
    });
  });

  describe("handler: a function the regex detector reported is reported identically", () => {
    // Line, text and message are a violation's identity in every report a
    // project already holds: measuring from the AST must not move them.
    it.each([
      ["a function declaration", "function formatIfNeeded() {", "}", "formatIfNeeded"],
      ["an exported async function", "export async function fetchAll(id: string): Promise<void> {", "}", "fetchAll"],
      ["a block-bodied arrow const", "export const greet = async (name: string): Promise<string> => {", "};", "greet"],
    ])("%s", (_form, opening, closing, name) => {
      expect(handler(fn(opening, 60, closing), "src/foo.ts", DEFAULTS)).toEqual([
        { rule: "max-function-lines", file: "src/foo.ts", line: 1, text: opening, fixHint: messageFor(name, 60) },
      ]);
    });

    it.each([
      ["a class method", "  async searchForItems(query: string) {", "searchForItems"],
      ["a modified class method", "  private static rebuild() {", "rebuild"],
      ["a constructor", "  constructor(private readonly id: string) {", "constructor"],
    ])("%s", (_form, opening, name) => {
      const content = ["class Holder {", fn(opening, 60, "  }", "    "), "}"].join("\n");
      expect(handler(content, "src/foo.ts", DEFAULTS)).toEqual([
        { rule: "max-function-lines", file: "src/foo.ts", line: 2, text: opening.trim(), fixHint: messageFor(name, 60) },
      ]);
    });
  });

  describe("handler: the forms the regex detector missed", () => {
    it("a multi-line signature, an object-literal method and a nested callback, each reported on its own line", () => {
      const content = [
        "export function createScheduler(",
        "  deps: Deps,",
        "): Scheduler {",
        "  return {",
        fn("    start: async () => {", 55, "    },", "      "),
        fn("    run(items: readonly Item[]) {", 3, "    },", "      "),
        "  };",
        "}",
      ].join("\n");
      expect(handler(content, "src/scheduler.ts", DEFAULTS).map(({ line, text, fixHint }) => ({ line, text, fixHint }))).toEqual([
        { line: 1, text: "export function createScheduler(", fixHint: messageFor("createScheduler", 64) },
        { line: 5, text: "start: async () => {", fixHint: messageFor("start", 55) },
      ]);
    });

    it("an anonymous function is named by the line it starts on", () => {
      const content = ["items.forEach((item) => {", ...Array.from({ length: 51 }, () => "  use(item);"), "});"].join("\n");
      expect(handler(content, "src/a.ts", DEFAULTS).map((v) => v.fixHint)).toEqual([
        "Anonymous function at line 1 is 51 lines (max: 50). Decompose into smaller functions with single responsibilities.",
      ]);
    });

    it("a file with syntax errors reports what parsed and does not throw", () => {
      const content = `${fn("function intact() {", 55)}\nfunction broken( {\n  const = ;\n`;
      expect(() => handler(content, "src/broken.ts", DEFAULTS)).not.toThrow();
      expect(handler(content, "src/broken.ts", DEFAULTS).map((v) => v.line)).toContain(1);
    });

    it("a TSX component, excluded in its test file", () => {
      const content = fn("export function Page({ items }: Props) {", 55);
      expect(handler(content, "src/page.tsx", DEFAULTS).map((v) => v.fixHint)).toEqual([messageFor("Page", 55)]);
      expect(handler(content, "src/page.test.tsx", DEFAULTS)).toEqual([]);
    });
  });

  describe("baseline: grandfathered functions, keyed path::name", () => {
    const two = `${fn("function legacy() {", 60)}\n${fn("function fresh() {", 60)}`;

    it("excuses a baselined function and reports the rest", () => {
      expect(handler(two, "src/a.ts", baselined(["src/a.ts::legacy"])).map((v) => v.fixHint)).toEqual([messageFor("fresh", 60)]);
    });

    it("keeps excusing a baselined function that moved or grew: the key names the function, not its line or length", () => {
      const moved = `\n\n${fn("function legacy() {", 90)}`;
      expect(handler(moved, "src/a.ts", baselined(["src/a.ts::legacy"]))).toEqual([]);
    });

    it("spends one entry per function: a second anonymous function past the limit is reported", () => {
      const anonymous = `${fn("run(() => {", 55, "});")}\n${fn("run(() => {", 55, "});")}`;
      expect(handler(anonymous, "src/a.ts", baselined(["src/a.ts::<anonymous>"]))).toHaveLength(1);
      expect(handler(anonymous, "src/a.ts", baselined(["src/a.ts::<anonymous>", "src/a.ts::<anonymous>"]))).toEqual([]);
    });

    it("matches a key from the absolute path the lint pipeline hands the rule, and only in its own file", () => {
      const options = baselined(["src/a.ts::legacy", "src/a.ts::fresh"], "/work/shop");
      expect(handler(two, "/work/shop/src/a.ts", options)).toEqual([]);
      expect(handler(two, "/work/shop/src/b.ts", options)).toHaveLength(2);
    });

    it("detects the key of every function past the limit, honouring the exclusions, ignoring the baseline", () => {
      const options = baselined(["src/a.ts::legacy"], "/work/shop");
      expect(detectedLongFunctionKeys(two, "src/a.ts", options)).toEqual(["src/a.ts::legacy", "src/a.ts::fresh"]);
      expect(detectedLongFunctionKeys(two, "/work/shop/src/a.ts", options)).toEqual(["src/a.ts::legacy", "src/a.ts::fresh"]);
      expect(detectedLongFunctionKeys(two, "src/a.test.ts", options)).toEqual([]);
      expect(detectedLongFunctionKeys(fn("function short() {", 3), "src/a.ts", options)).toEqual([]);
    });
  });
});
