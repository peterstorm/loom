import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskGraph } from "../../src/types";

/**
 * Test the overwrite guard logic from populate-task-graph.
 * Extracted as pure decision logic to avoid needing FS mocking.
 */

function shouldBlockOverwrite(existing: TaskGraph, force: boolean): string | null {
  if (force) return null;
  if (existing.tasks.some((t) => t.status !== "pending")) {
    return "Cannot overwrite task graph with non-pending tasks. Use --force to override.";
  }
  return null;
}

function mkState(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  };
}

describe("populate-task-graph — overwrite guard", () => {
  it("rejects overwrite of non-pending tasks", () => {
    const state = mkState({
      tasks: [
        { id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [] },
        { id: "T2", description: "x", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] },
      ],
    });
    expect(shouldBlockOverwrite(state, false)).toContain("non-pending");
  });

  it("allows with --force even with non-pending tasks", () => {
    const state = mkState({
      tasks: [
        { id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, status: "completed", depends_on: [] },
      ],
    });
    expect(shouldBlockOverwrite(state, true)).toBeNull();
  });

  it("allows when no existing tasks", () => {
    const state = mkState({ tasks: [] });
    expect(shouldBlockOverwrite(state, false)).toBeNull();
  });

  it("allows when all existing tasks are pending", () => {
    const state = mkState({
      tasks: [
        { id: "T1", description: "x", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] },
        { id: "T2", description: "x", agent: "code-implementer-agent", wave: 2, status: "pending", depends_on: [] },
      ],
    });
    expect(shouldBlockOverwrite(state, false)).toBeNull();
  });
});
