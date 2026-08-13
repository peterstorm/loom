import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import completeWaveGateHandler, {
  applyGateDecision,
  checkImplementationProof,
  createCompleteWaveGateHandler,
  checkTestEvidence,
  checkNewTests,
  checkReviews,
  checkSpecAlignment,
  checkCriticalFindings,
  computeNextWave,
  evaluateWaveGate,
  generateWaveGateSummary,
  gateCheckMessage,
  notificationCauseMessage,
  parseWaveArg,
  persistWaveGateSummaryFallback,
  postWaveGateSummary,
  renderLoomStatusHuman,
  renderLoomStatusJson,
  snapshotGateDeps,
  updateGitHubIssue,
  type GateDeps,
  type GitHubIssuePort,
  type GateIO,
} from "../../src/handlers/helpers/complete-wave-gate";
import type { CapturedSpecCheck, Task, TaskGraph } from "../../src/types";
import { derivePendingTaskProof, evaluateTaskProof } from "../../src/core/proof-obligations";
import {
  commitWaveGateCompletion,
  createWaveGateState,
  WAVE_REVIEW_AGENTS,
  deriveLoomStatus,
  deriveLoomStatusFromParsedGraph,
  deriveNextAction,
  deriveWaveAdvisoryNextAction,
  deriveWaveReadiness,
  deriveWaveRefutationPlan,
  deriveWaveReviewRecovery,
  evaluateWaveGate as evaluateCoreWaveGate,
  prepareWaveRefutationPanel,
  prepareWaveReviewBatch,
  publishWaveReviewBatch,
  proveWaveGateNextAction,
  reduceWaveGate,
  renderLoomStatusHuman as renderCoreLoomStatusHuman,
  renderLoomStatusJson as renderCoreLoomStatusJson,
  type GateDeps as CoreGateDeps,
  type WaveGateEvent,
  type WaveGateState,
} from "../../src/core/wave-gate-machine";
import {
  blockedAction,
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  doneAction,
  infrastructureRetryDiagnostic,
  parseAgentRosterSlot,
  parseArtifactDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  terminalBlockedDiagnostic,
  type AgentRequestAuthority,
  type CommitProtectedWaveState,
  type EffectReceipt,
} from "../../src/core/orchestration-contract";
import {
  deriveLegacyWaveGateCompatibilityAuthority,
  findLegacyWaveGateCompletionReplay,
  findRegisteredWaveGateCompletionReplay,
  parseActiveWaveGateRegistration,
  parseTaskGraph,
  StateManager,
} from "../../src/state-manager";

const satisfiedProof = evaluateTaskProof(
  { newTestsRequired: true, declaredArtifacts: [] },
  {
    taskCompleted: true,
    testResult: { verdict: "trusted-pass" },
    filesModified: [],
    newTestsWritten: true,
  },
);
if (satisfiedProof.state !== "satisfied") throw new Error("test fixture proof must be satisfied");

const baseTask: Task = {
  id: "T1",
  description: "test",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  proof: satisfiedProof,
  depends_on: [],
  test_result: { verdict: "trusted-pass" },
  test_evidence: "vitest: Tests 5 passed",
  new_tests_written: true,
  new_test_evidence: "1 new test, 1 assertion",
  review_status: "passed",
  critical_findings: [],
  advisory_findings: [],
};

describe("wave-gate durable summary fallback", () => {
  it("writes the documented fallback path", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-summary-"));
    try {
      const path = persistWaveGateSummaryFallback(3, "wave summary\n", root);
      expect(path).toBe(join(root, ".claude", "reviews", "wave-3-review.md"));
      expect(readFileSync(path, "utf-8")).toBe("wave summary\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked fallback leaf without modifying its target", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-summary-root-"));
    const outside = mkdtempSync(join(tmpdir(), "loom-wave-summary-outside-"));
    const sentinel = join(outside, "sentinel.md");
    writeFileSync(sentinel, "do not overwrite\n");
    mkdirSync(join(root, ".claude", "reviews"), { recursive: true });
    symlinkSync(sentinel, join(root, ".claude", "reviews", "wave-4-review.md"));
    try {
      expect(() => persistWaveGateSummaryFallback(4, "escaped\n", root))
        .toThrow("must not traverse a symlink");
      expect(readFileSync(sentinel, "utf-8")).toBe("do not overwrite\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("GitHub issue notification port", () => {
  const state = (repository = "owner/repo; echo unsafe"): TaskGraph => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    github_issue: 42,
    github_repo: repository,
    tasks: [baseTask],
    wave_gates: {},
  });

  it("updates checkboxes and forwards repository identity as one typed value", () => {
    const calls: unknown[][] = [];
    const port: GitHubIssuePort = {
      readBody: (issue, repository) => {
        calls.push(["read", issue, repository]);
        return "- [ ] T1: implement\n";
      },
      editBody: (issue, body, repository) => { calls.push(["edit", issue, body, repository]); },
      postComment: () => {},
    };
    updateGitHubIssue(state(), ["T1"], port);
    expect(calls).toEqual([
      ["read", 42, "owner/repo; echo unsafe"],
      ["edit", 42, "- [x] T1: implement\n", "owner/repo; echo unsafe"],
    ]);
  });

  it("normalizes Error, primitive, and hostile unknown notification causes", () => {
    expect(notificationCauseMessage(new Error("offline"))).toBe("offline");
    expect(notificationCauseMessage("socket closed")).toBe("socket closed");
    expect(notificationCauseMessage(undefined)).toBe("[no notification failure cause provided]");
    expect(notificationCauseMessage(null)).toBe("[no notification failure cause provided]");
    expect(notificationCauseMessage({ toString: () => { throw new Error("hostile"); } }))
      .toBe("[uninspectable thrown notification cause]");
  });

  it("posts through a fake and writes the durable fallback when the port fails", () => {
    const comments: unknown[][] = [];
    const success: GitHubIssuePort = {
      readBody: () => "",
      editBody: () => {},
      postComment: (issue, body, repository) => { comments.push([issue, body, repository]); },
    };
    postWaveGateSummary(state("owner/repo"), 1, success);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toEqual([42, expect.stringContaining("Wave 1"), "owner/repo"]);

    const root = mkdtempSync(join(tmpdir(), "loom-wave-summary-port-"));
    const failure: GitHubIssuePort = {
      readBody: () => "",
      editBody: () => {},
      postComment: () => { throw new Error("offline"); },
    };
    try {
      postWaveGateSummary(state(), 1, failure, root);
      expect(readFileSync(join(root, ".claude", "reviews", "wave-1-review.md"), "utf-8"))
        .toContain("Wave 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkImplementationProof (pure)", () => {
  it("requires both an implementation-bearing status and satisfied proof", () => {
    const failedProof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: ["missing.ts"] },
      { taskCompleted: true, filesModified: [] },
    );
    expect(checkImplementationProof([baseTask]).passed).toBe(true);
    for (const task of [
      { ...baseTask, status: "pending" as const },
      { ...baseTask, status: "pending" as const, proof: failedProof },
      { ...baseTask, proof: undefined },
    ]) {
      const result = checkImplementationProof([task]);
      expect(result.passed).toBe(false);
      expect(gateCheckMessage(result)).toContain("T1");
    }
  });
});

describe("checkTestEvidence (pure)", () => {
  it("passes when all tasks have test evidence", () => {
    const result = checkTestEvidence([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("fails when task has a trusted failure", () => {
    const result = checkTestEvidence([{ ...baseTask, test_result: { verdict: "trusted-fail" } }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("FAILED");
    expect(gateCheckMessage(result)).toContain("T1");
  });

  it("fails when task has no test result at all", () => {
    const result = checkTestEvidence([{ ...baseTask, test_result: undefined }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("T1");
  });

  it("fails on an untrusted result that did not claim a pass", () => {
    const result = checkTestEvidence([
      { ...baseTask, test_result: { verdict: "untrusted", passed: false, label: "transcript-regex (fallback)" } },
    ]);
    expect(result.passed).toBe(false);
  });

  it("passes on a labeled untrusted pass (honest tiering — trust gating is separate)", () => {
    const result = checkTestEvidence([
      { ...baseTask, test_result: { verdict: "untrusted", passed: true, label: "transcript-regex (fallback)" } },
    ]);
    expect(result.passed).toBe(true);
  });

  it("passes when task has new_tests_required=false (e.g. ADR writer)", () => {
    const adrTask: Task = {
      ...baseTask,
      id: "T-ADR-1",
      new_tests_required: false,
      test_result: { verdict: "trusted-fail" },
      test_evidence: undefined,
    };
    const result = checkTestEvidence([adrTask]);
    expect(result.passed).toBe(true);
    expect(gateCheckMessage(result)).toContain("not required");
  });
});

describe("checkNewTests (pure)", () => {
  it("passes when all tasks have new tests", () => {
    const result = checkNewTests([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("passes when task has new_tests_required=false", () => {
    const task = { ...baseTask, new_tests_required: false, new_tests_written: false };
    const result = checkNewTests([task]);
    expect(result.passed).toBe(true);
  });

  it("fails when task missing new tests", () => {
    const task = { ...baseTask, new_tests_written: false, new_tests_required: undefined };
    const result = checkNewTests([task]);
    expect(result.passed).toBe(false);
  });
});

describe("checkReviews (pure)", () => {
  it("passes when all tasks reviewed", () => {
    const result = checkReviews([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("passes with blocked review (still reviewed)", () => {
    const result = checkReviews([{ ...baseTask, review_status: "blocked" }]);
    expect(result.passed).toBe(true);
  });

  it("fails for pending review", () => {
    const result = checkReviews([{ ...baseTask, review_status: "pending" }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("Unreviewed");
  });

  it("reports evidence_capture_failed separately", () => {
    const result = checkReviews([{ ...baseTask, review_status: "evidence_capture_failed" }]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("Evidence capture failed");
  });
});

describe("checkCriticalFindings (pure)", () => {
  it("passes with no critical findings", () => {
    const result = checkCriticalFindings([baseTask]);
    expect(result.passed).toBe(true);
  });

  it("fails with critical findings", () => {
    const task = { ...baseTask, critical_findings: ["SQL injection", "XSS"] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("2 critical");
  });

  it("handles undefined critical_findings", () => {
    const task = { ...baseTask, critical_findings: undefined };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(true);
  });

  it("filters empty strings in critical_findings array", () => {
    const task = { ...baseTask, critical_findings: ["", "  ", "Real finding"] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("1 critical");
    expect(gateCheckMessage(result)).toContain("Real finding");
    expect(gateCheckMessage(result)).not.toContain('""');
  });

  it("passes when critical_findings only contains empty strings", () => {
    const task = { ...baseTask, critical_findings: ["", "  ", "   "] };
    const result = checkCriticalFindings([task]);
    expect(result.passed).toBe(true);
  });
});

describe("checkSpecAlignment (pure)", () => {
  const captured = (overrides: Partial<CapturedSpecCheck> = {}): CapturedSpecCheck => ({
    wave: 1,
    run_at: "",
    verdict: "PASSED",
    critical_count: 0,
    high_count: 0,
    critical_findings: [],
    high_findings: [],
    medium_findings: [],
    ...overrides,
  });
  const mkState = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  });

  it("fails closed when no spec-check data exists", () => {
    const result = checkSpecAlignment(mkState(), 1);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("missing for wave 1");
    expect(gateCheckMessage(result)).toContain("/spec-check");
  });

  it("fails when spec-check for different wave", () => {
    const state = mkState({
      spec_check: captured({ wave: 1 }),
    });
    const result = checkSpecAlignment(state, 2);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("wave 1");
    expect(gateCheckMessage(result)).toContain("not 2");
  });

  it("passes when spec-check matches wave with no criticals", () => {
    const state = mkState({
      spec_check: captured({ wave: 2 }),
    });
    const result = checkSpecAlignment(state, 2);
    expect(result.passed).toBe(true);
  });

  it("fails when spec-check has critical findings", () => {
    const state = mkState({
      spec_check: captured({
        verdict: "BLOCKED",
        critical_count: 2,
        critical_findings: ["drift", "missing"],
      }),
    });
    const result = checkSpecAlignment(state, 1);
    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("2 critical");
  });

  for (const verdict of ["UNKNOWN", "BLOCKED"] as const) {
    it(`fails when a zero-critical spec-check verdict is ${verdict}`, () => {
      const result = checkSpecAlignment(mkState({ spec_check: captured({ verdict }) }), 1);
      expect(result.passed).toBe(false);
      expect(gateCheckMessage(result)).toContain(`verdict is ${verdict}`);
    });
  }

  // The `captured()` helper cannot produce this verdict — an evidence failure
  // carries a cause and NO counts, which is the whole point of the separate
  // arm — so this branch had no covering case at the wave-gate layer. It is the
  // fail-closed contract the whole review harness rests on: missing evidence
  // must block the wave rather than read as zero findings.
  it("blocks the wave when spec-check evidence capture failed", () => {
    const state = mkState({
      spec_check: {
        wave: 1,
        run_at: "",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "SPEC_CHECK_CRITICAL_COUNT marker not found",
      },
    });

    const result = checkSpecAlignment(state, 1);

    expect(result.passed).toBe(false);
    expect(gateCheckMessage(result)).toContain("unusable");
    expect(gateCheckMessage(result)).toContain("EVIDENCE_CAPTURE_FAILED");
    // The cause must survive into the operator-facing message, or a re-run is
    // the only way to learn what went wrong.
    expect(gateCheckMessage(result)).toContain("SPEC_CHECK_CRITICAL_COUNT marker not found");
  });

  it("blocks an evidence-failed spec-check before the wave-mismatch check can excuse it", () => {
    const state = mkState({
      spec_check: {
        wave: 2,
        run_at: "",
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "transcript truncated",
      },
    });

    // Wrong wave AND unusable: either way the gate refuses; what must never
    // happen is a pass.
    expect(checkSpecAlignment(state, 1).passed).toBe(false);
    expect(checkSpecAlignment(state, 2).passed).toBe(false);
  });
});

describe("computeNextWave (pure)", () => {
  const mkTask = (wave: number): Task => ({
    ...baseTask,
    id: `T${wave}`,
    wave,
  });

  it("computes next wave from contiguous waves", () => {
    expect(computeNextWave([mkTask(1), mkTask(2), mkTask(3)], 1)).toBe(2);
    expect(computeNextWave([mkTask(1), mkTask(2), mkTask(3)], 2)).toBe(3);
  });

  it("computes next wave from non-contiguous waves", () => {
    expect(computeNextWave([mkTask(1), mkTask(3), mkTask(5)], 1)).toBe(3);
    expect(computeNextWave([mkTask(1), mkTask(3), mkTask(5)], 3)).toBe(5);
  });

  it("returns null when no next wave", () => {
    expect(computeNextWave([mkTask(1), mkTask(2)], 2)).toBeNull();
    expect(computeNextWave([mkTask(1)], 1)).toBeNull();
  });

  it("returns null for empty tasks", () => {
    expect(computeNextWave([], 1)).toBeNull();
  });
});

describe("generateWaveGateSummary (pure)", () => {
  const mkTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    ...baseTask,
    id,
    description: `Task ${id}`,
    test_evidence: "5 tests passed",
    ...overrides,
  });

  it("generates summary with spec check and tasks", () => {
    const tasks = [
      mkTask("T1", { critical_findings: [], advisory_findings: ["Refactor suggestion"] }),
      mkTask("T2", { critical_findings: [], advisory_findings: [] }),
    ];

    const specCheck: CapturedSpecCheck = {
      wave: 1,
      run_at: "2024-01-01",
      verdict: "PASSED",
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: ["Minor drift in validation"],
    };

    const summary = generateWaveGateSummary(1, tasks, specCheck);

    expect(summary).toContain("## Wave 1 — Gate Passed");
    expect(summary).toContain("### Spec Alignment: PASSED (0 critical)");
    expect(summary).toContain("- MEDIUM: Minor drift in validation");
    expect(summary).toContain("### Code Review");
    expect(summary).toContain("#### T1: Task T1");
    expect(summary).toContain("**Status:** passed — 0 critical, 1 advisory");
    expect(summary).toContain("<details>");
    expect(summary).toContain("<summary>1 advisories</summary>");
    expect(summary).toContain("- Refactor suggestion");
    expect(summary).toContain("### Tests");
    expect(summary).toContain("- T1: 5 tests passed");
  });

  it("generates summary without spec check", () => {
    const tasks = [mkTask("T1")];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).toContain("## Wave 1 — Gate Passed");
    expect(summary).not.toContain("### Spec Alignment");
    expect(summary).toContain("### Code Review");
    expect(summary).toContain("### Tests");
  });

  it("handles tasks with no advisories", () => {
    const tasks = [mkTask("T1", { advisory_findings: [] })];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).not.toContain("<details>");
    expect(summary).toContain("**Status:** passed — 0 critical, 0 advisory");
  });

  it("handles tasks with no test evidence", () => {
    const tasks = [mkTask("T1", { test_evidence: undefined })];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).toContain("- T1: no evidence");
  });

  it("truncates long task descriptions", () => {
    const longDesc = "A".repeat(100);
    const tasks = [mkTask("T1", { description: longDesc })];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).toContain("#### T1: " + "A".repeat(60));
    expect(summary).not.toContain("A".repeat(61));
  });

  it("includes multiple advisories in details", () => {
    const tasks = [
      mkTask("T1", {
        advisory_findings: ["Advisory 1", "Advisory 2", "Advisory 3"],
      }),
    ];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).toContain("<summary>3 advisories</summary>");
    expect(summary).toContain("- Advisory 1");
    expect(summary).toContain("- Advisory 2");
    expect(summary).toContain("- Advisory 3");
  });

  it("preserves advisory findings in summary even when empty criticals", () => {
    const tasks = [
      mkTask("T1", {
        critical_findings: [],
        advisory_findings: ["Keep this advisory"],
      }),
    ];
    const summary = generateWaveGateSummary(1, tasks);

    expect(summary).toContain("Keep this advisory");
  });

  it("audits every refuted finding with every refuting lens and reason", () => {
    const tasks = [mkTask("T1", {
      critical_findings: [],
      refuted_findings: [{
        finding: {
          id: "code-reviewer-1",
          agent: "code-reviewer",
          severity: "critical",
          file: "src/x.ts",
          line: 7,
          claim: "reported blocker",
        },
        refutations: [
          { lens: "reproduction", reason: "the guard makes the path unreachable" },
          { lens: "intent", reason: "the fallback is documented architecture" },
        ],
      }],
    })];

    const summary = generateWaveGateSummary(1, tasks);
    expect(summary).toContain("<summary>1 refuted critical findings</summary>");
    expect(summary).toContain("- code-reviewer-1: reported blocker");
    expect(summary).toContain("  - reproduction: the guard makes the path unreachable");
    expect(summary).toContain("  - intent: the fallback is documented architecture");
  });
});

describe("evaluateWaveGate + applyGateDecision — fs resolved once before the lock, checks on locked state", () => {
  const specCheck = (wave: number): CapturedSpecCheck => ({
    wave,
    run_at: "",
    verdict: "PASSED",
    critical_count: 0,
    high_count: 0,
    critical_findings: [],
    high_findings: [],
    medium_findings: [],
  });

  const mkGraph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    spec_check: specCheck(1),
    tasks: [baseTask, { ...baseTask, id: "T2", wave: 2 }],
    wave_gates: { "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false } },
    active_wave_gate: {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: authorityValue(parseOrchestrationRunId("evaluate-wave-run")),
      wave: 1,
      authorityDigest: authorityValue(parseArtifactDigest("e".repeat(64))),
      revision: 0,
      terminalOutcome: null,
    },
    ...overrides,
  });

  const countingDeps = () => {
    const calls = { loadPlanModels: 0, fileExists: 0 };
    const deps: GateDeps = {
      loadPlanModels: () => {
        calls.loadPlanModels++;
        return { kind: "none" };
      },
      fileExists: () => {
        calls.fileExists++;
        return true;
      },
    };
    return { deps, calls };
  };

  it("snapshotGateDeps resolves the fs seams exactly once — evaluation and (re)application repeat no I/O", () => {
    const calls = { loadPlanModels: 0, fileExists: 0 };
    const io: GateIO = {
      loadPlanModels: () => {
        calls.loadPlanModels++;
        return {
          kind: "loaded",
          models: {
            lifecycles: [{ id: "LC-1", title: "Order", machineFile: "src/order-machine.ts" }],
            pipeline: null,
            invariants: [],
            strays: [],
          },
        };
      },
      fileExists: () => {
        calls.fileExists++;
        return true;
      },
    };
    const state = mkGraph({
      plan_file: "plan.md",
      tasks: [{ ...baseTask, file_list: ["src/order-machine.ts"] }],
    });

    // All fs inputs resolve at snapshot time, BEFORE the state lock…
    const deps = snapshotGateDeps(state, io);
    expect(calls).toEqual({ loadPlanModels: 1, fileExists: 1 });

    // …so evaluating (even repeatedly, as a retried update callback would)
    // and applying never touch the seams again.
    const decision = evaluateWaveGate(state, null, deps);
    const again = evaluateWaveGate(state, null, deps);
    const once = applyGateDecision(state, decision);
    const twice = applyGateDecision(state, decision);
    expect(calls).toEqual({ loadPlanModels: 1, fileExists: 1 });
    expect(decision.verdict.kind).toBe("pass");
    expect(again).toEqual(decision);
    expect(twice).toEqual(once);
  });

  it("snapshotGateDeps fails closed for paths outside the snapshot", () => {
    const deps = snapshotGateDeps(mkGraph(), {
      loadPlanModels: () => ({ kind: "none" }),
      fileExists: () => true,
    });
    expect(deps.fileExists("/never/resolved.ts")).toBe(false);
  });

  it("snapshotGateDeps stats suffix-matched task file_list variants too (plan/task path divergence)", () => {
    // Plan declares src/machines/x.machine.json; the task file_list carries
    // engine/src/machines/x.machine.json and the artifact exists ONLY there.
    const statted: string[] = [];
    const state = mkGraph({
      plan_file: "plan.md",
      tasks: [{ ...baseTask, file_list: ["engine/src/machines/x.machine.json"] }],
    });
    const deps = snapshotGateDeps(state, {
      loadPlanModels: () => ({
        kind: "loaded",
        models: {
          lifecycles: [{ id: "LC-1", title: "X", machineFile: "src/machines/x.machine.json" }],
          pipeline: null,
          invariants: [],
          strays: [],
        },
      }),
      fileExists: (p) => {
        statted.push(p);
        return p === "engine/src/machines/x.machine.json";
      },
    });
    expect(statted).toContain("src/machines/x.machine.json");
    expect(statted).toContain("engine/src/machines/x.machine.json");

    // …and the full evaluation counts the variant as the artifact: the gate passes.
    const decision = evaluateWaveGate(state, null, deps);
    expect(decision.verdict.kind).toBe("pass");
  });

  it("snapshotGateDeps.loadPlanModels fails CLOSED when asked for a different plan than it snapshotted", () => {
    const deps = snapshotGateDeps(mkGraph({ plan_file: "plan.md" }), {
      loadPlanModels: () => ({ kind: "none" }),
      fileExists: () => true,
    });
    // The snapshotted path is served…
    expect(deps.loadPlanModels("plan.md")).toEqual({ kind: "none" });
    // …any other path is a drift, never silently answered from the snapshot.
    const drifted = deps.loadPlanModels("other-plan.md");
    expect(drifted.kind).toBe("unreadable");
    if (drifted.kind === "unreadable") {
      expect(drifted.path).toBe("other-plan.md");
      expect(drifted.error).toContain("drift");
      expect(drifted.error).toContain("plan.md");
    }
  });

  it("a task-state change AFTER the deps snapshot is honored by evaluation (SubagentStop lands before the lock)", () => {
    // Deps are snapshotted from the pre-lock read of a PASSING state…
    const preRead = mkGraph();
    const deps = snapshotGateDeps(preRead, {
      loadPlanModels: () => ({ kind: "none" }),
      fileExists: () => true,
    });

    // …then a SubagentStop lands before the locked update: T1 now carries a
    // trusted failure. Evaluation runs on the LOCKED state, so the gate
    // must fail — never force-complete the wave from the stale pre-read.
    const locked = mkGraph({
      tasks: [
        { ...baseTask, test_result: { verdict: "trusted-fail" } },
        { ...baseTask, id: "T2", wave: 2 },
      ],
    });
    const decision = evaluateWaveGate(locked, null, deps);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("T1");
    }
    expect(applyGateDecision(locked, decision)).toBe(locked); // no-op, nothing stamped
  });

  it("fails closed while any selected-wave task is still executing", () => {
    const state = mkGraph({ executing_tasks: ["T1"] });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);

    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("wave tasks still executing: T1");
    }
    expect(gateCheckMessage(decision.checks[0]!)).toContain("T1");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("does not let an executing task from another wave block the selected wave", () => {
    const decision = evaluateWaveGate(
      mkGraph({ executing_tasks: ["T2"] }),
      1,
      countingDeps().deps,
    );

    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: 2 });
  });

  it("a failed proof can never be force-completed into an unloadable graph", () => {
    const failedProof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: ["missing.ts"] },
      { taskCompleted: true, filesModified: [] },
    );
    const state = mkGraph({
      tasks: [{ ...baseTask, status: "pending", proof: failedProof, new_tests_required: false }],
    });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
    expect(gateCheckMessage(decision.checks[1]!)).toContain("proof=failed");
    expect(gateCheckMessage(decision.checks[1]!)).toContain("declared-artifact-not-changed:missing.ts");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("a passing decision carries the wave's task ids and the next wave", () => {
    const decision = evaluateWaveGate(mkGraph(), null, countingDeps().deps);
    expect(decision.wave).toBe(1);
    expect(decision.checks).toHaveLength(8);
    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: 2 });
  });

  it("applyGateDecision completes the wave, stamps every gate invariant, and is idempotent", () => {
    const state = mkGraph({
      wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
    });
    const frozen = JSON.parse(JSON.stringify(state));
    const decision = evaluateWaveGate(state, null, countingDeps().deps);

    const updated = applyGateDecision(state, decision);
    expect(state).toEqual(frozen); // input untouched
    expect(updated.tasks.find((t) => t.id === "T1")?.status).toBe("completed");
    expect(updated.tasks.find((t) => t.id === "T2")?.status).toBe("implemented"); // other waves untouched
    expect(updated.wave_gates["1"]).toMatchObject({
      impl_complete: true,
      tests_passed: true,
      reviews_complete: true,
      blocked: false,
    });
    expect(updated.wave_gates["2"]).toBeDefined();
    expect(updated.current_wave).toBe(2);
    expect(applyGateDecision(updated, decision)).toEqual(updated);
  });

  it("a failing decision names the first failing check and applies as a no-op", () => {
    const state = mkGraph({
      tasks: [{ ...baseTask, test_result: { verdict: "trusted-fail" } }],
    });
    const decision = evaluateWaveGate(state, null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("test evidence");
    }
    expect(applyGateDecision(state, decision)).toBe(state); // unchanged, same reference
  });

  it("always rejects an explicit Wave that disagrees with protected current/active authority", () => {
    const decision = evaluateWaveGate(
      mkGraph({ current_wave: 1, spec_check: specCheck(2) }),
      2,
      countingDeps().deps,
    );
    expect(decision.wave).toBe(2);
    expect(decision.verdict).toMatchObject({ kind: "fail" });
    if (decision.verdict.kind === "fail") expect(decision.verdict.reason).toContain("does not match protected current_wave");
  });

  it("an EMPTY wave fails — never a vacuous pass that stamps the gate", () => {
    const decision = evaluateWaveGate(mkGraph(), 7, countingDeps().deps);
    expect(decision.wave).toBe(7);
    expect(decision.checks).toHaveLength(0);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("does not match protected current_wave");
    }
    // …and applying the failing decision is a no-op: nothing completed,
    // no wave_gates["7"] stamped.
    const state = mkGraph();
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("an empty task graph fails the same way (unpopulated graph)", () => {
    const decision = evaluateWaveGate(mkGraph({ tasks: [] }), null, countingDeps().deps);
    expect(decision.verdict.kind).toBe("fail");
  });
});

describe("parseWaveArg — an unvalidated Number() would gate wave NaN vacuously", () => {
  it("parses a positive integer and returns null when absent", () => {
    expect(parseWaveArg(["--wave", "2"])).toBe(2);
    expect(parseWaveArg([])).toBeNull();
    expect(parseWaveArg(["--wave"])).toBeNull();
  });

  it("throws on non-numeric, non-integer, and sub-1 values", () => {
    for (const bad of ["abc", "NaN", "1.5", "0", "-1", "Infinity"]) {
      expect(() => parseWaveArg(["--wave", bad]), bad).toThrow("Invalid --wave value");
    }
  });
});

const authorityValue = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`invalid test authority: ${JSON.stringify(result.error)}`);
  return result.value;
};

function testNonEmpty<T>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("test fixture must be non-empty");
  return [first, ...rest];
}

const lifecycleRunId = authorityValue(parseOrchestrationRunId("wave-gate-lifecycle-test"));
const lifecycleEffectId = authorityValue(parseEffectId("wave-gate-effect-test"));
const infrastructureDiagnostic = authorityValue(infrastructureRetryDiagnostic({
  category: "infrastructure-failure",
  runId: lifecycleRunId,
  effectId: lifecycleEffectId,
  message: "retry the durable publication effect",
}));
const recoveryIntent: CommitProtectedWaveState = {
  kind: "commit-protected-wave-state",
  effectId: lifecycleEffectId,
  runId: lifecycleRunId,
  expectedRevision: 0,
  stateDigest: authorityValue(parseArtifactDigest("a".repeat(64))),
};
const recoveryReceipt = {
  kind: "protected-wave-state-committed",
  effectId: lifecycleEffectId,
  runId: lifecycleRunId,
  committedRevision: 1,
  stateDigest: authorityValue(parseArtifactDigest("a".repeat(64))),
} as EffectReceipt;

function lifecycleCompletionReadiness() {
  const graph = registeredGraph();
  const registration = graph.active_wave_gate!;
  return authorityValue(deriveWaveReadiness({
    ...graph,
    active_wave_gate: { ...registration, runId: lifecycleRunId },
  }, statusDeps));
}

function lifecycleCompletionEvent(): Extract<WaveGateEvent, { kind: "completion-committed" }> {
  const readiness = lifecycleCompletionReadiness();
  const committed = authorityValue(commitWaveGateCompletion(readiness));
  return { kind: "completion-committed", readiness, receipt: committed.receipt };
}

function lifecycleInitialState() {
  return authorityValue(createWaveGateState(lifecycleCompletionReadiness()));
}

function lifecycleStates(): readonly WaveGateState[] {
  const preparing = lifecycleInitialState();
  const awaitingReview = authorityValue(reduceWaveGate(preparing, { kind: "preparation-published" }));
  const awaitingRefutation = authorityValue(reduceWaveGate(awaitingReview, { kind: "complete-roster-with-criticals" }));
  const awaitingAdvisory = authorityValue(reduceWaveGate(awaitingRefutation, { kind: "complete-roster-with-advisories" }));
  const ready = authorityValue(reduceWaveGate(awaitingAdvisory, { kind: "advisory-decision-accepted" }));
  const done = authorityValue(reduceWaveGate(ready, lifecycleCompletionEvent()));
  const terminal = authorityValue(reduceWaveGate(awaitingReview, { kind: "result-rejected", attempt: 2 }));
  const recoverable = authorityValue(reduceWaveGate(awaitingRefutation, {
    kind: "recoverable-effect-failed",
    diagnostic: infrastructureDiagnostic,
    intent: recoveryIntent,
  }));
  return [preparing, awaitingReview, awaitingRefutation, awaitingAdvisory, ready, recoverable, done, terminal];
}

function lifecycleEvents(): readonly WaveGateEvent[] {
  return [
    { kind: "preparation-published" },
    { kind: "result-accepted", completeness: "incomplete" },
    { kind: "result-rejected", attempt: 1 },
    { kind: "result-rejected", attempt: 2 },
    { kind: "complete-roster-with-criticals" },
    { kind: "complete-roster-with-advisories" },
    { kind: "complete-roster-clean" },
    { kind: "advisory-decision-accepted" },
    lifecycleCompletionEvent(),
    { kind: "recoverable-effect-failed", diagnostic: infrastructureDiagnostic, intent: recoveryIntent },
    { kind: "recovery-receipt-accepted", receipt: recoveryReceipt },
  ];
}

const reduceWaveGateAtRuntime = reduceWaveGate as unknown as (
  state: WaveGateState,
  event: WaveGateEvent,
) => Readonly<{ ok: boolean; value?: WaveGateState; error?: unknown }>;

function transitionDeclared(state: WaveGateState, event: WaveGateEvent): boolean {
  if (state.kind === "done" || state.kind === "terminal-blocked") return false;
  if (event.kind === "recoverable-effect-failed") return true;
  if (state.kind === "recoverable-blocked") return event.kind === "recovery-receipt-accepted";
  if (state.kind === "preparing") return event.kind === "preparation-published";
  if (state.kind === "awaiting-review-results") {
    return event.kind === "result-accepted" || event.kind === "result-rejected" ||
      event.kind === "complete-roster-with-criticals" || event.kind === "complete-roster-with-advisories" ||
      event.kind === "complete-roster-clean";
  }
  if (state.kind === "awaiting-refutation") {
    return event.kind === "complete-roster-with-advisories" || event.kind === "complete-roster-clean";
  }
  if (state.kind === "awaiting-advisory-decision") return event.kind === "advisory-decision-accepted";
  return event.kind === "completion-committed";
}

describe("LC-1 Wave Gate lifecycle reducer", () => {
  it("makes undeclared transitions unrepresentable at concrete typed call sites", () => {
    const preparing = lifecycleInitialState();
    if (Date.now() < 0) {
      // @ts-expect-error LC-1 declares completion only from ready-to-complete.
      reduceWaveGate(preparing, lifecycleCompletionEvent());
    }
    expect(preparing.kind).toBe("preparing");
  });

  it("implements the exact declared transitions, including terminal attempt 2", () => {
    const preparing = lifecycleInitialState();
    const awaiting = authorityValue(reduceWaveGate(preparing, { kind: "preparation-published" }));
    expect(reduceWaveGate(awaiting, { kind: "result-rejected", attempt: 1 })).toMatchObject({
      ok: true,
      value: { kind: "awaiting-review-results" },
    });
    expect(reduceWaveGate(awaiting, { kind: "result-rejected", attempt: 2 })).toMatchObject({
      ok: true,
      value: { kind: "terminal-blocked", reason: "semantic-attempt-2-rejected" },
    });
  });

  it("records and restores the exact recoverable predecessor only for a matching receipt", () => {
    const awaiting = lifecycleStates().find((state) => state.kind === "awaiting-refutation")!;
    const blocked = authorityValue(reduceWaveGate(awaiting, {
      kind: "recoverable-effect-failed",
      diagnostic: infrastructureDiagnostic,
      intent: recoveryIntent,
    }));
    expect(blocked).toMatchObject({ kind: "recoverable-blocked", predecessor: { kind: "awaiting-refutation" } });
    expect(authorityValue(reduceWaveGate(blocked, { kind: "recovery-receipt-accepted", receipt: recoveryReceipt }))).toMatchObject({
      kind: "awaiting-refutation",
      runId: lifecycleRunId,
    });
    expect(reduceWaveGate(blocked, {
      kind: "recovery-receipt-accepted",
      receipt: { ...recoveryReceipt, effectId: authorityValue(parseEffectId("wrong-effect")) } as EffectReceipt,
    })).toMatchObject({ ok: false, error: { reason: "recovery-receipt-mismatch" } });
  });

  it("property: every undeclared state/event pair rejects and every declared pair is accepted", () => {
    const states = lifecycleStates();
    fc.assert(fc.property(
      fc.constantFrom(...states),
      fc.constantFrom(...lifecycleEvents()),
      (state, event) => {
        const before = JSON.stringify(state);
        const result = reduceWaveGateAtRuntime(state, event);
        expect(result.ok).toBe(transitionDeclared(state, event));
        expect(JSON.stringify(state)).toBe(before);
      },
    ), { numRuns: 500 });
  });

  it("keeps terminal states monotonic for every late event", () => {
    for (const terminal of lifecycleStates().filter((state) => state.kind === "done" || state.kind === "terminal-blocked")) {
      for (const event of lifecycleEvents()) {
        expect(reduceWaveGateAtRuntime(terminal, event)).toMatchObject({ ok: false, error: { reason: "terminal-state" } });
      }
    }
  });

  it("rejects forged readiness, wrong-run/revision/digest receipts, and ineligible completion", () => {
    const preparing = lifecycleInitialState();
    const awaiting = authorityValue(reduceWaveGate(preparing, { kind: "preparation-published" }));
    const ready = authorityValue(reduceWaveGate(awaiting, { kind: "complete-roster-clean" }));
    const valid = lifecycleCompletionEvent();

    expect(reduceWaveGateAtRuntime(ready, {
      ...valid,
      readiness: { ...valid.readiness },
    } as WaveGateEvent)).toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });
    for (const receipt of [
      { ...valid.receipt, runId: authorityValue(parseOrchestrationRunId("foreign-wave-run")) },
      { ...valid.receipt, committedRevision: valid.receipt.committedRevision + 1 },
      { ...valid.receipt, stateDigest: authorityValue(parseArtifactDigest("f".repeat(64))) },
    ]) {
      expect(reduceWaveGateAtRuntime(ready, { ...valid, receipt } as WaveGateEvent))
        .toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });
    }

    const graph = registeredGraph({ tasks: [{ ...baseTask, test_result: { verdict: "trusted-fail" } }] });
    const ineligible = authorityValue(deriveWaveReadiness(graph, statusDeps));
    const ineligibleReceipt = {
      kind: "protected-wave-state-committed" as const,
      effectId: ineligible.completionIntent.effectId,
      runId: ineligible.registration.runId,
      committedRevision: ineligible.registration.revision + 1,
      stateDigest: ineligible.readinessDigest,
    };
    const ineligibleReady = authorityValue(createWaveGateState(ineligible));
    const ineligibleAwaiting = authorityValue(reduceWaveGate(ineligibleReady, { kind: "preparation-published" }));
    const ineligibleCompletionState = authorityValue(reduceWaveGate(ineligibleAwaiting, { kind: "complete-roster-clean" }));
    expect(reduceWaveGate(ineligibleCompletionState, {
      kind: "completion-committed",
      readiness: ineligible,
      receipt: ineligibleReceipt,
    })).toMatchObject({ ok: false, error: { reason: "completion-ineligible" } });
  });

  it("rejects a recoverable failure diagnostic for another run and a matching-id receipt of the wrong kind", () => {
    const preparing = lifecycleInitialState();
    const foreignRun = authorityValue(parseOrchestrationRunId("foreign-recovery-run"));
    const foreignDiagnostic = authorityValue(infrastructureRetryDiagnostic({
      category: "infrastructure-failure",
      runId: foreignRun,
      effectId: lifecycleEffectId,
      message: "foreign",
    }));
    expect(reduceWaveGate(preparing, {
      kind: "recoverable-effect-failed",
      diagnostic: foreignDiagnostic,
      intent: recoveryIntent,
    })).toMatchObject({ ok: false, error: { reason: "authority-mismatch" } });

    const blocked = authorityValue(reduceWaveGate(preparing, {
      kind: "recoverable-effect-failed",
      diagnostic: infrastructureDiagnostic,
      intent: recoveryIntent,
    }));
    expect(reduceWaveGate(blocked, {
      kind: "recovery-receipt-accepted",
      receipt: {
        kind: "agent-requests-reserved",
        runId: lifecycleRunId,
        effectId: lifecycleEffectId,
        requestIds: [authorityValue(parseRequestId("wrong-kind-request"))],
      },
    })).toMatchObject({ ok: false, error: { reason: "recovery-receipt-mismatch" } });
  });
});

const statusDeps: CoreGateDeps = {
  loadPlanModels: () => ({ kind: "none" }),
  fileExists: () => true,
};

function registeredGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const parsed = parseTaskGraph({
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    spec_check: {
      wave: 1,
      run_at: "now",
      verdict: "PASSED",
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    },
    tasks: [baseTask],
    wave_gates: {},
    active_wave_gate: {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: "status-wave-run",
      wave: 1,
      authorityDigest: "b".repeat(64),
      revision: 0,
      terminalOutcome: null,
    },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.value, ...overrides };
}

describe("canonical Wave Gate readiness and LoomStatus", () => {
  it("derives the complete fact inventory and completion from the same snapshot", () => {
    const graph = registeredGraph();
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    expect(readiness.value.gateDecision).toEqual(evaluateCoreWaveGate(graph, 1, statusDeps));
    const resumeDecision = deriveNextAction(readiness.value);
    expect(resumeDecision.action).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "engine-resume-required", retry: { eligible: true } },
    });
    expect(deriveLoomStatus(readiness.value).next).toEqual(resumeDecision);

    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
    expect(status.schemaVersion).toBe(1);
    expect(Object.keys(status.facts)).toEqual([
      "location", "tasks", "failedProofObligations", "testReadiness", "reviewRuns", "findingCounts",
      "refutationPanelNeed", "waveGateCompletionEligibility",
    ]);
    expect(status.facts.location).toEqual({ kind: "known", value: { activePhase: "execute", activeWave: 1 } });
    expect(status.facts.tasks).toMatchObject({ kind: "known", value: { counts: { implemented: 1 } } });
    expect(status.facts.waveGateCompletionEligibility).toMatchObject({ kind: "known", value: { kind: "eligible" } });
    expect(status.next.action).toMatchObject({
      kind: "blocked",
      diagnostic: {
        kind: "engine-resume-required",
        retry: { kind: "engine-resume", eligible: true, consumesSemanticAttempt: false },
        recovery: { kind: "resume-orchestration", runId: graph.active_wave_gate!.runId },
      },
    });
    expect(status.next.reasons.some((entry) => entry.kind === "completion-eligible")).toBe(true);
    expect(status.next.reasons.some((entry) => entry.kind === "engine-resume-required" && entry.message.includes("retry eligible"))).toBe(true);
  });

  it("partitions every Task exactly once and reports roster/evidence/finding gaps", () => {
    const pendingProof = derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: [] });
    const tasks: Task[] = [
      { ...baseTask, id: "T1", wave: 1, status: "completed" },
      { ...baseTask, id: "T2", wave: 2, status: "pending", proof: pendingProof, review_status: "pending",
        review_generation: 1,
        review_run: {
          generation: 1, packet_id: "packet-2", head_sha: "head", prior_finding_ids: [],
          expected_agents: ["code-reviewer", "comment-analyzer"],
          evidence: [{ agent: "code-reviewer", prior_assessments: [], new_findings: [] }],
        } },
      { ...baseTask, id: "T3", wave: 2, status: "failed", proof: undefined,
        review_status: "evidence_capture_failed", review_error: "malformed summary",
        review_evidence_failures: ["type-design-analyzer"] },
      { ...baseTask, id: "T4", wave: 2, status: "implemented" },
      { ...baseTask, id: "T5", wave: 2, status: "pending", proof: pendingProof, review_status: "pending",
        critical_findings: ["critical"], advisory_findings: ["advisory"],
        refuted_findings: [{
          finding: { id: "old-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "old" },
          refutations: [{ lens: "intent", reason: "false positive" }],
        }],
        resolved_findings: [{
          finding: { id: "old-2", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "fixed" },
          resolution: {
            kind: "resolved_by_remediation", generation: 1, packet_id: "packet", head_sha: "head",
            expected_agents: ["code-reviewer"],
            assessments: [{ agent: "code-reviewer", finding_id: "old-2", verdict: "resolved_by_remediation", reason: "fixed" }],
          },
        }] },
    ];
    const graph = registeredGraph({ tasks, executing_tasks: ["T2"] });
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    const facts = readiness.value.facts;
    expect(facts.tasks).toEqual({
      kind: "known",
      value: { counts: { pending: 1, running: 1, implemented: 1, blocked: 1, completed: 1 } },
    });
    expect(facts.reviewRuns).toMatchObject({
      kind: "known",
      value: {
        rosterGaps: [{ taskId: "T2", agent: "comment-analyzer" }],
        evidenceFailures: [{ taskId: "T3", agent: "type-design-analyzer", error: "malformed summary" }],
      },
    });
    expect(facts.findingCounts).toEqual({ kind: "known", value: { activeCritical: 1, advisory: 1, resolved: 1, refuted: 1 } });
    if (facts.tasks.kind === "known") {
      expect(Object.values(facts.tasks.value.counts).reduce((sum, count) => sum + count, 0)).toBe(graph.tasks.length);
    }
  });

  it("uses wave-scoped canonical Finding identities when two Tasks emit the same Finding id", () => {
    const shared = {
      id: "code-reviewer-1",
      agent: "code-reviewer",
      severity: "critical" as const,
      file: null,
      line: null,
      claim: "same local reviewer identity",
    };
    const graph = registeredGraph({
      tasks: [
        { ...baseTask, id: "T1", findings: [shared], critical_findings: [shared.claim], advisory_findings: [] },
        { ...baseTask, id: "T2", findings: [shared], critical_findings: [shared.claim], advisory_findings: [] },
      ],
    });
    const snapshot = authorityValue(deriveWaveReadiness(graph, statusDeps));
    expect(snapshot.facts.refutationPanelNeed).toEqual({
      kind: "known",
      value: {
        kind: "needed",
        findingIds: ["T1:code-reviewer-1", "T2:code-reviewer-1"],
        reasons: ["2 active critical Finding(s) require refutation"],
      },
    });
    expect(new Set((snapshot.facts.refutationPanelNeed as { value: { findingIds: readonly string[] } }).value.findingIds).size).toBe(2);
    expect(authorityValue(deriveWaveRefutationPlan(snapshot)).findings.map(({ id }) => id)).toEqual([
      "T1:code-reviewer-1",
      "T2:code-reviewer-1",
    ]);
  });

  it("reports a parsed non-execute Phase with activeWave null instead of inventing Wave authority", () => {
    const parsed = parseTaskGraph({ current_phase: "specify", phase_artifacts: {}, skipped_phases: [] });
    const status = deriveLoomStatusFromParsedGraph(parsed, statusDeps);
    expect(status.facts.location).toEqual({
      kind: "known",
      value: { activePhase: "specify", activeWave: null },
    });
    expect(status.facts.waveGateCompletionEligibility).toMatchObject({
      kind: "known",
      value: { kind: "ineligible" },
    });
    expect(status.next.action.kind).toBe("blocked");
  });

  it("malformed authority keeps every category present but unavailable and returns only blocked", () => {
    const malformed = parseTaskGraph({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      tasks: [], wave_gates: {}, active_wave_gate: { schemaVersion: 99 },
    });
    expect(malformed.ok).toBe(false);
    const status = deriveLoomStatusFromParsedGraph(malformed, statusDeps);
    expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable")).toBe(true);
    expect(status.next.action).toMatchObject({
      kind: "blocked",
      diagnostic: {
        kind: "terminal-blocked",
        category: "invalid-authority",
        retry: { kind: "not-retryable", eligible: false },
        recovery: { kind: "inspect-run-and-stop" },
      },
    });
    expect(status.next.reasons).toHaveLength(1);
    expect(status.next.reasons[0].message).toContain("malformed");
  });

  it("makes every status category unavailable for missing, stale, or mismatched active authority", () => {
    const base = registeredGraph();
    const cases: TaskGraph[] = [
      { ...base, current_wave: undefined },
      (() => { const { active_wave_gate: _removed, ...missing } = base; return missing; })(),
      { ...base, current_wave: 2 },
    ];
    for (const graph of cases) {
      const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
      expect(Object.values(status.facts).every((entry) => entry.kind === "unavailable")).toBe(true);
      expect(status.next.action).toMatchObject({
        kind: "blocked",
        diagnostic: { kind: "terminal-blocked", retry: { eligible: false } },
      });
    }
  });

  it("reports terminal blocked from persisted terminal authority", () => {
    const base = registeredGraph();
    const diagnostic = authorityValue(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: base.active_wave_gate!.runId,
      message: "persisted terminal",
    }));
    const graph = {
      ...base,
      active_wave_gate: { ...base.active_wave_gate!, terminalOutcome: { kind: "terminal-blocked" as const, diagnostic } },
    };
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, statusDeps);
    expect(status.next.action).toMatchObject({ kind: "blocked", diagnostic: { message: "persisted terminal" } });
    expect(status.next.reasons).toEqual([{ kind: "blocked-diagnostic", message: "persisted terminal", taskId: null }]);
  });

  it("directly rejects lifecycle-proven next-action authority from a foreign run", () => {
    const graph = registeredGraph();
    const foreignRun = authorityValue(parseOrchestrationRunId("foreign-status-run"));
    const foreignGraph = registeredGraph({
      active_wave_gate: { ...graph.active_wave_gate!, runId: foreignRun },
    });
    const foreignSnapshot = authorityValue(deriveWaveReadiness(foreignGraph, statusDeps));
    const foreignState = authorityValue(createWaveGateState(foreignSnapshot));
    const foreignTerminal = authorityValue(reduceWaveGate(
      authorityValue(reduceWaveGate(foreignState, { kind: "preparation-published" })),
      { kind: "result-rejected", attempt: 2 },
    ));
    const diagnostic = authorityValue(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: foreignRun,
      message: "foreign terminal",
    }));
    const action = authorityValue(blockedAction(diagnostic));
    const proven = authorityValue(proveWaveGateNextAction(foreignSnapshot, foreignTerminal, action));
    const readiness = deriveWaveReadiness(graph, statusDeps, proven, foreignTerminal);
    expect(readiness).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });
  });

  it("renders versioned human and machine status from the same complete value", () => {
    const status = deriveLoomStatusFromParsedGraph({ ok: true, value: registeredGraph() }, statusDeps);
    const json = renderLoomStatusJson(status);
    expect(renderCoreLoomStatusJson(status)).toBe(json);
    expect(JSON.parse(json)).toEqual(status);
    const human = renderLoomStatusHuman(status);
    expect(renderCoreLoomStatusHuman(status)).toBe(human);
    for (const category of Object.keys(status.facts)) expect(human).toContain(category);
    expect(human).toContain(`nextAction: ${status.next.action.kind}`);
    for (const entry of status.next.reasons) expect(human).toContain(entry.message);
  });

  it("rejects pre-commit done proof but accepts terminal blocked only at its exact lifecycle checkpoint", () => {
    const snapshot = lifecycleCompletionReadiness();
    const doneState = lifecycleStates().find((state) => state.kind === "done")!;
    const done = authorityValue(doneAction(doneState.runId, {
      runId: doneState.runId,
      slot: "artifacts/wave-result.json",
      digest: "9".repeat(64),
      byteLength: 12,
    }));
    const provenDone = authorityValue(proveWaveGateNextAction(snapshot, doneState, done));
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, provenDone, doneState)).toMatchObject({
      ok: false,
      error: { reasons: [{ message: expect.stringContaining("committed terminal") }] },
    });

    const terminal = lifecycleStates().find((state) => state.kind === "terminal-blocked")!;
    const diagnostic = authorityValue(terminalBlockedDiagnostic({
      category: "invalid-authority", runId: terminal.runId, message: "stop",
    }));
    const blocked = authorityValue(blockedAction(diagnostic));
    const provenBlocked = authorityValue(proveWaveGateNextAction(snapshot, terminal, blocked));
    const blockedReadiness = authorityValue(deriveWaveReadiness(snapshot.graph, statusDeps, provenBlocked, terminal));
    expect(deriveNextAction(blockedReadiness).action).toMatchObject({
      kind: "blocked",
      diagnostic: { kind: "terminal-blocked", retry: { eligible: false } },
    });

    const disconnected = { ...terminal } as WaveGateState;
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, provenBlocked, disconnected)).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });
  });

  it("reports every failed completion prerequisite rather than only the first", () => {
    const graph = registeredGraph({
      executing_tasks: ["T1"],
      tasks: [{
        ...baseTask,
        test_result: { verdict: "trusted-fail" },
        new_tests_written: false,
        review_status: "pending",
        critical_findings: ["blocker"],
      }],
      spec_check: undefined,
    });
    const readiness = deriveWaveReadiness(graph, statusDeps);
    expect(readiness.ok).toBe(true);
    if (!readiness.ok) return;
    const eligibility = readiness.value.facts.waveGateCompletionEligibility;
    expect(eligibility.kind).toBe("known");
    if (eligibility.kind === "known" && eligibility.value.kind === "ineligible") {
      expect(eligibility.value.failedPrerequisites).toHaveLength(6);
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("still executing");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("test evidence");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("new-test");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("reviewed");
      expect(eligibility.value.failedPrerequisites.join("\n")).toContain("Spec alignment");
    }
  });
});

describe("authoritative Wave review preparation, recovery, panel, and advisory contracts", () => {
  const packet = {
    task_id: "T1",
    packet_id: "1".repeat(64),
    packet_path: ".claude/reviews/packets/run.test/T1.json",
    base_sha: "2".repeat(40),
    head_sha: "3".repeat(40),
    scope: ["engine/src/core/wave-gate-machine.ts"],
  } as const;

  function preparationFixture() {
    const graph = registeredGraph({ tasks: [{ ...baseTask, file_list: ["engine/src/core/wave-gate-machine.ts"] }] });
    const snapshot = authorityValue(deriveWaveReadiness(graph, statusDeps));
    return { snapshot, preparation: authorityValue(prepareWaveReviewBatch(snapshot)) };
  }

  it("derives the exact packet/roster/model/context/request authority without parent assembly and rejects drift claims", () => {
    const { snapshot, preparation } = preparationFixture();
    expect(preparation.packets).toHaveLength(1);
    expect(preparation.packets[0]).toMatchObject({ task_id: "T1", scope: ["engine/src/core/wave-gate-machine.ts"] });
    expect(createHash("sha256").update(Uint8Array.from(preparation.packetPublications[0].bytes)).digest("hex"))
      .toBe(preparation.packets[0].packet_id);
    expect(preparation.bindings).toHaveLength(6);
    expect(preparation.initialRequests.map((request) => (request.authority as AgentRequestAuthority).role)).toEqual([
      "spec-check-invoker", "code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "type-design-analyzer", "comment-analyzer",
    ]);
    expect(preparation.initialRequests.map((request) => (request.authority as AgentRequestAuthority).modelProfile)).toEqual([
      "general-review", "general-review", "focused-review", "focused-review", "focused-review", "focused-review",
    ]);
    const replay = authorityValue(prepareWaveReviewBatch(snapshot));
    expect(replay.publicationIntent).toEqual(preparation.publicationIntent);
    const assertedReplay = authorityValue(prepareWaveReviewBatch(snapshot, {
      packets: preparation.packets,
      bindings: preparation.bindings,
    }));
    expect(assertedReplay).toEqual(preparation);
    expect(prepareWaveReviewBatch(snapshot, { packets: [] })).toMatchObject({ ok: false });
    expect(prepareWaveReviewBatch(snapshot, { bindings: [...preparation.bindings].reverse() })).toMatchObject({ ok: false });
    const firstBinding = preparation.bindings[0];
    const firstRequest = firstBinding.attempts[0];
    const firstAuthority = firstRequest.authority as AgentRequestAuthority;
    const modelDriftBindings = [{
      ...firstBinding,
      attempts: [{
        ...firstRequest,
        authority: { ...firstAuthority, modelProfile: "mechanical" },
      }, firstBinding.attempts[1]] as const,
    }, ...preparation.bindings.slice(1)];
    expect(prepareWaveReviewBatch(snapshot, { bindings: modelDriftBindings })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("roster/model/context/request authority") },
    });
    expect(prepareWaveReviewBatch(snapshot, {
      packets: [{ ...preparation.packets[0], packet_id: "4".repeat(64) }],
    })).toMatchObject({ ok: false, error: { message: expect.stringContaining("drifted") } });
  });

  it("prepares fresh Task packets and requests together instead of consuming pre-issued packet registrations", () => {
    const graph = registeredGraph({
      tasks: [{ ...baseTask, file_list: ["engine/src/core/wave-gate-machine.ts"], issued_review_packets: [packet] }],
    });
    const snapshot = authorityValue(deriveWaveReadiness(graph, statusDeps));
    const prepared = authorityValue(prepareWaveReviewBatch(snapshot));
    expect(prepared.packets).not.toEqual([packet]);
    expect(prepared.publicationIntent.packets.map(({ registration }) => registration)).toEqual(prepared.packets);
    expect(prepared.publicationIntent.requestPublicationIntent.issuedRequests).toHaveLength(prepared.initialRequests.length);
    expect(authorityValue(prepareWaveReviewBatch(authorityValue(deriveWaveReadiness(registeredGraph(), statusDeps)))).packets)
      .toHaveLength(1);
  });

  it("exposes no spawn action until T1 atomically reconciles the exact publication receipt", () => {
    const { snapshot, preparation } = preparationFixture();
    const effectPort = createInitialPublicationEffectPort((intent) => ({
      ok: true,
      value: [...new TextEncoder().encode(JSON.stringify({
        schemaVersion: 1,
        kind: "batch-published",
        effectId: intent.identity.effectId,
        runId: intent.identity.runId,
        requestIds: intent.requestIds,
        contextDigests: intent.contextDigests,
        issuedRequests: intent.issuedRequests,
        publicationDigest: intent.identity.publicationDigest,
      }))],
    }));
    const claimPort = createAtomicInitialPublicationClaimPort((request) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "initial-publication-claimed",
        key: request.key,
        identity: request.identity,
      },
    }));
    const requestReconcile = createInitialBatchPublicationReconciler(effectPort, claimPort);
    let observedAtomicIntent = false;
    const reconcile = (intent: typeof preparation.publicationIntent) => {
      observedAtomicIntent = intent.packets.length > 0 && intent.requestPublicationIntent.issuedRequests.length > 0;
      const issuance = requestReconcile(intent.requestPublicationIntent);
      return issuance.ok
        ? { ok: true as const, value: {
            schemaVersion: 1 as const,
            kind: "wave-review-batch-published" as const,
            runId: intent.runId,
            publicationDigest: intent.publicationDigest,
            requestIssuance: issuance.value,
          } }
        : { ok: false as const, error: { kind: "wave-preparation-rejected" as const, message: issuance.error.message } };
    };
    const state = authorityValue(createWaveGateState(snapshot));
    const action = authorityValue(publishWaveReviewBatch(snapshot, state, preparation, reconcile));
    expect(observedAtomicIntent).toBe(true);
    expect(action).toMatchObject({ kind: "review-batch", action: { kind: "spawn-batch" } });
    if (action.kind === "review-batch") {
      expect(action.action.requests).toHaveLength(preparation.initialRequests.length);
      expect(action.action.receipt.publicationDigest)
        .toBe(preparation.publicationIntent.requestPublicationIntent.identity.publicationDigest);
    }
    const actionReadiness = authorityValue(deriveWaveReadiness(snapshot.graph, statusDeps, action, state));
    expect(deriveNextAction(actionReadiness).action.kind).toBe("spawn-batch");
    expect(deriveLoomStatus(actionReadiness).next.reasons.some(({ kind }) => kind === "review-spawn-required")).toBe(true);

    const revisedGraph = {
      ...snapshot.graph,
      active_wave_gate: { ...snapshot.registration, revision: snapshot.registration.revision + 1 },
    };
    const reauthorizedGraph = {
      ...snapshot.graph,
      active_wave_gate: { ...snapshot.registration, authorityDigest: authorityValue(parseArtifactDigest("d".repeat(64))) },
    };
    const changedReadinessGraph = {
      ...snapshot.graph,
      tasks: snapshot.graph.tasks.map((task) => ({ ...task, test_result: { verdict: "trusted-fail" as const } })),
    };
    for (const attacked of [revisedGraph, reauthorizedGraph, changedReadinessGraph]) {
      expect(deriveWaveReadiness(attacked, statusDeps, action, state)).toMatchObject({
        ok: false,
        error: { reasons: [{ kind: "authority-contradiction" }] },
      });
    }
    const advancedCheckpoint = authorityValue(reduceWaveGate(state, { kind: "preparation-published" }));
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, action, advancedCheckpoint)).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });
    expect(deriveWaveReadiness(snapshot.graph, statusDeps, { ...action }, state)).toMatchObject({
      ok: false,
      error: { reasons: [{ kind: "authority-contradiction" }] },
    });

    const second = preparationFixture();
    const failed = publishWaveReviewBatch(
      second.snapshot,
      authorityValue(createWaveGateState(second.snapshot)),
      second.preparation,
      (intent) => {
        const issuance = createInitialBatchPublicationReconciler(
          createInitialPublicationEffectPort(() => ({
            ok: false,
            error: { kind: "initial-publication-effect-failed", message: "partial write" },
          })),
          claimPort,
        )(intent.requestPublicationIntent);
        return issuance.ok
          ? { ok: true, value: {
              schemaVersion: 1, kind: "wave-review-batch-published", runId: intent.runId,
              publicationDigest: intent.publicationDigest, requestIssuance: issuance.value,
            } }
          : { ok: false, error: { kind: "wave-preparation-rejected", message: issuance.error.message } };
      },
    );
    expect(failed).toMatchObject({ ok: false, error: { kind: "wave-preparation-rejected" } });
  });

  it("derives retry publication only from exact active Review Run slots; caller evidence is comparison-only", () => {
    const { snapshot, preparation } = preparationFixture();
    const slots = preparation.bindings.map((binding) => authorityValue(parseAgentRosterSlot(
      binding.attempts[0].authority,
      binding.attempts[1].authority,
    )).slotId);
    const acceptedAgents = ["code-reviewer", "pr-test-analyzer", "comment-analyzer"];
    const task = {
      ...baseTask,
      review_generation: 1,
      review_status: "evidence_capture_failed" as const,
      review_error: "type verifier transcript invalid",
      review_evidence_failures: ["type-design-analyzer"],
      review_run: {
        generation: 1,
        packet_id: preparation.packets[0].packet_id,
        head_sha: preparation.packets[0].head_sha,
        expected_agents: [...WAVE_REVIEW_AGENTS] as [string, ...string[]],
        prior_finding_ids: [],
        evidence: acceptedAgents.map((agent) => ({ agent, prior_assessments: [], new_findings: [] })),
        slot_authority: testNonEmpty(WAVE_REVIEW_AGENTS.map((agent, index) => ({
          agent,
          slot_id: slots[index + 1],
          attempted: 1 as const,
        }))),
      },
    };
    const parsedActiveGraph = parseTaskGraph({ ...snapshot.graph, tasks: [task] });
    expect(parsedActiveGraph).toMatchObject({ ok: true });
    const activeSnapshot = authorityValue(deriveWaveReadiness(authorityValue(parsedActiveGraph), statusDeps));
    const claims = slots.map((slotId, index) => ({
      slotId,
      result: index === 2 ? "missing" as const : index === 4 ? "invalid" as const : "accepted" as const,
      attempted: 1 as const,
    }));
    const recovery = authorityValue(deriveWaveReviewRecovery(preparation, activeSnapshot, claims));
    expect(recovery.kind).toBe("retry-batch");
    if (recovery.kind === "retry-batch") {
      expect(recovery.affectedSlotIds).toEqual([slots[2], slots[4]]);
      expect(recovery.requests.map((request) => (request.authority as AgentRequestAuthority).attempt)).toEqual([2, 2]);
    }
    expect(deriveWaveReviewRecovery(preparation, activeSnapshot, claims.slice(1))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("caller recovery claim drifted") },
    });
    expect(deriveWaveReviewRecovery(preparation, snapshot)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("no exact active Review Run") },
    });

    const exhaustedTask = {
      ...task,
      review_run: {
        ...task.review_run,
        slot_authority: testNonEmpty(task.review_run.slot_authority!.map((slot, index) =>
          index === 1 ? { ...slot, attempted: 2 as const } : slot)),
      },
    };
    const exhaustedSnapshot = authorityValue(deriveWaveReadiness({ ...snapshot.graph, tasks: [exhaustedTask] }, statusDeps));
    expect(deriveWaveReviewRecovery(preparation, exhaustedSnapshot)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("exhausted semantic attempt 2") },
    });
  });

  it("refuses refutation while a current Review Packet still owns the finding snapshot", () => {
    const { snapshot, preparation } = preparationFixture();
    const taskBindings = preparation.bindings.filter((binding) => binding.subject.kind === "task-review");
    const packetAuthority = preparation.packets[0];
    const collecting = authorityValue(deriveWaveReadiness({
      ...snapshot.graph,
      tasks: snapshot.graph.tasks.map((task) => ({
        ...task,
        review_run: {
          generation: task.review_generation ?? 0,
          packet_id: packetAuthority.packet_id,
          head_sha: packetAuthority.head_sha,
          expected_agents: WAVE_REVIEW_AGENTS,
          prior_finding_ids: (task.findings ?? []).map(({ id }) => id),
          evidence: [],
          slot_authority: taskBindings.map((binding) => ({
            agent: binding.subject.kind === "task-review" ? binding.subject.reviewer : "code-reviewer",
            slot_id: (binding.attempts[0].authority as AgentRequestAuthority).slotId,
            attempted: 1 as const,
          })) as never,
        },
      })),
    }, statusDeps));

    expect(deriveWaveRefutationPlan(collecting)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Review Packet evidence must complete before refutation") },
    });
  });

  it("refuses stale criticals on a pending generation that has no current Review Packet", () => {
    const finding = {
      id: "code-reviewer-1", agent: "code-reviewer", severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts", line: 1, claim: "stale until current review completes",
    };
    const pending = authorityValue(deriveWaveReadiness(registeredGraph({
      tasks: [{
        ...baseTask,
        review_status: "pending",
        review_generation: 2,
        review_run: undefined,
        findings: [finding],
        critical_findings: [finding.claim],
        advisory_findings: [],
      }],
    }), statusDeps));

    expect(deriveWaveRefutationPlan(pending)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("current-generation review evidence must complete") },
    });
  });

  it("binds Wave refutation identity to the exact readiness epoch", () => {
    const finding = {
      id: "code-reviewer-1", agent: "code-reviewer", severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts", line: 1, claim: "completion can advance without authority",
    };
    const first = authorityValue(deriveWaveReadiness(registeredGraph({
      tasks: [{ ...baseTask, findings: [finding], critical_findings: [finding.claim], advisory_findings: [] }],
    }), statusDeps));
    const second = authorityValue(deriveWaveReadiness({
      ...first.graph,
      tasks: first.graph.tasks.map((task) => ({ ...task, test_evidence: `${task.test_evidence} (re-observed)` })),
    }, statusDeps));

    expect(authorityValue(deriveWaveRefutationPlan(first)).runId)
      .not.toBe(authorityValue(deriveWaveRefutationPlan(second)).runId);
  });

  it("refuses an empty panel and derives non-empty idempotent panel authority only from canonical Findings", () => {
    const clean = authorityValue(deriveWaveReadiness(registeredGraph(), statusDeps));
    expect(deriveWaveRefutationPlan(clean)).toMatchObject({ ok: false });

    const finding = {
      id: "code-reviewer-1",
      agent: "code-reviewer",
      severity: "critical" as const,
      file: "engine/src/core/wave-gate-machine.ts",
      line: 1,
      claim: "completion can advance without authority",
    };
    const snapshot = authorityValue(deriveWaveReadiness(registeredGraph({
      tasks: [{ ...baseTask, findings: [finding], critical_findings: [finding.claim], advisory_findings: [] }],
    }), statusDeps));
    const plan = authorityValue(deriveWaveRefutationPlan(snapshot));
    const replay = authorityValue(deriveWaveRefutationPlan(snapshot));
    expect(replay).toEqual(plan);
    expect(plan.findings.map(({ id }) => id)).toEqual(["T1:code-reviewer-1"]);
    const panel = authorityValue(prepareWaveRefutationPanel(snapshot));
    expect(panel.authority.findings).toEqual(plan.findings);
    expect(panel.authority.lenses).toEqual(plan.lenses);
    expect(panel.authority.verifierRoster.orderedSlots).toHaveLength(plan.lenses.length);
    const claimedReplay = authorityValue(prepareWaveRefutationPanel(snapshot, {
      verifierSlots: panel.authority.verifierRoster.orderedSlots,
    }));
    expect(claimedReplay.runId).toBe(panel.runId);
    expect(claimedReplay.findings).toEqual(panel.findings);
    expect(claimedReplay.lenses).toEqual(panel.lenses);
    expect(claimedReplay.authority.verifierRoster.orderedSlots).toEqual(panel.authority.verifierRoster.orderedSlots);
    expect(prepareWaveRefutationPanel(snapshot, {
      verifierSlots: [...panel.authority.verifierRoster.orderedSlots].reverse(),
    })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("caller verifier slot claim drifted") },
    });
  });

  it("derives advisory await-user internally and exposes it as the sole status action", () => {
    const advisory = {
      id: "comment-analyzer-1",
      agent: "comment-analyzer",
      severity: "advisory" as const,
      file: null,
      line: null,
      claim: "clarify wording",
    };
    const graph = registeredGraph({
      tasks: [{ ...baseTask, findings: [advisory], critical_findings: [], advisory_findings: [advisory.claim] }],
    });
    const snapshot = authorityValue(deriveWaveReadiness(graph, statusDeps));
    const runId = snapshot.registration.runId;
    const preparing = authorityValue(createWaveGateState(snapshot));
    const reviewing = authorityValue(reduceWaveGate(preparing, { kind: "preparation-published" }));
    const advisoryState = authorityValue(reduceWaveGate(reviewing, { kind: "complete-roster-with-advisories" }));
    const proven = authorityValue(deriveWaveAdvisoryNextAction(snapshot, advisoryState));
    const advisoryReadiness = authorityValue(deriveWaveReadiness(graph, statusDeps, proven, advisoryState));
    expect(deriveNextAction(advisoryReadiness).action.kind).toBe("await-user");
    const status = deriveLoomStatus(advisoryReadiness);
    expect(status.next.action.kind).toBe("await-user");
    expect(status.next.reasons.some(({ kind }) => kind === "advisory-decision-required")).toBe(true);
  });
});

describe("protected active Wave Gate registration", () => {
  const registration = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "registered-wave-run",
    wave: 1,
    authorityDigest: "c".repeat(64),
    revision: 0,
    terminalOutcome: null,
  };

  it("parses exact anchored authority and rejects malformed terminal outcomes", () => {
    expect(parseActiveWaveGateRegistration(registration)).toMatchObject({ ok: true, value: { wave: 1, revision: 0 } });
    expect(parseActiveWaveGateRegistration({ ...registration, extra: true })).toMatchObject({ ok: false });
    expect(parseActiveWaveGateRegistration({ ...registration, terminalOutcome: { kind: "done" } })).toMatchObject({ ok: false });
  });

  it("rejects nonterminal active authority that contradicts Phase, current Wave, or terminal history and blocks status", () => {
    const terminalHistory = {
      schemaVersion: 1,
      kind: "completed-wave-gate",
      runId: "completed-wave-run",
      wave: 1,
      authorityDigest: "d".repeat(64),
      revision: 1,
      completionReceipt: {
        kind: "protected-wave-state-committed",
        effectId: "completed-wave-effect",
        runId: "completed-wave-run",
        committedRevision: 1,
        stateDigest: "e".repeat(64),
      },
    };
    const raw = {
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [baseTask],
      wave_gates: {},
      active_wave_gate: registration,
    };
    const cases = [
      {
        label: "phase mismatch",
        graph: { ...raw, current_phase: "specify" },
        diagnostic: "requires current_phase execute",
      },
      {
        label: "wave mismatch",
        graph: { ...raw, current_wave: 2 },
        diagnostic: "must match protected current_wave 2",
      },
      {
        label: "terminal overlap",
        graph: { ...raw, wave_gate_history: [terminalHistory] },
        diagnostic: "overlaps terminal wave_gate_history Wave 1 run completed-wave-run",
      },
    ];

    for (const { label, graph, diagnostic } of cases) {
      const parsed = parseTaskGraph(graph);
      expect(parsed.ok, label).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error, label).toContain(diagnostic);
      const status = deriveLoomStatusFromParsedGraph(parsed, statusDeps);
      expect(Object.values(status.facts).every((fact) => fact.kind === "unavailable"), label).toBe(true);
      expect(status.next.action, label).toMatchObject({
        kind: "blocked",
        diagnostic: { kind: "terminal-blocked", category: "invalid-authority" },
      });
      expect(status.next.reasons[0]?.message, label).toContain(diagnostic);
    }
  });

  it("explicitly migrates legacy authority and never invents a default registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-legacy-wave-"));
    const path = join(root, "active_task_graph.json");
    writeFileSync(path, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, tasks: [baseTask], wave_gates: {},
    }));
    const manager = new StateManager(path);
    try {
      expect(evaluateWaveGate(manager.load(), null, statusDeps).verdict.kind).toBe("fail");
      const migrated = await manager.migrateLegacyWaveGateRegistration({
        schemaVersion: 1,
        kind: "legacy-wave-gate-compatibility",
        runId: "explicit-legacy-run",
        wave: 1,
        authorityDigest: "d".repeat(64),
      });
      expect(manager.load().active_wave_gate).toEqual(migrated);
      await expect(manager.migrateLegacyWaveGateRegistration({
        schemaVersion: 1, kind: "legacy-wave-gate-compatibility", runId: "other", wave: 1,
        authorityDigest: "e".repeat(64),
      })).rejects.toThrow("only when active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers atomically, replays idempotently, and refuses a competing active run", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-active-wave-"));
    const path = join(root, "active_task_graph.json");
    writeFileSync(path, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, tasks: [], wave_gates: {},
    }));
    const manager = new StateManager(path);
    try {
      const first = await manager.registerActiveWaveGate(registration);
      const replay = await manager.registerActiveWaveGate(registration);
      expect(replay).toEqual(first);
      expect(manager.load().active_wave_gate).toEqual(first);
      await expect(manager.registerActiveWaveGate({ ...registration, runId: "competing-run" }))
        .rejects.toThrow("already owns wave 1");
      expect(manager.load().active_wave_gate).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects registration for a Wave already present in terminal history", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-terminal-wave-registration-"));
    const path = join(root, "active_task_graph.json");
    writeFileSync(path, JSON.stringify(registeredGraph()));
    const manager = new StateManager(path);
    try {
      const committed = await manager.commitActiveWaveGateCompletion((locked) => {
        const readiness = deriveWaveReadiness(locked, statusDeps);
        return readiness.ok
          ? commitWaveGateCompletion(readiness.value)
          : { ok: false, error: { kind: "wave-completion-commit-rejected" as const, message: "unavailable" } };
      });
      const replay = authorityValue(findRegisteredWaveGateCompletionReplay(manager.load(), {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: committed.completedRegistration.runId,
        wave: committed.completedRegistration.wave,
        authorityDigest: committed.completedRegistration.authorityDigest,
        revision: committed.completedRegistration.revision - 1,
        terminalOutcome: null,
      }));
      expect(replay).toEqual(committed.completedRegistration);
      await expect(manager.registerActiveWaveGate(registration))
        .rejects.toThrow("already completed or older than terminal Wave history");
      expect(manager.load().active_wave_gate).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-stats lifecycle artifacts inside the completion lock and rejects pre-lock deletion drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-lock-drift-"));
    const path = join(root, "active_task_graph.json");
    const relativeArtifact = `tests/.wave-lock-drift-${process.pid}.ts`;
    const artifact = join(root, relativeArtifact);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(artifact, "export {};\n");
    const artifactProof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: [relativeArtifact] },
      {
        taskCompleted: true,
        testResult: { verdict: "trusted-pass" },
        filesModified: [relativeArtifact],
        newTestsWritten: true,
      },
    );
    if (artifactProof.state !== "satisfied") throw new Error("artifact fixture proof must be satisfied");
    writeFileSync(path, JSON.stringify(registeredGraph({
      plan_file: "plan.md",
      tasks: [{ ...baseTask, file_list: [relativeArtifact], files_modified: [relativeArtifact], proof: artifactProof }],
    })));
    const manager = new StateManager(path);
    const io: GateIO = {
      loadPlanModels: () => ({
        kind: "loaded",
        models: {
          lifecycles: [{ id: "LC-1", title: "Wave", machineFile: relativeArtifact }],
          pipeline: null,
          invariants: [],
          strays: [],
        },
      }),
      fileExists: (candidate) => existsSync(join(root, candidate)),
    };
    try {
      const stale = snapshotGateDeps(manager.load(), io);
      expect(evaluateWaveGate(manager.load(), null, stale).verdict.kind).toBe("pass");
      rmSync(artifact);
      let lockedFailure = "";
      await expect(manager.commitActiveWaveGateCompletion((locked) => {
        const live = snapshotGateDeps(locked, io);
        const liveDecision = evaluateWaveGate(locked, null, live);
        lockedFailure = liveDecision.verdict.kind === "fail" ? liveDecision.verdict.reason : "";
        const readiness = deriveWaveReadiness(locked, live);
        return readiness.ok
          ? commitWaveGateCompletion(readiness.value)
          : { ok: false, error: { kind: "wave-completion-commit-rejected", message: "unavailable" } };
      })).rejects.toThrow("completion readiness is ineligible");
      expect(lockedFailure).toContain("lifecycle machine files");
      expect(manager.load().active_wave_gate?.terminalOutcome).toBeNull();
      expect(manager.load().tasks[0]?.status).toBe("implemented");
    } finally {
      rmSync(artifact, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects completion when snapshot.graph.active_wave_gate is replaced after readiness derivation", () => {
    const graph = registeredGraph();
    const readiness = authorityValue(deriveWaveReadiness(graph, statusDeps));
    graph.active_wave_gate = { ...graph.active_wave_gate! };
    expect(commitWaveGateCompletion(readiness)).toMatchObject({
      ok: false,
      error: { message: "snapshot graph active_wave_gate is not the exact readiness registration" },
    });
  });

  it("rejects completion when the active run is already terminal in history", () => {
    const graph = registeredGraph();
    const readiness = authorityValue(deriveWaveReadiness(graph, statusDeps));
    const committed = authorityValue(commitWaveGateCompletion(readiness));

    // The same run re-enters the graph as the active gate with its own
    // completed registration already archived — the duplicate-terminal shape
    // the parse boundary refuses at load and the commit machine must also
    // refuse in memory.
    const rerun = registeredGraph({ wave_gate_history: [committed.completedRegistration] });
    const rerunReadiness = authorityValue(deriveWaveReadiness(rerun, statusDeps));
    expect(commitWaveGateCompletion(rerunReadiness)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already terminal in history") },
    });
  });

  it("rejects a next-action whose runId differs from the lifecycle state BEFORE readiness derivation", () => {
    // The pre-proof reject arm: a foreign-run action must be refused here, not
    // first minted into a next-action proof that downstream readiness
    // contradiction handling has to clean up.
    const snapshot = lifecycleCompletionReadiness();
    const state = lifecycleStates().find((candidate) => candidate.kind === "done")!;
    const foreignRun = authorityValue(parseOrchestrationRunId("foreign-next-action-run"));
    const done = authorityValue(doneAction(state.runId, {
      runId: state.runId,
      slot: "artifacts/wave-result.json",
      digest: "9".repeat(64),
      byteLength: 12,
    }));
    const foreign = { ...done, runId: foreignRun };

    const proven = proveWaveGateNextAction(snapshot, state, foreign);

    expect(proven.ok).toBe(false);
    if (!proven.ok) {
      expect(proven.error.kind).toBe("wave-gate-next-action-rejected");
      expect(proven.error.message).toContain("different Wave Gate run");
    }
  });

  it("atomically archives terminal receipt with Task/Wave advancement and allows compatibility to start the next Wave", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-complete-wave-"));
    const path = join(root, "active_task_graph.json");
    const initial = registeredGraph({
      tasks: [baseTask, { ...baseTask, id: "T2", wave: 2 }],
    });
    writeFileSync(path, JSON.stringify(initial));
    const manager = new StateManager(path);
    try {
      const committed = await manager.commitActiveWaveGateCompletion((locked) => {
        const readiness = deriveWaveReadiness(locked, statusDeps);
        if (!readiness.ok) return { ok: false, error: { kind: "wave-completion-commit-rejected", message: "unavailable" } };
        return commitWaveGateCompletion(readiness.value);
      });
      const stored = manager.load();
      expect(stored.active_wave_gate).toBeUndefined();
      expect(stored.current_wave).toBe(2);
      expect(stored.tasks.find(({ id }) => id === "T1")?.status).toBe("completed");
      expect(stored.wave_gate_history).toEqual([committed.completedRegistration]);
      expect(stored.wave_gate_history?.[0]?.completionReceipt).toEqual(committed.receipt);

      const nextAuthority = authorityValue(deriveLegacyWaveGateCompatibilityAuthority(stored, null));
      expect(nextAuthority.wave).toBe(2);
      const next = await manager.migrateLegacyWaveGateRegistration(nextAuthority);
      expect(manager.load().active_wave_gate).toEqual(next);
      expect(next).toMatchObject({ runId: nextAuthority.runId, wave: 2, terminalOutcome: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("final-Wave compatibility completion replay", () => {
  function legacyFinalGraph(): TaskGraph {
    const registered = registeredGraph({
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false },
      },
    });
    const { active_wave_gate: _active, ...legacy } = registered;
    return legacy;
  }

  async function withHandlerState<T>(
    run: (path: string) => Promise<T>,
    initial: TaskGraph = legacyFinalGraph(),
  ): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "loom-final-wave-replay-"));
    const path = join(root, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    writeFileSync(path, JSON.stringify(initial, null, 2));
    process.env.LOOM_STATE_PATH = path;
    try {
      return await run(path);
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("returns the exact completed outcome on repeated final-Wave calls with zero state mutation", async () => {
    await withHandlerState(async (path) => {
      expect(await completeWaveGateHandler("", [])).toEqual({ kind: "passthrough" });
      const completedBytes = readFileSync(path, "utf-8");
      const completed = new StateManager(path).load();
      const committedStatus = deriveLoomStatusFromParsedGraph({ ok: true, value: completed }, statusDeps);
      expect(committedStatus.next.action).toMatchObject({
        kind: "done",
        runId: completed.wave_gate_history?.[0]?.runId,
      });
      expect(committedStatus.next.reasons).toEqual([
        expect.objectContaining({ kind: "run-complete" }),
      ]);
      const authority = authorityValue(deriveLegacyWaveGateCompatibilityAuthority(completed, null));
      const replay = authorityValue(findLegacyWaveGateCompletionReplay(completed, authority));
      expect(replay).toEqual(completed.wave_gate_history?.[0]);

      for (let replayIndex = 0; replayIndex < 3; replayIndex++) {
        expect(await completeWaveGateHandler("", [])).toEqual({ kind: "passthrough" });
        expect(readFileSync(path, "utf-8")).toBe(completedBytes);
      }
      expect(new StateManager(path).load().active_wave_gate).toBeUndefined();
      await expect(new StateManager(path).migrateLegacyWaveGateRegistration(authority))
        .rejects.toThrow("already completed");
    });
  });

  it("reports both legacy migration and terminal replay-read failures", async () => {
    await withHandlerState(async (path) => {
      const manager = new (class extends StateManager {
        private readCount = 0;

        override load(): TaskGraph {
          this.readCount++;
          if (this.readCount > 1) throw new Error("simulated legacy replay read failure");
          return super.load();
        }

        override async migrateLegacyWaveGateRegistration(_raw: unknown): Promise<never> {
          throw new Error("simulated legacy migration failure");
        }
      })(path);
      const handlerWithReplayReadFailure = createCompleteWaveGateHandler(() => manager);

      const result = await handlerWithReplayReadFailure("", []);

      expect(result).toMatchObject({ kind: "error" });
      if (result.kind !== "error") return;
      expect(result.message).toContain("simulated legacy migration failure");
      expect(result.message).toContain("terminal replay read also failed");
      expect(result.message).toContain("simulated legacy replay read failure");
    });
  });

  it("coalesces concurrent final-Wave compatibility completion onto one terminal history entry", async () => {
    await withHandlerState(async (path) => {
      const results = await Promise.all([
        completeWaveGateHandler("", []),
        completeWaveGateHandler("", []),
        completeWaveGateHandler("", []),
      ]);
      expect(results).toEqual([
        { kind: "passthrough" },
        { kind: "passthrough" },
        { kind: "passthrough" },
      ]);
      const completed = new StateManager(path).load();
      expect(completed.active_wave_gate).toBeUndefined();
      expect(completed.wave_gate_history).toHaveLength(1);
      expect(completed.tasks[0]?.status).toBe("completed");
    });
  });

  it("reconciles concurrent completion of the same explicit active registration to its committed receipt", async () => {
    await withHandlerState(async (path) => {
      const before = new StateManager(path).load().active_wave_gate!;
      const results = await Promise.all([
        completeWaveGateHandler("", []),
        completeWaveGateHandler("", []),
        completeWaveGateHandler("", []),
      ]);
      expect(results).toEqual([
        { kind: "passthrough" },
        { kind: "passthrough" },
        { kind: "passthrough" },
      ]);
      const completed = new StateManager(path).load();
      expect(completed.active_wave_gate).toBeUndefined();
      expect(completed.wave_gate_history).toHaveLength(1);
      const terminal = completed.wave_gate_history![0]!;
      expect(terminal).toMatchObject({
        runId: before.runId,
        wave: before.wave,
        authorityDigest: before.authorityDigest,
        revision: before.revision + 1,
      });
      expect(authorityValue(findRegisteredWaveGateCompletionReplay(completed, before)))
        .toEqual(terminal);
    }, registeredGraph());
  });

  it("preserves AggregateError permission-restoration detail when the locked gate decision is blocked", async () => {
    const blockedGraph = registeredGraph({ tasks: [{ ...baseTask, review_status: "pending" }] });
    await withHandlerState(async (path) => {
      const manager = new StateManager(path, (_target, mode) => {
        if (mode === 0o444) throw new Error("simulated pre-commit chmod 0444 failure");
      });
      const result = await createCompleteWaveGateHandler(() => manager)("", []);

      expect(result).toMatchObject({ kind: "error" });
      if (result.kind !== "error") return;
      expect(result.message).toContain("Not all tasks have been reviewed");
      expect(result.message).toContain("Task graph write and permission restoration both failed");
      expect(result.message).toContain("simulated pre-commit chmod 0444 failure");
      expect(new StateManager(path).load().wave_gate_history).toBeUndefined();
    }, blockedGraph);
  });

  it("surfaces post-commit read-only restoration failure with the committed receipt and remediation", async () => {
    await withHandlerState(async (path) => {
      const manager = new StateManager(path, (_target, mode) => {
        if (mode === 0o444) throw new Error("simulated chmod 0444 failure");
      });
      const handlerWithProtectionFailure = createCompleteWaveGateHandler(() => manager);

      const result = await handlerWithProtectionFailure("", []);
      const committed = new StateManager(path).load();
      const receipt = committed.wave_gate_history?.[0]?.completionReceipt;

      expect(receipt).toBeDefined();
      expect(result).toMatchObject({ kind: "error" });
      if (result.kind !== "error" || receipt === undefined) return;
      expect(result.message).toContain(`committed with receipt ${receipt.effectId}`);
      expect(result.message).toContain(`revision ${receipt.committedRevision}`);
      expect(result.message).toContain("simulated chmod 0444 failure");
      expect(result.message).toContain(`chmod 0444 ${JSON.stringify(path)}`);
      expect(result.message).toContain("do not rerun completion as if this were an idempotent replay");
      expect(committed.active_wave_gate).toBeUndefined();
      expect(committed.wave_gate_history).toHaveLength(1);
    }, registeredGraph());
  });

  it("fails conflicting or older terminal history instead of treating it as replay", async () => {
    const graph = legacyFinalGraph();
    const authority = authorityValue(deriveLegacyWaveGateCompatibilityAuthority(graph, null));
    const conflict = registeredGraph({
      active_wave_gate: undefined,
      tasks: [{ ...baseTask, status: "completed" }],
      wave_gates: {
        "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      },
      wave_gate_history: [{
        schemaVersion: 1,
        kind: "completed-wave-gate",
        runId: authorityValue(parseOrchestrationRunId("conflicting-final-run")),
        wave: 1,
        authorityDigest: authorityValue(parseArtifactDigest("f".repeat(64))),
        revision: 1,
        completionReceipt: {
          kind: "protected-wave-state-committed",
          effectId: authorityValue(parseEffectId("conflicting-final-effect")),
          runId: authorityValue(parseOrchestrationRunId("conflicting-final-run")),
          committedRevision: 1,
          stateDigest: authorityValue(parseArtifactDigest("e".repeat(64))),
        },
      }],
    });
    expect(findLegacyWaveGateCompletionReplay(conflict, authority)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("conflicts") },
    });
    await withHandlerState(async (path) => {
      const before = readFileSync(path, "utf-8");
      expect(await completeWaveGateHandler("", [])).toMatchObject({
        kind: "error",
        message: expect.stringContaining("conflicting compatibility completion replay"),
      });
      expect(readFileSync(path, "utf-8")).toBe(before);
    }, conflict);

    const older = { ...conflict, current_wave: 1, wave_gate_history: [{ ...conflict.wave_gate_history![0]!, wave: 2 }] };
    expect(findLegacyWaveGateCompletionReplay(older, authority)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("older than completed terminal Wave 2") },
    });

    const root = mkdtempSync(join(tmpdir(), "loom-older-wave-migration-"));
    const path = join(root, "active_task_graph.json");
    writeFileSync(path, JSON.stringify(older));
    try {
      await expect(new StateManager(path).migrateLegacyWaveGateRegistration(authority))
        .rejects.toThrow("older than completed terminal Wave 2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("complete-wave-gate compatibility delegation", () => {
  it("returns the core decision byte-for-byte without weakening any check", () => {
    const state = registeredGraph();
    expect(evaluateWaveGate(state, null, statusDeps)).toEqual(evaluateCoreWaveGate(state, null, statusDeps));
  });
});
