/**
 * The filesystem observers the Wave Gate checks read through (`GateDeps` in
 * `core/wave-gate-checks`): the plan's executable models and Lifecycle
 * Machine artifact presence. The registered Wave Gate program and `loom
 * status` inject them; tests inject plain data instead.
 */

import { readFileSync, statSync } from "node:fs";
import { parsePlanModels } from "../../core/parse-plan-models";
import type { FilePresence, PlanModelsSource } from "../../core/wave-gate-checks";
import { describeCause } from "../../utils/describe-cause";

/** Resolve the plan's executable models from state — effectful shell helper */
export function loadPlanModelsSource(planFile: string | null | undefined): PlanModelsSource {
  if (typeof planFile !== "string" || planFile.trim().length === 0) return { kind: "none" };
  try {
    return { kind: "loaded", models: parsePlanModels(readFileSync(planFile, "utf-8")) };
  } catch (e) {
    // Carry the cause: ENOENT (typo'd path) and EACCES (permissions) demand
    // different operator responses — a bare "unreadable" hides which.
    return { kind: "unreadable", path: planFile, error: describeCause(e) };
  }
}

export function inspectFilePresence(path: string): FilePresence {
  try {
    // Follow the final path component: lstat succeeds for a dangling symlink,
    // but a link with no reachable target is not a Lifecycle Machine artifact.
    statSync(path);
    return { ok: true, exists: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { ok: true, exists: false }
      : { ok: false, error: describeCause(error) };
  }
}
