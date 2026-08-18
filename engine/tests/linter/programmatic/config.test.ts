import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig, EMPTY_CONFIG, type ProgrammaticConfig } from "../../../src/linter/programmatic/config";
import { createProgrammaticRules } from "../../../src/linter/programmatic";

describe("programmatic config loader", () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), "lint-config-"));
  }

  it("returns EMPTY_CONFIG when configDir is null", () => {
    expect(loadProjectConfig(null)).toEqual(EMPTY_CONFIG);
  });

  it("returns EMPTY_CONFIG when config.json doesn't exist", () => {
    const dir = makeTempDir();
    expect(loadProjectConfig(dir)).toEqual(EMPTY_CONFIG);
  });

  it("parses boundaries from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: [
        { module: "src/domain/", allow: ["./"], deny: ["src/infra/"] }
      ]
    }));

    const config = loadProjectConfig(dir);
    expect(config.boundaries).toHaveLength(1);
    expect(config.boundaries![0].module).toBe("src/domain/");
    expect(config.boundaries![0].deny).toEqual(["src/infra/"]);
  });

  it("parses pureModules from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      pureModules: ["src/domain/", "src/domain/model/"]
    }));

    const config = loadProjectConfig(dir);
    expect(config.pureModules).toEqual(["src/domain/", "src/domain/model/"]);
  });

  it("parses maxFunctionLines from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      maxFunctionLines: 30
    }));

    const config = loadProjectConfig(dir);
    expect(config.maxFunctionLines).toBe(30);
  });

  it("parses excludeFromMaxLines from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      excludeFromMaxLines: [".test.java", ".spec.ts"]
    }));

    const config = loadProjectConfig(dir);
    expect(config.excludeFromMaxLines).toEqual([".test.java", ".spec.ts"]);
  });

  it("throws on malformed JSON (fail-closed)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), "not json {{{");

    expect(() => loadProjectConfig(dir)).toThrow("Malformed linter config");
  });

  it("throws on non-object JSON (fail-closed)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), "[]");

    expect(() => loadProjectConfig(dir)).toThrow("expected a JSON object");
  });

  it("throws on invalid boundaries structure", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: "not-an-array"
    }));

    expect(() => loadProjectConfig(dir)).toThrow("'boundaries' must be an array");
  });

  it("throws on invalid boundary entry", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: [{ module: "foo/" }]  // missing allow/deny
    }));

    expect(() => loadProjectConfig(dir)).toThrow("boundaries[0].allow must be an array");
  });

  it("throws on an empty boundary module (would match every file, then allowlist-fail all)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: [{ module: "", allow: ["./"], deny: [] }]
    }));

    expect(() => loadProjectConfig(dir)).toThrow("boundaries[0].module must be a non-empty string");
  });

  it("throws on invalid maxFunctionLines", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      maxFunctionLines: -1
    }));

    expect(() => loadProjectConfig(dir)).toThrow("must be a positive integer");
  });

  it("throws on a non-integer maxFunctionLines", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      maxFunctionLines: 12.5
    }));

    expect(() => loadProjectConfig(dir)).toThrow("must be a positive integer");
  });

  it("allows empty config object (all optional)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), "{}");

    const config = loadProjectConfig(dir);
    expect(config).toEqual({});
  });

  // Both fields were declared on ProgrammaticConfig and read by
  // createProgrammaticRules, but the parser never looked at them — a project
  // that set either got the built-in default with no error and no log. These
  // pin the read, and the two rejection cases pin the fail-closed contract the
  // silent drop was violating.
  it("parses maxDiscriminantBranches from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxDiscriminantBranches: 2 }));

    expect(loadProjectConfig(dir).maxDiscriminantBranches).toBe(2);
  });

  it("parses discriminantTags from config.json", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ discriminantTags: ["kind", "state"] }));

    expect(loadProjectConfig(dir).discriminantTags).toEqual(["kind", "state"]);
  });

  it("throws on a non-integer maxDiscriminantBranches", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxDiscriminantBranches: 0 }));

    expect(() => loadProjectConfig(dir)).toThrow("'maxDiscriminantBranches' must be a positive integer");
  });

  it("throws on discriminantTags entries that are not non-empty strings", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ discriminantTags: ["kind", ""] }));

    expect(() => loadProjectConfig(dir)).toThrow("'discriminantTags' entries must be non-empty strings");
  });

  it("carries a configured discriminant limit through to the rule that reads it", () => {
    // The end-to-end path the silent drop broke: config → createProgrammaticRules
    // → handler. Two branches are under the default of 3 and over a limit of 2.
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxDiscriminantBranches: 2 }));
    const source = [
      `function f(r) {`,
      `  if (r.kind === "a") {`,
      `    a();`,
      `  } else if (r.kind === "b") {`,
      `    b();`,
      `  }`,
      `}`,
    ].join("\n");
    const rule = (config: ProgrammaticConfig) =>
      createProgrammaticRules(config).find((r) => r.name === "exhaustive-discriminant-branching")!;

    expect(rule(EMPTY_CONFIG).handler(source, "engine/src/core/example.ts")).toEqual([]);
    expect(rule(loadProjectConfig(dir)).handler(source, "engine/src/core/example.ts")).toHaveLength(1);
  });

  it("full config with all fields works", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: [
        { module: "src/main/java/com/example/domain/", allow: ["./"], deny: ["com.example.infra"] }
      ],
      pureModules: ["src/main/java/com/example/domain/"],
      maxFunctionLines: 40,
      excludeFromMaxLines: [".test.java"],
      maxDiscriminantBranches: 4,
      discriminantTags: ["kind"]
    }));

    const config = loadProjectConfig(dir);
    expect(config.boundaries).toHaveLength(1);
    expect(config.pureModules).toHaveLength(1);
    expect(config.maxFunctionLines).toBe(40);
    expect(config.excludeFromMaxLines).toEqual([".test.java"]);
    expect(config.maxDiscriminantBranches).toBe(4);
    expect(config.discriminantTags).toEqual(["kind"]);
  });
});
