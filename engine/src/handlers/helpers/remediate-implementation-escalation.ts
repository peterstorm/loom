/**
 * Orchestration surface consumer for `escalate-wave-implementation` (D3).
 *
 * `orchestration status` mints an escalation recovery when a Task exhausts
 * semantic attempt 2 (or an attestation attempt drifts), but nothing consumed it: the operator was told to
 * "escalate" with no escalation mechanism, and the only exit was
 * `populate-task-graph --force`, which resets the entire task ledger. This
 * operation is the sanctioned exit: under the TaskGraph lock it proves the
 * task's attempt lineage is EXACTLY the terminal escalation named by
 * `--receipt`, appends one `escalation-remediated` receipt, and leaves the
 * lineage's prefix authority (history start and predecessor seed) untouched —
 * the walk past the remediation receipt lands on a fresh attempt 1 for the
 * next dispatch, with authority minted on the current tree. Every prior
 * receipt stays in history as the audit trail — the ledger is never reset.
 *
 * The operator action is deliberate and fail-closed: the terminal receipt must
 * be named exactly, a live attempt refuses, and a repeat of the command after
 * the lineage reset refuses again ("no longer escalated") without touching
 * state — the reset happened once.
 */

import { remediateImplementationEscalation } from "../../core/implementation-lifecycle";
import type { TaskId } from "../../core/task-id";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { parseTaskReasonArguments } from "./cli-args";
import { renderImplementationLifecycleError } from "./implementation-lifecycle-errors";

const MAX_REMEDIATION_REASON = 512;

/** Parse the operation's exact argument surface; unknown flags fail closed. */
function parseRemediationArgs(args: readonly string[]):
  | Readonly<{ ok: true; value: { taskId: TaskId; terminalReceiptId: string; reason: string } }>
  | Readonly<{ ok: false; message: string }> {
  const parsed = parseTaskReasonArguments(args, {
    operation: "remediate",
    maximumReasonLength: MAX_REMEDIATION_REASON,
    additionalRequired: [{
      flag: "--receipt",
      missingMessage: "remediate requires --receipt <terminal escalation receipt id>",
    }],
  });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      taskId: parsed.value.taskId,
      terminalReceiptId: parsed.value.additionalValues["--receipt"],
      reason: parsed.value.reason,
    },
  };
}

export async function remediateOperation(args: readonly string[]): Promise<HookResult> {
  const parsed = parseRemediationArgs(args);
  if (!parsed.ok) return { kind: "error", message: `remediate: ${parsed.message}` };
  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return { kind: "error", message: `remediate: No task graph at ${statePath}` };

  const { taskId, terminalReceiptId, reason } = parsed.value;
  let observedAt;
  let remediationReceiptId;
  try {
    ({ observedAt, remediationReceiptId } = await manager.updateAndReturn((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`no Task ${taskId} in the active task graph`);
      const observedAt = new Date().toISOString();
      const command = remediateImplementationEscalation(task, {
        executing: (state.executing_tasks ?? []).includes(taskId),
        terminalReceiptId,
        observedAt,
      });
      if (!command.ok) throw new Error(renderImplementationLifecycleError(command.error));
      return {
        state: {
          ...state,
          tasks: state.tasks.map((candidate) => candidate.id === taskId ? command.value.task : candidate),
        },
        value: { observedAt, remediationReceiptId: command.value.receipt.receiptId },
      };
    }));
  } catch (error) {
    return { kind: "error", message: `remediate failed without changing state: ${error instanceof Error ? error.message : String(error)}` };
  }

  process.stdout.write(`${JSON.stringify({
    kind: "escalation-remediated",
    taskId,
    terminalReceiptId,
    remediationReceiptId,
    observedAt,
    reason,
  }, null, 2)}\n`);
  process.stdout.write(
    `Task ${taskId}'s terminal implementation escalation is retired; the next orchestration status offers a fresh ` +
    "attempt-1 dispatch (initial-implementation) with authority minted on the current tree.\n",
  );
  return { kind: "allow" };
}
