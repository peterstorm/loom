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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTransition, projectRootForStateFile } from "../../src/handlers/subagent-stop/advance-phase";
import {
  applyPhaseAgentPiResult,
  type TaskGraphStore,
} from "../../../pi/subagent-result";
import { parseTaskGraph, type ParsedTaskGraph } from "../../src/state-manager";
import type { Phase, TaskGraph } from "../../src/types";

const cleanup: string[] = [];
const elsewhere = (): string => {
  const dir = join(tmpdir(), `loom-phase-boundary-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
};

const tempRoot = (): string => {
  const root = join(tmpdir(), `loom-phase-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanup.push(root);
  return root;
};

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("phase artifacts resolve against the graph's project boundary, not cwd", () => {
  it("projectRootForStateFile derives the .claude-owning root from the state path", () => {
    expect(projectRootForStateFile(join("/repo", ".claude", "state", "active_task_graph.json"))).toBe("/repo");
    expect(projectRootForStateFile(join("/repo", ".pi", "state", "active_task_graph.json"))).toBe("/repo");
    expect(projectRootForStateFile("/repo/active_task_graph.json")).toBe("/repo");
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

  it("the Pi phase applier advances a worktree-shaped run whose cwd is elsewhere", async () => {
    const root = tempRoot();
    const cwd = elsewhere();
    const specDir = ".claude/specs/run";
    const brainstorm = join(specDir, "brainstorm.md");
    mkdirSync(join(root, specDir), { recursive: true });
    writeFileSync(join(root, brainstorm), "# Brainstorm\n");
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
      const cwdAnchored = await applyPhaseAgentPiResult({
        store, agentType: "brainstorm-agent", completedPhase: "brainstorm" as Phase,
        result, now: "2026-09-19T00:00:00.000Z",
      });
      expect(cwdAnchored.processingErrors.join("\n")).toContain("not ready");
      expect(store.current().current_phase).toBe("init");

      // With the graph-derived boundary the same result advances the phase and
      // stores the canonical project-relative artifact.
      const applied = await applyPhaseAgentPiResult({
        store, agentType: "brainstorm-agent", completedPhase: "brainstorm" as Phase,
        result, now: "2026-09-19T00:00:00.000Z",
        phaseArtifactBaseDir: projectRootForStateFile(join(root, ".claude", "state", "active_task_graph.json")),
      });
      expect(applied.processingErrors).toEqual([]);
      expect(store.current().current_phase).toBe("specify");
      expect(store.current().phase_artifacts.brainstorm).toBe(brainstorm);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
