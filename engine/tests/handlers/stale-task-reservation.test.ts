/**
 * The staleness probe behind stranded-reservation recovery, and the Pi parity
 * it must not break.
 *
 * `executing_tasks` is committed during PreToolUse, before the sibling gates
 * vote. Releasing an entry is therefore only safe when the shell can PROVE no
 * agent is serving it, and the only evidence available is the `.active`
 * roster — which is keyed by session and holds agent ids, so it can say
 * "nothing is running anywhere" and nothing more precise.
 *
 * Pi is the case that must not regress. Pi runs every guard in ONE process and
 * marks the roster (`fsSessionRegistry.markActive`, unconditionally, for every
 * roster id) BEFORE `validate-task-execution` reserves — so at reservation
 * time a Pi spawn always has a non-empty roster and nothing is ever released.
 * Pi additionally rolls back on a block, and its `validate-task-execution` is
 * the last guard that can block, so Pi never strands a reservation at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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

describe("anyActiveSubagent", () => {
  it("reports nothing running for an absent directory", () => {
    const dir = scopedSubagentDir();
    rmSync(dir, { recursive: true, force: true });

    // ENOENT is a real answer: the dir was never created, so no agent started.
    expect(anyActiveSubagent()).toBe(false);
  });

  it("reports nothing running for a directory with no roster", () => {
    const dir = scopedSubagentDir();
    // The non-roster session files a live orchestrator leaves behind must not
    // read as a running agent.
    writeFileSync(join(dir, "session-a.callstart.json"), "{}");
    writeFileSync(join(dir, "session-a.task_graph"), "/tmp/graph.json");

    expect(anyActiveSubagent()).toBe(false);
  });

  it("ignores an emptied roster left behind by cleanup", () => {
    const dir = scopedSubagentDir();
    writeFileSync(join(dir, "session-a.active"), "");

    expect(anyActiveSubagent()).toBe(false);
  });

  it("reports a running agent for a non-empty roster", () => {
    const dir = scopedSubagentDir();
    writeFileSync(join(dir, "session-a.active"), "agent-1\n");

    expect(anyActiveSubagent()).toBe(true);
  });

  it("finds a roster belonging to any session, not just the caller's", () => {
    const dir = scopedSubagentDir();
    writeFileSync(join(dir, "session-a.active"), "");
    writeFileSync(join(dir, "session-b.active"), "agent-2\n");

    expect(anyActiveSubagent()).toBe(true);
  });

  it("assumes a running agent when the directory cannot be read", () => {
    const dir = scopedSubagentDir();
    writeFileSync(join(dir, "session-a.active"), "agent-1\n");
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
    if (unreadable) expect(anyActiveSubagent()).toBe(true);
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

    // Pi marks the roster BEFORE reserving, so this is the state the probe
    // sees for every in-flight Pi spawn.
    writeFileSync(join(dir, "pi-session.active"), "pi-agent-1\n");
    expect(anyActiveSubagent()).toBe(true);

    // A live Pi reservation therefore yields an EMPTY stale set, leaving the
    // ownership invariant exactly as strict as before the recovery existed.
    const staleWhilePiRuns = new Set<string>();
    expect(taskExecutionOwnershipError(state, ["T1"], "parallel", staleWhilePiRuns))
      .toContain("already executing");
  });
});
