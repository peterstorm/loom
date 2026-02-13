/**
 * Atomic state file manager with chmod-based protection + locking
 *
 * State file stays chmod 444 at rest. Only hooks write via this manager.
 * Replaces: state-file-write.sh, resolve-task-graph.sh, loom-config.sh
 */

import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { withLock } from "./utils/lock";
import { TASK_GRAPH_PATH, SUBAGENT_DIR } from "./config";
import type { TaskGraph } from "./types";

/** Resolve task graph path for cross-repo access */
export function resolveTaskGraph(sessionId?: string): string | null {
  if (sessionId) {
    const sessionFile = `${SUBAGENT_DIR}/${sessionId}.task_graph`;
    if (existsSync(sessionFile)) {
      const absPath = readFileSync(sessionFile, "utf-8").trim();
      if (existsSync(absPath)) return absPath;
    }
  }

  if (existsSync(TASK_GRAPH_PATH)) return TASK_GRAPH_PATH;

  return null;
}

export class StateManager {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const path = resolveTaskGraph(sessionId);
    return path ? new StateManager(path) : null;
  }

  static fromPath(path: string): StateManager | null {
    return existsSync(path) ? new StateManager(path) : null;
  }

  load(): TaskGraph {
    const raw = readFileSync(this.path, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Corrupt state file (invalid JSON): ${this.path} — ${(e as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Corrupt state file (not an object): ${this.path}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (!("current_phase" in obj)) throw new Error(`Corrupt state file (missing current_phase): ${this.path}`);
    if (!("phase_artifacts" in obj)) throw new Error(`Corrupt state file (missing phase_artifacts): ${this.path}`);
    // Default tasks and wave_gates for early phases (populated in Phase 4)
    if (!("tasks" in obj)) (obj as Record<string, unknown>).tasks = [];
    if (!("wave_gates" in obj)) (obj as Record<string, unknown>).wave_gates = {};
    return obj as unknown as TaskGraph;
  }

  getPath(): string {
    return this.path;
  }

  /** Atomically update state via pure transform: (state) => state */
  async update(fn: (state: TaskGraph) => TaskGraph): Promise<void> {
    await this.atomicWrite(() => fn(this.load()));
  }

  /** Replace state entirely (used by populate-task-graph) */
  async replace(state: TaskGraph): Promise<void> {
    await this.atomicWrite(() => state);
  }

  /** lock → chmod 644 → produce → write tmp → rename → chmod 444 → unlock */
  private async atomicWrite(produce: () => TaskGraph): Promise<void> {
    const lockFile = `${dirname(this.path)}/.task_graph`;
    const tmp = `${this.path}.tmp`;
    await withLock(lockFile, () => {
      chmodSync(this.path, 0o644);
      try {
        writeFileSync(tmp, JSON.stringify(produce(), null, 2));
        renameSync(tmp, this.path);
      } catch (e) {
        // Clean up orphaned .tmp file
        try { unlinkSync(tmp); } catch {}
        throw e;
      } finally {
        chmodSync(this.path, 0o444);
      }
    });
  }
}
