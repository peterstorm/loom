/**
 * The one parse every PreToolUse guard applies to its hook payload before
 * reading it. A guard that skipped it would crash on malformed JSON, JSON
 * `null` or a wrong shape — and a crash exits 1, which is NON-blocking for
 * PreToolUse. Each guard maps the failure to its own fail-closed block text.
 */

import type { PreToolUseInput } from "../../types";

export const isPreToolUseInput = (value: unknown): value is PreToolUseInput =>
  typeof value === "object" && value !== null && "tool_name" in value && typeof value.tool_name === "string" &&
  "tool_input" in value && typeof value.tool_input === "object" && value.tool_input !== null;

/** The parsed payload, or the reason it is not one (a JSON error message, or a shape mismatch). */
export function parsePreToolUseInput(stdin: string): PreToolUseInput | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  return isPreToolUseInput(parsed) ? parsed : new Error("expected an object with tool_name and tool_input");
}
