/**
 * `scripts/lint-project.ts`, spawned for real over a temporary project with
 * its one rules directory: the shell around the engine's pure baseline
 * decisions (`baseline-config.ts`, unit-tested on its own).
 *
 * - `--write-baseline` records every unproven site into the project's
 *   `config.json`, keeps the other fields, and a re-run changes nothing;
 * - a stale baseline entry fails the run (exit 1) and is reported in the JSON
 *   output's `staleEntries`;
 * - a lint ERROR (a file the linter could not lint) fails `--json`, not only
 *   the human-readable mode;
 * - the scope is everything lintable — tests included — minus the config's
 *   reasoned `exclude` list, which applies to explicit paths too, and whose
 *   stale entries fail the run;
 * - the project root is found from a subdirectory with its own package.json,
 *   an unknown config key and a project carrying both rules layouts refuse to
 *   run (exit 2), and a Pi-only project is read from its `.pi` layout;
 * - explicit paths that yield nothing to lint — missing, excluded, or holding
 *   no lintable file — fail the run (exit 2) instead of passing unlinted;
 * - a governed plan beneath `.claude/` is walked and linted, and a Markdown
 *   file is linted only where `docReferences` governs it;
 * - `--init` writes a starter config the strict loader accepts, in the TS,
 *   Java and Pi-only layouts, and the very next lint run under it is clean.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { OPT_IN_CONFIG_KEYS } from "../../src/linter/programmatic/config";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "lint-project.ts");
const RULES_DIR = ".claude/linter/rules";
const PI_RULES_DIR = ".pi/linter/rules";

/** A two-arm switch over a union with no totality proof: one `switch-totality` site. */
const UNPROVEN_SWITCH = [
  "type Shape = { kind: \"a\" } | { kind: \"b\" };",
  "export function area(s: Shape): number {",
  "  switch (s.kind) {",
  "    case \"a\": return 1;",
  "    case \"b\": return 2;",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");
const SITE = "src/shape.ts::s.kind";

/** One `no-any-type` violation, assembled so this file's own source does not carry one. */
const ANY_ANNOTATED = (name: string): string => `export const ${name}:${" "}${"an"}y = 1;\n`;

/** Every opt-in rule family, declined: the fixture's coverage is complete, so
 *  a test sees only what it sets up. */
const ALL_DECLINED: readonly Readonly<{ key: string; reason: string }>[] = [
  { key: "boundaries", reason: "a one-file fixture has no layers" },
  { key: "pureModules", reason: "a one-file fixture has no functional core" },
  { key: "requireGovernance", reason: "a one-file fixture has no boundaries to govern by" },
  { key: "docReferences", reason: "the fixture's documents are added per test" },
];

const BASE_CONFIG = { maxFunctionLines: 60, declined: ALL_DECLINED };

let project: string;

beforeEach(() => {
  project = canonicalTempDir("loom-lint-project-cli-");
  writeFileSync(join(project, "package.json"), "{}\n");
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "shape.ts"), UNPROVEN_SWITCH);
  mkdirSync(join(project, RULES_DIR), { recursive: true });
  writeFileSync(join(project, RULES_DIR, "config.json"), `${JSON.stringify(BASE_CONFIG, null, 2)}\n`);
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Run the script from the project root. */
function lintProject(...args: string[]): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync("bun", [SCRIPT, ...args], { cwd: project, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const configBytes = (dir: string = RULES_DIR): string => readFileSync(join(project, dir, "config.json"), "utf8");

type JsonReport = Readonly<{
  violations: readonly Readonly<{ file: string; rule: string }>[];
  errorCount: number;
  staleEntries: readonly string[];
  coverage: "no-setup" | "set-up";
  coverageGaps: readonly string[];
  excluded: readonly Readonly<{ file: string; reason: string }>[];
}>;
const jsonReport = (stdout: string): JsonReport => JSON.parse(stdout) as JsonReport;

/** Rewrites the project's config.json with extra fields. A family a field
 *  configures is no longer declined: the loader refuses both at once. */
function configure(fields: Record<string, unknown>): void {
  const current = JSON.parse(configBytes()) as Record<string, unknown> & { declined?: readonly { key: string }[] };
  const declined = (current.declined ?? []).filter(({ key }) => !(key in fields));
  const next = { ...current, ...fields, declined };
  writeFileSync(join(project, RULES_DIR, "config.json"), `${JSON.stringify(next, null, 2)}\n`);
}

/** Grandfathers the fixture's one unproven switch, so a test starts from a clean run. */
function baselined(): void {
  const written = lintProject("--write-baseline");
  expect(written.status, written.stderr).toBe(0);
}

describe("lint-project.ts, spawned over a temporary project", () => {
  it("--write-baseline records the site in the project config, keeps other fields, and is idempotent", () => {
    const written = lintProject("--write-baseline");
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(configBytes())).toEqual({ ...BASE_CONFIG, switchTotalityBaseline: [SITE] });
    const first = configBytes();

    const rerun = lintProject("--write-baseline");
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(configBytes()).toEqual(first);

    // The baselined site is excused and nothing in the baseline is stale.
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout).toBe(0);
    expect(jsonReport(linted.stdout)).toEqual({
      violations: [], errorCount: 0, staleEntries: [], coverage: "set-up", coverageGaps: [], excluded: [],
    });
  });

  it("a stale baseline entry exits 1 and is reported in the JSON output's staleEntries", () => {
    baselined();
    configure({ switchTotalityBaseline: [SITE, "src/gone.ts::x.kind"] });

    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.violations).toEqual([]);
    expect(report.staleEntries).toEqual([
      "switch-totality: src/gone.ts::x.kind (no unproven switch matches it any more — delete the baseline entry)",
    ]);
    // --no-baseline-check skips the drift pass: the tier itself is clean.
    expect(lintProject("--json", "--no-baseline-check").status).toBe(0);
  });

  it("an unproven site with no baseline is a violation: exit 1 under --json", () => {
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).violations).toContainEqual(expect.objectContaining({ file: "src/shape.ts", rule: "switch-totality" }));
  });

  it("a lint error (rules that cannot load) exits 1 under --json and under --summary", () => {
    baselined();
    writeFileSync(join(project, RULES_DIR, "broken.json"), "{ not json");

    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
    expect(lintProject("--summary").status).toBe(1);
  });

  it("lints test files by default — a rule that skips tests says so itself", () => {
    baselined();
    writeFileSync(join(project, "src", "shape.test.ts"), ANY_ANNOTATED("x"));
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).violations).toContainEqual(expect.objectContaining({ file: "src/shape.test.ts", rule: "no-any-type" }));
  });

  it("lints the TypeScript module spellings (.mts, .cts) the walker used to skip", () => {
    baselined();
    writeFileSync(join(project, "src", "esm.mts"), ANY_ANNOTATED("x"));
    writeFileSync(join(project, "src", "cjs.cts"), ANY_ANNOTATED("y"));
    const files = jsonReport(lintProject("--json").stdout).violations.map(({ file }) => file);
    expect(files).toEqual(expect.arrayContaining(["src/esm.mts", "src/cjs.cts"]));
  });

  it("an excluded path is never linted, is listed with its reason, and stays excluded when named explicitly", () => {
    baselined();
    mkdirSync(join(project, "third_party"));
    writeFileSync(join(project, "third_party", "lib.ts"), ANY_ANNOTATED("x"));
    configure({ exclude: [{ path: "third_party/", reason: "vendored upstream, byte-pinned" }] });

    const linted = lintProject("--json");
    expect(linted.status, linted.stdout).toBe(0);
    expect(jsonReport(linted.stdout).excluded).toEqual([{ file: "third_party/lib.ts", reason: "third_party/ — vendored upstream, byte-pinned" }]);

    const explicit = lintProject("third_party/lib.ts");
    expect(explicit.stdout).toContain("excluded: third_party/lib.ts (third_party/ — vendored upstream, byte-pinned)");
    expect(explicit.stdout).not.toContain("no-any-type");
    // Naming only excluded files lints nothing: a failure, never a pass.
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toContain("third_party/lib.ts yielded no file to lint (1 excluded by config)");
  });

  it("a path argument that does not exist ends the run (exit 2) before anything is linted", () => {
    baselined();
    for (const args of [["src/shpae.ts"], ["src/shape.ts", "src/missing/"], ["--json", "nowhere.ts"]]) {
      const linted = lintProject(...args);
      expect(linted.status, args.join(" ")).toBe(2);
      expect(linted.stderr).toMatch(/not exist — nothing was linted/);
      expect(linted.stdout).not.toContain("No violations found");
    }
  });

  it("a directory argument with no lintable file is a run that checked nothing: exit 2", () => {
    baselined();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "notes.md"), "# notes\n");
    const linted = lintProject("docs");
    expect(linted.status).toBe(2);
    expect(linted.stderr).toContain("docs yielded no file to lint (0 excluded by config)");
  });

  it("an empty project, named by nothing, has nothing to lint and passes", () => {
    rmSync(join(project, "src"), { recursive: true, force: true });
    const linted = lintProject();
    expect(linted.status, linted.stderr).toBe(0);
    expect(linted.stdout).toContain("No source files found to lint.");
  });

  it("an exclusion that matches no file is stale: exit 1", () => {
    baselined();
    configure({ exclude: [{ path: "gone/", reason: "was vendored" }] });
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).staleEntries).toEqual(["exclude: gone/ (matches no file — delete the exclusion)"]);
  });

  it("finds the project root from a subdirectory that has its own package.json", () => {
    baselined();
    mkdirSync(join(project, "engine"));
    writeFileSync(join(project, "engine", "package.json"), "{}\n");
    const result = spawnSync("bun", [SCRIPT, "--json"], { cwd: join(project, "engine"), encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(jsonReport(result.stdout).staleEntries).toEqual([]);
  });

  it("reports a doc reference through a file as dangling, not as a lint error (Bun's stat throws ENOTDIR)", () => {
    baselined();
    writeFileSync(join(project, "README.md"), "# Readme\n");
    writeFileSync(join(project, "src", "through-files.ts"), "// Reads `README.md/child` and `src/shape.ts/x`.\nexport const one = 1;\n");
    configure({ docReferences: { govern: [{ path: "src/", reason: "comments name the tree" }] } });

    const linted = lintProject("--json");
    expect(linted.status, linted.stderr).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.errorCount).toBe(0);
    expect(report.violations.filter(({ rule }) => rule === "no-dangling-doc-reference")).toEqual([
      expect.objectContaining({ file: "src/through-files.ts" }),
      expect.objectContaining({ file: "src/through-files.ts" }),
    ]);
  });

  it("walks a governed plan beneath .claude/, which the project walk never enters, and lints it in the full tier", () => {
    baselined();
    mkdirSync(join(project, ".claude", "plans"), { recursive: true });
    writeFileSync(join(project, ".claude", "plans", "p.md"), "# Plan\n\n**Spec:** .claude/specs/gone/spec.md\n");
    configure({
      docReferences: {
        govern: [{ path: "src/", reason: "comments name the tree" }],
        plans: [{ path: ".claude/plans/", reason: "a plan cites its spec" }],
      },
    });

    const linted = lintProject("--json");
    expect(linted.status, linted.stderr).toBe(1);
    expect(jsonReport(linted.stdout)).toMatchObject({
      violations: [expect.objectContaining({ file: ".claude/plans/p.md", rule: "no-dangling-doc-reference" })],
      errorCount: 0,
      staleEntries: [],
    });
  });

  it("lints a Markdown file only where docReferences governs it: no other rule reads one", () => {
    baselined();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "x.md"), "# X\n\nSee `gone.md`.\n");

    const ungoverned = lintProject("--json");
    expect(ungoverned.status, ungoverned.stdout).toBe(0);
    expect(jsonReport(ungoverned.stdout).violations).toEqual([]);
    expect(lintProject().stdout).toContain("Linting 1 files");

    configure({ docReferences: { govern: [{ path: "docs/", reason: "the docs name the tree" }] } });
    const governed = lintProject("--json");
    expect(governed.status).toBe(1);
    expect(jsonReport(governed.stdout).violations).toEqual([
      expect.objectContaining({ file: "docs/x.md", rule: "no-dangling-doc-reference" }),
    ]);
  });

  it("resolves a listed external name, and fails the full run on one that has decayed — on a targeted run too", () => {
    baselined();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "telemetry.md"), "# Telemetry\n\nThe span carries `ai.llm.tokens_in`.\n");
    const telemetry = (names: readonly string[]) => configure({
      docReferences: {
        govern: [{ path: "docs/", reason: "the docs name the tree" }],
        externalNames: [{ names, reason: "OpenTelemetry attributes emitted at runtime" }],
      },
    });

    telemetry(["ai.llm.tokens_in"]);
    const live = lintProject("--json");
    expect(live.status, live.stdout + live.stderr).toBe(0);
    expect(jsonReport(live.stdout)).toMatchObject({ violations: [], staleEntries: [] });

    telemetry(["ai.llm.tokens_in", "ai.llm.tokens_out", "area"]);
    const stale = lintProject("--json", "src/shape.ts");
    expect(stale.status).toBe(1);
    expect(jsonReport(stale.stdout).staleEntries).toEqual([
      "docReferences.externalNames: ai.llm.tokens_out (no governed document references it — delete the name; listed because OpenTelemetry attributes emitted at runtime)",
      "docReferences.externalNames: area (no governed document references it — delete the name; listed because OpenTelemetry attributes emitted at runtime)",
    ]);

    // --no-baseline-check skips the drift pass, external names with it: the tier itself is clean.
    for (const targets of [[], ["src/shape.ts"]]) {
      const unchecked = lintProject("--json", "--no-baseline-check", ...targets);
      expect(unchecked.status, unchecked.stdout + unchecked.stderr).toBe(0);
      expect(jsonReport(unchecked.stdout)).toMatchObject({ violations: [], staleEntries: [] });
    }

    writeFileSync(join(project, "docs", "shape.md"), "# Shape\n\n`area` is computed in source.\n");
    const inSource = lintProject("--json");
    expect(inSource.status).toBe(1);
    expect(jsonReport(inSource.stdout).staleEntries).toContain(
      "docReferences.externalNames: area (the source already resolves it, so it is not external — delete the name; listed because OpenTelemetry attributes emitted at runtime)",
    );
  });

  it("refuses to run on an unknown config key (exit 2), naming it", () => {
    configure({ exlude: [] });
    const linted = lintProject("--json");
    expect(linted.status).toBe(2);
    expect(linted.stderr).toContain("unknown key 'exlude'");
  });

  it("refuses to run when the project carries both rules layouts (exit 2): the hooks read only one", () => {
    mkdirSync(join(project, PI_RULES_DIR), { recursive: true });
    writeFileSync(join(project, PI_RULES_DIR, "config.json"), configBytes());
    const linted = lintProject("--json");
    expect(linted.status).toBe(2);
    expect(linted.stderr).toContain(`the project carries ${RULES_DIR} and ${PI_RULES_DIR}`);
  });

  it("reads a Pi-only project from its .pi layout, and --write-baseline writes there", () => {
    mkdirSync(join(project, PI_RULES_DIR), { recursive: true });
    writeFileSync(join(project, PI_RULES_DIR, "config.json"), configBytes());
    rmSync(join(project, ".claude"), { recursive: true, force: true });
    expect(lintProject("--json").status).toBe(1);
    baselined();
    expect(JSON.parse(configBytes(PI_RULES_DIR))).toEqual({ ...BASE_CONFIG, switchTotalityBaseline: [SITE] });
    expect(lintProject("--json").status).toBe(0);
  });
});

describe("lint coverage: every opt-in rule family is configured or declined", () => {
  /** The fixture's config without its declined list: four gaps. */
  function undeclined(): void {
    const { declined: _declined, ...rest } = JSON.parse(configBytes()) as Record<string, unknown>;
    writeFileSync(join(project, RULES_DIR, "config.json"), `${JSON.stringify(rest, null, 2)}\n`);
  }

  it("a family neither configured nor declined fails the full tier and is named with both ways to decide it", () => {
    baselined();
    undeclined();
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.violations).toEqual([]);
    expect(report.coverageGaps).toHaveLength(4);
    expect(report.coverageGaps[0]).toBe(
      "coverage: 'boundaries' is off, so import boundaries between layers (no-cross-boundary-imports) checks nothing — " +
      "configure it (lint-project --init infers what it can) or add { \"key\": \"boundaries\", \"reason\": \"…\" } to 'declined'",
    );

    const human = lintProject();
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("✗ 4 rule families neither configured nor declined");
    expect(lintProject("--summary").stdout).toContain("Coverage gaps: 4");
  });

  it("an empty list is a gap too: it checks nothing — and declining it, as the gap line says, is accepted", () => {
    baselined();
    configure({ boundaries: [] });
    expect(jsonReport(lintProject("--json").stdout).coverageGaps).toEqual([
      expect.stringContaining("coverage: 'boundaries' is off"),
    ]);
    const current = JSON.parse(configBytes()) as Record<string, unknown>;
    writeFileSync(join(project, RULES_DIR, "config.json"), JSON.stringify({ ...current, declined: ALL_DECLINED }));
    const declined = lintProject("--json");
    expect(declined.status, declined.stderr).toBe(0);
    expect(jsonReport(declined.stdout).coverageGaps).toEqual([]);
  });

  it("the immediate tier does not judge coverage — it is the per-edit set", () => {
    baselined();
    undeclined();
    expect(lintProject("--json", "--tier=immediate").status).toBe(0);
  });

  it("a declined family needs its reason, and cannot be configured at the same time", () => {
    writeFileSync(join(project, RULES_DIR, "config.json"), JSON.stringify({ declined: [{ key: "boundaries", reason: "" }] }));
    const noReason = lintProject("--json");
    expect(noReason.status).toBe(2);
    expect(noReason.stderr).toContain("every declined family states why");

    writeFileSync(join(project, RULES_DIR, "config.json"), JSON.stringify({ pureModules: ["src/"], declined: [{ key: "pureModules", reason: "none" }] }));
    const both = lintProject("--json");
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("'pureModules' is both configured and declined — keep one");
  });

  it("a project with no rules directory is told what it is missing, and does not fail for it", () => {
    rmSync(join(project, ".claude"), { recursive: true, force: true });
    writeFileSync(join(project, "src", "shape.ts"), "export const one = 1;\n");
    const linted = lintProject();
    expect(linted.status, linted.stdout).toBe(0);
    expect(linted.stderr).toContain("note: no Loom lint setup — only the shipped rules run; `lint-project --init` turns every rule family on");
    // A machine caller reads the same state from the JSON, not from stderr.
    const json = lintProject("--json");
    expect(json.status).toBe(0);
    expect(json.stderr).not.toContain("no Loom lint setup");
    expect(jsonReport(json.stdout)).toMatchObject({ coverage: "no-setup", coverageGaps: [] });
  });
});

describe("lint-project.ts --init, then a lint run under the generated config", () => {
  beforeEach(() => {
    // A project with no linter config at all — what --init is for.
    rmSync(join(project, ".claude"), { recursive: true, force: true });
    rmSync(join(project, "src"), { recursive: true, force: true });
  });

  /** Writes `files` (project-relative path → content) into the project. */
  function withFiles(files: Readonly<Record<string, string>>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), content);
    }
  }

  function init(): string {
    const initialized = lintProject("--init");
    expect(initialized.status, initialized.stderr).toBe(0);
    return initialized.stdout;
  }

  /** Decline every family `--init` left as a gap, so the next run judges the rest. */
  function declineRemaining(dir: string = RULES_DIR): void {
    const stored = JSON.parse(configBytes(dir)) as Record<string, unknown>;
    const declined = OPT_IN_CONFIG_KEYS
      .filter((key) => stored[key] === undefined)
      .map((key) => ({ key, reason: "the fixture does not have it" }));
    writeFileSync(join(project, dir, "config.json"), `${JSON.stringify({ ...stored, declined }, null, 2)}\n`);
  }

  /** A TypeScript project in the layered package structure, with documents. */
  const LAYERED: Readonly<Record<string, string>> = {
    "tsconfig.json": "{}\n",
    "src/domain/order.ts": "export type Order = Readonly<{ id: string }>;\n",
    "src/orchestrator/place-order.ts": "import type { Order } from \"../domain/order\";\n\nexport const place = (order: Order): string => order.id;\n",
    "src/infra/pg-orders.ts": "import type { Order } from \"../domain/order\";\nimport { Client } from \"pg\";\n\nexport const client = (order: Order): Client => new Client({ application_name: order.id });\n",
    "README.md": "# Shop\n\nThe order model is `src/domain/order.ts`.\n",
    "docs/architecture.md": "# Architecture\n\nOrchestrators live in `src/orchestrator/`.\n",
  };

  it("a layered TypeScript project gets every family on, inferred from its tree, and lints clean", () => {
    withFiles(LAYERED);
    const output = init();
    expect(output).toContain("✓ .claude/linter/rules/config.json: created");
    for (const key of ["pureModules", "boundaries", "requireGovernance", "docReferences"]) expect(output).toContain(`on: ${key}`);
    expect(output).not.toContain("not inferred:");
    expect(output).not.toContain("Decide every family");
    expect(JSON.parse(configBytes())).toEqual({
      maxFunctionLines: 50,
      excludeFromMaxLines: [".test.ts", ".spec.ts"],
      pureModules: ["src/domain/"],
      boundaries: [
        {
          module: "src/domain/",
          description: "The pure functional core: it imports no shell layer.",
          allow: ["src/domain/"],
          deny: ["src/orchestrator/", "src/infra/"],
        },
        {
          module: "src/orchestrator/",
          description: "Shell orchestrators: they reach I/O through the domain's ports, never through infra or the API layer.",
          allow: ["src/domain/", "src/orchestrator/"],
          deny: ["src/infra/"],
        },
        {
          module: "src/infra/",
          description: "Adapters implement the domain's ports; they never call orchestrators or the API layer.",
          allow: ["pg", "src/domain/", "src/infra/"],
          deny: ["src/orchestrator/"],
        },
      ],
      requireGovernance: ["src/"],
      docReferences: {
        govern: [
          { path: "docs/", reason: "the project's documentation describes the tree as it is" },
          { path: "README.md", reason: "the entry document names the commands and files a reader starts from" },
        ],
        sourceRoots: ["src"],
      },
    });
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
    expect(jsonReport(linted.stdout)).toMatchObject({ staleEntries: [], coverageGaps: [] });
  });

  it("the inferred boundaries refuse a new import that points outward", () => {
    withFiles(LAYERED);
    init();
    withFiles({ "src/domain/leak.ts": "import { place } from \"../orchestrator/place-order\";\n\nexport const leak = place;\n" });
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).violations).toContainEqual(expect.objectContaining({ file: "src/domain/leak.ts", rule: "no-cross-boundary-imports" }));
  });

  it("a deny an import already breaks is left out and reported, so old code does not block the next edit", () => {
    withFiles({ ...LAYERED, "src/domain/order.ts": "import { client } from \"../infra/pg-orders\";\n\nexport const clientKind = (): string => typeof client;\n" });
    const output = init();
    expect(output).toContain("note: boundaries: src/domain/ already imports src/infra/, so that deny is left out");
    const domain = (JSON.parse(configBytes()) as { boundaries: { module: string; deny: string[] }[] }).boundaries[0];
    expect(domain).toMatchObject({ module: "src/domain/", deny: ["src/orchestrator/"] });
    expect(lintProject("--json").status).toBe(0);
  });

  it("baselines the debt the baselined rules already flag, so the first run is clean", () => {
    withFiles({ ...LAYERED, "src/domain/shape.ts": UNPROVEN_SWITCH });
    init();
    expect(JSON.parse(configBytes()).switchTotalityBaseline).toEqual(["src/domain/shape.ts::s.kind"]);
    expect(lintProject("--json").status).toBe(0);
  });

  it("names every family it cannot infer, and the run fails until each is decided", () => {
    withFiles({ "tsconfig.json": "{}\n", "src/domain/order.ts": "export const total = (a: number, b: number): number => a + b;\n" });
    const output = init();
    expect(output).toContain("on: pureModules");
    expect(output).toContain("not inferred: boundaries — fewer than two of");
    expect(output).toContain("not inferred: requireGovernance — the boundaries do not govern every source file under src/");
    expect(output).toContain("not inferred: docReferences — no document to govern");
    expect(JSON.parse(configBytes())).toEqual({
      maxFunctionLines: 50,
      excludeFromMaxLines: [".test.ts", ".spec.ts"],
      pureModules: ["src/domain/"],
    });
    expect(jsonReport(lintProject("--json").stdout).coverageGaps).toHaveLength(3);

    declineRemaining();
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
  });

  it("the generated config holds the pure roots to purity", () => {
    withFiles({ "tsconfig.json": "{}\n", "src/domain/clock.ts": "export const now = (): number => Date.now();\n" });
    init();
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).violations).toContainEqual(expect.objectContaining({ file: "src/domain/clock.ts", rule: "no-io-in-pure-modules" }));
  });

  it("a functional-core root the project does not have is not written, so the first run is not stale", () => {
    withFiles({ "tsconfig.json": "{}\n", "lib/index.ts": "export const one = 1;\n" });
    expect(init()).toContain("not inferred: pureModules — none of the conventional functional-core roots");
    expect(JSON.parse(configBytes()).pureModules).toBeUndefined();
    declineRemaining();
    expect(lintProject("--json").status).toBe(0);
  });

  it("a Java project gets directory roots that match every package's domain model, and lints clean", () => {
    withFiles({
      "pom.xml": "<project/>\n",
      "src/main/java/com/shop/domain/model/Order.java": "package com.shop.domain.model;\n\npublic record Order(String id) {}\n",
      "src/main/java/com/shop/domain/service/Pricing.java": "package com.shop.domain.service;\n\npublic final class Pricing {\n  private Pricing() {}\n}\n",
    });
    expect(init()).toContain("not inferred: boundaries — boundaries are inferred for TypeScript's layered src/ structure only");
    expect(JSON.parse(configBytes())).toEqual({
      maxFunctionLines: 40,
      excludeFromMaxLines: [".test.java", "Test.java"],
      pureModules: ["domain/model/", "domain/service/"],
    });
    declineRemaining();
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
  });

  it("a Pi-only project gets its config in the .pi layout, and the lint run reads it there", () => {
    mkdirSync(join(project, ".pi"));
    withFiles({ "tsconfig.json": "{}\n", "src/domain/order.ts": "export const one = 1;\n" });
    init();
    expect(JSON.parse(configBytes(PI_RULES_DIR)).pureModules).toEqual(["src/domain/"]);
    declineRemaining(PI_RULES_DIR);
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
  });

  it("on an existing config, fills only the families neither configured nor declined, and a re-run changes nothing", () => {
    withFiles({
      ...LAYERED,
      [`${RULES_DIR}/config.json`]: `${JSON.stringify({
        maxFunctionLines: 70,
        pureModules: ["src/orchestrator/"],
        declined: [{ key: "boundaries", reason: "the team enforces layering in review" }],
      })}\n`,
    });
    const output = init();
    expect(output).toContain("✓ .claude/linter/rules/config.json: updated");
    const written = JSON.parse(configBytes()) as Record<string, unknown>;
    expect(written).toMatchObject({
      maxFunctionLines: 70,
      pureModules: ["src/orchestrator/"],
      declined: [{ key: "boundaries", reason: "the team enforces layering in review" }],
      docReferences: expect.objectContaining({ sourceRoots: ["src"] }),
    });
    expect(written.boundaries).toBeUndefined();
    // The project declined boundaries and --init infers none for it, so no
    // boundary governs src/ and governance cannot be inferred.
    expect(output).toContain("not inferred: requireGovernance");

    const first = configBytes();
    const again = init();
    expect(again).not.toContain("config.json: updated");
    expect(configBytes()).toBe(first);
  });

  it("fills an empty list an older --init wrote, which turned nothing on", () => {
    withFiles({ ...LAYERED, [`${RULES_DIR}/config.json`]: `${JSON.stringify({ maxFunctionLines: 50, boundaries: [], pureModules: [] })}\n` });
    const output = init();
    expect(output).toContain("on: boundaries");
    expect(output).toContain("on: pureModules");
    expect(JSON.parse(configBytes()).pureModules).toEqual(["src/domain/"]);
    expect(lintProject("--json").status).toBe(0);
  });

  it("refuses --init in a project carrying both rules layouts (exit 2), writing nothing", () => {
    withFiles({
      ...LAYERED,
      [`${RULES_DIR}/config.json`]: "{}\n",
      [`${PI_RULES_DIR}/config.json`]: "{}\n",
    });
    const initialized = lintProject("--init");
    expect(initialized.status).toBe(2);
    expect(initialized.stderr).toContain(`the project carries ${RULES_DIR} and ${PI_RULES_DIR}`);
    expect(configBytes()).toBe("{}\n");
    expect(configBytes(PI_RULES_DIR)).toBe("{}\n");
  });

  it("refuses to fill a config the loader refuses (exit 2), leaving it as it was", () => {
    withFiles({ "tsconfig.json": "{}\n", [`${RULES_DIR}/config.json`]: "{ \"exlude\": [] }\n" });
    const initialized = lintProject("--init");
    expect(initialized.status).toBe(2);
    expect(initialized.stderr).toContain("unknown key 'exlude'");
    expect(configBytes()).toBe("{ \"exlude\": [] }\n");
  });
});
