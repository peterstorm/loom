/**
 * Compute initial task graph state from skip flags.
 * Replaces static heredoc in loom.md with programmatic resolution.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TaskGraph, Phase } from "./types";

export interface SkipFlags {
  skipBrainstorm?: boolean;
  skipClarify?: boolean;
  skipSpecify?: boolean;
}

/** Recursively search for a file by name under a directory */
function findFile(dir: string, filename: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === filename) return join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(join(dir, entry.name), filename);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

/** Resolve initial state from skip flags */
export function resolveInitialState(flags: SkipFlags, specDir: string): TaskGraph {
  const skippedPhases: string[] = [];
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
