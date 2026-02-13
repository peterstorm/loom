/**
 * Validate task graph JSON schema.
 * Usage: bun cli.ts helper validate-task-graph [--minimal] [--fix]
 * Reads JSON from stdin or file arg.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, Phase, TaskGraph } from "../../types";
import { PHASE_ORDER, KNOWN_AGENTS } from "../../config";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  fixed?: string; // corrected JSON if --fix
}

const VALID_PHASES = new Set<string>(PHASE_ORDER);

const NO_TEST_KEYWORDS = /migration|config|schema|rename|bump|version|refactor|cleanup|typo|docs|interface|documentation|changelog|readme|ci|cd|pipeline|deploy|→|->|styling|css|formatting/i;

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

  return { valid: errors.length === 0, errors };
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

  // Required top-level fields
  for (const field of ["plan_title", "plan_file", "spec_file", "tasks"]) {
    if (!json[field]) errors.push(`Missing required field: ${field}`);
  }

  const tasks = json.tasks;
  if (!Array.isArray(tasks)) {
    errors.push("'tasks' must be an array");
    return { valid: false, errors };
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

  return { valid: errors.length === 0, errors };
}

/** Fix full graph — add missing per-task defaults */
export function fixFull(json: Record<string, unknown>): string {
  const tasks = (json.tasks as Record<string, unknown>[]) ?? [];
  const fixed = {
    ...json,
    tasks: tasks.map((t) => ({
      ...t,
      depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
      status: t.status ?? "pending",
      review_status: t.review_status ?? "pending",
      critical_findings: Array.isArray(t.critical_findings) ? t.critical_findings : [],
      advisory_findings: Array.isArray(t.advisory_findings) ? t.advisory_findings : [],
    })),
  };
  return JSON.stringify(fixed, null, 2);
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
    const fixed = isMinimal ? fixMinimal(json) : fixFull(json);
    process.stdout.write(fixed);
    if (!result.valid) {
      process.stderr.write(`Fixed structural defaults; ${result.errors.length} issues remain\n`);
      for (const err of result.errors) process.stderr.write(`  - ${err}\n`);
    }
    return { kind: "passthrough" };
  }

  if (!result.valid) {
    return {
      kind: "error",
      message: [`Validation FAILED (${result.errors.length} errors):`, ...result.errors.map((e) => `  - ${e}`)].join("\n"),
    };
  }

  process.stderr.write(isMinimal ? "Minimal graph valid\n" : `Task graph valid: ${(json.tasks as unknown[]).length} tasks\n`);
  return { kind: "passthrough" };
};

export default handler;
