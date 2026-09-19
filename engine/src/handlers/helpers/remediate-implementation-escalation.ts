/**
 * Orchestration surface consumer for `escalate-wave-implementation` (D3).
 *
 * `orchestration status` mints an escalation recovery when a Task exhausts
 * semantic attempt 2, but nothing consumed it: the operator was told to
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

import { canonicalJson, sha256Hex } from "../../core/review-packet";
import { createEscalationRemediationReceipt } from "../../core/implementation-completion";
import { deriveImplementationRetryDisposition } from "../../core/implementation-retry";
import { parseTaskId, type TaskId } from "../../core/task-id";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import type { HookResult, Task } from "../../types";
import { argumentValue } from "./cli-args";

const MAX_REMEDIATION_REASON = 512;

export type RemediationPlan = Readonly<{
  taskId: string;
  terminalReceiptId: string;
  terminalAuthorityDigest: string;
  failureKinds: readonly [string, ...string[]];
}>;

function duplicateFlagError(flag: string): string {
  return `remediate requires ${flag} exactly once`;
}

/** Parse the operation's exact argument surface; unknown flags fail closed. */
export function parseRemediationArgs(args: readonly string[]):
  | Readonly<{ ok: true; value: { taskId: TaskId; terminalReceiptId: string; reason: string } }>
  | Readonly<{ ok: false; message: string }> {
  const known = new Set(["--task", "--receipt", "--reason"]);
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length > 0) return { ok: false, message: `unknown flag(s): ${unknown.join(" ")}` };
  const taskId = argumentValue(args, "--task");
  const terminalReceiptId = argumentValue(args, "--receipt");
  const reason = argumentValue(args, "--reason");
  if (taskId === null) return { ok: false, message: "remediate requires --task <task-id>" };
  if (terminalReceiptId === null) return { ok: false, message: "remediate requires --receipt <terminal escalation receipt id>" };
  if (reason === null) return { ok: false, message: "remediate requires --reason <text>" };
  if (reason.trim().length === 0 || reason.length > MAX_REMEDIATION_REASON) {
    return { ok: false, message: `remediate --reason must be non-empty and at most ${MAX_REMEDIATION_REASON} characters` };
  }
  if (args.filter((arg) => arg === "--task").length > 1) return { ok: false, message: duplicateFlagError("--task") };
  if (args.filter((arg) => arg === "--receipt").length > 1) return { ok: false, message: duplicateFlagError("--receipt") };
  if (args.filter((arg) => arg === "--reason").length > 1) return { ok: false, message: duplicateFlagError("--reason") };
  const parsedTaskId = parseTaskId(taskId, "remediate --task");
  if (!parsedTaskId.ok) return { ok: false, message: parsedTaskId.error.errors.join("; ") };
  return { ok: true, value: { taskId: parsedTaskId.value, terminalReceiptId, reason } };
}

/** Derive the remediation receipt inputs from the LOCKED task, or name the refusal. */
export function planEscalationRemediation(
  task: Task,
  input: Readonly<{ executing: boolean; terminalReceiptId: string }>,
):
  | Readonly<{ ok: true; value: RemediationPlan }>
  | Readonly<{ ok: false; message: string }> {
  if (task.status === "completed" || task.status === "implemented") {
    return { ok: false, message: `Task ${task.id} already reached ${task.status}; nothing to remediate` };
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return { ok: false, message: `Task ${task.id} carries a live implementation attempt; remediation requires a settled lineage` };
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return { ok: false, message: `Task ${task.id} has invalid attempt lineage: ${disposition.errors.join("; ")}` };
  }
  if (disposition.kind !== "escalated") {
    return {
      ok: false,
      message: `Task ${task.id} is no longer escalated (current disposition: ${disposition.kind}); nothing to remediate`,
    };
  }
  if (disposition.receiptId !== input.terminalReceiptId) {
    return {
      ok: false,
      message: `Task ${task.id}'s terminal escalation is receipt ${disposition.receiptId}, not ${input.terminalReceiptId}; ` +
        "read the exact receipt from orchestration status and repeat",
    };
  }
  const terminal = (task.implementation_attempt_history ?? [])
    .find((receipt) => receipt.receiptId === input.terminalReceiptId);
  if (terminal === undefined) {
    return { ok: false, message: `terminal escalation receipt ${input.terminalReceiptId} is absent from Task ${task.id} history` };
  }
  return {
    ok: true,
    value: {
      taskId: task.id,
      terminalReceiptId: input.terminalReceiptId,
      terminalAuthorityDigest: terminal.authorityDigest,
      failureKinds: disposition.failureKinds,
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
  let observedAt = "";
  let remediationReceiptId = "";
  try {
    await manager.update((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`no Task ${taskId} in the active task graph`);
      const plan = planEscalationRemediation(task, {
        executing: (state.executing_tasks ?? []).includes(taskId),
        terminalReceiptId,
      });
      if (!plan.ok) throw new Error(plan.message);
      observedAt = new Date().toISOString();
      const remediationReservationId =
        `remediation-${sha256Hex(canonicalJson({
          kind: "escalation-remediation",
          taskId,
          terminalReceiptId,
          observedAt,
        }))}`;
      const receipt = createEscalationRemediationReceipt({
        taskId,
        reservationId: remediationReservationId,
        authorityDigest: plan.value.terminalAuthorityDigest,
        observedAt,
        failureKinds: plan.value.failureKinds,
      });
      if (!receipt.ok) throw new Error(receipt.error.errors.join("; "));
      remediationReceiptId = receipt.value.receiptId;
      return {
        ...state,
        tasks: state.tasks.map((candidate) => candidate.id === taskId
          ? {
              ...candidate,
              implementation_attempt_history: [
                ...(candidate.implementation_attempt_history ?? []),
                receipt.value,
              ],
            }
          : candidate),
      };
    });
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
    `Task ${taskId}'s terminal attempt-2 escalation is retired; the next orchestration status offers a fresh ` +
    "attempt-1 dispatch (initial-implementation) with authority minted on the current tree.\n",
  );
  return { kind: "allow" };
}
