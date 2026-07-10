import { describe, it, expect } from "vitest";
import validateTaskExecution from "../../../src/handlers/pre-tool-use/validate-task-execution";
import validatePhaseOrder from "../../../src/handlers/pre-tool-use/validate-phase-order";
import validateTemplateSubstitution from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import { FAIL_CLOSED_ROUTES } from "../../../src/handler-routes";
import type { HookHandler } from "../../../src/types";

/**
 * Round-17: the Task-spawn gates must fail CLOSED on malformed hook input.
 * An uncaught JSON.parse crash exits 1 (NON-blocking for PreToolUse) and lets
 * a Task spawn skip wave-order / phase-order / template-substitution
 * enforcement — the exact fail-open guard-state-file was hardened against in
 * round 11. The deeper corrupt-task-graph crash (mgr.load()) is covered by
 * these routes being in FAIL_CLOSED_ROUTES (cli.ts exits 2 on a top-level
 * crash for them), pinned in cli-fail-polarity.test.ts.
 */
describe("spawn-gate handlers — malformed stdin fails CLOSED", () => {
  const gates: ReadonlyArray<[string, HookHandler]> = [
    ["validate-task-execution", validateTaskExecution],
    ["validate-phase-order", validatePhaseOrder],
    ["validate-template-substitution", validateTemplateSubstitution],
  ];

  for (const [name, handler] of gates) {
    it(`${name}: unparseable stdin → block`, async () => {
      const result = await handler("{not json", []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("malformed hook input");
      }
    });
  }

  it("all three spawn gates are registered as fail-closed routes", () => {
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-task-execution")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-phase-order")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-template-substitution")).toBe(true);
  });
});
