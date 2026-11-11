/**
 * The Distill Task at the Wave Gate (ADR-0068 §6): it is exempt from Wave
 * review, so it contributes no review subject, packet, slot, workspace or
 * epoch entry, and every gate check states what it owes instead.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { BASE_WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import {
  applyGateDecision,
  checkImplementationProof,
  checkNewTests,
  checkReviewedWorkspace,
  checkReviews,
  checkTestEvidence,
  deriveWaveStartReadiness,
  evaluateWaveGate,
  type GateDeps,
} from "../../src/core/wave-gate-checks";
import { installWaveReviewRunsTransition } from "../../src/core/wave-review-issuance";
import type { RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import {
  isWaveReviewExempt,
  owesWaveReview,
  prepareWaveReviewBatch,
  readWaveReviewContext,
  waveReviewExemption,
  waveReviewOutstanding,
  waveReviewSubjects,
  waveReviewedTasks,
  waveRunRosterProblem,
  waveTaskReviewRoster,
  waveTaskReviewRosters,
  type WaveRequestBatch,
} from "../../src/core/wave-review-authority";
import { generateWaveGateSummary } from "../../src/handlers/helpers/complete-wave-gate";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { ReviewStatus, Task, TaskGraph, TaskStatus } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { value } from "../fixtures/parse-result";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import {
  activeWaveGateFixture,
  distillTaskFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
  type DistillTaskFixtureInput,
} from "../fixtures/task-lifecycle";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PLAN_FILE = ".claude/plans/2026-11-11-distill.md";
const RUN_ID = value(parseOrchestrationRunId("run.distill-wave-gate"));
const AUTHORITY = "a".repeat(64);
const fileOf = (id: string): string => `src/${id.toLowerCase()}.ts`;

const sibling = (id: string, status: TaskStatus = "implemented", extra: Partial<Task> = {}): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave: 1, depends_on: [],
  spec_anchors: [], spec_contributions: [],
  file_list: [fileOf(id)], files_modified: [fileOf(id)],
  status,
  ...(status === "pending" ? {} : { proof: satisfiedProof([fileOf(id)]) }),
  test_result: { verdict: "trusted-pass" },
  new_tests_written: true,
  new_test_evidence: "one property",
  review_status: "pending",
  ...extra,
});

/** The Wave's Distill Task over `siblingIds`' files: never reviewed, so its review status stays `pending`. */
const distill = (
  id: string,
  siblingIds: readonly string[],
  status: TaskStatus = "implemented",
  extra: Partial<DistillTaskFixtureInput> = {},
): Task => distillTaskFixture({ id, wave: 1, scope: siblingIds.map(fileOf), status, files_modified: [], ...extra });

const graphOf = (tasks: readonly Task[], overrides: Record<string, unknown> = {}): TaskGraph => protectedGraphFixture({
  spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
  spec_file: null, plan_file: PLAN_FILE, wave_gates: {}, executing_tasks: [],
  tasks,
  ...overrides,
});

const registrationOf = (taskIds: readonly string[]): RegisteredWaveGateProgram => ({
  schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "wave-gate", input: { wave: 1 }, taskIds, authorityDigest: value(parseArtifactDigest(AUTHORITY)),
});

function projectWithPlan(): string {
  const root = canonicalTempDir("loom-distill-wave-gate-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), "# Plan: distill\n");
  return root;
}

const documentsOf = (root: string) => observeWaveSpecCheckDocuments({
  specFile: null, planFile: PLAN_FILE, projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
});

const workspaceOf = (task: Task) => {
  const scope = [...new Set([...(task.file_list ?? []), ...(task.files_modified ?? [])])].sort();
  return observedWorkspace(task.id, scope, scope.map((path) => ({ path, bytes: Buffer.from(`// ${path}\n`) })));
};

/** Prepare the Wave's batch from a workspace of exactly `observedTasks`. */
const prepare = (root: string, graph: TaskGraph, observedTasks: readonly Task[] = waveReviewedTasks(graph.tasks)) =>
  prepareWaveReviewBatch(
    RUN_ID,
    { ...registrationOf(graph.tasks.map(({ id }) => id)), input: { wave: 1 } },
    graph, 1, observedTasks.map(workspaceOf), documentsOf(root),
  );

const prepared = (root: string, graph: TaskGraph): WaveRequestBatch => {
  const batch = prepare(root, graph);
  if (!batch.ok) throw new Error(`issuance refused: ${batch.error.message}`);
  return batch.value;
};

describe("Wave review roster of a Distill Task (ADR-0068 §6)", () => {
  const graph = graphOf([sibling("T1"), sibling("T2"), distill("T3", ["T1", "T2"])]);
  const [t1, , t3] = graph.tasks;

  it("is the explicit exemption, never an empty roster", () => {
    const review = waveTaskReviewRoster(graph, 2, t3!);
    expect(review).toEqual({ kind: "exempt", reason: "distill-task" });
    expect(isWaveReviewExempt(review)).toBe(true);
    expect(waveReviewExemption(t3!)).toEqual(review);
    expect(owesWaveReview(t3!)).toBe(false);
  });

  it("leaves every other Task its derived roster", () => {
    const review = waveTaskReviewRoster(graph, 2, t1!);
    expect(isWaveReviewExempt(review)).toBe(false);
    expect(review).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(waveReviewExemption(t1!)).toBeNull();
  });

  it("contributes no roster to the registered Wave's rosters, and no subject", () => {
    const rosters = waveTaskReviewRosters(graph, 2, ["T1", "T2", "T3"]);
    expect(rosters).toEqual({ ok: true, value: [
      { taskId: "T1", roster: BASE_WAVE_REVIEW_AGENTS },
      { taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS },
    ] });
    if (!rosters.ok) return;
    expect(waveReviewSubjects(rosters.value).some(({ taskId }) => taskId === "T3")).toBe(false);
  });

  it("refuses any persisted Review Run on it as a roster problem", () => {
    const run = { expected_agents: [] as never, slot_authority: undefined };
    expect(waveRunRosterProblem(graph, 2, t3!, run)).toEqual({
      kind: "task-exempt", taskId: "T3", exemption: { kind: "exempt", reason: "distill-task" },
    });
  });

  it("is never outstanding for review, whatever its stored review status", () => {
    const statuses: readonly (ReviewStatus | undefined)[] = [undefined, "pending", "passed", "blocked", "evidence_capture_failed"];
    for (const review_status of statuses) {
      expect(waveReviewOutstanding({ agent: DISTILL_AGENT, review_status })).toBe(false);
      expect(waveReviewOutstanding({ agent: "code-implementer-agent", review_status }))
        .toBe(review_status !== "passed" && review_status !== "blocked");
    }
  });
});

describe("Wave review batch of a Wave with a Distill Task", () => {
  const siblings = [sibling("T1"), sibling("T2")];
  const withDistill = graphOf([...siblings, distill("T3", ["T1", "T2"])]);
  const without = graphOf(siblings);

  it("prepares exactly the siblings' subjects, packets and Task runs", () => {
    const batch = prepared(projectWithPlan(), withDistill);
    const expected = [
      { role: "spec-check-invoker", taskId: null },
      ...["T1", "T2"].flatMap((taskId) => BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId }))),
    ];
    expect(batch.subjects).toEqual(expected);
    expect(batch.requests).toHaveLength(expected.length);
    expect(batch.packets).toHaveLength(expected.length);
    expect(batch.taskRuns.map(({ taskId }) => taskId)).toEqual(["T1", "T2"]);
  });

  it("keeps the epoch, Task runs and subjects of the same Wave without the Distill Task", () => {
    const root = projectWithPlan();
    const one = prepared(root, withDistill);
    const other = prepared(root, without);
    expect(one.batchEpoch).toBe(other.batchEpoch);
    expect(one.taskRuns).toEqual(other.taskRuns);
    expect(one.subjects).toEqual(other.subjects);
  });

  it("keeps the Distill Task on the spec-check scope, the Wave's truthful roster", () => {
    const batch = prepared(projectWithPlan(), withDistill);
    const context = readWaveReviewContext(batch.packets, batch.packets[0]!.digest);
    if (context.kind !== "loaded" || context.value.specCheckScope === null) throw new Error("spec-check context missing");
    expect(context.value.specCheckScope.map(({ id }) => id)).toEqual(["T1", "T2", "T3"]);
    expect(context.value.specCheckScope[2]).toMatchObject({ completionAnchors: [], contributions: [], modifiedFiles: [] });
  });

  it("refuses a workspace observation of the Distill Task: it has no reviewed workspace", () => {
    const refused = prepare(projectWithPlan(), withDistill, withDistill.tasks);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("workspace observations differ");
  });

  it("still refuses a missing sibling observation", () => {
    expect(prepare(projectWithPlan(), withDistill, [withDistill.tasks[0]!]).ok).toBe(false);
  });

  it("installs Review Runs on the siblings and leaves the Distill Task untouched", () => {
    const root = projectWithPlan();
    const registration = registrationOf(["T1", "T2", "T3"]);
    const locked = graphOf(withDistill.tasks, {
      active_wave_gate: activeWaveGateFixture({ runId: RUN_ID, wave: 1, authorityDigest: AUTHORITY }),
    });
    const batch = prepared(root, locked);
    const installed = installWaveReviewRunsTransition(locked, {
      registration, batch, workspaces: waveReviewedTasks(locked.tasks).map(workspaceOf), specCheckObservation: documentsOf(root),
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const [t1, t2, t3] = installed.value.tasks;
    expect(t1!.review_run?.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(t2!.review_run?.expected_agents).toEqual(BASE_WAVE_REVIEW_AGENTS);
    expect(t3).toBe(locked.tasks[2]);
    expect(t3!.review_run).toBeUndefined();
    // Replaying the install over its own result changes nothing.
    const replay = installWaveReviewRunsTransition(installed.value, {
      registration, batch, workspaces: waveReviewedTasks(locked.tasks).map(workspaceOf), specCheckObservation: documentsOf(root),
    });
    expect(replay.ok && replay.value.tasks).toEqual(installed.value.tasks);
  });

  it("for any Wave, the batch's Task subjects are exactly the non-Distill Tasks' subjects, in order", () => {
    const root = projectWithPlan();
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.boolean(),
      (count, hasDistill) => {
        const ids = Array.from({ length: count }, (_, index) => `T${index + 1}`);
        const tasks = [...ids.map((id) => sibling(id)), ...(hasDistill ? [distill(`T${count + 1}`, ids)] : [])];
        const batch = prepared(root, graphOf(tasks));
        const expected = ids.flatMap((taskId) => BASE_WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId })));
        expect(batch.subjects.slice(1)).toEqual(expected);
        expect(batch.taskRuns.map(({ taskId }) => taskId)).toEqual(ids);
        expect(new Set(batch.requests.map(({ authority }) => authority.slotId)).size).toBe(expected.length + 1);
      },
    ), { numRuns: 12 });
  });
});

describe("Wave Gate checks over a Distill Task", () => {
  const reviewed = (id: string): Task => sibling(id, "implemented", { review_status: "passed" });
  const deps: GateDeps = {
    loadPlanModels: () => ({ kind: "loaded", models: { lifecycles: [], pipeline: null, invariants: [], contracts: [], strays: [] } }),
    filePresence: () => ({ ok: true, exists: true }),
  };
  const gateGraph = (tasks: readonly Task[]): TaskGraph => graphOf(tasks, {
    wave_gates: { "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false } },
    spec_check: capturedSpecCheck({ wave: 1, runAt: "", criticalFindings: [] }),
    active_wave_gate: activeWaveGateFixture({ runId: RUN_ID, wave: 1, authorityDigest: AUTHORITY }),
  });

  it("implementation proof is owed: a pending Distill Task keeps the gate from starting", () => {
    const graph = graphOf([reviewed("T1"), distill("T2", ["T1"], "pending")]);
    const check = checkImplementationProof(graph.tasks);
    expect(check.passed).toBe(false);
    if (!check.passed) expect(check.reason).toContain("T2 (status=pending, proof=pending)");
    const readiness = deriveWaveStartReadiness(graph, graph.tasks);
    expect(readiness.kind).toBe("not-ready");
    if (readiness.kind === "not-ready") expect(readiness.failures).toHaveLength(1);
  });

  it("an implemented Distill Task lets the gate start", () => {
    const graph = graphOf([reviewed("T1"), distill("T2", ["T1"])]);
    expect(deriveWaveStartReadiness(graph, graph.tasks)).toEqual({ kind: "ready" });
  });

  it("test evidence is not owed and is reported as waived, never as passed", () => {
    const expected = {
      passed: true,
      summary: "2. Test evidence verified (2/2 tasks):\n     T1: evidence present\n" +
        "     T2: not required (verification_policy.regression waived: distill-pass)",
    };
    // With no test result at all (the pass changed nothing) ...
    expect(checkTestEvidence([reviewed("T1"), distill("T2", ["T1"])])).toEqual(expected);
    // ... and with one (the pass changed scope and ran the tests): its evidence
    // lives in its `behaviour-preserved` obligation, not in this check.
    const ran = distill("T2", ["T1"], "implemented", { test_result: { verdict: "trusted-pass" }, test_evidence: "12 passed" });
    expect(checkTestEvidence([reviewed("T1"), ran])).toEqual(expected);
  });

  it("new tests are not owed", () => {
    const check = checkNewTests([reviewed("T1"), distill("T2", ["T1"])]);
    expect(check.passed).toBe(true);
    if (check.passed) expect(check.summary).toContain("T2: not required (verification_policy.new_tests waived: distill-pass)");
  });

  it("reviews are not owed: the check counts only reviewed Tasks and says why the Distill Task is absent", () => {
    const check = checkReviews([reviewed("T1"), distill("T2", ["T1"])]);
    expect(check).toEqual({
      passed: true,
      summary: "5. Reviews verified (1/1 tasks):\n     T1: passed\n     T2: not required (exempt from Wave review: distill-task)",
    });
  });

  it("an unreviewed sibling still fails the review check, and the Distill Task is never named unreviewed", () => {
    const check = checkReviews([sibling("T1"), distill("T2", ["T1"])]);
    expect(check).toEqual({ passed: false, reason: "FAILED: Not all tasks have been reviewed.\n  Unreviewed: T1" });
  });

  it("reviewed-workspace drift observes and compares only reviewed Tasks", () => {
    const accepted = { generation: 0, packet_id: AUTHORITY, head_sha: workspaceOf(reviewed("T1")).headSha, scope: [fileOf("T1")] };
    const t1 = { ...reviewed("T1"), accepted_review_authority: accepted } as Task;
    const observedIds: string[][] = [];
    const check = checkReviewedWorkspace([t1, distill("T2", ["T1"])], {
      ...deps,
      reviewedWorkspace: (tasks) => {
        observedIds.push(tasks.map(({ id }) => id));
        return tasks.map(workspaceOf);
      },
    });
    expect(observedIds).toEqual([["T1"]]);
    expect(check).toEqual({ passed: true, summary: "9. Review Packet workspace integrity verified (1/1 tasks)." });
  });

  it("completes with its Wave, keeping its never-reviewed status instead of a fake `passed`", () => {
    const state = gateGraph([reviewed("T1"), distill("T2", ["T1"])]);
    const decision = evaluateWaveGate(state, null, deps);
    expect(decision.verdict).toEqual({ kind: "pass", taskIds: ["T1", "T2"], nextWave: null });
    const completed = applyGateDecision(state, decision);
    expect(completed.tasks.map(({ id, status, review_status }) => ({ id, status, review_status }))).toEqual([
      { id: "T1", status: "completed", review_status: "passed" },
      { id: "T2", status: "completed", review_status: "pending" },
    ]);
    expect(completed.tasks[1]!.accepted_review_authority).toBeUndefined();
    expect(completed.wave_gates["1"]).toMatchObject({ impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false });
    // The completed graph is one the State File loads.
    const { active_wave_gate: _retired, ...archived } = completed;
    expect(protectedGraphFixture(archived).tasks[1]).toMatchObject({ id: "T2", status: "completed", review_status: "pending" });
  });

  it("a Wave whose Distill Task is still pending cannot complete", () => {
    const state = gateGraph([reviewed("T1"), distill("T2", ["T1"], "pending")]);
    const decision = evaluateWaveGate(state, null, deps);
    expect(decision.verdict.kind).toBe("fail");
    expect(applyGateDecision(state, decision)).toBe(state);
  });

  it("the Wave summary reports the Distill Task as not reviewed", () => {
    const summary = generateWaveGateSummary(1, [reviewed("T1"), distill("T2", ["T1"], "completed")]);
    expect(summary).toContain("**Status:** passed — 0 critical, 0 advisory");
    expect(summary).toContain("**Status:** not reviewed (exempt from Wave review: distill-task)");
  });
});
