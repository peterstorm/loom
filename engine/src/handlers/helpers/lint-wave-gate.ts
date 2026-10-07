/**
 * Lint wave-gate helper — full-tier multi-file validation at phase boundaries.
 *
 * Reads the task graph to find `files_modified` for current wave tasks,
 * runs `lintFiles(paths, "full")` over them, and aggregates results.
 *
 * Satisfies:
 * - FR-020: Execute all rules (declarative + programmatic) at wave-gate boundaries
 * - US7: Two-Tier Execution Model — at wave boundaries, run full-tier linting
 *
 * Usage: bun cli.ts helper lint-wave-gate [--wave N]
 */

import { lstatSync } from "node:fs";
import type { HookHandler, HookResult, Task } from "../../types";
import { TASK_GRAPH_PATH, DEFAULT_RULES_DIR, PROJECT_RULES_DIR } from "../../config";
import { StateManager } from "../../state-manager";
import { lintFiles as lintFilesBatch, formatOutput, formatBlockMessage } from "../../linter/index";
import type { LintResult, LintOutput } from "../../linter/index";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import { repositoryRoot, visibleLeavesAt } from "../../utils/git";

// --- Testable helper logic (pure transformations and filesystem adapters) ---

export { parseWaveArg } from "./wave-args";
import { parseWaveArg } from "./wave-args";

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

/** Repository-relative files at or below one directory, Git-visible only. */
export type ListDirectoryLeaves = (root: string, directory: string) => readonly string[];

const gitVisibleLeaves: ListDirectoryLeaves = (root, directory) => {
  const listed = visibleLeavesAt(root, directory);
  if (!listed.ok) throw new Error(listed.error);
  return listed.paths;
};

/** Canonical, repository-confined filesystem targets for the lint shell.
 *  `files_modified` may name a declared directory artifact; it lints as its
 *  Git-visible regular files (ignored files and symlink leaves carry no source
 *  of this Task to lint). A named path must otherwise be a regular file. */
export function resolveLintTargets(
  root: string,
  files: readonly string[],
  listLeaves: ListDirectoryLeaves = gitVisibleLeaves,
): readonly string[] {
  const targets = new Set<string>();
  for (const path of canonicalRepositoryPaths(root, files, "task.files_modified")) {
    const target = inspectRepositoryPath(root, path, "lint target");
    if (!target.exists) continue;
    const stat = lstatSync(target.absolute);
    if (stat.isFile()) {
      targets.add(target.absolute);
    } else if (stat.isDirectory()) {
      for (const leaf of listLeaves(root, path)) {
        const inspected = inspectRepositoryPath(root, leaf, "lint target", { allowLeafSymlink: true });
        if (inspected.exists && lstatSync(inspected.absolute).isFile()) targets.add(inspected.absolute);
      }
    } else {
      throw new Error(`lint target must be a regular file or directory: ${path}`);
    }
  }
  return [...targets].sort();
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
 * Runs full-tier lint on each file path and collects results.
 * Production loads rules once for the whole batch; an injected per-file
 * lintFn (tests) replaces only how each LintResult is obtained.
 */
export function lintFiles(
  files: readonly string[],
  defaultRulesDir: string,
  projectRulesDir: string | null,
  lintFn?: (filePath: string, tier: "full", defaultDir: string, projectDir: string | null) => LintResult
): readonly FileLintResult[] {
  const resultFor = lintFn
    ? (file: string): LintResult => lintFn(file, "full", defaultRulesDir, projectRulesDir)
    : batchResultLookup(lintFilesBatch(files, "full", defaultRulesDir, projectRulesDir));
  return files.map((file) => {
    const result = resultFor(file);
    return { file, result, output: formatOutput(result, file) };
  });
}

function batchResultLookup(results: ReadonlyMap<string, LintResult>): (file: string) => LintResult {
  return (file) => results.get(file) ?? { kind: "error", message: "File not in results map" };
}

// --- Imperative shell (I/O at edges) ---

/** Fail closed: every unexpected engine error blocks the gate with one message shape. */
function engineError(error: unknown): HookResult {
  return {
    kind: "block",
    message: `🚫 WAVE-GATE LINT ENGINE ERROR: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/** Execute full-tier lint for one already-authorized Wave task set. Never
 *  throws: every failure becomes the engine-error block. */
export function runFullTierWaveLint(tasks: readonly Task[]): HookResult {
  try {
    const root = repositoryRoot() ?? process.cwd();
    const existingFiles = resolveLintTargets(root, collectModifiedFiles(tasks));
    if (existingFiles.length === 0) return { kind: "allow" };
    return aggregateResults(lintFiles(existingFiles, DEFAULT_RULES_DIR, PROJECT_RULES_DIR));
  } catch (error) {
    return engineError(error);
  }
}

/** Load the protected graph and select the Wave to lint: `--wave`, else the
 *  current Wave, else Wave 1. Never throws: an unreadable graph is the
 *  read-failure block and any other failure the engine-error block. */
function selectLintWave(args: string[]):
  | Readonly<{ ok: true; wave: number; tasks: readonly Task[] }>
  | Readonly<{ ok: false; result: HookResult }> {
  try {
    const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
    if (!mgr) {
      return {
        ok: false,
        result: { kind: "block", message: `🚫 WAVE-GATE LINT: Cannot read task graph at ${TASK_GRAPH_PATH}` },
      };
    }
    const state = mgr.load();
    const wave = parseWaveArg(args) ?? state.current_wave ?? 1;
    return { ok: true, wave, tasks: state.tasks.filter((t) => t.wave === wave) };
  } catch (error: unknown) {
    return { ok: false, result: engineError(error) };
  }
}

const handler: HookHandler = async (_stdin, args) => {
  const selected = selectLintWave(args);
  if (!selected.ok) return selected.result;
  const { wave, tasks } = selected;

  if (collectModifiedFiles(tasks).length === 0) {
    process.stderr.write(`lint-wave-gate: wave ${wave} — no modified files to lint.\n`);
    return { kind: "allow" };
  }

  process.stderr.write(`lint-wave-gate: wave ${wave} — running full-tier lint...\n`);
  const result = runFullTierWaveLint(tasks);
  if (result.kind === "allow") process.stderr.write(`lint-wave-gate: wave ${wave} passed full-tier lint.\n`);
  return result;
};

export default handler;
