/**
 * Validate task graph JSON schema.
 * Usage: bun cli.ts helper validate-task-graph [--minimal] [--fix]
 * Reads JSON from stdin or file arg.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, Phase, TaskGraph } from "../../types";
import { PHASE_ORDER, KNOWN_AGENTS } from "../../config";
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
  parseStoredFindings,
  parseStoredRefutations,
  recoverViewOnlyClaims,
  unrecoverableViewClaims,
  salvageMalformedFindings,
  RECOVERED_AGENT,
} from "../../core/findings";
import { checkPlanModelBindings, type ModelBindingDeps } from "./validate-model-bindings";
import { taskUnionError } from "../../state-manager";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: readonly string[] };

function ok(): ValidationResult { return { ok: true }; }
function fail(errors: string[]): ValidationResult { return { ok: false, errors }; }

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
  push(findingIdCollisionError(task.findings, task.refuted_findings, label));
  push(evidenceFailureError(task, label));
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

  const allIds = new Set(tasks.map((t: Record<string, unknown>) => t.id as string));

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i] as Record<string, unknown>;
    const tid = task.id as string | undefined;

    if (!tid) { errors.push(`Task [${i}]: missing 'id'`); continue; }
    if (!/^T\d+$/.test(tid)) errors.push(`Task ${tid}: id must match T\\d+`);

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

    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep !== "string") {
          errors.push(`Task ${tid}: 'depends_on' entries must be strings`);
          continue;
        }
        if (dep === tid) { errors.push(`Task ${tid}: self-dependency`); continue; }
        if (!allIds.has(dep)) { errors.push(`Task ${tid}: depends on non-existent '${dep}'`); continue; }
        const depTask = tasks.find((t: Record<string, unknown>) => t.id === dep);
        if (depTask && wave && (depTask as Record<string, unknown>).wave as number >= wave) {
          errors.push(`Task ${tid} (wave ${wave}): depends on '${dep}' (wave ${(depTask as Record<string, unknown>).wave}) — deps must be in earlier wave`);
        }
      }
    }

    if (
      scope === "decompose-payload" &&
      task.file_list !== undefined &&
      (!Array.isArray(task.file_list) || task.file_list.some((file) => typeof file !== "string" || file.trim() === ""))
    ) {
      errors.push(`Task ${tid}: 'file_list' must be an array of non-empty strings if present`);
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
    if (task.spec_anchors !== undefined && task.spec_anchors !== null && !Array.isArray(task.spec_anchors)) {
      errors.push(`Task ${tid}: 'spec_anchors' must be array if present`);
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
  const waves = [...new Set(tasks.map((t: Record<string, unknown>) => t.wave as number))]
    .filter((w): w is number => typeof w === "number" && Number.isInteger(w))
    .sort((a, b) => a - b);
  for (let i = 1; i < waves.length; i++) {
    if (waves[i] !== waves[i - 1] + 1) {
      errors.push(`Wave gap: ${waves[i - 1]} → ${waves[i]} (waves must be contiguous)`);
    }
  }

  // ADR tasks must be in the highest wave so they document what already shipped.
  const adrTasks = tasks.filter((t: Record<string, unknown>) => t.agent === "adr-writer-agent");
  if (adrTasks.length > 0 && waves.length > 0) {
    const maxWave = waves[waves.length - 1];
    const nonImplTasks = tasks.filter((t: Record<string, unknown>) => t.agent !== "adr-writer-agent");
    const implWaves = [...new Set(nonImplTasks.map((t: Record<string, unknown>) => t.wave as number))]
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
  /** Malformed `refuted_findings` records — audit trail, unrecoverable. */
  readonly droppedRefutations: number;
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
 *   4. Malformed refutation records are dropped — they are audit trail with no
 *      derived view to rebuild them from — and counted, for the same reason.
 *
 * The views are then re-derived from the result, which is the lockstep
 * `findingsLockstepError` proves at load.
 */
function fixTaskFindings(t: Record<string, unknown>): FindingsRepair {
  const refuted = parseStoredRefutations(t.refuted_findings);
  const rawRefutedCount = Array.isArray(t.refuted_findings) ? t.refuted_findings.length : 0;
  // A singleton object is malformed as a container, not necessarily as a
  // finding. Normalize it to one input entry so repair can conserve its claim
  // (or count it as dropped) rather than silently treating it as no evidence.
  const rawFindings = Array.isArray(t.findings)
    ? t.findings
    : t.findings === undefined ? [] : [t.findings];
  const stored = parseStoredFindings(rawFindings);
  const rawFindingCount = rawFindings.length;
  // Order- and length-preserving, so an id that differs at the same index is
  // exactly one this repair re-minted.
  const parsed = deduplicateFindingIds(stored, refuted);
  const reminted = parsed.filter((finding, index) => finding.id !== stored[index]?.id).length;

  const salvagedDrafts = salvageMalformedFindings(rawFindings);
  const salvagedFindings = salvagedDrafts.length === 0
    ? []
    : attributeFindings(salvagedDrafts, RECOVERED_AGENT, nextOrdinal(parsed, refuted, RECOVERED_AGENT));
  const identified = [...parsed, ...salvagedFindings];

  const viewClaims = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((claim): claim is string => typeof claim === "string") : [];
  const recoveredFindings = recoverViewOnlyClaims(
    identified,
    refuted,
    viewClaims(t.critical_findings),
    viewClaims(t.advisory_findings),
  );
  const findings = [...identified, ...recoveredFindings];
  const unrecoverable = unrecoverableViewClaims(
    identified,
    viewClaims(t.critical_findings),
    viewClaims(t.advisory_findings),
  );

  const review = repairReviewRecord(t);

  return {
    fields: {
      findings,
      critical_findings: [...claimsOfSeverity(findings, "critical")],
      advisory_findings: [...claimsOfSeverity(findings, "advisory")],
      refuted_findings: refuted,
      ...review.fields,
    },
    recovered: recoveredFindings.map((finding) => finding.claim),
    salvaged: salvagedFindings.map((finding) => finding.claim),
    unrecoverableViewClaims: unrecoverable,
    reminted,
    dropped: rawFindingCount - parsed.length - salvagedFindings.length,
    droppedRefutations: rawRefutedCount - refuted.length,
    clearedReviewRecord: review.cleared,
  };
}

/**
 * Repair the review record's evidence-failure biconditional
 * (`evidenceFailureError` at the load boundary): the status is
 * `evidence_capture_failed` exactly when `review_evidence_failures` names at
 * least one reviewer.
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
  const agents = Array.isArray(raw)
    ? [...new Set(raw.filter((a): a is string => typeof a === "string" && a.trim() !== ""))]
    : [];
  const failed = t.review_status === "evidence_capture_failed";
  const wellFormed = failed === agents.length > 0 && (raw === undefined || Array.isArray(raw));

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
}

/**
 * Fix full graph — add missing per-task defaults and restore findings lockstep.
 *
 * Returns the notes rather than writing them: `--fix` is a pure transformation
 * whose output is piped, and a repair that changed a claim's identity must reach
 * the operator's stderr rather than only the file.
 */
export function fixFull(json: Record<string, unknown>): FixReport {
  const tasks = Array.isArray(json.tasks) ? (json.tasks as Record<string, unknown>[]) : [];
  const notes: string[] = [];
  const currentWaveValid =
    typeof json.current_wave === "number" && Number.isInteger(json.current_wave) && json.current_wave >= 1;
  if (json.current_wave !== undefined && !currentWaveValid) {
    notes.push(`normalized invalid current_wave ${JSON.stringify(json.current_wave)} to 1`);
  }
  const fixed = {
    ...json,
    ...(json.current_wave === undefined ? {} : { current_wave: currentWaveValid ? json.current_wave : 1 }),
    tasks: tasks.map((t) => {
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
        notes.push(
          `${id}: DROPPED ${repair.dropped} findings entr(y/ies) carrying no usable claim — ` +
            `data lost; check the reviewer output for this task`,
        );
      }
      if (repair.droppedRefutations > 0) {
        notes.push(
          `${id}: DROPPED ${repair.droppedRefutations} malformed refutation record(s) — ` +
            `audit trail lost, the findings themselves are unaffected`,
        );
      }
      for (const claim of repair.unrecoverableViewClaims) {
        notes.push(
          `${id}: DROPPED view-only claim carrying no finding — "${claim}". ` +
            `The wave gate counts that view and does not filter sentinels, so this task ` +
            `blocked the gate before this repair and no longer does`,
        );
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
  return { json: JSON.stringify(fixed, null, 2), notes };
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

  // Read JSON from stdin or file arg
  const fileArg = args.find((a) => a !== "--minimal" && a !== "--fix" && a !== "-");
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
    const repair = isMinimal ? { json: fixMinimal(json), notes: [] } : fixFull(json);
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
