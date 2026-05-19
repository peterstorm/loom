import { describe, it, expect } from "vitest";
import {
  parseWaveArg,
  collectModifiedFiles,
  filterExistingFiles,
  aggregateResults,
  lintFiles,
  type FileLintResult,
} from "../../../src/handlers/helpers/lint-wave-gate";
import type { Task } from "../../../src/types";
import type { LintResult } from "../../../src/linter/types";
import { formatOutput } from "../../../src/linter/formatter";

// --- Test helpers ---

const baseTask: Task = {
  id: "T1",
  description: "test task",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  depends_on: [],
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return { ...baseTask, ...overrides };
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

// --- filterExistingFiles ---

describe("filterExistingFiles", () => {
  it("returns empty array for empty input", () => {
    expect(filterExistingFiles([], () => true)).toEqual([]);
  });

  it("filters out non-existing files", () => {
    const files = ["exists.ts", "deleted.ts", "also-exists.ts"];
    const existsFn = (p: string) => p !== "deleted.ts";
    expect(filterExistingFiles(files, existsFn)).toEqual(["exists.ts", "also-exists.ts"]);
  });

  it("returns all files when all exist", () => {
    const files = ["a.ts", "b.ts"];
    expect(filterExistingFiles(files, () => true)).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty when none exist", () => {
    const files = ["a.ts", "b.ts"];
    expect(filterExistingFiles(files, () => false)).toEqual([]);
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
          { rule: "no-any", file: "src/index.ts", line: 20, text: "const x: any = {}", fixHint: "Use explicit type" },
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

// --- Integration: collectModifiedFiles + filterExistingFiles pipeline ---

describe("file collection pipeline", () => {
  it("handles full pipeline: collect → filter → empty = no files to lint", () => {
    const tasks = [makeTask({ files_modified: ["deleted.ts"] })];
    const files = collectModifiedFiles(tasks);
    const existing = filterExistingFiles(files, () => false);
    expect(existing).toEqual([]);
  });

  it("handles full pipeline: multiple tasks → deduplicate → filter", () => {
    const tasks = [
      makeTask({ id: "T1", files_modified: ["a.ts", "shared.ts"] }),
      makeTask({ id: "T2", files_modified: ["shared.ts", "b.ts", "deleted.ts"] }),
    ];
    const files = collectModifiedFiles(tasks);
    const existing = filterExistingFiles(files, (p) => p !== "deleted.ts");
    expect(existing).toEqual(["a.ts", "b.ts", "shared.ts"]);
  });
});
