/**
 * Validate task graph JSON schema.
 * Usage: bun cli.ts helper validate-task-graph [--minimal] [--fix] [--accept-data-loss]
 * Reads JSON from stdin or file arg.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, Phase, TaskGraph } from "../../types";
import { PHASE_ORDER, KNOWN_AGENTS, REVIEW_SUB_AGENTS } from "../../config";
import {
  attributeFindings,
  claimsOfSeverity,
  deduplicateFindingIds,
  findingIdCollisionError,
  findingsLockstepError,
  findingsUnionError,
  findingsViewError,
  evidenceFailureError,
  nextOrdinal,
  refutationsUnionError,
  resolutionsUnionError,
  reviewRunError,
  parseStoredFindings,
  parseStoredRefutations,
  parseStoredResolutions,
  recoverViewOnlyClaims,
  unrecoverableViewClaims,
  salvageFindingsFromMalformedRefutations,
  salvageFindingsFromMalformedResolutions,
  salvageMalformedFindings,
  RECOVERED_AGENT,
} from "../../core/findings";
import { checkPlanModelBindings, type ModelBindingDeps } from "./validate-model-bindings";
import {
  taskDependencyErrors,
  taskGraphLifecycleErrors,
  taskIdError,
  taskUnionError,
} from "../../state-manager";
import { parseReviewPath } from "../../core/review-packet";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: readonly string[] };

function ok(): ValidationResult { return { ok: true }; }
function fail(errors: string[]): ValidationResult { return { ok: false, errors }; }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const VALID_PHASES = new Set<string>(PHASE_ORDER);

const NO_TEST_KEYWORDS = /migration|config|schema|rename|bump|version|refactor|cleanup|typo|docs|interface|documentation|changelog|readme|ci|cd|pipeline|deploy|→|->|styling|css|formatting|adr|codegen|generated/i;

/** Validate minimal phase-tracking graph (no tasks) */
export function validateMinimal(json: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  const cp = json.current_phase as string | undefined;
  if (!cp) errors.push("Missing required field: current_phase");
  else if (!VALID_PHASES.has(cp)) errors.push(`current_phase '${cp}' not a valid phase`);

  if (typeof json.phase_artifacts !== "object" || Array.isArray(json.phase_artifacts)) {
    errors.push("phase_artifacts must be object");
  }
  if (!Array.isArray(json.skipped_phases)) errors.push("skipped_phases must be array");
  if (!("spec_file" in json)) errors.push("Missing required field: spec_file");
  if (!("plan_file" in json)) errors.push("Missing required field: plan_file");

  return errors.length === 0 ? ok() : fail(errors);
}

/** Fix minimal graph — preserve valid fields, default invalid ones */
function fixMinimal(json: Record<string, unknown>): string {
  return JSON.stringify({
    current_phase: VALID_PHASES.has(json.current_phase as string) ? json.current_phase : "init",
    phase_artifacts: typeof json.phase_artifacts === "object" && !Array.isArray(json.phase_artifacts)
      ? json.phase_artifacts : {},
    skipped_phases: Array.isArray(json.skipped_phases) ? json.skipped_phases : [],
    spec_file: "spec_file" in json ? json.spec_file : null,
    plan_file: "plan_file" in json ? json.plan_file : null,
  }, null, 2);
}

/**
 * Every findings-aggregate rule the load boundary applies to one task.
 *
 * Exported shape of the agreement: `taskUnionError` (state-manager) runs exactly
 * these, in this order, and `--fix` repairs exactly what they reject. A rule
 * added to one and not the other is the drift that let the operator's validator
 * disagree with the loader.
 */
function findingsErrorsOf(task: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  const push = (error: string | null): void => {
    if (error !== null) errors.push(error);
  };
  push(findingsUnionError(task.findings, `${label}: findings`));
  for (const severity of ["critical", "advisory"] as const) {
    push(findingsViewError(task[`${severity}_findings`], `${label}: ${severity}_findings`));
  }
  push(findingsLockstepError(task.findings, task.critical_findings, task.advisory_findings, label));
  push(refutationsUnionError(task.refuted_findings, `${label}: refuted_findings`));
  push(resolutionsUnionError(task.resolved_findings, `${label}: resolved_findings`));
  push(findingIdCollisionError(task.findings, task.refuted_findings, label, task.resolved_findings));
  push(reviewRunError(task.review_run, task.review_generation, task.findings, `${label}: review_run`));
  push(evidenceFailureError(task, label, REVIEW_SUB_AGENTS));
  return errors;
}

/**
 * What is being validated, which decides whether the findings aggregate is in
 * scope.
 *
 * `state-file` is a graph that `StateManager.load()` must be able to open, so it
 * is held to every load-boundary rule. `decompose-payload` is the
 * AGENT-CONTROLLED stdin the decompose step emits, validated BEFORE
 * `sanitizeDecomposedTask` strips the execution state a planner must never mint
 * — findings, review status, test verdicts. Holding that payload to the findings
 * invariants would reject forged state the pipeline exists to clean, turning a
 * successful sanitization into a hard failure.
 */
export type ValidationScope = "state-file" | "decompose-payload";

/** Validate full decompose task graph */
export function validateFull(
  json: Record<string, unknown>,
  scope: ValidationScope = "state-file",
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (scope === "state-file") errors.push(...taskGraphLifecycleErrors(json));

  // Required top-level fields — path fields must be real strings, not merely
  // truthy, or a garbage value silently disarms downstream plan-based checks
  for (const field of ["plan_title", "plan_file", "spec_file"]) {
    if (!json[field]) errors.push(`Missing required field: ${field}`);
    else if (typeof json[field] !== "string") errors.push(`Field '${field}' must be a string`);
  }
  if (!json.tasks) errors.push("Missing required field: tasks");
  if (
    json.current_wave !== undefined &&
    (typeof json.current_wave !== "number" || !Number.isInteger(json.current_wave) || json.current_wave < 1)
  ) {
    errors.push(`current_wave must be an integer >= 1 when present, got ${JSON.stringify(json.current_wave)}`);
  }

  const tasks = json.tasks;
  if (!Array.isArray(tasks)) {
    errors.push("'tasks' must be an array");
    return fail(errors);
  }

  if (tasks.length === 0) errors.push("'tasks' array is empty");

  const taskRecords = tasks.map((task) => isRecord(task) ? task : null);
  const validTaskRecords = taskRecords.filter((task): task is Record<string, unknown> => task !== null);
  const taskIds = validTaskRecords.flatMap((task) =>
    typeof task.id === "string" && task.id !== "" ? [task.id] : [],
  );
  const duplicateIds = [...new Set(taskIds.filter((id, index) => taskIds.indexOf(id) !== index))];
  for (const id of duplicateIds) errors.push(`Duplicate task id: ${id}`);
  errors.push(...taskDependencyErrors(validTaskRecords));

  for (let i = 0; i < tasks.length; i++) {
    const task = taskRecords[i];
    if (task === null) {
      errors.push(`Task [${i}]: must be an object`);
      continue;
    }
    const tid = typeof task.id === "string" ? task.id : undefined;

    if (!tid) { errors.push(`Task [${i}]: missing 'id'`); continue; }
    const identityError = taskIdError(tid, `Task ${tid}`);
    if (identityError !== null) errors.push(identityError);

    if (typeof task.description !== "string" || task.description.trim() === "") {
      errors.push(`Task ${tid}: 'description' must be a non-empty string`);
    }
    const agent = task.agent;
    if (typeof agent !== "string" || agent.trim() === "") {
      errors.push(`Task ${tid}: 'agent' must be a non-empty string`);
    } else if (!KNOWN_AGENTS.has(agent)) {
      errors.push(`Task ${tid}: unknown agent '${agent}'`);
    }

    const wave = task.wave as number | undefined;
    if (wave === undefined) errors.push(`Task ${tid}: missing 'wave'`);
    else if (!Number.isInteger(wave) || wave < 1) errors.push(`Task ${tid}: wave must be integer >= 1`);

    const deps = task.depends_on;
    if (deps !== undefined && deps !== null && !Array.isArray(deps)) {
      errors.push(`Task ${tid}: 'depends_on' must be array`);
    }

    if (Array.isArray(deps) && deps.some((dep) => typeof dep !== "string")) {
      errors.push(`Task ${tid}: 'depends_on' entries must be strings`);
    }

    if (scope === "decompose-payload" && task.file_list !== undefined) {
      if (!Array.isArray(task.file_list) || task.file_list.some((file) => typeof file !== "string" || file.trim() === "")) {
        errors.push(`Task ${tid}: 'file_list' must be an array of non-empty strings if present`);
      } else {
        const seen = new Set<string>();
        for (const [pathIndex, file] of task.file_list.entries()) {
          const parsed = parseReviewPath(file, `Task ${tid}: file_list[${pathIndex}]`);
          if (!parsed.ok) errors.push(...parsed.errors);
          else if (seen.has(parsed.value)) errors.push(`Task ${tid}: file_list repeats '${parsed.value}'`);
          else seen.add(parsed.value);
        }
      }
    }

    // The findings aggregate, checked with the SAME functions the load boundary
    // uses. This validator ran none of them, so `helper validate-task-graph`
    // reported `{ok: true}` on a graph `StateManager.load()` refuses to open —
    // two validators, two rule sets, and the one the operator is told to run was
    // the weaker one. Sharing the functions is what keeps "valid" one answer.
    if (scope === "state-file") {
      for (const check of findingsErrorsOf(task, `Task ${tid}`)) errors.push(check);
      // Decompose payloads intentionally omit execution state; every persisted
      // state task must agree with StateManager's exact parser, including when a
      // required field is absent rather than merely malformed.
      const stateError = taskUnionError(task, i);
      if (stateError !== null) errors.push(stateError);
    }

    // Optional field type checks
    if (
      task.spec_anchors !== undefined && task.spec_anchors !== null &&
      (!Array.isArray(task.spec_anchors) ||
        task.spec_anchors.some((anchor) => typeof anchor !== "string" || anchor.trim() === ""))
    ) {
      errors.push(`Task ${tid}: 'spec_anchors' must be an array of non-empty strings if present`);
    }
    if (task.new_tests_required !== undefined && typeof task.new_tests_required !== "boolean") {
      errors.push(`Task ${tid}: 'new_tests_required' must be boolean if present`);
    }

    // Warn on suspicious new_tests_required=false
    if (task.new_tests_required === false && task.description) {
      if (!NO_TEST_KEYWORDS.test(task.description as string)) {
        process.stderr.write(`WARNING: Task ${tid} has new_tests_required=false but description doesn't match no-test patterns\n`);
      }
    }
  }

  // Check wave contiguity — waves must be consecutive (1,2,3 not 1,3,5)
  const waves = [...new Set(validTaskRecords.map((task) => task.wave as number))]
    .filter((w): w is number => typeof w === "number" && Number.isInteger(w))
    .sort((a, b) => a - b);
  for (let i = 1; i < waves.length; i++) {
    if (waves[i] !== waves[i - 1] + 1) {
      errors.push(`Wave gap: ${waves[i - 1]} → ${waves[i]} (waves must be contiguous)`);
    }
  }

  // ADR tasks must be in the highest wave so they document what already shipped.
  const adrTasks = validTaskRecords.filter((task) => task.agent === "adr-writer-agent");
  if (adrTasks.length > 0 && waves.length > 0) {
    const maxWave = waves[waves.length - 1];
    const nonImplTasks = validTaskRecords.filter((task) => task.agent !== "adr-writer-agent");
    const implWaves = [...new Set(nonImplTasks.map((task) => task.wave as number))]
      .filter((w): w is number => typeof w === "number" && Number.isInteger(w));
    const maxImplWave = implWaves.length > 0 ? Math.max(...implWaves) : 0;

    for (const t of adrTasks) {
      const tid = t.id as string;
      const tw = t.wave as number;
      if (tw !== maxWave) {
        errors.push(`Task ${tid}: ADR task must be in the final wave (wave ${maxWave}); found wave ${tw}`);
      }
      if (maxImplWave > 0 && tw <= maxImplWave) {
        errors.push(`Task ${tid}: ADR task wave (${tw}) must be greater than max impl wave (${maxImplWave})`);
      }
    }
  }

  return errors.length === 0 ? ok() : fail(errors);
}

/** What one task's findings repair changed, so the handler can say so. */
interface FindingsRepair {
  readonly fields: Record<string, unknown>;
  /** Claims that existed only in a `string[]` view and were given identity. */
  readonly recovered: readonly string[];
  /** Claims rescued from a `findings` entry too malformed to parse. */
  readonly salvaged: readonly string[];
  /** View-only claims that could not be given identity — an empty string or a
   *  no-findings sentinel. Removed, correctly, but the removal flips a task
   *  from gate-blocking to gate-passing, so it is reported like every other
   *  lossy path rather than being inferred from a count that never saw it. */
  readonly unrecoverableViewClaims: readonly string[];
  /** Ids that collided and were re-minted. */
  readonly reminted: number;
  /** Malformed `findings` entries carrying nothing salvageable. The one path in
   *  this file that loses data, so it is counted and reported rather than
   *  vanishing between the raw array and the parsed one. */
  readonly dropped: number;
  /** Claims returned to the active set from malformed refutation envelopes. */
  readonly recoveredRefutationFindings: readonly string[];
  /** Malformed `refuted_findings` records whose audit trail was unrecoverable. */
  readonly droppedRefutations: number;
  /** Claims returned to the active set from malformed remediation envelopes. */
  readonly recoveredResolutionFindings: readonly string[];
  /** Malformed remediation records whose audit trail was unrecoverable. */
  readonly droppedResolutions: number;
  /** The review record was cleared because its evidence-failure biconditional
   *  was broken and no honest reconstruction exists. */
  readonly clearedReviewRecord: boolean;
}

/**
 * Repair one task's findings and the two `string[]` views over them.
 *
 * Every path here CONSERVES claims, or SAYS that it could not. That is the
 * whole rule, and it used not to hold in two ways. A claim in
 * `critical_findings` with no counterpart in `findings` was deleted, silently,
 * by the repair the load-boundary diagnostic itself tells the operator to run —
 * and `complete-wave-gate` counts that view, so the deletion turned a blocking
 * wave into a passing one. A claim carried ONLY by a malformed `findings` entry
 * was deleted the same way, because conservation rested entirely on the views
 * still holding it and nothing reported the difference when they did not.
 *
 * Four repairs, in order:
 *
 *   1. Malformed `findings` entries lose their IDENTITY, not their claim. They
 *      are the items a refutation panel votes on, and a malformed one reaches a
 *      verifier as an un-votable item, so it cannot stay as it is — but
 *      `salvageMalformedFindings` re-mints whatever claim it still carries under
 *      RECOVERED_AGENT. Only an entry with no usable severity or claim is truly
 *      dropped, and that is COUNTED and reported, never silent.
 *   2. Claims present only in a view are given identity (`recoverViewOnlyClaims`).
 *      This is what makes a pre-identity task adjudicable, and what makes the
 *      repair idempotent: after one pass the views hold exactly what `findings`
 *      holds, so a second pass finds nothing to recover. Running it AFTER step 1
 *      is what stops a salvaged claim being minted twice.
 *   3. Colliding ids are re-minted, because the load boundary now rejects
 *      duplicates and a rejection with no working repair dead-ends the operator.
 *   4. Malformed refutation records lose their unusable audit decision, but a
 *      valid nested finding is returned to the active set before views are
 *      derived. The malformed record is still counted and reported.
 *
 * The views are then re-derived from the result, which is the lockstep
 * `findingsLockstepError` proves at load.
 */
/**
 * Recover findings that survive only as malformed entries or as claims left in
 * a derived view.
 *
 * Both recoveries exist for the same reason: a finding that reaches only the
 * `critical_findings`/`advisory_findings` string views, or that is structurally
 * broken in `findings`, would otherwise be dropped by repair — and dropping one
 * silently loses a blocker. What cannot be recovered is reported rather than
 * discarded.
 */
function salvageAndRecoverFindings(
  t: Record<string, unknown>,
  rawFindings: readonly unknown[],
  parsed: ReturnType<typeof deduplicateFindingIds>,
  refuted: ReturnType<typeof parseStoredRefutations>,
  resolved: ReturnType<typeof parseStoredResolutions>,
) {
  const salvagedDrafts = salvageMalformedFindings(rawFindings);
  const salvagedFindings = salvagedDrafts.length === 0
    ? []
    : attributeFindings(
        salvagedDrafts,
        RECOVERED_AGENT,
        nextOrdinal(parsed, refuted, RECOVERED_AGENT, resolved),
      );
  const identified = [...parsed, ...salvagedFindings];

  const viewClaims = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((claim): claim is string => typeof claim === "string") : [];
  const recoveredFindings = recoverViewOnlyClaims(
    identified,
    refuted,
    viewClaims(t.critical_findings),
    viewClaims(t.advisory_findings),
    resolved,
  );
  return {
    salvagedFindings,
    recoveredFindings,
    findings: [...identified, ...recoveredFindings],
    unrecoverable: unrecoverableViewClaims(
      identified,
      viewClaims(t.critical_findings),
      viewClaims(t.advisory_findings),
    ),
  };
}

/**
 * Normalize the three stored containers and recover findings nested inside
 * malformed refutation/resolution records.
 *
 * A singleton object is malformed as a CONTAINER but not necessarily as a
 * record, so it is normalized to one entry rather than read as no evidence —
 * discarding it would lose the audit record and any finding nested in it.
 */
function readFindingContainers(t: Record<string, unknown>) {
  const asEntries = (raw: unknown): readonly unknown[] =>
    Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];

  const rawRefutations = asEntries(t.refuted_findings);
  const rawResolutions = asEntries(t.resolved_findings);
  const rawFindings = asEntries(t.findings);
  const refuted = parseStoredRefutations(rawRefutations);
  const resolved = parseStoredResolutions(rawResolutions);
  const stored = parseStoredFindings(rawFindings);

  const represented = [
    ...stored,
    ...refuted.map((record) => record.finding),
    ...resolved.map((record) => record.finding),
  ];
  type FindingIdentity = { readonly id: string; readonly severity: string; readonly claim: string };
  const sameFinding = (left: FindingIdentity, right: FindingIdentity): boolean =>
    left.id === right.id && left.severity === right.severity && left.claim === right.claim;

  const recoveredRefutationFindings = salvageFindingsFromMalformedRefutations(rawRefutations)
    .filter((candidate) => !represented.some((existing) => sameFinding(existing, candidate)));
  const recoveredResolutionFindings = salvageFindingsFromMalformedResolutions(rawResolutions)
    .filter((candidate) => ![...represented, ...recoveredRefutationFindings]
      .some((existing) => sameFinding(existing, candidate)));

  return {
    rawFindings,
    refuted,
    resolved,
    stored,
    recoveredRefutationFindings,
    recoveredResolutionFindings,
    rawRefutedCount: rawRefutations.length,
    rawResolvedCount: rawResolutions.length,
    rawFindingCount: rawFindings.length,
  };
}

function fixTaskFindings(t: Record<string, unknown>): FindingsRepair {
  const { rawFindings, refuted, resolved, stored, recoveredRefutationFindings,
    recoveredResolutionFindings, rawRefutedCount, rawResolvedCount, rawFindingCount } = readFindingContainers(t);
  // Order- and length-preserving, so an id that differs at the same index is
  // exactly one this repair re-minted. Recovered nested findings participate in
  // the same collision proof before returning to the active set.
  const beforeDedup = [...stored, ...recoveredRefutationFindings, ...recoveredResolutionFindings];
  const parsed = deduplicateFindingIds(beforeDedup, refuted, resolved);
  const reminted = parsed.filter((finding, index) => finding.id !== beforeDedup[index]?.id).length;

  const salvage = salvageAndRecoverFindings(t, rawFindings, parsed, refuted, resolved);
  const { salvagedFindings, recoveredFindings, findings, unrecoverable } = salvage;

  const review = repairReviewRecord(t);
  const runInvalidated = t.review_run !== undefined && (
    recoveredFindings.length > 0 || salvagedFindings.length > 0 ||
    unrecoverable.length > 0 || reminted > 0 || recoveredRefutationFindings.length > 0 ||
    recoveredResolutionFindings.length > 0 ||
    rawFindingCount !== stored.length || rawRefutedCount !== refuted.length ||
    rawResolvedCount !== resolved.length
  );

  return {
    fields: {
      findings,
      critical_findings: [...claimsOfSeverity(findings, "critical")],
      advisory_findings: [...claimsOfSeverity(findings, "advisory")],
      refuted_findings: refuted,
      resolved_findings: resolved,
      ...review.fields,
      ...(runInvalidated
        ? {
            review_run: undefined,
            review_status: "pending",
            review_error: undefined,
            review_evidence_failures: undefined,
          }
        : {}),
    },
    recovered: recoveredFindings.map((finding) => finding.claim),
    salvaged: salvagedFindings.map((finding) => finding.claim),
    unrecoverableViewClaims: unrecoverable,
    reminted,
    dropped: rawFindingCount - stored.length - salvagedFindings.length,
    recoveredRefutationFindings: recoveredRefutationFindings.map((finding) => finding.claim),
    droppedRefutations: rawRefutedCount - refuted.length,
    recoveredResolutionFindings: recoveredResolutionFindings.map((finding) => finding.claim),
    droppedResolutions: rawResolvedCount - resolved.length,
    clearedReviewRecord: review.cleared || runInvalidated,
  };
}

/**
 * Repair the review record's evidence-failure invariant
 * (`evidenceFailureError` at the load boundary): the status is
 * `evidence_capture_failed` exactly when `review_evidence_failures` names at
 * least one reviewer, and only that state may retain `review_error`.
 *
 * There is no honest reconstruction of a broken pairing — nothing on disk says
 * WHICH reviewer's transcript could not be parsed — so the repair clears the
 * whole review record rather than guessing. That is the fail-closed direction:
 * `checkReviews` counts a task with no review_status as unreviewed and fails the
 * gate, whereas inventing an agent name would leave a block nothing can clear,
 * and dropping the status alone would advance a wave over a reviewer whose
 * findings were never captured.
 */
function repairReviewRecord(t: Record<string, unknown>): {
  readonly fields: Record<string, unknown>;
  readonly cleared: boolean;
} {
  const raw = t.review_evidence_failures;
  const run = typeof t.review_run === "object" && t.review_run !== null && !Array.isArray(t.review_run)
    ? t.review_run as Record<string, unknown>
    : null;
  const expected = Array.isArray(run?.expected_agents) &&
    run.expected_agents.every((agent) => typeof agent === "string")
    ? new Set(run.expected_agents as string[])
    : null;
  const allowed = expected ?? REVIEW_SUB_AGENTS;
  const agents = Array.isArray(raw)
    ? [...new Set(raw.filter((a): a is string =>
        typeof a === "string" && a.trim() !== "" && allowed.has(a),
      ))]
    : [];
  const failed = t.review_status === "evidence_capture_failed";
  const rawArrayWellFormed = raw === undefined || (
    Array.isArray(raw) &&
    raw.every((agent) => typeof agent === "string" && agent.trim() !== "" && allowed.has(agent)) &&
    new Set(raw).size === raw.length
  );
  const reviewErrorWellFormed = t.review_error === undefined ||
    (typeof t.review_error === "string" && t.review_error.trim() !== "");
  const staleReviewError = !failed && t.review_error !== undefined;
  const wellFormed = failed === agents.length > 0 && rawArrayWellFormed &&
    reviewErrorWellFormed && !staleReviewError;

  if (wellFormed) {
    // Still normalize: a duplicate or blank entry loads as an error but carries
    // no information a repair could lose.
    return {
      fields: agents.length > 0 ? { review_evidence_failures: agents } : {},
      cleared: false,
    };
  }
  return {
    fields: {
      review_status: "pending",
      review_error: undefined,
      review_evidence_failures: undefined,
    },
    cleared: true,
  };
}

/** What `fixFull` changed beyond structural defaults — reported, never silent. */
export interface FixReport {
  readonly json: string;
  readonly notes: readonly string[];
  /** Exact notes for transformations that discard unrecoverable source data. */
  readonly dataLoss: readonly string[];
}

/**
 * Fix full graph — add missing per-task defaults and restore findings lockstep.
 *
 * Returns the notes rather than writing them: `--fix` is a pure transformation
 * whose output is piped, and a repair that changed a claim's identity must reach
 * the operator's stderr rather than only the file.
 */
export function fixFull(json: Record<string, unknown>): FixReport {
  const tasks: readonly unknown[] = Array.isArray(json.tasks) ? json.tasks : [];
  const notes: string[] = [];
  const dataLoss: string[] = [];
  const currentWaveValid =
    typeof json.current_wave === "number" && Number.isInteger(json.current_wave) && json.current_wave >= 1;
  if (json.current_wave !== undefined && !currentWaveValid) {
    notes.push(`normalized invalid current_wave ${JSON.stringify(json.current_wave)} to 1`);
  }
  const fixed = {
    ...json,
    ...(json.current_wave === undefined ? {} : { current_wave: currentWaveValid ? json.current_wave : 1 }),
    tasks: tasks.map((rawTask, taskIndex) => {
      if (!isRecord(rawTask)) {
        notes.push(
          `tasks[${taskIndex}]: cannot repair non-object task entry ${JSON.stringify(rawTask)}; refusing unchanged input`,
        );
        return rawTask;
      }
      const t = rawTask;
      const repair = fixTaskFindings(t);
      const id = typeof t.id === "string" ? t.id : "<task with no id>";
      for (const claim of repair.recovered) {
        notes.push(`${id}: recovered view-only claim into findings — "${claim}"`);
      }
      for (const claim of repair.salvaged) {
        notes.push(`${id}: re-minted identity for a malformed findings entry — "${claim}"`);
      }
      if (repair.reminted > 0) {
        notes.push(`${id}: re-minted ${repair.reminted} colliding finding id(s)`);
      }
      // The only lossy paths in this repair. Loud, and named as data loss —
      // a dropped critical is indistinguishable from one that was never found.
      if (repair.dropped > 0) {
        const note =
          `${id}: DROPPED ${repair.dropped} findings entr(y/ies) carrying no usable claim — ` +
          `data lost; check the reviewer output for this task`;
        notes.push(note);
        dataLoss.push(note);
      }
      for (const claim of repair.recoveredRefutationFindings) {
        notes.push(`${id}: recovered finding from malformed refutation record — "${claim}"`);
      }
      if (repair.droppedRefutations > 0) {
        const note =
          `${id}: DROPPED ${repair.droppedRefutations} malformed refutation record(s) — ` +
          `audit trail lost; valid nested findings were preserved or returned to the active set`;
        notes.push(note);
        dataLoss.push(note);
      }
      for (const claim of repair.recoveredResolutionFindings) {
        notes.push(`${id}: recovered finding from malformed remediation resolution — "${claim}"`);
      }
      if (repair.droppedResolutions > 0) {
        const note =
          `${id}: DROPPED ${repair.droppedResolutions} malformed remediation resolution record(s) — ` +
          `audit trail lost; valid nested findings were returned to the active set`;
        notes.push(note);
        dataLoss.push(note);
      }
      if (repair.clearedReviewRecord) {
        notes.push(
          `${id}: cleared an inconsistent review evidence-failure record and reset review_status to pending`,
        );
      }
      for (const claim of repair.unrecoverableViewClaims) {
        const note =
          `${id}: DROPPED view-only claim carrying no finding — "${claim}". ` +
          `The wave gate counts that view and does not filter sentinels, so this task ` +
          `blocked the gate before this repair and no longer does`;
        notes.push(note);
        dataLoss.push(note);
      }
      return {
        ...t,
        depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
        status: t.status ?? "pending",
        review_status: t.review_status ?? "pending",
        ...repair.fields,
      };
    }),
  };
  return { json: JSON.stringify(fixed, null, 2), notes, dataLoss };
}

/** Production filesystem port for model-binding checks; failures retain their cause. */
const PROD_DEPS: ModelBindingDeps = {
  readFile: (p) => {
    try {
      return { ok: true, content: readFileSync(p, "utf-8") };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

function tasksOf(json: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(json.tasks) ? (json.tasks as Record<string, unknown>[]) : [];
}

const handler: HookHandler = async (stdin, args) => {
  const isMinimal = args.includes("--minimal");
  const isFix = args.includes("--fix");
  const acceptsDataLoss = args.includes("--accept-data-loss");

  // Read JSON from stdin or file arg
  const fileArg = args.find((a) =>
    a !== "--minimal" && a !== "--fix" && a !== "--accept-data-loss" && a !== "-"
  );
  let raw: string;

  if (fileArg && fileArg !== "-") {
    if (!existsSync(fileArg)) {
      return { kind: "error", message: `File not found: ${fileArg}` };
    }
    raw = readFileSync(fileArg, "utf-8");
  } else {
    raw = stdin;
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    if (isFix && isMinimal) {
      process.stdout.write(fixMinimal({}));
      return { kind: "passthrough" };
    }
    return { kind: "error", message: "Invalid JSON" };
  }

  if (isFix) {
    // Validation of the INPUT is deliberately not run here. `validateFull`
    // writes `new_tests_required=false` warnings to stderr as a side effect,
    // and this path discards its result and re-validates the REPAIRED graph
    // below — so evaluating it eagerly printed every such warning twice, once
    // for a verdict nothing reads.
    const repair = isMinimal
      ? { json: fixMinimal(json), notes: [], dataLoss: [] }
      : fixFull(json);
    if (repair.dataLoss.length > 0 && !acceptsDataLoss) {
      return {
        kind: "error",
        message: [
          "validate-task-graph --fix refused a lossy repair; inspect the source evidence or retry with --accept-data-loss:",
          ...repair.dataLoss.map((loss) => `  - ${loss}`),
        ].join("\n"),
      };
    }
    process.stdout.write(repair.json);
    // A repair that gave a claim identity or renamed one changed the data the
    // panel will vote on. Silent conservation is still a change.
    for (const note of repair.notes) process.stderr.write(`  ${note}\n`);
    // Re-validate the REPAIRED graph, not the input. Reporting the input's
    // errors as "remaining" told the operator the repair had failed on exactly
    // the runs where it succeeded — and named issues they would then go looking
    // for in a file that no longer has them. A repair that cannot clear an error
    // is worth saying; one that did is worth not saying.
    const after = isMinimal
      ? validateMinimal(JSON.parse(repair.json))
      : validateFull(JSON.parse(repair.json));
    if (!after.ok) {
      process.stderr.write(`Fixed structural defaults; ${after.errors.length} issues remain\n`);
      for (const err of after.errors) process.stderr.write(`  - ${err}\n`);
    }
    // --fix is a transformation, not a gate — but binding problems are not
    // structurally fixable, so surface them rather than dropping them.
    // populate-task-graph enforces bindings fail-closed before any state write.
    if (!isMinimal) {
      const bindings = checkPlanModelBindings(json.plan_file, tasksOf(json), PROD_DEPS);
      if (!bindings.ok) {
        process.stderr.write(`Executable-model binding issues (not fixable by --fix; populate-task-graph will block):\n`);
        for (const err of bindings.errors) process.stderr.write(`  - ${err}\n`);
      }
    }
    return { kind: "passthrough" };
  }

  const result = isMinimal ? validateMinimal(json) : validateFull(json);

  if (!result.ok) {
    return {
      kind: "error",
      message: [`Validation FAILED (${result.errors.length} errors):`, ...result.errors.map((e) => `  - ${e}`)].join("\n"),
    };
  }

  // Executable-models policy: cross-check model bindings declared in the plan.
  // Fail-closed — an unreadable plan is an error, not a skipped check; plans
  // without model sections produce zero checks (genuine opt-out).
  if (!isMinimal) {
    const bindings = checkPlanModelBindings(json.plan_file, tasksOf(json), PROD_DEPS);
    if (!bindings.ok) {
      return {
        kind: "error",
        message: [`Executable-model binding validation FAILED (${bindings.errors.length} errors):`, ...bindings.errors.map((e) => `  - ${e}`)].join("\n"),
      };
    }
    const models = bindings.models;
    if (models && (models.lifecycles.length > 0 || models.pipeline !== null || models.invariants.length > 0)) {
      process.stderr.write(`Executable-model bindings valid: ${models.lifecycles.length} lifecycles, ${models.pipeline ? 1 : 0} pipeline, ${models.invariants.length} invariants\n`);
    }
  }

  process.stderr.write(isMinimal ? "Minimal graph valid\n" : `Task graph valid: ${(json.tasks as unknown[]).length} tasks\n`);
  return { kind: "passthrough" };
};

export default handler;
