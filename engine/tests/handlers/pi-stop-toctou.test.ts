/**
 * Tests for applyUntrustedStopResolution — the verdict-resolution decision
 * the pi extension's Stop handler runs INSIDE its locked mgr.update
 * (pi/extension.ts). The pre-lock skip guards are only a fast path: a
 * concurrent writer can outdate the snapshot before the write lands
 * (TOCTOU), so this pure re-check is the authoritative one. Pinned
 * directly (round-15): an untrusted pass must never overwrite a concurrent
 * trusted verdict or reopen a completed task — while executing_tasks is
 * still cleared, because the agent stopped either way.
 */

import { describe, it, expect } from "vitest";
import {
  applyUntrustedStopResolution,
  isWaveComplete,
  type UntrustedStopResolution,
} from "../../src/core/implementation-application";
import type { Task, TaskGraph, TaskTestResult } from "../../src/types";
import { taskFixture, type TaskFixtureInput } from "../fixtures/task-lifecycle";

const task = (overrides: Partial<TaskFixtureInput> & { id: string }): Task => taskFixture({
  description: "impl",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
  ...overrides,
});

const graph = (tasks: Task[], executing: string[]): TaskGraph => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  current_wave: 1,
  executing_tasks: executing,
  tasks,
  wave_gates: {},
});

const untrustedPass: UntrustedStopResolution = {
  taskCompleted: true,
  testResult: { verdict: "untrusted", passed: true, label: "pi-structured: bun: 5 pass", provenance: "pi-structured" },
  testEvidence: "pi-structured: bun: 5 pass",
  filesModified: ["src/a.ts", "tests/a.test.ts"],
  changedDeclaredArtifacts: ["src/a.ts", "tests/a.test.ts"],
  bytesChangedSinceAttempt: true,
  newTestsWritten: true,
  newTestEvidence: "2 new test methods, 4 assertions",
};

describe("applyUntrustedStopResolution — trust and freshness are re-checked atomically", () => {
  it("preserves a trusted failure while cumulative structural evidence lands", () => {
    const verdict: TaskTestResult = { verdict: "trusted-fail" };
    const s = graph([task({ id: "T1", status: "implemented", test_result: verdict })], ["T1", "T2"]);

    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(applied.skipped).toBe(false);
    const t1 = applied.state.tasks.find((t) => t.id === "T1")!;
    expect(t1.test_result).toEqual(verdict);
    expect(t1.status).toBe("pending");
    expect(t1.test_evidence).toBeUndefined();
    expect(t1.files_modified).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(applied.state.executing_tasks).toEqual(["T2"]);
  });

  it("invalidates a trusted pass when the retry changes code and the latest run fails", () => {
    const s = graph([task({
      id: "T1", status: "implemented", test_result: { verdict: "trusted-pass" },
      new_tests_required: true,
    })], ["T1"]);
    const latestFailure: UntrustedStopResolution = {
      ...untrustedPass,
      testResult: { verdict: "untrusted", passed: false, label: "pi-structured: bun: 1 fail", provenance: "pi-structured" },
      testEvidence: "pi-structured: bun: 1 fail",
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(s, "T1", latestFailure);

    expect(applied.skipped).toBe(false);
    expect(applied.state.tasks[0]).toMatchObject({
      status: "pending",
      test_result: latestFailure.testResult,
      test_evidence: latestFailure.testEvidence,
    });
    expect(applied.state.tasks[0]!.proof?.state).toBe("failed");
    expect(applied.state.wave_gates["1"].impl_complete).toBe(false);
  });

  it("does not let a failed child satisfy completion with retained artifact attribution", () => {
    const s = graph([task({
      id: "T1",
      status: "implemented",
      new_tests_required: false,
      file_list: ["src/a.ts"],
      files_modified: ["src/a.ts"],
    })], ["T1"]);
    const failedChild: UntrustedStopResolution = {
      ...untrustedPass,
      taskCompleted: false,
      testResult: { verdict: "untrusted", passed: false, label: "pi-implementation-failed", provenance: "unverified" },
      testEvidence: "implementation process failed",
      filesModified: [],
      changedDeclaredArtifacts: ["src/a.ts"],
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(s, "T1", failedChild);

    expect(applied.state.tasks[0]).toMatchObject({
      status: "pending",
      test_result: failedChild.testResult,
      files_modified: ["src/a.ts"],
    });
    expect(applied.state.tasks[0]!.proof?.state).toBe("failed");
    expect(applied.state.tasks[0]!.proof?.results).toContainEqual(expect.objectContaining({
      state: "failed",
      obligation: { kind: "task-completed" },
      failure: { kind: "task-not-completed" },
    }));
    expect(applied.state.wave_gates["1"].impl_complete).toBe(false);
  });

  it("retains a trusted pass as historical evidence without granting legacy positive authority", () => {
    const s = graph([task({
      id: "T1", status: "implemented", test_result: { verdict: "trusted-pass" },
      new_tests_required: false,
    })], ["T1"]);
    const noWriteFailure: UntrustedStopResolution = {
      ...untrustedPass,
      testResult: { verdict: "untrusted", passed: false, label: "no new run", provenance: "unverified" },
      testEvidence: "",
      filesModified: [],
      changedDeclaredArtifacts: [],
      bytesChangedSinceAttempt: false,
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(s, "T1", noWriteFailure);

    expect(applied.state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "failed" },
      revalidation_required: true,
      test_result: { verdict: "trusted-pass" },
    });
  });

  it("invalidates older evidence when bytes changed despite empty transcript attribution", () => {
    const s: TaskGraph = {
      ...graph([task({
        id: "T1",
        status: "implemented",
        test_result: { verdict: "trusted-pass" },
        new_tests_required: false,
        review_status: "passed",
      })], ["T1"]),
      spec_check: {
        wave: 1, run_at: "now", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    };
    const unobservedChange: UntrustedStopResolution = {
      ...untrustedPass,
      testResult: { verdict: "untrusted", passed: false, label: "no test run", provenance: "unverified" },
      testEvidence: "",
      filesModified: [],
      changedDeclaredArtifacts: [],
      bytesChangedSinceAttempt: true,
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(s, "T1", unobservedChange);

    expect(applied.state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "failed" },
      revalidation_required: true,
      review_status: "pending",
      test_result: unobservedChange.testResult,
    });
    expect(applied.state.spec_check).toBeUndefined();
    expect(applied.state.wave_gates["1"]).toMatchObject({
      tests_passed: null,
      reviews_complete: false,
    });
  });

  it("a completed task is never reopened; executing_tasks is still cleared", () => {
    const s = graph([task({ id: "T1", status: "completed" })], ["T1"]);

    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(applied.skipped).toBe(true);
    const t1 = applied.state.tasks.find((t) => t.id === "T1")!;
    expect(t1.status).toBe("completed");
    expect(t1.test_result).toBeUndefined();
    expect(applied.state.executing_tasks).toEqual([]);
  });

  it("a missing target skips (nothing to resolve) and still clears executing_tasks", () => {
    const s = graph([task({ id: "T2" })], ["T1"]);

    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(applied.skipped).toBe(true);
    expect(applied.state.tasks).toEqual(s.tasks);
    expect(applied.state.executing_tasks).toEqual([]);
  });

  it("an unresolved task takes the untrusted resolution and leaves executing_tasks", () => {
    const s = graph(
      [task({ id: "T1" }), task({ id: "T2", status: "completed" })],
      ["T1", "T3"],
    );

    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(applied.skipped).toBe(false);
    const t1 = applied.state.tasks.find((t) => t.id === "T1")!;
    expect(t1.status).toBe("pending");
    expect(t1.proof?.state).toBe("failed");
    expect(t1.revalidation_required).toBe(true);
    expect(t1.test_result).toEqual(untrustedPass.testResult);
    expect(t1.test_evidence).toBe(untrustedPass.testEvidence);
    // files_modified persists through the shared seam — lint-wave-gate
    // collects its lint targets EXCLUSIVELY from this field, so the pi path
    // (which resolves through this function) and the engine path (which
    // persists filesModified in its own locked update) agree (round-16 fix:
    // pi's omission made every wave-gate lint run over an empty set).
    expect(t1.files_modified).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(t1.new_test_observation).toEqual({
      kind: "written",
      written: true,
      evidence: untrustedPass.newTestEvidence,
    });
    expect(applied.state.executing_tasks).toEqual(["T3"]);
    expect(applied.state.wave_gates["1"].impl_complete).toBe(false);
    // Other tasks untouched.
    expect(applied.state.tasks.find((t) => t.id === "T2")).toEqual(s.tasks[1]);
  });

  it("unions retry writes, recomputes new-test evidence, and invalidates stale review/spec gates", () => {
    const initial = graph([task({
      id: "T1",
      files_modified: ["src/old.ts"],
      new_tests_written: true,
      new_test_evidence: "earlier test evidence",
      review_status: "evidence_capture_failed",
      review_error: "review transcript did not contain a machine summary",
      review_evidence_failures: ["code-reviewer"],
    })], ["T1"]);
    const s: TaskGraph = {
      ...initial,
      spec_check: {
        wave: 1, run_at: "now", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      wave_gates: { ...initial.wave_gates, "1": {
        impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false,
      } },
    };
    const retry: UntrustedStopResolution = {
      ...untrustedPass,
      filesModified: ["src/new.ts"],
      changedDeclaredArtifacts: [],
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(s, "T1", retry);
    const resolved = applied.state.tasks[0]!;

    expect(resolved.files_modified).toEqual(["src/new.ts", "src/old.ts"]);
    expect(resolved.new_test_observation).toEqual({
      kind: "not-written",
      written: false,
      evidence: "",
    });
    expect(resolved.review_status).toBe("pending");
    expect(resolved.review_error).toBeUndefined();
    expect(resolved.review_evidence_failures).toBeUndefined();
    expect(applied.state.spec_check).toBeUndefined();
    expect(applied.state.wave_gates["1"]).toMatchObject({
      tests_passed: null, reviews_complete: false,
    });
  });

  it("a failed re-resolution clears a stale impl_complete bit atomically", () => {
    const initial = graph([task({ id: "T1", status: "implemented" })], ["T1"]);
    const stale: TaskGraph = {
      ...initial,
      wave_gates: { ...initial.wave_gates, "1": {
        impl_complete: true, tests_passed: true, reviews_complete: false, blocked: false,
      } },
    };
    const failedResolution: UntrustedStopResolution = {
      ...untrustedPass,
      newTestsWritten: false,
      newTestEvidence: "",
    };

    const applied = applyUntrustedStopResolution(stale, "T1", failedResolution);

    expect(applied.skipped).toBe(false);
    expect(applied.state.tasks[0]!.status).toBe("pending");
    expect(applied.state.tasks[0]!.proof?.state).toBe("failed");
    expect(applied.state.wave_gates["1"].impl_complete).toBe(false);
  });

  it("an existing UNTRUSTED verdict is superseded (only trusted verdicts stand)", () => {
    const prior: TaskTestResult = { verdict: "untrusted", passed: false, label: "transcript-regex (fallback)", provenance: "unverified" };
    const s = graph([task({ id: "T1", status: "implemented", test_result: prior })], ["T1"]);

    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(applied.skipped).toBe(false);
    expect(applied.state.tasks.find((t) => t.id === "T1")!.test_result).toEqual(
      untrustedPass.testResult,
    );
  });

  it("never mutates the input state (pure)", () => {
    const s = graph([task({ id: "T1" })], ["T1"]);
    const frozen = JSON.parse(JSON.stringify(s));

    applyUntrustedStopResolution(s, "T1", untrustedPass);

    expect(s).toEqual(frozen);
  });
});

describe("isWaveComplete — the wave-completion predicate shared by engine and pi (round-16)", () => {
  it("complete when every wave task is implemented or completed", () => {
    const s = graph(
      [
        task({ id: "T1", status: "implemented" }),
        task({ id: "T2", status: "completed" }),
        task({ id: "T3", wave: 2, status: "pending" }), // other wave: ignored
      ],
      [],
    );
    expect(isWaveComplete(s, 1)).toBe(true);
  });

  it("incomplete while any wave task is pending or failed", () => {
    for (const status of ["pending", "failed"] as const) {
      const s = graph(
        [task({ id: "T1", status: "implemented" }), task({ id: "T2", status })],
        [],
      );
      expect(isWaveComplete(s, 1)).toBe(false);
    }
  });

  it("a wave with no tasks counts as complete (long-standing inlined semantics, now pinned)", () => {
    const s = graph([task({ id: "T1", wave: 1, status: "pending" })], []);
    expect(isWaveComplete(s, 7)).toBe(true);
  });

  it("keeps legacy cleanup outside the Wave implementation projection", () => {
    const s = graph(
      [task({ id: "T1" }), task({ id: "T2", status: "implemented" })],
      ["T1"],
    );
    expect(isWaveComplete(s, 1)).toBe(false);
    const applied = applyUntrustedStopResolution(s, "T1", untrustedPass);
    expect(applied.skipped).toBe(false);
    expect(isWaveComplete(applied.state, 1)).toBe(false);
  });
});
