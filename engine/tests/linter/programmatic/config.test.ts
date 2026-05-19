import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig, EMPTY_CONFIG } from "../../../src/linter/programmatic/config";

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

  it("throws on invalid maxFunctionLines", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      maxFunctionLines: -1
    }));

    expect(() => loadProjectConfig(dir)).toThrow("must be a positive number");
  });

  it("allows empty config object (all optional)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), "{}");

    const config = loadProjectConfig(dir);
    expect(config).toEqual({});
  });

  it("full config with all fields works", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      boundaries: [
        { module: "src/main/java/com/example/domain/", allow: ["./"], deny: ["com.example.infra"] }
      ],
      pureModules: ["src/main/java/com/example/domain/"],
      maxFunctionLines: 40,
      excludeFromMaxLines: [".test.java"]
    }));

    const config = loadProjectConfig(dir);
    expect(config.boundaries).toHaveLength(1);
    expect(config.pureModules).toHaveLength(1);
    expect(config.maxFunctionLines).toBe(40);
    expect(config.excludeFromMaxLines).toEqual([".test.java"]);
  });
});
