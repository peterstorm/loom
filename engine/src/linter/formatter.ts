/**
 * Violation formatter — maps LintResult to structured JSON output (LintOutput)
 * and renders human-readable block messages for hook stderr.
 *
 * Satisfies:
 * - FR-004: Structured JSON with rule name, file path, line number, violation text, fix hint
 * - US3: Single JSON object parseable programmatically
 * - NFR-005: Valid JSON output on all paths including error paths
 * - SC-005: Parseable by both Claude Code and Pi consumers without transformation
 */

import { match } from "ts-pattern";
import type { LintResult, LintOutput, Violation } from "./types";

/**
 * Maps a LintResult discriminated union to a serializable LintOutput JSON object.
 *
 * - `{ kind: "pass" }` → `{ status: "pass", file }`
 * - `{ kind: "violations", violations }` → `{ status: "fail", file, violations }`
 * - `{ kind: "error", message }` → `{ status: "error", file, error: message }`
 */
export function formatOutput(result: LintResult, filePath: string): LintOutput {
  return match(result)
    .with({ kind: "pass" }, () => ({ status: "pass" as const, file: filePath }))
    .with({ kind: "violations" }, ({ violations }) => ({ status: "fail" as const, file: filePath, violations }))
    .with({ kind: "error" }, ({ message }) => ({ status: "error" as const, file: filePath, error: message }))
    .exhaustive();
}

/**
 * Renders a LintOutput as a human-readable multi-line string for hook stderr.
 *
 * - For "pass": returns empty string (no output needed)
 * - For "fail": renders violations with rule name, line, text, and fix hint
 * - For "error": renders error message
 */
export function formatBlockMessage(output: LintOutput): string {
  return match(output)
    .with({ status: "pass" }, () => "")
    .with({ status: "fail" }, (o) => {
      const header = `❌ LINT VIOLATIONS in ${o.file}`;
      const violationLines = o.violations.map(formatViolationBlock);
      return [header, "", ...violationLines].join("\n");
    })
    .with({ status: "error" }, (o) => {
      const header = `❌ LINT ENGINE ERROR in ${o.file}`;
      return [header, "", `  Error: ${o.error}`].join("\n");
    })
    .exhaustive();
}

function formatViolationBlock(v: Violation): string {
  return `  [${v.rule}] line ${v.line}: ${v.text}\n    Fix: ${v.fixHint}`;
}
