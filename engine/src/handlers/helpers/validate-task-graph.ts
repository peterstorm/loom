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
  claimsOfSeverity,
  deduplicateFindingIds,
  parseStoredFindings,
  parseStoredRefutations,
  recoverViewOnlyClaims,
} from "../../core/findings";
import { checkPlanModelBindings, type ModelBindingDeps } from "./validate-model-bindings";

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

/** Validate full decompose task graph */
export function validateFull(json: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required top-level fields — path fields must be real strings, not merely
  // truthy, or a garbage value silently disarms downstream plan-based checks
  for (const field of ["plan_title", "plan_file", "spec_file"]) {
    if (!json[field]) errors.push(`Missing required field: ${field}`);
    else if (typeof json[field] !== "string") errors.push(`Field '${field}' must be a string`);
  }
  if (!json.tasks) errors.push("Missing required field: tasks");

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

    if (!task.description) errors.push(`Task ${tid}: missing 'description'`);
    const agent = task.agent as string | undefined;
    if (!agent) errors.push(`Task ${tid}: missing 'agent'`);
    else if (!KNOWN_AGENTS.has(agent)) errors.push(`Task ${tid}: unknown agent '${agent}'`);

    const wave = task.wave as number | undefined;
    if (wave === undefined) errors.push(`Task ${tid}: missing 'wave'`);
    else if (!Number.isInteger(wave) || wave < 1) errors.push(`Task ${tid}: wave must be integer >= 1`);

    const deps = task.depends_on;
    if (deps !== undefined && deps !== null && !Array.isArray(deps)) {
      errors.push(`Task ${tid}: 'depends_on' must be array`);
    }

    if (Array.isArray(deps)) {
      for (const dep of deps as string[]) {
        if (dep === tid) { errors.push(`Task ${tid}: self-dependency`); continue; }
        if (!allIds.has(dep)) { errors.push(`Task ${tid}: depends on non-existent '${dep}'`); continue; }
        const depTask = tasks.find((t: Record<string, unknown>) => t.id === dep);
        if (depTask && wave && (depTask as Record<string, unknown>).wave as number >= wave) {
          errors.push(`Task ${tid} (wave ${wave}): depends on '${dep}' (wave ${(depTask as Record<string, unknown>).wave}) — deps must be in earlier wave`);
        }
      }
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
  /** Ids that collided and were re-minted. */
  readonly reminted: number;
}

/**
 * Repair one task's findings and the two `string[]` views over them.
 *
 * Every path here CONSERVES claims. That is the whole rule, and it used not to
 * hold: a claim in `critical_findings` with no counterpart in `findings` was
 * deleted, silently, by the repair the load-boundary diagnostic itself tells the
 * operator to run. `complete-wave-gate` counts that view, so the deletion turned
 * a blocking wave into a passing one.
 *
 * Three repairs, in order:
 *
 *   1. Malformed `findings` entries are dropped. They are the items a refutation
 *      panel votes on, and a malformed one reaches a verifier as an un-votable
 *      item — but their CLAIMS survive step 2 if the views still hold them.
 *   2. Claims present only in a view are given identity (`recoverViewOnlyClaims`).
 *      This is what makes a pre-identity task adjudicable, and what makes the
 *      repair idempotent: after one pass the views hold exactly what `findings`
 *      holds, so a second pass finds nothing to recover.
 *   3. Colliding ids are re-minted, because the load boundary now rejects
 *      duplicates and a rejection with no working repair dead-ends the operator.
 *
 * The views are then re-derived from the result, which is the lockstep
 * `findingsLockstepError` proves at load.
 */
function fixTaskFindings(t: Record<string, unknown>): FindingsRepair {
  const refuted = parseStoredRefutations(t.refuted_findings);
  const stored = parseStoredFindings(t.findings);
  // Order- and length-preserving, so an id that differs at the same index is
  // exactly one this repair re-minted.
  const parsed = deduplicateFindingIds(stored, refuted);
  const reminted = parsed.filter((finding, index) => finding.id !== stored[index]?.id).length;

  const viewClaims = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((claim): claim is string => typeof claim === "string") : [];
  const recoveredFindings = recoverViewOnlyClaims(
    parsed,
    refuted,
    viewClaims(t.critical_findings),
    viewClaims(t.advisory_findings),
  );
  const findings = [...parsed, ...recoveredFindings];

  return {
    fields: {
      findings,
      critical_findings: [...claimsOfSeverity(findings, "critical")],
      advisory_findings: [...claimsOfSeverity(findings, "advisory")],
      refuted_findings: refuted,
    },
    recovered: recoveredFindings.map((finding) => finding.claim),
    reminted,
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
  const fixed = {
    ...json,
    tasks: tasks.map((t) => {
      const repair = fixTaskFindings(t);
      const id = typeof t.id === "string" ? t.id : "<task with no id>";
      for (const claim of repair.recovered) {
        notes.push(`${id}: recovered view-only claim into findings — "${claim}"`);
      }
      if (repair.reminted > 0) {
        notes.push(`${id}: re-minted ${repair.reminted} colliding finding id(s)`);
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

/** Production filesystem port for model-binding checks — honest null on any read failure */
const PROD_DEPS: ModelBindingDeps = {
  readFile: (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
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

  const result = isMinimal ? validateMinimal(json) : validateFull(json);

  if (isFix) {
    const repair = isMinimal ? { json: fixMinimal(json), notes: [] } : fixFull(json);
    process.stdout.write(repair.json);
    // A repair that gave a claim identity or renamed one changed the data the
    // panel will vote on. Silent conservation is still a change.
    for (const note of repair.notes) process.stderr.write(`  ${note}\n`);
    if (!result.ok) {
      process.stderr.write(`Fixed structural defaults; ${result.errors.length} issues remain\n`);
      for (const err of result.errors) process.stderr.write(`  - ${err}\n`);
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
