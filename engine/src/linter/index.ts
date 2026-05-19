/**
 * lintFile — public entry point for the linter bounded context.
 *
 * Orchestrates: binary detection → file read → rule loading → rule execution → result.
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

import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { type Tier, type LintResult, passResult, lintErrorResult } from "./types";
import { loadRules } from "./loader";
import { executeRules } from "./executor";

/** Number of bytes to read for binary detection */
const BINARY_CHECK_BYTES = 8192;

/**
 * Detects if a file is binary by checking the first 8KB for null bytes.
 * Returns true if the file contains null bytes (binary), false otherwise.
 * Throws on read errors (caller handles via fail-closed wrapper).
 */
export function isBinaryFile(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = readSync(fd, buffer, 0, BINARY_CHECK_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
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

    // FR-009 / SC-007: Skip binary files entirely
    if (isBinaryFile(absolutePath)) {
      return passResult();
    }

    // Read file content (stateless — fresh read every time per FR-010)
    const content = readFileSync(absolutePath, "utf-8");

    // Load rules (stateless — fresh load every time per FR-010)
    const rules = loadRules(defaultRulesDir, projectRulesDir, tier);

    // Execute rules against file content
    // executeRules internally filters by extension — if no rules match, returns []
    const violations = executeRules(rules, absolutePath, content);

    // FR-008: No violations (including no rules matching extension) → pass
    if (violations.length === 0) {
      return passResult();
    }

    return { kind: "violations", violations };
  } catch (error: unknown) {
    // FR-007 / NFR-004 / SC-004: Fail closed on ANY error
    const message = error instanceof Error ? error.message : String(error);
    return lintErrorResult(message);
  }
}
