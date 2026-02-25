/**
 * Compute initial task graph state from skip flags.
 * Replaces static heredoc in loom.md with programmatic resolution.
 */

import type { TaskGraph, Phase } from "./types";
import { findFile } from "./utils/find-file";

export interface SkipFlags {
  skipBrainstorm?: boolean;
  skipClarify?: boolean;
  skipSpecify?: boolean;
  skipPlanAlignment?: boolean;
}

/** Resolve initial state from skip flags */
export function resolveInitialState(flags: SkipFlags, specDir: string): TaskGraph {
  const skippedPhases: Phase[] = [];
  let currentPhase: Phase = "init";
  let specFile: string | null = null;

  if (flags.skipSpecify) {
    // --skip-specify implies skipping brainstorm, specify, and clarify
    skippedPhases.push("brainstorm", "specify", "clarify");
    currentPhase = "architecture";

    specFile = findFile(specDir, "spec.md");
    if (!specFile) {
      throw new Error(
        `--skip-specify requires existing spec.md under ${specDir}, but none found`,
      );
    }
  } else if (flags.skipBrainstorm) {
    skippedPhases.push("brainstorm");
    currentPhase = "specify";
  }

  // --skip-clarify can combine with other flags
  if (flags.skipClarify && !skippedPhases.includes("clarify")) {
    skippedPhases.push("clarify");
  }

  // --skip-plan-alignment can combine with other flags
  if (flags.skipPlanAlignment && !skippedPhases.includes("plan-alignment")) {
    skippedPhases.push("plan-alignment");
  }

  return {
    current_phase: currentPhase,
    phase_artifacts: {},
    skipped_phases: skippedPhases,
    spec_dir: specDir,
    spec_file: specFile,
    plan_file: null,
    tasks: [],
    wave_gates: {},
  };
}
