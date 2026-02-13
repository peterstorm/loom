import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../src/state-manager";
import type { TaskGraph } from "../src/types";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `loom-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalGraph(): TaskGraph {
  return {
    current_phase: "init",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
  };
}

describe("StateManager", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    statePath = join(tmpDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(minimalGraph(), null, 2));
    chmodSync(statePath, 0o444);
  });

  afterEach(() => {
    try { chmodSync(statePath, 0o644); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads state from file", () => {
    const mgr = new StateManager(statePath);
    const state = mgr.load();
    expect(state.current_phase).toBe("init");
    expect(state.tasks).toEqual([]);
  });

  it("updates state atomically", async () => {
    const mgr = new StateManager(statePath);

    await mgr.update((s) => ({
      ...s,
      current_phase: "specify",
    }));

    const updated = mgr.load();
    expect(updated.current_phase).toBe("specify");
  });

  it("restores chmod 444 after update", async () => {
    const mgr = new StateManager(statePath);
    await mgr.update((s) => ({ ...s, current_phase: "brainstorm" }));

    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it("restores chmod 444 even on error", async () => {
    const mgr = new StateManager(statePath);

    await expect(
      mgr.update(() => { throw new Error("boom"); })
    ).rejects.toThrow("boom");

    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it("replaces state entirely", async () => {
    const mgr = new StateManager(statePath);
    const newState: TaskGraph = {
      ...minimalGraph(),
      current_phase: "execute",
      tasks: [{ id: "T1", description: "test", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] }],
      wave_gates: {},
    };

    await mgr.replace(newState);

    const loaded = mgr.load();
    expect(loaded.current_phase).toBe("execute");
    expect(loaded.tasks).toHaveLength(1);
    expect(loaded.tasks[0].id).toBe("T1");
  });

  it("fromPath returns null for non-existent path", () => {
    expect(StateManager.fromPath("/nonexistent/path.json")).toBeNull();
  });

  it("fromPath returns manager for existing path", () => {
    const mgr = StateManager.fromPath(statePath);
    expect(mgr).not.toBeNull();
    expect(mgr!.getPath()).toBe(statePath);
  });

  it("handles concurrent updates via locking", async () => {
    const mgr = new StateManager(statePath);

    // Write initial state with a counter
    await mgr.update((s) => ({ ...s, current_wave: 0 }));

    // Run 5 concurrent updates
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        mgr.update((s) => ({ ...s, current_wave: (s.current_wave ?? 0) + 1 }))
      )
    );

    const final = mgr.load();
    expect(final.current_wave).toBe(5);
  });

  it("throws on empty file", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, "");
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("Corrupt state file");
  });

  it("throws on truncated JSON", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '{"current_phase":');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("invalid JSON");
  });

  it("throws on missing required fields", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '{"foo": "bar"}');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("missing current_phase");
  });

  it("throws on non-object JSON (array)", () => {
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, '[1, 2, 3]');
    chmodSync(statePath, 0o444);
    const mgr = new StateManager(statePath);
    expect(() => mgr.load()).toThrow("not an object");
  });
});
