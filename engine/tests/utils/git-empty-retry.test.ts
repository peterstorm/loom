/**
 * Consumer-level pin for `probeGitWithEmptyRetry` in utils/git (pta-3).
 *
 * The shared retry primitive's semantics are pinned in tests/utils/git-probe.test.ts,
 * and two of its three consumers (workspace-digest, git-remediation) pin their
 * own guards. This file closes the third gap: a revert of the retry inside
 * utils/git alone would otherwise pass every suite while an empty root or HEAD
 * observation flows into the caller as a fabricated value.
 *
 * `execFileSync` is scripted, so the status-0/empty-stdout transient is
 * reproduced deterministically — a real repository cannot produce it on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptedResponses: { queue: string[]; calls: string[][] } = vi.hoisted(() => ({
  queue: [] as string[],
  calls: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[]) => {
      scriptedResponses.calls.push([file, ...args]);
      const next = scriptedResponses.queue.shift();
      if (next === undefined) throw new Error("fixture ran past its scripted Git responses");
      return next;
    },
  };
});

import { observeExactHead, repositoryContext } from "../../src/utils/git";

const SHA = "a".repeat(40);
const ROOT = "/fixture/repo";

beforeEach(() => {
  scriptedResponses.queue = [];
  scriptedResponses.calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("utils/git consumer retry of the transient empty-stdout Git probe", () => {
  it("recovers when the root probe answers empty once and pins the exact probe sequence", () => {
    scriptedResponses.queue = ["", ROOT, SHA];
    const observed = repositoryContext(ROOT);
    expect(observed).toEqual({ ok: true, root: ROOT, headSha: SHA });
    // Three probes ran: the empty root answer was retried, and HEAD was then
    // observed against the recovered root — the retry consumed the transient,
    // it did not ingest it.
    expect(scriptedResponses.calls).toEqual([
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--verify", "HEAD"],
    ]);
  });

  it("refuses loudly when the root probe stays empty after bounded retries", () => {
    scriptedResponses.queue = ["", "", "", "", ""];
    const observed = repositoryContext(ROOT);
    expect(observed.ok).toBe(false);
    if (!observed.ok) {
      expect(observed.error).toContain("cannot resolve repository root and HEAD");
      expect(observed.error).toContain("returned empty output after bounded retries");
    }
    // The retry budget was actually spent before the refusal.
    expect(scriptedResponses.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("recovers the exact HEAD probe through the same bounded retry", () => {
    scriptedResponses.queue = ["", SHA];
    const observed = observeExactHead(ROOT);
    expect(observed).toEqual({ ok: true, headSha: SHA });
    expect(scriptedResponses.calls).toEqual([
      ["git", "rev-parse", "--verify", "HEAD"],
      ["git", "rev-parse", "--verify", "HEAD"],
    ]);
  });

  it("refuses loudly when the HEAD probe stays empty after bounded retries", () => {
    scriptedResponses.queue = ["", "", "", ""];
    const observed = observeExactHead(ROOT);
    expect(observed.ok).toBe(false);
    if (!observed.ok) {
      expect(observed.error).toContain("cannot read Git HEAD");
      expect(observed.error).toContain("returned empty output after bounded retries");
    }
    expect(scriptedResponses.calls.length).toBeGreaterThanOrEqual(3);
  });
});
