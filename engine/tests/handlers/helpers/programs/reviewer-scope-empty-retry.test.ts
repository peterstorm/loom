/**
 * Consumer-level pin for the reviewer-scope Git observations in
 * handlers/helpers/programs/changed-paths (the standalone-review scope authority).
 *
 * The canonical empty-stdout transient rationale lives at `observeGitProbe`
 * (utils/git-probe); the policy was already enforced at the four other
 * Git-observing families (config root probe, utils/git root/HEAD/diff probes,
 * git-remediation, workspace-digest). This file closes the last gap: a revert
 * of the retry inside changed-paths.ts alone would otherwise freeze a silently
 * reduced review scope (an empty path family or an empty HEAD revision) with
 * no diagnostic, because `parseStandaloneReviewScope` refuses only the
 * all-empty union, never a partially emptied one.
 *
 * Every probe reaches Git through the injected `GitSpawn` port, so each case
 * scripts `GitSpawnOutcome` values with the shared scripted-Git fixture and
 * asserts the LOGICAL argv and run each probe asked for — no
 * `node:child_process` mock. The status-0/empty-stdout transient, a lost
 * fatal diagnostic and an over-budget capture are reproduced
 * deterministically — a real repository produces none of them on demand.
 */

import { describe, expect, it } from "vitest";
import { baselineBlob, deriveChangedPaths, metadata } from "../../../../src/handlers/helpers/programs/changed-paths";
import { GIT_PROBE_OUTPUT_LIMIT } from "../../../../src/utils/git-execution-policy";
import type { GitSpawnOutcome } from "../../../../src/utils/git-spawn-outcome";
import { answered, exited, failedToStart, scriptedGitSpawn, type ScriptedGitCall } from "../../../fixtures/scripted-git";

const SHA = "b".repeat(40);
const BLOB = "c".repeat(40);
const SCOPE_LISTING_LIMIT = 16 * 1024 * 1024;
const BASELINE_BLOB_LIMIT = 64 * 1024 * 1024;

// The changed-shape fixture both numstat rows consume: token-identical in
// every field, so the rows state only what they actually vary — the scripted
// Git answers and the expected additions count (code-simplifier-3).
const numstatChanged = {
  authority: { unstaged: ["src/b.ts"], staged: [], committed: [], base_revision: null, head_revision: SHA },
  untracked: ["src/a.ts"],
  created: new Set(["src/a.ts", "src/b.ts"]),
};

/** The Git command (first logical argument) of each call, in order. */
const commands = (calls: readonly ScriptedGitCall[]): readonly (string | undefined)[] => calls.map(({ args }) => args[0]);
const callsOf = (calls: readonly ScriptedGitCall[], command: string, second?: string): readonly ScriptedGitCall[] =>
  calls.filter(({ args }) => args[0] === command && (second === undefined || args[1] === second));

/** Four candidates, each present with no common base: no committed scope. */
const NO_BASE_CANDIDATES: readonly GitSpawnOutcome[] = [
  answered(SHA), exited(1), answered(SHA), exited(1),
  answered(SHA), exited(1), answered(SHA), exited(1),
];

describe("reviewer scope derivation survives the transient empty-stdout Git observation", () => {
  it("recovers a transient empty HEAD and empty path listing before freezing scope authority", () => {
    const git = scriptedGitSpawn([
      answered(""), answered(SHA), // rev-parse HEAD: transient discharged on attempt 2
      ...NO_BASE_CANDIDATES,
      answered(""), answered("src/a.ts\0"), // ls-files untracked: transient discharged
      answered("src/b.ts\0"), // diff --name-only -z
      answered("src/c.ts\0"), // diff --cached --diff-filter=A
      answered("src/c.ts\0"), // diff --cached --name-only
    ]);
    const changed = deriveChangedPaths(git.spawn);
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
    expect(callsOf(git.calls, "rev-parse", "HEAD")).toHaveLength(2);
    expect(callsOf(git.calls, "ls-files")).toHaveLength(2);
  });

  it("refuses loudly when the HEAD probe stays empty after bounded retries", () => {
    const git = scriptedGitSpawn([answered(""), answered(""), answered("")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/rev-parse HEAD.*empty output after bounded retries/);
    // The whole retry budget was spent before the refusal, and nothing later ran.
    expect(git.calls).toHaveLength(3);
    expect(git.calls.every(({ args }) => args[0] === "rev-parse")).toBe(true);
  });

  it("refuses a confirmed-empty merge-base before omitting committed changes from scope", () => {
    const git = scriptedGitSpawn([answered(SHA), answered(SHA), answered(""), answered(""), answered("")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/merge-base origin\/main.*empty output after bounded retries/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse", "merge-base", "merge-base", "merge-base"]);
  });

  it("refuses a merge-base spawn error before trying another base or omitting committed paths", () => {
    const git = scriptedGitSpawn([
      answered(SHA), answered(SHA), // HEAD and verified candidate reference
      failedToStart("spawn git ENOENT"),
    ]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/merge-base.*could not start.*ENOENT/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("refuses a fatal merge-base exit instead of classifying it as no common ancestor", () => {
    const git = scriptedGitSpawn([answered(SHA), answered(SHA), exited(128, "", "fatal: broken repository")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/fatal: broken repository/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("refuses a diagnostic-bearing exit 1 rather than treating an unobserved error as no base", () => {
    const git = scriptedGitSpawn([answered(SHA), answered(SHA), exited(1, "", "fatal: cannot read object")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/fatal: cannot read object/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse", "merge-base"]);
  });

  it("skips an independently observed missing ref without running merge-base on it", () => {
    const git = scriptedGitSpawn([
      answered(SHA), exited(1), // origin/main does not exist
      answered(SHA), answered(SHA), // origin/master exists and has a base
      answered(""), answered(""), answered(""), // untracked
      answered("src/unstaged.ts\0"),
      answered(""), answered(""), answered(""), // staged-added
      answered("src/committed.ts\0"),
      answered(""), answered(""), answered(""), // staged
      answered("src/committed.ts\0"),
    ]);
    const changed = deriveChangedPaths(git.spawn);
    expect(changed.authority.committed).toEqual(["src/committed.ts"]);
    expect(callsOf(git.calls, "merge-base")).toHaveLength(1);
    expect(callsOf(git.calls, "rev-parse")).toHaveLength(3);
  });

  it("refuses candidate-reference process errors instead of skipping that candidate", () => {
    const git = scriptedGitSpawn([answered(SHA), failedToStart("spawn git ENOENT")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/rev-parse.*could not start.*ENOENT/);
    expect(git.calls).toHaveLength(2);
  });

  it("refuses a confirmed-empty candidate reference before attempting merge-base", () => {
    const git = scriptedGitSpawn([answered(SHA), answered(""), answered(""), answered("")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/candidate origin\/main.*empty output after bounded retries/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse", "rev-parse", "rev-parse"]);
  });

  it("refuses a fatal candidate-reference exit instead of classifying it as a missing ref", () => {
    // Mirrors the merge-base fatal pin: a regression that classifies any
    // non-zero status as a clean absent ref would silently skip the candidate
    // and omit committed branch changes from the frozen scope.
    const git = scriptedGitSpawn([answered(SHA), exited(128, "", "fatal: broken repository")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/fatal: broken repository/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse"]);
  });

  it("refuses a diagnostic-bearing candidate-reference exit 1 rather than treating an unobserved error as a missing ref", () => {
    const git = scriptedGitSpawn([answered(SHA), exited(1, "", "fatal: cannot lock ref")]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(/fatal: cannot lock ref/);
    expect(commands(git.calls)).toEqual(["rev-parse", "rev-parse"]);
  });

  it("continues only for a clean no-common-ancestor result and keeps the next candidate's committed paths", () => {
    const git = scriptedGitSpawn([
      answered(SHA), answered(SHA), exited(1), answered(SHA), answered(SHA),
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered("src/unstaged.ts\0"),
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/committed.ts\0"),
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/committed.ts\0"),
    ]);
    const changed = deriveChangedPaths(git.spawn);
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/committed.ts"]);
    expect(callsOf(git.calls, "merge-base")).toHaveLength(2);
  });

  it("recovers a transient empty merge-base and keeps committed branch paths", () => {
    const git = scriptedGitSpawn([
      answered(SHA), answered(SHA), // HEAD and verified candidate reference
      answered(""), answered(SHA), // merge-base: retry before using a real base
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered(""), answered(""), answered(""), // legitimate empty unstaged listing
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/new.ts\0"), // committed-added listing
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/new.ts\0"), // committed path listing
    ]);
    const changed = deriveChangedPaths(git.spawn);
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/new.ts"]);
    expect(callsOf(git.calls, "merge-base")).toHaveLength(2);
  });

  it("recovers a transient empty candidate reference before observing the merge base", () => {
    // The reference probe is the last Git probe family without a discharge
    // pin: its attempt-2 recovery must observe the real revision, not skip
    // the candidate or run past the scripted answers.
    const git = scriptedGitSpawn([
      answered(SHA), // rev-parse HEAD
      answered(""), answered(SHA), // candidate reference: transient discharged on attempt 2
      answered(SHA), // merge-base observes the real base
      answered(""), answered(""), answered(""), // legitimate empty untracked listing
      answered(""), answered(""), answered(""), // legitimate empty unstaged listing
      answered(""), answered(""), answered(""), // legitimate empty staged-added listing
      answered("src/new.ts\0"), // committed-added listing
      answered(""), answered(""), answered(""), // legitimate empty staged listing
      answered("src/new.ts\0"), // committed path listing
    ]);
    const changed = deriveChangedPaths(git.spawn);
    expect(changed.authority.base_revision).toBe(SHA);
    expect(changed.authority.committed).toEqual(["src/new.ts"]);
    expect(callsOf(git.calls, "rev-parse", "--verify")).toHaveLength(2);
    expect(callsOf(git.calls, "merge-base")).toHaveLength(1);
  });

  it("accepts a confirmed-empty path listing as the explicit legitimate-empty decision", () => {
    const git = scriptedGitSpawn([
      answered(SHA), // rev-parse HEAD observed first try
      ...NO_BASE_CANDIDATES,
      answered(""), answered(""), answered(""), // ls-files stays empty: legitimate
      answered("src/b.ts\0"),
      answered("src/c.ts\0"),
      answered("src/c.ts\0"),
    ]);
    const changed = deriveChangedPaths(git.spawn);
    expect(changed.authority.head_revision).toBe(SHA);
    expect(changed.untracked).toEqual([]);
    expect(changed.authority.unstaged).toEqual(["src/b.ts"]);
    // The caller decision was reached only after the full retry budget.
    expect(callsOf(git.calls, "ls-files")).toHaveLength(3);
  });

  it("recovers transient empty numstat observations before counting additions for reviewer selection", () => {
    const git = scriptedGitSpawn([
      answered(""), answered("1\t0\tsrc/b.ts\n"), // tracked numstat transient discharged
      answered(""), answered("3\t0\tsrc/a.ts\n"), // untracked numstat transient discharged
    ]);
    const reviewMetadata = metadata("all", ["src/a.ts", "src/b.ts"], numstatChanged, git.spawn);
    expect(reviewMetadata.additions).toBe(4);
    expect(callsOf(git.calls, "diff", "--numstat")).toHaveLength(2);
  });

  it("counts zero tracked additions when numstat legitimately stays empty after bounded retries", () => {
    const git = scriptedGitSpawn([answered(""), answered(""), answered("")]);
    const reviewMetadata = metadata("all", ["src/b.ts"], numstatChanged, git.spawn);
    expect(reviewMetadata.additions).toBe(0);
    expect(git.calls).toHaveLength(3);
  });

  it("refuses confirmed-empty untracked numstat before using zero for reviewer selection", () => {
    const git = scriptedGitSpawn([
      answered("2\t0\tsrc/b.ts\n"), // tracked additions observed
      answered(""), answered(""), answered(""), // untracked numstat: impossible empty result
    ]);
    expect(() => metadata("code", ["src/a.ts", "src/b.ts"], numstatChanged, git.spawn))
      .toThrow(/cannot measure untracked additions for src\/a.ts.*empty output after bounded retries/);
    expect(git.calls).toHaveLength(4);
  });
});

describe("reviewer scope probes read each status protocol and refuse every other ending", () => {
  it("asks each probe for its own output budget: scope listings, ref answers and baseline blobs", () => {
    const scope = scriptedGitSpawn([answered(SHA), ...NO_BASE_CANDIDATES, answered(""), answered(""), answered(""),
      answered("src/b.ts\0"), answered("src/c.ts\0"), answered("src/c.ts\0")]);
    deriveChangedPaths(scope.spawn);
    expect(scope.calls.map(({ run }) => run)).toEqual([
      { maxBuffer: SCOPE_LISTING_LIMIT }, // rev-parse HEAD is text authority
      ...Array.from({ length: 8 }, () => ({ maxBuffer: GIT_PROBE_OUTPUT_LIMIT })), // candidate refs and merge bases
      ...Array.from({ length: 6 }, () => ({ maxBuffer: SCOPE_LISTING_LIMIT })), // path listings, retries included
    ]);

    const blob = scriptedGitSpawn([answered(`100644 blob ${BLOB}\ta.txt\0`), answered("hello\n")]);
    expect(Buffer.from(baselineBlob(SHA, "a.txt", blob.spawn) ?? []).toString("utf-8")).toBe("hello\n");
    expect(blob.calls).toEqual([
      { args: ["ls-tree", "-z", "--full-tree", SHA, "--", "a.txt"], run: { maxBuffer: GIT_PROBE_OUTPUT_LIMIT } },
      { args: ["cat-file", "blob", BLOB], run: { maxBuffer: BASELINE_BLOB_LIMIT } },
    ]);
  });

  it("accepts the no-index numstat's status 1 as an answer, and refuses it when Git also wrote a diagnostic", () => {
    const counted = scriptedGitSpawn([exited(1, "5\t0\tsrc/a.ts\n")]);
    expect(metadata("all", ["src/a.ts"], numstatChanged, counted.spawn).additions).toBe(5);
    expect(counted.calls[0]!.args).toEqual(["diff", "--no-index", "--numstat", "--", "/dev/null", "src/a.ts"]);

    const warned = scriptedGitSpawn([exited(1, "5\t0\tsrc/a.ts\n", "warning: CRLF will be replaced")]);
    expect(() => metadata("all", ["src/a.ts"], numstatChanged, warned.spawn)).toThrow("warning: CRLF will be replaced");

    const fatal = scriptedGitSpawn([exited(2)]);
    expect(() => metadata("all", ["src/a.ts"], numstatChanged, fatal.spawn))
      .toThrow("cannot measure untracked additions for src/a.ts (exited 2: stderr empty, stdout 0 bytes)");
  });

  it("refuses a status-0-only probe's status 1, naming the probe and the rendered exit", () => {
    const git = scriptedGitSpawn([exited(1)]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow("git rev-parse failed (exited 1: stderr empty, stdout 0 bytes)");
    expect(git.calls).toHaveLength(1);
  });

  it("names a fatal exit whose stderr arrived empty as a lost capture, never as Git's answer", () => {
    const head = scriptedGitSpawn([exited(128)]);
    expect(() => deriveChangedPaths(head.spawn)).toThrow(
      "git rev-parse failed (exited 128: stderr empty, stdout 0 bytes — Git writes a diagnostic for every fatal exit, " +
      "so the child's stderr was lost before it reached the engine)",
    );
    // A silent fatal candidate probe is a refusal too — never a missing ref.
    const candidate = scriptedGitSpawn([answered(SHA), exited(128)]);
    expect(() => deriveChangedPaths(candidate.spawn)).toThrow(/git cannot observe candidate origin\/main \(exited 128: .*stderr was lost/);
  });

  it.each<[string, GitSpawnOutcome, string]>([
    ["an over-budget capture", { kind: "over-budget", maxBuffer: SCOPE_LISTING_LIMIT, stdout: Buffer.alloc(8), stderr: Buffer.alloc(0) },
      `git rev-parse exceeded its ${SCOPE_LISTING_LIMIT}-byte output budget`],
    ["a signalled child", { kind: "signalled", signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      "git rev-parse terminated on signal SIGKILL"],
    ["a timed-out child", { kind: "timed-out", timeoutMs: 50, signal: "SIGTERM", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      "git rev-parse timed out after 50 ms"],
    ["a child that never started", failedToStart("spawn git ENOENT", "ENOENT"), "git rev-parse could not start: spawn git ENOENT"],
  ])("refuses %s with its rendered outcome on the first attempt", (_label, outcome, expected) => {
    const git = scriptedGitSpawn([outcome]);
    expect(() => deriveChangedPaths(git.spawn)).toThrow(expected);
    expect(git.calls).toHaveLength(1);
  });

  it("refuses an over-budget baseline blob instead of handing back truncated bytes", () => {
    const git = scriptedGitSpawn([
      answered(`100644 blob ${BLOB}\ta.txt\0`),
      { kind: "over-budget", maxBuffer: BASELINE_BLOB_LIMIT, stdout: Buffer.from("trunc"), stderr: Buffer.alloc(0) },
    ]);
    expect(() => baselineBlob(SHA, "a.txt", git.spawn)).toThrow(`git cat-file exceeded its ${BASELINE_BLOB_LIMIT}-byte output budget`);
  });

  it("reads a baseline's absence from an empty ls-tree listing only after the bounded retries", () => {
    const git = scriptedGitSpawn([answered(""), answered(""), answered("")]);
    expect(baselineBlob(SHA, "missing.txt", git.spawn)).toBeNull();
    expect(commands(git.calls)).toEqual(["ls-tree", "ls-tree", "ls-tree"]);
  });
});
