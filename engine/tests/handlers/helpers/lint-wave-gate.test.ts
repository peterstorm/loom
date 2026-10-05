import { execFileSync, spawnSync } from "node:child_process";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseWaveArg,
  collectModifiedFiles,
  resolveLintTargets,
  aggregateResults,
  lintFiles,
  runFullTierWaveLint,
  type FileLintResult,
} from "../../../src/handlers/helpers/lint-wave-gate";
import type { Task, TaskCommonMetadata } from "../../../src/types";
import { taskFixture } from "../../fixtures/task-lifecycle";
import type { LintResult } from "../../../src/linter/types";
import { formatOutput } from "../../../src/linter/formatter";

// --- Test helpers ---

const baseTask: Task = {
  id: "T1",
  description: "test task",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  legacy_missing_proof: true,
  depends_on: [],
};

function makeTask(overrides: Partial<TaskCommonMetadata> = {}): Task {
  return taskFixture({ ...baseTask, ...overrides });
}

function makeFileLintResult(file: string, result: LintResult): FileLintResult {
  return { file, result, output: formatOutput(result, file) };
}

// --- parseWaveArg ---

describe("parseWaveArg", () => {
  it("returns null when no --wave arg present", () => {
    expect(parseWaveArg([])).toBeNull();
    expect(parseWaveArg(["--other", "val"])).toBeNull();
  });

  it("parses --wave N correctly", () => {
    expect(parseWaveArg(["--wave", "3"])).toBe(3);
    expect(parseWaveArg(["--other", "x", "--wave", "5"])).toBe(5);
  });

  it("returns null when --wave has no value", () => {
    expect(parseWaveArg(["--wave"])).toBeNull();
  });

  it("throws for non-numeric --wave value", () => {
    expect(() => parseWaveArg(["--wave", "abc"])).toThrow("Invalid --wave value");
  });

  it("throws for negative --wave value", () => {
    expect(() => parseWaveArg(["--wave", "-1"])).toThrow("Invalid --wave value");
  });

  it("throws for fractional --wave value", () => {
    expect(() => parseWaveArg(["--wave", "3.5"])).toThrow("Invalid --wave value");
  });

  it("throws for zero --wave value", () => {
    expect(() => parseWaveArg(["--wave", "0"])).toThrow("Invalid --wave value");
  });

  it("returns valid positive integer", () => {
    expect(parseWaveArg(["--wave", "2"])).toBe(2);
  });
});

// --- collectModifiedFiles ---

describe("collectModifiedFiles", () => {
  it("returns empty array when no tasks", () => {
    expect(collectModifiedFiles([])).toEqual([]);
  });

  it("returns empty array when tasks have no files_modified", () => {
    const tasks = [makeTask(), makeTask({ id: "T2" })];
    expect(collectModifiedFiles(tasks)).toEqual([]);
  });

  it("collects files from single task", () => {
    const tasks = [makeTask({ files_modified: ["a.ts", "b.ts"] })];
    expect(collectModifiedFiles(tasks)).toEqual(["a.ts", "b.ts"]);
  });

  it("deduplicates files across multiple tasks", () => {
    const tasks = [
      makeTask({ id: "T1", files_modified: ["a.ts", "b.ts"] }),
      makeTask({ id: "T2", files_modified: ["b.ts", "c.ts"] }),
    ];
    expect(collectModifiedFiles(tasks)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("returns sorted list", () => {
    const tasks = [makeTask({ files_modified: ["z.ts", "a.ts", "m.ts"] })];
    expect(collectModifiedFiles(tasks)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("handles tasks with empty files_modified array", () => {
    const tasks = [
      makeTask({ id: "T1", files_modified: [] }),
      makeTask({ id: "T2", files_modified: ["a.ts"] }),
    ];
    expect(collectModifiedFiles(tasks)).toEqual(["a.ts"]);
  });
});

// --- repository-confined lint targets ---

describe("resolveLintTargets", () => {
  it("canonicalizes absolute in-repo paths and skips deleted files", () => {
    const root = canonicalTempDir("loom-lint-targets-");
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.ts"), "export {};\n");
      expect(resolveLintTargets(root, [join(root, "src", "a.ts"), "./src/a.ts", "src/deleted.ts"]))
        .toEqual([join(root, "src", "a.ts")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects external and symlink-traversing transcript paths before lint reads", () => {
    const root = canonicalTempDir("loom-lint-root-");
    const outside = canonicalTempDir("loom-lint-outside-");
    try {
      writeFileSync(join(outside, "secret.ts"), "secret\n");
      symlinkSync(outside, join(root, "linked"));
      expect(() => resolveLintTargets(root, [join(outside, "secret.ts")]))
        .toThrow("must identify a file inside the repository");
      expect(() => resolveLintTargets(root, ["linked/secret.ts"]))
        .toThrow("must not traverse a symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("lints a directory artifact as its Git-visible regular files", () => {
    // Production regression: a Wave whose Task declared a directory artifact
    // blocked the completion suite with "lint target must be a regular file".
    const root = canonicalTempDir("loom-lint-directory-");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      mkdirSync(join(root, "calibration", "pilot", "cache"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), "calibration/pilot/cache/\n");
      writeFileSync(join(root, "calibration", "pilot", "tracked.ts"), "export {};\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "seed"], { cwd: root });
      writeFileSync(join(root, "calibration", "pilot", "untracked.ts"), "export {};\n");
      writeFileSync(join(root, "calibration", "pilot", "cache", "ignored.ts"), "export {};\n");
      symlinkSync("tracked.ts", join(root, "calibration", "pilot", "alias.ts"));

      expect(resolveLintTargets(root, ["calibration/pilot", "calibration/pilot/tracked.ts"])).toEqual([
        join(root, "calibration", "pilot", "tracked.ts"),
        join(root, "calibration", "pilot", "untracked.ts"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a directory artifact's files cannot be listed", () => {
    const root = canonicalTempDir("loom-lint-listing-");
    try {
      mkdirSync(join(root, "calibration"));
      expect(() => resolveLintTargets(root, ["calibration"], () => {
        throw new Error("git index unreadable");
      })).toThrow("git index unreadable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- lintFiles ---

describe("lintFiles", () => {
  it("returns empty array for empty input", () => {
    const results = lintFiles([], "/rules", null);
    expect(results).toEqual([]);
  });

  it("calls lintFn with full tier for each file", () => {
    const calls: Array<{ file: string; tier: string; defaultDir: string; projectDir: string | null }> = [];
    const mockLintFn = (file: string, tier: "full", defaultDir: string, projectDir: string | null): LintResult => {
      calls.push({ file, tier, defaultDir, projectDir });
      return { kind: "pass" };
    };

    lintFiles(["a.ts", "b.ts"], "/default-rules", "/project-rules", mockLintFn);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ file: "a.ts", tier: "full", defaultDir: "/default-rules", projectDir: "/project-rules" });
    expect(calls[1]).toEqual({ file: "b.ts", tier: "full", defaultDir: "/default-rules", projectDir: "/project-rules" });
  });

  it("returns FileLintResult with correct structure", () => {
    const mockLintFn = (): LintResult => ({ kind: "pass" });
    const results = lintFiles(["a.ts"], "/rules", null, mockLintFn);

    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("a.ts");
    expect(results[0].result).toEqual({ kind: "pass" });
    expect(results[0].output).toEqual({ status: "pass", file: "a.ts" });
  });

  it("collects violation results correctly", () => {
    const mockLintFn = (): LintResult => ({
      kind: "violations",
      violations: [{ rule: "no-console", file: "a.ts", line: 5, text: "console.log(x)", fixHint: "Remove console" }],
    });
    const results = lintFiles(["a.ts"], "/rules", null, mockLintFn);

    expect(results[0].result.kind).toBe("violations");
    expect(results[0].output.status).toBe("fail");
  });

  it("collects error results correctly", () => {
    const mockLintFn = (): LintResult => ({ kind: "error", message: "Rule load failed" });
    const results = lintFiles(["a.ts"], "/rules", null, mockLintFn);

    expect(results[0].result.kind).toBe("error");
    expect(results[0].output.status).toBe("error");
  });
});

// --- aggregateResults ---

describe("aggregateResults", () => {
  it("returns allow for empty results", () => {
    expect(aggregateResults([])).toEqual({ kind: "allow" });
  });

  it("returns allow when all files pass", () => {
    const results: FileLintResult[] = [
      makeFileLintResult("a.ts", { kind: "pass" }),
      makeFileLintResult("b.ts", { kind: "pass" }),
    ];
    expect(aggregateResults(results)).toEqual({ kind: "allow" });
  });

  it("returns block when any file has violations", () => {
    const results: FileLintResult[] = [
      makeFileLintResult("a.ts", { kind: "pass" }),
      makeFileLintResult("b.ts", {
        kind: "violations",
        violations: [{ rule: "no-console", file: "b.ts", line: 1, text: "console.log()", fixHint: "Remove" }],
      }),
    ];
    const result = aggregateResults(results);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("WAVE-GATE LINT");
      expect(result.message).toContain("1 file(s) failed");
      expect(result.message).toContain("no-console");
      expect(result.message).toContain("b.ts");
    }
  });

  it("returns block when any file has an error", () => {
    const results: FileLintResult[] = [
      makeFileLintResult("a.ts", { kind: "pass" }),
      makeFileLintResult("c.ts", { kind: "error", message: "Failed to read rules" }),
    ];
    const result = aggregateResults(results);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("WAVE-GATE LINT");
      expect(result.message).toContain("1 file(s) failed");
      expect(result.message).toContain("Failed to read rules");
    }
  });

  it("aggregates multiple failures", () => {
    const results: FileLintResult[] = [
      makeFileLintResult("a.ts", {
        kind: "violations",
        violations: [{ rule: "no-todo", file: "a.ts", line: 3, text: "// TODO", fixHint: "Fix it" }],
      }),
      makeFileLintResult("b.ts", { kind: "error", message: "Boom" }),
      makeFileLintResult("c.ts", { kind: "pass" }),
    ];
    const result = aggregateResults(results);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("2 file(s) failed");
      expect(result.message).toContain("a.ts");
      expect(result.message).toContain("b.ts");
      expect(result.message).not.toContain("c.ts");
    }
  });

  it("includes violation details in block message", () => {
    const results: FileLintResult[] = [
      makeFileLintResult("src/index.ts", {
        kind: "violations",
        violations: [
          { rule: "no-console", file: "src/index.ts", line: 10, text: "console.log('debug')", fixHint: "Use logger instead" },
          { rule: "no-any", file: "src/index.ts", line: 20, text: "const x = untypedValue", fixHint: "Use explicit type" },
        ],
      }),
    ];
    const result = aggregateResults(results);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("no-console");
      expect(result.message).toContain("line 10");
      expect(result.message).toContain("no-any");
      expect(result.message).toContain("line 20");
      expect(result.message).toContain("Use logger instead");
    }
  });
});

// --- batch lint path (production: rules loaded once) ---

describe("lintFiles batch path", () => {
  it("assembles each FileLintResult from the batch result, in input order", () => {
    const root = canonicalTempDir("loom-lint-batch-");
    try {
      const rules = join(root, "rules");
      mkdirSync(rules);
      writeFileSync(join(root, "b.ts"), "export {};\n");
      writeFileSync(join(root, "a.ts"), "export {};\n");
      const files = [join(root, "b.ts"), join(root, "a.ts")];
      const results = lintFiles(files, rules, null);
      expect(results.map(({ file }) => file)).toEqual(files);
      for (const { file, result, output } of results) {
        expect(output).toEqual(formatOutput(result, file));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- engine-error block (fail closed) ---

describe("runFullTierWaveLint", () => {
  it("allows a Wave that modified nothing", () => {
    expect(runFullTierWaveLint([makeTask()])).toEqual({ kind: "allow" });
  });

  it("converts a target-resolution failure into the WAVE-GATE LINT ENGINE ERROR block", () => {
    const outside = canonicalTempDir("loom-lint-engine-error-");
    try {
      writeFileSync(join(outside, "secret.ts"), "export {};\n");
      const result = runFullTierWaveLint([makeTask({ files_modified: [join(outside, "secret.ts")] })]);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toMatch(/^🚫 WAVE-GATE LINT ENGINE ERROR: .*must identify a file inside the repository/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("lint-wave-gate handler", () => {
  const cli = (statePath: string) =>
    spawnSync("bun", ["src/cli.ts", "helper", "lint-wave-gate"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env, LOOM_STATE_PATH: statePath, PI_CODING_AGENT: "" },
    });

  it("fails closed with the engine-error block when the task graph cannot be loaded", () => {
    const dir = canonicalTempDir("loom-lint-handler-");
    try {
      const statePath = join(dir, "active_task_graph.json");
      writeFileSync(statePath, '{"current_phase":');
      const run = cli(statePath);
      expect(run.status).toBe(2);
      expect(run.stdout + run.stderr)
        .toContain(`🚫 WAVE-GATE LINT ENGINE ERROR: Corrupt state file (invalid JSON): ${statePath}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an absent task graph without the engine-error prefix", () => {
    const dir = canonicalTempDir("loom-lint-handler-");
    try {
      const statePath = join(dir, "absent.json");
      const run = cli(statePath);
      expect(run.status).toBe(2);
      expect(run.stdout + run.stderr).toContain(`🚫 WAVE-GATE LINT: Cannot read task graph at ${statePath}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
