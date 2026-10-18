/**
 * A Claude Code PostToolUse call for minting tests, built through the
 * production adapter (`claudeToolCall`): the raw `tool_response` shapes the
 * suites pin are read exactly as the hook reads them.
 */

import { claudeToolCall } from "../../src/core/harness-tool-call";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";

export const claudeCall = (
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  toolResponse: unknown,
): HarnessToolCall => claudeToolCall({ tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, cwd: "/repo" });
