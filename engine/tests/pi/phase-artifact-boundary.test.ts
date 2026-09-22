/**
 * Phase-artifact observation is anchored to the TaskGraph's project boundary,
 * never to process.cwd() (D5).
 *
 * Artifacts are stored project-relative. A runtime may be rooted in a
 * different checkout than the run it advances — a Pi parent session in the
 * main checkout whose graph (and spec/plan artifacts) live in a linked
 * worktree. Probing `.claude/specs/...` against cwd searched the wrong
 * repository and phase advancement refused with "artifact was not found",
 * dead-ending the run. These tests pin the boundary anchoring through BOTH
 * appliers, from a process whose cwd is deliberately elsewhere.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeTaskGraphProjectBoundary } from "../../src/config";
import { resolveTransition, projectRootForStateFile } from "../../src/handlers/subagent-stop/advance-phase";
import {
  applyPhaseAgentPiResult,
  type TaskGraphStore,
} from "../../../pi/subagent-result";
import { parseTaskGraph, type ParsedTaskGraph } from "../../src/state-manager";
import type { Phase, TaskGraph } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const cleanup: string[] = [];
const trackedTempDir = (prefix: string): string => {
  const directory = canonicalTempDir(prefix);
  cleanup.push(directory);
  return directory;
};
const elsewhere = (): string => trackedTempDir("loom-phase-boundary-cwd-");
const tempRoot = (): string => trackedTempDir("loom-phase-boundary-");

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("phase artifacts resolve against the graph's project boundary, not cwd", () => {
  it("projectRootForStateFile derives the .claude-owning root from the state path", () => {
    expect(projectRootForStateFile(join("/repo", ".claude", "state", "active_task_graph.json"))).toBe("/repo");
    expect(projectRootForStateFile(join("/repo", ".pi", "state", "active_task_graph.json"))).toBe("/repo");
    expect(projectRootForStateFile("/repo/active_task_graph.json")).toBe("/repo");
  });

  it("retains a relative nested override's Git boundary after cwd changes", () => {
    const root = tempRoot();
    const cwd = elsewhere();
    const statePath = join(root, "custom", "state.json");
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(statePath, "{}\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const previousCwd = process.cwd();
    const previousOverride = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = "custom/state.json";
    process.chdir(cwd);
    try {
      expect(observeTaskGraphProjectBoundary(statePath)).toEqual({
        kind: "git-repository",
        root,
      });
    } finally {
      process.chdir(previousCwd);
      if (previousOverride === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previousOverride;
    }
  });

  it("advance-phase observes brainstorm artifacts under an explicit boundary while cwd is elsewhere", () => {
    const root = tempRoot();
    const cwd = elsewhere();
    const specDir = ".claude/specs/run";
    mkdirSync(join(root, specDir), { recursive: true });
    writeFileSync(join(root, specDir, "brainstorm.md"), "# Brainstorm\n");
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const state = {
        current_phase: "init",
        phase_artifacts: {},
        skipped_phases: [],
        spec_file: null,
        plan_file: null,
        spec_dir: specDir,
        tasks: [],
        wave_gates: {},
      } as unknown as TaskGraph;

      // The boundary-anchored observation finds the artifact the cwd-anchored
      // one cannot see.
      expect(resolveTransition("brainstorm", state, root)).toEqual({
        kind: "ready",
        nextPhase: "specify",
        artifact: join(specDir, "brainstorm.md"),
      });
      // The compatibility default (cwd) refuses — the exact failure the
      // worktree scenario produced.
      expect(resolveTransition("brainstorm", state).kind).toBe("not-ready");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("refuses an absolute persisted spec_dir from the runtime checkout", () => {
    const graphRoot = tempRoot();
    const runtimeRoot = elsewhere();
    const foreignSpecDir = join(runtimeRoot, ".claude", "specs", "run");
    mkdirSync(foreignSpecDir, { recursive: true });
    writeFileSync(join(foreignSpecDir, "brainstorm.md"), "# Foreign brainstorm\n");
    const state = {
      current_phase: "init",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      spec_dir: foreignSpecDir,
      tasks: [],
      wave_gates: {},
    } as unknown as TaskGraph;

    expect(resolveTransition("brainstorm", state, graphRoot)).toEqual({
      kind: "not-ready",
      reason: expect.stringContaining("not project-relative"),
    });
  });

  it("the Pi phase applier advances a worktree-shaped run whose cwd is elsewhere", async () => {
    const root = tempRoot();
    const cwd = elsewhere();
    const specDir = ".claude/specs/run";
    const brainstorm = join(specDir, "brainstorm.md");
    mkdirSync(join(root, specDir), { recursive: true });
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(join(root, brainstorm), "# Brainstorm\n");
    writeFileSync(join(root, "custom", "state.json"), "{}\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const state = parseTaskGraph({
        current_phase: "init",
        phase_artifacts: {},
        skipped_phases: [],
        spec_file: null,
        plan_file: null,
        spec_dir: specDir,
        tasks: [],
        wave_gates: {},
      });
      if (!state.ok) throw new Error(state.error);
      let current: ParsedTaskGraph = state.value;
      const store: TaskGraphStore & { current(): TaskGraph } = {
        load: () => current,
        update: async (mutate) => { current = mutate(current) as ParsedTaskGraph; },
        updateAndReturn: async (mutate) => {
          const applied = mutate(current);
          current = applied.state as ParsedTaskGraph;
          return applied.value;
        },
        current: () => current,
      };
      const result = {
        agent: "brainstorm-agent",
        task: "brainstorm",
        exitCode: 0,
        messages: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: brainstorm } }],
        }],
      };

      // Without the boundary the applier probes cwd and refuses: the deadlock.
      // (The base dir is a REQUIRED argument — this call passes the ambient cwd
      // explicitly, which is exactly the spelling the boundary was introduced
      // to replace.)
      const cwdAnchored = await applyPhaseAgentPiResult({
        store, agentType: "brainstorm-agent", completedPhase: "brainstorm" as Phase,
        result, now: "2026-09-19T00:00:00.000Z",
        phaseArtifactBaseDir: process.cwd(),
      });
      expect(cwdAnchored.processingErrors.join("\n")).toContain("not ready");
      expect(store.current().current_phase).toBe("init");

      // With the graph-derived boundary the same result advances the phase and
      // stores the canonical project-relative artifact.
      const applied = await applyPhaseAgentPiResult({
        store, agentType: "brainstorm-agent", completedPhase: "brainstorm" as Phase,
        result, now: "2026-09-19T00:00:00.000Z",
        phaseArtifactBaseDir: observeTaskGraphProjectBoundary(join(root, "custom", "state.json")).root,
      });
      expect(applied.processingErrors).toEqual([]);
      expect(store.current().current_phase).toBe("specify");
      expect(store.current().phase_artifacts.brainstorm).toBe(brainstorm);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
