/**
 * Consumer-level pin for the reviewer-scope Git observations in
 * handlers/helpers/programs/helpers (the standalone-review scope authority).
 *
 * The canonical empty-stdout transient rationale lives at `observeGitProbe`
 * (utils/git-probe); the policy was already enforced at the four other
 * Git-observing families (config root probe, utils/git root/HEAD/diff probes,
 * git-remediation, workspace-digest). This file closes the last gap: a revert
 * of the retry inside helpers.ts alone would otherwise freeze a silently
 * reduced review scope (an empty path family or an empty HEAD revision) with
 * no diagnostic, because `parseStandaloneReviewScope` refuses only the
 * all-empty union, never a partially emptied one.
 *
 * `spawnSync` is scripted, so the status-0/empty-stdout transient is
 * reproduced deterministically — a real repository cannot produce it on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptedResponses: { queue: SpawnAnswer[]; calls: string[][] } = vi.hoisted(() => ({
  queue: [] as SpawnAnswer[],
  calls: [] as string[][],
}));

type SpawnAnswer = {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
};

const answered = (stdout: string): SpawnAnswer => ({ status: 0, stdout, stderr: "" });
const failedWith = (status: number): SpawnAnswer => ({ status, stdout: "", stderr: "" });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (file: string, args: readonly string[]) => {
      scriptedResponses.calls.push([file, ...args]);
      const next = scriptedResponses.queue.shift();
      if (next === undefined) throw new Error("fixture ran past its scripted Git responses");
      return next;
    },
  };
});

import { deriveChangedPaths, metadata } from "../../../../src/handlers/helpers/programs/helpers";

const SHA = "b".repeat(40);

// The changed-shape fixture both numstat rows consume: token-identical in
// every field, so the rows state only what they actually vary — the scripted
// spawnSync queue and the expected additions count (code-simplifier-3).
const numstatChanged = {
  authority: { unstaged: ["src/b.ts"], staged: [], committed: [], base_revision: null, head_revision: SHA },
  untracked: ["src/a.ts"],
  created: new Set(["src/a.ts", "src/b.ts"]),
};

beforeEach(() => {
  scriptedResponses.queue = [];
  scriptedResponses.calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewer scope derivation survives the transient empty-stdout Git observation", () => {
  it("recovers a transient empty HEAD and empty path listing before freezing scope authority", () => {
    scriptedResponses.queue = [
      answered(""), answered(SHA), // rev-parse HEAD: transient discharged on attempt 2
      answered(SHA), failedWith(1), answered(SHA), failedWith(1), // first two candidates: present, no base
      answered(SHA), failedWith(1), answered(SHA), failedWith(1), // next two candidates: present, no base
      answered(""), answered("src/a.ts\0"), // ls-files untracked: transient discharged
      answered("src/b.ts\0"), // diff --name-only -z
      answered("src/c.ts\0"), // diff --cached --diff-filter=A
      answered("src/c.ts\0"), // diff --cached --name-only
    ];
    const changed = deriveChangedPaths();
    // The unstaged authority is the union of tracked-unstaged and untracked paths.
    expect(changed.authority).toEqual({
      unstaged: ["src/a.ts", "src/b.ts"],
      staged: ["src/c.ts"],
      committed: [],
      base_revision: null,
      head_revision: SHA,
    });
    expect(changed.untracked).toEqual(["src/a.ts"]);
    // The retry consumed the transients; it did not ingest them.
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "rev-parse" && entry[2] === "HEAD")).toHaveLength(2);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "ls-files")).toHaveLength(2);
  });

  it("refuses loudly when the HEAD probe stays empty after bounded retries", () => {
    scriptedResponses.queue = [answered(""), answered(""), answered("")];
    expect(() => deriveChangedPaths()).toThrow(/rev-parse HEAD.*empty output after bounded retries/);
    // The whole retry budget was spent before the refusal, and nothing later ran.
    expect(scriptedResponses.calls).toHaveLength(3);
    expect(scriptedResponses.calls.every((entry) => entry[1] === "rev-parse")).toBe(true);
  });

  it("refuses a confirmed-empty merge-base before omitting committed changes from scope", () => {
    scriptedResponses.queue = [answered(SHA), answered(SHA), answered(""), answered(""), answered("")];
    expect(() => deriveChangedPaths()).toThrow(/merge-base origin\/main.*empty output after bounded retries/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual([
      "rev-parse", "rev-parse", "merge-base", "merge-base", "merge-base",
    ]);
  });

  it("refuses a merge-base spawn error before trying another base or omitting committed paths", () => {
    scriptedResponses.queue = [
      answered(SHA), answered(SHA), // HEAD and verified candidate reference
      { error: new Error("spawn git ENOENT"), status: null, stdout: "", stderr: "" },
    ];
    expect(() => deriveChangedPaths()).toThrow(/merge-base.*could not be spawned.*ENOENT/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("refuses a fatal merge-base exit instead of classifying it as no common ancestor", () => {
    scriptedResponses.queue = [answered(SHA), answered(SHA), { status: 128, stdout: "", stderr: "fatal: broken repository" }];
    expect(() => deriveChangedPaths()).toThrow(/fatal: broken repository/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("refuses a diagnostic-bearing exit 1 rather than treating an unobserved error as no base", () => {
    scriptedResponses.queue = [answered(SHA), answered(SHA), { status: 1, stdout: "", stderr: "fatal: cannot read object" }];
    expect(() => deriveChangedPaths()).toThrow(/fatal: cannot read object/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("skips an independently observed missing ref without running merge-base on it", () => {
    scriptedResponses.queue = [
      answered(SHA), failedWith(1), // origin/main does not exist
      answered(SHA), answered(SHA), // origin/master exists and has a base
      answered(""), answered(""), answered(""), // untracked
      answered("src/unstaged.ts\0"),
      answered(""), answered(""), answered(""), // staged-added
      answered("src/committed.ts\0"),
      answered(""), answered(""), answered(""), // staged
      answered("src/committed.ts\0"),
    ];
    const changed = deriveChangedPaths();
    expect(changed.authority.committed).toEqual(["src/committed.ts"]);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "merge-base")).toHaveLength(1);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "rev-parse")).toHaveLength(3);
  });

  it("refuses candidate-reference process errors instead of skipping that candidate", () => {
    scriptedResponses.queue = [
      answered(SHA), { error: new Error("spawn git ENOENT"), status: null, stdout: "", stderr: "" },
    ];
    expect(() => deriveChangedPaths()).toThrow(/rev-parse.*could not be spawned.*ENOENT/);
    expect(scriptedResponses.calls).toHaveLength(2);
  });

  it("refuses a confirmed-empty candidate reference before attempting merge-base", () => {
    scriptedResponses.queue = [answered(SHA), answered(""), answered(""), answered("")];
    expect(() => deriveChangedPaths()).toThrow(/candidate origin\/main.*empty output after bounded retries/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse", "rev-parse", "rev-parse"]);
  });

  it("refuses a fatal candidate-reference exit instead of classifying it as a missing ref", () => {
    // Mirrors the merge-base fatal pin: a regression that classifies any
    // non-zero status as a clean absent ref would silently skip the candidate
    // and omit committed branch changes from the frozen scope.
    scriptedResponses.queue = [answered(SHA), { status: 128, stdout: "", stderr: "fatal: broken repository" }];
    expect(() => deriveChangedPaths()).toThrow(/fatal: broken repository/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse"]);
  });

  it("refuses a diagnostic-bearing candidate-reference exit 1 rather than treating an unobserved error as a missing ref", () => {
    scriptedResponses.queue = [answered(SHA), { status: 1, stdout: "", stderr: "fatal: cannot lock ref" }];
    expect(() => deriveChangedPaths()).toThrow(/fatal: cannot lock ref/);
    expect(scriptedResponses.calls.map((entry) => entry[1])).toEqual(["rev-parse", "rev-parse"]);
  });

  it("continues only for a clean no-common-ancestor result and keeps the next candidate's committed paths", () => {
    scriptedResponses.queue = [
      answered(SHA), answered(SHA), failedWith(1), answered(SHA), answered(SHA),
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered("src/unstaged.ts\0"),
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/committed.ts\0"),
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/committed.ts\0"),
    ];
    const changed = deriveChangedPaths();
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/committed.ts"]);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "merge-base")).toHaveLength(2);
  });

  it("recovers a transient empty merge-base and keeps committed branch paths", () => {
    scriptedResponses.queue = [
      answered(SHA), answered(SHA), // HEAD and verified candidate reference
      answered(""), answered(SHA), // merge-base: retry before using a real base
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered(""), answered(""), answered(""), // legitimate empty unstaged listing
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/new.ts\0"), // committed-added listing
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/new.ts\0"), // committed path listing
    ];
    const changed = deriveChangedPaths();
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/new.ts"]);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "merge-base")).toHaveLength(2);
  });

  it("recovers a transient empty candidate reference before observing the merge base", () => {
    // The reference probe is the last Git probe family without a discharge
    // pin: its attempt-2 recovery must observe the real revision, not skip
    // the candidate or run past the scripted queue.
    scriptedResponses.queue = [
      answered(SHA), // rev-parse HEAD
      answered(""), answered(SHA), // candidate reference: transient discharged on attempt 2
      answered(SHA), // merge-base observes the real base
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered(""), answered(""), answered(""), // legitimate empty unstaged listing
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/new.ts\0"), // committed-added listing
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/new.ts\0"), // committed path listing
    ];
    const changed = deriveChangedPaths();
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/new.ts"]);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "rev-parse" && entry[2] === "--verify")).toHaveLength(2);
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "merge-base")).toHaveLength(1);
  });

  it("accepts a confirmed-empty path listing as the explicit legitimate-empty decision", () => {
    scriptedResponses.queue = [
      answered(SHA), // rev-parse HEAD observed first try
      answered(SHA), failedWith(1), answered(SHA), failedWith(1),
      answered(SHA), failedWith(1), answered(SHA), failedWith(1),
      answered(""), answered(""), answered(""), // ls-files stays empty: legitimate
      answered("src/b.ts\0"),
      answered("src/c.ts\0"),
      answered("src/c.ts\0"),
    ];
    const changed = deriveChangedPaths();
    expect(changed.authority.head_revision).toBe(SHA);
    expect(changed.untracked).toEqual([]);
    expect(changed.authority.unstaged).toEqual(["src/b.ts"]);
    // The caller decision was reached only after the full retry budget.
    expect(scriptedResponses.calls.filter((entry) => entry[1] === "ls-files")).toHaveLength(3);
  });

  it("recovers transient empty numstat observations before counting additions for reviewer selection", () => {
    scriptedResponses.queue = [
      answered(""), answered("1\t0\tsrc/b.ts\n"), // tracked numstat transient discharged
      answered(""), answered("3\t0\tsrc/a.ts\n"), // untracked numstat transient discharged
    ];
    const reviewMetadata = metadata("all", ["src/a.ts", "src/b.ts"], numstatChanged);
    expect(reviewMetadata.additions).toBe(4);
    expect(scriptedResponses.calls.filter((entry) => entry[2] === "--numstat")).toHaveLength(2);
  });

  it("counts zero tracked additions when numstat legitimately stays empty after bounded retries", () => {
    scriptedResponses.queue = [answered(""), answered(""), answered("")];
    const reviewMetadata = metadata("all", ["src/b.ts"], numstatChanged);
    expect(reviewMetadata.additions).toBe(0);
    expect(scriptedResponses.calls).toHaveLength(3);
  });

  it("refuses confirmed-empty untracked numstat before using zero for reviewer selection", () => {
    scriptedResponses.queue = [
      answered("2\t0\tsrc/b.ts\n"), // tracked additions observed
      answered(""), answered(""), answered(""), // untracked numstat: impossible empty result
    ];
    expect(() => metadata("code", ["src/a.ts", "src/b.ts"], numstatChanged))
      .toThrow(/cannot measure untracked additions for src\/a.ts.*empty output after bounded retries/);
    expect(scriptedResponses.calls).toHaveLength(4);
  });
});
