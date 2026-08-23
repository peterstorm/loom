/**
 * Round-10 Fix 7 + gap 17:
 * - machine-bound agents don't self-report completion: unmet terminal
 *   requirements (missingRequirements over the epoch fold) cap a
 *   trusted-pass at untrusted, labeled "machine-incomplete: <reqs>"
 * - the ambiguous multi-task inference branch: no extractable task ID with
 *   several executing tasks clears executing_tasks and touches no task
 */

import { execFileSync } from "node:child_process";
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capVerdictForMachineCompletion,
  runUpdateTaskStatus,
} from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import { parseEpoch } from "../../../src/machine";
import type { EvidenceRecord, Requirement } from "../../../src/machine";
import { reportSummary } from "../../machine/report-summary";

const run = `uts-machine-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;

let dirs: string[] = [];
let sessionFiles: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-uts-machine-"));
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
  delete process.env.LOOM_MACHINES_DIR;
  vi.restoreAllMocks();
});

function writeState(
  dir: string,
  tasks: Array<Record<string, unknown>>,
  executing: string[],
): string {
  const statePath = join(dir, "active_task_graph.json");
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: executing,
    tasks,
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  }));
  return statePath;
}

const implTask = (id: string, newTestsRequired = true): Record<string, unknown> => ({
  id, description: "impl", agent: "code-implementer-agent",
  wave: 1, status: "pending", depends_on: [], new_tests_required: newTestsRequired,
});

function pointSessionAt(session: string, statePath: string): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = `${SUBAGENT_DIR}/${session}.task_graph`;
  writeFileSync(pointer, statePath);
  sessionFiles.push(pointer);
}

/** A machine whose terminal phase demands TWO trusted passes — one trusted
 *  pass then resolves trusted-pass while missingRequirements stays non-empty,
 *  exercising the cap. */
function writeStrictMachine(): void {
  const machines = tempDir();
  writeFileSync(join(machines, "code-implementer-agent.machine.json"), JSON.stringify({
    agent: "code-implementer-agent",
    enforcedTools: ["Edit", "Write", "MultiEdit"],
    phases: [
      { id: "work", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 2 } },
      { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 2 }] },
    ],
  }));
  process.env.LOOM_MACHINES_DIR = machines;
}

const stopInput = (s: string) =>
  JSON.stringify({ session_id: s, agent_id: "a-1", agent_type: "code-implementer-agent" });

describe("capVerdictForMachineCompletion (pure)", () => {
  const missing: Requirement[] = [{ event: "TestRunPassed", min: 2 }];
  const trustedPass = { result: { verdict: "trusted-pass" as const }, evidence: "ledger: exit 0" };

  it("caps a trusted-pass at untrusted with a machine-incomplete label naming the requirements", () => {
    const capped = capVerdictForMachineCompletion(trustedPass, missing);
    expect(capped.result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "machine-incomplete: TestRunPassed ≥ 2", provenance: "unverified" as const,
    });
    expect(capped.evidence).toContain("machine-incomplete: TestRunPassed ≥ 2");
    expect(capped.evidence).toContain("ledger: exit 0");
  });

  it("no missing requirements → resolution untouched", () => {
    expect(capVerdictForMachineCompletion(trustedPass, [])).toBe(trustedPass);
  });

  it("a trusted-fail is ground truth of non-completion — never rewritten", () => {
    const fail = { result: { verdict: "trusted-fail" as const }, evidence: "ledger: exit 1" };
    expect(capVerdictForMachineCompletion(fail, missing)).toBe(fail);
  });

  it("untrusted resolutions are already at the floor — untouched", () => {
    const untrusted = {
      result: { verdict: "untrusted" as const, passed: true, label: "transcript-regex (fallback)", provenance: "unverified" as const },
      evidence: "vitest: Tests 5 passed",
    };
    expect(capVerdictForMachineCompletion(untrusted, missing)).toBe(untrusted);
  });
});

describe("machine terminal requirements gate the persisted verdict (Fix 7)", () => {
  it("a trusted-pass with unmet requirements lands as untrusted machine-incomplete", async () => {
    writeStrictMachine();
    const s = sid("incomplete");
    const dir = tempDir();
    const statePath = writeState(dir, [implTask("T1")], ["T1"]);
    pointSessionAt(s, statePath);

    // One trusted pass — enough for resolveTestEvidence's trusted-pass, NOT
    // enough for the strict machine's TestRunPassed ≥ 2 terminal requirement.
    const snapshot: readonly EvidenceRecord[] = [{
      epoch: parseEpoch("a-1:code-implementer-agent")!,
      event: { kind: "TestRun", command: "npm test", exit: 0, report: reportSummary(5, 0) },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");
    expect(text).toContain("unmet terminal requirements");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.tasks[0].test_result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "machine-incomplete: TestRunPassed ≥ 2", provenance: "unverified" as const,
    });
  }, 30000);

  it("control: requirements met → the trusted-pass persists untouched", async () => {
    writeStrictMachine();
    const s = sid("complete");
    const dir = tempDir();
    const statePath = writeState(dir, [implTask("T1")], ["T1"]);
    pointSessionAt(s, statePath);

    const epoch = parseEpoch("a-1:code-implementer-agent")!;
    const pass = { kind: "TestRun" as const, command: "npm test", exit: 0, report: reportSummary(5, 0) };
    const snapshot: readonly EvidenceRecord[] = [
      { epoch, event: pass },
      { epoch, event: pass },
    ];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
  }, 30000);
});

describe("wave-completion gate write (round-17 A1 pin)", () => {
  const pass = { kind: "TestRun" as const, command: "npm test", exit: 0, report: reportSummary(3, 0) };

  it("resolving the last task of a wave stamps impl_complete=true", async () => {
    const s = sid("wave-done");
    const dir = tempDir();
    const statePath = writeState(dir, [implTask("T1", false)], ["T1"]);
    pointSessionAt(s, statePath);

    const snapshot: readonly EvidenceRecord[] = [
      { epoch: parseEpoch("a-1:code-implementer-agent")!, event: pass },
    ];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    expect(state.wave_gates["1"].impl_complete).toBe(true);
  }, 30000);

  it("a still-pending sibling leaves impl_complete=false", async () => {
    const s = sid("wave-partial");
    const dir = tempDir();
    // T1 executing and resolved; T2 still pending in the same wave.
    const statePath = writeState(dir, [implTask("T1", false), implTask("T2")], ["T1"]);
    pointSessionAt(s, statePath);

    const snapshot: readonly EvidenceRecord[] = [
      { epoch: parseEpoch("a-1:code-implementer-agent")!, event: pass },
    ];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks.find((t: { id: string }) => t.id === "T1").status).toBe("implemented");
    expect(state.tasks.find((t: { id: string }) => t.id === "T2").status).toBe("pending");
    expect(state.wave_gates["1"].impl_complete).toBe(false);
  }, 30000);

  it("settles with regression required while explicit policy waives only new tests", async () => {
    const s = sid("asymmetric-policy");
    const dir = tempDir();
    const task = {
      ...implTask("T1"),
      new_tests_required: undefined,
      verification_policy: {
        regression: { kind: "required" },
        new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
      },
    };
    const statePath = writeState(dir, [task], ["T1"]);
    pointSessionAt(s, statePath);

    const snapshot: readonly EvidenceRecord[] = [
      { epoch: parseEpoch("a-1:code-implementer-agent")!, event: pass },
    ];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: snapshot });
    stderrSpy.mockRestore();

    expect(result.kind).toBe("passthrough");
    const persisted = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(persisted.status).toBe("implemented");
    expect(persisted.new_tests_written).toBe(false);
    expect(persisted.new_test_evidence).toContain(
      "verification_policy.new_tests waived: existing-tests-sufficient",
    );
    expect(persisted.proof.obligations).toEqual([
      { kind: "task-completed" },
      { kind: "regression-test-pass" },
    ]);
    expect(persisted.proof.state).toBe("satisfied");
    expect(persisted.proof.evidence).toContainEqual({
      kind: "regression-test-pass",
      provenance: "evidence-ledger",
      verdict: "trusted-pass",
    });
    expect(persisted.proof.evidence).not.toContainEqual(expect.objectContaining({ kind: "new-tests" }));
  }, 30000);

  it("settles with attributed new-test evidence and no regression evidence when explicit policy waives only regression", async () => {
    const s = sid("inverse-asymmetric-policy");
    const repositoryRoot = tempDir();
    const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const testPath = "tests/inverse-policy.test.ts";
    mkdirSync(join(repositoryRoot, "tests"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
    writeFileSync(join(repositoryRoot, testPath), "export {};\n");
    execFileSync("git", ["add", testPath], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Loom Tests", "-c", "user.email=loom@example.test", "commit", "-m", "baseline"],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
    writeFileSync(
      join(repositoryRoot, testPath),
      'export {};\n\n  it("covers the change", () => {\n    expect(true).toBe(true);\n  });\n',
    );
    process.env.CLAUDE_PROJECT_DIR = repositoryRoot;

    try {
      const task = {
        ...implTask("T1"),
        new_tests_required: undefined,
        file_list: [],
        verification_policy: {
          regression: { kind: "waived", reason: "documentation-only" },
          new_tests: { kind: "required" },
        },
      };
      const statePath = writeState(repositoryRoot, [task], ["T1"]);
      pointSessionAt(s, statePath);
      const transcriptPath = join(repositoryRoot, "agent-transcript.jsonl");
      writeFileSync(transcriptPath, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "**Task ID:** T1\n\nAdded the required test." },
            { type: "tool_use", name: "Write", input: { file_path: testPath } },
          ],
        },
      }) + "\n");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await runUpdateTaskStatus(JSON.stringify({
        session_id: s,
        agent_id: "a-1",
        agent_type: "code-implementer-agent",
        agent_transcript_path: transcriptPath,
      }), [], { kind: "snapshot", events: [] });
      stderrSpy.mockRestore();

      expect(result.kind).toBe("passthrough");
      const persisted = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
      expect(persisted.test_result).toMatchObject({ verdict: "untrusted", passed: false });
      expect(persisted.new_tests_written).toBe(true);
      expect(persisted.new_test_evidence).toContain("1 new test methods, 1 assertions");
      expect(persisted.status).toBe("implemented");
      expect(persisted.proof.obligations).toEqual([
        { kind: "task-completed" },
        { kind: "new-tests" },
      ]);
      expect(persisted.proof.state).toBe("satisfied");
      expect(persisted.proof.evidence).toContainEqual({
        kind: "new-tests",
        detail: expect.stringContaining("1 new test methods, 1 assertions"),
      });
      expect(persisted.proof.evidence).not.toContainEqual(
        expect.objectContaining({ kind: "regression-test-pass" }),
      );
    } finally {
      if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
    }
  }, 30000);
});

describe("ambiguous multi-task inference branch (gap 17)", () => {
  it("no extractable task ID + several executing tasks → warn, clear executing_tasks, touch no task", async () => {
    const s = sid("ambiguous");
    const dir = tempDir();
    const statePath = writeState(dir, [implTask("T1"), implTask("T2")], ["T1", "T2"]);
    pointSessionAt(s, statePath);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // No transcript at all → extractTaskId finds nothing.
    const result = await runUpdateTaskStatus(stopInput(s), [], { kind: "snapshot", events: [] });
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(result.kind).toBe("passthrough");
    expect(text).toContain("2 tasks executing (ambiguous)");

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.executing_tasks).toEqual([]);
    // NEVER marked failed/implemented — the old cascade this branch prevents.
    expect(state.tasks.map((t: { status: string }) => t.status)).toEqual(["pending", "pending"]);
    expect(state.tasks.every((t: { test_result?: unknown }) => t.test_result === undefined)).toBe(true);
  }, 30000);
});
