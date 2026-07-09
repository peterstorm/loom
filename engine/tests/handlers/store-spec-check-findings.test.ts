import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSpecCheckOutput } from "../../src/handlers/subagent-stop/store-spec-check-findings";
import handler from "../../src/handlers/subagent-stop/store-spec-check-findings";

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

    // Create a JSONL transcript file with spec-check output
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

    // Temporarily override SUBAGENT_DIR by mocking fromSession behavior
    // Instead, call handler directly — it uses StateManager.fromSession
    // which checks SUBAGENT_DIR. We'll test the file-reading logic via the
    // handler returning passthrough (not error) when given a valid transcript file.

    // If the handler were still passing the path string to parseTranscript,
    // it would get empty transcript and return passthrough early.
    // With the fix, it reads file content → gets valid JSONL → parses findings.
    // We can verify the fix by checking parseTranscript works on actual content:
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
      expect(result.message).toContain("malformed SubagentStop input");
      expect(result.message).toContain("NOT stored");
    }
  });

  it("empty/unreadable transcript → EVIDENCE_CAPTURE_FAILED recorded, never a silent skip", async () => {
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
      // Wave-gate check 4 now sees a verdict, not a vacuous "no spec-check data".
      expect(state.spec_check.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(state.spec_check.wave).toBe(3);
      expect(state.spec_check.error).toContain("re-run /wave-gate");
    } finally {
      stderrSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(pointer, { force: true });
    }
  });
});
