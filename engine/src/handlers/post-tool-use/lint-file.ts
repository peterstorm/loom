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

import type { HookHandler } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { lintFile, formatOutput, formatBlockMessage } from "../../linter/index";
import { DEFAULT_RULES_DIR, projectRulesDir } from "../../config";
import { editedFilePath } from "../../core/tool-vocabulary";
import { isRecord } from "../../core/plain-record";
import { match } from "ts-pattern";

/** Tool names that trigger file linting */
const LINT_TRIGGER_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * The two PostToolUse payload fields this handler reads. A `tool_name` that is
 * not a string names no lint-triggering tool, and a `tool_input` that is not an
 * object carries no file path: each is `null`, never a value of the wrong type.
 */
export type LintHookInput = Readonly<{
  toolName: string | null;
  toolInput: Readonly<Record<string, unknown>> | null;
}>;

/** Read the hook payload from parsed JSON. Anything but a JSON object is refused. */
export function parseLintHookInput(raw: unknown): LintHookInput | Error {
  if (!isRecord(raw)) return new Error("hook input must be a JSON object");
  return {
    toolName: typeof raw.tool_name === "string" ? raw.tool_name : null,
    toolInput: isRecord(raw.tool_input) ? raw.tool_input : null,
  };
}

const handler: HookHandler = async (stdin) => {
  // Fail-closed: wrap entire handler in try/catch
  try {
    // Passthrough on empty stdin (e.g. no piped data)
    if (!stdin || stdin.trim().length === 0) {
      return passthroughResult();
    }

    const raw: unknown = JSON.parse(stdin);
    const input = parseLintHookInput(raw);
    if (input instanceof Error) return blockResult(`Lint hook error: ${input.message}`);

    // Only trigger on Edit/Write/MultiEdit tools
    if (input.toolName === null || !LINT_TRIGGER_TOOLS.has(input.toolName)) {
      return passthroughResult();
    }

    // Extract file path — fail-closed if not available for a lint-triggering tool
    const filePath = editedFilePath(input.toolInput);
    if (!filePath) {
      return blockResult("Lint hook error: Could not extract file_path from tool_input");
    }

    // Invoke linter with immediate tier (fast, PostEdit rules only), against
    // the project's one rules directory when it has one
    const result = lintFile(filePath, "immediate", DEFAULT_RULES_DIR, projectRulesDir());

    // Map LintResult to HookResult
    return match(result)
      .with({ kind: "pass" }, () => allowResult())
      .with({ kind: "violations" }, (r) => {
        const output = formatOutput(r, filePath);
        const message = formatBlockMessage(output);
        return blockResult(message);
      })
      .with({ kind: "error" }, (r) => blockResult(`Lint engine error: ${r.message}`))
      .exhaustive();
  } catch (error: unknown) {
    // Fail-closed: any unexpected error → block
    const message = error instanceof Error ? error.message : String(error);
    return blockResult(`Lint hook error: ${message}`);
  }
};

export default handler;
