import { describe, it, expect } from "vitest";
import {
  collectDiff,
  collectNewTestEvidence,
  type DiffDeps,
} from "../../src/handlers/subagent-stop/update-task-status";

const diff = (value: string) => ({ ok: true as const, diff: value });

function fakeDeps(overrides: Partial<DiffDeps> = {}): DiffDeps {
  return {
    isTracked: (f) => ({ ok: true, tracked: !f.startsWith("untracked/") }),
    diffFiles: (files) => diff(files.length ? `diff --tracked\n${files.map((f) => `+modified ${f}`).join("\n")}` : ""),
    diffFilesStaged: () => diff(""),
    diffFilesSince: () => diff(""),
    diffUntracked: (f) => diff(`diff --untracked ${f}\n+new content in ${f}`),
    inspectFilePresence: () => ({ ok: true, exists: true }),
    ...overrides,
  };
}

describe("collectDiff", () => {
  it("includes only paths attributed to the current task", () => {
    const result = collectDiff(["src/main.ts"], fakeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("src/main.ts");
    expect(result.value).not.toContain("engine/tests/new.test.ts");
    expect(result.value).not.toContain("apps/web/tests/login.spec.ts");
  });

  it("does not duplicate test files already in filesModified", () => {
    const diffedFiles: string[] = [];
    const deps = fakeDeps({
      diffUntracked: (f) => {
        diffedFiles.push(f);
        return diff(`diff --untracked ${f}\n+content`);
      },
      isTracked: (f) => ({ ok: true, tracked: f === "src/main.ts" }),
    });

    collectDiff(["src/main.ts", "engine/tests/new.test.ts"], deps);

    expect(diffedFiles.filter((f) => f === "engine/tests/new.test.ts")).toHaveLength(1);
  });

  it("excludes foreign untracked tests that are not in filesModified", () => {
    const diffedFiles: string[] = [];
    collectDiff(["src/main.ts"], fakeDeps({
      diffUntracked: (f) => {
        diffedFiles.push(f);
        return diff(`diff --untracked ${f}\n+content`);
      },
    }));
    expect(diffedFiles).toEqual([]);
  });

  it("returns an empty successful observation when no path is attributable", () => {
    expect(collectDiff([], fakeDeps())).toEqual({ ok: true, value: "" });
  });

  it("collects an attributed untracked test", () => {
    const result = collectDiff(
      ["engine/tests/new.test.ts"],
      fakeDeps({ isTracked: () => ({ ok: true, tracked: false }) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain("engine/tests/new.test.ts");
  });

  it("returns typed Git tracking failure data", () => {
    expect(collectDiff(
      ["engine/tests/existing.test.ts"],
      fakeDeps({ isTracked: () => ({ ok: false, error: "git index unreadable" }) }),
    )).toEqual({
      ok: false,
      error: { kind: "git-observation-failed", operation: "is-tracked", message: "git index unreadable" },
    });
  });

  it("returns typed file-observation failure data", () => {
    expect(collectDiff(
      ["engine/tests/new.test.ts"],
      fakeDeps({
        isTracked: () => ({ ok: true, tracked: false }),
        inspectFilePresence: () => ({ ok: false, error: "EACCES" }),
      }),
    )).toEqual({
      ok: false,
      error: {
        kind: "filesystem-observation-failed",
        operation: "inspect-file",
        path: "engine/tests/new.test.ts",
        message: "EACCES",
      },
    });
  });

  it("returns typed Git diff failure data", () => {
    expect(collectDiff(
      ["engine/tests/existing.test.ts"],
      fakeDeps({ diffFiles: () => ({ ok: false, error: "git object database unreadable" }) }),
    )).toEqual({
      ok: false,
      error: {
        kind: "git-observation-failed",
        operation: "diff-worktree",
        message: "git object database unreadable",
      },
    });
  });

  it.each([
    [false, "legacy-new-tests-required-false"],
    [{ kind: "waived" as const, reason: "existing-tests-sufficient" as const }, "existing-tests-sufficient"],
  ])("returns waiver evidence directly without touching the diff seam", (requirement, reason) => {
    const evidence = collectNewTestEvidence(
      ["engine/tests/existing.test.ts"],
      requirement,
      undefined,
      fakeDeps({ isTracked: () => { throw new Error("diff seam must not run"); } }),
    );
    expect(evidence).toEqual({
      ok: true,
      value: {
        kind: "not-written",
        written: false,
        evidence: `verification_policy.new_tests waived: ${reason}`,
      },
    });
  });

  it("proves new tests from tracked unstaged worktree changes for every harness", () => {
    const evidence = collectNewTestEvidence(
      ["engine/tests/existing.test.ts"],
      true,
      undefined,
      fakeDeps({
        diffFiles: () => diff([
          "diff --git a/engine/tests/existing.test.ts b/engine/tests/existing.test.ts",
          "--- a/engine/tests/existing.test.ts",
          "+++ b/engine/tests/existing.test.ts",
          "+  it(\"covers the fix\", () => {",
          "+    expect(result).toBe(true);",
          "+  });",
        ].join("\n")),
        diffFilesStaged: () => diff(""),
      }),
    );

    expect(evidence).toEqual({
      ok: true,
      value: {
        kind: "written",
        written: true,
        evidence: "1 new test methods, 1 assertions (ts: 1 it/test/describe)",
      },
    });
  });

  it("proves an attributed test committed after the task start SHA", () => {
    const calls: Array<{ revision: string; files: string[] }> = [];
    const evidence = collectNewTestEvidence(
      ["engine/tests/committed.test.ts"],
      true,
      "a".repeat(40),
      fakeDeps({
        diffFiles: () => diff(""),
        diffFilesStaged: () => diff(""),
        diffFilesSince: (revision, files) => {
          calls.push({ revision, files });
          return diff([
            "diff --git a/engine/tests/committed.test.ts b/engine/tests/committed.test.ts",
            "--- a/engine/tests/committed.test.ts",
            "+++ b/engine/tests/committed.test.ts",
            "+  it(\"survives an agent commit\", () => {",
            "+    expect(result).toBe(true);",
            "+  });",
          ].join("\n"));
        },
      }),
    );

    expect(calls).toEqual([{ revision: "a".repeat(40), files: ["engine/tests/committed.test.ts"] }]);
    expect(evidence).toEqual({
      ok: true,
      value: {
        kind: "written",
        written: true,
        evidence: "1 new test methods, 1 assertions (ts: 1 it/test/describe)",
      },
    });
  });

  it("does not catch unexpected dependency defects", () => {
    expect(() => collectDiff(
      ["engine/tests/existing.test.ts"],
      fakeDeps({ isTracked: () => { throw new TypeError("bad adapter"); } }),
    )).toThrowError(TypeError);
  });
});
