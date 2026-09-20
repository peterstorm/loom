import { describe, expect, it, vi } from "vitest";

/**
 * Process seam only: the real composition under test is
 * `openGitRepository → runGitProbingEmpty → observeGitProbe →
 * confirmedEmptyPassthrough → requireNonEmptyGitOutput`. The scripted spawn
 * pins the guard's refusal ORDER (spawn error/signal/status arms first; both
 * probes complete before either emptiness guard evaluates) and its exact
 * operator-facing messages, which no other test observes.
 */
const script = vi.hoisted(() => ({ responses: [] as unknown[] }));
vi.mock("node:child_process", () => ({
  spawnSync: () => {
    const next = script.responses.shift();
    if (next === undefined) throw new Error("scripted git spawn exhausted");
    return next;
  },
}));

import { openGitRepository } from "../../src/orchestration/git-remediation";

type SpawnShape = {
  error: Error | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
};

const spawnResult = (
  overrides: Partial<SpawnShape> = {},
): SpawnShape => ({
  error: null,
  status: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  ...overrides,
});

const empty = (): SpawnShape => spawnResult();
const output = (text: string): SpawnShape => spawnResult({ stdout: Buffer.from(text) });

describe("git boundary emptiness-guard ordering", () => {
  it("refuses a confirmed-empty root probe with the guard's exact message after both bounded probes", () => {
    // Both probes run before either guard evaluates: three transient-empty
    // retries for --show-toplevel, three for --absolute-git-dir, THEN the
    // root guard refuses. Six calls, then the exact refusal — never a digest
    // of sha256("").
    script.responses = [empty(), empty(), empty(), empty(), empty(), empty()];
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git rev-parse --show-toplevel returned no output");
    expect(script.responses).toHaveLength(0);
  });

  it("refuses a confirmed-empty git-dir probe with that guard's exact message", () => {
    // A non-empty root passes its guard, so the git-dir guard's own message
    // is the observable refusal — each guard carries its operation's text.
    script.responses = [output("/fixture/repo\n"), empty(), empty(), empty()];
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git rev-parse --absolute-git-dir returned no output");
    expect(script.responses).toHaveLength(0);
  });

  it("keeps the spawn-failure arm ahead of the emptiness guard (one attempt, exact message)", () => {
    script.responses = [spawnResult({ error: new Error("spawn boom") })];
    const opened = openGitRepository("/fixture/repo");
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected refusal");
    expect(opened.error.operation).toBe("rev-parse");
    expect(opened.error.message).toBe("git could not be run: spawn boom");
    // The error arm fired on the first attempt; the probe never retried it.
    expect(script.responses).toHaveLength(0);
  });
});
