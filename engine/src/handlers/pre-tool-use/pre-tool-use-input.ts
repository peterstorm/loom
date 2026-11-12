/**
 * The one parse every PreToolUse guard applies to its hook payload before
 * reading it. A guard that skipped it would crash on malformed JSON, JSON
 * `null` or a wrong shape — and a crash exits 1, which is NON-blocking for
 * PreToolUse.
 *
 * Most guards fail CLOSED on a payload that does not parse, unconditionally:
 * `failClosedInput` is that direction and its block text, in one place. A
 * guard whose direction depends on other state (`enforce-phase-tools` blocks
 * only while a machine binding exists) calls `parsePreToolUseInput` itself.
 */

import { blockResult, type HookResult, type PreToolUseInput } from "../../types";

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

/** The guards that block every PreToolUse payload they cannot parse, whatever else holds. */
export type FailClosedGuard =
  | "block-direct-edits"
  | "guard-state-file"
  | "guard-subagent-authority"
  | "validate-agent-model"
  | "validate-agent-skill"
  | "validate-phase-order"
  | "validate-task-execution"
  | "validate-template-substitution";

/** A fail-closed guard's read of its payload: the parsed input, or the block that refuses it. */
export type FailClosedInput =
  | Readonly<{ ok: true; input: PreToolUseInput }>
  | Readonly<{ ok: false; block: HookResult }>;

/**
 * Parse the payload for `guard`, failing CLOSED: a payload that does not parse
 * is a block naming the guard and the parse error, so the call never proceeds
 * past a guard that could not read it.
 */
export function failClosedInput(guard: FailClosedGuard, stdin: string): FailClosedInput {
  const input = parsePreToolUseInput(stdin);
  return input instanceof Error
    ? { ok: false, block: blockResult(`${guard}: malformed hook input — failing closed: ${input.message}`) }
    : { ok: true, input };
}
