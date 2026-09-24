/**
 * Consumer-level pin for the boundary root probe (pta-1).
 *
 * `config.ts` `gitRepositoryRootFrom` composes the canonical bounded
 * empty-stdout retry (`observeGitProbe`) around `git rev-parse
 * --show-toplevel` — the same policy `tests/utils/git-empty-retry.test.ts`
 * pins for the utils/git consumers. This file closes the config gap: a revert
 * of the retry or of the confirmed-empty attribution inside config alone would
 * otherwise pass every suite while a transient empty probe froze a fabricated
 * `root: ""` boundary and a confirmed one was silently ingested the same way.
 *
 * `spawnSync` is scripted, so the status-0/empty-stdout transient is
 * reproduced deterministically — a real repository cannot produce it on
 * demand. The mock falls through to the real spawnSync when the script is
 * empty, so the module-import-time `TASK_GRAPH_PATH` resolution (which probes
 * the real checkout) neither consumes the script nor breaks.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";

const scripted = vi.hoisted(() => ({
  queue: [] as Array<{ status: number; stdout: string; stderr: string }>,
  calls: [] as Array<{ file: string; args: readonly string[]; cwd: string | undefined }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const scriptedSpawnSync = (
    file: string,
    args: readonly string[],
    options?: { cwd?: string },
  ) => {
    scripted.calls.push({ file, args, cwd: options?.cwd });
    const next = scripted.queue.shift();
    if (next === undefined) return actual.spawnSync(file, args, options ?? {});
    return {
      status: next.status,
      stdout: next.stdout,
      stderr: next.stderr,
      signal: null,
      error: undefined,
    } as unknown as ReturnType<typeof actual.spawnSync>;
  };
  return {
    ...actual,
    spawnSync: scriptedSpawnSync as unknown as typeof actual.spawnSync,
  };
});

import { observeTaskGraphProjectBoundary } from "../src/config";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  scripted.queue = [];
  scripted.calls = [];
});

function stateFileIn(dir: string): string {
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify({ current_phase: "execute" }));
  return statePath;
}

describe("config boundary root probe retries the transient empty-stdout Git answer", () => {
  it("recovers the repository root when rev-parse answers empty once, and pins the exact probe sequence", () => {
    const dir = canonicalTempDir("loom-boundary-root-");
    dirs.push(dir);
    const statePath = stateFileIn(dir);
    scripted.queue = [
      { status: 0, stdout: "", stderr: "" },          // the transient empty answer
      { status: 0, stdout: `${dir}\n`, stderr: "" },  // the retried, real root
    ];

    expect(observeTaskGraphProjectBoundary(statePath)).toEqual({
      kind: "git-repository",
      root: dir,
    });
    // The retry consumed the transient; it did not ingest it as `root: ""`.
    expect(scripted.calls).toEqual([
      { file: "git", args: ["rev-parse", "--show-toplevel"], cwd: dir },
      { file: "git", args: ["rev-parse", "--show-toplevel"], cwd: dir },
    ]);
  });

  it("refuses loudly when the root probe stays empty after bounded retries, attributing the confirmed anomaly", () => {
    const dir = canonicalTempDir("loom-boundary-root-");
    dirs.push(dir);
    const statePath = stateFileIn(dir);
    scripted.queue = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];

    let thrown: unknown;
    try {
      observeTaskGraphProjectBoundary(statePath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The refusal names the probed directory and carries the full probe
    // evidence: a confirmed anomaly is thrown, never fabricated into a boundary.
    expect(message).toContain(`git rev-parse returned an empty repository root for ${dir}`);
    expect(message).toContain("confirmed after bounded retries");
    expect(message).toContain("status=0 stdoutLength=0 signal=none");
    // The bounded retry budget was actually spent before the refusal.
    expect(scripted.calls.length).toBe(3);
    for (const call of scripted.calls) {
      expect(call.file).toBe("git");
      expect(call.args).toEqual(["rev-parse", "--show-toplevel"]);
      expect(call.cwd).toBe(dir);
    }
  });
});
