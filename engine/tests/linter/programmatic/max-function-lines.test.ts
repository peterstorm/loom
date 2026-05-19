import { describe, it, expect } from "bun:test";
import {
  detectFunctions,
  handler,
  DEFAULT_MAX_LINES,
} from "../../../src/linter/programmatic/max-function-lines";

describe("max-function-lines", () => {
  describe("detectFunctions", () => {
    it("detects simple function declaration", () => {
      const content = `function foo() {\n  const x = 1;\n  return x;\n}\n`;
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("foo");
      expect(fns[0].bodyLines).toBe(2);
    });

    it("detects async function", () => {
      const content = `async function fetchData() {\n  await something();\n}\n`;
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("fetchData");
    });

    it("detects exported function", () => {
      const content = `export function doStuff() {\n  return 42;\n}\n`;
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("doStuff");
    });

    it("detects arrow function with block body", () => {
      const content = `const greet = (name: string) => {\n  return "hi";\n};\n`;
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("greet");
    });

    it("detects multiple functions", () => {
      const content = `function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n`;
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(2);
      expect(fns[0].name).toBe("a");
      expect(fns[1].name).toBe("b");
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
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("outer");
      expect(fns[0].bodyLines).toBe(6);
    });

    it("skips single-line comments", () => {
      const content = [
        "function foo() {",
        "  // this is a comment",
        "  return 1;",
        "}",
      ].join("\n");
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
    });

    it("handles block comments", () => {
      const content = [
        "/* comment */",
        "function foo() {",
        "  return 1;",
        "}",
      ].join("\n");
      const fns = detectFunctions(content);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe("foo");
    });
  });

  describe("handler", () => {
    it("returns no violations for short functions", () => {
      const content = `function short() {\n  return 1;\n}\n`;
      const violations = handler(content, "src/foo.ts");
      expect(violations).toHaveLength(0);
    });

    it("returns violation for function exceeding max lines", () => {
      const lines = ["function long() {"];
      for (let i = 0; i < 60; i++) {
        lines.push(`  const x${i} = ${i};`);
      }
      lines.push("}");
      const content = lines.join("\n");

      const violations = handler(content, "src/foo.ts", 50);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("max-function-lines");
      expect(violations[0].line).toBe(1);
      expect(violations[0].fixHint).toContain("long");
      expect(violations[0].fixHint).toContain("60");
    });

    it("respects custom maxLines parameter", () => {
      const lines = ["function medium() {"];
      for (let i = 0; i < 30; i++) {
        lines.push(`  const x${i} = ${i};`);
      }
      lines.push("}");
      const content = lines.join("\n");

      // 30 lines, max 25 → violation
      expect(handler(content, "src/foo.ts", 25)).toHaveLength(1);
      // 30 lines, max 50 → no violation
      expect(handler(content, "src/foo.ts", 50)).toHaveLength(0);
    });

    it("excludes test files by default", () => {
      const lines = ["function long() {"];
      for (let i = 0; i < 100; i++) {
        lines.push(`  const x${i} = ${i};`);
      }
      lines.push("}");
      const content = lines.join("\n");

      expect(handler(content, "src/foo.test.ts")).toHaveLength(0);
      expect(handler(content, "src/foo.spec.ts")).toHaveLength(0);
      expect(handler(content, "src/foo.property.test.ts")).toHaveLength(0);
    });

    it("reports multiple over-length functions", () => {
      const makeLong = (name: string) => {
        const lines = [`function ${name}() {`];
        for (let i = 0; i < 55; i++) lines.push(`  x${i};`);
        lines.push("}");
        return lines.join("\n");
      };

      const content = makeLong("a") + "\n\n" + makeLong("b");
      const violations = handler(content, "src/foo.ts", 50);
      expect(violations).toHaveLength(2);
    });

    it("function at exactly maxLines is allowed", () => {
      const lines = ["function exact() {"];
      for (let i = 0; i < 50; i++) {
        lines.push(`  const x${i} = ${i};`);
      }
      lines.push("}");
      const content = lines.join("\n");

      expect(handler(content, "src/foo.ts", 50)).toHaveLength(0);
    });

    it("function at maxLines+1 triggers violation", () => {
      const lines = ["function oneOver() {"];
      for (let i = 0; i < 51; i++) {
        lines.push(`  const x${i} = ${i};`);
      }
      lines.push("}");
      const content = lines.join("\n");

      expect(handler(content, "src/foo.ts", 50)).toHaveLength(1);
    });
  });
});
