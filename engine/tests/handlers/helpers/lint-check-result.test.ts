/**
 * The full-tier lint's verdict as the reserved completion check's result
 * (`lintCheckResult`). Its result enters the Wave completion suite result,
 * which the gate re-parses before evaluating it, so every arm must produce a
 * check result the production parser admits: a lint engine error longer than
 * a stored message, or one with a blank message, must still surface as the
 * lint's own spawn failure, never as a parser refusal.
 */

import { describe, expect, it } from "vitest";
import {
  FULL_TIER_LINT_CHECK_ID_TEXT,
  MAX_FAILURE_MESSAGE_LENGTH,
  parseCompletionCheckId,
  parseCompletionCheckResult,
  type CompletionCheckId,
} from "../../../src/core/completion-suite";
import { lintCheckResult } from "../../../src/handlers/helpers/wave-completion-suite";
import type { HookResult } from "../../../src/types";

const LINT: CompletionCheckId = (() => {
  const parsed = parseCompletionCheckId(FULL_TIER_LINT_CHECK_ID_TEXT);
  if (!parsed.ok) throw new Error("the reserved lint check id must parse");
  return parsed.value;
})();

/** The result, after the round trip the gate makes through the production parser. */
function admitted(lint: HookResult) {
  const result = lintCheckResult(LINT, lint);
  const parsed = parseCompletionCheckResult(JSON.parse(JSON.stringify(result)));
  if (!parsed.ok) throw new Error(`the lint check result was refused: ${parsed.error.errors.join("; ")}`);
  expect(parsed.value).toEqual(result);
  return parsed.value.outcome;
}

describe("lintCheckResult", () => {
  it("is a clean exit when the lint allows, and exit 1 for a rule block", () => {
    expect(admitted({ kind: "allow" })).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(admitted({ kind: "block", message: "no-any: src/a.ts:3" })).toMatchObject({ kind: "observed", exitCode: 1 });
  });

  it("is a spawn failure carrying the engine error for a lint engine error", () => {
    expect(admitted({ kind: "error", message: "🚫 WAVE-GATE LINT ENGINE ERROR: rules dir missing" }))
      .toEqual({ kind: "spawn-failed", message: "🚫 WAVE-GATE LINT ENGINE ERROR: rules dir missing" });
  });

  it("bounds a lint engine error longer than a stored message, keeping its head", () => {
    const outcome = admitted({ kind: "block", message: `🚫 WAVE-GATE LINT ENGINE ERROR: ${"src/file.ts\n".repeat(2_000)}` });
    expect(outcome.kind).toBe("spawn-failed");
    if (outcome.kind !== "spawn-failed") return;
    expect(outcome.message).toHaveLength(MAX_FAILURE_MESSAGE_LENGTH);
    expect(outcome.message.startsWith("🚫 WAVE-GATE LINT ENGINE ERROR: src/file.ts")).toBe(true);
  });

  it("names the missing verdict for a blank engine error and for a result with no verdict", () => {
    expect(admitted({ kind: "error", message: "  " }))
      .toEqual({ kind: "spawn-failed", message: "full-tier lint returned no terminal result" });
    expect(admitted({ kind: "passthrough" }))
      .toEqual({ kind: "spawn-failed", message: "full-tier lint returned no terminal result" });
  });
});
