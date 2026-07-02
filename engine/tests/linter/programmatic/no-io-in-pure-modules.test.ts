import { describe, it, expect } from "vitest";
import {
  isPureModule,
  handler,
  DEFAULT_PURE_MODULES,
} from "../../../src/linter/programmatic/no-io-in-pure-modules";

describe("no-io-in-pure-modules", () => {
  describe("isPureModule", () => {
    it("matches exact file paths", () => {
      expect(isPureModule("engine/src/linter/types.ts")).toBe(true);
      expect(isPureModule("engine/src/linter/formatter.ts")).toBe(true);
    });

    it("matches prefix patterns (directories)", () => {
      expect(isPureModule("engine/src/core/validate-phase-order.ts")).toBe(true);
      expect(isPureModule("engine/src/parsers/parse-transcript.ts")).toBe(true);
    });

    it("does not match non-pure modules", () => {
      expect(isPureModule("engine/src/linter/loader.ts")).toBe(false);
      expect(isPureModule("engine/src/linter/index.ts")).toBe(false);
      expect(isPureModule("engine/src/handlers/pi-adapter.ts")).toBe(false);
      expect(isPureModule("engine/src/state-manager.ts")).toBe(false);
    });

    it("handles Windows paths", () => {
      expect(isPureModule("engine\\src\\core\\validate-phase-order.ts")).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns no violations for non-pure modules", () => {
      const content = `import { readFileSync } from "node:fs";\nconsole.log("hello");\n`;
      const violations = handler(content, "engine/src/linter/loader.ts");
      expect(violations).toHaveLength(0);
    });

    it("detects node:fs import in pure module", () => {
      const content = `import { readFileSync } from "node:fs";\n`;
      const violations = handler(content, "engine/src/linter/types.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("no-io-in-pure-modules");
      expect(violations[0].fixHint).toContain("node:fs");
    });

    it("detects node:child_process import", () => {
      const content = `import { execSync } from "node:child_process";\n`;
      const violations = handler(content, "engine/src/core/validate.ts");
      expect(violations).toHaveLength(1);
    });

    it("allows node:path in pure modules", () => {
      const content = `import { extname } from "node:path";\n`;
      const violations = handler(content, "engine/src/linter/executor.ts");
      expect(violations).toHaveLength(0);
    });

    it("allows node:url in pure modules", () => {
      const content = `import { fileURLToPath } from "node:url";\n`;
      const violations = handler(content, "engine/src/linter/formatter.ts");
      expect(violations).toHaveLength(0);
    });

    it("detects process.env usage", () => {
      const content = `const val = process.env.FOO;\n`;
      const violations = handler(content, "engine/src/core/something.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].fixHint).toContain("process.env");
    });

    it("detects console.log", () => {
      const content = `console.log("debug");\n`;
      const violations = handler(content, "engine/src/parsers/parse-transcript.ts");
      expect(violations).toHaveLength(1);
    });

    it("detects fetch()", () => {
      const content = `const res = await fetch("https://api.example.com");\n`;
      const violations = handler(content, "engine/src/core/something.ts");
      expect(violations).toHaveLength(1);
    });

    it("detects Math.random()", () => {
      const content = `const id = Math.random().toString(36);\n`;
      const violations = handler(content, "engine/src/linter/formatter.ts");
      expect(violations).toHaveLength(1);
    });

    it("detects new Date() without argument", () => {
      const content = `const now = new Date();\n`;
      const violations = handler(content, "engine/src/core/something.ts");
      expect(violations).toHaveLength(1);
    });

    it("allows new Date with argument (deterministic)", () => {
      const content = `const d = new Date("2024-01-01");\nconst d2 = new Date(1234567890);\n`;
      const violations = handler(content, "engine/src/core/something.ts");
      expect(violations).toHaveLength(0);
    });

    it("skips comment lines", () => {
      const content = `// console.log("commented out");\n/* process.env.FOO */\n`;
      const violations = handler(content, "engine/src/core/something.ts");
      expect(violations).toHaveLength(0);
    });

    it("reports multiple violations in one file", () => {
      const content = [
        `import { readFileSync } from "node:fs";`,
        `const x = process.env.FOO;`,
        `console.log(x);`,
      ].join("\n");
      const violations = handler(content, "engine/src/parsers/parse-stuff.ts");
      expect(violations.length).toBeGreaterThanOrEqual(3);
    });
  });
});
