import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import validateTaskExecution from "../../../src/handlers/pre-tool-use/validate-task-execution";
import validatePhaseOrder from "../../../src/handlers/pre-tool-use/validate-phase-order";
import validateTemplateSubstitution from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import validateAgentModel from "../../../src/handlers/pre-tool-use/validate-agent-model";
import validateAgentSkill from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import { FAIL_CLOSED_ROUTES } from "../../../src/handler-routes";
import { TASK_GRAPH_PATH } from "../../../src/config";
import type { HookHandler } from "../../../src/types";

/**
 * Round-17/18: the Task-spawn gates must fail CLOSED on malformed hook input.
 * An uncaught JSON.parse crash exits 1 (NON-blocking for PreToolUse) and lets
 * a Task spawn skip wave-order / phase-order / template-substitution / model /
 * skill enforcement — the exact fail-open guard-state-file was hardened against
 * in round 11. The deeper corrupt-task-graph crash (mgr.load()) is covered by
 * these routes being in FAIL_CLOSED_ROUTES (cli.ts exits 2 on a top-level
 * crash for them), pinned in cli-fail-polarity.test.ts.
 */
describe("spawn-gate handlers — malformed stdin fails CLOSED", () => {
  // These parse stdin unconditionally (no task-graph precheck).
  const unconditional: ReadonlyArray<[string, HookHandler]> = [
    ["validate-task-execution", validateTaskExecution],
    ["validate-phase-order", validatePhaseOrder],
    ["validate-template-substitution", validateTemplateSubstitution],
  ];

  for (const [name, handler] of unconditional) {
    it(`${name}: unparseable stdin → block`, async () => {
      const result = await handler("{not json", []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("malformed hook input");
      }
    });
  }

  // validate-agent-model / validate-agent-skill only gate DURING orchestration
  // (task graph exists), so their parse-catch is reached only then.
  const orchestrationGated: ReadonlyArray<[string, HookHandler]> = [
    ["validate-agent-model", validateAgentModel],
    ["validate-agent-skill", validateAgentSkill],
  ];

  for (const [name, handler] of orchestrationGated) {
    it(`${name}: unparseable stdin with a task graph present → block`, async () => {
      const created = !existsSync(TASK_GRAPH_PATH);
      if (created) {
        mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
        writeFileSync(TASK_GRAPH_PATH, "{}");
      }
      try {
        const result = await handler("{not json", []);
        expect(result.kind).toBe("block");
        if (result.kind === "block") {
          expect(result.message).toContain("malformed hook input");
        }
      } finally {
        if (created) rmSync(TASK_GRAPH_PATH, { force: true });
      }
    });

    it(`${name}: unparseable stdin with NO task graph → allow (not orchestrating)`, async () => {
      if (existsSync(TASK_GRAPH_PATH)) return; // can't assert the no-graph path
      const result = await handler("{not json", []);
      expect(result.kind).toBe("allow");
    });
  }

  it("all five spawn gates are registered as fail-closed routes", () => {
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-task-execution")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-phase-order")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-template-substitution")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-agent-model")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-agent-skill")).toBe(true);
  });
});
