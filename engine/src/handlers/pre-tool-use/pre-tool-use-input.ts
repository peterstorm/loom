/**
 * The one shape check every PreToolUse guard applies to its parsed hook payload
 * before reading it. A guard that skipped it would crash on JSON `null` or a
 * wrong shape — and a crash exits 1, which is NON-blocking for PreToolUse.
 */

import type { PreToolUseInput } from "../../types";

export const isPreToolUseInput = (value: unknown): value is PreToolUseInput =>
  typeof value === "object" && value !== null && "tool_name" in value && typeof value.tool_name === "string" &&
  "tool_input" in value && typeof value.tool_input === "object" && value.tool_input !== null;
