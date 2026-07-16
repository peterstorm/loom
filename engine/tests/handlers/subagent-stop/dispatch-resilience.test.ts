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
import { reportSummary } from "../../machine/report-summary";

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
function writeState(dir: string, taskOverrides: Record<string, unknown> = {}): string {
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
      // "pending": parseTaskGraph rejects out-of-union statuses at load —
      // the executing marker is executing_tasks, not a status value.
      wave: 1, status: "pending", depends_on: [],
      new_tests_required: true,
      ...taskOverrides,
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
        report: reportSummary(5, 0),
      },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(
      JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" }),
      [],
      { kind: "snapshot", events: snapshot },
    );
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 0");
  }, 30000);
});

describe("trust-aware skip guard — decided INSIDE the locked update", () => {
  const stopInput = (s: string) =>
    JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" });

  it("an untrusted helper-reported 'pass' does NOT preempt the ledger's trusted-fail (laundering hole closed)", async () => {
    const s = sid("launder");
    const dir = tempDir();
    // The classic laundering move: store-test-evidence stdin wrote an
    // untrusted pass BEFORE SubagentStop fired. The old any-trust skip
    // guard would have preserved it and dropped the ground truth.
    const statePath = writeState(dir, {
      status: "implemented",
      test_result: { verdict: "untrusted", passed: true, label: "helper-reported (store-test-evidence stdin)" },
      test_evidence: "all 999 tests pass, honest",
    });
    pointSessionAt(s, statePath);

    const snapshot: readonly EvidenceRecord[] = [{
      epoch: parseEpoch("a-1:code-implementer-agent")!,
      event: { kind: "TestRun", command: "npm test", exit: 1, report: null },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-fail" }); // ground truth persisted
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 1");
  }, 30000);

  it("a trusted verdict on the task IS preserved (skip fires inside the lock)", async () => {
    const s = sid("trusted-kept");
    const dir = tempDir();
    const statePath = writeState(dir, {
      status: "implemented",
      test_result: { verdict: "trusted-fail" },
      test_evidence: "ledger: exit 1 (npm test)",
      new_tests_written: true,
    });
    pointSessionAt(s, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Empty snapshot + no transcript: the handler would write an untrusted
    // failure — the existing trusted verdict must survive it.
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: [] });
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");
    expect(text).toContain("leaving it untouched");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-fail" });
    expect(state.tasks[0].test_evidence).toBe("ledger: exit 1 (npm test)");
    expect(state.tasks[0].new_tests_written).toBe(true);
    // The VERDICT stands down, but the agent still STOPPED: the task must
    // leave executing_tasks or the duplicate-spawn check ghost-blocks re-runs.
    expect(state.executing_tasks).toEqual([]);
  }, 30000);

  it("a completed task is never reopened", async () => {
    const s = sid("completed-kept");
    const dir = tempDir();
    const statePath = writeState(dir, { status: "completed" });
    pointSessionAt(s, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: [] });
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("completed");
    expect(state.tasks[0].test_result).toBeUndefined();
  }, 30000);
});

describe("a FAILED evidence snapshot is never laundered into 'genuinely empty' (snapshot-failed sentinel)", () => {
  it("unreadable ledger → verdict is labeled snapshot-read-failed, never 'degraded'", async () => {
    const s = sid("snapshot-fail");
    const dir = tempDir();
    const statePath = writeState(dir);
    pointSessionAt(s, statePath);

    // A DIRECTORY at the ledger path makes readEvidence throw (EISDIR):
    // the dispatcher's snapshot read fails. The { kind: "snapshot-failed" }
    // sentinel routes update-task-status to the transcript-only fallback
    // with a snapshot-read-failed label — never the misleading "degraded
    // (machine bound, no ledger evidence)" that a laundered [] would mint.
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
    // The handler proceeds (labeled), it does not crash:
    expect(text).not.toContain("ERROR in updateTaskStatus");
    expect(text).toContain("labeled snapshot-read-failed");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    // No transcript in this run → the fallback found no pass markers; the
    // labeled untrusted verdict carries exactly that.
    expect(state.tasks[0].test_result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
    });
    expect(state.tasks[0].test_result.label).not.toContain("degraded");
  }, 30000);
});

describe("an INVALID session id is a typed snapshot failure, never an empty snapshot (round-10 gap 22)", () => {
  it("session_id with reserved characters → 'invalid session id' stderr + passthrough", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await dispatch(
      JSON.stringify({
        session_id: "../../etc/evil session",
        agent_id: "a-1",
        agent_type: "code-implementer-agent",
      }),
      [],
    );
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(result.kind).toBe("passthrough"); // dispatcher never crashes the pipeline
    // The snapshot is labeled FAILED (invalid id can name no ledger file) —
    // downstream would label the verdict snapshot-read-failed, never "degraded".
    expect(text).toContain("evidence snapshot failed");
    expect(text).toContain("invalid session id");
  });
});
