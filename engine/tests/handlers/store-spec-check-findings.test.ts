import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSpecCheckOutput } from "../../src/handlers/subagent-stop/store-spec-check-findings";
import handler, { runStoreSpecCheckFindings } from "../../src/handlers/subagent-stop/store-spec-check-findings";
import { projectSlug } from "../../src/utils/agent-transcript-path";
import { reconcileSpecCheck } from "../../src/core/spec-check";
import { parseOrchestrationRunId, parseSlotId } from "../../src/core/orchestration-contract";

describe("parseSpecCheckOutput (pure)", () => {
  it("parses all severity levels", () => {
    const output = [
      "CRITICAL: Missing authentication on /api/admin",
      "HIGH: No rate limiting on public endpoints",
      "MEDIUM: Inconsistent error response format",
      "SPEC_CHECK_CRITICAL_COUNT: 1",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: BLOCKED",
      "SPEC_CHECK_WAVE: 2",
    ].join("\n");

    const result = parseSpecCheckOutput(output);
    expect(result.critical).toEqual(["Missing authentication on /api/admin"]);
    expect(result.high).toEqual(["No rate limiting on public endpoints"]);
    expect(result.medium).toEqual(["Inconsistent error response format"]);
    expect(result.criticalCount).toBe(1);
    expect(result.highCount).toBe(1);
    expect(result.verdict).toBe("BLOCKED");
    expect(result.wave).toBe(2);
  });

  it("handles zero findings", () => {
    const output = "SPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED";
    const result = parseSpecCheckOutput(output);
    expect(result.critical).toEqual([]);
    expect(result.criticalCount).toBe(0);
    expect(result.verdict).toBe("PASSED");
  });

  it("returns null counts when markers missing", () => {
    const result = parseSpecCheckOutput("no markers");
    expect(result.criticalCount).toBeNull();
    expect(result.highCount).toBeNull();
    expect(result.verdict).toBeNull();
  });

  it("extracts multiple findings per severity", () => {
    const output = [
      "CRITICAL: Issue 1",
      "CRITICAL: Issue 2",
      "HIGH: Issue 3",
      "HIGH: Issue 4",
      "HIGH: Issue 5",
    ].join("\n");

    const result = parseSpecCheckOutput(output);
    expect(result.critical).toHaveLength(2);
    expect(result.high).toHaveLength(3);
  });

  it("fails evidence reconciliation when the required verdict marker is absent", () => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
    ].join("\n"));

    const resolution = reconcileSpecCheck(parsed, 1, "now");
    expect(resolution).toEqual({
      kind: "evidence-failed",
      specCheck: {
        wave: 1,
        run_at: "now",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "SPEC_CHECK_VERDICT marker not found - re-run /wave-gate",
      },
    });
  });

  it("fails evidence reconciliation when the required high-count marker is absent", () => {
    // A transcript truncated after CRITICAL_COUNT and VERDICT carries no HIGH:
    // lines either, so coercing the missing marker to 0 made the count agree
    // with the itemization and recorded a truncated report as a clean one.
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    const resolution = reconcileSpecCheck(parsed, 1, "now");
    expect(resolution).toEqual({
      kind: "evidence-failed",
      specCheck: {
        wave: 1,
        run_at: "now",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "SPEC_CHECK_HIGH_COUNT marker not found - re-run /wave-gate",
      },
    });
  });

  it("captures a genuinely clean report that emits all three markers", () => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    const resolution = reconcileSpecCheck(parsed, 1, "now");
    expect(resolution.kind).toBe("captured");
    if (resolution.kind !== "captured") return;
    expect(resolution.specCheck.high_count).toBe(0);
    expect(resolution.specCheck.verdict).toBe("PASSED");
  });

  it("fails evidence reconciliation when the high count drifts from HIGH lines", () => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
      "HIGH: uncounted risk",
    ].join("\n"));

    const resolution = reconcileSpecCheck(parsed, 1, "now");
    expect(resolution.kind).toBe("evidence-failed");
    if (resolution.kind === "evidence-failed") {
      expect(resolution.specCheck.error).toContain("SPEC_CHECK_HIGH_COUNT");
    }
  });

  it("finds last spec-check block, not skill template", () => {
    const output = [
      "SPEC_CHECK_WAVE: {wave_number}",
      "SPEC_CHECK_CRITICAL_COUNT: N",
      "SPEC_CHECK_HIGH_COUNT: N",
      "SPEC_CHECK_VERDICT: {PASSED|BLOCKED}",
      "CRITICAL: {each critical finding}",
      "HIGH: {each high-severity finding}",
      "",
      "Agent processing text...",
      "",
      "SPEC_CHECK_WAVE: 2",
      "SPEC_CHECK_CRITICAL_COUNT: 2",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: BLOCKED",
      "CRITICAL: Missing authentication on /api/admin",
      "CRITICAL: SQL injection vulnerability",
      "HIGH: No rate limiting on public endpoints",
    ].join("\n");

    const result = parseSpecCheckOutput(output);
    expect(result.wave).toBe(2);
    expect(result.criticalCount).toBe(2);
    expect(result.highCount).toBe(1);
    expect(result.verdict).toBe("BLOCKED");
    expect(result.critical).toHaveLength(2);
    expect(result.critical).toEqual([
      "Missing authentication on /api/admin",
      "SQL injection vulnerability",
    ]);
    expect(result.high).toEqual(["No rate limiting on public endpoints"]);
    expect(result.medium).toEqual([]);
  });
});

describe("handler reads file content (not path)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads transcript from file path and parses JSONL content", async () => {
    tmpDir = join(tmpdir(), `spec-check-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const transcriptLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "SPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\nSPEC_CHECK_WAVE: 1" },
        ],
      },
    });
    writeFileSync(transcriptPath, transcriptLine);

    // Create state file
    const statePath = join(tmpDir, "active_task_graph.json");
    const state = {
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [],
      wave_gates: {},
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    chmodSync(statePath, 0o444);

    // Create subagent tracking file pointing to our state
    const subagentDir = join(tmpDir, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, "test-session.task_graph"), statePath);

    // Parser-level regression: file bytes yield the marker text, while the old
    // bug's path-string input yields no transcript content.
    const content = readFileSync(transcriptPath, "utf-8");
    const { parseTranscript } = await import("../../src/parsers/parse-transcript");
    const transcript = parseTranscript(content);

    expect(transcript).toContain("SPEC_CHECK_CRITICAL_COUNT: 0");
    expect(transcript).toContain("SPEC_CHECK_VERDICT: PASSED");

    // Verify that passing a file PATH (old bug) gives empty string
    const badResult = parseTranscript(transcriptPath);
    expect(badResult).toBe("");

    try { chmodSync(statePath, 0o644); } catch {}
  });
});

describe("handler fail-closed paths (round-10 Fix 2 + gap 20)", () => {
  it("malformed stdin → contextual error naming that findings were NOT stored (parity with update-task-status)", async () => {
    const result = await handler("{not json", []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("invalid SubagentStop input");
      expect(result.message).toContain("NOT stored");
    }
  });

  it.each(["null", "42", "[]", JSON.stringify({ session_id: "session-1", agent_type: 7 })])(
    "valid JSON outside the SubagentStop domain fails closed: %s",
    async (stdin) => {
      const result = await handler(stdin, []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/invalid SubagentStop input.*NOT stored/),
      });
    },
  );

  it.each([
    ["absent", `missing-spec-session-${process.pid}-${Date.now()}`],
    ["malformed", "../../invalid spec session"],
  ])("%s TaskGraph authority fails the recognized spec-check stop", async (_label, sessionId) => {
    const result = await handler(JSON.stringify({
      session_id: sessionId,
      agent_type: "spec-check-invoker",
      agent_transcript_path: "/nonexistent/spec-check.jsonl",
    }), []);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/TaskGraph authority unavailable.*spec-check findings NOT stored/),
    });
  });

  it("rejects absent and stale request authority on a modern Wave without changing spec evidence", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const tmpDir = join(tmpdir(), `spec-check-authority-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = join(tmpDir, "active_task_graph.json");
    const runId = parseOrchestrationRunId("run.spec-authority");
    const slotId = parseSlotId("wave-slot:spec-check");
    if (!runId.ok || !slotId.ok) throw new Error("invalid authority fixture");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, tasks: [], wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: runId.value, wave: 1,
        authorityDigest: "a".repeat(64), revision: 1, terminalOutcome: null,
      },
      wave_review_epoch: {
        runId: runId.value, wave: 1, batchEpoch: "b".repeat(64),
        specCheckSlotAuthority: { slot_id: slotId.value, attempted: 2 },
      },
    }));
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED" }] },
    }));
    const session = `spec-check-authority-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);
    const stdin = JSON.stringify({
      session_id: session,
      agent_type: "spec-check-invoker",
      agent_transcript_path: transcriptPath,
    });
    try {
      await expect(handler(stdin, [])).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("no capture-correlated request authority"),
      });
      await expect(runStoreSpecCheckFindings(stdin, [], {
        runId: runId.value,
        slotId: slotId.value,
        attempt: 1,
        role: "spec-check-invoker",
      })).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("does not match the exact current Wave epoch"),
      });
      expect(JSON.parse(readFileSync(statePath, "utf-8")).spec_check).toBeUndefined();
    } finally {
      rmSync(pointer, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects authority-free spec-check evidence after modern Wave authority is retired", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const tmpDir = join(tmpdir(), `spec-check-retired-modern-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = join(tmpDir, "active_task_graph.json");
    const initial = {
      spec_trace_version: 2,
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      tasks: [],
      wave_gates: {},
      spec_check: {
        wave: 1, run_at: "accepted", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    };
    writeFileSync(statePath, JSON.stringify(initial));
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "text",
        text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 1\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: BLOCKED\nCRITICAL: late stale result",
      }] },
    }));
    const session = `spec-check-retired-modern-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);
    try {
      const result = await handler(JSON.stringify({
        session_id: session,
        agent_type: "spec-check-invoker",
        agent_transcript_path: transcriptPath,
      }), []);

      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("modern Wave spec-check has no current capture-correlated request authority"),
      });
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(initial);
    } finally {
      rmSync(pointer, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("count/findings mismatch → EVIDENCE_CAPTURE_FAILED (fail closed, mirrors the manual store-spec-check helper)", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const { mkdirSync: mkdir } = await import("node:fs");
    const tmpDir = join(tmpdir(), `spec-check-mismatch-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = join(tmpDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      tasks: [],
      spec_check: {
        wave: 1, run_at: "earlier", verdict: "BLOCKED", critical_count: 1, high_count: 0,
        critical_findings: ["earlier blocker"], high_findings: [], medium_findings: [],
      },
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
      },
    }));
    // A reported count of 0 alongside a listed CRITICAL finding must become a
    // typed capture failure rather than contradictory spec-check evidence.
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\nCRITICAL: smuggled unreconciled finding",
          },
        ],
      },
    }));
    const session = `spec-check-mismatch-${process.pid}-${Date.now()}`;
    mkdir(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await handler(JSON.stringify({
        session_id: session,
        agent_type: "spec-check-invoker",
        agent_transcript_path: transcriptPath,
      }), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("marking evidence_capture_failed");

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.spec_check.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(state.spec_check.error).toContain("does not match");
      expect(state.wave_gates["1"].blocked).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    }
  });

  it("derives and consumes the transcript when agent_transcript_path is absent", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const tmpDir = join(tmpdir(), `spec-check-derived-${Date.now()}`);
    const configDir = join(tmpDir, "claude-config");
    const projectDir = join(tmpDir, "project");
    const statePath = join(tmpDir, "active_task_graph.json");
    const session = `spec-check-derived-${process.pid}-${Date.now()}`;
    const agentId = "a0a0057138606bfd0";
    const transcriptDir = join(
      configDir, "projects", projectSlug(projectDir), session, "subagents",
    );
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousProject = process.env.CLAUDE_PROJECT_DIR;
    mkdirSync(transcriptDir, { recursive: true });
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 2, tasks: [], wave_gates: {},
    }));
    writeFileSync(pointer, statePath);
    writeFileSync(join(transcriptDir, `agent-${agentId}.jsonl`), JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "SPEC_CHECK_WAVE: 2\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED",
        }],
      },
    }));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    try {
      const result = await handler(JSON.stringify({
        session_id: session,
        agent_id: agentId,
        agent_type: "spec-check-invoker",
      }), []);

      expect(result.kind).toBe("passthrough");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.spec_check).toMatchObject({
        wave: 2,
        verdict: "PASSED",
        critical_count: 0,
      });
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProject;
      rmSync(pointer, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("absent transcript → EVIDENCE_CAPTURE_FAILED recorded, never a silent skip", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const { mkdirSync: mkdir } = await import("node:fs");
    const tmpDir = join(tmpdir(), `spec-check-empty-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = join(tmpDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 3,
      tasks: [],
      wave_gates: {},
    }));
    const session = `spec-check-empty-${process.pid}-${Date.now()}`;
    mkdir(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await handler(JSON.stringify({
        session_id: session,
        agent_type: "spec-check-invoker",
        agent_transcript_path: join(tmpDir, "does-not-exist.jsonl"),
      }), []);
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("marking evidence_capture_failed");

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      // Preserve the concrete unreadable-transcript cause instead of generic
      // missing spec-check evidence.
      expect(state.spec_check.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(state.spec_check.wave).toBe(3);
      expect(state.spec_check.error).toContain("re-run /wave-gate");
    } finally {
      stderrSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    }
  });

  it("existing unreadable transcript records its concrete EVIDENCE_CAPTURE_FAILED cause", async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    const tmpDir = join(tmpdir(), `spec-check-unreadable-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = join(tmpDir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 4,
      tasks: [],
      wave_gates: {},
    }));
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    mkdirSync(transcriptPath);
    const session = `spec-check-unreadable-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const result = await handler(JSON.stringify({
        session_id: session,
        agent_type: "spec-check-invoker",
        agent_transcript_path: transcriptPath,
      }), []);

      expect(result.kind).toBe("passthrough");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.spec_check).toMatchObject({
        wave: 4,
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: expect.stringContaining("spec-check transcript is unreadable"),
      });
      expect(state.spec_check.error).toContain("re-run /wave-gate");
    } finally {
      stderrSpy.mockRestore();
      rmSync(pointer, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
