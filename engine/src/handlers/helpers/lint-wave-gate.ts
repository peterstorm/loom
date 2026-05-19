/**
 * Lint wave-gate helper — full-tier multi-file validation at phase boundaries.
 *
 * Reads the task graph to find `files_modified` for current wave tasks,
 * runs `lintFile(path, "full")` for each, and aggregates results.
 *
 * Satisfies:
 * - FR-020: Execute all rules (declarative + programmatic) at wave-gate boundaries
 * - US7: Two-Tier Execution Model — at wave boundaries, run full-tier linting
 *
 * Usage: bun cli.ts helper lint-wave-gate [--wave N]
 */

import { existsSync } from "node:fs";
import type { HookHandler, HookResult, Task } from "../../types";
import { TASK_GRAPH_PATH, DEFAULT_RULES_DIR, PROJECT_RULES_DIR } from "../../config";
import { StateManager } from "../../state-manager";
import { lintFile, lintFiles as lintFilesBatch, formatOutput, formatBlockMessage } from "../../linter/index";
import type { LintResult, LintOutput } from "../../linter/index";

// --- Pure logic (extracted for testability) ---

/**
 * Parses --wave N from CLI args. Returns null if not provided.
 */
export function parseWaveArg(args: string[]): number | null {
  const idx = args.indexOf("--wave");
  if (idx < 0 || !args[idx + 1]) return null;
  const n = Number(args[idx + 1]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --wave value: "${args[idx + 1]}" (must be a positive integer)`);
  }
  return n;
}

/**
 * Collects and deduplicates file paths from tasks' files_modified arrays.
 * Returns a sorted, deduplicated list of file paths.
 */
export function collectModifiedFiles(tasks: readonly Task[]): readonly string[] {
  const files = new Set<string>();
  for (const task of tasks) {
    if (task.files_modified) {
      for (const f of task.files_modified) {
        files.add(f);
      }
    }
  }
  return [...files].sort();
}

/**
 * Filters file paths to only those that exist on disk.
 * Deleted files are skipped gracefully.
 */
export function filterExistingFiles(
  files: readonly string[],
  existsFn: (path: string) => boolean = existsSync
): readonly string[] {
  return files.filter(existsFn);
}

/**
 * Result of linting a single file in the wave-gate context.
 */
export interface FileLintResult {
  readonly file: string;
  readonly result: LintResult;
  readonly output: LintOutput;
}

/**
 * Aggregates file lint results into a single HookResult.
 * - All pass → { kind: "allow" }
 * - Any violations or errors → { kind: "block", message: aggregated }
 */
export function aggregateResults(results: readonly FileLintResult[]): HookResult {
  if (results.length === 0) {
    return { kind: "allow" };
  }

  const failures: string[] = [];

  for (const r of results) {
    if (r.result.kind === "violations" || r.result.kind === "error") {
      const blockMsg = formatBlockMessage(r.output);
      if (blockMsg) {
        failures.push(blockMsg);
      } else {
        // Defensive: if formatting fails to produce a message for a failure, still block
        failures.push(`❌ ${r.file}: lint ${r.result.kind} (formatting produced empty message)`);
      }
    }
  }

  if (failures.length === 0) {
    return { kind: "allow" };
  }

  const header = `🚫 WAVE-GATE LINT: ${failures.length} file(s) failed full-tier linting`;
  const message = header + "\n\n" + failures.join("\n\n");
  return { kind: "block", message };
}

/**
 * Runs lintFile on each file path and collects results.
 * Uses batch loading (rules loaded once) for efficiency.
 * lintFn injectable for testability.
 */
export function lintFiles(
  files: readonly string[],
  defaultRulesDir: string,
  projectRulesDir: string | null,
  lintFn?: (filePath: string, tier: "full", defaultDir: string, projectDir: string | null) => LintResult
): readonly FileLintResult[] {
  // If custom lintFn provided (tests), use per-file invocation
  if (lintFn) {
    return files.map((file) => {
      const result = lintFn(file, "full", defaultRulesDir, projectRulesDir);
      const output = formatOutput(result, file);
      return { file, result, output };
    });
  }

  // Production path: use batch linting (loads rules once)
  const resultsMap = lintFilesBatch(files, "full", defaultRulesDir, projectRulesDir);
  return files.map((file) => {
    const result = resultsMap.get(file) ?? { kind: "error" as const, message: "File not in results map" };
    const output = formatOutput(result, file);
    return { file, result, output };
  });
}

// --- Imperative shell (I/O at edges) ---

const handler: HookHandler = async (_stdin, args) => {
  try {
    const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
    if (!mgr) {
      return {
        kind: "block",
        message: `🚫 WAVE-GATE LINT: Cannot read task graph at ${TASK_GRAPH_PATH}`,
      };
    }

    const state = mgr.load();
    const waveArg = parseWaveArg(args);
    const wave = waveArg ?? state.current_wave ?? 1;

    const waveTasks = state.tasks.filter((t) => t.wave === wave);
    const allFiles = collectModifiedFiles(waveTasks);
    const existingFiles = filterExistingFiles(allFiles);

    if (existingFiles.length === 0) {
      process.stderr.write(`lint-wave-gate: wave ${wave} — no modified files to lint.\n`);
      return { kind: "allow" };
    }

    process.stderr.write(
      `lint-wave-gate: wave ${wave} — linting ${existingFiles.length} file(s) (full tier)...\n`
    );

    const results = lintFiles(existingFiles, DEFAULT_RULES_DIR, PROJECT_RULES_DIR);
    const hookResult = aggregateResults(results);

    if (hookResult.kind === "allow") {
      process.stderr.write(`lint-wave-gate: all ${existingFiles.length} file(s) passed.\n`);
    }

    return hookResult;
  } catch (error: unknown) {
    // Fail closed — any unexpected error blocks the gate
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "block",
      message: `🚫 WAVE-GATE LINT ENGINE ERROR: ${message}`,
    };
  }
};

export default handler;
