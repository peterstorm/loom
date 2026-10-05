/**
 * Canonical status facts — the pure per-category derivations that both the
 * proof-carrying readiness snapshot (`wave-gate-machine`) and the status
 * projection (`loom-status`) report. Defined once so a fact cannot read one
 * way in readiness and another in status.
 */

import type {
  FailedProofObligation,
  FindingCounts,
  RefutationPanelNeed,
  ReviewEvidenceFailure,
  ReviewRosterGap,
  StatusReason,
  StatusTaskCounts,
  Task,
  TaskGraph,
  TestReadiness,
  WaveGateCompletionEligibility,
} from "../types";
import { newTestsSatisfied, testEvidenceSatisfied, type GateDecision } from "./wave-gate-checks";
import { canonicalRecord, type NonEmpty } from "./orchestration-contract";

export const statusReason = (kind: StatusReason["kind"], message: string, taskId: string | null = null): StatusReason =>
  canonicalRecord({ kind, message, taskId });

export const nonEmptyReasons = (values: readonly StatusReason[], fallback: StatusReason): NonEmpty<StatusReason> => {
  const all = values.length === 0 ? [fallback] : values;
  return Object.freeze(all) as NonEmpty<StatusReason>;
};

/** First matching bucket wins; the order below IS the precedence. */
function taskBucket(task: Task, executing: ReadonlySet<string>): keyof StatusTaskCounts {
  if (task.status === "completed") return "completed";
  if (
    task.status === "failed" || task.proof?.state === "failed" ||
    task.review_status === "blocked" || task.review_status === "evidence_capture_failed"
  ) return "blocked";
  if (executing.has(task.id)) return "running";
  if (task.status === "implemented") return "implemented";
  return "pending";
}

export function taskCounts(graph: TaskGraph): StatusTaskCounts {
  const executing = new Set(graph.executing_tasks ?? []);
  const counts = { pending: 0, running: 0, implemented: 0, blocked: 0, completed: 0 };
  for (const task of graph.tasks) counts[taskBucket(task, executing)]++;
  return canonicalRecord(counts);
}

export function failedProofs(graph: TaskGraph): readonly FailedProofObligation[] {
  return Object.freeze(graph.tasks.flatMap((task) => task.proof?.state === "failed"
    ? task.proof.failures.map((failure) => canonicalRecord({ taskId: task.id, failure }))
    : []));
}

export function deriveTestReadinessForTasks(tasks: readonly Task[]): TestReadiness {
  const affected = tasks.flatMap((task) => {
    const reasons: string[] = [];
    if (!testEvidenceSatisfied(task)) reasons.push("passing test evidence is missing");
    if (!newTestsSatisfied(task)) reasons.push("required new tests were not observed");
    return reasons.length === 0 ? [] : [canonicalRecord({ taskId: task.id, reasons: Object.freeze(reasons) as NonEmpty<string> })];
  });
  return affected.length === 0
    ? canonicalRecord({ kind: "ready", affectedTasks: Object.freeze([]) })
    : canonicalRecord({ kind: "not-ready", affectedTasks: Object.freeze(affected) as NonEmpty<(typeof affected)[number]> });
}

export const deriveTestReadiness = (graph: TaskGraph, wave: number): TestReadiness =>
  deriveTestReadinessForTasks(graph.tasks.filter((task) => task.wave === wave));

export function reviewFacts(graph: TaskGraph): Readonly<{
  rosterGaps: readonly ReviewRosterGap[];
  evidenceFailures: readonly ReviewEvidenceFailure[];
}> {
  const rosterGaps: ReviewRosterGap[] = [];
  const evidenceFailures: ReviewEvidenceFailure[] = [];
  for (const task of graph.tasks) {
    if (task.review_run !== undefined) {
      const supplied = new Set(task.review_run.evidence.map((entry) => entry.agent));
      for (const agent of task.review_run.expected_agents) {
        if (!supplied.has(agent)) rosterGaps.push(canonicalRecord({
          taskId: task.id,
          generation: task.review_run.generation,
          packetId: task.review_run.packet_id,
          agent,
        }));
      }
    }
    for (const agent of task.review_evidence_failures ?? []) {
      evidenceFailures.push(canonicalRecord({
        taskId: task.id,
        generation: task.review_run?.generation ?? task.review_generation ?? null,
        packetId: task.review_run?.packet_id ?? null,
        agent,
        error: task.review_error ?? "review evidence capture failed",
      }));
    }
  }
  return canonicalRecord({ rosterGaps: Object.freeze(rosterGaps), evidenceFailures: Object.freeze(evidenceFailures) });
}

export function deriveFindingCounts(tasks: readonly Task[]): FindingCounts {
  let activeCritical = 0;
  let advisory = 0;
  let resolved = 0;
  let refuted = 0;
  for (const task of tasks) {
    if (task.findings !== undefined) {
      activeCritical += task.findings.filter((finding) => finding.severity === "critical").length;
      advisory += task.findings.filter((finding) => finding.severity === "advisory").length;
    } else {
      activeCritical += task.critical_findings?.filter((finding) => finding.trim() !== "").length ?? 0;
      advisory += task.advisory_findings?.filter((finding) => finding.trim() !== "").length ?? 0;
    }
    resolved += task.resolved_findings?.length ?? 0;
    refuted += task.refuted_findings?.length ?? 0;
  }
  return canonicalRecord({ activeCritical, advisory, resolved, refuted });
}

function activeCriticalFindingIds(graph: TaskGraph, wave: number): readonly string[] {
  return Object.freeze(graph.tasks.filter((task) => task.wave === wave).flatMap((task) => {
    if (task.findings !== undefined) {
      return task.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => `${task.id}:${finding.id}`);
    }
    return (task.critical_findings ?? []).flatMap((finding, index) =>
      finding.trim() === "" ? [] : [`${task.id}:legacy-critical:${index + 1}`]);
  }));
}

export function panelNeed(graph: TaskGraph, wave: number): RefutationPanelNeed {
  const findingIds = activeCriticalFindingIds(graph, wave);
  return findingIds.length === 0
    ? canonicalRecord({ kind: "not-needed", findingIds: Object.freeze([]), reasons: Object.freeze(["the active Wave has no critical Findings"]) as NonEmpty<string> })
    : canonicalRecord({ kind: "needed", findingIds: Object.freeze(findingIds) as NonEmpty<string>, reasons: Object.freeze([`${findingIds.length} active critical Finding(s) require refutation`]) as NonEmpty<string> });
}

export function completionEligibility(decision: GateDecision): WaveGateCompletionEligibility {
  const failed = decision.checks.flatMap((check) => check.passed ? [] : [check.reason]);
  if (decision.verdict.kind === "fail" && decision.checks.length === 0) failed.push(decision.verdict.reason);
  return failed.length === 0
    ? canonicalRecord({ kind: "eligible", failedPrerequisites: Object.freeze([]) })
    : canonicalRecord({ kind: "ineligible", failedPrerequisites: Object.freeze(failed) as NonEmpty<string> });
}

export function readinessReasons(
  graph: TaskGraph,
  wave: number,
  decision: GateDecision,
  reviews: ReturnType<typeof reviewFacts>,
  panel: RefutationPanelNeed,
  tests: TestReadiness,
  eligibility: WaveGateCompletionEligibility,
): NonEmpty<StatusReason> {
  const reasons: StatusReason[] = [];
  const waveTasks = graph.tasks.filter((task) => task.wave === wave);
  const waveTaskIds = new Set(waveTasks.map((task) => task.id));
  for (const task of waveTasks) {
    if ((graph.executing_tasks ?? []).includes(task.id)) reasons.push(statusReason("task-running", `${task.id} is still executing`, task.id));
    if (task.proof?.state === "failed") reasons.push(statusReason("proof-failed", `${task.id} has ${task.proof.failures.length} failed proof obligation(s)`, task.id));
  }
  if (tests.kind === "not-ready") {
    for (const affected of tests.affectedTasks) reasons.push(statusReason("tests-not-ready", `${affected.taskId}: ${affected.reasons.join("; ")}`, affected.taskId));
  }
  for (const gap of reviews.rosterGaps.filter((entry) => waveTaskIds.has(entry.taskId))) {
    reasons.push(statusReason("review-roster-gap", `${gap.taskId} is missing review evidence from ${gap.agent}`, gap.taskId));
  }
  for (const failure of reviews.evidenceFailures.filter((entry) => waveTaskIds.has(entry.taskId))) {
    reasons.push(statusReason("review-evidence-failure", `${failure.taskId}/${failure.agent}: ${failure.error}`, failure.taskId));
  }
  if (panel.kind === "needed") reasons.push(statusReason("refutation-required", panel.reasons.join("; ")));
  if (eligibility.kind === "ineligible") {
    for (const failed of eligibility.failedPrerequisites) reasons.push(statusReason("completion-prerequisite-failed", failed));
  } else {
    reasons.push(statusReason("completion-eligible", `Wave ${wave} satisfies every completion prerequisite`));
  }
  return nonEmptyReasons(reasons, statusReason("wave-gate-ready", decision.verdict.kind === "pass" ? `Wave ${wave} is ready` : decision.verdict.reason));
}
