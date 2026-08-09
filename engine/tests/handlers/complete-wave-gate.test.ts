import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGateDecision,
  checkImplementationProof,
  checkTestEvidence,
  checkNewTests,
  checkReviews,
  checkSpecAlignment,
  checkCriticalFindings,
  computeNextWave,
  evaluateWaveGate,
  generateWaveGateSummary,
  gateCheckMessage,
  parseWaveArg,
  persistWaveGateSummaryFallback,
  snapshotGateDeps,
  type GateDeps,
  type GateIO,
} from "../../src/handlers/helpers/complete-wave-gate";
import type { CapturedSpecCheck, Task, TaskGraph } from "../../src/types";
import { evaluateTaskProof } from "../../src/core/proof-obligations";

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
    expect(gateCheckMessage(decision.checks[0]!)).toContain("proof=failed");
    expect(gateCheckMessage(decision.checks[0]!)).toContain("declared-artifact-not-changed:missing.ts");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("a passing decision carries the wave's task ids and the next wave", () => {
    const decision = evaluateWaveGate(mkGraph(), null, countingDeps().deps);
    expect(decision.wave).toBe(1);
    expect(decision.checks).toHaveLength(7);
    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1"], nextWave: 2 });
  });

  it("applyGateDecision completes the wave, stamps the gate, advances current_wave — and does not mutate its input", () => {
    const state = mkGraph();
    const frozen = JSON.parse(JSON.stringify(state));
    const decision = evaluateWaveGate(state, null, countingDeps().deps);

    const updated = applyGateDecision(state, decision);
    expect(state).toEqual(frozen); // input untouched
    expect(updated.tasks.find((t) => t.id === "T1")?.status).toBe("completed");
    expect(updated.tasks.find((t) => t.id === "T2")?.status).toBe("implemented"); // other waves untouched
    expect(updated.wave_gates["1"]).toMatchObject({ tests_passed: true, reviews_complete: true, blocked: false });
    expect(updated.wave_gates["2"]).toBeDefined();
    expect(updated.current_wave).toBe(2);
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

  it("an explicit --wave argument overrides current_wave", () => {
    const decision = evaluateWaveGate(
      mkGraph({ current_wave: 1, spec_check: specCheck(2) }),
      2,
      countingDeps().deps,
    );
    expect(decision.wave).toBe(2);
    expect(decision.verdict).toMatchObject({ kind: "pass", taskIds: ["T2"], nextWave: null });
  });

  it("an EMPTY wave fails — never a vacuous pass that stamps the gate", () => {
    const decision = evaluateWaveGate(mkGraph(), 7, countingDeps().deps);
    expect(decision.wave).toBe(7);
    expect(decision.checks).toHaveLength(0);
    expect(decision.verdict.kind).toBe("fail");
    if (decision.verdict.kind === "fail") {
      expect(decision.verdict.reason).toContain("wave 7 has no tasks");
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
