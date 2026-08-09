import { describe, expect, it } from "vitest";
import {
  applyFindingOutcomes,
  mergeFindings,
  recordReviewRunEvidence,
  startReviewRun,
  type Finding,
} from "../../src/core/findings";
import {
  applyReviewResolution,
  invalidateTaskReview,
  makeParsedFindings,
  resolveBoundReviewFindings,
  resolveTaskReviewFindings,
  reviewResolutionLog,
} from "../../src/core/review-output";
import { fixFull } from "../../src/handlers/helpers/validate-task-graph";
import { parseTaskGraph } from "../../src/state-manager";
import type { PriorFindingVerdict, ReviewRun, Task, TaskGraph } from "../../src/types";

const PACKET = "a".repeat(64);
const HEAD = "b".repeat(40);
const AGENTS = ["code-reviewer", "silent-failure-hunter"] as const;

const prior = (id: string, agent: string, severity: "critical" | "advisory", claim: string): Finding => ({
  id,
  agent,
  severity,
  file: "src/x.ts",
  line: 1,
  claim,
});

function reviewedTask(): Task {
  const findings = [
    prior("code-reviewer-1", "code-reviewer", "critical", "null result is silently accepted"),
    prior("silent-failure-hunter-1", "silent-failure-hunter", "advisory", "error context is vague"),
  ];
  return {
    id: "T1",
    description: "fix review findings",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    review_status: "pending",
    review_generation: 1,
    findings,
    critical_findings: [findings[0]!.claim],
    advisory_findings: [findings[1]!.claim],
    refuted_findings: [],
    resolved_findings: [],
  };
}

function start(task = reviewedTask()): Task {
  const transition = startReviewRun(task, {
    generation: 1,
    packetId: PACKET,
    headSha: HEAD,
    expectedAgents: AGENTS,
  });
  expect(transition.ok).toBe(true);
  if (!transition.ok) throw new Error(transition.error);
  return transition.task;
}

function transcript(
  run: ReviewRun,
  verdicts: readonly PriorFindingVerdict[],
  findings: readonly { severity: "critical" | "advisory"; claim: string }[] = [],
): string {
  const critical = findings.filter((finding) => finding.severity === "critical");
  const advisory = findings.filter((finding) => finding.severity === "advisory");
  const markerLines = [
    ...critical.map((finding) => `CRITICAL: ${finding.claim}`),
    ...advisory.map((finding) => `ADVISORY: ${finding.claim}`),
  ];
  return [
    "### Machine Summary",
    `REVIEW_GENERATION: ${run.generation}`,
    `REVIEW_PACKET_ID: ${run.packet_id}`,
    `CRITICAL_COUNT: ${critical.length}`,
    `ADVISORY_COUNT: ${advisory.length}`,
    ...markerLines,
    "```findings",
    JSON.stringify(findings.map((finding) => ({ ...finding, file: "src/x.ts", line: 2 }))),
    "```",
    "```review_lifecycle",
    JSON.stringify({
      prior_findings: run.prior_finding_ids.map((finding_id, index) => ({
        finding_id,
        verdict: verdicts[index],
        reason: verdicts[index] === "resolved_by_remediation"
          ? "Verified the remediation in the packet postimage"
          : "The packet still contains the failing behavior",
      })),
    }),
    "```",
  ].join("\n");
}

function applyAgent(
  task: Task,
  agent: string,
  verdicts: readonly PriorFindingVerdict[],
  findings: readonly { severity: "critical" | "advisory"; claim: string }[] = [],
): Task {
  const run = task.review_run!;
  const resolution = resolveBoundReviewFindings(transcript(run, verdicts, findings), agent, run);
  expect(resolution.kind).toBe("findings");
  return applyReviewResolution(task, resolution);
}

function graph(task: Task): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    plan_title: "review lifecycle",
    plan_file: ".claude/plans/review.md",
    spec_file: ".claude/specs/review.md",
    current_wave: 1,
    executing_tasks: [],
    tasks: [task],
    wave_gates: {
      "1": { impl_complete: true, tests_passed: null, reviews_complete: false, blocked: false },
    },
  };
}

describe("packet-bound remediation review runs", () => {
  it("migrates a legacy task onto generation zero when its first packet starts", () => {
    const legacy = { ...reviewedTask(), review_generation: undefined };
    const transition = startReviewRun(legacy, {
      generation: 0,
      packetId: PACKET,
      headSha: HEAD,
      expectedAgents: AGENTS,
    });
    expect(transition.ok).toBe(true);
    if (!transition.ok) return;
    expect(transition.task.review_generation).toBe(0);
    expect(parseTaskGraph(graph(transition.task)).ok).toBe(true);
  });

  it("keeps a first review pending until the complete roster lands", () => {
    const empty: Task = {
      ...reviewedTask(),
      review_generation: 0,
      findings: [],
      critical_findings: [],
      advisory_findings: [],
    };
    const opened = startReviewRun(empty, {
      generation: 0,
      packetId: PACKET,
      headSha: HEAD,
      expectedAgents: AGENTS,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let task = applyAgent(opened.task, AGENTS[0], [], [
      { severity: "critical", claim: "first reviewer blocker" },
    ]);
    expect(task.review_status).toBe("pending");
    expect(task.findings).toEqual([]);
    task = applyAgent(task, AGENTS[1], []);
    expect(task.review_status).toBe("blocked");
    expect(task.critical_findings).toEqual(["first reviewer blocker"]);
  });

  it("finalizes remediation assessments in roster order when reviewers finish in reverse order", () => {
    let task = start();
    task = applyAgent(task, AGENTS[1], ["resolved_by_remediation", "resolved_by_remediation"]);
    task = applyAgent(task, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"]);

    expect(task.resolved_findings?.[0]?.resolution.assessments.map(({ agent }) => agent))
      .toEqual(AGENTS);
    expect(parseTaskGraph(graph(task))).toMatchObject({ ok: true });
  });

  it("recovers legacy view-only findings before freezing the packet snapshot", () => {
    const legacy: Task = {
      ...reviewedTask(),
      findings: undefined,
      critical_findings: ["legacy blocker"],
      advisory_findings: [],
      review_generation: 0,
    };
    const opened = startReviewRun(legacy, {
      generation: 0,
      packetId: PACKET,
      headSha: HEAD,
      expectedAgents: AGENTS,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.task.review_run?.prior_finding_ids).toEqual(["recovered-view-1"]);
    expect(opened.task.findings?.map(({ claim }) => claim)).toEqual(["legacy blocker"]);

    let task = applyAgent(opened.task, AGENTS[0], ["still_present"]);
    task = applyAgent(task, AGENTS[1], ["resolved_by_remediation"]);
    expect(task.critical_findings).toEqual(["legacy blocker"]);
    expect(task.review_status).toBe("blocked");
    expect(parseTaskGraph(graph(task))).toMatchObject({ ok: true });
  });

  it("does not retire anything until every expected reviewer explicitly resolves every prior finding", () => {
    let task = start();
    task = applyAgent(task, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"], [
      { severity: "advisory", claim: "new advice from the first reviewer" },
    ]);

    expect(task.review_status).toBe("pending");
    expect(task.findings).toHaveLength(2);
    expect(task.resolved_findings).toEqual([]);
    expect(task.review_run?.evidence.map(({ agent }) => agent)).toEqual([AGENTS[0]]);

    task = applyAgent(task, AGENTS[1], ["resolved_by_remediation", "resolved_by_remediation"], [
      { severity: "critical", claim: "new blocker from the sibling reviewer" },
    ]);

    expect(task.review_run).toBeUndefined();
    expect(task.review_status).toBe("blocked");
    expect(task.findings?.map(({ claim }) => claim)).toEqual([
      "new advice from the first reviewer",
      "new blocker from the sibling reviewer",
    ]);
    expect(task.critical_findings).toEqual(["new blocker from the sibling reviewer"]);
    expect(task.advisory_findings).toEqual(["new advice from the first reviewer"]);
    expect(task.resolved_findings?.map(({ finding }) => finding.id)).toEqual([
      "code-reviewer-1",
      "silent-failure-hunter-1",
    ]);
    expect(task.resolved_findings?.[0]?.resolution.expected_agents).toEqual(AGENTS);
    expect(task.resolved_findings?.[0]?.resolution.assessments.map(({ agent }) => agent))
      .toEqual(AGENTS);
    expect(task.refuted_findings).toEqual([]);
    expect(parseTaskGraph(graph(task)).ok).toBe(true);
  });

  it("keeps a prior finding active when any reviewer says it is still present", () => {
    let task = start();
    task = applyAgent(task, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"]);
    task = applyAgent(task, AGENTS[1], ["still_present", "resolved_by_remediation"]);

    expect(task.findings?.map(({ id }) => id)).toEqual(["code-reviewer-1"]);
    expect(task.resolved_findings?.map(({ finding }) => finding.id)).toEqual([
      "silent-failure-hunter-1",
    ]);
    expect(task.review_status).toBe("blocked");
  });

  it("cannot retire packet-bound findings without a newer implementation generation", () => {
    const packetBound: Task = {
      ...reviewedTask(),
      findings: reviewedTask().findings?.map((finding) => ({
        ...finding,
        review_generation: 1,
        review_packet_id: "d".repeat(64),
      })),
    };
    let task = start(packetBound);
    task = applyAgent(task, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"]);
    task = applyAgent(task, AGENTS[1], ["resolved_by_remediation", "resolved_by_remediation"]);

    expect(task.resolved_findings).toEqual([]);
    expect(task.findings?.map(({ id }) => id)).toEqual([
      "code-reviewer-1",
      "silent-failure-hunter-1",
    ]);
    expect(task.review_status).toBe("blocked");
  });

  it("requires exactly one lifecycle block even when a packet has no prior findings", () => {
    const empty = start({
      ...reviewedTask(),
      findings: [],
      critical_findings: [],
      advisory_findings: [],
    });
    const run = empty.review_run!;
    const withoutLifecycle = [
      "### Machine Summary",
      `REVIEW_GENERATION: ${run.generation}`,
      `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
    ].join("\n");
    expect(resolveBoundReviewFindings(withoutLifecycle, AGENTS[0], run))
      .toMatchObject({ kind: "evidence-failed", message: expect.stringContaining("block missing") });

    const duplicated = `${transcript(run, [])}\n${transcript(run, []).split("```review_lifecycle")[1] === undefined
      ? ""
      : `\`\`\`review_lifecycle${transcript(run, []).split("```review_lifecycle")[1]}`}`;
    expect(resolveBoundReviewFindings(duplicated, AGENTS[0], run))
      .toMatchObject({ kind: "evidence-failed", message: expect.stringContaining("exactly one") });
  });

  it("fails closed when a rerun omits the lifecycle block or a prior finding", () => {
    const task = start();
    const run = task.review_run!;
    const missingBlock = resolveBoundReviewFindings([
      "### Machine Summary",
      `REVIEW_GENERATION: ${run.generation}`,
      `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
    ].join("\n"), AGENTS[0], run);

    expect(missingBlock).toMatchObject({ kind: "evidence-failed" });
    expect(resolveBoundReviewFindings(
      "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0",
      AGENTS[0],
      run,
    )).toMatchObject({ kind: "evidence-failed" });
    const failed = applyReviewResolution(task, missingBlock);
    expect(failed.review_status).toBe("evidence_capture_failed");
    expect(failed.findings).toEqual(task.findings);
    expect(failed.resolved_findings).toEqual([]);
  });

  it("never falls back to legacy merge when implementation clears a run before its late result arrives", () => {
    const task = start();
    const run = task.review_run!;
    const lateTranscript = transcript(run, ["resolved_by_remediation", "resolved_by_remediation"], [
      { severity: "critical", claim: "stale new finding" },
    ]);
    const invalidated = invalidateTaskReview(task);
    const stale = resolveTaskReviewFindings(
      lateTranscript,
      AGENTS[0],
      invalidated.review_run,
      invalidated.review_generation,
    );

    expect(stale.kind).toBe("ignored-stale");
    expect(applyReviewResolution(invalidated, stale)).toEqual(invalidated);
    expect(invalidated.findings?.map(({ claim }) => claim)).not.toContain("stale new finding");
  });

  it("never treats markerless late output as a legacy review on a generation-aware task", () => {
    const invalidated = invalidateTaskReview(start());
    const markerless = [
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 0",
      "CRITICAL: stale markerless finding",
    ].join("\n");
    const stale = resolveTaskReviewFindings(
      markerless,
      AGENTS[0],
      invalidated.review_run,
      invalidated.review_generation,
    );

    expect(stale).toMatchObject({ kind: "ignored-stale" });
    expect(applyReviewResolution(invalidated, stale)).toEqual(invalidated);
  });

  it("surfaces a matching active-run evidence transition failure instead of logging staged", () => {
    const snapshot = start();
    const run = snapshot.review_run!;
    const resolution = resolveBoundReviewFindings(
      transcript(run, ["resolved_by_remediation", "resolved_by_remediation"]),
      AGENTS[0],
      run,
    );
    expect(resolution.kind).toBe("findings");
    const changedCurrent: Task = {
      ...snapshot,
      review_run: { ...run, prior_finding_ids: [...run.prior_finding_ids].reverse() },
    };
    const applied = applyReviewResolution(changedCurrent, resolution);

    expect(applied.review_status).toBe("evidence_capture_failed");
    expect(applied.review_evidence_failures).toEqual([AGENTS[0]]);
    expect(applied.review_error).toContain("packet order");
    expect(reviewResolutionLog("T1", resolution, applied)).toContain("evidence_capture_failed");
    expect(reviewResolutionLog("T1", resolution, applied)).not.toContain("staged");
  });

  it("does not mint a duplicate when a reviewer re-emits an unchanged prior finding", () => {
    const original = reviewedTask();
    original.findings = original.findings?.map((finding, index) =>
      index === 0 ? { ...finding, line: 2 } : finding
    );
    let task = start(original);
    task = applyAgent(task, AGENTS[0], ["still_present", "still_present"], [
      { severity: "critical", claim: "null result is silently accepted" },
    ]);
    task = applyAgent(task, AGENTS[1], ["still_present", "still_present"]);

    expect(task.findings?.filter(({ claim }) => claim === "null result is silently accepted"))
      .toHaveLength(1);
  });

  it("fails evidence capture when one reviewer resolves and identically re-emits a prior finding", () => {
    const original = reviewedTask();
    original.findings = original.findings?.map((finding, index) =>
      index === 0 ? { ...finding, line: 2 } : finding
    );
    const task = applyAgent(
      start(original),
      AGENTS[0],
      ["resolved_by_remediation", "still_present"],
      [{ severity: "critical", claim: "null result is silently accepted" }],
    );

    expect(task.review_status).toBe("evidence_capture_failed");
    expect(task.review_evidence_failures).toEqual([AGENTS[0]]);
    expect(task.review_error).toContain("cannot mark prior finding code-reviewer-1 resolved_by_remediation");
    expect(task.findings?.filter(({ claim }) => claim === "null result is silently accepted"))
      .toHaveLength(1);
  });

  it("ignores evidence bound to an older packet or generation", () => {
    const task = start();
    const run = task.review_run!;
    const stale = resolveBoundReviewFindings(
      transcript({ ...run, packet_id: "c".repeat(64) }, ["resolved_by_remediation", "resolved_by_remediation"]),
      AGENTS[0],
      run,
    );

    expect(stale.kind).toBe("ignored-stale");
    expect(applyReviewResolution(task, stale)).toEqual(task);
  });

  it("blocks legacy merges and panel adjudication while the run owns the finding snapshot", () => {
    const task = start();
    expect(() => mergeFindings(task, makeParsedFindings({ criticalCount: 0 }), AGENTS[0]))
      .toThrow(/unbound merge cannot mutate active packet/);
    expect(() => applyFindingOutcomes(task, [{
      finding: { id: `T1:${task.findings![0]!.id}`, taskId: "T1" },
      survives: false,
      refutations: [{ lens: "intent", reason: "obsolete" }],
    }])).toThrow(/cannot adjudicate.*still collecting evidence/);
  });

  it("rejects duplicate or non-roster evidence without changing the task", () => {
    const task = start();
    const evidence = {
      agent: AGENTS[0],
      prior_assessments: task.review_run!.prior_finding_ids.map((finding_id) => ({
        finding_id,
        verdict: "resolved_by_remediation" as const,
        reason: "fixed",
      })),
      new_findings: [],
    };
    const first = recordReviewRunEvidence(task, PACKET, 1, evidence);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(recordReviewRunEvidence(first.task, PACKET, 1, evidence)).toMatchObject({ ok: false });
    expect(recordReviewRunEvidence(task, PACKET, 1, { ...evidence, agent: "foreign-reviewer" }))
      .toMatchObject({ ok: false });

    const resolution = resolveBoundReviewFindings(
      transcript(task.review_run!, ["resolved_by_remediation", "resolved_by_remediation"]),
      AGENTS[0],
      task.review_run!,
    );
    const duplicateApplication = applyReviewResolution(first.task, resolution);
    expect(duplicateApplication).toBe(first.task);
    expect(reviewResolutionLog("T1", resolution, duplicateApplication, false)).toContain("evidence ignored");
    expect(reviewResolutionLog("T1", resolution, duplicateApplication, false)).not.toContain("staged");
  });

  it("opens a new generation on implementation writes without deleting audit or active findings", () => {
    const task = start();
    const invalidated = invalidateTaskReview(task);

    expect(invalidated.review_generation).toBe(2);
    expect(invalidated.review_run).toBeUndefined();
    expect(invalidated.review_status).toBe("pending");
    expect(invalidated.findings).toEqual(task.findings);
    expect(invalidated.resolved_findings).toEqual(task.resolved_findings);
  });

  it("proves in-progress runs and remediation audit records at the state boundary", () => {
    const inProgress = start();
    expect(parseTaskGraph(graph(inProgress)).ok).toBe(true);
    const repaired = JSON.parse(fixFull(graph(inProgress) as unknown as Record<string, unknown>).json);
    expect(repaired.tasks[0].review_run).toEqual(inProgress.review_run);
    expect(parseTaskGraph(repaired).ok).toBe(true);

    const wrongSnapshot = structuredClone(graph(inProgress)) as unknown as Record<string, unknown>;
    const wrongTask = (wrongSnapshot.tasks as Array<Record<string, unknown>>)[0]!;
    (wrongTask.review_run as Record<string, unknown>).prior_finding_ids = ["code-reviewer-1"];
    const rejectedSnapshot = parseTaskGraph(wrongSnapshot);
    expect(rejectedSnapshot.ok).toBe(false);
    if (!rejectedSnapshot.ok) expect(rejectedSnapshot.error).toContain("exactly snapshot");

    let completed = start();
    completed = applyAgent(completed, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"]);
    completed = applyAgent(completed, AGENTS[1], ["resolved_by_remediation", "resolved_by_remediation"]);
    const collision = structuredClone(graph(completed)) as unknown as Record<string, unknown>;
    const collisionTask = (collision.tasks as Array<Record<string, unknown>>)[0]!;
    collisionTask.findings = [(collisionTask.resolved_findings as Array<Record<string, unknown>>)[0]!.finding];
    collisionTask.critical_findings = ["null result is silently accepted"];
    collisionTask.advisory_findings = [];
    const rejectedCollision = parseTaskGraph(collision);
    expect(rejectedCollision.ok).toBe(false);
    if (!rejectedCollision.ok) expect(rejectedCollision.error).toContain("resolved_findings");

    const impossibleGeneration = structuredClone(graph(completed)) as unknown as Record<string, unknown>;
    const impossibleTask = (impossibleGeneration.tasks as Array<Record<string, unknown>>)[0]!;
    const impossibleResolution = (impossibleTask.resolved_findings as Array<Record<string, unknown>>)[0]!;
    const storedFinding = impossibleResolution.finding as Record<string, unknown>;
    const storedResolution = impossibleResolution.resolution as Record<string, unknown>;
    storedFinding.review_generation = storedResolution.generation;
    storedFinding.review_packet_id = "e".repeat(64);
    const rejectedGeneration = parseTaskGraph(impossibleGeneration);
    expect(rejectedGeneration.ok).toBe(false);
    if (!rejectedGeneration.ok) expect(rejectedGeneration.error).toContain("resolved_findings");
  });

  it("repairs malformed remediation audit without deleting its valid nested finding", () => {
    let completed = start();
    completed = applyAgent(completed, AGENTS[0], ["resolved_by_remediation", "resolved_by_remediation"]);
    completed = applyAgent(completed, AGENTS[1], ["resolved_by_remediation", "resolved_by_remediation"]);
    const broken = structuredClone(graph(completed)) as unknown as Record<string, unknown>;
    const brokenTask = (broken.tasks as Array<Record<string, unknown>>)[0]!;
    const firstResolution = (brokenTask.resolved_findings as Array<Record<string, unknown>>)[0]!;
    const resolution = firstResolution.resolution as Record<string, unknown>;
    ((resolution.assessments as Array<Record<string, unknown>>)[0]!).reason = "";

    expect(parseTaskGraph(broken).ok).toBe(false);
    const repaired = fixFull(broken);
    const repairedGraph = JSON.parse(repaired.json);
    expect(repaired.notes).toContain(
      "T1: recovered finding from malformed remediation resolution — \"null result is silently accepted\"",
    );
    expect(repairedGraph.tasks[0].critical_findings).toEqual(["null result is silently accepted"]);
    expect(parseTaskGraph(repairedGraph)).toMatchObject({ ok: true });
    expect(fixFull(repairedGraph).json).toBe(JSON.stringify(repairedGraph, null, 2));
  });
});
