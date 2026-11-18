/**
 * The Task owner check's execution shell (ADR-0092). It runs what
 * `helper owner-check` asks for and decides nothing: the duty is the pure
 * core's (`core/task-owner-check.ts`), and each obligation's run is the Wave
 * Gate's own (`verifyObligations` in `owner-verification-runner.ts`):
 * coverage over the paths the duty says are due at this stop, then the gate's
 * mutation plan over the owner's Wave base, in one isolated worktree, through
 * the frozen `affectedRunner` over the matrix test.
 *
 * What differs from the gate is only the deadline: a matrix-test run launches
 * only while the time left before `TASK_OWNER_CHECK_DEADLINE_MS` holds its
 * whole time limit. A run it cannot hold is not launched, and reads as the
 * gate's own `spawn-failed` outcome naming the deadline, so its obligation's
 * mutation half is an infrastructure verdict while its coverage is still
 * judged. The real workspace is only ever read.
 *
 * `runTaskOwnerCheck` never throws: whatever a step throws is the
 * `unavailable` result naming it.
 */

import { mapNonEmpty } from "../core/orchestration-contract/identity";
import { obligationRunOf } from "../core/owner-verification/owed-verification";
import type { MatrixTestRun } from "../core/owner-verification/types";
import {
  TASK_OWNER_CHECK_DEADLINE_MS,
  taskOwnerCheckResult,
  taskOwnerCheckUnavailable,
  type OwedTaskOwnerCheck,
  type TaskOwnerCheckResult,
} from "../core/task-owner-check";
import type { TaskGraph } from "../types";
import { describeCause } from "../utils/describe-cause";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { runOnce } from "./mutation-run-steps";
import { verifyObligations, type ExecuteMatrixTest, type ScopedRun } from "./owner-verification-runner";

export type TaskOwnerCheckRunInput = Readonly<{
  /** The real workspace. It is only ever read. */
  root: CanonicalRepositoryRoot;
  /** The Tasks whose listings choose each owner's Wave base. */
  graph: Pick<TaskGraph, "tasks" | "acceptance_contracts">;
  duty: OwedTaskOwnerCheck;
  now: () => number;
}>;

/** Why no further run may launch before `deadlineMs`, or null while the time left holds one of `timeoutMs`. */
export function deadlineRefusal(deadlineMs: number, now: number, timeoutMs: number): string | null {
  const left = deadlineMs - now;
  return left >= timeoutMs
    ? null
    : `not launched: the Task owner check's ${TASK_OWNER_CHECK_DEADLINE_MS / 1000} s deadline cannot hold another run ` +
      `(${Math.max(left, 0)} ms left, one run may take ${timeoutMs} ms)`;
}

/** `execute` behind the deadline: a run the time left cannot hold is never launched. */
export function withinDeadline(execute: ExecuteMatrixTest, deadlineMs: number, now: () => number): ExecuteMatrixTest {
  return async (workspace, command, owner): Promise<MatrixTestRun> => {
    const refused = deadlineRefusal(deadlineMs, now(), command.timeoutMs);
    return refused === null ? execute(workspace, command, owner) : { kind: "spawn-failed", message: refused };
  };
}

/** Each owed obligation's run with the paths its duty says are due: mutation through the duty's runner unless exempt. */
const dutyRuns = (duty: OwedTaskOwnerCheck) =>
  mapNonEmpty(duty.obligations, ({ obligation, due }): ScopedRun => ({
    run: obligationRunOf(obligation, duty.mutation === "owed" ? duty.runner : undefined),
    due,
  }));

/**
 * Run the Task owner check for a Task that owes it. Never throws: whatever a
 * step throws is the `unavailable` result naming it. `execute` is the gate's
 * `runOnce` in production.
 */
export async function runTaskOwnerCheck(input: TaskOwnerCheckRunInput, execute: ExecuteMatrixTest = runOnce): Promise<TaskOwnerCheckResult> {
  try {
    const { duty } = input;
    const deadlineMs = input.now() + TASK_OWNER_CHECK_DEADLINE_MS;
    const scope = { root: input.root, graph: input.graph, wave: duty.wave, execute: withinDeadline(execute, deadlineMs, input.now) };
    const ran = await verifyObligations(scope, dutyRuns(duty));
    return taskOwnerCheckResult(ran.verdicts);
  } catch (cause) {
    return taskOwnerCheckUnavailable(`the check failed while it ran: ${describeCause(cause)}`);
  }
}
