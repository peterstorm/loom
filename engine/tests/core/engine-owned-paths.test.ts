/**
 * loom#198, Cause 2: one module owns every repository path class the engine
 * writes or protects, and every workspace observer asks it. These tests pin
 * the classes for both harnesses and that the observers agree with it.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CANONICAL_TASK_GRAPH_PATHS,
  COMPLETION_REPORT_ROOT,
  HARNESS_DIRECTORY_NAMES,
  RUN_LAYOUTS,
  canonicalRunsRoot,
  canonicalTaskGraphPath,
  engineOwnedPathClass,
  isEngineEvidencePath,
  projectRootOfCanonicalStatePath,
  RUN_LAYOUT_COMPONENTS,
  runsRootBesideStateFile,
} from "../../src/core/engine-owned-paths";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExcludedRemediationPath, parseCanonicalRepositoryRelativePath } from "../../src/core/remediation-machine";

describe("engineOwnedPathClass", () => {
  it.each<[string, ReturnType<typeof engineOwnedPathClass>]>([
    [".git", "git-metadata"],
    [".git/index", "git-metadata"],
    [".claude/state/active_task_graph.json", "harness-state"],
    [".pi/state/active_task_graph.json", "harness-state"],
    [".pi/state/.task_graph", "harness-state"],
    [".claude/reviews/packets/run.x/T5.json", "run-directory"],
    [".pi/reviews/review-and-fix-runs/run.x/result.json", "run-directory"],
    [".claude/specs/2026-x/panel-runs/run.x/manifest.json", "run-directory"],
    [".pi/custom/wave-gate-runs/run.x/events.json", "run-directory"],
    [".loom/completion-reports/affected.junit.xml", "completion-report"],
    [".gitignore", null],
    [".github/workflows/ci.yml", null],
    [".claude/settings.json", null],
    [".claude/specs/2026-x/spec.md", null],
    [".loom/verification-manifest.json", null],
    ["src/panel-runs/view.ts", null],
    [".claude-state/x", null],
    [".pi/statefile", null],
  ])("classifies %s as %s", (path, owned) => {
    expect(engineOwnedPathClass(path)).toBe(owned);
  });

  it("derives the canonical State File and runs-root paths for each harness", () => {
    expect(CANONICAL_TASK_GRAPH_PATHS).toEqual([".claude/state/active_task_graph.json", ".pi/state/active_task_graph.json"]);
    expect(HARNESS_DIRECTORY_NAMES.map(canonicalTaskGraphPath)).toEqual(CANONICAL_TASK_GRAPH_PATHS);
    expect(canonicalRunsRoot(".claude", "wave-gate-runs")).toBe(".claude/reviews/wave-gate-runs");
    expect(canonicalRunsRoot(".pi", "review-and-fix-runs")).toBe(".pi/reviews/review-and-fix-runs");
    expect(COMPLETION_REPORT_ROOT).toBe(".loom/completion-reports");
  });

  it("treats both harnesses alike: a path's class does not depend on which harness directory holds it", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/u);
    fc.assert(fc.property(
      fc.constantFrom("state", "reviews", "specs", "custom"),
      fc.array(fc.oneof(segment, fc.constantFrom(...RUN_LAYOUTS)), { maxLength: 4 }),
      (area, rest) => {
        const tail = [area, ...rest].join("/");
        expect(engineOwnedPathClass(`.pi/${tail}`)).toBe(engineOwnedPathClass(`.claude/${tail}`));
      },
    ));
  });
});

describe("the derivations beside a State File", () => {
  it("finds the project root of a canonical State File, and none for another layout", () => {
    expect(projectRootOfCanonicalStatePath("/work/repo/.claude/state/active_task_graph.json")).toBe("/work/repo");
    expect(projectRootOfCanonicalStatePath("/work/repo/.pi/state/active_task_graph.json")).toBe("/work/repo");
    expect(projectRootOfCanonicalStatePath("/work/repo/.claude/state/other.json")).toBeNull();
    expect(projectRootOfCanonicalStatePath("/work/repo/custom/active_task_graph.json")).toBeNull();
  });

  it("puts a runs root in the reviews directory of the State File's own harness", () => {
    expect(runsRootBesideStateFile("/work/repo/.pi/state/active_task_graph.json", "wave-gate-runs")).toBe("/work/repo/.pi/reviews/wave-gate-runs");
    expect(runsRootBesideStateFile("/work/repo/.claude/state/active_task_graph.json", "review-and-fix-runs"))
      .toBe("/work/repo/.claude/reviews/review-and-fix-runs");
  });

  it("keeps the run layout set immutable at runtime", () => {
    expect(() => (RUN_LAYOUT_COMPONENTS as Set<string>).add("evil-runs")).toThrow();
    expect(RUN_LAYOUT_COMPONENTS.has("evil-runs")).toBe(false);
  });
});

describe("the lint rule that keeps these paths in one module", () => {
  const rule = JSON.parse(readFileSync(join(__dirname, "../../../.claude/linter/rules/inv-10-one-engine-owned-path-module.json"), "utf8")) as {
    pattern: string; flags: string; excludePatterns: readonly string[];
  };
  const restates = (line: string): boolean => new RegExp(rule.pattern, rule.flags).test(line);

  it.each([
    'const STATE = ".pi/state/active_task_graph.json";',
    "const ROOT = '.claude/reviews';",
    'join(root, "reviews", "wave-gate-runs")',
    'const layouts = ["panel-runs", "review-runs"];',
    'const REPORT = `.loom/completion-reports/affected.json`;',
    'const FILE = "active_task_graph.json";',
  ])("flags a restatement in code: %s", (line) => {
    expect(restates(line)).toBe(true);
  });

  it.each([
    " * The State File lives in `.claude/state/active_task_graph.json`.",
    "// keep panel-runs out of a staged set",
    "/* .pi/reviews holds run evidence */",
    'const SETTINGS = ".claude/settings.json";',
    'const SPEC = ".claude/specs/x/spec.md";',
    'const VIEW = "src/panel-runs-view.ts";',
  ])("does not flag prose or other paths: %s", (line) => {
    expect(restates(line)).toBe(false);
  });

  it("exempts only the owning module and tests", () => {
    expect(rule.excludePatterns).toContain("engine/src/core/engine-owned-paths.ts");
    expect(rule.excludePatterns.filter((pattern) => pattern.startsWith("engine/src/"))).toEqual(["engine/src/core/engine-owned-paths.ts"]);
  });
});

describe("the observers agree with the one module", () => {
  it("remediation excludes exactly Loom evidence, for either harness", () => {
    const segment = fc.stringMatching(/^[a-z.][a-z0-9.-]{0,7}$/u).filter((part) => part !== "." && part !== "..");
    const path = fc.tuple(
      fc.constantFrom(".git", ".claude", ".pi", ".loom", "src", ".github"),
      fc.constantFrom("state", "reviews", "specs", ...RUN_LAYOUTS, "lib"),
      fc.array(segment, { maxLength: 3 }),
    ).map(([first, second, rest]) => [first, second, ...rest].join("/"));
    fc.assert(fc.property(path, (candidate) => {
      const parsed = parseCanonicalRepositoryRelativePath(candidate);
      if (!parsed.ok) return;
      expect(isExcludedRemediationPath(parsed.value)).toBe(isEngineEvidencePath(candidate));
    }));
  });

  it("calls a completion report engine-owned but not evidence, so remediation may stage a report path", () => {
    expect(engineOwnedPathClass(`${COMPLETION_REPORT_ROOT}/affected.json`)).toBe("completion-report");
    expect(isEngineEvidencePath(`${COMPLETION_REPORT_ROOT}/affected.json`)).toBe(false);
  });
});
