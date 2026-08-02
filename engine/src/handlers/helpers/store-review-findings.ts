/**
 * Store review findings for a task.
 * Usage: bun cli.ts helper store-review-findings --task T1
 * Reads CRITICAL:/ADVISORY: lines from stdin.
 */

import type { HookHandler, ReviewStatus, Task } from "../../types";
import { newWaveGate } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import {
  attributeFindings,
  claimsOfSeverity,
  draftsFromClaims,
  nextOrdinal,
  recoverViewOnlyClaims,
  type Finding,
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
  advisory: string[]
): Task {
  const reviewStatus: ReviewStatus = critical.length > 0 ? "blocked" : "passed";

  // A pre-identity task's claims live only in the views; give them identity
  // through the same primitive `mergeFindings` and `--fix` use, so all four
  // writers agree on what a legacy task's findings ARE before any of them
  // decides what to keep.
  const existing: readonly Finding[] = [
    ...(task.findings ?? []),
    ...recoverViewOnlyClaims(
      task.findings ?? [],
      task.refuted_findings ?? [],
      task.critical_findings,
      task.advisory_findings,
    ),
  ];

  // Advisories the override did not speak to survive with their identity intact.
  const keptAdvisory: readonly Finding[] =
    advisory.length > 0 ? [] : existing.filter((finding) => finding.severity === "advisory");

  const supplied = attributeFindings(
    draftsFromClaims(critical, advisory),
    OVERRIDE_AGENT,
    nextOrdinal(keptAdvisory, task.refuted_findings ?? [], OVERRIDE_AGENT),
  );
  const findings = [...keptAdvisory, ...supplied];

  return {
    ...task,
    review_status: reviewStatus,
    findings,
    critical_findings: [...claimsOfSeverity(findings, "critical")],
    advisory_findings: [...claimsOfSeverity(findings, "advisory")],
  };
}

const handler: HookHandler = async (stdin, args) => {
  const taskIdx = args.indexOf("--task");
  const taskId = taskIdx >= 0 ? args[taskIdx + 1] : null;
  if (!taskId) return { kind: "error", message: "--task required" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const { critical, advisory } = parseFindings(stdin);

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
  const blocking = critical.length > 0;
  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === taskId ? updateTaskFindings(t, critical, advisory) : t)),
    wave_gates: blocking
      ? {
          ...s.wave_gates,
          [String(target.wave)]: {
            ...(s.wave_gates[String(target.wave)] ?? newWaveGate()),
            blocked: true,
          },
        }
      : s.wave_gates,
  }));

  process.stderr.write(`Stored findings for ${taskId}: ${critical.length} critical, ${advisory.length} advisory\n`);

  return { kind: "passthrough" };
};

export default handler;
