/**
 * Orchestration surface for implementation re-attestation (D4 option 2).
 *
 * The inverse of the D3 remediation problem: a Task whose declared artifacts
 * ALREADY carry the completed work (a `populate-task-graph --force` reset, a
 * reopened Wave, an anchor-only repair) cannot be settled by a normal
 * implementation child, because the child itself must move declared-artifact
 * bytes against the attempt baseline and discharge whichever test obligations
 * its stored Verification Policy requires. Attestation is the sanctioned inverse:
 * the operator declares the work pre-existing, the next dispatch runs a
 * verify-only child, and the proof's declared-artifact obligations flip to the
 * `attested` arm — satisfied when bytes are UNCHANGED vs the attempt baseline.
 * Any scoped write fails `attempt-scope-attested` with `attempt-scope-drifted`;
 * a declared-artifact write additionally yields `declared-artifact-drifted`.
 *
 * Under the TaskGraph lock this rewrites exactly the proof surface: the
 * attested obligation set, the regression-required/new-tests-waived
 * verification policy, and the attestation-mode flag. It never touches the
 * attempt lineage, baselines, or history. The load boundary proves
 * flag/obligation/policy lockstep on every later load, and the dispatch
 * binding (`authorizeImplementationSpawn`) refuses any attestation prompt
 * without the exact engine-derived context line.
 *
 * The stored policy is the ONLY policy surface the program writes: the legacy
 * `new_tests_required` boolean projects a regression requirement too, so a
 * `false` there would contradict this policy's required regression at the
 * load boundary. The field is cleared, not flipped.
 *
 * The operator action is deliberate and fail-closed: a reason is required and
 * echoed to stdout only (never persisted — the mode itself is the audit), a
 * live attempt refuses, an escalated lineage refuses (remediate first), and a
 * repeat refuses "already in attestation mode" without touching state.
 */

import { armImplementationAttestation } from "../../core/implementation-lifecycle";
import type { TaskId } from "../../core/task-id";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { parseTaskReasonArguments } from "./cli-args";
import { renderImplementationLifecycleError } from "./implementation-lifecycle-errors";

const MAX_ATTEST_REASON = 512;

/** Parse the operation's exact argument surface; unknown flags fail closed. */
export function parseAttestArgs(args: readonly string[]):
  | Readonly<{ ok: true; value: { taskId: TaskId; reason: string } }>
  | Readonly<{ ok: false; message: string }> {
  const parsed = parseTaskReasonArguments(args, {
    operation: "attest",
    maximumReasonLength: MAX_ATTEST_REASON,
  });
  return parsed.ok
    ? { ok: true, value: { taskId: parsed.value.taskId, reason: parsed.value.reason } }
    : parsed;
}

export async function attestOperation(args: readonly string[]): Promise<HookResult> {
  const parsed = parseAttestArgs(args);
  if (!parsed.ok) return { kind: "error", message: `attest: ${parsed.message}` };
  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return { kind: "error", message: `attest: No task graph at ${statePath}` };

  const { taskId, reason } = parsed.value;
  let obligations;
  let attestationProofDigest;
  try {
    ({ obligations, attestationProofDigest } = await manager.updateAndReturn((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`no Task ${taskId} in the active task graph`);
      const command = armImplementationAttestation(task, {
        executing: (state.executing_tasks ?? []).includes(taskId),
      });
      if (!command.ok) throw new Error(renderImplementationLifecycleError(command.error));
      return {
        state: {
          ...state,
          tasks: state.tasks.map((candidate) => candidate.id === taskId ? command.value.task : candidate),
        },
        value: {
          obligations: command.value.plan.obligations,
          attestationProofDigest: command.value.plan.attestationProofDigest,
        },
      };
    }));
  } catch (error) {
    return { kind: "error", message: `attest failed without changing state: ${error instanceof Error ? error.message : String(error)}` };
  }

  process.stdout.write(`${JSON.stringify({
    kind: "implementation-attestation-armed",
    taskId,
    obligations,
    attestationProofDigest,
    reason,
  }, null, 2)}\n`);
  process.stdout.write(
    `Task ${taskId} is in attestation mode: the next orchestration status dispatch carries the attestation ` +
    "context line; the child must change NOTHING and run the classified regression. Any scoped write fails " +
    "with attempt-scope-drifted; declared-artifact writes also fail with declared-artifact-drifted.\n",
  );
  return { kind: "allow" };
}
