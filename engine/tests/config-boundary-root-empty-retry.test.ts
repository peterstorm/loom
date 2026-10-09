/**
 * Consumer-level pin for the boundary root probe (pta-1).
 *
 * `config.ts` `gitRepositoryRootFrom` composes the canonical bounded retry
 * (`observeGitProbe`) around `git rev-parse --show-toplevel` — the same policy
 * `tests/utils/git-empty-retry.test.ts` pins for the utils/git consumers. This
 * file closes the config gap: a revert of the retry or of the confirmed-empty
 * attribution inside config alone would otherwise pass every suite while a
 * transient empty probe froze a fabricated `root: ""` boundary and a confirmed
 * one was silently ingested the same way.
 *
 * The probe reaches Git through the injected `GitSpawn` port, so each case
 * scripts `GitSpawnOutcome` values with the shared scripted-Git fixture and
 * asserts the LOGICAL argv the probe asked for — no `node:child_process` mock
 * and no knowledge of the execution policy's private argv prefix. Two transients are reproduced
 * deterministically, since a real repository produces neither on demand: a
 * status-0 empty root, and a fatal exit whose stderr arrived empty.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeTaskGraphProjectBoundary } from "../src/config";
import { GIT_PROBE_OUTPUT_LIMIT } from "../src/utils/git-execution-policy";
import type { GitSpawnOutcome } from "../src/utils/git-spawn-outcome";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";
import { exited, scriptedGitSpawn, type ScriptedGitCall } from "./fixtures/scripted-git";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDirectory(): Readonly<{ dir: string; statePath: string }> {
  const dir = canonicalTempDir("loom-boundary-root-");
  dirs.push(dir);
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify({ current_phase: "execute" }));
  return { dir, statePath };
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected the boundary probe to throw");
}

const ROOT_PROBE = ["rev-parse", "--show-toplevel"];
/** The one call the root probe makes per attempt: the probed directory, under the probe budget. */
const probeCall = (dir: string): ScriptedGitCall => ({ args: ROOT_PROBE, run: { cwd: dir, maxBuffer: GIT_PROBE_OUTPUT_LIMIT } });
const NOT_A_REPOSITORY = "fatal: not a git repository (or any of the parent directories): .git\n";

describe("config boundary root probe retries the transient empty-stdout Git answer", () => {
  it("recovers the repository root when rev-parse answers empty once, and pins the exact probe sequence", () => {
    const { dir, statePath } = stateDirectory();
    const script = scriptedGitSpawn([
      exited(0, ""), // the transient empty answer
      exited(0, `${dir}\n`), // the retried, real root
    ]);

    expect(observeTaskGraphProjectBoundary(statePath, script.spawn)).toEqual({ kind: "git-repository", root: dir });
    // The retry consumed the transient; it did not ingest it as `root: ""`.
    expect(script.calls).toEqual([probeCall(dir), probeCall(dir)]);
  });

  it("refuses loudly when the root probe stays empty after bounded retries, attributing the confirmed anomaly", () => {
    const { dir, statePath } = stateDirectory();
    const script = scriptedGitSpawn([exited(0, ""), exited(0, ""), exited(0, "")]);

    const message = thrownMessage(() => observeTaskGraphProjectBoundary(statePath, script.spawn));
    // The refusal names the probed directory and carries the full probe
    // evidence: a confirmed anomaly is thrown, never fabricated into a boundary.
    expect(message).toContain(`git rev-parse returned an empty repository root for ${dir}`);
    expect(message).toContain("confirmed after bounded retries");
    expect(message).toContain("status=0 stdoutLength=0 signal=none");
    // The bounded retry budget was actually spent before the refusal.
    expect(script.calls).toEqual(Array.from({ length: 3 }, () => probeCall(dir)));
  });
});

describe("config boundary root probe never mistakes a lost diagnostic for Git's answer", () => {
  it("re-observes a fatal exit whose stderr arrived empty and classifies the real not-a-repository answer", () => {
    const { dir, statePath } = stateDirectory();
    const script = scriptedGitSpawn([exited(128, ""), exited(128, "", NOT_A_REPOSITORY)]);

    // The canonical temp directory has no repository metadata above it, so
    // the recovered diagnostic proves a non-repository: the layout fallback.
    expect(observeTaskGraphProjectBoundary(statePath, script.spawn)).toMatchObject({ kind: "state-layout" });
    expect(script.calls).toEqual([probeCall(dir), probeCall(dir)]);
  });

  it("refuses Git's not-a-repository answer when repository metadata exists, once the retry recovered it", () => {
    const { dir, statePath } = stateDirectory();
    mkdirSync(join(dir, ".git"));
    const script = scriptedGitSpawn([exited(128, ""), exited(128, "", NOT_A_REPOSITORY)]);

    expect(thrownMessage(() => observeTaskGraphProjectBoundary(statePath, script.spawn)))
      .toBe(`git reported no repository, but repository metadata exists at ${join(dir, ".git")}`);
    // The filesystem proof checks the classified answer once; it is not a retried step.
    expect(script.calls).toEqual([probeCall(dir), probeCall(dir)]);
  });

  it("refuses a fatal exit that stays silent after bounded retries, naming the lost capture", () => {
    const { dir, statePath } = stateDirectory();
    const script = scriptedGitSpawn([exited(128, ""), exited(128, ""), exited(128, "")]);

    expect(thrownMessage(() => observeTaskGraphProjectBoundary(statePath, script.spawn))).toBe(
      `git rev-parse failed (exited 128) for ${dir} (confirmed after bounded retries): stderr empty, stdout 0 bytes — ` +
      "Git writes a diagnostic for every fatal exit, so the child's stderr was lost before it reached the engine",
    );
    expect(script.calls).toHaveLength(3);
  });

  it("surfaces Git's own dubious-ownership diagnostic on the first attempt, without retrying it", () => {
    const { dir, statePath } = stateDirectory();
    const dubious = "fatal: detected dubious ownership in repository at '/srv/repo'\n" +
      "To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/repo";
    const script = scriptedGitSpawn([exited(128, "", dubious)]);

    expect(thrownMessage(() => observeTaskGraphProjectBoundary(statePath, script.spawn)))
      .toBe(`git rev-parse failed (exited 128) for ${dir}: ${dubious}`);
    expect(script.calls).toHaveLength(1);
  });

  it.each<[string, GitSpawnOutcome, (dir: string) => string]>([
    ["a child that never started", { kind: "spawn-failed", code: "ENOENT", message: "spawn git ENOENT" },
      () => "git rev-parse could not start: spawn git ENOENT"],
    ["a child whose spawn faulted mid-run",
      { kind: "faulted", code: "EIO", message: "spawnSync git EIO", status: 128, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: partial\n") },
      (dir) => `git rev-parse failed (exited 128 after a spawn fault (spawnSync git EIO)) for ${dir}: fatal: partial`],
    ["a signalled child", { kind: "signalled", signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      (dir) => `git rev-parse failed (terminated on signal SIGKILL) for ${dir}`],
    ["an over-budget capture", { kind: "over-budget", maxBuffer: 1024, stdout: Buffer.alloc(2048), stderr: Buffer.alloc(0) },
      (dir) => `git rev-parse failed (exceeded its 1024-byte output budget) for ${dir}`],
  ])("refuses %s with its rendered outcome on the first attempt", (_label, outcome, expected) => {
    const { dir, statePath } = stateDirectory();
    const script = scriptedGitSpawn([outcome]);

    expect(thrownMessage(() => observeTaskGraphProjectBoundary(statePath, script.spawn))).toBe(expected(dir));
    expect(script.calls).toHaveLength(1);
  });
});
