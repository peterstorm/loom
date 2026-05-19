import { describe, it, expect } from "bun:test";
import {
  extractImports,
  resolveImportPath,
  checkBoundaryViolation,
  handler,
  DEFAULT_BOUNDARIES,
} from "../../../src/linter/programmatic/no-cross-boundary-imports";

describe("no-cross-boundary-imports", () => {
  describe("extractImports", () => {
    it("extracts ESM import from", () => {
      const content = `import { foo } from "../core/bar";`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("../core/bar");
      expect(imports[0].line).toBe(1);
    });

    it("extracts side-effect import", () => {
      const content = `import "node:path";`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("node:path");
    });

    it("extracts require", () => {
      const content = `const x = require("fs");`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("fs");
    });

    it("extracts dynamic import", () => {
      const content = `const mod = await import("./foo");`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("./foo");
    });

    it("skips comment lines", () => {
      const content = `// import { foo } from "bad";\nimport { bar } from "./ok";`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("./ok");
    });

    it("handles multi-line imports", () => {
      const content = `import {\n  foo,\n  bar,\n} from "../types";`;
      const imports = extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0].specifier).toBe("../types");
      expect(imports[0].line).toBe(4); // from is on line 4
    });

    it("returns empty for no imports", () => {
      const content = `const x = 42;\nconst y = x + 1;`;
      expect(extractImports(content)).toHaveLength(0);
    });
  });

  describe("checkBoundaryViolation", () => {
    it("allows relative imports within same module", () => {
      const result = checkBoundaryViolation(
        "engine/src/linter/loader.ts",
        "engine/src/linter/types",
        DEFAULT_BOUNDARIES
      );
      expect(result).toBeNull();
    });

    it("denies linter importing from core", () => {
      const result = checkBoundaryViolation(
        "engine/src/linter/loader.ts",
        "engine/src/core/validate-phase-order",
        DEFAULT_BOUNDARIES
      );
      expect(result).not.toBeNull();
      expect(result).toContain("must not import");
    });

    it("denies linter importing from handlers", () => {
      const result = checkBoundaryViolation(
        "engine/src/linter/executor.ts",
        "engine/src/handlers/pi-adapter",
        DEFAULT_BOUNDARIES
      );
      expect(result).not.toBeNull();
    });

    it("denies core importing from linter", () => {
      const result = checkBoundaryViolation(
        "engine/src/core/validate-phase-order.ts",
        "engine/src/linter/types",
        DEFAULT_BOUNDARIES
      );
      expect(result).not.toBeNull();
    });

    it("denies parsers importing from handlers", () => {
      const result = checkBoundaryViolation(
        "engine/src/parsers/parse-transcript.ts",
        "engine/src/handlers/dispatch",
        DEFAULT_BOUNDARIES
      );
      expect(result).not.toBeNull();
    });

    it("allows files outside boundary rules", () => {
      const result = checkBoundaryViolation(
        "engine/src/handlers/pi-adapter.ts",
        "engine/src/linter/index",
        DEFAULT_BOUNDARIES
      );
      expect(result).toBeNull(); // handlers have no boundary rule — allowed
    });

    it("allows node: imports in linter", () => {
      const result = checkBoundaryViolation(
        "engine/src/linter/loader.ts",
        "node:fs",
        DEFAULT_BOUNDARIES
      );
      expect(result).toBeNull();
    });
  });

  describe("handler", () => {
    it("returns no violations for clean linter file", () => {
      const content = `import { type Rule } from "./types";\nimport { analyzeRegex } from "./safety";\n`;
      const violations = handler(content, "engine/src/linter/loader.ts");
      expect(violations).toHaveLength(0);
    });

    it("detects cross-boundary import", () => {
      const content = `import { validatePhaseOrder } from "../core/validate-phase-order";\n`;
      const violations = handler(content, "engine/src/linter/loader.ts");
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("no-cross-boundary-imports");
      expect(violations[0].line).toBe(1);
    });

    it("returns empty for files without boundary rules", () => {
      const content = `import { anything } from "anywhere";\n`;
      const violations = handler(content, "some/other/file.ts");
      expect(violations).toHaveLength(0);
    });
  });
});
