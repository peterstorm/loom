/**
 * Store review findings for a task.
 * Usage: bun cli.ts helper store-review-findings --task T1
 * Reads CRITICAL:/ADVISORY: lines from stdin.
 */

import type { HookHandler, ReviewStatus, Task } from "../../types";
import { reconcileWaveBlock } from "../../core/wave-gate-model";
import { TASK_GRAPH_PATH } from "../../config";
import {
  attributeFindings,
  claimsOfSeverity,
  draftsFromClaims,
  nextOrdinal,
  recoverViewOnlyClaims,
  type Finding,
  type RefutedFinding,
} from "../../core/findings";
import { StateManager } from "../../state-manager";
import { isNoFindingSentinel } from "../../utils/no-finding-sentinel";

/** Pure: Parse CRITICAL/ADVISORY lines from stdin */
export function parseFindings(stdin: string): { critical: string[]; advisory: string[] } {
  const critical: string[] = [];
  const advisory: string[] = [];

  for (const line of stdin.split("\n")) {
    const critMatch = line.match(/^CRITICAL:\s*(.*)/);
    if (critMatch) {
      const text = critMatch[1].trim();
      if (text !== '' && !isNoFindingSentinel(text)) critical.push(text);
      continue;
    }
    const advMatch = line.match(/^ADVISORY:\s*(.*)/);
    if (advMatch) {
      const text = advMatch[1].trim();
      if (text !== '' && !isNoFindingSentinel(text)) advisory.push(text);
    }
  }

  return { critical, advisory };
}

/**
 * The agent name a manual override attributes its findings to.
 *
 * An override is an operator decision, not a review. Attributing it honestly
 * keeps `findings` readable — a refutation panel that later kills one of these
 * records who made the claim, and it cannot be mistaken for `code-reviewer`'s.
 */
export const OVERRIDE_AGENT = "manual-override";

/** Why a replaced finding left the active set. Stored in the audit trail so a
 *  dismissal reads as a decision someone made, not as a finding that vanished. */
export const OVERRIDE_DISMISSAL_REASON =
  "replaced by a manual operator override (helper store-review-findings)";

/**
 * Pure: replace a task's review findings, preserving existing advisories when
 * none are provided.
 *
 * This is the sanctioned false-positive downgrade (`commands/loom.md`), and it
 * REPLACES rather than merges — that is the whole point of an override. It must
 * therefore rewrite the authoritative `findings` array too, not just the
 * `critical_findings` view: leaving `findings` alone would put the dismissed
 * critical back in front of the refutation panel while an added one stayed
 * invisible to it, and the wave gate's skip predicate (which reads the view)
 * would disagree with the brief (which reads the array).
 */
export function updateTaskFindings(
  task: Task,
  critical: string[],
  advisory: string[],
  preserveUnmentionedAdvisories = true,
): Task {
  const reviewStatus: ReviewStatus = critical.length > 0 ? "blocked" : "passed";

  // A pre-identity task's claims live only in the views; give them identity
  // through `recoverViewOnlyClaims` — the same primitive `mergeFindings`,
  // `reviewRunPriorFindings` (reached from `review-packet`) and `--fix`
  // (`validate-task-graph`) reach for — so all six lockstep writers
  // (enumerated on `Task.findings` in types.ts) agree on what a legacy task's
  // findings ARE before any of them decides what to keep. Named rather than
  // counted: an ordinal in this comment is a fact about OTHER files, and it
  // was already wrong (it said "third", omitting `reviewRunPriorFindings`).
  const existing: readonly Finding[] = [
    ...(task.findings ?? []),
    ...recoverViewOnlyClaims(
      task.findings ?? [],
      task.refuted_findings ?? [],
      { critical: task.critical_findings, advisory: task.advisory_findings },
      task.resolved_findings ?? [],
    ),
  ];

  // Advisories the override did not speak to survive with their identity intact.
  const keptAdvisory: readonly Finding[] =
    advisory.length > 0 || !preserveUnmentionedAdvisories
      ? []
      : existing.filter((finding) => finding.severity === "advisory");

  // What the override REPLACES is recorded, not deleted — the same rule
  // `applyFindingOutcomes` follows when the panel kills a finding, for the same
  // reason: "a wrong dismissal is a shipped bug, and a silently dropped critical
  // is indistinguishable from one that was never found." An override IS a
  // refutation; the refuter happens to be a person rather than a lens, which is
  // why `Refutation.lens` is an open string.
  //
  // It also closes the id-rewind hole for good. Seeding `nextOrdinal` from
  // `existing` fixes the two-override case, but an override that empties the
  // findings array left NO record of the ordinals it had issued, so the next one
  // restarted at 1 and re-minted `manual-override-1` for a different claim —
  // which an in-flight refutation brief still named, defeating
  // `applyFindingOutcomes`' absence guard exactly as before. `nextOrdinal`
  // counts `refuted_findings`, so a conserved dismissal is a high-water mark
  // that removal cannot rewind.
  const kept = new Set(keptAdvisory.map((finding) => finding.id));
  const dismissed: readonly RefutedFinding[] = existing
    .filter((finding) => !kept.has(finding.id))
    .map((finding) => ({
      finding,
      refutations: [{ lens: OVERRIDE_AGENT, reason: OVERRIDE_DISMISSAL_REASON }],
    }));
  const refuted = [...(task.refuted_findings ?? []), ...dismissed];

  const supplied = attributeFindings(
    draftsFromClaims(critical, advisory),
    OVERRIDE_AGENT,
    nextOrdinal(existing, refuted, OVERRIDE_AGENT, task.resolved_findings ?? []),
  );
  const findings = [...keptAdvisory, ...supplied];

  return {
    ...task,
    review_status: reviewStatus,
    review_run: undefined,
    // An override replaces the review record outright, and `review_error` plus
    // the outstanding evidence failures are part of that record — both are
    // meaningful only for evidence_capture_failed, which this write leaves.
    review_error: undefined,
    review_evidence_failures: undefined,
    findings,
    critical_findings: [...claimsOfSeverity(findings, "critical")],
    advisory_findings: [...claimsOfSeverity(findings, "advisory")],
    refuted_findings: refuted,
  };
}

const handler: HookHandler = async (stdin, args) => {
  const taskIdx = args.indexOf("--task");
  const taskId = taskIdx >= 0 ? args[taskIdx + 1] : null;
  if (!taskId) return { kind: "error", message: "--task required" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const { critical, advisory } = parseFindings(stdin);

  // Empty input is refused, not obeyed. `updateTaskFindings` writes the state
  // it is given, so parsing nothing out of stdin moved EVERY existing finding
  // into `refuted_findings` under `manual-override`, emptied `critical_findings`
  // and set `review_status: "passed"` — an unblocked wave gate — while logging
  // "0 critical, 0 advisory", which is exactly what a legitimate all-clear
  // override logs. An operator pipeline whose upstream command produced nothing
  // (a failed grep, a truncated file, a typo'd path) therefore unblocked the
  // gate silently. Dismissing findings is a real operation, but it is one the
  // operator has to say out loud.
  if (critical.length === 0 && advisory.length === 0 && !args.includes("--dismiss-all")) {
    return {
      kind: "error",
      message:
        `No findings parsed from stdin for '${taskId}'. Storing nothing would dismiss every ` +
        `finding this task holds and pass its review — if that is the intent, pass ` +
        `--dismiss-all; otherwise check the input that produced this.`,
    };
  }

  // Prove the target exists before writing. `tasks.map` over a non-matching id
  // is a total no-op, so an unknown --task used to print "Stored findings for
  // X" and exit 0 with nothing written. The downgrade direction self-corrects
  // (the gate keeps blocking and the operator retries); the ADD direction is
  // terminal — a critical the operator deliberately injected never reaches
  // complete-wave-gate, and nothing anywhere says so.
  const known = mgr.load().tasks;
  const target = known.find((t) => t.id === taskId);
  if (!target) {
    return {
      kind: "error",
      message:
        `No task '${taskId}' in ${TASK_GRAPH_PATH} — known ids: ` +
        `${known.map((t) => t.id).join(", ") || "(none)"}`,
    };
  }

  // One locked transform, not two. Splitting the findings write from the gate
  // write released the lock between them, leaving a window where a concurrent
  // writer sees a stored critical on an unblocked wave.
  const dismissAll = args.includes("--dismiss-all");
  await mgr.update((s) => {
    const tasks = s.tasks.map((t) => (
      t.id === taskId ? updateTaskFindings(t, critical, advisory, !dismissAll) : t
    ));
    // `blocked` tracks its causes in BOTH directions, computed from the state
    // this transform is about to write.
    //
    // Only the set direction existed: an override that downgraded the last
    // critical to advisory (or `--dismiss-all`) emptied `critical_findings` and
    // passed the task's review, but left `blocked: true` behind. The wave then
    // sat blocked with NO cause — `validate-task-execution` printed
    // "Wave N is BLOCKED due to:" with nothing under it, and no rerun of
    // `/wave-gate` could clear a block whose cause it could not find. The
    // operator's override landed on the task and died at the gate.
    //
    // The other cause (a wave-scoped critical spec-check) is deliberately still
    // honored here: clearing a review block must not silently drop a spec-check
    // block that this command never adjudicated.
    return {
      ...s,
      tasks,
      wave_gates: reconcileWaveBlock(s.wave_gates, tasks, s.spec_check, target.wave),
    };
  });

  // A dismissal and a two-finding override used to print the same shape of
  // line, differing only in a zero. Named, because this one passed a review.
  process.stderr.write(
    critical.length === 0 && advisory.length === 0
      ? `DISMISSED every finding on ${taskId} (--dismiss-all): review_status is now passed\n`
      : `Stored findings for ${taskId}: ${critical.length} critical, ${advisory.length} advisory\n`,
  );

  return { kind: "passthrough" };
};

export default handler;
