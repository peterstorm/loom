import { describe, expect, it, vi } from "vitest";

/**
 * Process seam only: the real composition under test is
 * `openGitRepository → runGitProbingEmpty → observeGitProbe →
 * confirmedEmptyPassthrough → requireNonEmptyGitOutput`. The scripted spawn
 * (the shared scripted-Git fixture) pins the guard's refusal ORDER (spawn
 * error/signal/status arms first; both probes complete before either
 * emptiness guard evaluates) and its exact operator-facing messages, which no
 * other test observes.
 */
vi.mock("node:child_process", async (importOriginal) =>
  (await import("../fixtures/scripted-git")).scriptedChildProcess(await importOriginal()));

import { openGitRepository } from "../../src/orchestration/git-remediation";
import { answered, failedToStart, scriptedGit, scriptGit } from "../fixtures/scripted-git";

describe("git boundary emptiness-guard ordering", () => {
  it("refuses a confirmed-empty root probe with the guard's exact message after both bounded probes", () => {
    // Both probes run before either guard evaluates: three transient-empty
    // retries for --show-toplevel, three for --absolute-git-dir, THEN the
    // root guard refuses. Six calls, then the exact refusal — never a digest
    // of sha256("").
    scriptGit(Array.from({ length: 6 }, () => answered("")));
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git rev-parse --show-toplevel returned no output");
    expect(scriptedGit.answers).toHaveLength(0);
  });

  it("refuses a confirmed-empty git-dir probe with that guard's exact message", () => {
    // A non-empty root passes its guard, so the git-dir guard's own message
    // is the observable refusal — each guard carries its operation's text.
    scriptGit([answered("/fixture/repo\n"), answered(""), answered(""), answered("")]);
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git rev-parse --absolute-git-dir returned no output");
    expect(scriptedGit.answers).toHaveLength(0);
  });

  it("keeps the spawn-failure arm ahead of the emptiness guard (one attempt, exact message)", () => {
    scriptGit([failedToStart("spawn boom")]);
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git could not start: spawn boom");
    // The error arm fired on the first attempt; the probe never retried it.
    expect(scriptedGit.answers).toHaveLength(0);
  });
});
