import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  completionEligibility,
  deriveFindingCounts,
  deriveTestReadiness,
  deriveTestReadinessForTasks,
  failedProofs,
  nonEmptyReasons,
  panelNeed,
  readinessReasons,
  reviewFacts,
  statusReason,
  taskCounts,
} from "../../src/core/wave-status-facts";
import type { GateCheck, GateDecision } from "../../src/core/wave-gate-checks";
import { attributeFindings } from "../../src/core/findings";
import type { Finding, RefutedFinding, ResolvedFinding, ReviewStatus, Task, TaskGraph } from "../../src/types";
import { graphFixture, taskFixture, type TaskFixtureInput } from "../fixtures/task-lifecycle";

type TaskExtras = Omit<TaskFixtureInput, "id" | "description" | "agent" | "wave" | "depends_on">;

const task = (id: string, extras: TaskExtras = {}, wave = 1): Task =>
  taskFixture({ id, description: `task ${id}`, agent: "code-implementer-agent", wave, depends_on: [], ...extras });

/** Every test-readiness requirement satisfied: a trusted regression pass and observed new tests. */
const testReady: TaskExtras = {
  test_result: { verdict: "trusted-pass" },
  new_tests_written: true,
  new_test_evidence: "tests/new.test.ts",
};

const withExecuting = (graph: TaskGraph, executing: readonly string[]): TaskGraph => ({ ...graph, executing_tasks: [...executing] });

const findings = attributeFindings([
  { severity: "critical", claim: "critical one", file: null, line: null },
  { severity: "critical", claim: "critical two", file: null, line: null },
  { severity: "advisory", claim: "advisory one", file: null, line: null },
], "code-reviewer");

const refuted = (finding: Finding): RefutedFinding => ({ finding, refutations: [{ lens: "correctness", reason: "not reachable" }] });
const resolved = (finding: Finding): ResolvedFinding => ({
  finding,
  resolution: {
    kind: "resolved_by_remediation",
    generation: 1,
    packet_id: "p".repeat(64),
    head_sha: "h".repeat(40),
    expected_agents: ["code-reviewer"],
    assessments: [{ finding_id: finding.id, verdict: "resolved_by_remediation", reason: "fixed", agent: "code-reviewer" }],
  },
});

const passCheck = (summary: string): GateCheck => ({ passed: true, summary });
const failCheck = (reason: string): GateCheck => ({ passed: false, reason });
const passDecision = (checks: readonly GateCheck[]): GateDecision =>
  ({ wave: 1, checks, verdict: { kind: "pass", taskIds: ["T1"], nextWave: null } });
const failDecision = (checks: readonly GateCheck[], reason: string): GateDecision =>
  ({ wave: 1, checks, verdict: { kind: "fail", reason } });

describe("statusReason / nonEmptyReasons", () => {
  it("builds a frozen reason defaulting taskId to null", () => {
    const reason = statusReason("task-running", "T1 is still executing");
    expect(reason).toEqual({ kind: "task-running", message: "T1 is still executing", taskId: null });
    expect(Object.isFrozen(reason)).toBe(true);
    expect(statusReason("proof-failed", "m", "T9")).toEqual({ kind: "proof-failed", message: "m", taskId: "T9" });
  });

  it("returns the supplied reasons, or exactly the fallback when there are none", () => {
    const fallback = statusReason("wave-gate-ready", "ready");
    const supplied = [statusReason("task-running", "a", "T1"), statusReason("proof-failed", "b", "T2")];
    const kept = nonEmptyReasons(supplied, fallback);
    expect(kept).toEqual(supplied);
    expect(Object.isFrozen(kept)).toBe(true);
    const fellBack = nonEmptyReasons([], fallback);
    expect(fellBack).toEqual([fallback]);
    expect(Object.isFrozen(fellBack)).toBe(true);
  });
});

describe("taskCounts", () => {
  it("buckets each task by precedence: completed > blocked > running > implemented > pending", () => {
    const failedProof = task("pending-failed-proof", { status: "failed" });
    const proof = failedProof.proof;
    if (proof?.state !== "failed") throw new Error("failed proof fixture expected");
    const graph = withExecuting(graphFixture([
      task("completed-and-executing", { status: "completed", review_status: "blocked" }),
      task("failed", { status: "failed" }),
      task("pending-with-failed-proof", { status: "pending", proof }),
      task("review-blocked", { status: "implemented", review_status: "blocked" }),
      task("capture-failed", { status: "pending", review_status: "evidence_capture_failed", review_evidence_failures: ["code-reviewer"], review_error: "e" }),
      task("running", { status: "implemented" }),
      task("implemented", { status: "implemented", review_status: "passed" }),
      task("pending"),
      task("pending-executing-blocked", { status: "failed" }),
    ]), ["completed-and-executing", "running", "pending-executing-blocked"]);
    expect(taskCounts(graph)).toEqual({ pending: 1, running: 1, implemented: 1, blocked: 5, completed: 1 });
    expect(Object.isFrozen(taskCounts(graph))).toBe(true);
  });

  it("counts an empty graph as all zeros and tolerates absent executing_tasks", () => {
    expect(taskCounts(graphFixture([]))).toEqual({ pending: 0, running: 0, implemented: 0, blocked: 0, completed: 0 });
    expect(taskCounts(graphFixture([task("T1")]))).toEqual({ pending: 1, running: 0, implemented: 0, blocked: 0, completed: 0 });
  });
});

describe("failedProofs", () => {
  it("lists every failure of every failed proof, tagged with its task, in graph order", () => {
    const failedA = task("A", { status: "failed" });
    const failedB = task("B", { status: "failed", new_tests_required: false });
    const graph = graphFixture([task("ok", { status: "implemented" }), failedA, task("pending"), failedB]);
    const expected = [failedA, failedB].flatMap((entry) =>
      entry.proof?.state === "failed" ? entry.proof.failures.map((failure) => ({ taskId: entry.id, failure })) : []);
    expect(expected.map(({ taskId, failure }) => `${taskId}:${failure.kind}`)).toEqual([
      "A:task-not-completed", "A:test-result-missing", "A:new-tests-not-observed",
      "B:task-not-completed",
    ]);
    const proofs = failedProofs(graph);
    expect(proofs).toEqual(expected);
    expect(Object.isFrozen(proofs)).toBe(true);
  });

  it("is empty when no proof failed", () => {
    expect(failedProofs(graphFixture([task("T1"), task("T2", { status: "completed" })]))).toEqual([]);
  });
});

describe("deriveTestReadinessForTasks / deriveTestReadiness", () => {
  it("is ready when every task has passing evidence and observed new tests", () => {
    const readiness = deriveTestReadinessForTasks([task("T1", testReady), task("T2", testReady)]);
    expect(readiness).toEqual({ kind: "ready", affectedTasks: [] });
    expect(Object.isFrozen(readiness)).toBe(true);
  });

  it("is ready for an empty task list", () => {
    expect(deriveTestReadinessForTasks([])).toEqual({ kind: "ready", affectedTasks: [] });
  });

  it("names each unready task with every reason it is unready, in task order", () => {
    const readiness = deriveTestReadinessForTasks([
      task("ready", testReady),
      task("nothing"),
      task("failed-run", { ...testReady, test_result: { verdict: "trusted-fail" } }),
      task("untrusted-pass", { ...testReady, test_result: { verdict: "untrusted", passed: true, label: "pytest", provenance: "unverified" } }),
      task("no-new-tests", { test_result: { verdict: "trusted-pass" }, new_tests_written: true, new_test_evidence: "   " }),
      task("waived", { new_tests_required: false }),
    ]);
    expect(readiness).toEqual({
      kind: "not-ready",
      affectedTasks: [
        { taskId: "nothing", reasons: ["passing test evidence is missing", "required new tests were not observed"] },
        { taskId: "failed-run", reasons: ["passing test evidence is missing"] },
        { taskId: "no-new-tests", reasons: ["required new tests were not observed"] },
      ],
    });
  });

  it("restricts the graph projection to the requested wave", () => {
    const graph = graphFixture([task("W1-ready", testReady, 1), task("W2-bare", {}, 2), task("W1-bare", {}, 1)]);
    expect(deriveTestReadiness(graph, 1)).toEqual({
      kind: "not-ready",
      affectedTasks: [{ taskId: "W1-bare", reasons: ["passing test evidence is missing", "required new tests were not observed"] }],
    });
    expect(deriveTestReadiness(graph, 2)).toEqual({
      kind: "not-ready",
      affectedTasks: [{ taskId: "W2-bare", reasons: ["passing test evidence is missing", "required new tests were not observed"] }],
    });
    expect(deriveTestReadiness(graph, 3)).toEqual({ kind: "ready", affectedTasks: [] });
  });
});

describe("reviewFacts", () => {
  const legacyRun = (expected: readonly [string, ...string[]], supplied: readonly string[]) => ({
    generation: 4,
    packet_id: "p".repeat(64),
    head_sha: "h".repeat(40),
    expected_agents: expected,
    prior_finding_ids: [],
    evidence: supplied.map((agent) => ({ agent, prior_assessments: [], new_findings: [] })),
  });

  it("reports each expected reviewer that has not supplied evidence as a roster gap", () => {
    const graph = graphFixture([
      task("T1", { review_generation: 4, review_run: legacyRun(["code-reviewer", "silent-failure-hunter", "type-design-analyzer"], ["silent-failure-hunter"]) }),
      task("T2", { review_generation: 4, review_run: legacyRun(["code-reviewer"], ["code-reviewer"]) }),
      task("T3"),
    ]);
    const facts = reviewFacts(graph);
    expect(facts).toEqual({
      rosterGaps: [
        { taskId: "T1", generation: 4, packetId: "p".repeat(64), agent: "code-reviewer" },
        { taskId: "T1", generation: 4, packetId: "p".repeat(64), agent: "type-design-analyzer" },
      ],
      evidenceFailures: [],
    });
    expect(Object.isFrozen(facts.rosterGaps)).toBe(true);
    expect(Object.isFrozen(facts.evidenceFailures)).toBe(true);
  });

  it("reports evidence failures with run authority, generation fallback and default error", () => {
    const graph = graphFixture([
      task("with-run", {
        review_status: "evidence_capture_failed", review_evidence_failures: ["code-reviewer"], review_error: "CRITICAL_COUNT marker not found",
        review_generation: 4, review_run: legacyRun(["code-reviewer", "silent-failure-hunter"], ["silent-failure-hunter"]),
      }),
      task("generation-only", {
        review_status: "evidence_capture_failed", review_evidence_failures: ["a", "b"], review_generation: 7,
      }),
      task("bare", { review_status: "evidence_capture_failed", review_evidence_failures: ["c"], review_error: "boom" }),
    ]);
    expect(reviewFacts(graph)).toEqual({
      rosterGaps: [{ taskId: "with-run", generation: 4, packetId: "p".repeat(64), agent: "code-reviewer" }],
      evidenceFailures: [
        { taskId: "with-run", generation: 4, packetId: "p".repeat(64), agent: "code-reviewer", error: "CRITICAL_COUNT marker not found" },
        { taskId: "generation-only", generation: 7, packetId: null, agent: "a", error: "review evidence capture failed" },
        { taskId: "generation-only", generation: 7, packetId: null, agent: "b", error: "review evidence capture failed" },
        { taskId: "bare", generation: null, packetId: null, agent: "c", error: "boom" },
      ],
    });
  });
});

describe("deriveFindingCounts", () => {
  it("counts authoritative findings by severity, ignoring the derived views when findings exist", () => {
    const counts = deriveFindingCounts([task("T1", {
      findings,
      critical_findings: ["view-only critical that must not be double counted"],
      advisory_findings: [],
      resolved_findings: [resolved(findings[0]!)],
      refuted_findings: [refuted(findings[1]!), refuted(findings[2]!)],
    })]);
    expect(counts).toEqual({ activeCritical: 2, advisory: 1, resolved: 1, refuted: 2 });
    expect(Object.isFrozen(counts)).toBe(true);
  });

  it("falls back to non-blank legacy view strings when findings are absent", () => {
    expect(deriveFindingCounts([
      task("legacy", { critical_findings: ["a", "  ", "", "b"], advisory_findings: ["x", "\t"] }),
      task("empty-findings", { findings: [], critical_findings: ["ignored"] }),
      task("none"),
    ])).toEqual({ activeCritical: 2, advisory: 1, resolved: 0, refuted: 0 });
  });

  it("is zero for no tasks", () => {
    expect(deriveFindingCounts([])).toEqual({ activeCritical: 0, advisory: 0, resolved: 0, refuted: 0 });
  });
});

describe("panelNeed", () => {
  it("is needed for the active wave's critical findings, legacy views numbered from 1", () => {
    const graph = graphFixture([
      task("T1", { findings }),
      task("T2", { critical_findings: ["", "legacy a", " ", "legacy b"] }),
      task("T3", { findings: [findings[2]!] }),
      task("other-wave", { findings }, 2),
    ]);
    expect(panelNeed(graph, 1)).toEqual({
      kind: "needed",
      findingIds: ["T1:code-reviewer-1", "T1:code-reviewer-2", "T2:legacy-critical:2", "T2:legacy-critical:4"],
      reasons: ["4 active critical Finding(s) require refutation"],
    });
  });

  it("is not needed when the wave has only advisories or nothing", () => {
    const graph = graphFixture([task("T1", { findings: [findings[2]!] }), task("T2", { critical_findings: ["  "] }), task("W2", { findings }, 2)]);
    const need = panelNeed(graph, 1);
    expect(need).toEqual({ kind: "not-needed", findingIds: [], reasons: ["the active Wave has no critical Findings"] });
    expect(Object.isFrozen(need)).toBe(true);
    expect(panelNeed(graph, 3)).toEqual({ kind: "not-needed", findingIds: [], reasons: ["the active Wave has no critical Findings"] });
  });
});

describe("completionEligibility", () => {
  it("is eligible when every check passed", () => {
    const eligibility = completionEligibility(passDecision([passCheck("1. ok"), passCheck("2. ok")]));
    expect(eligibility).toEqual({ kind: "eligible", failedPrerequisites: [] });
    expect(Object.isFrozen(eligibility)).toBe(true);
  });

  it("lists every failed check reason in order", () => {
    expect(completionEligibility(failDecision([failCheck("first"), passCheck("ok"), failCheck("second")], "first")))
      .toEqual({ kind: "ineligible", failedPrerequisites: ["first", "second"] });
  });

  it("uses the verdict reason when a failed decision carries no checks", () => {
    expect(completionEligibility(failDecision([], "FAILED: wave 1 has no tasks")))
      .toEqual({ kind: "ineligible", failedPrerequisites: ["FAILED: wave 1 has no tasks"] });
  });

  it("does not repeat the verdict reason when failed checks already state it", () => {
    expect(completionEligibility(failDecision([failCheck("only")], "only")))
      .toEqual({ kind: "ineligible", failedPrerequisites: ["only"] });
  });

  it("is eligible for a passing decision with no checks", () => {
    expect(completionEligibility(passDecision([]))).toEqual({ kind: "eligible", failedPrerequisites: [] });
  });
});

describe("readinessReasons", () => {
  const reasonsFor = (graph: TaskGraph, decision: GateDecision, wave = 1) => readinessReasons(
    graph, wave, decision, reviewFacts(graph), panelNeed(graph, wave), deriveTestReadiness(graph, wave), completionEligibility(decision),
  );

  it("reports a blocked wave's every reason, scoped to the wave, in category order", () => {
    const failed = task("T2", { status: "failed", review_status: "evidence_capture_failed", review_evidence_failures: ["silent-failure-hunter"], review_error: "unparseable" });
    const proofCount = failed.proof?.state === "failed" ? failed.proof.failures.length : 0;
    expect(proofCount).toBe(3);
    const graph = withExecuting(graphFixture([
      task("T1", {
        ...testReady, findings,
        review_generation: 2,
        review_run: { generation: 2, packet_id: "q".repeat(64), head_sha: "h".repeat(40), expected_agents: ["code-reviewer"], prior_finding_ids: [], evidence: [] },
      }),
      failed,
      task("W2", { review_status: "evidence_capture_failed", review_evidence_failures: ["x"] }, 2),
    ]), ["T1", "W2"]);
    const decision = failDecision([failCheck("FAILED: executing"), failCheck("FAILED: tests")], "FAILED: executing");
    expect(reasonsFor(graph, decision)).toEqual([
      { kind: "task-running", message: "T1 is still executing", taskId: "T1" },
      { kind: "proof-failed", message: "T2 has 3 failed proof obligation(s)", taskId: "T2" },
      { kind: "tests-not-ready", message: "T2: passing test evidence is missing; required new tests were not observed", taskId: "T2" },
      { kind: "review-roster-gap", message: "T1 is missing review evidence from code-reviewer", taskId: "T1" },
      { kind: "review-evidence-failure", message: "T2/silent-failure-hunter: unparseable", taskId: "T2" },
      { kind: "refutation-required", message: "2 active critical Finding(s) require refutation", taskId: null },
      { kind: "completion-prerequisite-failed", message: "FAILED: executing", taskId: null },
      { kind: "completion-prerequisite-failed", message: "FAILED: tests", taskId: null },
    ]);
  });

  it("reports only completion eligibility for a clean, eligible wave", () => {
    const graph = graphFixture([task("T1", { ...testReady, status: "implemented", review_status: "passed" })]);
    const reasons = reasonsFor(graph, passDecision([passCheck("ok")]));
    expect(reasons).toEqual([
      { kind: "completion-eligible", message: "Wave 1 satisfies every completion prerequisite", taskId: null },
    ]);
    expect(Object.isFrozen(reasons)).toBe(true);
  });

  it("states the panel need beside eligibility when only criticals remain", () => {
    const graph = graphFixture([task("T1", { ...testReady, critical_findings: ["legacy"] })]);
    expect(reasonsFor(graph, passDecision([passCheck("ok")]))).toEqual([
      { kind: "refutation-required", message: "1 active critical Finding(s) require refutation", taskId: null },
      { kind: "completion-eligible", message: "Wave 1 satisfies every completion prerequisite", taskId: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const reviewStatuses: readonly (ReviewStatus | undefined)[] = [undefined, "pending", "passed", "blocked", "evidence_capture_failed"];

const taskArbitrary = fc.record({
  status: fc.constantFrom("pending" as const, "implemented" as const, "completed" as const, "failed" as const),
  review: fc.constantFrom(...reviewStatuses),
  wave: fc.integer({ min: 1, max: 3 }),
  executing: fc.boolean(),
  criticals: fc.array(fc.constantFrom("claim", " ", ""), { maxLength: 4 }),
  advisories: fc.array(fc.constantFrom("note", "\t"), { maxLength: 3 }),
  structured: fc.boolean(),
  ready: fc.boolean(),
});

type TaskSpec = typeof taskArbitrary extends fc.Arbitrary<infer T> ? T : never;

function graphOf(specs: readonly TaskSpec[]): TaskGraph {
  const tasks = specs.map((spec, index) => task(`T${index}`, {
    status: spec.status,
    ...(spec.review === undefined ? {} : { review_status: spec.review }),
    ...(spec.review === "evidence_capture_failed" ? { review_evidence_failures: ["code-reviewer"] } : {}),
    ...(spec.structured ? { findings } : { critical_findings: spec.criticals, advisory_findings: spec.advisories }),
    ...(spec.ready ? testReady : {}),
  }, spec.wave));
  return withExecuting(graphFixture(tasks), specs.flatMap((spec, index) => spec.executing ? [`T${index}`] : []));
}

const add = (a: ReturnType<typeof deriveFindingCounts>, b: ReturnType<typeof deriveFindingCounts>) => ({
  activeCritical: a.activeCritical + b.activeCritical,
  advisory: a.advisory + b.advisory,
  resolved: a.resolved + b.resolved,
  refuted: a.refuted + b.refuted,
});

describe("status fact properties", () => {
  it("taskCounts places every task in exactly one bucket and is order-independent", () => {
    fc.assert(fc.property(fc.array(taskArbitrary, { maxLength: 12 }), (specs) => {
      const graph = graphOf(specs);
      const counts = taskCounts(graph);
      expect(counts.pending + counts.running + counts.implemented + counts.blocked + counts.completed).toBe(specs.length);
      expect(counts.completed).toBe(specs.filter((spec) => spec.status === "completed").length);
      expect(taskCounts({ ...graph, tasks: [...graph.tasks].reverse() })).toEqual(counts);
    }), { seed: 20261005, numRuns: 200 });
  });

  it("deriveFindingCounts is additive over task-list concatenation", () => {
    fc.assert(fc.property(fc.array(taskArbitrary, { maxLength: 6 }), fc.array(taskArbitrary, { maxLength: 6 }), (left, right) => {
      const a = graphOf(left).tasks;
      const b = graphOf(right).tasks;
      expect(deriveFindingCounts([...a, ...b])).toEqual(add(deriveFindingCounts(a), deriveFindingCounts(b)));
    }), { seed: 20261006, numRuns: 200 });
  });

  it("panelNeed names exactly the wave's active critical count, and is needed iff that count is positive", () => {
    fc.assert(fc.property(fc.array(taskArbitrary, { maxLength: 12 }), fc.integer({ min: 1, max: 3 }), (specs, wave) => {
      const graph = graphOf(specs);
      const critical = deriveFindingCounts(graph.tasks.filter((entry) => entry.wave === wave)).activeCritical;
      const need = panelNeed(graph, wave);
      expect(need.findingIds.length).toBe(critical);
      expect(new Set(need.findingIds).size).toBe(critical);
      expect(need.kind).toBe(critical > 0 ? "needed" : "not-needed");
    }), { seed: 20261007, numRuns: 200 });
  });

  it("test readiness affects exactly the wave tasks lacking evidence, in graph order", () => {
    fc.assert(fc.property(fc.array(taskArbitrary, { maxLength: 12 }), fc.integer({ min: 1, max: 3 }), (specs, wave) => {
      const graph = graphOf(specs);
      const readiness = deriveTestReadiness(graph, wave);
      const expected = graph.tasks.filter((entry, index) => entry.wave === wave && !specs[index]!.ready).map((entry) => entry.id);
      expect(readiness.affectedTasks.map(({ taskId }) => taskId)).toEqual(expected);
      expect(readiness.kind).toBe(expected.length === 0 ? "ready" : "not-ready");
    }), { seed: 20261008, numRuns: 200 });
  });

  it("completion eligibility lists exactly the failed checks' reasons, in order", () => {
    const check = fc.oneof(
      fc.string().map(passCheck),
      fc.string().map(failCheck),
    );
    fc.assert(fc.property(fc.array(check, { minLength: 1, maxLength: 8 }), (checks) => {
      const failedReasons = checks.flatMap((entry) => entry.passed ? [] : [entry.reason]);
      const eligibility = completionEligibility(failedReasons.length === 0 ? passDecision(checks) : failDecision(checks, failedReasons[0]!));
      expect(eligibility.failedPrerequisites).toEqual(failedReasons);
      expect(eligibility.kind).toBe(failedReasons.length === 0 ? "eligible" : "ineligible");
    }), { seed: 20261009, numRuns: 200 });
  });

  it("readinessReasons is never empty and reports eligibility exactly once per eligible wave", () => {
    fc.assert(fc.property(fc.array(taskArbitrary, { maxLength: 8 }), fc.boolean(), (specs, eligible) => {
      const graph = graphOf(specs);
      const decision = eligible ? passDecision([passCheck("ok")]) : failDecision([failCheck("blocked")], "blocked");
      const reasons = readinessReasons(graph, 1, decision, reviewFacts(graph), panelNeed(graph, 1), deriveTestReadiness(graph, 1), completionEligibility(decision));
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.filter(({ kind }) => kind === "completion-eligible").length).toBe(eligible ? 1 : 0);
      expect(reasons.filter(({ kind }) => kind === "completion-prerequisite-failed").length).toBe(eligible ? 0 : 1);
      expect(reasons.at(-1)!.kind).toBe(eligible ? "completion-eligible" : "completion-prerequisite-failed");
    }), { seed: 20261010, numRuns: 200 });
  });
});
