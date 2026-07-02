/**
 * SubagentStop dispatch resilience:
 * - malformed stdin is caught with a specific "bindings may leak" note
 *   instead of crashing the whole pipeline (Advisory 4)
 * - a cleanupSubagentFlag crash still runs update-task-status (Advisory 4)
 * - update-task-status judges the dispatcher's pre-unbind ledger snapshot,
 *   not whatever file is on disk when it runs (Advisory 7)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dispatch from "../../../src/handlers/subagent-stop/dispatch";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import { parseEpoch } from "../../../src/machine";
import type { EvidenceRecord } from "../../../src/machine";

const run = `dispatch-resilience-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;

let dirs: string[] = [];
let sessionFiles: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-dispatch-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  for (const f of sessionFiles) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch {}
  }
  sessionFiles = [];
  vi.restoreAllMocks();
});

/** State with one executing task so update-task-status has unambiguous work. */
function writeState(dir: string): string {
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [{
      id: "T1", description: "impl", agent: "code-implementer-agent",
      wave: 1, status: "in_progress", depends_on: [],
      new_tests_required: true,
    }],
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  }));
  return statePath;
}

/** Point the session at the state file (cross-repo resolution path). */
function pointSessionAt(session: string, statePath: string): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = `${SUBAGENT_DIR}/${session}.task_graph`;
  writeFileSync(pointer, statePath);
  sessionFiles.push(pointer);
}

describe("malformed hook input is caught, not crashed on (Advisory 4)", () => {
  it("dispatch: malformed stdin → passthrough + 'bindings may leak' stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await dispatch("{not json", []);
    expect(result.kind).toBe("passthrough");
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("cleanup skipped");
    expect(text).toContain("bindings may leak");
  });

  it("mark-subagent-active: malformed stdin → passthrough + loud stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await markActive("{not json", []);
    expect(result.kind).toBe("passthrough");
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("agent not tracked");
  });
});

describe("a cleanupSubagentFlag crash still runs update-task-status (Advisory 4)", () => {
  it("held cleanup lock crashes cleanup; T1 is still marked implemented", async () => {
    const s = sid("cleanup-crash");
    const dir = tempDir();
    const statePath = writeState(dir);
    pointSessionAt(s, statePath);

    // .active exists → cleanup must take the lock to rewrite it
    const activeFile = `${SUBAGENT_DIR}/${s}.active`;
    writeFileSync(activeFile, "a-1\n");
    sessionFiles.push(activeFile);

    // Hold the cleanup lock with OUR live pid: acquisition retries then
    // throws — a genuine cleanup crash inside the dispatcher.
    const lockDir = `${SUBAGENT_DIR}/${s}.cleanup.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), `${process.pid}`);
    sessionFiles.push(lockDir);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await dispatch(
        JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" }),
        [],
      );
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("ERROR in cleanupSubagentFlag");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    expect(state.executing_tasks).toEqual([]);
  }, 30000);
});

describe("update-task-status honors the pre-unbind evidence snapshot (Advisory 7)", () => {
  it("a trusted TestRun in the snapshot decides the verdict even with no ledger on disk", async () => {
    const s = sid("snapshot");
    const dir = tempDir();
    const statePath = writeState(dir);
    pointSessionAt(s, statePath);

    // No <session>.evidence.jsonl exists — the snapshot is the only source,
    // exactly the bind-time truncation window the dispatcher closes.
    const snapshot: readonly EvidenceRecord[] = [{
      epoch: parseEpoch("a-1:code-implementer-agent")!,
      event: {
        kind: "TestRun",
        command: "npm test",
        exit: 0,
        report: { total: 5, failed: 0, source: "vitest-json" },
      },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(
      JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" }),
      [],
      snapshot,
    );
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 0");
  }, 30000);
});

describe("a FAILED evidence snapshot is never laundered into 'genuinely empty' (null sentinel)", () => {
  it("unreadable ledger → snapshot fails loudly and the task is NOT credited a degraded verdict", async () => {
    const s = sid("snapshot-fail");
    const dir = tempDir();
    const statePath = writeState(dir);
    pointSessionAt(s, statePath);

    // A DIRECTORY at the ledger path makes readEvidence throw (EISDIR):
    // the dispatcher's snapshot read fails. With the old `[]` sentinel the
    // handler would treat this as an empty ledger and mint a degraded
    // verdict; with the null sentinel it re-reads (and fails loudly).
    const ledgerDir = `${SUBAGENT_DIR}/${s}.evidence.jsonl`;
    mkdirSync(ledgerDir, { recursive: true });
    sessionFiles.push(ledgerDir);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await dispatch(
      JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" }),
      [],
    );
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(result.kind).toBe("passthrough"); // dispatcher never crashes the pipeline
    expect(text).toContain(`evidence snapshot failed for ${s}`);
    // The re-read also fails → update-task-status errors instead of writing
    // a fabricated "degraded (machine bound, no ledger evidence)" verdict.
    expect(text).toContain("ERROR in updateTaskStatus");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("in_progress"); // untouched — fail closed
    expect(state.tasks[0].test_result).toBeUndefined();
  }, 30000);
});
