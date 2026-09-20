/**
 * Orchestration surface for implementation re-attestation (D4 option 2).
 *
 * The inverse of the D3 remediation problem: a Task whose declared artifacts
 * ALREADY carry the completed work (a `populate-task-graph --force` reset, a
 * reopened Wave, an anchor-only repair) cannot be settled by a normal
 * implementation child, because the child itself must move bytes and add new
 * tests against the attempt baseline. Attestation is the sanctioned inverse:
 * the operator declares the work pre-existing, the next dispatch runs a
 * verify-only child, and the proof's declared-artifact obligations flip to the
 * `attested` arm — satisfied when bytes are UNCHANGED vs the attempt baseline,
 * failed with `declared-artifact-drifted` when the child wrote anything.
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

import {
  armImplementationAttestation,
  type AttestationPlan,
} from "../../core/implementation-lifecycle";
export { attestedTask, ATTESTATION_VERIFICATION_POLICY } from "../../core/implementation-lifecycle";
export type { AttestationPlan } from "../../core/implementation-lifecycle";
import { parseTaskId, type TaskId } from "../../core/task-id";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import type { HookResult, Task } from "../../types";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const MAX_ATTEST_REASON = 512;

function duplicateFlagError(flag: string): string {
  return `attest requires ${flag} exactly once`;
}

/** Parse the operation's exact argument surface; unknown flags fail closed. */
export function parseAttestArgs(args: readonly string[]):
  | Readonly<{ ok: true; value: { taskId: TaskId; reason: string } }>
  | Readonly<{ ok: false; message: string }> {
  const unconsumed = unconsumedValueArguments(args, new Set(["--task", "--reason"]));
  if (unconsumed.length > 0) return { ok: false, message: `unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  const taskId = argumentValue(args, "--task");
  const reason = argumentValue(args, "--reason");
  if (taskId === null) return { ok: false, message: "attest requires --task <task-id>" };
  if (reason === null) return { ok: false, message: "attest requires --reason <text>" };
  if (reason.trim().length === 0 || reason.length > MAX_ATTEST_REASON) {
    return { ok: false, message: `attest --reason must be non-empty and at most ${MAX_ATTEST_REASON} characters` };
  }
  if (args.filter((arg) => arg === "--task").length > 1) return { ok: false, message: duplicateFlagError("--task") };
  if (args.filter((arg) => arg === "--reason").length > 1) return { ok: false, message: duplicateFlagError("--reason") };
  const parsedTaskId = parseTaskId(taskId, "attest --task");
  if (!parsedTaskId.ok) return { ok: false, message: parsedTaskId.error.errors.join("; ") };
  return { ok: true, value: { taskId: parsedTaskId.value, reason } };
}

/** Compatibility projection for callers that need only the plan. */
export function planAttestation(
  task: Task,
  input: Readonly<{ executing: boolean }>,
): Readonly<{ ok: true; value: AttestationPlan }> | Readonly<{ ok: false; message: string }> {
  const command = armImplementationAttestation(task, input);
  return command.ok ? { ok: true, value: command.value.plan } : command;
}

export async function attestOperation(args: readonly string[]): Promise<HookResult> {
  const parsed = parseAttestArgs(args);
  if (!parsed.ok) return { kind: "error", message: `attest: ${parsed.message}` };
  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return { kind: "error", message: `attest: No task graph at ${statePath}` };

  const { taskId, reason } = parsed.value;
  let obligations: readonly string[] = [];
  let attestationProofDigest = "";
  try {
    await manager.update((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`no Task ${taskId} in the active task graph`);
      const command = armImplementationAttestation(task, {
        executing: (state.executing_tasks ?? []).includes(taskId),
      });
      if (!command.ok) throw new Error(command.message);
      obligations = command.value.plan.obligations;
      attestationProofDigest = command.value.plan.attestationProofDigest;
      return {
        ...state,
        tasks: state.tasks.map((candidate) => candidate.id === taskId ? command.value.task : candidate),
      };
    });
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
    "context line; the child must change NOTHING and run the classified regression. Any write inside the " +
    "attempt scope settles as declared-artifact-drifted, never as attested.\n",
  );
  return { kind: "allow" };
}
