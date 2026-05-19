/**
 * Pi extension adapter — pure function for lint integration via tool_result events.
 *
 * Satisfies:
 * - FR-018: Pi extension adapter integrating via Pi's event API
 * - US6: Developer using Pi with wave-based agents gets immediate lint feedback after edits
 *
 * This is a PURE FUNCTION (functional core) — fully testable without the Pi runtime.
 * The imperative shell (pi/extension.ts) calls this with the lint result.
 */

import { match } from "ts-pattern";
import type { LintResult } from "../linter/index";
import { formatOutput, formatBlockMessage } from "../linter/index";

// --- Response type (mirrors Pi's ToolResultEventResult) ---

export interface PiToolResultResponse {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError: boolean;
}

// --- Tool names that trigger lint ---

// Pi tool names are lowercase (vs PascalCase in Claude Code's PostToolUse)
const LINT_TRIGGER_TOOLS = new Set(["edit", "write", "multi_edit"]);

/**
 * Determines whether a tool_result event should trigger linting.
 * Only edit and write tools modify files and need lint checks.
 */
export function shouldTriggerLint(toolName: string): boolean {
  return LINT_TRIGGER_TOOLS.has(toolName);
}

/**
 * Extracts the file path from a tool_result event's input.
 * Both edit and write tools use `input.path` for the file path.
 *
 * Returns null if path is missing or not a string (graceful handling).
 */
export function extractFilePath(input: Record<string, unknown>): string | null {
  const path = input?.path;
  if (typeof path === "string" && path.trim().length > 0) {
    return path;
  }
  return null;
}

/**
 * Pure adapter: maps a LintResult to a Pi tool_result response.
 *
 * - pass → undefined (no injection, agent continues normally)
 * - violations → { content: [formatted message], isError: true } (agent sees and fixes)
 * - error → { content: [error message], isError: true } (fail-closed — agent sees error)
 */
export function handleLintResult(
  filePath: string,
  lintResult: LintResult
): PiToolResultResponse | undefined {
  return match(lintResult)
    .with({ kind: "pass" }, () => undefined)
    .with({ kind: "violations" }, (r) => {
      const output = formatOutput(r, filePath);
      const message = formatBlockMessage(output);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      } satisfies PiToolResultResponse;
    })
    .with({ kind: "error" }, (r) => {
      const output = formatOutput(r, filePath);
      const message = formatBlockMessage(output);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      } satisfies PiToolResultResponse;
    })
    .exhaustive();
}

/**
 * Top-level adapter orchestrator (still pure — takes lintFile as a dependency).
 *
 * Composes: shouldTriggerLint → extractFilePath → lintFn → handleLintResult
 *
 * @param toolName - The tool that completed (e.g. "edit", "write", "read")
 * @param input - The tool's input record (contains `path`)
 * @param lintFn - Injected lint function (for testability without file system)
 * @returns PiToolResultResponse | undefined
 */
export function processToolResult(
  toolName: string,
  input: Record<string, unknown>,
  lintFn: (filePath: string) => LintResult
): PiToolResultResponse | undefined {
  if (!shouldTriggerLint(toolName)) {
    return undefined;
  }

  const filePath = extractFilePath(input);
  if (filePath === null) {
    // No file path — fail-closed with error message
    return {
      content: [{ type: "text", text: "❌ LINT ENGINE ERROR: Could not extract file path from tool input" }],
      isError: true,
    };
  }

  let lintResult: LintResult;
  try {
    lintResult = lintFn(filePath);
  } catch (error: unknown) {
    // Fail-closed: lintFn throwing is treated as a lint engine error
    const message = error instanceof Error ? error.message : String(error);
    lintResult = { kind: "error", message: `lintFn threw: ${message}` };
  }
  return handleLintResult(filePath, lintResult);
}
