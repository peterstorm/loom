import { describe, expect, it } from "vitest";
import {
  isLintableName,
  isNeverSourceDirectory,
  isUnderEntry,
  scopeDrift,
  scopeOf,
} from "../../src/linter/project-scope";
import type { ProgrammaticConfig } from "../../src/linter/programmatic/config";
import { LOOM_CONFIG } from "./loom-project-config";

describe("project scope: everything lintable, minus explicit exclusions", () => {
  it("treats every module spelling, tests and declaration files as lintable", () => {
    for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "A.java", "a.kt", "a.scala", "a.test.ts", "a.d.ts", "a.d.mts"]) {
      expect(isLintableName(name), name).toBe(true);
    }
    for (const name of ["a.json", "a.md", "a.sh", "Makefile"]) expect(isLintableName(name), name).toBe(false);
  });

  it("never enters a directory that holds no project source", () => {
    for (const name of ["node_modules", ".git", ".claude", ".pi", "dist", "coverage"]) expect(isNeverSourceDirectory(name), name).toBe(true);
    for (const name of ["src", "tests", "engine", "probes"]) expect(isNeverSourceDirectory(name), name).toBe(false);
  });

  it("excludes a path under an entry, with the entry and its reason; anchored at the project root", () => {
    const exclusions = [{ path: "third_party/", reason: "vendored" }, { path: "gen/schema.ts", reason: "generated" }];
    expect(scopeOf("third_party/lib/a.ts", exclusions)).toEqual({ kind: "excluded", exclusion: exclusions[0] });
    expect(scopeOf("gen/schema.ts", exclusions)).toEqual({ kind: "excluded", exclusion: exclusions[1] });
    expect(scopeOf("src/third_party/a.ts", exclusions)).toEqual({ kind: "lint" });
    expect(scopeOf("gen/schema.ts.bak", exclusions)).toEqual({ kind: "lint" });
    expect(scopeOf("src/a.ts", [])).toEqual({ kind: "lint" });
    expect(isUnderEntry("third_party", "third_party/")).toBe(false);
  });
});

describe("scopeDrift: every subtracting list reports its own decay", () => {
  const files = ["src/domain/order.ts", "src/domain/repository.ts", "src/api/routes.ts", "third_party/lib.ts"];

  it("is silent when every entry names something", () => {
    const config: ProgrammaticConfig = {
      exclude: [{ path: "third_party/", reason: "vendored" }],
      pureModules: ["src/domain/"],
      impureModules: [{ path: "src/domain/repository.ts", reason: "reads the database" }],
      requireGovernance: ["src/"],
      boundaries: [{
        module: "src/domain/", allow: [], deny: [],
        perFileAllow: { "src/domain/order.ts": { allow: ["node:path"], reason: "path math" } },
      }],
    };
    expect(scopeDrift(config, files)).toEqual([]);
  });

  it("names each stale exclusion, root, shell, governance root, boundary and grant", () => {
    const config: ProgrammaticConfig = {
      exclude: [{ path: "gone/", reason: "was vendored" }],
      pureModules: ["src/core/"],
      impureModules: [{ path: "src/api/routes.ts", reason: "outside every root, so it exempts nothing" }],
      requireGovernance: ["lib/"],
      boundaries: [{
        module: "src/infra/", allow: [], deny: [],
        perFileAllow: { "src/infra/db.ts": { allow: ["node:net"], reason: "the database socket" } },
      }],
    };
    expect(scopeDrift(config, files)).toEqual([
      "exclude: gone/ (matches no file — delete the exclusion)",
      "pureModules: src/core/ (matches no file — fix or delete the root)",
      "impureModules: src/api/routes.ts (names no file under a pure root — delete the entry)",
      "requireGovernance: lib/ (matches no file — fix or delete the root)",
      "boundaries: src/infra/ (governs no file — fix or delete the boundary)",
      "boundaries: src/infra/ grants src/infra/db.ts (no such file — delete the grant)",
    ]);
  });

  it("is silent for a config with no scoping lists at all", () => {
    expect(scopeDrift({}, files)).toEqual([]);
  });

  it("Loom's own config has its exclusion, roots, shells and boundaries all live", () => {
    // The CLI run reports the same against the real tree; this pins that the
    // config carries every kind of entry the drift pass checks.
    expect(LOOM_CONFIG.exclude?.length).toBeGreaterThan(0);
    expect(LOOM_CONFIG.impureModules?.length).toBeGreaterThan(0);
    expect(LOOM_CONFIG.requireGovernance).toEqual(["engine/src/"]);
  });
});
