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

import { derivePendingTaskProof, type PendingTaskProof } from "../../core/proof-obligations";
import {
  deriveImplementationAttestationContext,
  deriveImplementationRetryDisposition,
} from "../../core/implementation-retry";
import {
  serializeVerificationPolicy,
  type VerificationPolicy,
} from "../../core/verification-policy";
import { parseTaskId, type TaskId } from "../../core/task-id";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import type { HookResult, Task } from "../../types";
import { argumentValue } from "./cli-args";

const MAX_ATTEST_REASON = 512;

/** The policy attestation authors: the classified regression still runs; new
 * tests are waived because the work predates the attempt. The waiver reason is
 * the authored `existing-tests-sufficient`, not the migration spelling. */
export const ATTESTATION_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" }),
  newTests: Object.freeze({ kind: "waived", reason: "existing-tests-sufficient" }),
});

export type AttestationPlan = Readonly<{
  taskId: string;
  obligations: readonly string[];
  attestationProofDigest: string;
  promptAppendix: string;
}>;

function duplicateFlagError(flag: string): string {
  return `attest requires ${flag} exactly once`;
}

/** Parse the operation's exact argument surface; unknown flags fail closed. */
export function parseAttestArgs(args: readonly string[]):
  | Readonly<{ ok: true; value: { taskId: TaskId; reason: string } }>
  | Readonly<{ ok: false; message: string }> {
  const known = new Set(["--task", "--reason"]);
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length > 0) return { ok: false, message: `unknown flag(s): ${unknown.join(" ")}` };
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

/** The attested proof: same derivation for the rewritten Task and the plan,
 * so the obligation report can never diverge from what gets persisted. */
const attestedProofFor = (task: Task): PendingTaskProof =>
  derivePendingTaskProof({
    verificationPolicy: ATTESTATION_VERIFICATION_POLICY,
    declaredArtifacts: task.file_list ?? [],
    declaredArtifactExpectation: "attested",
  });

/** The exact rewritten Task the attest program persists. */
export function attestedTask(task: Task): Task {
  return {
    ...task,
    status: "pending",
    implementation_attestation: true,
    verification_policy: serializeVerificationPolicy(ATTESTATION_VERIFICATION_POLICY),
    new_tests_required: undefined,
    proof: attestedProofFor(task),
    revalidation_required: undefined,
    legacy_missing_proof: undefined,
  };
}

/** Prove the Task is attestation-eligible and derive the exact rewritten proof. */
export function planAttestation(
  task: Task,
  input: Readonly<{ executing: boolean }>,
):
  | Readonly<{ ok: true; value: AttestationPlan }>
  | Readonly<{ ok: false; message: string }> {
  if (task.status !== "pending") {
    return { ok: false, message: `Task ${task.id} has status ${task.status}; attestation applies only to pending Tasks with unsatisfied proof` };
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return { ok: false, message: `Task ${task.id} carries a live implementation attempt; finish or settle it before attesting` };
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return { ok: false, message: `Task ${task.id} has invalid attempt lineage: ${disposition.errors.join("; ")}` };
  }
  if (disposition.kind === "escalated") {
    return { ok: false, message: `Task ${task.id} exhausted semantic attempt 2; remediate the escalation before attesting` };
  }
  if (task.implementation_attestation === true) {
    return { ok: false, message: `Task ${task.id} is already in attestation mode; nothing to attest` };
  }
  if (task.proof?.state === "satisfied") {
    return { ok: false, message: `Task ${task.id} already carries satisfied proof; nothing to attest` };
  }
  const rewritten = attestedTask(task);
  const context = deriveImplementationAttestationContext(rewritten);
  if (!context.ok) return { ok: false, message: `attestation context derivation failed for ${task.id}: ${context.error}` };
  const proof = attestedProofFor(task);
  return {
    ok: true,
    value: {
      taskId: task.id,
      obligations: proof.obligations.map((obligation) =>
        "artifact" in obligation ? `${obligation.kind}:${obligation.artifact}` : obligation.kind),
      attestationProofDigest: context.context.attestationProofDigest,
      promptAppendix: context.promptAppendix,
    },
  };
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
      const derived = planAttestation(task, {
        executing: (state.executing_tasks ?? []).includes(taskId),
      });
      if (!derived.ok) throw new Error(derived.message);
      obligations = derived.value.obligations;
      attestationProofDigest = derived.value.attestationProofDigest;
      return {
        ...state,
        tasks: state.tasks.map((candidate) => candidate.id === taskId ? attestedTask(candidate) : candidate),
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
