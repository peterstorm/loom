import { describe, it, expect, mock, beforeEach } from "bun:test";

// Use a mutable state object so test overrides propagate through bun's mock.module
const mockState = {
  untrackedTestFiles: ["engine/tests/new.test.ts", "apps/web/tests/login.spec.ts"] as string[],
  diffUntrackedFn: (f: string) => `diff --untracked ${f}\n+new content in ${f}`,
  diffFilesFn: (files: string[]) => files.length ? `diff --tracked\n${files.map(f => `+modified ${f}`).join("\n")}` : "",
  diffFilesStagedFn: (_files: string[]) => "",
  isTrackedFn: (f: string) => !f.startsWith("untracked/"),
  existsSyncFn: (_path: string) => true,
};

mock.module("../../src/utils/git", () => ({
  isTracked: (f: string) => mockState.isTrackedFn(f),
  diffFiles: (files: string[]) => mockState.diffFilesFn(files),
  diffFilesStaged: (files: string[]) => mockState.diffFilesStagedFn(files),
  diffUntracked: (f: string) => mockState.diffUntrackedFn(f),
  listUntrackedTestFiles: () => mockState.untrackedTestFiles,
  diff: () => "",
  diffStaged: () => "",
  defaultBranch: () => "main",
  mergeBase: () => "abc123",
  headSha: () => "def456",
  isGitRepo: () => true,
  countNewTests: () => ({ java: 0, ts: 0, python: 0, rust: 0, total: 0 }),
  countAssertions: () => 0,
  filterTestFiles: (files: string[]) => files,
}));

// Mock node:fs so existsSync is controllable
mock.module("node:fs", () => ({
  existsSync: (p: string) => mockState.existsSyncFn(p),
  readFileSync: () => "",
  writeFileSync: () => {},
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ isFile: () => true, isDirectory: () => false }),
  rmSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  copyFileSync: () => {},
  accessSync: () => {},
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
}));

mock.module("../../src/state-manager", () => ({
  StateManager: class {
    static fromSession() { return new this(); }
    readGraph() { return { metadata: {}, tasks: [] }; }
    writeGraph() {}
  },
}));
mock.module("../../src/config", () => ({
  IMPL_AGENTS: ["code-implementer-agent"],
  REVIEW_AGENTS: ["reviewer-agent"],
}));
mock.module("../../src/parsers/parse-transcript", () => ({
  parseTranscript: () => ({ messages: [] }),
}));
mock.module("../../src/parsers/parse-files-modified", () => ({
  parseFilesModified: () => [],
}));
mock.module("../../src/parsers/parse-bash-test-output", () => ({
  parseBashTestOutput: () => "",
}));
mock.module("../../src/utils/strip-namespace", () => ({
  stripNamespace: (s: string) => s,
}));
mock.module("../../src/utils/extract-task-id", () => ({
  extractTaskId: () => null,
}));

const { collectDiff } = await import("../../src/handlers/subagent-stop/update-task-status");

describe("collectDiff", () => {
  beforeEach(() => {
    mockState.untrackedTestFiles = ["engine/tests/new.test.ts", "apps/web/tests/login.spec.ts"];
    mockState.diffFilesFn = (files: string[]) => files.length ? `diff --tracked\n${files.map(f => `+modified ${f}`).join("\n")}` : "";
    mockState.diffUntrackedFn = (f: string) => `diff --untracked ${f}\n+new content in ${f}`;
    mockState.diffFilesStagedFn = () => "";
    mockState.isTrackedFn = (f: string) => !f.startsWith("untracked/");
    mockState.existsSyncFn = () => true;
  });

  it("includes untracked test files even when filesModified produces output", () => {
    const result = collectDiff(["src/main.ts"], undefined);
    // Should contain the tracked diff
    expect(result).toContain("src/main.ts");
    // Should also contain untracked test files from listUntrackedTestFiles
    expect(result).toContain("engine/tests/new.test.ts");
    expect(result).toContain("apps/web/tests/login.spec.ts");
  });

  it("does not duplicate test files already in filesModified", () => {
    const diffedFiles: string[] = [];
    mockState.diffUntrackedFn = (f: string) => {
      diffedFiles.push(f);
      return `diff --untracked ${f}\n+content`;
    };
    // Mark test file as untracked so it goes through diffUntracked path from filesModified
    mockState.isTrackedFn = (f: string) => f === "src/main.ts";

    collectDiff(["src/main.ts", "engine/tests/new.test.ts"], undefined);

    // engine/tests/new.test.ts should be diffed exactly once
    // (from filesModified untracked processing, NOT duplicated from listUntrackedTestFiles)
    const testFileCount = diffedFiles.filter(f => f === "engine/tests/new.test.ts").length;
    expect(testFileCount).toBe(1);
  });

  it("includes test files from listUntrackedTestFiles not in filesModified", () => {
    const diffedFiles: string[] = [];
    mockState.diffUntrackedFn = (f: string) => {
      diffedFiles.push(f);
      return `diff --untracked ${f}\n+content`;
    };

    collectDiff(["src/main.ts"], undefined);

    expect(diffedFiles).toContain("engine/tests/new.test.ts");
    expect(diffedFiles).toContain("apps/web/tests/login.spec.ts");
  });

  it("falls back to SHA-based diff when filesModified is empty and includes test files", () => {
    const result = collectDiff([], "abc123");
    // Fallback path should still include untracked test files
    expect(result).toContain("engine/tests/new.test.ts");
    expect(result).toContain("apps/web/tests/login.spec.ts");
  });

  it("handles empty listUntrackedTestFiles gracefully", () => {
    mockState.untrackedTestFiles = [];
    const result = collectDiff(["src/main.ts"], undefined);
    // Should still have the tracked diff
    expect(result).toContain("src/main.ts");
    // No test file content since there are none
    expect(result).not.toContain("engine/tests/new.test.ts");
  });
});
