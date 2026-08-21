/**
 * lintFile — public entry point for the linter bounded context.
 *
 * Orchestrates: file read → binary detection → rule loading → rule execution → result.
 *
 * Satisfies:
 * - FR-007: Fail closed — any engine crash blocks the edit
 * - FR-008: Pass silently when no rules match the file's extension
 * - FR-009: Skip binary files entirely (pass without evaluation)
 * - FR-010: Stateless — each invocation evaluates from scratch
 * - NFR-004: Fail closed on all error paths
 * - SC-004: Engine crash → blocked edit 100% of the time
 * - SC-007: Binary file detection skips correctly 100% of the time
 *
 * Zero external dependencies (node:fs, node:path, and internal imports only).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Tier, type LintResult, type Rule, passResult, violationsResult, lintErrorResult } from "./types";
import { loadRules } from "./loader";
import { executeRules } from "./executor";
import { createDeadlineChecker } from "./safety";

// --- Barrel re-exports (public API of the linter bounded context) ---

export { formatOutput, formatBlockMessage } from "./formatter";
export type { LintResult, LintOutput, Violation, Tier, Rule, RegexRule, ProgrammaticRule, RuleSource } from "./types";
export { passResult, violationsResult, lintErrorResult, makeViolation, isRegexRule, isProgrammaticRule } from "./types";
export type { SafetyResult, NowFn } from "./safety";
export { analyzeRegex, createDeadlineChecker } from "./safety";
export { loadRules } from "./loader";

/** Default timeout budget for a single file (ms) */
const DEFAULT_TIMEOUT_MS = 50;

/**
 * Detects if a buffer contains null bytes (binary content).
 * Checks up to the first 8192 bytes.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}


/**
 * The per-file pipeline both entry points run: resolve → one buffered read →
 * binary skip → decode → deadline → execute → fail-closed error.
 *
 * One copy, because two had already drifted: `lintFiles` hardcoded the hook's
 * 50ms budget where `lintFile` honoured its caller's, so the same file could
 * time out through one entry point and pass through the other.
 */
function lintLoadedFile(
  rules: readonly Rule[],
  filePath: string,
  timeoutMs: number,
): LintResult {
  try {
    const absolutePath = resolve(filePath);

    // One buffer read — binary detection and decoding cannot observe different reads.
    const buffer = readFileSync(absolutePath);

    // FR-009 / SC-007: Skip binary files entirely
    if (isBinaryBuffer(buffer)) return passResult();

    // Decode to UTF-8 from the same buffer (no second read)
    const content = buffer.toString("utf-8");

    // The deadline checker is time-dependent, so the shell creates it.
    // executeRules internally filters by extension — no match returns [].
    const violations = executeRules(rules, absolutePath, content, createDeadlineChecker(timeoutMs));

    // FR-008: No violations (including no rules matching extension) → pass
    return violationsResult(violations);
  } catch (error: unknown) {
    // FR-007 / NFR-004 / SC-004: Fail closed on ANY error
    return lintErrorResult(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Lints a single file against all applicable rules for the given tier.
 *
 * Stateless: loads rules fresh on every invocation. No caching, no memoization.
 * Fail-closed: entire function wrapped in try/catch — any throw → LintResult.error.
 *
 * @param filePath - Absolute or relative path to the file to lint
 * @param tier - "immediate" (PostEdit, fast) or "full" (wave-gate, all rules)
 * @param defaultRulesDir - Directory containing shipped default rules
 * @param projectRulesDir - Directory containing project-local rule overrides (or null)
 * @param timeoutMs - Wall-clock budget for this file. Defaults to the hook
 *   budget (`DEFAULT_TIMEOUT_MS`); callers that are not a latency-bound hook —
 *   a batch audit, or a test feeding a deliberately huge file — pass their own.
 *   Without it, "does this rule find the violation" and "did the machine finish
 *   in 50ms" were the same assertion, so a slow or loaded host turned a
 *   correctness test into a flaky one.
 * @returns LintResult: pass | violations | error
 */
export function lintFile(
  filePath: string,
  tier: Tier,
  defaultRulesDir: string,
  projectRulesDir: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): LintResult {
  let rules: readonly Rule[];
  try {
    // Stateless — fresh load every time per FR-010.
    rules = loadRules(defaultRulesDir, projectRulesDir, tier);
  } catch (error: unknown) {
    return lintErrorResult(error instanceof Error ? error.message : String(error));
  }
  return lintLoadedFile(rules, filePath, timeoutMs);
}

/**
 * Lints multiple files with a single rule-load pass.
 * Optimized for the wave-gate path where many files are checked at once.
 *
 * @param filePaths - Absolute file paths to lint
 * @param tier - Execution tier
 * @param defaultRulesDir - Default rules directory
 * @param projectRulesDir - Project rules directory (or null)
 * @param timeoutMs - Per-file wall-clock budget; defaults to the immediate-tier hook budget
 * @returns Map of file path → LintResult
 */
export function lintFiles(
  filePaths: readonly string[],
  tier: Tier,
  defaultRulesDir: string,
  projectRulesDir: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): ReadonlyMap<string, LintResult> {
  const results = new Map<string, LintResult>();

  // Load rules once for all files
  let rules: readonly Rule[];
  try {
    rules = loadRules(defaultRulesDir, projectRulesDir, tier);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // All files get the same error if rules fail to load
    for (const fp of filePaths) {
      results.set(fp, lintErrorResult(message));
    }
    return results;
  }

  for (const filePath of filePaths) {
    results.set(filePath, lintLoadedFile(rules, filePath, timeoutMs));
  }

  return results;
}
