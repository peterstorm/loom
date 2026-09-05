import { describe, it, expect, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdirSync, realpathSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { parseSpecCheckOutput } from "../../src/handlers/subagent-stop/store-spec-check-findings";
import handler, { runStoreSpecCheckFindings } from "../../src/handlers/subagent-stop/store-spec-check-findings";
import { projectSlug } from "../../src/utils/agent-transcript-path";
import { reconcileSpecCheck } from "../../src/core/spec-check";
import { parseOrchestrationRunId, parseSlotId } from "../../src/core/orchestration-contract";

describe("parseSpecCheckOutput (pure)", () => {
  it("parses all severity levels", () => {
    const output = [
      "SPEC_CHECK_WAVE: 2",
      "CRITICAL: Missing authentication on /api/admin",
      "HIGH: No rate limiting on public endpoints",
      "MEDIUM: Inconsistent error response format",
      "SPEC_CHECK_CRITICAL_COUNT: 1",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: BLOCKED",
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

  it("rejects contradictory duplicate count markers instead of selecting the first", () => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_CRITICAL_COUNT: 1",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    expect(parsed.duplicateMarkers).toEqual(["SPEC_CHECK_CRITICAL_COUNT"]);
    expect(reconcileSpecCheck(parsed, 1, "now")).toMatchObject({
      kind: "evidence-failed",
      specCheck: {
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: expect.stringContaining("SPEC_CHECK_CRITICAL_COUNT marker appears more than once"),
      },
    });
  });

  it("rejects contradictory terminal verdicts instead of accepting the first", () => {
    const parsed = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
      "SPEC_CHECK_VERDICT: BLOCKED",
    ].join("\n"));

    expect(parsed.duplicateMarkers).toEqual(["SPEC_CHECK_VERDICT"]);
    expect(reconcileSpecCheck(parsed, 1, "now")).toMatchObject({
      kind: "evidence-failed",
      specCheck: {
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: expect.stringContaining("SPEC_CHECK_VERDICT marker appears more than once"),
      },
    });
  });

  it("property: duplicate footer scalars never reconcile to captured evidence", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        "SPEC_CHECK_CRITICAL_COUNT",
        "SPEC_CHECK_HIGH_COUNT",
        "SPEC_CHECK_OVERRIDE",
        "SPEC_CHECK_VERDICT",
      ),
      fc.nat({ max: 10 }),
      fc.nat({ max: 10 }),
      (marker, first, second) => {
        const value = (count: number): string => {
          if (marker === "SPEC_CHECK_OVERRIDE") return `reason-${count}`;
          if (marker === "SPEC_CHECK_VERDICT") return count % 2 === 0 ? "PASSED" : "BLOCKED";
          return String(count);
        };
        const parsed = parseSpecCheckOutput([
          "SPEC_CHECK_WAVE: 1",
          "SPEC_CHECK_CRITICAL_COUNT: 0",
          "SPEC_CHECK_HIGH_COUNT: 0",
          `${marker}: ${value(first)}`,
          `${marker}: ${value(second)}`,
          "SPEC_CHECK_VERDICT: PASSED",
        ].join("\n"));
        const resolution = reconcileSpecCheck(parsed, 1, "now");

        expect(parsed.duplicateMarkers).toContain(marker);
        expect(resolution.kind).toBe("evidence-failed");
        if (resolution.kind === "evidence-failed") {
          expect(resolution.specCheck.error).toContain(`${marker} marker appears more than once`);
        }
      },
    ));
  });

  it("fails evidence reconciliation when the high count drifts from HIGH lines", () => {
    const parsed = parseSpecCheckOutput([
      "HIGH: uncounted risk",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
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
      "CRITICAL: Missing authentication on /api/admin",
      "CRITICAL: SQL injection vulnerability",
      "HIGH: No rate limiting on public endpoints",
      "SPEC_CHECK_CRITICAL_COUNT: 2",
      "SPEC_CHECK_HIGH_COUNT: 1",
      "SPEC_CHECK_VERDICT: BLOCKED",
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

  it("ignores finding and override markers after the selected footer verdict", () => {
    const result = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 2",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
      "HIGH: trailing transcript prose",
      "SPEC_CHECK_OVERRIDE: unauthorised trailing override",
    ].join("\n"));

    expect(result).toMatchObject({
      critical: [], high: [], medium: [], criticalCount: 0, highCount: 0,
      verdict: "PASSED", wave: 2, overrideReason: null,
    });
  });

  it("does not let a later incomplete footer borrow an earlier verdict", () => {
    const result = parseSpecCheckOutput([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
      "SPEC_CHECK_WAVE: 2",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
    ].join("\n"));

    expect(result).toMatchObject({ criticalCount: 0, highCount: 0, verdict: null, wave: 2 });
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
    // macOS tmpdir() sits behind the system /var → /private/var symlink; the
    // anchored primitives resolve the base once, so the fixture root must be
    // canonical too.
    tmpDir = realpathSync.native(tmpDir);

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

    const subagentDir = join(tmpDir, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, "test-session.task_graph"), statePath);

    const content = readFileSync(transcriptPath, "utf-8");
    const { parseTranscript } = await import("../../src/parsers/parse-transcript");
    const transcript = parseTranscript(content);

    expect(transcript).toContain("SPEC_CHECK_CRITICAL_COUNT: 0");
    expect(transcript).toContain("SPEC_CHECK_VERDICT: PASSED");

    const badResult = parseTranscript(transcriptPath);
    expect(badResult).toBe("");

    try {
      chmodSync(statePath, 0o644);
    } catch (error) {
      // ENOENT is the one idempotent absence; anything else is fixture damage.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
});

describe("handler fail-closed paths (round-10 Fix 2 + gap 20)", () => {
  async function withTaskGraphPointer<T>(
    session: string,
    statePath: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const { SUBAGENT_DIR } = await import("../../src/config");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);
    try {
      return await run();
    } finally {
      rmSync(pointer, { force: true });
    }
  }
  it.each(["missing", "unreadable"] as const)(
    "records exact modern Wave %s transcript capture as EVIDENCE_CAPTURE_FAILED",
    async (failureKind) => {
      const tmpRoot = join(tmpdir(), `spec-check-${failureKind}-modern-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      const tmpDir = realpathSync.native(tmpRoot);
      const statePath = join(tmpDir, "active_task_graph.json");
      const transcriptPath = join(tmpDir, "transcript.jsonl");
      if (failureKind === "unreadable") mkdirSync(transcriptPath);
      const runId = parseOrchestrationRunId(`run.spec-${failureKind}-transcript`);
      const slotId = parseSlotId(`wave-slot:spec-${failureKind}-transcript`);
      if (!runId.ok || !slotId.ok) throw new Error("invalid transcript failure authority fixture");
      writeFileSync(statePath, JSON.stringify({
        spec_trace_version: 2,
        current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
        spec_file: null, plan_file: null, current_wave: 5, tasks: [], wave_gates: {},
        active_wave_gate: {
          schemaVersion: 1, kind: "active-wave-gate", runId: runId.value, wave: 5,
          authorityDigest: "a".repeat(64), revision: 1, terminalOutcome: null,
        },
        wave_review_epoch: {
          runId: runId.value, wave: 5, batchEpoch: "b".repeat(64),
          specCheckDocuments: {
            spec: { path: null, contentDigest: null },
            plan: { path: null, contentDigest: null },
          },
          specCheckSlotAuthority: { slot_id: slotId.value, attempted: 1 },
        },
      }));
      const session = `spec-check-${failureKind}-modern-${process.pid}-${Date.now()}`;
      try {
        await withTaskGraphPointer(session, statePath, async () => {
          const result = await runStoreSpecCheckFindings(JSON.stringify({
            session_id: session,
            agent_type: "spec-check-invoker",
            agent_transcript_path: transcriptPath,
          }), [], {
            runId: runId.value,
            slotId: slotId.value,
            attempt: 1,
            role: "spec-check-invoker",
          });

          expect(result).toMatchObject({
            kind: "passthrough",
            systemMessage: expect.stringContaining("marking evidence_capture_failed"),
          });
          expect(JSON.parse(readFileSync(statePath, "utf8")).spec_check).toMatchObject({
            wave: 5,
            verdict: "EVIDENCE_CAPTURE_FAILED",
            error: expect.stringMatching(/spec-check transcript is unreadable.*re-run \/wave-gate/),
          });
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

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
        specCheckDocuments: {
          spec: { path: null, contentDigest: null },
          plan: { path: null, contentDigest: null },
        },
        specCheckSlotAuthority: { slot_id: slotId.value, attempted: 2 },
      },
    }));
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED" }] },
    }));
    const session = `spec-check-authority-${process.pid}-${Date.now()}`;
    const stdin = JSON.stringify({
      session_id: session,
      agent_type: "spec-check-invoker",
      agent_transcript_path: transcriptPath,
    });
    try {
      await withTaskGraphPointer(session, statePath, async () => {
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
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects exact request evidence after the bound specification bytes change", async () => {
    const tmpRoot = join(tmpdir(), `spec-check-byte-drift-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = realpathSync.native(tmpRoot);
    const statePath = join(tmpDir, "active_task_graph.json");
    const specPath = join(tmpDir, "spec.md");
    const planPath = join(tmpDir, "plan.md");
    const originalSpec = "spec before";
    const plan = "plan";
    writeFileSync(specPath, originalSpec);
    writeFileSync(planPath, plan);
    const runId = parseOrchestrationRunId("run.spec-byte-drift");
    const slotId = parseSlotId("wave-slot:spec-byte-drift");
    if (!runId.ok || !slotId.ok) throw new Error("invalid authority fixture");
    writeFileSync(statePath, JSON.stringify({
      spec_trace_version: 2,
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: specPath, plan_file: planPath, current_wave: 1, tasks: [], wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: runId.value, wave: 1,
        authorityDigest: "a".repeat(64), revision: 1, terminalOutcome: null,
      },
      wave_review_epoch: {
        runId: runId.value, wave: 1, batchEpoch: "b".repeat(64),
        specCheckDocuments: {
          spec: { path: specPath, contentDigest: createHash("sha256").update(originalSpec).digest("hex") },
          plan: { path: planPath, contentDigest: createHash("sha256").update(plan).digest("hex") },
        },
        specCheckSlotAuthority: { slot_id: slotId.value, attempted: 1 },
      },
    }));
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "text",
        text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED",
      }] },
    }));
    writeFileSync(specPath, "spec after");
    const session = `spec-check-byte-drift-${process.pid}-${Date.now()}`;
    try {
      await withTaskGraphPointer(session, statePath, async () => {
        const result = await runStoreSpecCheckFindings(JSON.stringify({
          session_id: session,
          agent_type: "spec-check-invoker",
          agent_transcript_path: transcriptPath,
        }), [], {
          runId: runId.value,
          slotId: slotId.value,
          attempt: 1,
          role: "spec-check-invoker",
        });
        expect(result).toMatchObject({
          kind: "error",
          message: expect.stringContaining("spec/plan bytes do not match"),
        });
        expect(JSON.parse(readFileSync(statePath, "utf8")).spec_check).toBeUndefined();
      });
    } finally {
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
    const tmpRoot = join(tmpdir(), `spec-check-mismatch-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    // macOS tmpdir() sits behind /var → /private/var; canonicalize the fixture
    // root so the anchored primitives' base-resolution matches production.
    const tmpDir = realpathSync.native(tmpRoot);
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
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "SPEC_CHECK_WAVE: 1\nCRITICAL: smuggled unreconciled finding\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED",
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
    const tmpRoot = join(tmpdir(), `spec-check-derived-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = realpathSync.native(tmpRoot);
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
    const tmpRoot = join(tmpdir(), `spec-check-empty-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = realpathSync.native(tmpRoot);
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
      expect(state.spec_check.error).toContain("spec-check transcript is unreadable");
      expect(state.spec_check.error).toContain("does-not-exist.jsonl");
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

describe("the Requirement Coverage Projection is enforced, not merely rendered", () => {
  const spec = `# Feature: Enforced

## User Scenarios

### US1: [P1] Enforce the floor

**Acceptance Scenarios:**
- AS-001: Given a settled row, When the Agent drops it, Then evidence capture fails

## Functional Requirements

- FR-001: System MUST floor the reported CRITICAL count at the settled count

## Out of Scope

- OOS-001: Symbol-level source indexing

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
`;

  /**
   * One Wave whose single Task claims an identifier the spec does not define —
   * a settled CRITICAL — and a spec-check transcript reporting `reported`
   * CRITICAL findings. Returns the persisted `spec_check` record.
   */
  async function storedSpecCheck(reported: number): Promise<Record<string, unknown>> {
    const tmpRoot = join(tmpdir(), `spec-check-floor-${reported}-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = realpathSync.native(tmpRoot);
    const statePath = join(tmpDir, "active_task_graph.json");
    const specPath = join(tmpDir, "spec.md");
    writeFileSync(specPath, spec);
    const specDigest = createHash("sha256").update(readFileSync(specPath)).digest("hex");
    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const criticalLines = Array.from({ length: reported }, (_, at) => `CRITICAL: finding ${at + 1}`);
    writeFileSync(transcriptPath, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: [
        "SPEC_CHECK_WAVE: 5",
        ...criticalLines,
        `SPEC_CHECK_CRITICAL_COUNT: ${reported}`,
        "SPEC_CHECK_HIGH_COUNT: 0",
        `SPEC_CHECK_VERDICT: ${reported === 0 ? "PASSED" : "BLOCKED"}`,
      ].join("\n") }] },
    }));
    const runId = parseOrchestrationRunId(`run.spec-floor-${reported}`);
    const slotId = parseSlotId(`wave-slot:spec-floor-${reported}`);
    if (!runId.ok || !slotId.ok) throw new Error("invalid floor authority fixture");
    writeFileSync(statePath, JSON.stringify({
      spec_trace_version: 2,
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: specPath, plan_file: null, current_wave: 5,
      tasks: [{
        id: "T1", description: "claims an undefined Requirement", agent: "code-implementer-agent",
        wave: 5, status: "completed", depends_on: [],
        spec_anchors: ["FR-404"], spec_contributions: [],
        file_list: ["src/a.ts"], files_modified: ["src/a.ts"],
      }],
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: runId.value, wave: 5,
        authorityDigest: "a".repeat(64), revision: 1, terminalOutcome: null,
      },
      wave_review_epoch: {
        runId: runId.value, wave: 5, batchEpoch: "b".repeat(64),
        specCheckDocuments: {
          spec: { path: specPath, contentDigest: specDigest },
          plan: { path: null, contentDigest: null },
        },
        specCheckSlotAuthority: { slot_id: slotId.value, attempted: 1 },
      },
    }));
    const session = `spec-check-floor-${reported}-${process.pid}-${Date.now()}`;
    await withTaskGraphPointer(session, statePath, async () => {
      await runStoreSpecCheckFindings(JSON.stringify({
        session_id: session,
        agent_type: "spec-check-invoker",
        agent_transcript_path: transcriptPath,
      }), [], { runId: runId.value, slotId: slotId.value, attempt: 1, role: "spec-check-invoker" });
    });
    const stored = JSON.parse(readFileSync(statePath, "utf8")).spec_check as Record<string, unknown>;
    rmSync(tmpDir, { recursive: true, force: true });
    return stored;
  }

  it("fails evidence capture when the report drops a row the engine settled", async () => {
    // The defect this closes: the engine settled FR-404 as CRITICAL, rendered
    // it into the packet, and then accepted a transcript claiming zero. The
    // Wave Gate opened on the model's own arithmetic.
    const stored = await storedSpecCheck(0);
    expect(stored).toMatchObject({ wave: 5, verdict: "EVIDENCE_CAPTURE_FAILED" });
    expect(String(stored.error)).toContain("the Requirement Coverage Projection settled");
    expect(String(stored.error)).toContain("re-run /wave-gate");
  });

  it("accepts a report that meets the floor", async () => {
    // FR-404 is the one settled CRITICAL: unknown-requirement, and no FR or AS
    // in the fixture goes unclaimed except the ones the Task does not name.
    const settled = 3; // FR-404 row + FR-001 unclaimed + AS-001 unclaimed
    const stored = await storedSpecCheck(settled);
    expect(stored).toMatchObject({ wave: 5, critical_count: settled });
    expect(stored.verdict).not.toBe("EVIDENCE_CAPTURE_FAILED");
  });
});

function withTaskGraphPointer<T>(session: string, statePath: string, run: () => Promise<T>): Promise<T> {
  return (async () => {
    const { SUBAGENT_DIR } = await import("../../src/config");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const pointer = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(pointer, statePath);
    try {
      return await run();
    } finally {
      rmSync(pointer, { force: true });
    }
  })();
}
