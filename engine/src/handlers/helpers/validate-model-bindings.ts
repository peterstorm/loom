/**
 * Executable-models policy: validate that models declared in a plan bind to
 * executable artifacts, and that the task graph implements them.
 *
 * Opt-in: a plan with no `## Lifecycles` / `## Pipeline` / `## Invariants`
 * sections (and no stray model markers) produces zero checks. A plan that
 * declares a model must bind it — a descriptive model with nothing to run is
 * a validation error, not a warning. Near-miss declarations (see
 * PlanModels.strays) are errors too: a typo must not read as an opt-out.
 *
 * Pure core (`validateModelBindings`) with filesystem access injected via
 * `ModelBindingDeps`; `checkPlanModelBindings` is the shared fail-closed
 * entry point used by both the validate-task-graph handler and
 * populate-task-graph (the only whitelisted helper that populates tasks
 * into state), so neither path can skip enforcement.
 */

import { parsePlanModels, hasModels, renderStray, type PlanModels } from "../../parsers/parse-plan-models";
import type { ValidationResult } from "./validate-task-graph";

export interface ModelBindingDeps {
  /** Returns file content, or null when the file does not exist or is unreadable */
  readonly readFile: (path: string) => string | null;
}

function ok(): ValidationResult {
  return { ok: true };
}
function fail(errors: string[]): ValidationResult {
  return { ok: false, errors };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * One-directional, suffix-tolerant match: the task path may be an absolute or
 * deeper form of the declared plan path, never the reverse — a bare-basename
 * file_list entry must not satisfy a fully-pathed declaration. A declared
 * path with no directory segment only matches exactly.
 */
export function pathsMatch(taskFile: string, declared: string): boolean {
  const nt = normalizePath(taskFile);
  const nd = normalizePath(declared);
  if (nt === nd) return true;
  if (!nd.includes("/")) return false;
  return nt.endsWith(`/${nd}`);
}

function taskFileLists(tasks: readonly Record<string, unknown>[]): string[] {
  return tasks.flatMap((t) =>
    Array.isArray(t.file_list) ? (t.file_list as unknown[]).filter((f): f is string => typeof f === "string") : []
  );
}

function jsonParseError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function validateModelBindings(
  models: PlanModels,
  tasks: readonly Record<string, unknown>[],
  deps: ModelBindingDeps,
): ValidationResult {
  const errors: string[] = [];
  const allFiles = taskFileLists(tasks);

  for (const stray of models.strays) {
    errors.push(`Model declaration problem: ${renderStray(stray)}`);
  }

  for (const lc of models.lifecycles) {
    const machineFile = lc.machineFile;
    if (machineFile === null) {
      errors.push(`${lc.id} ("${lc.title}"): no '**Machine file:**' declared — a lifecycle without an executable machine is a descriptive model (see references/executable-models.md)`);
      continue;
    }
    if (!allFiles.some((f) => pathsMatch(f, machineFile))) {
      errors.push(`${lc.id}: machine file '${machineFile}' is not in any task's file_list — decompose must emit a task that implements the statechart/reducer`);
    }
  }

  if (models.pipeline !== null) {
    const dagFile = models.pipeline.dagFile;
    if (dagFile === null) {
      errors.push("Pipeline section declares no '**AuthoredDag:**' path — a pipeline without an authored DAG is a descriptive model (see references/executable-models.md)");
    } else {
      const content = deps.readFile(dagFile);
      if (content === null) {
        errors.push(`Pipeline: AuthoredDag file '${dagFile}' not found or unreadable — the architecture phase must author it before decompose`);
      } else {
        let dag: unknown;
        let parseError: string | null = null;
        try {
          dag = JSON.parse(content);
        } catch (e) {
          parseError = jsonParseError(e);
        }
        if (parseError !== null) {
          errors.push(`Pipeline: AuthoredDag file '${dagFile}' is not valid JSON: ${parseError}`);
        } else if (typeof dag !== "object" || dag === null || Array.isArray(dag) || !Array.isArray((dag as Record<string, unknown>).nodes)) {
          errors.push(`Pipeline: AuthoredDag file '${dagFile}' must be a JSON object with a 'nodes' array (deep validation is fugue's job — 'fugue new --from' gates codegen)`);
        } else {
          // Drift guard: every node the plan's Pipeline table names must appear
          // in the sidecar. Checked as a substring of the raw sidecar text, not
          // against a schema field, so loom gains NO new knowledge of fugue's
          // AuthoredDag shape beyond the existing 'has a nodes array'. A plan
          // node absent from the sidecar is the plan↔sidecar drift that the
          // unguarded-intermediate leak allowed through to fugue runtime.
          const missing = models.pipeline.declaredNodes.filter((n) => !content.includes(n));
          if (missing.length > 0) {
            errors.push(
              `Pipeline: node(s) named in the plan's table are absent from AuthoredDag file '${dagFile}': ${missing.join(", ")} — plan and sidecar have drifted; re-author the sidecar or fix the table`,
            );
          }
        }
      }
    }
  }

  for (const inv of models.invariants) {
    if (inv.tier === null) {
      errors.push(`${inv.id} ("${inv.title}"): missing or unrecognized '**Tier:**' — must be 'checkable' or 'advisory'`);
      continue;
    }
    if (inv.tier === "advisory") {
      if (inv.ruleFile !== null) {
        errors.push(`${inv.id} ("${inv.title}"): tier is 'advisory' but declares a '**Rule file:**' — advisory invariants are never enforced; re-tier as 'checkable' or remove the rule file line`);
      }
      continue;
    }
    const ruleFile = inv.ruleFile;
    if (ruleFile === null) {
      errors.push(`${inv.id} ("${inv.title}"): tier is 'checkable' but no '**Rule file:**' declared — a checkable invariant must be a lint rule, or be honestly tiered 'advisory'`);
      continue;
    }
    const content = deps.readFile(ruleFile);
    if (content === null) {
      errors.push(`${inv.id}: rule file '${ruleFile}' not found or unreadable — the architecture phase must write it (validate with the validate-lint-rules helper)`);
      continue;
    }
    let rule: unknown;
    let parseError: string | null = null;
    try {
      rule = JSON.parse(content);
    } catch (e) {
      parseError = jsonParseError(e);
    }
    if (parseError !== null) {
      errors.push(`${inv.id}: rule file '${ruleFile}' is not valid JSON: ${parseError}`);
    } else if (typeof rule !== "object" || rule === null || Array.isArray(rule) || typeof (rule as Record<string, unknown>).kind !== "string" || typeof (rule as Record<string, unknown>).name !== "string") {
      errors.push(`${inv.id}: rule file '${ruleFile}' must be a JSON object with 'kind' and 'name' (full fail-closed load happens in the linter)`);
    }
  }

  return errors.length === 0 ? ok() : fail(errors);
}

/**
 * Outcome of the fail-closed plan-binding check. A discriminated union
 * instead of `ValidationResult & { models?: PlanModels }`: `models` is
 * present exactly when the plan was readable enough to parse — the type
 * states it, callers never guess. `ok` doubles as the pass/fail
 * discriminant so gate callers keep their `if (!check.ok)` shape.
 */
export type PlanBindingCheck =
  /** The plan itself could not be consulted (missing path / unreadable file) — nothing was parsed. */
  | { readonly kind: "plan-unavailable"; readonly ok: false; readonly errors: readonly string[] }
  /** Models were declared and at least one binding is broken. */
  | { readonly kind: "invalid-bindings"; readonly ok: false; readonly errors: readonly string[]; readonly models: PlanModels }
  /** The plan parsed and declares no models — genuine opt-out, zero checks. */
  | { readonly kind: "opted-out"; readonly ok: true; readonly models: PlanModels }
  /** Models were declared and every binding validated. */
  | { readonly kind: "validated"; readonly ok: true; readonly models: PlanModels };

/**
 * Fail-closed entry point: read the plan, parse models, validate bindings.
 *
 * - Non-string or empty `planFile` → plan-unavailable (the graph names no plan to check)
 * - Plan file unreadable → plan-unavailable (a graph must not pass validation
 *   because its plan cannot be read — that would let a typo'd path disarm the gate)
 * - Plan readable, no models declared → opted-out (genuine opt-out)
 */
export function checkPlanModelBindings(
  planFile: unknown,
  tasks: readonly Record<string, unknown>[],
  deps: ModelBindingDeps,
): PlanBindingCheck {
  if (typeof planFile !== "string" || planFile.trim().length === 0) {
    return {
      kind: "plan-unavailable",
      ok: false,
      errors: ["plan_file must be a non-empty string path — executable-model bindings cannot be verified without the plan"],
    };
  }
  const content = deps.readFile(planFile);
  if (content === null) {
    return {
      kind: "plan-unavailable",
      ok: false,
      errors: [`plan_file '${planFile}' not found or unreadable — executable-model bindings cannot be verified (fix the path or run from the repo root)`],
    };
  }
  const models = parsePlanModels(content);
  if (!hasModels(models)) return { kind: "opted-out", ok: true, models };
  const result = validateModelBindings(models, tasks, deps);
  return result.ok
    ? { kind: "validated", ok: true, models }
    : { kind: "invalid-bindings", ok: false, errors: result.errors, models };
}
