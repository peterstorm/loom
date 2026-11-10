/**
 * `scripts/lint-project.ts`, spawned for real over a temporary project with
 * BOTH harness rules directories: the shell around the engine's pure baseline
 * decisions (`baseline-config.ts`, unit-tested on its own).
 *
 * - `--write-baseline` records every unproven site into each harness's
 *   `config.json`, keeps the other fields, and a re-run changes nothing;
 * - a stale baseline entry fails the run (exit 1) and is reported in the JSON
 *   output's `staleEntries`;
 * - a lint ERROR (a file the linter could not lint) fails `--json`, not only
 *   the human-readable mode;
 * - the scope is everything lintable — tests included — minus the config's
 *   reasoned `exclude` list, which applies to explicit paths too, and whose
 *   stale entries fail the run;
 * - the project root is found from a subdirectory with its own package.json,
 *   an unknown config key and diverging harness copies refuse to run (exit 2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "lint-project.ts");
const HARNESS_DIRS = [".claude/linter/rules", ".pi/linter/rules"] as const;

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

let project: string;

beforeEach(() => {
  project = canonicalTempDir("loom-lint-project-cli-");
  writeFileSync(join(project, "package.json"), "{}\n");
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "shape.ts"), UNPROVEN_SWITCH);
  for (const dir of HARNESS_DIRS) {
    mkdirSync(join(project, dir), { recursive: true });
    writeFileSync(join(project, dir, "config.json"), `${JSON.stringify({ maxFunctionLines: 60 }, null, 2)}\n`);
  }
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Run the script from the project root. */
function lintProject(...args: string[]): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const result = spawnSync("bun", [SCRIPT, ...args], { cwd: project, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const configBytes = (dir: string): string => readFileSync(join(project, dir, "config.json"), "utf8");

type JsonReport = Readonly<{
  violations: readonly Readonly<{ file: string; rule: string }>[];
  errorCount: number;
  staleEntries: readonly string[];
  excluded: readonly Readonly<{ file: string; reason: string }>[];
}>;
const jsonReport = (stdout: string): JsonReport => JSON.parse(stdout) as JsonReport;

describe("lint-project.ts, spawned over a temporary project", () => {
  it("--write-baseline records the site in every harness config, keeps other fields, and is idempotent", () => {
    const written = lintProject("--write-baseline");
    expect(written.status, written.stderr).toBe(0);
    for (const dir of HARNESS_DIRS) {
      expect(JSON.parse(configBytes(dir))).toEqual({ maxFunctionLines: 60, switchTotalityBaseline: [SITE] });
    }
    const first = HARNESS_DIRS.map(configBytes);

    const rerun = lintProject("--write-baseline");
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(HARNESS_DIRS.map(configBytes)).toEqual(first);

    // The baselined site is excused and nothing in the baseline is stale.
    const linted = lintProject("--json");
    expect(linted.status, linted.stdout).toBe(0);
    expect(jsonReport(linted.stdout)).toEqual({ violations: [], errorCount: 0, staleEntries: [], excluded: [] });
  });

  it("a stale baseline entry exits 1 and is reported in the JSON output's staleEntries", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    // Both harness configs move together, as --write-baseline keeps them
    // (each harness's hook reads its own copy, so the script refuses a divergence).
    for (const dir of HARNESS_DIRS) {
      const config = JSON.parse(configBytes(dir));
      writeFileSync(join(project, dir, "config.json"),
        JSON.stringify({ ...config, switchTotalityBaseline: [...config.switchTotalityBaseline, "src/gone.ts::x.kind"] }));
    }

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
    expect(lintProject("--write-baseline").status).toBe(0);
    for (const dir of HARNESS_DIRS) writeFileSync(join(project, dir, "broken.json"), "{ not json");

    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
    expect(lintProject("--summary").status).toBe(1);
  });

  /** Rewrites both harness copies of config.json with extra fields. */
  function configure(fields: Record<string, unknown>): void {
    for (const dir of HARNESS_DIRS) {
      writeFileSync(join(project, dir, "config.json"), `${JSON.stringify({ ...JSON.parse(configBytes(dir)), ...fields }, null, 2)}\n`);
    }
  }

  it("lints test files by default — a rule that skips tests says so itself", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    writeFileSync(join(project, "src", "shape.test.ts"), ANY_ANNOTATED("x"));
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).violations).toContainEqual(expect.objectContaining({ file: "src/shape.test.ts", rule: "no-any-type" }));
  });

  it("lints the TypeScript module spellings (.mts, .cts) the walker used to skip", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    writeFileSync(join(project, "src", "esm.mts"), ANY_ANNOTATED("x"));
    writeFileSync(join(project, "src", "cjs.cts"), ANY_ANNOTATED("y"));
    const files = jsonReport(lintProject("--json").stdout).violations.map(({ file }) => file);
    expect(files).toEqual(expect.arrayContaining(["src/esm.mts", "src/cjs.cts"]));
  });

  it("an excluded path is never linted, is listed with its reason, and stays excluded when named explicitly", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    mkdirSync(join(project, "third_party"));
    writeFileSync(join(project, "third_party", "lib.ts"), ANY_ANNOTATED("x"));
    configure({ exclude: [{ path: "third_party/", reason: "vendored upstream, byte-pinned" }] });

    const linted = lintProject("--json");
    expect(linted.status, linted.stdout).toBe(0);
    expect(jsonReport(linted.stdout).excluded).toEqual([{ file: "third_party/lib.ts", reason: "third_party/ — vendored upstream, byte-pinned" }]);

    const explicit = lintProject("third_party/lib.ts");
    expect(explicit.stdout).toContain("excluded: third_party/lib.ts (third_party/ — vendored upstream, byte-pinned)");
    expect(explicit.stdout).not.toContain("no-any-type");
  });

  it("an exclusion that matches no file is stale: exit 1", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    configure({ exclude: [{ path: "gone/", reason: "was vendored" }] });
    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    expect(jsonReport(linted.stdout).staleEntries).toEqual(["exclude: gone/ (matches no file — delete the exclusion)"]);
  });

  it("finds the project root from a subdirectory that has its own package.json", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    mkdirSync(join(project, "engine"));
    writeFileSync(join(project, "engine", "package.json"), "{}\n");
    const result = spawnSync("bun", [SCRIPT, "--json"], { cwd: join(project, "engine"), encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(jsonReport(result.stdout).staleEntries).toEqual([]);
  });

  it("refuses to run on an unknown config key (exit 2), naming it", () => {
    configure({ exlude: [] });
    const linted = lintProject("--json");
    expect(linted.status).toBe(2);
    expect(linted.stderr).toContain("unknown key 'exlude'");
  });

  it("refuses to run when the two harness copies diverge (exit 2)", () => {
    writeFileSync(join(project, ".pi/linter/rules", "config.json"), `${JSON.stringify({ maxFunctionLines: 61 }, null, 2)}\n`);
    const linted = lintProject("--json");
    expect(linted.status).toBe(2);
    expect(linted.stderr).toContain("differ in: config.json");
  });
});
