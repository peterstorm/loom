/**
 * `scripts/lint-project.ts`, spawned for real over a temporary project with
 * BOTH harness rules directories: the shell around the engine's pure baseline
 * decisions (`baseline-config.ts`, unit-tested on its own).
 *
 * - `--write-baseline` records every unproven site into each harness's
 *   `config.json`, keeps the other fields, and a re-run changes nothing;
 * - a stale baseline entry fails the run (exit 1) and is reported in the JSON
 *   output's `baselineDrift`;
 * - a lint ERROR (a file the linter could not lint) fails `--json`, not only
 *   the human-readable mode.
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

type JsonReport = Readonly<{ violations: readonly unknown[]; errorCount: number; baselineDrift: readonly string[] }>;
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
    expect(jsonReport(linted.stdout)).toEqual({ violations: [], errorCount: 0, baselineDrift: [] });
  });

  it("a stale baseline entry exits 1 and is reported in the JSON output's baselineDrift", () => {
    expect(lintProject("--write-baseline").status).toBe(0);
    // Both harness configs move together, as --write-baseline keeps them
    // (the script reads the Pi one when `.pi/` exists).
    for (const dir of HARNESS_DIRS) {
      const config = JSON.parse(configBytes(dir));
      writeFileSync(join(project, dir, "config.json"),
        JSON.stringify({ ...config, switchTotalityBaseline: [...config.switchTotalityBaseline, "src/gone.ts::x.kind"] }));
    }

    const linted = lintProject("--json");
    expect(linted.status).toBe(1);
    const report = jsonReport(linted.stdout);
    expect(report.violations).toEqual([]);
    expect(report.baselineDrift).toEqual([
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
});
