import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskGraph } from "../../src/types";
import {
  applyFailedPiResult,
  applyImplementationPiResult,
  applyPhaseAgentPiResult,
  applyReviewPiResult,
  applySpecCheckPiResult,
  piSubagentFailureSignals,
  resolveImplementationTaskId,
  writtenPathsOf,
  type PiSubagentResult,
  type TaskGraphStore,
} from "../../../pi/subagent-result";

/**
 * The concerns the Pi `tool_result` handler used to hold inline, exercised
 * through their ports.
 *
 * Every case here runs with an in-memory `TaskGraphStore` and no repository:
 * that is the whole point of the split. Before it, asserting "a malformed
 * transcript does not advance the phase" meant standing up a real StateManager,
 * a real git root, and a ~980-line closure whose unrelated branches all had to
 * be survivable first.
 */

const NOW = "2026-08-16T00:00:00.000Z";

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_dir: null,
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [],
    wave_gates: {},
    tasks: [{
      id: "T1",
      description: "a task",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      review_status: "pending",
      file_list: ["engine/src/x.ts"],
    }],
    ...overrides,
  } as TaskGraph;
}

/** An in-memory stand-in for StateManager: load, mutate, keep. */
function fakeStore(initial: TaskGraph): TaskGraphStore & { current: () => TaskGraph } {
  let state = initial;
  return {
    load: () => state,
    update: async (mutate) => { state = mutate(state); },
    current: () => state,
  };
}

const result = (overrides: Partial<PiSubagentResult> = {}): PiSubagentResult => ({
  agent: "code-reviewer",
  task: "Task: T1",
  exitCode: 0,
  messages: [],
  ...overrides,
});

const assistantText = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

const structuredBashPass = () => [
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-green-tests",
      name: "bash",
      arguments: { command: "bun test engine/tests/pi/subagent-result.test.ts" },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call-green-tests",
    toolName: "bash",
    isError: false,
    content: [{
      type: "text",
      text: "bun test v1.3.0\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file.\n",
    }],
  },
];

let toolCallSeq = 0;
const writeCall = (path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `call-${(toolCallSeq += 1)}`, name: "write", arguments: { path } }],
});

describe("writtenPathsOf", () => {
  it("reads write/Write tool-call paths in order and ignores everything else", () => {
    expect(writtenPathsOf([
      writeCall("a.md"),
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { path: "b.md" } }] },
      { role: "user", content: [{ type: "toolCall", id: "c3", name: "write", arguments: { path: "c.md" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "Write", arguments: { file_path: "d.md" } }] },
    ] as never)).toEqual(["a.md", "d.md"]);
  });
});

describe("resolveImplementationTaskId", () => {
  const base = { agentType: "code-implementer-agent", resultPrompt: "", parentPrompt: "", executingTasks: [] };

  it("prefers the reservation over either prompt", () => {
    expect(resolveImplementationTaskId({
      ...base,
      reservedTaskId: "T9",
      resultPrompt: "Task ID: T1",
      parentPrompt: "Task ID: T2",
    })).toEqual({ kind: "bound", taskId: "T9", inferred: false });
  });

  it("falls back to the result prompt, then the parent prompt", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, resultPrompt: "Task ID: T1" }))
      .toEqual({ kind: "bound", taskId: "T1", inferred: false });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, parentPrompt: "Task ID: T2" }))
      .toEqual({ kind: "bound", taskId: "T2", inferred: false });
  });

  it("infers a single executing task, and refuses an ambiguous or empty set", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5"] }))
      .toEqual({ kind: "bound", taskId: "T5", inferred: true });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5", "T6"] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("ambiguous") });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: [] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("executing_tasks is empty") });
  });
});

describe("applyPhaseAgentPiResult", () => {
  it("records a spec written inside the run's spec_dir", async () => {
    const store = fakeStore(graph({ current_phase: "specify", spec_dir: ".claude/specs/run" } as Partial<TaskGraph>));
    const applied = await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({ agent: "specify-agent", messages: [writeCall(".claude/specs/run/spec.md")] }),
      now: NOW,
    });

    expect(applied.processingErrors).toEqual([]);
    expect(store.current().spec_file).toBe(".claude/specs/run/spec.md");
  });

  it("does NOT record a traversal path the substring test used to accept", async () => {
    const store = fakeStore(graph({ current_phase: "specify", spec_dir: ".claude/specs/run" } as Partial<TaskGraph>));
    await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({
        agent: "specify-agent",
        messages: [writeCall(".claude/specs/run/../../../../tmp/evil/spec.md")],
      }),
      now: NOW,
    });

    expect(store.current().spec_file).toBeNull();
  });

  it("reports a malformed envelope and advances nothing", async () => {
    const store = fakeStore(graph({ current_phase: "specify" }));
    const applied = await applyPhaseAgentPiResult({
      store,
      agentType: "specify-agent",
      completedPhase: "specify",
      result: result({ agent: "specify-agent", messages: [{ role: 42 }] }),
      now: NOW,
    });

    expect(applied.processingErrors).toHaveLength(1);
    expect(applied.processingErrors[0]).toContain("phase artifact extraction failed");
    expect(store.current().current_phase).toBe("specify");
    expect(store.current().spec_file).toBeNull();
  });
});

describe("applyFailedPiResult", () => {
  it("stores an evidence failure against the reviewer's task", async () => {
    const store = fakeStore(graph());
    const applied = await applyFailedPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ exitCode: 1 }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      now: NOW,
    });

    expect(store.current().tasks[0]!.review_status).toBe("evidence_capture_failed");
    expect(applied.processingErrors).toEqual([]);
    expect(applied.log.join("\n")).toContain("T1");
  });

  it("says so and stores nothing when the reviewer names no known task", async () => {
    const store = fakeStore(graph());
    const applied = await applyFailedPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ exitCode: 1, task: "no task id here" }),
      reservedSlot: undefined,
      now: NOW,
    });

    expect(store.current().tasks[0]!.review_status).toBe("pending");
    expect(applied.log.join("\n")).toContain("review evidence NOT stored");
  });

  it("marks a failed spec-check as evidence_capture_failed", async () => {
    const store = fakeStore(graph());
    await applyFailedPiResult({
      store,
      agentType: "spec-check-invoker",
      result: result({ agent: "spec-check-invoker", exitCode: 1 }),
      reservedSlot: undefined,
      now: NOW,
    });

    expect(store.current().spec_check).toMatchObject({ verdict: "EVIDENCE_CAPTURE_FAILED", wave: 1 });
  });

  it("carries the harness failure signals into the stored diagnostic", async () => {
    const store = fakeStore(graph());
    const applied = await applyFailedPiResult({
      store,
      agentType: "code-reviewer",
      result: { ...result({ exitCode: 0 }), stopReason: "error", errorMessage: "Connection error." },
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      now: NOW,
    });

    expect(applied.log.join("\n")).toContain('exitCode=0, stopReason=error, errorMessage="Connection error."');
  });
});

/**
 * An infrastructure fault and an agent-contract fault must not read alike. The
 * fields that separate them are in scope wherever the diagnostic is composed;
 * the whole point of this helper is that none of them get dropped.
 */
describe("piSubagentFailureSignals", () => {
  it("reports the exit/stop pair and the harness cause line", () => {
    expect(piSubagentFailureSignals({ exitCode: 0, stopReason: "error", errorMessage: "Connection error." }))
      .toBe('exitCode=0, stopReason=error, errorMessage="Connection error."');
  });

  it("omits the cause line rather than printing an empty or absent one", () => {
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted" }))
      .toBe("exitCode=1, stopReason=aborted");
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted", errorMessage: "   " }))
      .toBe("exitCode=1, stopReason=aborted");
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted", errorMessage: { not: "a string" } }))
      .toBe("exitCode=1, stopReason=aborted");
  });

  it("degrades a malformed exit code or stop reason to n/a instead of undefined", () => {
    expect(piSubagentFailureSignals({})).toBe("exitCode=n/a, stopReason=n/a");
    expect(piSubagentFailureSignals({ exitCode: "1", stopReason: 7 })).toBe("exitCode=n/a, stopReason=n/a");
  });
});

describe("applyReviewPiResult", () => {
  const machineSummary = [
    "### Machine Summary",
    "CRITICAL_COUNT: 1",
    "ADVISORY_COUNT: 0",
    "CRITICAL: a real blocker",
  ].join("\n");

  it("stores findings against the named task", async () => {
    const store = fakeStore(graph());
    await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ messages: assistantText(machineSummary) }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      parentPrompt: "",
    });

    expect(store.current().tasks[0]).toMatchObject({
      review_status: "blocked",
      critical_findings: ["a real blocker"],
    });
  });

  it("refuses a task id the graph does not hold instead of reporting a silent store", async () => {
    const store = fakeStore(graph());
    const applied = await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ task: "Task: T77", messages: assistantText(machineSummary) }),
      reservedSlot: undefined,
      parentPrompt: "",
    });

    expect(applied.log.join("\n")).toContain("is not in the task graph");
    expect(store.current().tasks[0]!.review_status).toBe("pending");
  });

  it("records an evidence failure for malformed reviewer messages", async () => {
    const store = fakeStore(graph());
    await applyReviewPiResult({
      store,
      agentType: "code-reviewer",
      result: result({ messages: [{ role: 42 }] }),
      reservedSlot: { agentType: "code-reviewer", taskId: "T1" },
      parentPrompt: "",
    });

    expect(store.current().tasks[0]!.review_status).toBe("evidence_capture_failed");
  });
});

describe("applySpecCheckPiResult", () => {
  const specCheckText = (critical: number) => [
    "SPEC_CHECK_WAVE: 1",
    `SPEC_CHECK_CRITICAL_COUNT: ${critical}`,
    "SPEC_CHECK_HIGH_COUNT: 0",
    `SPEC_CHECK_VERDICT: ${critical > 0 ? "BLOCKED" : "PASSED"}`,
    ...(critical > 0 ? ["CRITICAL: requirement R1 is unimplemented"] : []),
  ].join("\n");

  it("derives blocked from the stored spec-check rather than asserting it", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: assistantText(specCheckText(1)) }),
      now: NOW,
    });

    expect(store.current().wave_gates["1"]).toMatchObject({ blocked: true });
  });

  it("leaves the gate unblocked when the spec-check reports no critical", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: assistantText(specCheckText(0)) }),
      now: NOW,
    });

    expect(store.current().wave_gates["1"]?.blocked ?? false).toBe(false);
  });

  it("marks malformed spec-check messages as evidence_capture_failed", async () => {
    const store = fakeStore(graph());
    await applySpecCheckPiResult({
      store,
      result: result({ agent: "spec-check-invoker", messages: [{ role: 42 }] }),
      now: NOW,
    });

    expect(store.current().spec_check).toMatchObject({ verdict: "EVIDENCE_CAPTURE_FAILED" });
  });
});

describe("applyImplementationPiResult", () => {
  /** A repository probe pointed at a root, with `isRepo` under test control. */
  const repositoryAt = (root: string, isRepo = true) => ({ root: () => root, isRepo: () => isRepo });

  const implementationGraph = (taskOverrides: Record<string, unknown> = {}): TaskGraph => {
    const base = graph({ executing_tasks: ["T1"] });
    return {
      ...base,
      tasks: [{ ...base.tasks[0]!, ...taskOverrides }],
    } as TaskGraph;
  };

  /**
   * The malformed-transcript branch has TWO exits keyed on whether bytes moved
   * since the attempt started. Only the `true` exit (full invalidation through
   * applyUntrustedStopResolution) was covered; this is the `false` one, where
   * the task must stay pending with the failure stamped on it.
   */
  it("stamps failure_reason and preserves pending when a malformed transcript changed no bytes", async () => {
    // A defined-but-empty attempt baseline compares clean, so nothing moved.
    const store = fakeStore(implementationGraph({ attempt_artifact_baseline: [] }));
    const outcome = await applyImplementationPiResult({
      store,
      repository: repositoryAt(process.cwd()),
      agentType: "code-implementer-agent",
      result: result({ agent: "code-implementer-agent", messages: "not a message array" }),
      reservedSlot: { agentType: "code-implementer-agent", taskId: "T1" },
      parentPrompt: "",
    });

    const task = store.current().tasks[0]!;
    expect(task.status).toBe("pending");
    expect(task.failure_reason).toContain("Pi transcript evidence capture failed");
    // Not routed through the untrusted resolution: no verdict was minted.
    expect(task.test_result).toBeUndefined();
    expect(store.current().executing_tasks).toEqual([]);
    // Reported on the log, not as a processing error: the capture failed but
    // the orchestration step itself completed and left the task retryable.
    expect(outcome.processingErrors).toEqual([]);
    expect(outcome.log.join("\n")).toContain("evidence was not accepted");
  });

  /**
   * `compareAttemptBaseline` failing is a documented fail-closed contract, but
   * nothing pinned the Pi bridge's WIRING to it — only the pure comparator was
   * tested. A dropped `comparisonFailures.push` would have been invisible.
   */
  it("reports the baseline comparison failure on the malformed-transcript path", async () => {
    const store = fakeStore(implementationGraph({
      // A baseline naming an artifact under a root that does not exist makes
      // the comparator throw, which it reports as a failure rather than "no
      // change" — the fail-closed direction.
      attempt_artifact_baseline: [{ artifact: "engine/src/x.ts", sha256: "a".repeat(64) }],
    }));
    const outcome = await applyImplementationPiResult({
      store,
      repository: repositoryAt("/nonexistent/loom-repo-root"),
      agentType: "code-implementer-agent",
      result: result({ agent: "code-implementer-agent", messages: "not a message array" }),
      reservedSlot: { agentType: "code-implementer-agent", taskId: "T1" },
      parentPrompt: "",
    });

    expect(outcome.log.join("\n")).toContain("cannot compare malformed-transcript attempt baseline for T1");
    // Fail-closed: an uncomparable baseline is treated as "bytes moved", so the
    // stale evidence is invalidated rather than preserved.
    expect(store.current().tasks[0]!.status).not.toBe("completed");
  });

  /**
   * The wave gate rejects the transcript fallback, so a null structured verdict
   * is a latent blocker the operator should hear about at the point it happens.
   */
  it("explains a well-formed transcript that produced no structured test evidence", async () => {
    const store = fakeStore(implementationGraph({ attempt_artifact_baseline: [] }));
    const outcome = await applyImplementationPiResult({
      store,
      repository: repositoryAt(process.cwd(), false),
      agentType: "code-implementer-agent",
      result: result({
        agent: "code-implementer-agent",
        messages: assistantText("I made the change but ran no tests."),
      }),
      reservedSlot: { agentType: "code-implementer-agent", taskId: "T1" },
      parentPrompt: "",
    });

    const logged = outcome.log.join("\n");
    expect(logged).toContain("produced no structured test evidence");
    expect(logged).toContain("no Bash call was classified as a test run");
    expect(logged).toContain("the wave gate will reject it");
  });

  it("accepts structured regression evidence while explicit policy waives only new tests", async () => {
    const store = fakeStore(implementationGraph({
      file_list: [],
      attempt_artifact_baseline: [],
      verification_policy: {
        regression: { kind: "required" },
        new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
      },
    }));

    await applyImplementationPiResult({
      store,
      repository: repositoryAt(process.cwd()),
      agentType: "code-implementer-agent",
      result: result({
        agent: "code-implementer-agent",
        messages: structuredBashPass(),
      }),
      reservedSlot: { agentType: "code-implementer-agent", taskId: "T1" },
      parentPrompt: "",
    });

    const task = store.current().tasks[0]!;
    expect(task.status).toBe("implemented");
    expect(task.new_tests_written).toBe(false);
    expect(task.new_test_evidence).toContain(
      "verification_policy.new_tests waived: existing-tests-sufficient",
    );
    expect(task.proof?.obligations).toEqual([
      { kind: "task-completed" },
      { kind: "regression-test-pass" },
    ]);
    expect(task.proof?.state).toBe("satisfied");
    if (task.proof?.state === "satisfied") {
      expect(task.proof.evidence).toContainEqual({
        kind: "regression-test-pass",
        provenance: "pi-structured",
        verdict: "untrusted-pass",
        label: expect.stringMatching(/^pi-structured: /),
      });
      expect(task.proof.evidence).not.toContainEqual(expect.objectContaining({ kind: "new-tests" }));
    }
  });

  it("accepts attributed new-test evidence without regression evidence when explicit policy waives only regression", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "loom-pi-inverse-policy-"));
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
      const store = fakeStore(implementationGraph({
        file_list: [],
        attempt_artifact_baseline: [],
        verification_policy: {
          regression: { kind: "waived", reason: "documentation-only" },
          new_tests: { kind: "required" },
        },
      }));

      await applyImplementationPiResult({
        store,
        repository: repositoryAt(repositoryRoot),
        agentType: "code-implementer-agent",
        result: result({
          agent: "code-implementer-agent",
          messages: [writeCall(testPath)],
        }),
        reservedSlot: { agentType: "code-implementer-agent", taskId: "T1" },
        parentPrompt: "",
      });

      const task = store.current().tasks[0]!;
      expect(task.test_result).toMatchObject({ verdict: "untrusted", passed: false });
      expect(task.new_tests_written).toBe(true);
      expect(task.new_test_evidence).toContain("1 new test methods, 1 assertions");
      expect(task.status).toBe("implemented");
      expect(task.proof?.obligations).toEqual([
        { kind: "task-completed" },
        { kind: "new-tests" },
      ]);
      expect(task.proof?.state).toBe("satisfied");
      if (task.proof?.state === "satisfied") {
        expect(task.proof.evidence).toContainEqual({
          kind: "new-tests",
          detail: expect.stringContaining("1 new test methods, 1 assertions"),
        });
        expect(task.proof.evidence).not.toContainEqual(
          expect.objectContaining({ kind: "regression-test-pass" }),
        );
      }
    } finally {
      if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
