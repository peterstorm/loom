import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseProjectConfig,
  projectRootOf,
  EMPTY_CONFIG,
  PROGRAMMATIC_CONFIG_KEYS,
  type ProgrammaticConfig,
} from "../../../src/linter/programmatic/config";
import { createProgrammaticRules } from "../../../src/linter/programmatic";
import { loadProjectConfig, loadRules } from "../../../src/linter/loader";
import { isProgrammaticRule } from "../../../src/linter/types";

const LOOM_DEFAULT_RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "lint-rules");

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "lint-config-"));
}

describe("programmatic config loader", () => {
  it("returns EMPTY_CONFIG when configDir is null", () => {
    expect(loadProjectConfig(null)).toEqual(EMPTY_CONFIG);
  });

  it("returns EMPTY_CONFIG when config.json doesn't exist", () => {
    const dir = makeTempDir();
    expect(loadProjectConfig(dir)).toEqual(EMPTY_CONFIG);
  });

  it("throws when config.json is inaccessible instead of silently disabling policy", () => {
    const dir = makeTempDir();
    const configPath = join(dir, "config.json");
    symlinkSync(configPath, configPath);

    expect(() => loadProjectConfig(dir)).toThrow(/Cannot read linter config.*ELOOP/i);
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

  it("refuses an unknown key by name — a typo must not silently fall back to the default scope", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ exlude: [], pureModule: ["src/"] }));

    expect(() => loadProjectConfig(dir)).toThrow(/unknown keys 'exlude', 'pureModule'/);
  });

  it("refuses an unknown key inside a boundary, an exemption or a grant", () => {
    const refused = (json: unknown) => parseProjectConfig(json, "config.json");
    expect(refused({ boundaries: [{ module: "src/a/", allow: [], deny: [], perFileAlow: {} }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("'perFileAlow'") });
    expect(refused({ exclude: [{ path: "vendor-js/", reason: "vendored", why: "x" }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("'why'") });
    expect(refused({ boundaries: [{ module: "src/a/", allow: [], deny: [], perFileAllow: { "src/a/x.ts": { allow: ["node:fs"], reason: "r", extra: 1 } } }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("'extra'") });
  });

  it("names every known key in the refusal, and accepts each of them", () => {
    const result = parseProjectConfig({ bogus: 1 }, "config.json");
    expect(result.ok).toBe(false);
    if (!result.ok) for (const key of PROGRAMMATIC_CONFIG_KEYS) expect(result.error).toContain(key);
  });
});

describe("scoping config: exclusions, purity roots and shells, governance", () => {
  const parse = (json: unknown) => parseProjectConfig(json, "config.json");

  it("parses exclusions and impure shells as { path, reason } pairs", () => {
    const result = parse({
      exclude: [{ path: "third_party/", reason: "vendored upstream" }],
      pureModules: ["src/domain/"],
      impureModules: [{ path: "src/domain/repository.ts", reason: "reads the database" }],
      requireGovernance: ["src/"],
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        exclude: [{ path: "third_party/", reason: "vendored upstream" }],
        pureModules: ["src/domain/"],
        impureModules: [{ path: "src/domain/repository.ts", reason: "reads the database" }],
        requireGovernance: ["src/"],
      }),
    });
  });

  it.each([
    [{ exclude: [{ path: "vendor-js/" }] }, "reason must be a non-empty string"],
    [{ exclude: [{ path: "vendor-js/", reason: "  " }] }, "reason must be a non-empty string"],
    [{ impureModules: [{ path: "src/a.ts", reason: "" }] }, "reason must be a non-empty string"],
    [{ exclude: ["vendor-js/"] }, "expected a JSON object"],
    [{ exclude: [{ path: "a/", reason: "x" }, { path: "a/", reason: "y" }] }, "lists 'a/' twice"],
  ])("refuses an exemption without its justification: %j", (json, message) => {
    expect(parse(json)).toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it.each([
    [{ pureModules: ["packages/*/src/"] }, "is a glob"],
    [{ exclude: [{ path: "engine/**", reason: "x" }] }, "is a glob"],
    [{ pureModules: ["/abs/src/"] }, "must be project-relative"],
    [{ impureModules: [{ path: "./src/a.ts", reason: "x" }] }, "must be project-relative"],
    [{ pureModules: [""] }, "non-empty strings"],
  ])("refuses a path that would silently match the wrong set: %j", (json, message) => {
    expect(parse(json)).toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it("refuses an empty governance scope — it would govern nothing", () => {
    expect(parse({ requireGovernance: [] })).toMatchObject({ ok: false, error: expect.stringContaining("must not be empty") });
  });

  it("parses per-file capability grants with their reasons, and refuses a grant without one", () => {
    const grant = { allow: ["node:path"], reason: "pure path math" };
    expect(parse({ boundaries: [{ module: "src/a/", description: "the a layer", allow: [], deny: [], perFileAllow: { "src/a/x.ts": grant } }] }))
      .toEqual({ ok: true, value: expect.objectContaining({ boundaries: [expect.objectContaining({ description: "the a layer", perFileAllow: { "src/a/x.ts": grant } })] }) });
    expect(parse({ boundaries: [{ module: "src/a/", allow: [], deny: [], perFileAllow: { "src/a/x.ts": { allow: ["node:path"] } } }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("every capability grant states why") });
  });

  it("refuses a grant that could never apply: a directory, or a file outside the boundary's module", () => {
    const grant = { allow: ["node:fs"], reason: "r" };
    expect(parse({ boundaries: [{ module: "src/a/", allow: [], deny: [], perFileAllow: { "src/a/sub/": grant } }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("must name one file") });
    expect(parse({ boundaries: [{ module: "src/a/", allow: [], deny: [], perFileAllow: { "src/b/x.ts": grant } }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("outside 'src/a/'") });
  });

  it("Loom's own config parses under the strict loader, in both harness copies", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    for (const layout of [".claude/linter/rules", ".pi/linter/rules"]) {
      const config = loadProjectConfig(join(repo, layout));
      expect(config.requireGovernance, layout).toEqual(["engine/src/"]);
      expect(config.exclude?.length, layout).toBeGreaterThan(0);
    }
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

describe("totality config: scope, baselines and the project root they are written against", () => {
  const UNPROVEN = [
    `function name(x: Event): string {`,
    `  switch (x.kind) {`,
    `    case "a": return "a";`,
    `    case "b": return "b";`,
    `  }`,
    `  return "?";`,
    `}`,
  ].join("\n");

  /** A target project in the Claude Code layout, with `config` as its linter config. */
  function project(config: Record<string, unknown>): Readonly<{ root: string; rulesDir: string }> {
    const root = mkdtempSync(join(tmpdir(), "lint-project-"));
    const rulesDir = join(root, ".claude/linter/rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "config.json"), JSON.stringify(config));
    return { root, rulesDir };
  }

  it("parses both baselines and a narrowed switch scope", () => {
    const { rulesDir } = project({
      switchTotalityModules: ["src/domain/"],
      switchTotalityBaseline: ["src/domain/order.ts::x.kind"],
      discriminantBranchingBaseline: ["src/domain/order.ts::event.kind"],
    });
    expect(loadProjectConfig(rulesDir)).toEqual({
      switchTotalityModules: ["src/domain/"],
      switchTotalityBaseline: ["src/domain/order.ts::x.kind"],
      discriminantBranchingBaseline: ["src/domain/order.ts::event.kind"],
    });
  });

  it("refuses an EMPTY switch scope — it would silently match nothing", () => {
    const { rulesDir } = project({ switchTotalityModules: [] });
    expect(() => loadProjectConfig(rulesDir)).toThrow("'switchTotalityModules' must not be empty");
  });

  it.each([
    [".claude/linter/rules"],
    [".pi/linter/rules"],
  ])("finds the project root above a %s directory, and none above an unknown layout", (layout) => {
    expect(projectRootOf(`/work/shop/${layout}`)).toBe("/work/shop");
    expect(projectRootOf("/work/shop/lint")).toBeNull();
    expect(projectRootOf(null)).toBeNull();
  });

  it("excuses a target project's baselined switch through the production loader, and only that one", () => {
    // The path a target repository takes: an absolute file path, a rules
    // directory in the harness layout, and a baseline keyed relative to the
    // project root. Keys used to be relative to loom's own directory names, so
    // a target project's baseline could never match.
    const { root, rulesDir } = project({ switchTotalityBaseline: ["src/domain/order.ts::x.kind"] });
    const rule = loadRules(LOOM_DEFAULT_RULES, rulesDir, "immediate")
      .filter(isProgrammaticRule)
      .find((candidate) => candidate.name === "switch-totality")!;
    expect(rule.handler(UNPROVEN, join(root, "src/domain/order.ts"))).toEqual([]);
    expect(rule.handler(UNPROVEN, join(root, "src/domain/invoice.ts"))).toHaveLength(1);
  });

  it("applies switch-totality to a target project with no config at all", () => {
    const rule = createProgrammaticRules(EMPTY_CONFIG).find((candidate) => candidate.name === "switch-totality")!;
    expect(rule.handler(UNPROVEN, "/work/shop/src/domain/order.ts")).toHaveLength(1);
  });
});
