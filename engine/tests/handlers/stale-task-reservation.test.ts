/**
 * The staleness probe behind stranded-reservation recovery, and the Pi parity
 * it must not break.
 *
 * `executing_tasks` is committed during PreToolUse, before the sibling gates
 * vote. Releasing an entry is therefore only safe when the shell can PROVE no
 * agent is serving it. The evidence is the `.active` roster plus the
 * `<session>.task_graph` pointer beside it — and the pointer is what makes the
 * answer project-scoped. SUBAGENT_DIR is shared by every project on the
 * machine, so a project-blind probe lets another repo's live agent, or any
 * stray roster file, veto recovery here indefinitely.
 *
 * Pi is the case that must not regress. Pi runs every guard in ONE process and
 * marks the roster (`fsSessionRegistry.markActive`, unconditionally, for every
 * roster id) BEFORE `validate-task-execution` reserves — so at reservation
 * time a Pi spawn always has a non-empty roster and nothing is ever released.
 * Pi additionally rolls back on a block, and its `validate-task-execution` is
 * the last guard that can block, so Pi never strands a reservation at all.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { anyActiveSubagent } from "../../src/machine";

const created: string[] = [];
const previousDir = process.env.LOOM_SUBAGENT_DIR;

afterEach(() => {
  if (previousDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = previousDir;
  for (const path of created.splice(0)) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // best effort — the dir may already be gone or already traversable
    }
    rmSync(path, { recursive: true, force: true });
  }
});

/** Point the probe at a throwaway subagent dir. */
function scopedSubagentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-active-probe-"));
  created.push(dir);
  process.env.LOOM_SUBAGENT_DIR = dir;
  return dir;
}

const GRAPH = "/repo/ours/.claude/state/active_task_graph.json";
const OTHER_GRAPH = "/repo/theirs/.claude/state/active_task_graph.json";

/** A roster for `session`, optionally bound to `graph` by its pointer file. */
function activeSession(dir: string, session: string, graph: string | null): void {
  writeFileSync(join(dir, `${session}.active`), `${session}-agent\n`);
  if (graph !== null) writeFileSync(join(dir, `${session}.task_graph`), graph);
}

describe("anyActiveSubagent", () => {
  it("reports nothing running for an absent directory", () => {
    const dir = scopedSubagentDir();
    rmSync(dir, { recursive: true, force: true });

    // ENOENT is a real answer: the dir was never created, so no agent started.
    expect(anyActiveSubagent(GRAPH)).toBe(false);
  });

  it("reports nothing running for a directory with no roster", () => {
    const dir = scopedSubagentDir();
    // The non-roster session files a live orchestrator leaves behind must not
    // read as a running agent.
    writeFileSync(join(dir, "session-a.callstart.json"), "{}");
    writeFileSync(join(dir, "session-a.task_graph"), GRAPH);

    expect(anyActiveSubagent(GRAPH)).toBe(false);
  });

  it("ignores an emptied roster left behind by cleanup", () => {
    const dir = scopedSubagentDir();
    writeFileSync(join(dir, "session-a.active"), "");
    writeFileSync(join(dir, "session-a.task_graph"), GRAPH);

    expect(anyActiveSubagent(GRAPH)).toBe(false);
  });

  it("reports a running agent bound to this graph", () => {
    const dir = scopedSubagentDir();
    activeSession(dir, "session-a", GRAPH);

    expect(anyActiveSubagent(GRAPH)).toBe(true);
  });

  it("compares the pointer by resolved path", () => {
    const dir = scopedSubagentDir();
    activeSession(dir, "session-a", "/repo/ours/./.claude/state/../state/active_task_graph.json");

    expect(anyActiveSubagent(GRAPH)).toBe(true);
  });

  it("finds a roster in any session bound to this graph", () => {
    const dir = scopedSubagentDir();
    activeSession(dir, "session-a", OTHER_GRAPH);
    activeSession(dir, "session-b", GRAPH);

    expect(anyActiveSubagent(GRAPH)).toBe(true);
  });

  // The defect this scoping exists to fix: SUBAGENT_DIR is global, so without
  // it a live agent in another repo blocks reservation recovery here forever.
  describe("project scoping", () => {
    it("ignores a live agent serving a different task graph", () => {
      const dir = scopedSubagentDir();
      activeSession(dir, "other-project", OTHER_GRAPH);

      expect(anyActiveSubagent(GRAPH)).toBe(false);
    });

    it("ignores a roster bound to no graph at all", () => {
      // Stray rosters — leaked test fixtures, non-loom subagents — carry no
      // pointer. "Bound to nothing" is a real answer, not a failure, so they
      // must not veto recovery.
      const dir = scopedSubagentDir();
      activeSession(dir, "stray-fixture", null);

      expect(anyActiveSubagent(GRAPH)).toBe(false);
    });

    it("still blocks when only one of several rosters is ours", () => {
      const dir = scopedSubagentDir();
      activeSession(dir, "stray-fixture", null);
      activeSession(dir, "other-project", OTHER_GRAPH);
      activeSession(dir, "ours", GRAPH);

      expect(anyActiveSubagent(GRAPH)).toBe(true);
    });

    it("assumes ours when the pointer exists but cannot be read", () => {
      // Unreadable is not evidence of absence — fail closed.
      const dir = scopedSubagentDir();
      activeSession(dir, "unreadable", GRAPH);
      chmodSync(join(dir, "unreadable.task_graph"), 0o000);

      // Root ignores file permissions; only assert when the mode really bites.
      let unreadable = true;
      try {
        readFileSync(join(dir, "unreadable.task_graph"), "utf-8");
        unreadable = false;
      } catch {
        unreadable = true;
      }
      if (unreadable) expect(anyActiveSubagent(GRAPH)).toBe(true);
    });
  });

  it("assumes a running agent when the directory cannot be read", () => {
    const dir = scopedSubagentDir();
    activeSession(dir, "session-a", GRAPH);
    chmodSync(dir, 0o000);

    // Unknown must never read as "safe to release". Skip when the test runs
    // as a user that ignores directory permissions (e.g. root in CI).
    let unreadable = true;
    try {
      mkdirSync(join(dir, "probe"));
      unreadable = false;
    } catch {
      unreadable = true;
    }
    if (unreadable) expect(anyActiveSubagent(GRAPH)).toBe(true);
  });
});

describe("Pi ordering parity", () => {
  it("never releases a reservation while a Pi spawn holds the roster", async () => {
    const dir = scopedSubagentDir();
    const { taskExecutionOwnershipError } = await import(
      "../../src/core/validate-task-execution"
    );
    const state = {
      current_phase: "execute" as const,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      wave_gates: {},
      executing_tasks: ["T1"],
      tasks: [{
        id: "T1",
        description: "pi spawn",
        agent: "code-implementer-agent",
        status: "pending" as const,
        wave: 1,
        depends_on: [],
        file_list: ["src/a.ts"],
      }],
    };

    // Pi marks the roster BEFORE reserving, and mark-subagent-active writes the
    // graph pointer alongside it, so this is the state the probe sees for every
    // in-flight Pi spawn on this graph.
    activeSession(dir, "pi-session", GRAPH);
    expect(anyActiveSubagent(GRAPH)).toBe(true);

    // A live Pi reservation therefore yields an EMPTY stale set, leaving the
    // ownership invariant exactly as strict as before the recovery existed.
    const staleWhilePiRuns = new Set<string>();
    expect(taskExecutionOwnershipError(state, ["T1"], "parallel", staleWhilePiRuns))
      .toContain("already executing");
  });
});
