import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
/**
 * SubagentStop dispatch resilience:
 * - malformed stdin fails closed with a specific "bindings may leak" error
 * - a cleanupSubagentFlag crash still runs update-task-status (Advisory 4)
 * - update-task-status judges the dispatcher's pre-unbind ledger snapshot,
 *   not whatever file is on disk when it runs (Advisory 7)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import dispatch, { runDispatch } from "../../../src/handlers/subagent-stop/dispatch";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import { parseEpoch } from "../../../src/machine";
import type { EvidenceRecord } from "../../../src/machine";
import { agentRequestAuthority } from "../../fixtures/agent-request-authority";
import { openRunDirectory } from "../../../src/orchestration/run-directory-handle";
import { reportSummary } from "../../machine/report-summary";

const run = `dispatch-resilience-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;

let dirs: string[] = [];
let sessionFiles: string[] = [];

function tempDir(): string {
  const dir = canonicalTempDir("loom-dispatch-");
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

describe("category handler errors propagate instead of passthrough (critical)", () => {
  it("a storeReviewerFindings failure fails the SubagentStop hook", async () => {
    const dir = tempDir();
    const statePath = writeState(dir);
    const session = sid("review-evidence-error");
    pointSessionAt(session, statePath);

    // The reviewer transcript is unreadable, so storeReviewerFindings returns
    // kind error. dispatch must surface that as a failed SubagentStop — a
    // swallowed error would make a wave look clean while evidence was lost.
    const result = await dispatch(JSON.stringify({
      session_id: session,
      agent_id: "agent-review-error",
      agent_type: "code-reviewer",
      agent_transcript_path: join(dir, "missing-transcript.jsonl"),
    }), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("store-reviewer-findings");
  });
});

describe("request-bound capture gates legacy dispatch", () => {
  it("combines capture and cleanup failures while skipping legacy state mutation", async () => {
    const dir = tempDir();
    const statePath = writeState(dir);
    const session = sid("capture-rejected");
    pointSessionAt(session, statePath);
    const runsRoot = join(dir, "runs");
    const runDir = join(runsRoot, "run.dispatch-capture");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const request = agentRequestAuthority("run.dispatch-capture");
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);
    expect((await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "claude",
      nativeId: "agent-capture",
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    })).ok).toBe(true);
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await runDispatch(JSON.stringify({
        session_id: session,
        agent_id: "agent-capture",
        agent_type: "code-reviewer",
        agent_transcript_path: join(dir, "missing-transcript.jsonl"),
      }), [], async () => ({ kind: "error", message: "injected cleanup failure" }));
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("injected cleanup failure"),
      });
      if (result.kind === "error") expect(result.message).toContain("request-bound capture rejected");
      const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
      expect(task.critical_findings ?? []).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });
});

describe("malformed hook input is caught, not crashed on (Advisory 4)", () => {
  it("dispatch: malformed stdin fails closed and names skipped cleanup", async () => {
    const result = await dispatch("{not json", []);
    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("cleanup skipped");
    expect(result.message).toContain("bindings may leak");
  });

  it("mark-subagent-active: malformed stdin → passthrough + loud stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await markActive("{not json", []);
    expect(result.kind).toBe("passthrough");
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("agent not tracked");
  });
});

/** Every discarded result is named; an unnameable active-graph stop also
 * fails the evidence boundary, while known unrelated custom roles retain
 * legacy passthrough compatibility. */
describe("dispatch names what it discarded (audit diagnostics)", () => {
  const stderrOf = async (
    payload: Record<string, unknown>,
    expectedKind: "passthrough" | "error" = "passthrough",
  ): Promise<string> => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await dispatch(JSON.stringify(payload), []);
      expect(result.kind).toBe(expectedKind);
      return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stderrSpy.mockRestore();
    }
  };

  it("says the whole record was skipped when no task graph resolves", async () => {
    // Session bound to nothing: StateManager.fromSession returns null, so
    // status, evidence and findings are ALL skipped.
    const text = await stderrOf({
      session_id: sid("no-graph-at-all"),
      agent_id: "agent-no-graph",
      agent_type: "code-implementer-agent",
    });
    expect(text).toContain("no task graph resolvable");
    expect(text).toContain("recorded NOTHING");
  });

  it("preserves recorded-NOTHING and cleanup diagnostics when graph resolution and cleanup both fail", async () => {
    const result = await runDispatch(JSON.stringify({
      session_id: "../../invalid session",
      agent_id: "agent-dual-failure",
      agent_type: "code-implementer-agent",
    }), [], async () => ({ kind: "error", message: "injected cleanup failure" }));

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("no task graph resolvable");
    expect(result.message).toContain("SubagentStop recorded NOTHING");
    expect(result.message).toContain("invalid session id");
    expect(result.message).toContain("cleanup also failed: injected cleanup failure");
  });

  it.each([
    ["invalid session", { session_id: "../../invalid session", agent_id: "agent-invalid-session", agent_type: "code-reviewer" }, "missing/invalid session id"],
    ["missing agent", { session_id: sid("missing-agent"), agent_type: "code-reviewer" }, "missing agent_id"],
  ])("propagates %s cleanup identity failure instead of reporting successful cleanup", async (_label, payload, diagnostic) => {
    const result = await runDispatch(JSON.stringify(payload), []);

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("SubagentStop recorded NOTHING");
    expect(result.message).toContain("cleanup also failed");
    expect(result.message).toContain(diagnostic);
  });

  it("distinguishes an UNNAMEABLE agent from a merely unrouted one", async () => {
    const dir = tempDir();
    const session = sid("unnameable");
    pointSessionAt(session, writeState(dir));

    // Neither the payload nor the harness metadata can say what ran — a loom
    // agent's result may have just been lost, which is not the same as a user's
    // own subagent legitimately having no orchestration hooks.
    const unnameable = await stderrOf(
      { session_id: session, agent_id: "agent-unnameable" },
      "error",
    );
    expect(unnameable).toContain("carried no agent_type and none could be derived");
    expect(unnameable).toContain("its result is LOST");
  });

  it("names an agent type that resolved but maps to no route", async () => {
    const dir = tempDir();
    const session = sid("unrouted");
    pointSessionAt(session, writeState(dir));

    const unrouted = await stderrOf({
      session_id: session,
      agent_id: "agent-unrouted",
      agent_type: "some-users-own-agent",
    });
    expect(unrouted).toContain("no orchestration route for agent type");
    expect(unrouted).toContain("some-users-own-agent");
    // The louder "result is LOST" wording belongs to the unnameable case only.
    expect(unrouted).not.toContain("its result is LOST");
  });
});

describe("a cleanupSubagentFlag crash still runs update-task-status (Advisory 4)", () => {
  it("held cleanup lock reports cleanup failure after T1 quarantine still runs", async () => {
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
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("cleanup-subagent-flag") });
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).not.toContain("ERROR in cleanupSubagentFlag");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.executing_tasks).toEqual([]);
  }, 30000);

  it("catches a thrown cleanup dependency, still runs category quarantine, and returns the cleanup error", async () => {
    const s = sid("cleanup-throws");
    const dir = tempDir();
    const statePath = writeState(dir, { new_tests_required: false });
    pointSessionAt(s, statePath);

    const result = await runDispatch(
      JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" }),
      [],
      async () => { throw new Error("injected cleanup crash"); },
    );

    expect(result).toEqual({
      kind: "error",
      message: expect.stringContaining("cleanupSubagentFlag crashed: injected cleanup crash"),
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.executing_tasks).toEqual([]);
    expect(state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "failed" },
      revalidation_required: true,
    });
  });
});

describe("update-task-status honors the pre-unbind evidence snapshot (Advisory 7)", () => {
  it("a trusted TestRun in the snapshot decides the verdict even with no ledger on disk", async () => {
    const s = sid("snapshot");
    const dir = tempDir();
    // New-test detection is independent of this snapshot-attribution test.
    const statePath = writeState(dir, { new_tests_required: false });
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
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.tasks[0].revalidation_required).toBe(true);
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 0");
  }, 30000);
});

describe("legacy Claude completion has no positive authority", () => {
  it("an extracted transcript Task id and passing ledger evidence remain cleanup-only", async () => {
    const s = sid("legacy-extracted-pass");
    const dir = tempDir();
    const statePath = writeState(dir, { new_tests_required: false });
    pointSessionAt(s, statePath);
    const transcriptPath = join(dir, "legacy-extracted.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "Task ID: T1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "1 passing" } }),
    ].join("\n"));
    const snapshot: readonly EvidenceRecord[] = [{
      epoch: parseEpoch("a-1:code-implementer-agent")!,
      event: { kind: "TestRun", command: "npm test", exit: 0, report: reportSummary(1, 0) },
    }];

    const result = await runUpdateTaskStatus(JSON.stringify({
      session_id: s,
      agent_id: "a-1",
      agent_type: "code-implementer-agent",
      agent_transcript_path: transcriptPath,
    }), [], { kind: "snapshot", events: snapshot });

    expect(result.kind).toBe("passthrough");
    const task = JSON.parse(readFileSync(statePath, "utf8")).tasks[0];
    expect(task).toMatchObject({
      status: "pending",
      proof: { state: "failed" },
      revalidation_required: true,
      test_result: { verdict: "trusted-pass" },
    });
  });
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

  it("a trusted verdict is preserved while task cleanup resolves inside the lock", async () => {
    const s = sid("trusted-kept");
    const dir = tempDir();
    const statePath = writeState(dir, {
      status: "implemented",
      test_result: { verdict: "trusted-fail" },
      test_evidence: "ledger: exit 1 (npm test)",
      new_tests_written: true,
      new_test_evidence: "legacy fixture evidence",
    });
    pointSessionAt(s, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Empty snapshot + no transcript: the handler produces an untrusted
    // failure, but the existing trusted verdict must survive while execution
    // cleanup lands. New-test evidence is deliberately not asserted here: it is
    // recomputed from the repository diff and belongs to dedicated tests with
    // injected DiffDeps.
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: [] });
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");
    expect(text).not.toContain("leaving it untouched");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-fail" });
    expect(state.tasks[0].test_evidence).toBe("ledger: exit 1 (npm test)");
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
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    // No transcript in this run → the fallback found no pass markers; the
    // labeled untrusted verdict carries exactly that.
    expect(state.tasks[0].test_result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      provenance: "unverified",
    });
    expect(state.tasks[0].test_result.label).not.toContain("degraded");
  }, 30000);
});

describe("an INVALID session id is a typed snapshot failure, never an empty snapshot (round-10 gap 22)", () => {
  it("session_id with reserved characters → typed snapshot failure + cleanup error", async () => {
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

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("missing/invalid session id"),
    });
    // The snapshot is labeled FAILED (invalid id can name no ledger file) —
    // downstream would label the verdict snapshot-read-failed, never "degraded".
    expect(text).toContain("evidence snapshot failed");
    expect(text).toContain("invalid session id");
  });
});
