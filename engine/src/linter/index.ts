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
 * Detects if a file is binary by checking for null bytes.
 * Convenience wrapper that reads the file and delegates to isBinaryBuffer.
 */
export function isBinaryFile(filePath: string): boolean {
  const buffer = readFileSync(filePath);
  return isBinaryBuffer(buffer);
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
 * @returns LintResult: pass | violations | error
 */
export function lintFile(
  filePath: string,
  tier: Tier,
  defaultRulesDir: string,
  projectRulesDir: string | null
): LintResult {
  try {
    // Resolve to absolute path
    const absolutePath = resolve(filePath);

    // Single atomic read — eliminates TOCTOU race between binary check and content read
    const buffer = readFileSync(absolutePath);

    // FR-009 / SC-007: Skip binary files entirely
    if (isBinaryBuffer(buffer)) {
      return passResult();
    }

    // Decode to UTF-8 from the same buffer (no second read)
    const content = buffer.toString("utf-8");

    // Load rules (stateless — fresh load every time per FR-010)
    const rules = loadRules(defaultRulesDir, projectRulesDir, tier);

    // Create deadline checker (imperative shell creates the time-dependent resource)
    const checkDeadline = createDeadlineChecker(DEFAULT_TIMEOUT_MS);

    // Execute rules against file content
    // executeRules internally filters by extension — if no rules match, returns []
    const violations = executeRules(rules, absolutePath, content, checkDeadline);

    // FR-008: No violations (including no rules matching extension) → pass
    return violationsResult(violations);
  } catch (error: unknown) {
    // FR-007 / NFR-004 / SC-004: Fail closed on ANY error
    const message = error instanceof Error ? error.message : String(error);
    return lintErrorResult(message);
  }
}

/**
 * Lints multiple files with a single rule-load pass.
 * Optimized for the wave-gate path where many files are checked at once.
 *
 * @param filePaths - Absolute file paths to lint
 * @param tier - Execution tier
 * @param defaultRulesDir - Default rules directory
 * @param projectRulesDir - Project rules directory (or null)
 * @returns Map of file path → LintResult
 */
export function lintFiles(
  filePaths: readonly string[],
  tier: Tier,
  defaultRulesDir: string,
  projectRulesDir: string | null
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
    try {
      const absolutePath = resolve(filePath);
      const buffer = readFileSync(absolutePath);

      if (isBinaryBuffer(buffer)) {
        results.set(filePath, passResult());
        continue;
      }

      const content = buffer.toString("utf-8");
      const checkDeadline = createDeadlineChecker(DEFAULT_TIMEOUT_MS);
      const violations = executeRules(rules, absolutePath, content, checkDeadline);
      results.set(filePath, violationsResult(violations));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      results.set(filePath, lintErrorResult(message));
    }
  }

  return results;
}
