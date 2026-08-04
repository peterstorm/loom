import { describe, it, expect } from "vitest";
import {
  collectDiff,
  collectNewTestEvidence,
  type DiffDeps,
} from "../../src/handlers/subagent-stop/update-task-status";

/**
 * collectDiff takes its I/O seam (DiffDeps) as a parameter, so tests pass
 * plain object literals — no module mocking (bun's vitest shim supports
 * neither vi.mock nor vi.hoisted).
 */

function fakeDeps(overrides: Partial<DiffDeps> = {}): DiffDeps {
  return {
    isTracked: (f) => !f.startsWith("untracked/"),
    diffFiles: (files) => (files.length ? `diff --tracked\n${files.map((f) => `+modified ${f}`).join("\n")}` : ""),
    diffFilesStaged: () => "",
    diffUntracked: (f) => `diff --untracked ${f}\n+new content in ${f}`,
    fileExists: () => true,
    ...overrides,
  };
}

describe("collectDiff", () => {
  it("includes only paths attributed to the current task", () => {
    const result = collectDiff(["src/main.ts"], fakeDeps());
    expect(result).toContain("src/main.ts");
    expect(result).not.toContain("engine/tests/new.test.ts");
    expect(result).not.toContain("apps/web/tests/login.spec.ts");
  });

  it("does not duplicate test files already in filesModified", () => {
    const diffedFiles: string[] = [];
    const deps = fakeDeps({
      diffUntracked: (f) => {
        diffedFiles.push(f);
        return `diff --untracked ${f}\n+content`;
      },
      // Mark test file as untracked so it goes through diffUntracked path from filesModified
      isTracked: (f) => f === "src/main.ts",
    });

    collectDiff(["src/main.ts", "engine/tests/new.test.ts"], deps);

    // engine/tests/new.test.ts is attributed and therefore diffed exactly once.
    const testFileCount = diffedFiles.filter((f) => f === "engine/tests/new.test.ts").length;
    expect(testFileCount).toBe(1);
  });

  it("excludes foreign untracked tests that are not in filesModified", () => {
    const diffedFiles: string[] = [];
    const deps = fakeDeps({
      diffUntracked: (f) => {
        diffedFiles.push(f);
        return `diff --untracked ${f}\n+content`;
      },
    });

    collectDiff(["src/main.ts"], deps);

    expect(diffedFiles).toEqual([]);
  });

  it("fails closed when no path is attributable to the task", () => {
    expect(collectDiff([], fakeDeps())).toBe("");
  });

  it("collects an attributed untracked test", () => {
    const result = collectDiff(
      ["engine/tests/new.test.ts"],
      fakeDeps({ isTracked: () => false }),
    );
    expect(result).toContain("engine/tests/new.test.ts");
  });

  it("proves new tests from tracked unstaged worktree changes for every harness", () => {
    const evidence = collectNewTestEvidence(
      ["engine/tests/existing.test.ts"],
      true,
      fakeDeps({
        diffFiles: () => [
          "diff --git a/engine/tests/existing.test.ts b/engine/tests/existing.test.ts",
          "+  it(\"covers the fix\", () => {",
          "+    expect(result).toBe(true);",
          "+  });",
        ].join("\n"),
        diffFilesStaged: () => "",
      }),
    );

    expect(evidence).toEqual({
      written: true,
      evidence: "1 new test methods, 1 assertions (ts: 1 it/test/describe)",
    });
  });
});
