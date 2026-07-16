import { describe, it, expect } from "vitest";
import { collectDiff, type DiffDeps } from "../../src/handlers/subagent-stop/update-task-status";

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
    listUntrackedTestFiles: () => ["engine/tests/new.test.ts", "apps/web/tests/login.spec.ts"],
    diff: () => "",
    diffStaged: () => "",
    defaultBranch: () => "main",
    mergeBase: () => "abc123",
    fileExists: () => true,
    ...overrides,
  };
}

describe("collectDiff", () => {
  it("includes untracked test files even when filesModified produces output", () => {
    const result = collectDiff(["src/main.ts"], undefined, fakeDeps());
    // Should contain the tracked diff
    expect(result).toContain("src/main.ts");
    // Should also contain untracked test files from listUntrackedTestFiles
    expect(result).toContain("engine/tests/new.test.ts");
    expect(result).toContain("apps/web/tests/login.spec.ts");
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

    collectDiff(["src/main.ts", "engine/tests/new.test.ts"], undefined, deps);

    // engine/tests/new.test.ts should be diffed exactly once
    // (from filesModified untracked processing, NOT duplicated from listUntrackedTestFiles)
    const testFileCount = diffedFiles.filter((f) => f === "engine/tests/new.test.ts").length;
    expect(testFileCount).toBe(1);
  });

  it("includes test files from listUntrackedTestFiles not in filesModified", () => {
    const diffedFiles: string[] = [];
    const deps = fakeDeps({
      diffUntracked: (f) => {
        diffedFiles.push(f);
        return `diff --untracked ${f}\n+content`;
      },
    });

    collectDiff(["src/main.ts"], undefined, deps);

    expect(diffedFiles).toContain("engine/tests/new.test.ts");
    expect(diffedFiles).toContain("apps/web/tests/login.spec.ts");
  });

  it("falls back to SHA-based diff when filesModified is empty and includes test files", () => {
    const result = collectDiff([], "abc123", fakeDeps());
    // Fallback path should still include untracked test files
    expect(result).toContain("engine/tests/new.test.ts");
    expect(result).toContain("apps/web/tests/login.spec.ts");
  });

  it("handles empty listUntrackedTestFiles gracefully", () => {
    const result = collectDiff(["src/main.ts"], undefined, fakeDeps({ listUntrackedTestFiles: () => [] }));
    // Should still have the tracked diff
    expect(result).toContain("src/main.ts");
    // No test file content since there are none
    expect(result).not.toContain("engine/tests/new.test.ts");
  });
});
