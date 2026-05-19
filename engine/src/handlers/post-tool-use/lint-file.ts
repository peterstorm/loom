/**
 * PostToolUse handler: lint-file
 *
 * Invoked after Edit/Write/MultiEdit tool use in Claude Code.
 * Lints the edited file against immediate-tier rules and blocks
 * the edit if violations are found.
 *
 * Satisfies:
 * - FR-017: Claude Code adapter via PostToolUse hook (shell shim → bun CLI)
 * - US1: Immediate violation blocking — bad patterns flagged and blocked
 *        immediately when an agent edits a file
 *
 * Fail-closed: any unexpected error → block (prevents silent bypass).
 */

import type { HookHandler, HookResult } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { lintFile } from "../../linter/index";
import { formatOutput, formatBlockMessage } from "../../linter/formatter";
import { DEFAULT_RULES_DIR, PROJECT_RULES_DIR } from "../../config";

/** Tool names that trigger file linting */
const LINT_TRIGGER_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** PostToolUse stdin shape (from Claude Code) */
export interface PostToolUseInput {
  readonly hook_type: string;
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_result?: string;
}

/**
 * Extracts file_path from tool_input, handling various tool input shapes.
 * Returns null if no file_path can be determined.
 */
export function extractFilePath(toolInput: Record<string, unknown> | null | undefined): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = toolInput.file_path ?? toolInput.path;
  if (typeof filePath === "string" && filePath.trim().length > 0) {
    return filePath;
  }
  return null;
}

const handler: HookHandler = async (stdin) => {
  // Fail-closed: wrap entire handler in try/catch
  try {
    // Passthrough on empty stdin (e.g. no piped data)
    if (!stdin || stdin.trim().length === 0) {
      return passthroughResult();
    }

    const input: PostToolUseInput = JSON.parse(stdin);

    // Only trigger on Edit/Write/MultiEdit tools
    if (!LINT_TRIGGER_TOOLS.has(input.tool_name)) {
      return passthroughResult();
    }

    // Extract file path — passthrough if not available
    const filePath = extractFilePath(input.tool_input);
    if (!filePath) {
      return passthroughResult();
    }

    // Resolve project rules dir (may not exist — lintFile handles gracefully)
    const projectRulesDir = PROJECT_RULES_DIR;

    // Invoke linter with immediate tier (fast, PostEdit rules only)
    const result = lintFile(filePath, "immediate", DEFAULT_RULES_DIR, projectRulesDir);

    // Map LintResult to HookResult
    switch (result.kind) {
      case "pass":
        return allowResult();

      case "violations": {
        const output = formatOutput(result, filePath);
        const message = formatBlockMessage(output);
        return blockResult(message);
      }

      case "error":
        // Fail-closed: lint engine error → block the edit
        return blockResult(`Lint engine error: ${result.message}`);

      default: {
        // Exhaustive check — should never reach here
        const _exhaustive: never = result;
        return blockResult(`Unexpected lint result: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (error: unknown) {
    // Fail-closed: any unexpected error → block
    const message = error instanceof Error ? error.message : String(error);
    return blockResult(`Lint hook error: ${message}`);
  }
};

export default handler;
