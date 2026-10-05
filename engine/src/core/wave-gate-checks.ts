/**
 * Wave Gate evaluation — the functional core that decides whether one Wave's
 * protected state satisfies every completion prerequisite.
 *
 * One entry point decides (`evaluateWaveGate`), one applies its pass verdict
 * (`applyGateDecision`), and `deriveWaveStartReadiness` answers the start
 * subset of the same checks. The individual checks are exported because the
 * handler tests pin their exact operator-facing messages; the test-readiness
 * predicates are exported because the status projection must answer "is this
 * Task test-ready?" through the very same functions. No proof-carrying
 * authority lives here: readiness snapshots and lifecycle state belong to
 * `wave-gate-machine`.
 */

import { match } from "ts-pattern";
import { reviewedWorkspaceDrift, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import type {
  PlanModels,
  Task,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveWorkspaceObservation,
} from "../types";
import { newWaveGate, reconcileWaveBlock, testResultPassed } from "./wave-gate-model";
import {
  requiresNewTests,
  requiresRegression,
  taskVerificationPolicy,
} from "./verification-policy";
import type { ProofFailure } from "./proof-obligations";
import { renderProjectVerificationCoverage } from "./verification-manifest";
import { deriveWaveCompletionSuiteReadiness } from "./wave-completion-suite-readiness";
import { canonicalRecord, type NonEmpty } from "./orchestration-contract";

export type GateCheck =
  | Readonly<{ passed: true; summary: string }>
  | Readonly<{ passed: false; reason: string }>;

const pass = (summary: string): GateCheck => canonicalRecord({ passed: true, summary });
const fail = (reason: string): GateCheck => canonicalRecord({ passed: false, reason });

export function gateCheckMessage(check: GateCheck): string {
  return check.passed ? check.summary : check.reason;
}

function proofFailureMessage(failure: ProofFailure): string {
  switch (failure.kind) {
    case "declared-artifact-not-changed":
    case "declared-artifact-drifted": return `${failure.kind}:${failure.artifact}`;
    case "untrusted-regression-tests-failed":
    case "untrusted-regression-pass": return `${failure.kind}:${failure.label}`;
    default: return failure.kind;
  }
}

function unreadyTaskMessage(task: Task): string {
  const failures = task.proof?.state === "failed"
    ? `, failures=[${task.proof.failures.map(proofFailureMessage).join(", ")}]`
    : "";
  const revalidation = task.revalidation_required === true ? ", revalidation=fresh-test-evidence-required" : "";
  return `${task.id} (status=${task.status}, proof=${task.proof?.state ?? "missing"}${revalidation}${failures})`;
}

export function checkNoExecutingTasks(tasks: readonly Task[], executingTaskIds: readonly string[]): GateCheck {
  const waveTaskIds = new Set(tasks.map((task) => task.id));
  const active = [...new Set(executingTaskIds.filter((id) => waveTaskIds.has(id)))];
  return active.length === 0
    ? pass("No wave tasks are still executing")
    : fail(`FAILED: wave tasks still executing: ${active.join(", ")} — wait for every implementation agent to stop before completing the wave`);
}

export function checkImplementationProof(tasks: readonly Task[]): GateCheck {
  const unready = tasks.filter((task) =>
    task.revalidation_required === true ||
    (task.status !== "implemented" && task.status !== "completed") || task.proof?.state !== "satisfied"
  );
  return unready.length === 0
    ? pass(`1. Implementation proof verified (${tasks.length}/${tasks.length} tasks).`)
    : fail("FAILED: Not all tasks have satisfied implementation proof.\n" +
      `  Unready: ${unready.map(unreadyTaskMessage).join(", ")}`);
}

/**
 * The shared test-readiness predicates, defined ONCE.
 *
 * The gate (`checkTestEvidence`/`checkNewTests`) and the status projection
 * (`deriveTestReadinessForTasks`) must answer "is this task test-ready?"
 * identically — a gate that blocks while status reports ready, or the reverse,
 * is a contradiction the operator has no way to resolve. They read the same
 * fields, so they read them through the same functions.
 */
const regressionExempt = (task: Task): boolean =>
  !requiresRegression(taskVerificationPolicy(task));
const newTestsExempt = (task: Task): boolean =>
  !requiresNewTests(taskVerificationPolicy(task));
export const testEvidenceSatisfied = (task: Task): boolean =>
  regressionExempt(task) || testResultPassed(task.test_result);
export const newTestsSatisfied = (task: Task): boolean =>
  newTestsExempt(task) || task.new_test_observation?.kind === "written";
const regressionEvidenceLine = (task: Task): string => {
  const requirement = taskVerificationPolicy(task).regression;
  return requirement.kind === "waived"
    ? `not required (verification_policy.regression waived: ${requirement.reason})`
    : (task.test_evidence ?? "evidence present");
};
const newTestEvidenceLine = (task: Task): string => {
  const requirement = taskVerificationPolicy(task).newTests;
  return requirement.kind === "waived"
    ? `not required (verification_policy.new_tests waived: ${requirement.reason})`
    : (task.new_test_observation?.evidence ?? "new tests present");
};

function checkTaskRequirement(
  tasks: readonly Task[],
  satisfied: (task: Task) => boolean,
  failure: string,
  success: string,
  evidenceLine: (task: Task) => string,
): GateCheck {
  const missing = tasks.filter((task) => !satisfied(task));
  if (missing.length > 0) {
    return fail(`${failure}\n  Missing: ${missing.map((task) => task.id).join(", ")}`);
  }
  const lines = tasks.map((task) => `     ${task.id}: ${evidenceLine(task)}`);
  return pass(`${success} (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}`);
}

export function checkTestEvidence(tasks: readonly Task[]): GateCheck {
  return checkTaskRequirement(
    tasks,
    testEvidenceSatisfied,
    "FAILED: Not all tasks have test evidence.",
    "2. Test evidence verified",
    regressionEvidenceLine,
  );
}

export function checkNewTests(tasks: readonly Task[]): GateCheck {
  return checkTaskRequirement(
    tasks,
    newTestsSatisfied,
    "FAILED: Not all tasks satisfied new-test requirement.",
    "3. New tests verified",
    newTestEvidenceLine,
  );
}

export function checkReviews(tasks: readonly Task[]): GateCheck {
  const reviewed = tasks.filter((task) => task.review_status === "passed" || task.review_status === "blocked");
  if (reviewed.length !== tasks.length) {
    const unreviewed = tasks.filter((task) => !task.review_status || task.review_status === "pending").map((task) => task.id);
    const failedReview = tasks.filter((task) => task.review_status === "evidence_capture_failed").map((task) => task.id);
    const parts = ["FAILED: Not all tasks have been reviewed."];
    if (failedReview.length > 0) parts.push(`  Evidence capture failed: ${failedReview.join(", ")}`);
    if (unreviewed.length > 0) parts.push(`  Unreviewed: ${unreviewed.join(", ")}`);
    return fail(parts.join("\n"));
  }
  return pass(`5. Reviews verified (${tasks.length}/${tasks.length} tasks):\n${tasks.map((task) => `     ${task.id}: ${task.review_status}`).join("\n")}`);
}

export function checkSpecAlignment(state: TaskGraph, wave: number): GateCheck {
  if (!state.spec_check) return fail(`FAILED: Spec alignment evidence is missing for wave ${wave}. Run /spec-check for wave ${wave}.`);
  if (state.spec_check.wave !== wave) {
    return fail(`FAILED: Spec alignment was run for wave ${state.spec_check.wave}, not ${wave}. Re-run /spec-check for wave ${wave}.`);
  }
  if (state.spec_check.verdict === "EVIDENCE_CAPTURE_FAILED") {
    return fail(`FAILED: Spec alignment evidence is unusable (verdict: ${state.spec_check.verdict}, critical_count: missing).` +
      `\n  ${state.spec_check.error}\n  Re-run /spec-check for wave ${wave}.`);
  }
  if (state.spec_check.critical_count > 0) {
    return fail(`FAILED: Spec alignment has ${state.spec_check.critical_count} critical findings.\n${state.spec_check.critical_findings.map((finding) => `  - ${finding}`).join("\n")}`);
  }
  if (state.spec_check.verdict !== "PASSED") {
    return fail(`FAILED: Spec alignment verdict is ${state.spec_check.verdict}; only PASSED with zero critical findings can advance wave ${wave}.`);
  }
  return pass("6. Spec alignment verified (verdict: PASSED).");
}

export function checkCriticalFindings(tasks: readonly Task[]): GateCheck {
  const criticalByTask = tasks.map((task) => ({
    taskId: task.id,
    findings: (task.critical_findings ?? []).filter((finding) => finding.trim() !== ""),
  }));
  const totalCritical = criticalByTask.reduce((sum, { findings }) => sum + findings.length, 0);
  if (totalCritical > 0) {
    const details = criticalByTask
      .filter(({ findings }) => findings.length > 0)
      .map(({ taskId, findings }) => `  ${taskId}: ${findings.join(", ")}`)
      .join("\n");
    return fail(`FAILED: ${totalCritical} critical code review findings.\n${details}`);
  }
  return pass("7. No critical code review findings.");
}

export type PlanModelsSource =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unreadable"; path: string; error: string }>
  | Readonly<{ kind: "loaded"; models: PlanModels }>;

export type FilePresence =
  | Readonly<{ ok: true; exists: boolean }>
  | Readonly<{ ok: false; error: string }>;

const normalizeBindingPath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "");
const lifecyclePathMatches = (taskFile: string, declared: string): boolean => {
  const task = normalizeBindingPath(taskFile);
  const model = normalizeBindingPath(declared);
  return task === model || (model.includes("/") && task.endsWith(`/${model}`));
};

export function checkLifecycleArtifacts(
  source: PlanModelsSource,
  waveTasks: readonly Task[],
  filePresence: (path: string) => FilePresence,
): GateCheck {
  if (source.kind === "none") {
    return fail("FAILED: plan file is missing — cannot verify Lifecycle Machine artifacts (fail-closed).");
  }
  if (source.kind === "unreadable") {
    return fail(`FAILED: plan file '${source.path}' is unreadable — cannot verify lifecycle machine artifacts (fail-closed): ${source.error}`);
  }
  const waveFiles = waveTasks.flatMap((task) => task.file_list ?? []);
  const bound = source.models.lifecycles.flatMap((lifecycle) => {
    const machineFile = lifecycle.machineFile;
    return machineFile !== null && waveFiles.some((file) => lifecyclePathMatches(file, machineFile))
      ? [{ lifecycle, machineFile }]
      : [];
  });
  if (bound.length === 0) return pass("8. Lifecycle artifacts: none bound to this wave.");
  const observed = bound.map(({ lifecycle, machineFile }) => {
    const variants = [...new Set([
      machineFile,
      ...waveFiles.filter((file) => lifecyclePathMatches(file, machineFile)),
    ])];
    return { lifecycle, machineFile, variants: variants.map((path) => ({ path, presence: filePresence(path) })) };
  });
  const unresolved = observed.filter(({ variants }) =>
    !variants.some(({ presence }) => presence.ok && presence.exists)
  );
  const unavailable = unresolved.flatMap(({ lifecycle, variants }) =>
    variants.flatMap(({ path, presence }) => presence.ok ? [] : [{ lifecycle, path, error: presence.error }])
  );
  if (unavailable.length > 0) {
    return fail("FAILED: lifecycle machine artifact presence is unavailable (fail-closed):\n" +
      unavailable.map(({ lifecycle, path, error }) => `  ${lifecycle.id}: ${path}: ${error}`).join("\n"));
  }
  if (unresolved.length > 0) {
    return fail("FAILED: lifecycle machine files declared in the plan were not created by this wave:\n" +
      unresolved.map(({ lifecycle, machineFile }) => `  ${lifecycle.id}: ${machineFile}`).join("\n"));
  }
  return pass(`8. Lifecycle artifacts verified (${bound.length}):\n` +
    bound.map(({ lifecycle, machineFile }) => `     ${lifecycle.id}: ${machineFile}`).join("\n"));
}

export type ImplementationReservationStatusObservation =
  | Readonly<{ kind: "observed"; observedAtMs: number; anyActiveForGraph: boolean }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export interface GateDeps {
  readonly loadPlanModels: (planFile: string | null | undefined) => PlanModelsSource;
  readonly filePresence: (path: string) => FilePresence;
  /** Shell observation of current declared bytes. Required whenever accepted
   * packet authority exists; omitted observations fail closed. */
  readonly reviewedWorkspace?: (tasks: readonly Task[]) => readonly ReviewedWorkspaceObservation[];
  /** Shell-supplied current Wave workspace observation. The functional core
   * compares it with suite authority and performs no repository I/O. */
  readonly currentWaveWorkspace?: WaveWorkspaceObservation;
  /** Shell-supplied persisted result observation, separate from workspace
   * authority so absence cannot be confused with an unreadable artifact. */
  readonly currentWaveCompletionResult?: WaveCompletionResultObservation;
  /** Shell observation used only to make policy-expired reservations
   * dispatchable again. Absence/unavailability keeps them active fail-closed. */
  readonly implementationReservations?: ImplementationReservationStatusObservation;
}

export function checkWaveCompletionSuite(
  state: TaskGraph,
  wave: number,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined = undefined,
): GateCheck {
  const readiness = deriveWaveCompletionSuiteReadiness(state, wave, currentWorkspace, currentResult);
  return match(readiness)
    .with({ kind: "legacy-unavailable" }, () =>
      pass("4. Wave completion suite: legacy-unavailable (verification_manifest and active receipt absent)."))
    .with({ kind: "required" }, (value) => fail(
      `FAILED: Wave completion suite required (${value.reason}): ${value.detail}. ` +
      renderProjectVerificationCoverage(value.projectVerificationCoverage),
    ))
    .with({ kind: "rejected" }, (value) => fail(
      `FAILED: Wave completion suite rejected (${value.failureKinds.join(", ")}): ${value.checkIds.join(", ")}. ` +
      renderProjectVerificationCoverage(value.projectVerificationCoverage),
    ))
    .with({ kind: "stale" }, (value) => fail(
      "FAILED: accepted Wave completion suite is stale: " +
      `accepted workspace ${value.acceptedWorkspaceDigest}, current workspace ${value.currentWorkspaceDigest}. ` +
      renderProjectVerificationCoverage(value.projectVerificationCoverage),
    ))
    .with({ kind: "accepted" }, (value) => pass(
      `4. Wave completion suite accepted (${value.checkCount} checks; ` +
      `result ${value.resultDigest}; workspace ${value.workspaceDigest}). ` +
      (value.projectVerificationCoverage.kind === "not-configured" ? "Reserved checks accepted; " : "") +
      renderProjectVerificationCoverage(value.projectVerificationCoverage),
    ))
    .exhaustive();
}

export function checkReviewedWorkspace(tasks: readonly Task[], deps: GateDeps): GateCheck {
  if (!tasks.some((task) => task.accepted_review_authority !== undefined)) {
    // Pre-integrity historical packets have no byte snapshot authority to
    // compare. New engine-owned Wave packets always retain one on acceptance.
    return pass("9. Review Packet workspace integrity: legacy packet authority unavailable.");
  }
  if (deps.reviewedWorkspace === undefined) {
    return fail("FAILED: Review Packet workspace integrity cannot be observed; refresh review evidence after restoring repository access.");
  }
  try {
    const drift = reviewedWorkspaceDrift(tasks, deps.reviewedWorkspace(tasks));
    return drift.length === 0
      ? pass(`9. Review Packet workspace integrity verified (${tasks.length}/${tasks.length} tasks).`)
      : fail(`FAILED: accepted Review Packet authority is stale:\n  ${drift.join("\n  ")}\n  Protected block: rerun the Wave Gate review batch to refresh evidence.`);
  } catch (error) {
    return fail(`FAILED: Review Packet workspace integrity could not be proven (fail-closed): ${error instanceof Error ? error.message : String(error)}. Refresh review evidence after correcting the repository path.`);
  }
}

export interface GateDecision {
  readonly wave: number;
  readonly checks: readonly GateCheck[];
  readonly verdict:
    | Readonly<{ kind: "fail"; reason: string }>
    | Readonly<{ kind: "pass"; taskIds: readonly string[]; nextWave: number | null }>;
}

export function computeNextWave(tasks: readonly Task[], currentWave: number): number | null {
  const waves = [...new Set(tasks.map((task) => task.wave))].sort((left, right) => left - right);
  return waves.find((wave) => wave > currentWave) ?? null;
}

type WaveGateAuthorityCheck = Readonly<{
  wave: number;
  failures: readonly string[];
}>;

function waveGateAuthorityCheck(state: TaskGraph, waveArg: number | null): WaveGateAuthorityCheck {
  const currentWave = state.current_wave;
  const registration = state.active_wave_gate;
  const requestedWave = waveArg ?? currentWave;
  const failures: string[] = [];
  if (state.current_phase !== "execute") failures.push(`current Phase is ${state.current_phase}, not execute`);
  if (currentWave === undefined) failures.push("protected current_wave authority is missing");
  if (registration === undefined) failures.push("active Wave Gate registration is missing; explicitly register or migrate legacy authority first");
  if (registration?.terminalOutcome !== null && registration !== undefined) {
    failures.push(`active Wave Gate run ${registration.runId} is terminal and must be archived before another completion`);
  }
  if (requestedWave === undefined) failures.push("no Wave was selected by protected authority");
  if (waveArg !== null && currentWave !== undefined && waveArg !== currentWave) {
    failures.push(`requested wave ${waveArg} does not match protected current_wave ${currentWave}`);
  }
  if (registration !== undefined && currentWave !== undefined && registration.wave !== currentWave) {
    failures.push(`active Wave Gate wave ${registration.wave} does not match protected current_wave ${currentWave}`);
  }
  if (registration !== undefined && requestedWave !== undefined && registration.wave !== requestedWave) {
    failures.push(`active Wave Gate wave ${registration.wave} does not authorize requested wave ${requestedWave}`);
  }
  return canonicalRecord({ wave: requestedWave ?? 0, failures: Object.freeze(failures) });
}

function failedGateDecision(wave: number, checks: readonly GateCheck[], reason: string): GateDecision {
  return canonicalRecord({ wave, checks, verdict: canonicalRecord({ kind: "fail", reason }) });
}

/**
 * The Wave Gate's start prerequisites, defined ONCE. The gate evaluates them
 * first, status projects them before it advises a start, and `start
 * wave-gate` refuses on them before claiming a Run Directory — so status can
 * never advise a start that the start would then register and block on.
 */
function waveStartPrerequisiteChecks(state: TaskGraph, waveTasks: readonly Task[]): readonly GateCheck[] {
  return Object.freeze([
    checkNoExecutingTasks(waveTasks, state.executing_tasks ?? []),
    checkImplementationProof(waveTasks),
    checkTestEvidence(waveTasks),
    checkNewTests(waveTasks),
  ]);
}

export type WaveStartReadiness =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "not-ready"; failures: NonEmpty<string> }>;

/** Whether one Wave's Tasks satisfy every start prerequisite, with every
 *  failed prerequisite's reason in gate order. */
export function deriveWaveStartReadiness(state: TaskGraph, waveTasks: readonly Task[]): WaveStartReadiness {
  const failures = waveStartPrerequisiteChecks(state, waveTasks)
    .flatMap((check) => check.passed ? [] : [check.reason]);
  const [first, ...rest] = failures;
  return first === undefined
    ? canonicalRecord({ kind: "ready" as const })
    : canonicalRecord({ kind: "not-ready" as const, failures: Object.freeze([first, ...rest]) as NonEmpty<string> });
}

function waveGateChecks(state: TaskGraph, wave: number, waveTasks: readonly Task[], deps: GateDeps): readonly GateCheck[] {
  return Object.freeze([
    ...waveStartPrerequisiteChecks(state, waveTasks),
    checkWaveCompletionSuite(
      state,
      wave,
      deps.currentWaveWorkspace,
      deps.currentWaveCompletionResult,
    ),
    checkReviews(waveTasks),
    checkSpecAlignment(state, wave),
    checkCriticalFindings(waveTasks),
    checkLifecycleArtifacts(deps.loadPlanModels(state.plan_file ?? state.phase_artifacts?.architecture), waveTasks, deps.filePresence),
    checkReviewedWorkspace(waveTasks, deps),
  ]);
}

function passedGateDecision(state: TaskGraph, wave: number, checks: readonly GateCheck[], waveTasks: readonly Task[]): GateDecision {
  return canonicalRecord({
    wave,
    checks,
    verdict: canonicalRecord({ kind: "pass", taskIds: Object.freeze(waveTasks.map((task) => task.id)), nextWave: computeNextWave(state.tasks, wave) }),
  });
}

export function evaluateWaveGate(state: TaskGraph, waveArg: number | null, deps: GateDeps): GateDecision {
  const authority = waveGateAuthorityCheck(state, waveArg);
  if (authority.failures.length > 0) {
    return failedGateDecision(
      authority.wave,
      Object.freeze([]),
      `FAILED: Wave Gate authority unavailable or contradictory:\n  - ${authority.failures.join("\n  - ")}`,
    );
  }
  const waveTasks = state.tasks.filter((task) => task.wave === authority.wave);
  if (waveTasks.length === 0) {
    return failedGateDecision(
      authority.wave,
      Object.freeze([]),
      `FAILED: wave ${authority.wave} has no tasks — nothing to gate (wrong --wave or unpopulated task graph?)`,
    );
  }
  const checks = waveGateChecks(state, authority.wave, waveTasks, deps);
  const failed = checks.find((check): check is Extract<GateCheck, { passed: false }> => !check.passed);
  return failed === undefined
    ? passedGateDecision(state, authority.wave, checks, waveTasks)
    : failedGateDecision(authority.wave, checks, failed.reason);
}

export function applyGateDecision(state: TaskGraph, decision: GateDecision): TaskGraph {
  if (
    decision.verdict.kind !== "pass" || state.current_wave !== decision.wave ||
    state.active_wave_gate === undefined || state.active_wave_gate.wave !== decision.wave ||
    state.active_wave_gate.terminalOutcome !== null
  ) return state;
  const defaultGate = newWaveGate();
  const clearedTasks = state.tasks.map((task): Task => {
    if (task.wave !== decision.wave || task.status === "completed") return task;
    if (task.status !== "implemented" || task.proof?.state !== "satisfied") return task;
    return {
      ...task,
      status: "completed",
      proof: task.proof,
      legacy_missing_proof: undefined,
      review_status: "passed",
    };
  });
  // `blocked` is DERIVED, never asserted. `wave-gate-model`'s `waveHasBlockCause`
  // is documented as the only copy of the rule every writer computes from, and a
  // literal `blocked: false` here was the writer that made that false. On a pass
  // verdict `checkCriticalFindings` and `checkSpecAlignment` have already proven
  // there is no cause, so re-deriving cannot change the outcome — it removes the
  // second, drifting copy of the rule rather than the behaviour.
  const gatesAfterDecision = reconcileWaveBlock(
    {
      ...state.wave_gates,
      [String(decision.wave)]: {
        ...(state.wave_gates[String(decision.wave)] ?? defaultGate),
        impl_complete: true,
        tests_passed: true,
        reviews_complete: true,
      },
      ...(decision.verdict.nextWave === null ? {} : {
        [String(decision.verdict.nextWave)]: { ...(state.wave_gates[String(decision.verdict.nextWave)] ?? defaultGate) },
      }),
    },
    clearedTasks,
    state.spec_check,
    decision.wave,
  );
  return {
    ...state,
    tasks: clearedTasks,
    wave_gates: gatesAfterDecision,
    ...(decision.verdict.nextWave === null ? {} : { current_wave: decision.verdict.nextWave }),
    wave_review_epoch: undefined,
  };
}
