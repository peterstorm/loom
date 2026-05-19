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

import type { LintResult, LintOutput, Violation } from "./types";

/**
 * Maps a LintResult discriminated union to a serializable LintOutput JSON object.
 *
 * - `{ kind: "pass" }` → `{ status: "pass", file }`
 * - `{ kind: "violations", violations }` → `{ status: "fail", file, violations }`
 * - `{ kind: "error", message }` → `{ status: "error", file, error: message }`
 */
export function formatOutput(result: LintResult, filePath: string): LintOutput {
  switch (result.kind) {
    case "pass":
      return { status: "pass", file: filePath };
    case "violations":
      return { status: "fail", file: filePath, violations: result.violations };
    case "error":
      return { status: "error", file: filePath, error: result.message };
    default: {
      const _exhaustive: never = result;
      return { status: 'error' as const, file: filePath, error: `Unknown result kind: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/**
 * Renders a LintOutput as a human-readable multi-line string for hook stderr.
 *
 * - For "pass": returns empty string (no output needed)
 * - For "fail": renders violations with rule name, line, text, and fix hint
 * - For "error": renders error message
 */
export function formatBlockMessage(output: LintOutput): string {
  switch (output.status) {
    case "pass":
      return "";

    case "fail": {
      const header = `❌ LINT VIOLATIONS in ${output.file}`;
      const violationLines = (output.violations ?? []).map(formatViolationBlock);
      return [header, "", ...violationLines].join("\n");
    }

    case "error": {
      const header = `❌ LINT ENGINE ERROR in ${output.file}`;
      return [header, "", `  Error: ${output.error ?? "Unknown error"}`].join("\n");
    }

    default: {
      const _exhaustive: never = output.status;
      return `❌ LINT ENGINE ERROR in ${output.file}\n\n  Error: Unexpected status: ${String(_exhaustive)}`;
    }
  }
}

function formatViolationBlock(v: Violation): string {
  return `  [${v.rule}] line ${v.line}: ${v.text}\n    Fix: ${v.fixHint}`;
}
