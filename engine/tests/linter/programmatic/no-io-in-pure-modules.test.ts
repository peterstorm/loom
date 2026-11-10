import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  classifyPurity,
  codeOfLine,
  DEFAULT_PURITY_SCOPE,
  isPureModule,
  handler,
  type PurityScope,
} from "../../../src/linter/programmatic/no-io-in-pure-modules";
import { LOOM_PURITY_SCOPE } from "../loom-project-config";

const scope = (pureModules: readonly string[], impureModules: PurityScope["impureModules"] = []): PurityScope =>
  ({ pureModules, impureModules });

describe("no-io-in-pure-modules", () => {
  describe("the generic default", () => {
    it("checks nothing: a project with no purity config has no functional core declared", () => {
      expect(DEFAULT_PURITY_SCOPE).toEqual({ pureModules: [], impureModules: [] });
      expect(isPureModule("engine/src/core/anything.ts", DEFAULT_PURITY_SCOPE)).toBe(false);
      expect(handler(`import { readFileSync } from "node:fs";\n`, "src/domain/order.ts")).toEqual([]);
    });
  });

  describe("classifyPurity: pure by default inside the roots, shells declared with their reason", () => {
    const shells = [{ path: "src/domain/repository.ts", reason: "reads orders from the database" }];
    const domain = scope(["src/domain/"], shells);

    it("holds every file beneath a root to purity, at any depth", () => {
      expect(classifyPurity("src/domain/order.ts", domain)).toEqual({ kind: "pure" });
      expect(classifyPurity("src/domain/model/line.ts", domain)).toEqual({ kind: "pure" });
    });

    it("names a declared shell inside a root with its reason", () => {
      expect(classifyPurity("src/domain/repository.ts", domain))
        .toEqual({ kind: "shell", path: "src/domain/repository.ts", reason: "reads orders from the database" });
    });

    it("never holds a test file to purity — tests own their I/O", () => {
      expect(classifyPurity("src/domain/order.test.ts", domain)).toEqual({ kind: "test" });
    });

    it("leaves a file outside every root unscoped", () => {
      expect(classifyPurity("src/api/routes.ts", domain)).toEqual({ kind: "unscoped" });
    });

    it("matches a root at a path boundary only, so an absolute path matches and a lookalike does not", () => {
      expect(isPureModule("/work/shop/src/domain/order.ts", domain)).toBe(true);
      expect(isPureModule("my-src/domain/order.ts", domain)).toBe(false);
      expect(isPureModule("src/domain-extra/order.ts", domain)).toBe(false);
    });

    it("handles Windows paths", () => {
      expect(isPureModule("src\\domain\\order.ts", domain)).toBe(true);
    });
  });

  describe("Loom's own scope (config.json)", () => {
    it("holds the core, machine, linter and parsers roots to purity", () => {
      for (const mod of [
        "engine/src/core/defect-family-accounting.ts",
        "engine/src/machine/advance.ts",
        "engine/src/linter/types.ts",
        "engine/src/linter/programmatic/config.ts",
        "engine/src/parsers/parse-transcript.ts",
      ]) expect(isPureModule(mod, LOOM_PURITY_SCOPE), mod).toBe(true);
    });

    it("declares the shells inside those roots, each with the I/O it does", () => {
      for (const mod of ["engine/src/linter/loader.ts", "engine/src/linter/index.ts", "engine/src/machine/ledger.ts"]) {
        const classified = classifyPurity(mod, LOOM_PURITY_SCOPE);
        expect(classified.kind, mod).toBe("shell");
        if (classified.kind === "shell") expect(classified.reason.length, mod).toBeGreaterThan(0);
      }
    });

    it("leaves the imperative shell directories outside the roots", () => {
      for (const mod of ["engine/src/handlers/pi-adapter.ts", "engine/src/orchestration/git-remediation.ts", "engine/src/state-manager.ts", "engine/src/cli.ts"]) {
        expect(classifyPurity(mod, LOOM_PURITY_SCOPE), mod).toEqual({ kind: "unscoped" });
      }
    });
  });

  describe("handler", () => {
    const pure = scope(["src/domain/"], [{ path: "src/domain/repository.ts", reason: "database reads" }]);
    const lint = (content: string, path = "src/domain/order.ts") => handler(content, path, pure);

    it("returns no violations for a declared shell, or a file outside the roots", () => {
      const content = `import { readFileSync } from "node:fs";\nconsole.log("hello");\n`;
      expect(lint(content, "src/domain/repository.ts")).toHaveLength(0);
      expect(lint(content, "src/api/routes.ts")).toHaveLength(0);
    });

    it("detects node:fs import in pure module", () => {
      const violations = lint(`import { readFileSync } from "node:fs";\n`);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("no-io-in-pure-modules");
      expect(violations[0].fixHint).toContain("node:fs");
    });

    it("detects node:child_process import", () => {
      expect(lint(`import { execSync } from "node:child_process";\n`)).toHaveLength(1);
    });

    it("allows node:path and node:url in pure modules", () => {
      expect(lint(`import { extname } from "node:path";\n`)).toHaveLength(0);
      expect(lint(`import { fileURLToPath } from "node:url";\n`)).toHaveLength(0);
    });

    it("detects process.env usage", () => {
      const violations = lint(`const val = process.env.FOO;\n`);
      expect(violations).toHaveLength(1);
      expect(violations[0].fixHint).toContain("process.env");
    });

    it("detects console.log, fetch(), Math.random() and new Date()", () => {
      expect(lint(`console.log("debug");\n`)).toHaveLength(1);
      expect(lint(`const res = await fetch("https://api.example.com");\n`)).toHaveLength(1);
      expect(lint(`const id = Math.random().toString(36);\n`)).toHaveLength(1);
      expect(lint(`const now = new Date();\n`)).toHaveLength(1);
    });

    it("allows new Date with argument (deterministic)", () => {
      expect(lint(`const d = new Date("2024-01-01");\nconst d2 = new Date(1234567890);\n`)).toHaveLength(0);
    });

    it("skips comment lines", () => {
      expect(lint(`// console.log("commented out");\n/* process.env.FOO */\n`)).toHaveLength(0);
    });

    it("does not read a banned global NAMED in a string or a trailing comment as a call", () => {
      expect(lint(`const hint = "process.exit (control flow side effect)";\n`)).toHaveLength(0);
      expect(lint(`const hint = 'use Date.now() in the shell';\n`)).toHaveLength(0);
      expect(lint(`const x = 1; // Math.random() lives in the shell\n`)).toHaveLength(0);
    });

    it("still reads code inside a template literal, and a line with an unclosed quote", () => {
      expect(lint("const home = `${process.env.HOME}`;\n")).toHaveLength(1);
      expect(lint(`const q = "a" + process.env.B + "\n`)).toHaveLength(1);
    });

    it("reads past a `//` inside a template literal or a regex literal — neither is a comment", () => {
      expect(lint("const url = `https://${process.env.HOST}/api`;\n")).toHaveLength(1);
      expect(lint("const url = `https://example.test/` + process.env.PATH_SUFFIX;\n")).toHaveLength(1);
      expect(lint("const scheme = /^https?:\\/\\//; const t = Date.now();\n")).toHaveLength(1);
      expect(lint("if (/a\\/\\/b/.test(s)) Math.random();\n")).toHaveLength(1);
      expect(lint("const r = [/x\\/\\//, Date.now()];\n")).toHaveLength(1);
    });

    it("carries template text across lines, so a continuation line's `//` is not a comment either", () => {
      const content = ["const page = `", "  see https://example.test ${process.env.HOST}", "`;"].join("\n");
      const violations = lint(content);
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(2);
    });

    it("reads code after a block comment that closes on the same line", () => {
      expect(lint("/* the shell's clock */ const t = Date.now();\n")).toHaveLength(1);
    });

    it("still treats a division as a division and the comment after it as a comment", () => {
      expect(lint("const half = total / 2; // Math.random() lives in the shell\n")).toHaveLength(0);
      expect(lint("const ratio = (a) / b / c; // process.env is read by the shell\n")).toHaveLength(0);
    });

    it("ignores an import named in a comment or a string, never one in code", () => {
      expect(lint(`/* import { readFileSync } from "node:fs"; */\nconst x = 1;\n`)).toHaveLength(0);
      expect(lint(`const hint = 'import x from "node:fs"';\n`)).toHaveLength(0);
      expect(lint(`/* a note */ import { readFileSync } from "node:fs";\n`)).toHaveLength(1);
    });

    it("reports multiple violations in one file", () => {
      const content = [
        `import { readFileSync } from "node:fs";`,
        `const x = process.env.FOO;`,
        `console.log(x);`,
      ].join("\n");
      expect(lint(content).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("codeOfLine", () => {
    it("empties quoted strings, drops a trailing comment, keeps template literals and escapes", () => {
      expect(codeOfLine(`call("a // b", 'c') // tail`)).toBe(`call("", '') `);
      expect(codeOfLine("x = `${y}` + 1")).toBe("x = `${y}` + 1");
      expect(codeOfLine(`s = "esc \\" quote" + t`)).toBe(`s = "" + t`);
    });

    it("keeps a `//` inside a template or regex literal, and the code after it", () => {
      expect(codeOfLine("u = `http://${h}` // tail")).toBe("u = `http://${h}` ");
      expect(codeOfLine("u = `${'a // b'}` + x")).toBe("u = `${''}` + x");
      expect(codeOfLine("r = /\\/\\//g; y // tail")).toBe("r = /\\/\\//g; y ");
      expect(codeOfLine("r = /[/]/; y")).toBe("r = /[/]/; y");
      expect(codeOfLine("q = a / b // tail")).toBe("q = a / b ");
      expect(codeOfLine("/* c */ code /* d */")).toBe(" code ");
    });

    it("leaves an unclosed quote or regex delimiter as code: when in doubt the text is checked", () => {
      expect(codeOfLine(`x = "open + y`)).toBe(`x = "open + y`);
      expect(codeOfLine("x = (/open + y")).toBe("x = (/open + y");
    });

    it("never drops a character that is not inside a string or a comment (property)", () => {
      fc.assert(fc.property(fc.stringMatching(/^[a-z $.(){}=+]*$/), (source) => {
        expect(codeOfLine(source)).toBe(source);
      }));
    });
  });
});
